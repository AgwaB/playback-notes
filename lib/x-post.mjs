// X (Twitter) posts: resolve a public post to the video file X serves for it, through the
// public embed data that embedded posts load (cdn.syndication.twimg.com): no account,
// cookies, API key or browser. Everything fetched is untrusted source data and goes
// through the guarded network; only video.twimg.com MP4 files are accepted.
import { networkError } from "./network.mjs";

const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  // Link-preview mirrors people share instead of x.com; only the post ID is used.
  "fxtwitter.com",
  "www.fxtwitter.com",
  "vxtwitter.com",
  "www.vxtwitter.com",
  "fixupx.com",
  "www.fixupx.com",
  "fixvx.com",
  "www.fixvx.com",
]);
// /<handle>/status/<id>, /i/status/<id> or /i/web/status/<id>, optionally /video/<n>, and
// optionally a sub-page of the post such as /likes, /quotes or /analytics.
const POST_PATH =
  /^\/(?:([A-Za-z0-9_]{1,15})|i(?:\/web)?)\/status(?:es)?\/(\d{1,20})(?:\/(?:video|photo)\/(\d{1,2}))?(?:\/[A-Za-z_]{1,32}){0,2}\/?$/;
const EMBED_LIMIT = 4 * 1024 * 1024;
const MEDIA_HOST = "video.twimg.com";
// Frames and speech both come from one download: the sharpest file whose short side is at
// most 480 px (as for YouTube frames), with its audio track.
const MAX_SHORT_SIDE = 480;

/** Classify a parsed URL as an X post link; `videoIndex` is the 1-based media number. */
export function xPostLink(url) {
  // http is accepted too: the link itself is never fetched, only its post ID.
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    !X_HOSTS.has(url.hostname.toLowerCase())
  )
    return null;
  const match = POST_PATH.exec(url.pathname);
  if (!match) return null;
  const handle = match[1] && match[1].toLowerCase() !== "i" ? match[1] : null;
  return {
    id: match[2],
    handle,
    videoIndex: match[3] ? Number(match[3]) : null,
  };
}

/** The token X's own embed script sends with a post ID (derived from the ID alone). */
export function embedToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

const text = (value, max = 1000) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

function mediaFile(variant) {
  if (variant?.content_type !== "video/mp4" || typeof variant.url !== "string")
    return null;
  let url;
  try {
    url = new URL(variant.url);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== MEDIA_HOST ||
    url.username ||
    url.password
  )
    return null;
  // X's encoding-profile tag (?tag=12) does not change the file; without it the URL is a
  // query-free public address the report's player can use.
  if (/^\?tag=\d{1,3}$/.test(url.search)) url.search = "";
  const size = /\/(\d{2,5})x(\d{2,5})\//.exec(url.pathname);
  return {
    url: url.href,
    bitrate: Number.isFinite(Number(variant.bitrate))
      ? Number(variant.bitrate)
      : 0,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
  };
}

/** The file to download: the best one with a short side ≤480 px, else the smallest. */
export function chooseVideoFile(variants) {
  const files = (Array.isArray(variants) ? variants : [])
    .map(mediaFile)
    .filter(Boolean);
  if (!files.length) return null;
  const short = (f) =>
    f.width && f.height ? Math.min(f.width, f.height) : Infinity;
  const small = files.filter((f) => short(f) <= MAX_SHORT_SIDE);
  const pool = small.length ? small : files;
  return pool.reduce((best, f) =>
    small.length
      ? f.bitrate > best.bitrate
        ? f
        : best
      : f.bitrate < best.bitrate
        ? f
        : best,
  );
}

// The post text without its trailing t.co links, first line only, as a title.
function postTitle(raw) {
  const line = (text(raw, 20000) ?? "")
    .replace(/\s*https:\/\/t\.co\/\S+/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
}

/** Resolve a public post to its video file and metadata through X's public embed data. */
export async function resolveXPost(network, { id, videoIndex = null }) {
  let data;
  try {
    data = JSON.parse(
      await network.text(
        `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${embedToken(id)}&lang=en`,
        EMBED_LIMIT,
      ),
    );
  } catch (error) {
    if (
      [
        "NETWORK_UNAVAILABLE",
        "TIMEOUT",
        "CANCELLED",
        "RESOURCE_LIMIT",
      ].includes(error.code) ||
      error.detail === "connection-failed"
    )
      throw error;
    // A deleted, protected or restricted post answers 404 or an empty body.
    throw networkError(
      "SOURCE_UNAVAILABLE",
      "X's public embed data does not include this post.",
      "x-post-unavailable",
    );
  }
  if (
    !data ||
    data.__typename === "TweetTombstone" ||
    String(data.id_str) !== id
  )
    throw networkError(
      "SOURCE_UNAVAILABLE",
      "X's public embed data does not include this post.",
      "x-post-unavailable",
    );
  const isVideo = (m) => m?.type === "video" && m.video_info;
  const mediaOf = (tweet) =>
    Array.isArray(tweet?.mediaDetails) ? tweet.mediaDetails : [];
  // A post that only quotes a video post ("this video…") is about the quoted video.
  const quoted = data.quoted_tweet;
  const followQuote =
    !mediaOf(data).some(isVideo) &&
    /^\d{1,20}$/.test(String(quoted?.id_str ?? "")) &&
    mediaOf(quoted).some(isVideo);
  const tweet = followQuote ? quoted : data;
  const media = mediaOf(tweet);
  const videos = media.filter(isVideo);
  if (!videos.length)
    throw networkError(
      "SOURCE_UNSUPPORTED",
      "This post has no video of its own.",
      "x-post-no-video",
    );
  // /video/<n> counts the linked post's media in order; fall back to its first video.
  const requested = followQuote ? null : videoIndex;
  const picked =
    requested && isVideo(media[requested - 1])
      ? media[requested - 1]
      : videos[0];
  const file = chooseVideoFile(picked.video_info.variants);
  if (!file)
    throw networkError(
      "SOURCE_UNSUPPORTED",
      "X lists no downloadable MP4 file for this video.",
      "x-post-no-video",
    );
  const handle = /^[A-Za-z0-9_]{1,15}$/.test(tweet.user?.screen_name ?? "")
    ? tweet.user.screen_name
    : null;
  const millis = Number(picked.video_info.duration_millis);
  const postId = followQuote ? String(quoted.id_str) : id;
  return {
    id: postId,
    // The linked post, when it only quoted the post whose video this is.
    quotedFrom: followQuote ? id : null,
    handle,
    author: text(tweet.user?.name, 200),
    title: postTitle(tweet.note_tweet?.text ?? tweet.text),
    createdAt: text(tweet.created_at, 64),
    durationMs: Number.isSafeInteger(millis) && millis > 0 ? millis : null,
    mediaUrl: file.url,
    width: file.width,
    height: file.height,
    videoCount: videos.length,
    // 1-based position among the post's media, as /video/<n> counts it.
    videoNumber: media.indexOf(picked) + 1,
    // The /video/<n> asked for, when it named no video of the post.
    unmatchedNumber:
      requested && media.indexOf(picked) + 1 !== requested ? requested : null,
    // Built from the handle and numeric ID only, so it carries no tracking parameters.
    pageUrl: handle
      ? `https://x.com/${handle}/status/${postId}`
      : `https://x.com/i/status/${postId}`,
  };
}
