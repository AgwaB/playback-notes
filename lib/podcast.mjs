// Podcast episode links: resolve an Apple Podcasts episode to its audio file and, when the
// show publishes one in its feed, a transcript (Podcasting 2.0 <podcast:transcript>).
// Everything fetched here is untrusted source data and goes through the guarded network.
import { JSDOM } from "jsdom";
import { networkError } from "./network.mjs";

const APPLE_HOSTS = new Set(["podcasts.apple.com", "itunes.apple.com"]);
const LOOKUP_LIMIT = 8 * 1024 * 1024;
const FEED_LIMIT = 16 * 1024 * 1024;
const MAX_ITEMS = 5000;
const TRANSCRIPT_NAMESPACES = new Set([
  "https://podcastindex.org/namespace/1.0",
  "https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md",
]);
// Timed formats first; HTML and plain text have no times.
const TRANSCRIPT_TYPES = new Map([
  ["text/vtt", { format: "vtt", rank: 0 }],
  ["application/x-subrip", { format: "srt", rank: 1 }],
  ["application/srt", { format: "srt", rank: 1 }],
  ["text/srt", { format: "srt", rank: 1 }],
  ["application/json", { format: "json", rank: 2 }],
  ["text/plain", { format: "txt", rank: 3 }],
  ["text/html", { format: "html", rank: 4 }],
]);

/** Classify a parsed URL as a podcast link: an Apple episode, an Apple show, or Spotify. */
export function podcastLink(url) {
  const host = url.hostname.toLowerCase();
  if (APPLE_HOSTS.has(host)) {
    const showId = /\/id(\d{1,15})(?:\/|$)/.exec(url.pathname)?.[1];
    if (!showId) return null;
    const episodeId = url.searchParams.get("i");
    return episodeId && /^\d{1,20}$/.test(episodeId)
      ? { kind: "apple", showId, episodeId }
      : { kind: "apple-show", showId };
  }
  if (
    host === "open.spotify.com" &&
    /^\/(?:intl-[a-z-]+\/)?episode\//.test(url.pathname)
  )
    return { kind: "spotify" };
  return null;
}

const text = (value, max = 1000) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

/** Apple's public lookup lists a show's 200 most recent episodes with their audio URLs. */
export async function resolveAppleEpisode(network, { showId, episodeId }) {
  let data;
  try {
    data = JSON.parse(
      await network.text(
        `https://itunes.apple.com/lookup?id=${showId}&entity=podcastEpisode&limit=200`,
        LOOKUP_LIMIT,
      ),
    );
  } catch (error) {
    if (["NETWORK_UNAVAILABLE", "TIMEOUT", "CANCELLED", "RESOURCE_LIMIT"].includes(error.code))
      throw error;
    throw networkError(
      "SOURCE_UNAVAILABLE",
      "Apple's podcast lookup did not return episode data.",
      "podcast-lookup-failed",
    );
  }
  const results = Array.isArray(data?.results) ? data.results : [];
  const show = results.find(
    (r) => r?.wrapperType === "track" && r?.kind === "podcast",
  );
  const episode = results.find(
    (r) => r?.wrapperType === "podcastEpisode" && String(r?.trackId) === episodeId,
  );
  if (!episode)
    throw networkError(
      "SOURCE_UNAVAILABLE",
      "The episode is not among the episodes Apple's lookup lists for this show.",
      "podcast-episode-not-found",
    );
  const enclosureUrl = text(episode.episodeUrl, 4096);
  if (!enclosureUrl || !/^https?:\/\//i.test(enclosureUrl))
    throw networkError(
      "SOURCE_UNAVAILABLE",
      "Apple lists no audio file for this episode.",
      "podcast-episode-not-found",
    );
  const millis = Number(episode.trackTimeMillis);
  const feedUrl = text(show?.feedUrl ?? episode.feedUrl, 4096);
  return {
    showId,
    episodeId,
    title: text(episode.trackName) ?? `Episode ${episodeId}`,
    show: text(episode.collectionName) ?? text(show?.collectionName),
    releaseDate: text(episode.releaseDate, 64),
    durationMs:
      Number.isSafeInteger(millis) && millis > 0 ? millis : null,
    guid: text(episode.episodeGuid, 1000),
    enclosureUrl,
    feedUrl: feedUrl && /^https?:\/\//i.test(feedUrl) ? feedUrl : null,
    // Built from the two numeric IDs only, so it carries no tracking parameters.
    pageUrl: `https://podcasts.apple.com/podcast/id${showId}?i=${episodeId}`,
  };
}

/** The feed item for the episode (matched by GUID, else by audio URL) and its transcripts. */
export async function feedTranscripts(network, feedUrl, { guid, enclosureUrl }) {
  const xml = await network.text(feedUrl, FEED_LIMIT);
  // No document types: they are not needed for RSS and can declare entities.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return { language: null, transcripts: [] };
  let document;
  try {
    document = new JSDOM(xml, { contentType: "application/xml" }).window.document;
  } catch {
    return { language: null, transcripts: [] };
  }
  if (document.getElementsByTagName("parsererror").length)
    return { language: null, transcripts: [] };
  const channel = document.getElementsByTagName("channel")[0];
  const language = text(
    [...(channel?.children ?? [])].find((el) => el.localName === "language")
      ?.textContent,
    35,
  );
  const items = [...document.getElementsByTagName("item")].slice(0, MAX_ITEMS);
  const child = (item, name) =>
    [...item.children].find((el) => el.localName === name && !el.prefix);
  const item =
    (guid && items.find((it) => child(it, "guid")?.textContent.trim() === guid)) ||
    items.find((it) => child(it, "enclosure")?.getAttribute("url") === enclosureUrl);
  if (!item) return { language, transcripts: [] };
  const transcripts = [...item.children]
    .filter(
      (el) =>
        el.localName === "transcript" &&
        (TRANSCRIPT_NAMESPACES.has(el.namespaceURI) || el.prefix === "podcast"),
    )
    .map((el) => ({
      url: el.getAttribute("url"),
      type: (el.getAttribute("type") ?? "").toLowerCase().split(";")[0].trim(),
      language: text(el.getAttribute("language"), 35),
      rel: text(el.getAttribute("rel"), 40),
    }))
    .filter((t) => t.url && /^https?:\/\//i.test(t.url) && TRANSCRIPT_TYPES.has(t.type));
  return { language, transcripts };
}

/** Prefer timed formats, then the user's caption languages, then feed order. */
export function chooseTranscript(transcripts, languages = []) {
  const wanted = languages.map((l) => l.toLowerCase());
  const languageRank = (t) => {
    if (!wanted.length || !t.language) return 0;
    const index = wanted.findIndex(
      (l) => t.language.toLowerCase() === l || t.language.toLowerCase().startsWith(`${l}-`),
    );
    return index === -1 ? wanted.length : index;
  };
  return (
    transcripts
      .map((t, order) => ({ ...t, ...TRANSCRIPT_TYPES.get(t.type), order }))
      .sort(
        (a, b) =>
          a.rank - b.rank || languageRank(a) - languageRank(b) || a.order - b.order,
      )[0] ?? null
  );
}

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/u;
/**
 * Podcasting 2.0 JSON transcripts (`segments` with `startTime`, `endTime`, `body`,
 * optional `speaker`). Word-level entries are joined into sentences per speaker, at most
 * about 20 s long, so citations point at readable passages.
 */
export function parsePodcastJson(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw networkError("INVALID_CONTRACT", "The podcast's JSON transcript could not be parsed.", "subtitle-parse-failed");
  }
  const entries = Array.isArray(data?.segments) ? data.segments : null;
  if (!entries?.length)
    throw networkError("NO_USABLE_EVIDENCE", "The podcast's JSON transcript has no segments.");
  const segments = [];
  let current = null;
  for (const entry of entries.slice(0, 500000)) {
    const start = Number(entry?.startTime),
      end = Number(entry?.endTime);
    const body = typeof entry?.body === "string" ? entry.body.trim() : "";
    if (!body) continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start)
      throw networkError("INVALID_CONTRACT", "A podcast transcript entry has an invalid time interval.", "transcript-invalid-timing");
    const speaker = text(entry?.speaker, 100);
    const startMs = Math.round(start * 1000),
      endMs = Math.max(Math.round(end * 1000), startMs + 1);
    if (
      current &&
      current.speaker === speaker &&
      startMs >= current.endMs - 1000 &&
      endMs - current.startMs <= 20000 &&
      !SENTENCE_END.test(current.text)
    ) {
      current.text += ` ${body}`;
      current.endMs = Math.max(current.endMs, endMs);
    } else {
      current = { startMs, endMs, text: body, speaker };
      segments.push(current);
    }
  }
  return segments;
}

