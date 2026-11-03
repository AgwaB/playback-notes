import { diagramSvg } from "./diagram.mjs";
import { phraseHtml } from "./phrases.mjs";
import Handlebars from "handlebars";
import { publicUrl, statements } from "./validation.mjs";
export function timestamp(ms) {
  if (ms === null) return "";
  const s = Math.floor(ms / 1000),
    hours = Math.floor(s / 3600);
  return `${hours ? `${hours}:` : ""}${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function sourceLink(source, ms = null) {
  if (!source.canonicalUrl) return null;
  const safe = publicUrl(source.canonicalUrl);
  let url;
  try {
    url = new URL(safe);
  } catch {
    return null;
  }
  if (ms !== null && source.kind === "youtube")
    url.searchParams.set("t", `${Math.floor(ms / 1000)}s`);
  else if (ms !== null && source.kind === "direct-media")
    url.hash = `t=${ms / 1000}`;
  return url.href;
}
// Full-width characters (Hangul, CJK, kana) take about 1 em; Latin text about 0.56 em.
const WIDE_CHAR = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u;
const textEms = (text) =>
  [...text].reduce(
    (sum, c) => sum + (WIDE_CHAR.test(c) ? 1 : c === " " ? 0.3 : 0.56),
    0,
  );
const luminance = (hex) =>
  [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const pct = (value) => `${(value * 100).toFixed(2)}%`;
/**
 * Translations placed where their lines are on the frame, on the slide's own colour. Sizes
 * are in container-width units: each fits its line's height and, growing up to half again
 * the line's width, its translated length; lines of about one height share the smallest.
 */
export function screenOverlay(lines, frame) {
  const ratio = frame.height / frame.width;
  const items = lines.map(({ translation, box, background = "#ffffff" }) => {
    const x = Math.max(0, box.x - 0.012),
      y = Math.max(0, box.y - 0.008);
    const w = Math.min(1 - x, box.w + 0.024),
      h = Math.min(1 - y, box.h + 0.016);
    const room = Math.max(w, Math.min(1 - x - 0.01, w * 1.5));
    const byHeight = 0.8 * h * ratio;
    return {
      translation,
      x,
      y,
      w,
      h,
      room,
      background,
      byHeight,
      fit: Math.min(byHeight, (room * 0.98) / textEms(translation)),
    };
  });
  return items.map((item) => {
    const size = Math.min(
      ...items
        .filter((o) => Math.abs(o.byHeight - item.byHeight) <= 0.2 * item.byHeight)
        .map((o) => o.fit),
    );
    return {
      text: item.translation,
      style: `left:${pct(item.x)};top:${pct(item.y)};min-width:${pct(item.w)};max-width:${pct(item.room)};height:${pct(item.h)};font-size:${(size * 100).toFixed(3)}cqw;background:${item.background};color:${luminance(item.background) > 0.5 ? "#1f2430" : "#f5f5f2"}`,
    };
  });
}
const TECHNICAL_WARNINGS = new Set([
  "BOTGUARD_TOKEN",
  "CAPTIONS_ANDROID_CLIENT",
  "ASR_GPU_FALLBACK",
  "ASR_LANGUAGE_RECHECK",
]);
/** Writing direction of the report language (Arabic, Hebrew, Persian, Urdu and others are RTL). */
export function textDirection(language) {
  try {
    const locale = new Intl.Locale(language);
    const info =
      typeof locale.getTextInfo === "function"
        ? locale.getTextInfo()
        : locale.textInfo;
    return info?.direction === "rtl" ? "rtl" : "ltr";
  } catch {
    return "ltr";
  }
}
function labels() {
  return {
    overview: "At a glance",
    contents: "Contents",
    source: "Source & transcript",
    open: "Open source",
    close: "Close",
    pin: "Pin alongside",
    follow: "Follow playback",
    caveats: "Conditions & caveats",
    limitations: "Scope & limitations",
    interpretation: "Interpretation",
    paraphrase: "Translation / paraphrase",
    original: "Open original",
    untimed: "No timestamp",
    transcript: "Transcript",
    unavailable: "Playback unavailable. Use the transcript or source link.",
    local:
      "Local source: HTTP viewing is required; the media file may not be included in a shared folder.",
    briefing: "Briefing",
    deep: "Deep dive",
    skip: "Skip to content",
    privacy: "This document contains the source transcript.",
    privacyFrames: "This document contains source frame images.",
    frames: "Cited frames",
    screenText: "On-screen text",
    screenTranslation: "Translation",
    screenOriginal: "Original",
    screenTranslated: "Translated",
    scopeFrames: "Inspected frames",
    visual: "Visual grounding is limited to inspected frames.",
    noVisual: "Transcript-based report; source visuals were not analyzed.",
    textOnly:
      "Citations enable traceability, not an automated guarantee of factual accuracy.",
    refs: "Sources",
    generated: "Generated from the same structured report",
    partial: "The source or analysis is partial.",
    timing: "Some or all statements lack timestamps.",
    scope: "Reviewed transcript chunks",
    errors: "Export status",
    preparing: "Preparing player…",
    failedFormat: "Not generated",
    reconstructed: "Reconstructed code",
    details: "Document details",
    moreCitations: "More citations",
    hideCitations: "Hide additional citations",
    video: "Source video",
    audio: "Source audio",
    videoNotes: "VIDEO NOTES",
    audioNotes: "AUDIO NOTES",
    youtube: "YouTube video",
  };
}
export function buildView(bundle, artifacts = [], exportIssues = []) {
  const { report, evidence, analysis, maps } = bundle;
  // With publishTranscript false the source panel keeps one timestamp per segment (so
  // citations still seek and highlight) but no transcript text.
  const publishTranscript = bundle.request?.policy?.publishTranscript !== false;
  const base = labels();
  const ui = publishTranscript
    ? base
    : {
        ...base,
        source: "Source & timestamps",
        transcript: "Source timestamps",
        unavailable: "Playback unavailable. Use the source link.",
        privacy:
          "The full transcript is not included in this document; see the source.",
      };
  const segmentPositions = new Map(
    evidence.segments.map((s, index) => [s.id, index + 1]),
  );
  const framePositions = new Map(
    evidence.frames.map((f, index) => [f.id, index + 1]),
  );
  const citation = (c) => {
    const item =
      c.kind === "segment" ? maps.segments.get(c.id) : maps.frames.get(c.id);
    const ms = c.kind === "segment" ? item.startMs : item.timestampMs;
    return {
      ...c,
      ms,
      timed: ms !== null,
      label:
        ms === null
          ? c.kind === "segment"
            ? `${ui.transcript} ${segmentPositions.get(c.id)}`
            : `${ui.frames} ${framePositions.get(c.id)}`
          : timestamp(ms),
      href: sourceLink(evidence.source, ms),
      anchor: `${c.kind === "segment" ? "tx" : "frame"}-${c.id}`,
      position:
        c.kind === "segment"
          ? segmentPositions.get(c.id)
          : framePositions.get(c.id),
    };
  };
  let citationGroup = 0;
  // Every original citation remains a separate link in HTML and print. Only the
  // interactive presentation folds the extra links. Markdown writes a run of
  // consecutive timed segments as one range (see lib/markdown.mjs).
  const citationView = (source) => {
    const citations = source.map(citation);
    return {
      citations,
      leadCitation: citations[0] ?? null,
      extraCitations: citations.slice(1),
      extraCitationCount: Math.max(0, citations.length - 1),
      citationDisclosureId: `citation-extra-${++citationGroup}`,
      moreCitationLabel: `${ui.moreCitations} ${Math.max(0, citations.length - 1)}`,
    };
  };
  // A quote is attributed only when every cited segment names the same speaker
  // (speakers come from the source's transcript, e.g. a podcast's JSON transcript).
  const quoteSpeaker = (s) => {
    const speakers = new Set(
      s.citations
        .filter((c) => c.kind === "segment")
        .map((c) => maps.segments.get(c.id).speaker ?? null),
    );
    const [only] = speakers;
    return speakers.size === 1 && only ? only : null;
  };
  const statement = (s) => ({
    ...s,
    htmlText: phraseHtml(s.text),
    interpretation: s.attribution === "interpretation",
    ...citationView(s.citations),
  });
  const sections = report.sections.map((section) => ({
    ...section,
    headingHtml: phraseHtml(section.heading),
    blocks: section.blocks.map((block) => ({
      ...block,
      titleHtml: block.title ? phraseHtml(block.title) : null,
      statement: block.statement ? statement(block.statement) : null,
      items: block.items?.map(statement),
      rows: block.rows?.map((row) => row.map(statement)),
      caption: block.caption ? statement(block.caption) : null,
      ...(block.citations ? citationView(block.citations) : {}),
      // Trusted renderer output built only from escaped report text; the template
      // inserts it raw because it is not host-supplied markup.
      svg: block.type === "diagram" ? diagramSvg(block) : null,
      interpretation: block.attribution === "interpretation",
      asset: block.frameId ? maps.frames.get(block.frameId).assetPath : null,
      screenOverlay: block.screenText?.every((line) => line.box)
        ? screenOverlay(block.screenText, maps.frames.get(block.frameId))
        : null,
      speaker: block.type === "quote" ? quoteSpeaker(block.statement) : null,
    })),
  }));
  const limitations = [
    ui.textOnly,
    analysis.inspectedFrameIds.length ? ui.visual : ui.noVisual,
    ...analysis.limitations,
  ];
  let authoredLimitationsStart =
    limitations.length - analysis.limitations.length;
  if (
    evidence.extraction.status !== "complete" ||
    analysis.status !== "complete"
  ) {
    limitations.unshift(ui.partial);
    authoredLimitationsStart++;
  }
  // Timing/transcript notices only make sense when there is a transcript at all.
  if (evidence.segments.length && evidence.extraction.timing !== "complete")
    limitations.push(ui.timing);
  for (const gap of evidence.extraction.gaps)
    limitations.push(
      `${timestamp(gap.startMs)}–${timestamp(gap.endMs)} ${gap.reason}`,
    );
  const technicalDetails = [];
  for (const warning of evidence.extraction.warnings) {
    if (TECHNICAL_WARNINGS.has(warning.code))
      technicalDetails.push({ code: warning.code, message: warning.message });
    else limitations.push(warning.message);
  }
  // Even an imported recheck warning without ASR_UNVERIFIED must retain its correctness caveat.
  if (
    technicalDetails.some((w) => w.code === "ASR_LANGUAGE_RECHECK") &&
    !evidence.extraction.warnings.some((w) => w.code === "ASR_UNVERIFIED")
  )
    limitations.push(
      "Automatic transcription can be wrong. Check names, numbers, language changes and cited times against the source.",
    );
  if (evidence.source.playback.locator?.startsWith("media:"))
    limitations.push(ui.local);
  const figureFrames = new Set(
    report.sections
      .flatMap((s) => s.blocks)
      .filter((b) => b.type === "figure")
      .map((b) => b.frameId),
  );
  const allCitations = new Map();
  for (const s of statements(report))
    for (const c of s.citations)
      allCitations.set(`${c.kind}:${c.id}`, citation(c));
  const sourceName = evidence.source.title || evidence.source.displayName;
  const sourceLabel =
    !sourceName ||
    sourceName === evidence.source.id ||
    sourceName === evidence.source.platformId ||
    /^YouTube\s+[A-Za-z0-9_-]{11}$/i.test(sourceName)
      ? evidence.source.kind === "youtube"
        ? ui.youtube
        : evidence.source.mediaType === "audio"
          ? ui.audio
          : ui.video
      : sourceName;
  const durationSeconds = Math.round((evidence.source.durationMs ?? 0) / 1000);
  const durationLabel =
    durationSeconds > 0
      ? `${Math.floor(durationSeconds / 60)}:${String(durationSeconds % 60).padStart(2, "0")}`
      : null;
  return {
    title: report.title,
    titleHtml: phraseHtml(report.title),
    language: report.outputLanguage,
    direction: textDirection(report.outputLanguage),
    modeLabel: report.mode === "briefing" ? ui.briefing : ui.deep,
    eyebrow:
      evidence.source.mediaType === "audio" ? ui.audioNotes : ui.videoNotes,
    ui,
    source: evidence.source,
    sourceLabel,
    durationLabel,
    technicalDetails,
    sourceHref: sourceLink(evidence.source),
    playerLocator: evidence.source.playback.locator?.startsWith("media:")
      ? `media/${evidence.source.id}`
      : evidence.source.playback.locator,
    summary: report.summary.map(statement),
    sections,
    caveats: report.caveats.map(statement),
    limitations,
    limitationsHtml: limitations.map((text, index) =>
      index >= authoredLimitationsStart &&
      index < authoredLimitationsStart + analysis.limitations.length
        ? phraseHtml(text)
        : Handlebars.escapeExpression(text),
    ),
    segments: evidence.segments.map((s) => ({
      ...s,
      text: publishTranscript ? s.text : "",
      speaker: publishTranscript ? s.speaker : null,
      timed: s.startMs !== null,
      label: s.startMs === null ? ui.untimed : timestamp(s.startMs),
    })),
    scope: evidence.chunks.length
      ? `${analysis.reviewedChunkIds.length}/${evidence.chunks.length}`
      : `${analysis.inspectedFrameIds.length}/${evidence.frames.length}`,
    scopeLabel: evidence.chunks.length ? ui.scope : ui.scopeFrames,
    privacyNotice: evidence.segments.length ? ui.privacy : ui.privacyFrames,
    printPrivacyNotice: evidence.segments.length
      ? "The full transcript is not included in this document; see the source."
      : ui.privacyFrames,
    // Frames cited by statements but not shown as figures get an anchor in the source panel.
    citedFrames: evidence.frames
      .filter(
        (frame) =>
          !figureFrames.has(frame.id) &&
          [...statements(report)].some((s) =>
            s.citations.some((c) => c.kind === "frame" && c.id === frame.id),
          ),
      )
      .map((frame) => ({
        ...frame,
        label: timestamp(frame.timestampMs),
        href: sourceLink(evidence.source, frame.timestampMs),
        ...citationView([{ kind: "frame", id: frame.id }]),
      })),
    references: [...allCitations.values()],
    reportSha256: bundle.reportSha256,
    evidenceSha256: bundle.evidenceSha256,
    exports: artifacts
      .filter((a) => ["markdown", "pdf"].includes(a.format))
      .map((a) => ({
        ...a,
        available: ["created", "reused"].includes(a.status),
      })),
    exportIssues,
  };
}
