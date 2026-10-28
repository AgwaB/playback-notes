// Caption-track selection with youtube-transcript-api semantics: the caller's language
// priority list wins first; then the video's ORIGINAL language (the default audio track,
// when the player names one) beats translations — a video's manual tracks are listed in
// arbitrary order and the first one may be a translation; within a language a manually
// created track beats an auto-generated (asr) one; otherwise the platform's own order is
// kept. No translation is ever requested.

const LANGUAGE = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i;

function normalizeLanguage(value) {
  return typeof value === "string" && LANGUAGE.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}
function languageRank(code, preferred) {
  if (!code) return preferred.length;
  const exact = preferred.indexOf(code);
  if (exact >= 0) return exact;
  const base = code.split("-")[0];
  // A regional variant of a preferred language ranks with that language, so a manual
  // en-US track still beats an auto-generated en track when `en` is requested.
  const loose = preferred.findIndex(
    (p) => p === base || p.split("-")[0] === base,
  );
  return loose >= 0 ? loose : preferred.length;
}
/**
 * @param {{languageCode: string|null, automatic: boolean, label?: string}[]} tracks
 * @param {string[]} preferredLanguages descending priority, already normalized
 */
export function rankCaptionTracks(
  tracks,
  preferredLanguages = [],
  originalLanguage = null,
) {
  const preferred = preferredLanguages.map(normalizeLanguage).filter(Boolean);
  const original = normalizeLanguage(originalLanguage);
  const originalRank = (code) =>
    original &&
    code &&
    (code === original || code.split("-")[0] === original.split("-")[0])
      ? 0
      : 1;
  return tracks
    .map((track, index) => ({ track, index }))
    .sort(
      (a, b) =>
        languageRank(normalizeLanguage(a.track.languageCode), preferred) -
          languageRank(normalizeLanguage(b.track.languageCode), preferred) ||
        originalRank(normalizeLanguage(a.track.languageCode)) -
          originalRank(normalizeLanguage(b.track.languageCode)) ||
        Number(a.track.automatic) - Number(b.track.automatic) ||
        a.index - b.index,
    )
    .map(({ track }) => track);
}
// Words the player uses (in the viewer's UI language) to mark the original audio track.
const ORIGINAL_MARK =
  /\b(original|originale|originál|oryginał|orijinal)\b|원본|オリジナル|原始|原声|原版|原音|d['’]origine|оригинал/i;
const trackLanguage = (id) =>
  typeof id === "string" ? normalizeLanguage(id.split(".")[0]) : null;
/**
 * The video's original (spoken) language, following yt-dlp: an adaptive audio stream whose
 * `audioTrack.displayName` marks it as original wins; otherwise the stream flagged
 * `audioIsDefault`; otherwise the caption renderer's default audio track. Auto-dubbed
 * streams (`isAutoDubbed`) never count: YouTube makes a dub the default for viewers in the
 * dub's locale. With no audio-track ids at all, a single auto-generated (asr) caption
 * language is the spoken language — speech recognition runs on the original audio, which
 * is how yt-dlp names its `-orig` captions. Null when none of these is known.
 */
export function originalCaptionLanguage(player) {
  const formats = Array.isArray(player?.streamingData?.adaptiveFormats)
    ? player.streamingData.adaptiveFormats
    : [];
  const all = formats
    .map((f) => f?.audioTrack)
    .filter((t) => t && typeof t === "object");
  const dubbed = new Set(
    all.filter((t) => t.isAutoDubbed === true).map((t) => t.id),
  );
  const tracks = all.filter((t) => t.isAutoDubbed !== true);
  const original = tracks.find(
    (t) =>
      typeof t.displayName === "string" && ORIGINAL_MARK.test(t.displayName),
  );
  if (original && trackLanguage(original.id)) return trackLanguage(original.id);
  const flagged = tracks.find((t) => t.audioIsDefault === true);
  if (flagged && trackLanguage(flagged.id)) return trackLanguage(flagged.id);
  const renderer = player?.captions?.playerCaptionsTracklistRenderer;
  const audio = Array.isArray(renderer?.audioTracks)
    ? renderer.audioTracks
    : [];
  const index = Number.isInteger(renderer?.defaultAudioTrackIndex)
    ? renderer.defaultAudioTrackIndex
    : 0;
  const preferred = audio[index];
  // A dubbed default gives way to the first undubbed renderer track.
  const fromRenderer =
    preferred && dubbed.has(preferred.audioTrackId)
      ? audio.find((t) => t?.audioTrackId && !dubbed.has(t.audioTrackId))
      : preferred;
  if (audio.some((t) => t?.audioTrackId))
    return trackLanguage(fromRenderer?.audioTrackId);
  const asr = new Set(
    (Array.isArray(renderer?.captionTracks) ? renderer.captionTracks : [])
      .filter((t) => t?.kind === "asr")
      .map((t) => normalizeLanguage(t.languageCode))
      .filter(Boolean),
  );
  return asr.size === 1 ? [...asr][0] : null;
}
