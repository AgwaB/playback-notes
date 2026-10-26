import { diagramSvg } from "./diagram.mjs";
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
// Extraction warnings are emitted in English by the worker; reports in Korean show these
// equivalents (keyed by code), anything unknown falls back to the English message.
const WARNING_KO = Object.freeze({
  COVERAGE_UNVERIFIED:
    "자막·전사 확보가 모든 발화나 화면 내용을 담았다는 보장은 아니며, 구간 커버리지 비율을 주장하지 않습니다.",
  AUTOMATIC_CAPTIONS:
    "원본 자막은 자동 생성된 것으로, 전사 오류가 있을 수 있습니다.",
  TIMING_UNAVAILABLE:
    "일부 또는 전체 구간의 시간 정보가 없습니다. 시간은 추정하지 않았습니다.",
  DOM_CAPTURE_PARTIAL:
    "화면에 표시된 자막 행만 가져왔으므로 로드되지 않은 행은 빠졌을 수 있습니다. 시작 시각은 초 단위이며 종료 시각은 없습니다.",
  BROWSER_CAPTURE_UNVERIFIED:
    "사용자 브라우저에서 캡처한 자막을 가져왔습니다. 수집 과정과 메타데이터는 독립 검증되지 않았습니다.",
  BROWSER_ACQUISITION:
    "익명 관리형 브라우저로 수집했습니다. 메타데이터·자막 정확성·전체 커버리지는 독립 검증되지 않았습니다.",
  USER_TRANSCRIPT_UNVERIFIED:
    "사용자가 제공한 전사입니다. 영상과의 일치와 완전성은 독립 검증되지 않았습니다.",
  REMOTE_METADATA_UNVERIFIED:
    "사용자 전사를 사용했으므로 원격 영상의 메타데이터와 가용성은 조회하지 않았습니다.",
  ASR_UNVERIFIED:
    "로컬 음성 인식 결과이므로 전사 오류가 있을 수 있습니다. 원본과 대조해 확인하세요.",
  ASR_SUSPECT_SEGMENTS:
    "일부 음성 인식 구간이 Whisper가 음악·무음 위에 지어내곤 하는 문구(자막 제작자 표기, 시청 감사 인사 등)와 일치합니다. 인용 전에 원본을 확인하세요.",
  ASR_MODEL_COMPACT:
    "소형 음성 인식 모델을 사용했습니다. 숫자·조건·부정 표현은 특히 오인식될 수 있습니다.",
  FRAMES_CUTS_DROPPED:
    "장면 전환 샘플까지 포함하면 프레임 상한을 넘어, 영상 전체를 고르게 덮는 간격 샘플만 남겼습니다. 샘플 사이의 짧은 장면은 빠졌을 수 있습니다.",
  FRAMES_TRUNCATED:
    "프레임 상한에 도달해 영상 뒷부분의 장면은 샘플링되지 않았습니다.",
  FRAMES_SAMPLED:
    "화면은 일정 간격과 장면 전환 시점에서 샘플링한 프레임입니다. 샘플 사이의 장면은 포함되지 않습니다.",
  VISUAL_OCR_UNVERIFIED:
    "화면 텍스트는 장면 전환 시점에서 샘플링한 프레임을 기계 판독한 것입니다. 인식 오류와 누락된 장면이 있을 수 있습니다.",
  BOTGUARD_TOKEN:
    "자막 요청에 로컬에서 생성한 proof-of-origin 토큰을 사용했습니다(모든 YouTube 클라이언트와 같은 방식, 네트워크·파일 접근이 차단된 격리 프로세스).",
  CAPTIONS_ANDROID_CLIENT:
    "이 영상의 웹 자막은 proof-of-origin 토큰이 필요한데 여기서는 쓸 수 없어, YouTube가 Android 앱에 주는 자막 목록에서 같은 자막을 읽었습니다.",
  PLATFORM_MEDIA_DOWNLOADED:
    "로컬 전사를 위해 오디오를 비공개 작업 폴더에 내려받았습니다(사용자 승인). 공유 출력에는 포함되지 않습니다.",
  PLATFORM_VIDEO_DOWNLOADED:
    "핵심 장면 추출을 위해 저해상도(≤480p) 무음 영상을 비공개 작업 폴더에 내려받았습니다(사용자 승인). 공유 출력에는 포함되지 않습니다.",
  DURATION_UNVERIFIED:
    "자막이 영상의 표시 길이보다 뒤에서 끝나므로 길이는 미확인으로 두었습니다. 자막을 자르거나 길이를 늘리지 않았습니다.",
});
function warningText(warning, language) {
  return (
    (language.toLowerCase().startsWith("ko") && WARNING_KO[warning.code]) ||
    warning.message
  );
}
function labels(language) {
  return language.toLowerCase().startsWith("ko")
    ? {
        overview: "한눈에 보기",
        contents: "목차",
        source: "원본 · 전사",
        open: "원본 열기",
        close: "닫기",
        pin: "옆에 고정",
        follow: "재생 위치 따라가기",
        caveats: "조건과 주의사항",
        limitations: "분석 범위와 한계",
        interpretation: "해석",
        paraphrase: "번역·의역",
        original: "원본에서 보기",
        untimed: "시간 정보 없음",
        transcript: "전사",
        unavailable: "재생할 수 없습니다. 전사 또는 원본 링크를 이용하세요.",
        local:
          "로컬 원본: HTTP 열람이 필요하며 공유 폴더에 영상이 없을 수 있습니다.",
        briefing: "브리핑",
        deep: "딥다이브",
        skip: "본문으로 이동",
        privacy: "이 문서에는 원본 전사가 포함됩니다.",
        privacyFrames: "이 문서에는 원본 화면 이미지가 포함됩니다.",
        frames: "인용한 화면",
        scopeFrames: "확인한 화면",
        visual: "화면 근거는 확인한 이미지에 한정됩니다.",
        noVisual: "화면을 분석하지 않은 전사 기반 리포트입니다.",
        textOnly:
          "내용은 인용을 통해 추적할 수 있지만 기계 검증이 사실 정확성을 보증하지는 않습니다.",
        refs: "출처",
        generated: "같은 구조화 리포트에서 생성",
        partial: "원본 또는 분석이 일부만 처리되었습니다.",
        timing: "일부 또는 모든 발언에 시간 정보가 없습니다.",
        scope: "검토한 구간",
        errors: "내보내기 상태",
        preparing: "플레이어 준비 중…",
        failedFormat: "생성되지 않음",
        reconstructed: "코드 재구성",
      }
    : {
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
          "Local source: HTTP viewing is required; the video may not be included in a shared folder.",
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
        scope: "Reviewed chunks",
        errors: "Export status",
        preparing: "Preparing player…",
        failedFormat: "Not generated",
        reconstructed: "Reconstructed code",
      };
}
export function buildView(bundle, artifacts = [], exportIssues = []) {
  const { report, evidence, analysis, maps } = bundle;
  // With publishTranscript false the source panel keeps one timestamp per segment (so
  // citations still seek and highlight) but no transcript text.
  const publishTranscript = bundle.request?.policy?.publishTranscript !== false;
  const base = labels(report.outputLanguage);
  const ko = report.outputLanguage.toLowerCase().startsWith("ko");
  const ui = publishTranscript
    ? base
    : {
        ...base,
        source: ko ? "원본 · 타임스탬프" : "Source & timestamps",
        transcript: ko ? "출처 타임스탬프" : "Source timestamps",
        unavailable: ko
          ? "재생할 수 없습니다. 원본 링크를 이용하세요."
          : "Playback unavailable. Use the source link.",
        privacy: ko
          ? "전체 자막은 이 문서에 포함하지 않았습니다. 원본에서 확인하세요."
          : "The full transcript is not included in this document; see the source.",
      };
  const citation = (c) => {
    const item =
      c.kind === "segment" ? maps.segments.get(c.id) : maps.frames.get(c.id);
    const ms = c.kind === "segment" ? item.startMs : item.timestampMs;
    return {
      ...c,
      ms,
      timed: ms !== null,
      label: ms === null ? `${ui.transcript} ${c.id}` : timestamp(ms),
      href: sourceLink(evidence.source, ms),
      anchor: `${c.kind === "segment" ? "tx" : "frame"}-${c.id}`,
    };
  };
  const order = new Map(evidence.segments.map((s, i) => [s.id, i]));
  // Strictly adjacent timed segment citations collapse into one chip labelled with the first
  // and last cue *start* times; it seeks to the first. Deliberately separate citations stay separate.
  const grouped = (citations) => {
    const out = [];
    for (const c of citations.map(citation)) {
      const last = out.at(-1);
      const adjacent =
        last &&
        c.kind === "segment" &&
        last.kind === "segment" &&
        c.timed &&
        last.timed &&
        order.get(c.id) - order.get(last.lastId) === 1;
      if (adjacent) {
        last.lastId = c.id;
        last.label = `${timestamp(last.ms)}–${timestamp(c.ms)}`;
      } else out.push({ ...c, lastId: c.id });
    }
    return out;
  };
  const statement = (s) => ({
    ...s,
    interpretation: s.attribution === "interpretation",
    citations: grouped(s.citations),
  });
  const sections = report.sections.map((section) => ({
    ...section,
    blocks: section.blocks.map((block) => ({
      ...block,
      statement: block.statement ? statement(block.statement) : null,
      items: block.items?.map(statement),
      rows: block.rows?.map((row) => row.map(statement)),
      caption: block.caption ? statement(block.caption) : null,
      citations: block.citations && grouped(block.citations),
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
  if (
    evidence.extraction.status !== "complete" ||
    analysis.status !== "complete"
  )
    limitations.unshift(ui.partial);
  // Timing/transcript notices only make sense when there is a transcript at all.
  if (evidence.segments.length && evidence.extraction.timing !== "complete")
    limitations.push(ui.timing);
  for (const gap of evidence.extraction.gaps)
    limitations.push(
      `${timestamp(gap.startMs)}–${timestamp(gap.endMs)} ${gap.reason}`,
    );
  for (const warning of evidence.extraction.warnings)
    limitations.push(warningText(warning, report.outputLanguage));
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
  return {
    title: report.title,
    language: report.outputLanguage,
    modeLabel: report.mode === "briefing" ? ui.briefing : ui.deep,
    ui,
    source: evidence.source,
    sourceHref: sourceLink(evidence.source),
    playerLocator: evidence.source.playback.locator?.startsWith("media:")
      ? `media/${evidence.source.id}`
      : evidence.source.playback.locator,
    summary: report.summary.map(statement),
    sections,
    caveats: report.caveats.map(statement),
    limitations,
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
