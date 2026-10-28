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
const TECHNICAL_WARNINGS = new Set([
  "BOTGUARD_TOKEN",
  "CAPTIONS_ANDROID_CLIENT",
  "ASR_GPU_FALLBACK",
  "ASR_LANGUAGE_RECHECK",
]);
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
    };
  };
  let citationGroup = 0;
  // Every original citation remains a separate link. Only the interactive presentation
  // folds the extra links; print, Markdown and no-JS reading retain them all.
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
