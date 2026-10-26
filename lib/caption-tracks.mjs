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
/**
 * The video's original language as the player reports it: the default audio track's id
 * (`en-US.4` → `en-US`); dubbed tracks carry other languages. Null when not reported.
 */
export function originalCaptionLanguage(renderer) {
  const audio = renderer?.audioTracks;
  if (!Array.isArray(audio) || !audio.length) return null;
  const index = Number.isInteger(renderer.defaultAudioTrackIndex)
    ? renderer.defaultAudioTrackIndex
    : 0;
  const id = audio[index]?.audioTrackId;
  return typeof id === "string" ? normalizeLanguage(id.split(".")[0]) : null;
}
