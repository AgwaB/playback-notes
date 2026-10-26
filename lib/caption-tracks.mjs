// Caption-track selection with youtube-transcript-api semantics: the caller's language
// priority list wins first; within a language a manually created track beats an
// auto-generated (asr) one; otherwise the platform's own order is kept. No translation.

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
export function rankCaptionTracks(tracks, preferredLanguages = []) {
  const preferred = preferredLanguages.map(normalizeLanguage).filter(Boolean);
  return tracks
    .map((track, index) => ({ track, index }))
    .sort(
      (a, b) =>
        languageRank(normalizeLanguage(a.track.languageCode), preferred) -
          languageRank(normalizeLanguage(b.track.languageCode), preferred) ||
        Number(a.track.automatic) - Number(b.track.automatic) ||
        a.index - b.index,
    )
    .map(({ track }) => track);
}
