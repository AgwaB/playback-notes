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
  sampledOnly:
    "Frames were sampled from the source, but this report cites none of them.",
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
    sampledOnly:
      "영상에서 프레임을 뽑았지만, 이 리포트에 인용한 장면은 없습니다.",
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
  ja: {
    overview: "概要",
    contents: "目次",
    source: "ソースと文字起こし",
    open: "ソースを表示",
    close: "閉じる",
    pin: "横に固定",
    follow: "再生位置に追従",
    caveats: "条件と注意点",
    limitations: "範囲と限界",
    interpretation: "解釈",
    paraphrase: "翻訳・言い換え",
    original: "オリジナルを開く",
    untimed: "タイムスタンプなし",
    transcript: "文字起こし",
    unavailable:
      "再生できません。文字起こしまたはソースのリンクをご利用ください。",
    local:
      "ローカルソース: HTTP 経由で表示する必要があります。共有フォルダーにメディアファイルが含まれていない場合があります。",
    briefing: "ブリーフィング",
    deep: "ディープダイブ",
    skip: "本文へスキップ",
    privacy: "この文書にはソースの文字起こしが含まれています。",
    privacyFrames: "この文書にはソースのフレーム画像が含まれています。",
    frames: "引用フレーム",
    screenText: "画面上のテキスト",
    screenTranslation: "翻訳",
    screenOriginal: "オリジナル",
    screenTranslated: "翻訳版",
    scopeFrames: "確認したフレーム",
    visual: "映像に基づく根拠は、確認したフレームに限られます。",
    noVisual:
      "文字起こしに基づくレポートです。ソースの映像は分析していません。",
    sampledOnly:
      "ソースからフレームを抽出しましたが、このレポートでは引用していません。",
    textOnly:
      "引用は出典をたどれるようにするもので、事実の正確さを自動的に保証するものではありません。",
    refs: "出典",
    generated: "同じ構造化レポートから生成",
    partial: "ソースまたは分析は一部にとどまります。",
    timing: "一部またはすべての記述にタイムスタンプがありません。",
    scope: "確認した文字起こし区間",
    errors: "エクスポート状況",
    preparing: "プレーヤーを準備中…",
    failedFormat: "未生成",
    reconstructed: "再構成したコード",
    details: "文書の詳細",
    moreCitations: "その他の引用を表示",
    hideCitations: "その他の引用を非表示",
    video: "元の動画",
    audio: "元の音声",
    videoNotes: "動画ノート",
    audioNotes: "音声ノート",
    youtube: "YouTube 動画",
    sourceTimes: "ソースとタイムスタンプ",
    transcriptTimes: "ソースのタイムスタンプ",
    unavailableTimes: "再生できません。ソースのリンクをご利用ください。",
    privacyTimes:
      "この文書に文字起こしの全文は含まれていません。ソースを参照してください。",
    asrCaveat:
      "自動文字起こしには誤りが含まれることがあります。名前、数字、言語が切り替わる箇所、引用した時刻をソースと照合してください。",
  },
  // Simplified Chinese: a Traditional Chinese tag (zh-TW, zh-Hant) has the same primary
  // language and therefore gets these labels too.
  zh: {
    overview: "概览",
    contents: "目录",
    source: "来源与文字稿",
    open: "查看来源",
    close: "关闭",
    pin: "并排固定",
    follow: "跟随播放",
    caveats: "条件与注意事项",
    limitations: "范围与局限",
    interpretation: "解读",
    paraphrase: "翻译 / 转述",
    original: "打开原始内容",
    untimed: "无时间戳",
    transcript: "文字稿",
    unavailable: "无法播放。请使用文字稿或来源链接。",
    local: "本地来源：需要通过 HTTP 查看；共享文件夹中可能不包含媒体文件。",
    briefing: "简报",
    deep: "深度解析",
    skip: "跳到正文",
    privacy: "本文档包含来源的文字稿。",
    privacyFrames: "本文档包含来源的帧图像。",
    frames: "引用的帧",
    screenText: "画面文字",
    screenTranslation: "译文",
    screenOriginal: "原始画面",
    screenTranslated: "翻译画面",
    scopeFrames: "已检查的帧",
    visual: "画面依据仅限于已检查的帧。",
    noVisual: "本报告基于文字稿；未分析来源的画面。",
    sampledOnly: "已从来源中抽取帧，但本报告未引用其中任何一帧。",
    textOnly: "引用用于追溯出处，并不能自动保证事实准确。",
    refs: "来源",
    generated: "由同一份结构化报告生成",
    partial: "来源或分析并不完整。",
    timing: "部分或全部陈述没有时间戳。",
    scope: "已审阅的文字稿片段",
    errors: "导出状态",
    preparing: "正在准备播放器…",
    failedFormat: "未生成",
    reconstructed: "重建的代码",
    details: "文档详情",
    moreCitations: "更多引用",
    hideCitations: "收起其余引用",
    video: "原视频",
    audio: "原音频",
    videoNotes: "视频笔记",
    audioNotes: "音频笔记",
    youtube: "YouTube 视频",
    sourceTimes: "来源与时间戳",
    transcriptTimes: "来源时间戳",
    unavailableTimes: "无法播放。请使用来源链接。",
    privacyTimes: "本文档不包含完整文字稿；请查看来源。",
    asrCaveat:
      "自动转录可能有误。请对照来源核对名称、数字、语言切换处和引用的时间。",
  },
  es: {
    overview: "De un vistazo",
    contents: "Índice",
    source: "Fuente y transcripción",
    open: "Ver fuente",
    close: "Cerrar",
    pin: "Fijar al lado",
    follow: "Seguir la reproducción",
    caveats: "Condiciones y salvedades",
    limitations: "Alcance y limitaciones",
    interpretation: "Interpretación",
    paraphrase: "Traducción / paráfrasis",
    original: "Abrir original",
    untimed: "Sin marca de tiempo",
    transcript: "Transcripción",
    unavailable:
      "Reproducción no disponible. Usa la transcripción o el enlace a la fuente.",
    local:
      "Fuente local: hay que verla por HTTP; es posible que el archivo multimedia no esté incluido en una carpeta compartida.",
    briefing: "Resumen",
    deep: "Análisis en profundidad",
    skip: "Saltar al contenido",
    privacy: "Este documento contiene la transcripción de la fuente.",
    privacyFrames: "Este documento contiene fotogramas de la fuente.",
    frames: "Fotogramas citados",
    screenText: "Texto en pantalla",
    screenTranslation: "Traducción",
    screenOriginal: "Imagen original",
    screenTranslated: "Imagen traducida",
    scopeFrames: "Fotogramas examinados",
    visual: "El respaldo visual se limita a los fotogramas examinados.",
    noVisual:
      "Informe basado en la transcripción; no se analizaron las imágenes de la fuente.",
    sampledOnly:
      "Se tomaron fotogramas de muestra de la fuente, pero este informe no cita ninguno.",
    textOnly:
      "Las citas permiten rastrear el origen; no son una garantía automática de exactitud de los hechos.",
    refs: "Fuentes",
    generated: "Generado a partir del mismo informe estructurado",
    partial: "La fuente o el análisis son parciales.",
    timing: "Algunas o todas las afirmaciones carecen de marca de tiempo.",
    scope: "Fragmentos de transcripción revisados",
    errors: "Estado de la exportación",
    preparing: "Preparando el reproductor…",
    failedFormat: "No generado",
    reconstructed: "Código reconstruido",
    details: "Detalles del documento",
    moreCitations: "Más citas",
    hideCitations: "Ocultar citas adicionales",
    video: "Video original",
    audio: "Audio original",
    videoNotes: "NOTAS DE VIDEO",
    audioNotes: "NOTAS DE AUDIO",
    youtube: "Video de YouTube",
    sourceTimes: "Fuente y marcas de tiempo",
    transcriptTimes: "Marcas de tiempo de la fuente",
    unavailableTimes: "Reproducción no disponible. Usa el enlace a la fuente.",
    privacyTimes:
      "Este documento no incluye la transcripción completa; consulta la fuente.",
    asrCaveat:
      "La transcripción automática puede contener errores. Comprueba nombres, cifras, cambios de idioma y tiempos citados con la fuente.",
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
  ja: {
    ASR_END_CLAMPED:
      "文字起こしの最後の部分の終了時刻が音声の長さを超えていたため、音声の終了時刻に合わせました。",
    FRAMES_CUTS_DROPPED:
      "フレーム数の上限に達したため、場面転換点のサンプルは除き、一定間隔のサンプルのみを残しました。動画全体をカバーしていますが、その間の短い場面が抜けている可能性があります。",
    ASR_UNVERIFIED:
      "ローカル音声認識では、発話の脱落、翻訳、ローマ字化、誤認識が起こることがあり、言語が切り替わる箇所では特に起こりやすくなります。区間の時刻が不正確な場合もあるため、ソースを確認してください。",
    AUTOMATIC_CAPTIONS:
      "ソースの字幕は自動生成されたもので、文字起こしの誤りが含まれている可能性があります。",
    AUTO_CAPTIONS_REPLACED:
      "動画には自動生成字幕しかなかったため、承認に基づき、音声をローカルで文字起こしして使用しました。",
    COVERAGE_UNVERIFIED:
      "文字起こしの取得では、すべての発話や映像の内容を検証していません。全体の長さのうちどの程度をカバーしているかも主張しません。",
    DURATION_UNVERIFIED:
      "字幕が動画の表示上の長さより後に終わっているため、字幕を切り詰めたり長さを延ばしたりせず、長さを不明のままにしました。",
    FRAMES_SAMPLED:
      "フレームは一定間隔と場面転換点で抽出したもので、その間の場面は反映されていません。",
    PLATFORM_MEDIA_DOWNLOADED:
      "ユーザーの承認に基づき、ソースのメディアを非公開の作業フォルダーにダウンロードし、ローカルでの文字起こしやフレーム抽出に使用しました（プラットフォームの利用規約はダウンロードを制限しています）。共有される出力にはコピーされません。",
    PLATFORM_VIDEO_DOWNLOADED:
      "ユーザーの承認に基づき、フレーム抽出用の低解像度（480p 以下）の映像を非公開の作業フォルダーにダウンロードしました（プラットフォームの利用規約はダウンロードを制限しています）。共有される出力にはコピーされません。",
    PODCAST_PUBLISHER_TRANSCRIPT:
      "文字起こしはポッドキャストがフィードで公開したもので、音声とは照合していません。時刻は配信元のバージョンに基づくため、ダウンロード時に挿入される広告によって、実際に聞こえる位置とずれることがあります。",
  },
  zh: {
    ASR_END_CLAMPED:
      "文字稿最后一段的结束时间超出了音频时长，已调整为音频的结束时间。",
    FRAMES_CUTS_DROPPED:
      "由于达到帧数上限，已舍弃镜头切换处的采样，仅保留固定间隔的采样。这些采样覆盖整个视频，但其间的短暂画面可能缺失。",
    ASR_UNVERIFIED:
      "本地语音识别可能漏掉、翻译、罗马化或误识别语音，在语言切换处尤其如此；片段时间也可能不准确。请对照来源核实，尤其是语言切换的地方。",
    AUTOMATIC_CAPTIONS: "来源字幕为自动生成，可能存在转录错误。",
    AUTO_CAPTIONS_REPLACED:
      "该视频只有自动生成的字幕；经批准，改为在本地转录其音频。",
    COVERAGE_UNVERIFIED:
      "获取文字稿的过程不会核实每一句话或画面内容，也不声称覆盖了全部时长的多大比例。",
    DURATION_UNVERIFIED:
      "字幕的结束时间晚于视频标示的时长；未截断字幕，也未延长时长，而是将时长保留为未知。",
    FRAMES_SAMPLED:
      "帧是按固定间隔并在镜头切换处抽取的，采样之间的画面未被反映。",
    PLATFORM_MEDIA_DOWNLOADED:
      "经用户批准，来源媒体已下载到私有工作文件夹，用于本地转录或抽取帧（平台条款限制下载）。它不会被复制到共享的输出中。",
    PLATFORM_VIDEO_DOWNLOADED:
      "经用户批准，已将用于抽取帧的低分辨率（不超过 480p）视频下载到私有工作文件夹（平台条款限制下载）。它不会被复制到共享的输出中。",
    PODCAST_PUBLISHER_TRANSCRIPT:
      "文字稿由播客在其订阅源中发布，未与音频核对。其时间以发布方的版本为准；下载时插入的广告可能使实际听到的位置发生偏移。",
  },
  es: {
    ASR_END_CLAMPED:
      "El final del último tramo de la transcripción superaba la duración del audio, así que se ajustó al final del audio.",
    FRAMES_CUTS_DROPPED:
      "Se alcanzó el límite de fotogramas, por lo que se descartaron las muestras tomadas en los cambios de escena y solo se conservaron las de intervalo fijo. Estas abarcan todo el video, pero puede faltar alguna escena breve entre ellas.",
    ASR_UNVERIFIED:
      "El reconocimiento de voz local puede omitir, traducir, romanizar o transcribir mal lo que se dice, sobre todo en los cambios de idioma; los tiempos de los segmentos pueden ser inexactos. Comprueba la fuente, en especial donde cambia el idioma.",
    AUTOMATIC_CAPTIONS:
      "Los subtítulos de la fuente se generaron automáticamente y pueden contener errores de transcripción.",
    AUTO_CAPTIONS_REPLACED:
      "El video solo ofrecía subtítulos generados automáticamente; según lo aprobado, se transcribió su audio localmente en su lugar.",
    COVERAGE_UNVERIFIED:
      "La obtención de la transcripción no verifica cada palabra dicha ni el contenido visual, y no se afirma qué parte de la duración total queda cubierta.",
    DURATION_UNVERIFIED:
      "Los subtítulos terminan después de la duración anunciada del video; la duración se dejó como desconocida en lugar de recortar los subtítulos o alargar la duración.",
    FRAMES_SAMPLED:
      "Los fotogramas se tomaron a intervalos fijos y en los cambios de escena; las escenas entre muestras no están representadas.",
    PLATFORM_MEDIA_DOWNLOADED:
      "Con la aprobación del usuario, el contenido multimedia de la fuente se descargó en la carpeta de trabajo privada para transcribirlo localmente o extraer fotogramas (los términos de la plataforma restringen las descargas). No se copia en el resultado compartido.",
    PLATFORM_VIDEO_DOWNLOADED:
      "Con la aprobación del usuario, se descargó en la carpeta de trabajo privada un video de baja resolución (480p como máximo) para extraer fotogramas (los términos de la plataforma restringen las descargas). No se copia en el resultado compartido.",
    PODCAST_PUBLISHER_TRANSCRIPT:
      "La transcripción fue publicada por el pódcast en su feed y no se cotejó con el audio. Sus tiempos corresponden a la versión del editor; los anuncios que se insertan al descargar el episodio pueden desplazar lo que se escucha.",
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
    // Frames that were sampled but never cited (a recording of people talking) are not
    // "visuals were not analyzed": say what the evidence shows, without claiming a review.
    analysis.inspectedFrameIds.length
      ? ui.visual
      : evidence.frames.length
        ? ui.sampledOnly
        : ui.noVisual,
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
