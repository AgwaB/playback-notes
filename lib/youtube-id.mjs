import { extractYouTubeVideoId } from "@steipete/summarize-core/content/url";

// YouTube front ends that address a video by its YouTube ID in the path. Only the exact
// watch path is accepted; any other page on these hosts stays an unsupported web page.
const FRONT_ENDS = new Map([
  ["hackertube.org", /^\/watch\/([A-Za-z0-9_-]{11})\/?$/],
  ["www.hackertube.org", /^\/watch\/([A-Za-z0-9_-]{11})\/?$/],
]);

/** The YouTube video ID a URL names, or null. Acquisition always uses youtube.com. */
export function youtubeVideoId(href) {
  const id = extractYouTubeVideoId(href);
  if (id) return id;
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  // http too, as for youtube.com links: the page itself is never fetched, only the ID used.
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  )
    return null;
  const match = FRONT_ENDS.get(url.hostname)?.exec(url.pathname);
  return match ? match[1] : null;
}
