import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseTranscript,
  feedTranscripts,
  htmlTranscriptSegments,
  htmlTranscriptText,
  parsePodcastJson,
  podcastLink,
  resolveAppleEpisode,
} from "../lib/podcast.mjs";
import { publicUrl } from "../lib/validation.mjs";
import { FAILURE_DETAILS } from "../lib/ingest.mjs";

import { publishedPodcastTranscript } from "../lib/ingest-worker.mjs";

// Offline stand-in for the guarded network: canned bodies by URL, recording requests.
function fakeNetwork(bodies) {
  const requested = [];
  return {
    requested,
    async text(url, limit) {
      requested.push({ url, limit });
      if (!(url in bodies)) throw Object.assign(new Error("no route"), { code: "SOURCE_ACCESS_DENIED" });
      return bodies[url];
    },
  };
}
const LOOKUP =
  "https://itunes.apple.com/lookup?id=1584274529&entity=podcastEpisode&limit=200";
const lookupBody = JSON.stringify({
  resultCount: 3,
  results: [
    {
      wrapperType: "track",
      kind: "podcast",
      collectionName: "Example Show",
      feedUrl: "https://feeds.example.org/show.xml",
    },
    {
      wrapperType: "podcastEpisode",
      trackId: 1000000000002,
      trackName: "Other episode",
      episodeUrl: "https://media.example.org/other.mp3",
    },
    {
      wrapperType: "podcastEpisode",
      trackId: 1000000000001,
      trackName: "Episode 7: <b>Markup</b> stays text",
      collectionName: "Example Show",
      episodeUrl: "https://track.example.net/r/media.example.org/ep7.mp3?id=abc",
      episodeGuid: "ep-7-guid",
      releaseDate: "2026-10-01T07:00:00Z",
      trackTimeMillis: 1800000,
    },
  ],
});

test("podcast links: Apple episodes resolve, shows and Spotify are named, others pass through", () => {
  const parse = (value) => podcastLink(new URL(value));
  assert.deepEqual(
    parse("https://podcasts.apple.com/us/podcast/some-title/id1584274529?i=1000000000001"),
    { kind: "apple", showId: "1584274529", episodeId: "1000000000001" },
  );
  assert.deepEqual(parse("https://podcasts.apple.com/podcast/id1584274529?i=1000000000001&uo=4"), {
    kind: "apple",
    showId: "1584274529",
    episodeId: "1000000000001",
  });
  assert.deepEqual(parse("https://podcasts.apple.com/us/podcast/some-title/id1584274529"), {
    kind: "apple-show",
    showId: "1584274529",
  });
  assert.deepEqual(parse("https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk"), { kind: "spotify" });
  assert.deepEqual(parse("https://open.spotify.com/intl-de/episode/4rOoJ6Egrf8K2IrywzwOMk"), { kind: "spotify" });
  assert.equal(parse("https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk"), null);
  assert.equal(parse("https://example.org/episode.mp3"), null);
  for (const detail of ["podcast-spotify", "podcast-show-link", "podcast-episode-not-found", "podcast-lookup-failed"])
    assert.ok(FAILURE_DETAILS[detail], detail);
});

test("an Apple episode resolves through the public lookup to its audio, feed and a tracking-free page", async () => {
  const network = fakeNetwork({ [LOOKUP]: lookupBody });
  const episode = await resolveAppleEpisode(network, {
    showId: "1584274529",
    episodeId: "1000000000001",
  });
  assert.deepEqual(network.requested.map((r) => r.url), [LOOKUP]);
  assert.equal(episode.title, "Episode 7: <b>Markup</b> stays text");
  assert.equal(episode.show, "Example Show");
  assert.equal(episode.enclosureUrl, "https://track.example.net/r/media.example.org/ep7.mp3?id=abc");
  assert.equal(episode.feedUrl, "https://feeds.example.org/show.xml");
  assert.equal(episode.guid, "ep-7-guid");
  assert.equal(episode.durationMs, 1800000);
  assert.equal(episode.pageUrl, "https://podcasts.apple.com/podcast/id1584274529?i=1000000000001");
  // The constructed page is publishable; tracking or other parameters are not.
  assert.equal(publicUrl(episode.pageUrl), episode.pageUrl);
  assert.throws(() => publicUrl("https://podcasts.apple.com/podcast/id1?i=2&uo=4"), { code: "UNSAFE_URL" });
  await assert.rejects(
    resolveAppleEpisode(network, { showId: "1584274529", episodeId: "999" }),
    { code: "SOURCE_UNAVAILABLE", detail: "podcast-episode-not-found" },
  );
  await assert.rejects(
    resolveAppleEpisode(fakeNetwork({ [LOOKUP]: "<html>not json</html>" }), {
      showId: "1584274529",
      episodeId: "1000000000001",
    }),
    { code: "SOURCE_UNAVAILABLE", detail: "podcast-lookup-failed" },
  );
});