/**
 * Podcasting 2.0 HTML transcripts: `<cite>` names the speaker of the paragraphs that
 * follow it. `<time>` holds only a start, and an end is never inferred from the next
 * paragraph, so the segments stay untimed.
 */
export function htmlTranscriptSegments(raw) {
  const { document } = new JSDOM(raw).window;
  for (const node of document.querySelectorAll("script,style,noscript,template"))
    node.remove();
  const blocks = "p,li,h1,h2,h3,h4,h5,h6,blockquote";
  const leaf = (el) => !el.querySelector("p,li");
  const name = (cite) =>
    text(cite.textContent.replace(/\s+/g, " ").replace(/\s*:\s*$/, ""), 100);
  const segments = [];
  let speaker = null;
  for (const el of document.querySelectorAll(`cite,${blocks}`)) {
    if (el.localName === "cite") {
      // A cite inside a paragraph is read with that paragraph, below.
      const block = el.parentElement?.closest(blocks);
      if (!block || !leaf(block)) speaker = name(el);
      continue;
    }
    if (!leaf(el) || el.closest("cite")) continue;
    // A paragraph that opens with a cite ("<p><cite>Alice:</cite> Hello.</p>") is that
    // speaker's; a cite later in the text is an ordinary citation and stays text.
    const copy = el.cloneNode(true);
    const first = copy.querySelector("cite");
    if (first) {
      const before = document.createRange();
      before.setStart(copy, 0);
      before.setEndBefore(first);
      if (!before.toString().trim()) {
        speaker = name(first);
        first.remove();
      }
    }
    const body = copy.textContent.replace(/\s+/g, " ").trim();
    if (body) segments.push({ startMs: null, endMs: null, text: body, speaker });
  }
  if (segments.length) return segments;
  return htmlTranscriptText(raw)
    .split("\n\n")
    .filter(Boolean)
    .map((body) => ({ startMs: null, endMs: null, text: body, speaker: null }));
}

/** HTML transcripts have no times: one untimed segment per paragraph. */
export function htmlTranscriptText(raw) {
  const { document } = new JSDOM(raw).window;
  for (const node of document.querySelectorAll("script,style,noscript,template"))
    node.remove();
  const blocks = [...document.querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,blockquote")]
    .filter((el) => !el.querySelector("p,li"))
    .map((el) => el.textContent.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const paragraphs = blocks.length
    ? blocks
    : (document.body?.textContent ?? "")
        .split(/\n\s*\n/)
        .map((block) => block.replace(/\s+/g, " ").trim())
        .filter(Boolean);
  return paragraphs.join("\n\n");
}
