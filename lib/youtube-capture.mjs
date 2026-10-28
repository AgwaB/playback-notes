import Ajv from "ajv";
import { extractYouTubeVideoId } from "@steipete/summarize-core/content/url";
import { networkError, parseSourceUrl } from "./network.mjs";
import { sha256 } from "./ingest.mjs";

const CAPTURE_VERSION = "1";
const text = { type: "string", minLength: 1, maxLength: 20000 };
const nullableText = { anyOf: [text, { type: "null" }] };
const common = {
  schemaVersion: { const: 1 },
  videoId: { type: "string", pattern: "^[A-Za-z0-9_-]{11}$" },
  sourceUrl: text,
  capturedAt: {
    type: "string",
    pattern: "^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d+)?Z$",
  },
  title: text,
  durationMs: {
    type: ["integer", "null"],
    minimum: 0,
    maximum: 864000000,
  },
  language: nullableText,
};
// Optional track descriptors (which transcript-panel track the rows came from). Absent in
// older captures; never trusted beyond a warning.
const optionalTrack = {
  trackName: nullableText,
  trackKind: { anyOf: [{ enum: ["manual", "asr"] }, { type: "null" }] },
};
const object = (properties, optional = {}) => ({
  type: "object",
  properties: { ...properties, ...optional },
  required: Object.keys(properties),
  additionalProperties: false,
});
const validate = new Ajv({ strict: true }).compile({
  oneOf: [
    object(
      {
        ...common,
        method: { const: "timedtext-json3" },
        responseUrl: text,
        httpStatus: { const: 200 },
        bodyComplete: { const: true },
        payload: { type: "string", minLength: 1, maxLength: 8388608 },
      },
      optionalTrack,
    ),
    object(
      {
        ...common,
        method: { const: "transcript-dom" },
        rows: {
          type: "array",
          minItems: 1,
          maxItems: 100000,
          items: object({ startLabel: nullableText, text }),
        },
      },
      optionalTrack,
    ),
  ],
});
const fail = (code = "INVALID_CONTRACT") => {
  throw networkError(
    code,
    "YouTube browser capture is invalid or does not match the requested source.",
  );
};
const warning = (code, message) => ({
  code,
  message,
  severity: "warning",
  path: null,
  retryable: false,
});

function captureVideoId(request) {
  if (request.source?.kind !== "url" || request.transcriptFile) fail();
  const url = parseSourceUrl(request.source.value);
  const id = extractYouTubeVideoId(url.href);
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) fail();
  return id;
}
function watchIdentity(value, videoId) {
  const url = parseSourceUrl(value);
  if (
    url.origin !== "https://www.youtube.com" ||
    url.pathname !== "/watch" ||
    url.searchParams.getAll("v").length !== 1 ||
    url.searchParams.get("v") !== videoId
  )
    fail();
}
function timestamp(label) {
  if (label === null) return null;
  if (!/^(?:\d{1,3}:)?\d{1,2}:[0-5]\d$/.test(label)) fail();
  const parts = label.split(":").map(Number);
  if (parts.length === 3 && parts[1] > 59) fail();
  return parts.reduce((total, part) => total * 60 + part, 0) * 1000;
}
function json3Segments(capture) {
  const url = parseSourceUrl(capture.responseUrl);
  if (
    url.origin !== "https://www.youtube.com" ||
    url.pathname !== "/api/timedtext" ||
    url.searchParams.getAll("v").length !== 1 ||
    url.searchParams.get("v") !== capture.videoId ||
    url.searchParams.getAll("lang").length !== 1 ||
    url.searchParams.get("lang") !== capture.language
  )
    fail();
  let data;
  try {
    data = JSON.parse(capture.payload);
  } catch {
    fail();
  }
  if (!Array.isArray(data?.events)) fail();
  const segments = [];
  for (const event of data.events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) fail();
    // JSON3 also contains non-text window events.
    if (event.segs === undefined) continue;
    if (!Array.isArray(event.segs)) fail();
    for (const seg of event.segs) if (typeof seg?.utf8 !== "string") fail();
    const text = event.segs
      .map((seg) => seg.utf8)
      .join("")
      .trim();
    if (!text) continue;
    const startMs = event.tStartMs ?? null;
    const duration = event.dDurationMs ?? null;
    if (
      (startMs !== null && (!Number.isSafeInteger(startMs) || startMs < 0)) ||
      (duration !== null && (!Number.isSafeInteger(duration) || duration <= 0))
    )
      fail();
    segments.push({
      startMs,
      endMs: startMs !== null && duration !== null ? startMs + duration : null,
      text,
      speaker: null,
    });
  }
  if (!segments.length) fail("SOURCE_ACCESS_DENIED");
  return segments;
}
function validateCapturedSegments(segments, durationMs) {
  if (segments.length > 100000) fail("RESOURCE_LIMIT");
  let previous = -1;
  for (const segment of segments) {
    if (
      !segment.text.trim() ||
      segment.text.length > 20000 ||
      (segment.endMs !== null && !Number.isSafeInteger(segment.endMs)) ||
      (durationMs !== null &&
        (segment.startMs > durationMs || segment.endMs > durationMs)) ||
      (segment.startMs !== null && segment.startMs < previous)
    )
      fail();
    if (segment.startMs !== null) previous = segment.startMs;
  }
}

