import Ajv from "ajv";
import evidenceSchema from "../schemas/evidence.schema.json" with {
  type: "json",
};
import reportSchema from "../schemas/report.schema.json" with { type: "json" };
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import {
  isBlockedNetworkAddress,
  isBlockedNetworkHostname,
} from "@steipete/summarize-core/content/network-safety";
import { AppError, containedFile, exists, readJson, sha256 } from "./io.mjs";
import { diagramTruncations } from "./diagram.mjs";

const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const string = { type: "string", minLength: 1, maxLength: 20000 };
const nullable = { type: ["string", "null"], maxLength: 20000 };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const id = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" };
const ids = { type: "array", items: id, uniqueItems: true, maxItems: 100000 };
const enumeration = (...values) => ({ enum: values });
const positive = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};
const optionalApproval = (properties) => ({
  anyOf: [{ type: "null" }, object(properties)],
});
const defaultPolicy = Object.freeze({
  asr: "off",
  partialEvidenceApproval: null,
  partialAnalysisApproval: null,
  copyLocalMedia: false,
  maxDownloadBytes: 2147483648,
  extractTimeoutMs: 1800000,
  asrTimeoutMs: 3600000,
  transcriptLanguages: [],
  visual: "off",
  publishTranscript: true,
});
const requestSchema = object({
  schemaVersion: { const: 1 },
  source: object({ kind: enumeration("url", "local"), value: string }),
  mode: enumeration("briefing", "deep-dive"),
  outputLanguage: string,
  focus: nullable,
  transcriptFile: nullable,
  formats: {
    type: "array",
    items: enumeration("html", "markdown", "pdf"),
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
  },
  policy: object({
    asr: enumeration("off", "local"),
    partialEvidenceApproval: optionalApproval({ evidenceSha256: hash }),
    partialAnalysisApproval: optionalApproval({
      evidenceSha256: hash,
      unreviewedChunkIds: ids,
      limitationsSha256: hash,
    }),
    copyLocalMedia: { type: "boolean" },
    maxDownloadBytes: positive,
    extractTimeoutMs: positive,
    asrTimeoutMs: positive,
    // Descending caption-language priority (youtube-transcript-api semantics); empty keeps the platform default.
    transcriptLanguages: {
      type: "array",
      items: { type: "string", pattern: "^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$" },
      maxItems: 8,
      uniqueItems: true,
    },
    // Local OCR of sampled frames (explicit tesseract executable); never a cloud vision call.
    visual: enumeration("off", "frames", "local-ocr"),
    // Include the full transcript text in the shareable HTML (citations still seek either way).
    publishTranscript: { type: "boolean" },
  }),
});
const analysisSchema = object({
  schemaVersion: { const: 1 },
  evidenceId: id,
  reviewedChunkIds: ids,
  inspectedFrameIds: ids,
  status: enumeration("complete", "partial"),
  limitations: { type: "array", items: string, maxItems: 1000 },
});
const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: true });
ajv.addFormat(
  "date-time",
  (value) =>
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)),
);
const validators = {
  request: ajv.compile(requestSchema),
  analysis: ajv.compile(analysisSchema),
  evidence: ajv.compile(evidenceSchema),
  report: ajv.compile(reportSchema),
};
export function assertSchema(kind, value) {
  const validate = validators[kind];
  if (!validate(value))
    throw new AppError(
      "INVALID_CONTRACT",
      `${kind} schema validation failed.`,
      kind === "request" ? 4 : 1,
      validate.errors.map((e) => ({
        code: "INVALID_CONTRACT",
        severity: "error",
        message: `${kind}: ${e.message}`,
        path: e.instancePath,
        retryable: false,
      })),
    );
  return value;
}
export function normalizeRequest(input) {
  const request = {
    outputLanguage: "en",
    focus: null,
    transcriptFile: null,
    formats: ["html", "markdown"],
    ...input,
    policy: { ...defaultPolicy, ...input.policy },
  };
  assertSchema("request", request);
  try {
    new Intl.Locale(request.outputLanguage);
  } catch {
    throw new AppError("INVALID_CONTRACT", "Invalid output language tag.", 4);
  }
  return request;
}
const fail = (code, message) => {
  throw new AppError(code, message);
};
function uniqueMap(items) {
  const map = new Map(items.map((item) => [item.id, item]));
  if (map.size !== items.length)
    fail("INVALID_CONTRACT", "Duplicate evidence or section ID.");
  return map;
}
export function publicUrl(raw) {
  if (raw === null) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("UNSAFE_URL", "Invalid source URL.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    isBlockedNetworkHostname(hostname) ||
    (isIP(hostname) && isBlockedNetworkAddress(hostname))
  )
    fail("UNSAFE_URL", "Source URL is not a permitted public URL.");
  const youtube = ["youtube.com", "www.youtube.com", "youtu.be"].includes(
    hostname,
  );
  // Apple Podcasts episode pages are identified by their numeric `i` parameter.
  const applePodcasts = hostname === "podcasts.apple.com";
  const allowed = youtube ? ["v", "t"] : applePodcasts ? ["i"] : [];
  if (
    url.search &&
    [...url.searchParams.keys()].some((key) => !allowed.includes(key))
  )
    fail(
      "UNSAFE_URL",
      "Potentially sensitive source queries must stay private.",
    );
  return url.href;
}
function validTimes(start, end, duration) {
  if (
    (start === null && end !== null) ||
    (end !== null && end <= start) ||
    (duration !== null &&
      ((start !== null && start > duration) ||
        (end !== null && end > duration)))
  )
    fail("INVALID_CONTRACT", "Invalid source timestamp range.");
}
export function validateEvidence(evidence) {
  assertSchema("evidence", evidence);
  const segments = uniqueMap(evidence.segments),
    frames = uniqueMap(evidence.frames),
    chunks = uniqueMap(evidence.chunks);
  publicUrl(evidence.source.canonicalUrl);
  const playback = evidence.source.playback;
  if (
    playback.kind === "youtube" &&
    (!/^[A-Za-z0-9_-]{11}$/.test(playback.locator ?? "") ||
      playback.locator !== evidence.source.platformId)
  )
    fail("UNSAFE_URL", "Invalid YouTube player identity.");
  if (
    playback.kind === "native" &&
    !/^media:[A-Za-z0-9_-]+$/.test(playback.locator ?? "")
  )
    publicUrl(playback.locator);
  if (playback.kind === "link-only" && playback.locator !== null)
    publicUrl(playback.locator);
  if (playback.kind === "none" && playback.locator !== null)
    fail("INVALID_CONTRACT", "Absent player must not have a locator.");
  for (const segment of segments.values())
    validTimes(segment.startMs, segment.endMs, evidence.source.durationMs);
  for (const range of evidence.extraction.processedRanges)
    validTimes(range.startMs, range.endMs, evidence.source.durationMs);
  for (const gap of evidence.extraction.gaps)
    validTimes(gap.startMs, gap.endMs, evidence.source.durationMs);
  for (const frame of frames.values())
    if (
      evidence.source.durationMs !== null &&
      frame.timestampMs > evidence.source.durationMs
    )
      fail("INVALID_CONTRACT", "Frame timestamp exceeds source duration.");
  const timed = evidence.segments.filter((s) => s.startMs !== null).length;
  const timing =
    timed === 0 ? "none" : timed === segments.size ? "complete" : "partial";
  if (timing !== evidence.extraction.timing)
    fail("INVALID_CONTRACT", "Timing status contradicts actual segments.");
  const membership = evidence.chunks.flatMap((chunk) => chunk.segmentIds);
  if (
    membership.length !== segments.size ||
    new Set(membership).size !== segments.size ||
    membership.some((value, index) => value !== evidence.segments[index]?.id)
  )
    fail(
      "INVALID_CONTRACT",
      "Chunks must cover each segment exactly once in order.",
    );
  for (const chunk of chunks.values())
    if (
      chunk.segmentIds.length === 0 ||
      chunk.contextSegmentIds.some((value) => !segments.has(value))
    )
      fail("INVALID_REFERENCE", "Invalid chunk context.");
  return { segments, frames, chunks };
}
export function statements(report) {
  const result = [...report.summary, ...report.caveats];
  for (const section of report.sections)
    for (const block of section.blocks) {
      if (block.statement) result.push(block.statement);
      if (block.items) result.push(...block.items);
      if (block.rows) result.push(...block.rows.flat());
      if (block.caption) result.push(block.caption);
      if (block.type === "code") result.push(block);
    }
  return result;
}
export function validateData({
  request,
  evidence,
  analysis,
  report,
  evidenceSha256,
}) {
  assertSchema("request", request);
  assertSchema("analysis", analysis);
  assertSchema("report", report);
  const maps = validateEvidence(evidence);
  uniqueMap(report.sections);
  if (
    report.evidenceRef.id !== evidence.id ||
    report.evidenceRef.sha256 !== evidenceSha256 ||
    analysis.evidenceId !== evidence.id
  )
    fail(
      "EVIDENCE_MISMATCH",
      "Report/analysis does not reference these exact evidence bytes.",
    );
  if (
    request.mode !== report.mode ||
    request.outputLanguage !== report.outputLanguage
  )
    fail("INVALID_CONTRACT", "Report mode/language differs from request.");
  if (
    (!evidence.segments.length && !evidence.frames.length) ||
    evidence.extraction.status === "failed"
  )
    fail(
      "NO_USABLE_EVIDENCE",
      "Cannot summarize metadata-only or failed evidence.",
    );
  if (
    evidence.extraction.status === "partial" &&
    request.policy.partialEvidenceApproval?.evidenceSha256 !== evidenceSha256
  )
    fail(
      "UNREVIEWED_EVIDENCE",
      "Partial extraction requires approval for this exact evidence snapshot.",
    );
  if (
    analysis.reviewedChunkIds.some((id) => !maps.chunks.has(id)) ||
    analysis.inspectedFrameIds.some((id) => !maps.frames.has(id))
  )
    fail("INVALID_REFERENCE", "Analysis contains unknown evidence IDs.");
  const reviewed = new Set(analysis.reviewedChunkIds);
  const missing = [...maps.chunks.keys()]
    .filter((id) => !reviewed.has(id))
    .sort();
  if ((missing.length === 0) !== (analysis.status === "complete"))
    fail("INVALID_CONTRACT", "Analysis status contradicts reviewed chunks.");
  if (missing.length) {
    const approval = request.policy.partialAnalysisApproval;
    if (
      !approval ||
      approval.evidenceSha256 !== evidenceSha256 ||
      JSON.stringify([...approval.unreviewedChunkIds].sort()) !==
        JSON.stringify(missing) ||
      approval.limitationsSha256 !==
        sha256(JSON.stringify(analysis.limitations))
    )
      fail(
        "UNREVIEWED_EVIDENCE",
        "Partial analysis requires approval for this exact missing scope.",
      );
  }
  const reviewedSegments = new Set(
    evidence.chunks
      .filter((chunk) => reviewed.has(chunk.id))
      .flatMap((chunk) => chunk.segmentIds),
  );
  for (const statement of statements(report))
    for (const citation of statement.citations) {
      const map = citation.kind === "segment" ? maps.segments : maps.frames;
      if (!map.has(citation.id))
        fail("INVALID_REFERENCE", "Claim cites unknown evidence.");
      if (citation.kind === "segment" && !reviewedSegments.has(citation.id))
        fail(
          "UNREVIEWED_EVIDENCE",
          "Claim cites a chunk outside the reviewed scope.",
        );
      if (
        citation.kind === "frame" &&
        !analysis.inspectedFrameIds.includes(citation.id)
      )
        fail("UNCONFIRMED_FRAME", "Frame was not inspected by the host.");
    }
  const diagramIds = new Set();
  for (const section of report.sections)
    for (const block of section.blocks) {
      if (block.type === "diagram") validateDiagram(block, diagramIds);
      if (
        block.type === "table" &&
        block.rows.some((row) => row.length !== block.columns.length)
      )
        fail("INVALID_CONTRACT", "Table column counts differ.");
      if (block.type === "quote" && block.verbatim) {
        const source = block.statement.citations
          .filter((c) => c.kind === "segment")
          .map((c) => maps.segments.get(c.id).text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (!source.includes(block.statement.text.replace(/\s+/g, " ").trim()))
          fail(
            "INVALID_CONTRACT",
            "Verbatim quotation is not in the cited transcript.",
          );
      }
      if (
        block.type === "figure" &&
        (!maps.frames.has(block.frameId) ||
          !analysis.inspectedFrameIds.includes(block.frameId) ||
          !block.caption.citations.some(
            (c) => c.kind === "frame" && c.id === block.frameId,
          ))
      )
        fail(
          "UNCONFIRMED_FRAME",
          "Figure requires an inspected frame and matching citation.",
        );
    }
  return maps;
}
/** Structural checks the schema cannot express: references, acyclicity, focal budget. */
function validateDiagram(block, seen) {
  if (seen.has(block.id)) fail("INVALID_CONTRACT", "Duplicate diagram ID.");
  seen.add(block.id);
  const ids = new Set(block.nodes.map((n) => n.id));
  if (ids.size !== block.nodes.length)
    fail("INVALID_CONTRACT", "Duplicate diagram node ID.");
  if (block.nodes.filter((n) => n.focal).length > 2)
    fail("INVALID_CONTRACT", "A diagram may emphasize at most two nodes.");
  if (block.kind === "stack") {
    if (block.edges.length)
      fail("INVALID_CONTRACT", "Stack diagrams have no edges.");
    return assertNoTruncation(block);
  }
  if (!block.edges.length)
    fail("INVALID_CONTRACT", "Flow diagrams need edges.");
  const pairs = new Set();
  for (const e of block.edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to)
      fail("INVALID_REFERENCE", "Diagram edge references an unknown node.");
    const key = `${e.from}>${e.to}`;
    if (pairs.has(key)) fail("INVALID_CONTRACT", "Duplicate diagram edge.");
    pairs.add(key);
  }
  const touched = new Set(block.edges.flatMap((e) => [e.from, e.to]));
  if (touched.size !== ids.size)
    fail("INVALID_CONTRACT", "Every flow node must be connected.");
  // Kahn's algorithm: any remaining node means a cycle, which has no layered layout.
  const indegree = new Map(block.nodes.map((n) => [n.id, 0]));
  for (const e of block.edges) indegree.set(e.to, indegree.get(e.to) + 1);
  const queue = [...indegree].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited++;
    for (const e of block.edges)
      if (
        e.from === id &&
        indegree.set(e.to, indegree.get(e.to) - 1).get(e.to) === 0
      )
        queue.push(e.to);
  }
  if (visited !== block.nodes.length)
    fail("INVALID_CONTRACT", "Flow diagrams must be acyclic.");
  assertNoTruncation(block);
}
function assertNoTruncation(block) {
  const cut = diagramTruncations(block);
  if (cut.length)
    fail(
      "INVALID_CONTRACT",
      `Diagram ${block.id}: ${cut
        .map((c) => `node ${c.id} ${c.field} would be cut to "${c.shown}"`)
        .join(
          "; ",
        )}. Shorten it (a label wraps to two lines, a sublabel has one) or move the detail into the caption.`,
    );
}
export async function loadBundle(options) {
  const request = normalizeRequest((await readJson(options.request)).data);
  const evidenceFile = await readJson(options.evidence),
    reportFile = await readJson(options.report);
  const analysis = (await readJson(options.analysis)).data;
  const bundle = {
    request,
    evidence: evidenceFile.data,
    analysis,
    report: reportFile.data,
    evidenceSha256: evidenceFile.sha256,
    reportSha256: reportFile.sha256,
    workDir: await realpath(
      options["work-dir"] ?? path.dirname(options.evidence),
    ),
  };
  const manifestPath = path.join(bundle.workDir, "manifest.json");
  if (await exists(manifestPath)) {
    const acquisition = (await readJson(manifestPath)).data;
    if (
      acquisition.evidenceSha256 !== bundle.evidenceSha256 ||
      (acquisition.sourceInput &&
        (acquisition.sourceInput.kind !== request.source.kind ||
          acquisition.sourceInput.value !== request.source.value))
    )
      fail(
        "EVIDENCE_MISMATCH",
        "Request/evidence differs from this acquisition job.",
      );
  }
  bundle.maps = validateData(bundle);
  // Validate every asset before any renderer reads it, even when not cited.
  for (const frame of bundle.evidence.frames) {
    const file = await containedFile(
      bundle.workDir,
      frame.assetPath,
      20 * 1024 * 1024,
    );
    const bytes = await readFile(file);
    const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if ((!png && !jpeg) || sha256(bytes) !== frame.sha256)
      fail("INVALID_CONTRACT", "Invalid frame image or hash.");
  }
  return bundle;
}