const FEED = "https://feeds.example.org/show.xml";
const feed = (items, extra = "") => `<?xml version="1.0" encoding="UTF-8"?>${extra}
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:old="https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md">
<channel><title>Example Show</title><language>en-us</language>${items}</channel></rss>`;

test("feed transcripts come from the matching item, in either namespace, and never from a DOCTYPE feed", async () => {
  const items = `
<item><guid>other</guid><enclosure url="https://media.example.org/other.mp3"/>
  <podcast:transcript url="https://t.example.org/other.vtt" type="text/vtt"/></item>
<item><guid isPermaLink="false"> ep-7-guid </guid><enclosure url="https://track.example.net/r/media.example.org/ep7.mp3?id=abc"/>
  <podcast:transcript url="https://t.example.org/ep7.html" type="text/html"/>
  <old:transcript url="https://t.example.org/ep7.srt" type="application/srt" rel="captions"/>
  <podcast:transcript url="https://t.example.org/ep7.json" type="application/json" language="es"/>
  <podcast:transcript url="javascript:alert(1)" type="text/vtt"/>
  <podcast:transcript url="https://t.example.org/ep7.pdf" type="application/pdf"/></item>`;
  const listed = await feedTranscripts(fakeNetwork({ [FEED]: feed(items) }), FEED, {
    guid: "ep-7-guid",
    enclosureUrl: null,
  });
  assert.equal(listed.language, "en-us");
  assert.deepEqual(
    listed.transcripts.map((t) => [t.url, t.type]),
    [
      ["https://t.example.org/ep7.html", "text/html"],
      ["https://t.example.org/ep7.srt", "application/srt"],
      ["https://t.example.org/ep7.json", "application/json"],
    ],
  );
  const byAudio = await feedTranscripts(fakeNetwork({ [FEED]: feed(items) }), FEED, {
    guid: null,
    enclosureUrl: "https://media.example.org/other.mp3",
  });
  assert.deepEqual(byAudio.transcripts.map((t) => t.url), ["https://t.example.org/other.vtt"]);
  const doctype = await feedTranscripts(
    fakeNetwork({ [FEED]: feed(items, '<!DOCTYPE rss [<!ENTITY x "y">]>') }),
    FEED,
    { guid: "ep-7-guid" },
  );
  assert.deepEqual(doctype.transcripts, []);
});

test("timed transcripts win over untimed ones, then the requested caption language", () => {
  const list = [
    { url: "h", type: "text/html", language: null },
    { url: "j", type: "application/json", language: "es" },
    { url: "s", type: "application/srt", language: null },
    { url: "v-de", type: "text/vtt", language: "de" },
    { url: "v-en", type: "text/vtt", language: "en-US" },
  ];
  assert.equal(chooseTranscript(list).url, "v-de");
  assert.equal(chooseTranscript(list, ["en"]).url, "v-en");
  assert.equal(chooseTranscript(list.slice(0, 2)).format, "json");
  assert.equal(chooseTranscript([]), null);
});

test("word-level JSON transcripts become sentence segments per speaker; bad times are refused", () => {
  const words = (speaker, start, text) =>
    text.split(" ").map((body, i) => ({ speaker, startTime: start + i * 0.4, endTime: start + i * 0.4 + 0.35, body }));
  const segments = parsePodcastJson(
    JSON.stringify({
      version: "1.0.0",
      segments: [
        ...words("Alice", 0, "Welcome to the show."),
        ...words("Alice", 1.6, "Today we test."),
        ...words("Bob", 3, "Thanks, Alice"),
        { speaker: "Bob", startTime: 4.2, endTime: 4.5, body: "   " },
      ],
    }),
  );
  assert.deepEqual(
    segments.map((s) => [s.speaker, s.text, s.startMs]),
    [
      ["Alice", "Welcome to the show.", 0],
      ["Alice", "Today we test.", 1600],
      ["Bob", "Thanks, Alice", 3000],
    ],
  );
  assert.ok(segments.every((s) => s.endMs > s.startMs));
  assert.throws(
    () => parsePodcastJson(JSON.stringify({ segments: [{ startTime: 2, endTime: 1, body: "x" }] })),
    { code: "INVALID_CONTRACT", detail: "transcript-invalid-timing" },
  );
  assert.throws(() => parsePodcastJson("{"), { code: "INVALID_CONTRACT" });
});