/** Import untrusted host-browser evidence, not authenticated proof. No network or browser launch. */
export function parseYoutubeCapture(raw, request) {
  const videoId = captureVideoId(request);
  let capture;
  try {
    capture = JSON.parse(raw);
  } catch {
    fail();
  }
  if (
    !validate(capture) ||
    capture.videoId !== videoId ||
    !Number.isFinite(Date.parse(capture.capturedAt))
  )
    fail();
  watchIdentity(capture.sourceUrl, videoId);
  if (
    capture.language !== null &&
    !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(capture.language)
  )
    fail();
  const dom = capture.method === "transcript-dom";
  const segments = dom
    ? capture.rows.map((row) => ({
        startMs: timestamp(row.startLabel),
        endMs: null,
        text: row.text,
        speaker: null,
      }))
    : json3Segments(capture);
  validateCapturedSegments(segments, capture.durationMs);
  const timed = segments.filter((segment) => segment.startMs !== null).length;
  let timing = "partial";
  if (timed === 0) timing = "none";
  else if (timed === segments.length) timing = "complete";
  const warnings = [
    warning(
      "BROWSER_CAPTURE_UNVERIFIED",
      "Imported host-browser capture; its acquisition and metadata were not independently authenticated or refreshed.",
    ),
    warning(
      "COVERAGE_UNVERIFIED",
      "Caption acquisition does not establish whole-video speech or visual coverage, or transcription accuracy.",
    ),
  ];
  if (capture.trackKind === "asr")
    warnings.push(
      warning(
        "AUTOMATIC_CAPTIONS",
        "The captured track is auto-generated and may contain transcription errors.",
      ),
    );
  if (dom)
    warnings.push(
      warning(
        "DOM_CAPTURE_PARTIAL",
        "Only observed transcript rows were imported; virtualized or unloaded rows may be missing. Displayed starts have second-level precision and ends are unknown.",
      ),
    );
  if (
    segments.some(
      (segment) => segment.startMs === null || segment.endMs === null,
    )
  )
    warnings.push(
      warning(
        "TIMING_UNAVAILABLE",
        "Some cue boundaries are unavailable; no ends were inferred from later rows or media duration.",
      ),
    );
  return {
    source: {
      id: `src-${sha256(`youtube:${videoId}`).slice(0, 24)}`,
      kind: "youtube",
      mediaType: "video",
      title: capture.title,
      displayName: capture.title,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      platformId: videoId,
      sourceLanguage: capture.language,
      durationMs: capture.durationMs,
      playback: { kind: "youtube", locator: videoId },
    },
    segments,
    extraction: {
      status: dom ? "partial" : "complete",
      method: "captions",
      provider: `playback-notes/browser-${capture.method}`,
      providerVersion: CAPTURE_VERSION,
      retrievedAt: capture.capturedAt,
      timing,
      processedRanges: [],
      gaps: dom
        ? [
            {
              startMs: null,
              endMs: null,
              reason: "Transcript DOM completeness is unknown.",
            },
          ]
        : [],
      warnings,
    },
    raw: { youtubeCapture: capture },
    mediaPath: null,
  };
}
