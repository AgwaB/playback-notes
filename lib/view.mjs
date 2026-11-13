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
const WIDE_CHAR =
  /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u;
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
        .filter(
          (o) => Math.abs(o.byHeight - item.byHeight) <= 0.2 * item.byHeight,
        )
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
/**
 * Built-in text in the report language where a translation ships, English otherwise. A
 * translation lists every key (tests compare them), so a new label cannot ship half-translated.
 */
export function labels(language) {
  return { ...ENGLISH, ...(TRANSLATED[primaryLanguage(language)] ?? {}) };
}
/** Reader-facing wording of extraction warnings whose message has no run-specific detail. */
function warningText(warning, language) {
  return (
    TRANSLATED_WARNINGS[primaryLanguage(language)]?.[warning.code] ??
    warning.message
  );
}
/** "ko" for "ko-KR"; an unusable tag keeps the English text. */
function primaryLanguage(tag) {
  try {
    return new Intl.Locale(tag).language;
  } catch {
    return "en";
  }
}
const ENGLISH = {
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
  sourceTimes: "Source & timestamps",
  transcriptTimes: "Source timestamps",
  unavailableTimes: "Playback unavailable. Use the source link.",
  privacyTimes:
    "The full transcript is not included in this document; see the source.",
  asrCaveat:
    "Automatic transcription can be wrong. Check names, numbers, language changes and cited times against the source.",
};
const TRANSLATED = {
  ko: {
    overview: "한눈에 보기",
    contents: "목차",
    source: "원본과 전사본",
    open: "원본 보기",
    close: "닫기",
    pin: "옆에 고정",
    follow: "재생 위치 따라가기",
    caveats: "조건과 유의점",
    limitations: "범위와 한계",
    interpretation: "해석",
    paraphrase: "번역·의역",
    original: "원본 열기",
    untimed: "시각 정보 없음",
    transcript: "전사본",
    unavailable: "재생할 수 없습니다. 전사본이나 원본 링크를 이용하세요.",
    local:
      "로컬 원본: HTTP로 열어야 재생되며, 공유 폴더에는 미디어 파일이 들어 있지 않을 수 있습니다.",
    briefing: "브리핑",
    deep: "심층 분석",
    skip: "본문으로 건너뛰기",
    privacy: "이 문서에는 원본 전사본이 들어 있습니다.",
    privacyFrames: "이 문서에는 원본 영상의 프레임 이미지가 들어 있습니다.",
    frames: "인용한 프레임",
    screenText: "화면 속 글자",
    screenTranslation: "번역",
    screenOriginal: "원본",
    screenTranslated: "번역본",
    scopeFrames: "확인한 프레임",
    visual: "화면 근거는 직접 확인한 프레임에 한정됩니다.",
    noVisual: "전사본 기반 리포트이며 영상 화면은 분석하지 않았습니다.",
    textOnly:
      "인용은 출처를 추적할 수 있게 해 줄 뿐, 사실 여부를 자동으로 보증하지 않습니다.",
    refs: "출처",
    generated: "같은 구조화 리포트에서 생성됨",
    partial: "원본 또는 분석이 일부만 이루어졌습니다.",
    timing: "일부 또는 모든 문장에 시각 정보가 없습니다.",
    scope: "검토한 전사 구간",
    errors: "내보내기 상태",
    preparing: "플레이어 준비 중…",
    failedFormat: "생성되지 않음",
    reconstructed: "재구성한 코드",
    details: "문서 정보",
    moreCitations: "인용 더 보기",
    hideCitations: "추가 인용 숨기기",
    video: "원본 영상",
    audio: "원본 오디오",
    videoNotes: "영상 노트",
    audioNotes: "오디오 노트",
    youtube: "YouTube 영상",
    sourceTimes: "원본과 시각",
    transcriptTimes: "원본 시각",
    unavailableTimes: "재생할 수 없습니다. 원본 링크를 이용하세요.",
    privacyTimes:
      "이 문서에는 전체 전사본이 들어 있지 않습니다. 원본을 참고하세요.",
    asrCaveat:
      "자동 전사는 틀릴 수 있습니다. 이름, 숫자, 언어가 바뀌는 부분, 인용 시각을 원본과 대조하세요.",
  },
};
// Only warnings whose stored message carries no run-specific detail a reader needs (segment
// IDs) are reworded; every other code keeps its stored English message.
const TRANSLATED_WARNINGS = {
  ko: {
    ASR_END_CLAMPED:
      "전사 마지막 부분의 끝 시각이 오디오 길이를 넘어, 오디오가 끝나는 시각으로 맞추었습니다.",
    FRAMES_CUTS_DROPPED:
      "프레임 수 상한에 걸려 장면 전환 지점의 표본은 빼고 일정 간격 표본만 남겼습니다. 영상 전체를 다루지만, 그 사이의 짧은 장면은 빠질 수 있습니다.",
    ASR_UNVERIFIED:
      "로컬 음성 인식은 말을 빠뜨리거나, 번역하거나, 로마자로 적거나, 잘못 받아쓸 수 있습니다. 언어가 바뀌는 부분에서 특히 그렇고, 구간 시각도 부정확할 수 있으니 원본을 확인하세요.",
    AUTOMATIC_CAPTIONS:
      "원본 자막은 자동 생성된 것이어서 받아쓰기 오류가 있을 수 있습니다.",
    AUTO_CAPTIONS_REPLACED:
      "영상에 자동 생성 자막만 있어, 승인에 따라 오디오를 로컬에서 전사해 사용했습니다.",
    COVERAGE_UNVERIFIED:
      "전사본을 가져오는 과정은 모든 발화나 화면 내용을 검증하지 않으며, 전체 길이 중 얼마가 담겼는지도 주장하지 않습니다.",
    DURATION_UNVERIFIED:
      "자막이 영상의 표시 길이보다 늦게 끝나, 자막을 자르거나 길이를 늘리지 않고 길이를 미확인으로 두었습니다.",
    FRAMES_SAMPLED:
      "프레임은 일정 간격과 장면 전환 지점에서 뽑은 것이어서, 그 사이의 장면은 반영되지 않았습니다.",
    PLATFORM_MEDIA_DOWNLOADED:
      "사용자 승인에 따라 원본 미디어를 비공개 작업 폴더에 내려받아 로컬 전사나 프레임 추출에 사용했습니다(플랫폼 약관은 다운로드를 제한합니다). 공유 결과물에는 복사되지 않습니다.",
    PLATFORM_VIDEO_DOWNLOADED:
      "사용자 승인에 따라 프레임 추출용 저해상도(480p 이하) 영상을 비공개 작업 폴더에 내려받았습니다(플랫폼 약관은 다운로드를 제한합니다). 공유 결과물에는 복사되지 않습니다.",
    PODCAST_PUBLISHER_TRANSCRIPT:
      "전사본은 팟캐스트가 피드에 게시한 것이며 오디오와 대조하지 않았습니다. 시각은 게시자 버전 기준이어서, 내려받을 때 삽입되는 광고에 따라 실제로 듣는 위치와 어긋날 수 있습니다.",
  },
};
export function buildView(bundle, artifacts = [], exportIssues = []) {
  const { report, evidence, analysis, maps } = bundle;
  // With publishTranscript false the source panel keeps one timestamp per segment (so
  // citations still seek and highlight) but no transcript text.
  const publishTranscript = bundle.request?.policy?.publishTranscript !== false;
  const base = labels(report.outputLanguage);
  const ui = publishTranscript
    ? base
    : {
        ...base,
        source: base.sourceTimes,
        transcript: base.transcriptTimes,
        unavailable: base.unavailableTimes,
        privacy: base.privacyTimes,
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
    else limitations.push(warningText(warning, report.outputLanguage));
  }
  // Even an imported recheck warning without ASR_UNVERIFIED must retain its correctness caveat.
  if (
    technicalDetails.some((w) => w.code === "ASR_LANGUAGE_RECHECK") &&
    !evidence.extraction.warnings.some((w) => w.code === "ASR_UNVERIFIED")
  )
    limitations.push(ui.asrCaveat);
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
      ? ui.privacyTimes
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