test("HTML transcripts become untimed paragraphs without scripts or markup", () => {
  const text = htmlTranscriptText(
    "<html><body><h2>Transcript</h2><p>Alice: Hello <b>there</b>.</p><script>steal()</script><ul><li>Bob: Hi.</li></ul></body></html>",
  );
  assert.equal(text, "Transcript\n\nAlice: Hello there.\n\nBob: Hi.");
});

test("Podcasting 2.0 HTML transcripts: <cite> names the speaker of the following paragraphs, untimed", () => {
  const segments = htmlTranscriptSegments(
    "<cite>Kevin:</cite> <time>0:00</time> <p> We have an update planned </p> <cite>Alban :</cite> <time>0:09</time> <p>You're triggering Tom.</p><p>Second <b>paragraph</b>.</p><script>steal()</script>",
  );
  assert.deepEqual(segments, [
    { startMs: null, endMs: null, text: "We have an update planned", speaker: "Kevin" },
    { startMs: null, endMs: null, text: "You're triggering Tom.", speaker: "Alban" },
    { startMs: null, endMs: null, text: "Second paragraph.", speaker: "Alban" },
  ]);
  // A cite that opens a paragraph names that paragraph's speaker; a cite inside the text
  // is an ordinary citation of a work.
  assert.deepEqual(
    htmlTranscriptSegments(
      "<p><cite>Alice:</cite> Hello.</p><p><cite>Bob:</cite> Hi.</p><p>Still Bob.</p><p><cite>Ann:</cite></p><p>As <cite>The Book</cite> says.</p>",
    ).map((s) => [s.speaker, s.text]),
    [
      ["Alice", "Hello."],
      ["Bob", "Hi."],
      ["Bob", "Still Bob."],
      ["Ann", "As The Book says."],
    ],
  );
  assert.deepEqual(
    htmlTranscriptSegments("<body>Plain text only.\n\nSecond block.</body>").map((s) => [s.speaker, s.text]),
    [
      [null, "Plain text only."],
      [null, "Second block."],
    ],
  );
});

test("an unreadable feed or transcript leaves the episode audio to local ASR, with a warning", async () => {
  const episode = {
    feedUrl: "https://feeds.example.org/show.xml",
    guid: "ep-7-guid",
    enclosureUrl: "https://media.example.org/ep7.mp3",
  };
  const policy = { transcriptLanguages: [], maxDownloadBytes: 1000000 };
  // A feed that answers 404 (the show moved hosts) is not a reason to fail the episode.
  const missing = await publishedPodcastTranscript(fakeNetwork({}), episode, policy);
  assert.equal(missing.segments, null);
  assert.deepEqual(missing.warnings.map((w) => w.code), ["PODCAST_FEED_UNAVAILABLE"]);
  const feed = `<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><item><guid>ep-7-guid</guid>
<podcast:transcript url="https://feeds.example.org/ep7.vtt" type="text/vtt"/></item></channel></rss>`;
  const broken = await publishedPodcastTranscript(
    fakeNetwork({ [episode.feedUrl]: feed, "https://feeds.example.org/ep7.vtt": "WEBVTT\n\nnot a cue" }),
    episode,
    policy,
  );
  assert.equal(broken.segments, null);
  assert.deepEqual(broken.warnings.map((w) => w.code), ["PODCAST_TRANSCRIPT_UNUSABLE"]);
  // An HTML transcript with no text is just as unusable: it must not stop the audio fallback.
  const htmlFeed = feed.replace('https://feeds.example.org/ep7.vtt" type="text/vtt"', 'https://feeds.example.org/ep7.html" type="text/html"');
  const blank = await publishedPodcastTranscript(
    fakeNetwork({ [episode.feedUrl]: htmlFeed, "https://feeds.example.org/ep7.html": "<p> </p>" }),
    episode,
    policy,
  );
  assert.equal(blank.segments, null);
  assert.equal(blank.chosen, null);
  assert.deepEqual(blank.warnings.map((w) => w.code), ["PODCAST_TRANSCRIPT_UNUSABLE"]);
  const good = await publishedPodcastTranscript(
    fakeNetwork({
      [episode.feedUrl]: feed,
      "https://feeds.example.org/ep7.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nHello.\n",
    }),
    episode,
    policy,
  );
  assert.equal(good.segments[0].text, "Hello.");
  assert.deepEqual(good.warnings, []);
  // Being offline or over budget still stops the job: the audio would fail the same way.
  const offline = {
    async text() {
      throw Object.assign(new Error("offline"), { code: "NETWORK_UNAVAILABLE" });
    },
  };
  await assert.rejects(publishedPodcastTranscript(offline, episode, policy), {
    code: "NETWORK_UNAVAILABLE",
  });
});
