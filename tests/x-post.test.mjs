import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseVideoFile,
  embedToken,
  resolveXPost,
  xPostLink,
} from "../lib/x-post.mjs";
import { FAILURE_DETAILS } from "../lib/ingest.mjs";
import { publicUrl } from "../lib/validation.mjs";

// Offline stand-in for the guarded network: canned bodies by URL, recording requests.
function fakeNetwork(bodies) {
  const requested = [];
  return {
    requested,
    async text(url, limit) {
      requested.push({ url, limit });
      if (!(url in bodies))
        throw Object.assign(new Error("no route"), {
          code: "SOURCE_ACCESS_DENIED",
        });
      return bodies[url];
    },
  };
}
const ID = "2116191759231246768";
const EMBED = `https://cdn.syndication.twimg.com/tweet-result?id=${ID}&token=${embedToken(ID)}&lang=en`;
const mp4 = (w, h, bitrate, host = "video.twimg.com") => ({
  content_type: "video/mp4",
  bitrate,
  url: `https://${host}/amplify_video/1/vid/avc1/${w}x${h}/f${w}.mp4`,
});
const video = (variants, duration = 5670963) => ({
  type: "video",
  video_info: { duration_millis: duration, variants },
});
const post = (media, extra = {}) =>
  JSON.stringify({
    __typename: "Tweet",
    id_str: ID,
    text: "Anthropic engineers just released a course:\n\n• 00:00 - intro https://t.co/AbC123",
    created_at: "2026-10-30T15:33:26.000Z",
    user: { screen_name: "Some_User", name: "Some User" },
    mediaDetails: media,
    ...extra,
  });
const VARIANTS = [
  {
    content_type: "application/x-mpegURL",
    url: "https://video.twimg.com/amplify_video/1/pl/a.m3u8",
  },
  mp4(480, 270, 256000),
  mp4(640, 360, 832000),
  mp4(1280, 720, 2176000),
  mp4(1920, 1080, 10368000),
];

test("X post links: x.com and twitter.com status URLs, with or without /video/<n>, others pass through", () => {
  const parse = (value) => xPostLink(new URL(value));
  assert.deepEqual(parse(`https://x.com/AnatoliKopadze/status/${ID}/video/1`), {
    id: ID,
    handle: "AnatoliKopadze",
    videoIndex: 1,
  });
  assert.deepEqual(parse(`https://twitter.com/some_user/status/${ID}?s=20`), {
    id: ID,
    handle: "some_user",
    videoIndex: null,
  });
  assert.deepEqual(parse(`https://mobile.twitter.com/a/statuses/${ID}/`), {
    id: ID,
    handle: "a",
    videoIndex: null,
  });
  assert.deepEqual(parse(`https://x.com/i/status/${ID}`), {
    id: ID,
    handle: null,
    videoIndex: null,
  });
  assert.deepEqual(parse(`https://x.com/i/web/status/${ID}`), {
    id: ID,
    handle: null,
    videoIndex: null,
  });
  // Only the post ID is used, so http, link-preview mirrors and post sub-pages work too.
  for (const same of [
    `http://x.com/AnatoliKopadze/status/${ID}`,
    `https://X.COM/AnatoliKopadze/status/${ID}`,
    `https://fxtwitter.com/AnatoliKopadze/status/${ID}`,
    `https://vxtwitter.com/AnatoliKopadze/status/${ID}`,
    `https://fixupx.com/AnatoliKopadze/status/${ID}`,
    `https://fixvx.com/AnatoliKopadze/status/${ID}`,
    `https://x.com/AnatoliKopadze/status/${ID}/likes`,
    `https://x.com/AnatoliKopadze/status/${ID}/analytics`,
    `https://x.com/AnatoliKopadze/status/${ID}/retweets/with_comments`,
  ])
    assert.deepEqual(
      parse(same),
      { id: ID, handle: "AnatoliKopadze", videoIndex: null },
      same,
    );
  assert.equal(
    parse(`https://x.com/AnatoliKopadze/status/${ID}/video/2/likes`).videoIndex,
    2,
  );
  for (const other of [
    "https://x.com/AnatoliKopadze",
    "https://x.com/i/spaces/1brkRVpyKNpWEz/peek",
    "https://x.com/i/broadcasts/2mdAmPBvoXjvmA",
    "https://t.co/Fkc0FwfXzo",
    `https://x.com/AnatoliKopadze/status/${ID}/a/b/c`,
    `ftp://x.com/AnatoliKopadze/status/${ID}`,
    `https://x.com:8443/AnatoliKopadze/status/${ID}`,
    `https://u:p@x.com/AnatoliKopadze/status/${ID}`,
    `https://x.com.example.org/AnatoliKopadze/status/${ID}`,
    `https://example.org/AnatoliKopadze/status/${ID}`,
  ])
    assert.equal(parse(other), null, other);
  for (const detail of [
    "x-post-unavailable",
    "x-post-no-video",
    "asr-not-configured",
    "download-over-budget",
    "asr-timeout",
    "extraction-timeout",
    "connection-failed",
  ])
    assert.ok(FAILURE_DETAILS[detail], detail);
});

test("the downloaded file is the sharpest with a short side of at most 480 px, from video.twimg.com only", () => {
  assert.equal(chooseVideoFile(VARIANTS).url, VARIANTS[2].url);
  // Portrait video: the short side counts.
  assert.equal(
    chooseVideoFile([
      mp4(720, 1280, 2000000),
      mp4(480, 852, 900000),
      mp4(320, 568, 300000),
    ]).width,
    480,
  );
  // Nothing small enough: the smallest file.
  assert.equal(
    chooseVideoFile([mp4(1920, 1080, 9000000), mp4(1280, 720, 2000000)]).width,
    1280,
  );
  // Other hosts, schemes and formats are never chosen.
  assert.equal(
    chooseVideoFile([mp4(640, 360, 800000, "evil.example.org"), VARIANTS[0]]),
    null,
  );
  assert.equal(chooseVideoFile(undefined), null);
  // X's encoding-profile tag is dropped so the file has a query-free public address;
  // any other query is kept (and then the file is never published as a player URL).
  const tagged = (query) => ({
    ...mp4(640, 360, 800000),
    url: `https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/640x360/a.mp4${query}`,
  });
  assert.equal(
    chooseVideoFile([tagged("?tag=12")]).url,
    "https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/640x360/a.mp4",
  );
  assert.match(chooseVideoFile([tagged("?tag=12&sig=x")]).url, /\?tag=12&sig=x$/);
});

test("a public post resolves through X's embed data to its video file, title and a tracking-free page", async () => {
  const network = fakeNetwork({ [EMBED]: post([video(VARIANTS)]) });
  const resolved = await resolveXPost(network, { id: ID });
  assert.deepEqual(
    network.requested.map((r) => r.url),
    [EMBED],
  );
  assert.equal(resolved.mediaUrl, VARIANTS[2].url);
  assert.equal(resolved.title, "Anthropic engineers just released a course:");
  assert.equal(resolved.handle, "Some_User");
  assert.equal(resolved.durationMs, 5670963);
  assert.equal(resolved.videoCount, 1);
  assert.equal(resolved.videoNumber, 1);
  assert.equal(resolved.pageUrl, `https://x.com/Some_User/status/${ID}`);
  assert.equal(publicUrl(resolved.pageUrl), resolved.pageUrl);
});

test("/video/<n> picks that media item; a photo or missing index falls back to the first video", async () => {
  const media = [
    { type: "photo" },
    video([mp4(640, 360, 800000)]),
    video([mp4(480, 270, 250000)]),
  ];
  const network = fakeNetwork({ [EMBED]: post(media) });
  assert.equal(
    (await resolveXPost(network, { id: ID, videoIndex: 3 })).width,
    480,
  );
  assert.equal(
    (await resolveXPost(network, { id: ID, videoIndex: 3 })).videoNumber,
    3,
  );
  const fallback = await resolveXPost(network, { id: ID, videoIndex: 1 });
  assert.equal(fallback.width, 640);
  assert.equal(fallback.videoNumber, 2);
  // A /video/<n> naming a photo or no item is reported, not silently swapped.
  assert.equal(fallback.unmatchedNumber, 1);
  assert.equal(
    (await resolveXPost(network, { id: ID, videoIndex: 9 })).unmatchedNumber,
    9,
  );
  assert.equal(
    (await resolveXPost(network, { id: ID, videoIndex: 2 })).unmatchedNumber,
    null,
  );
  const plain = await resolveXPost(network, { id: ID });
  assert.equal(plain.videoCount, 2);
  assert.equal(plain.unmatchedNumber, null);
  assert.equal(plain.quotedFrom, null);
});

test("a post that only quotes a video post uses the quoted post's video, page and title", async () => {
  const QUOTED = "2117393931679760702";
  const quote = (quotedMedia, ownMedia = []) =>
    post(ownMedia, {
      text: "This video man pls https://t.co/Q",
      quoted_tweet: {
        id_str: QUOTED,
        text: "Eu notei em outra coisa https://t.co/V",
        created_at: "2026-11-02T23:10:27.000Z",
        user: { screen_name: "anninhalottin", name: "Anna" },
        mediaDetails: quotedMedia,
      },
    });
  const network = fakeNetwork({ [EMBED]: quote([video(VARIANTS, 23405)]) });
  // A /video/<n> on the linking post does not apply to the quoted one.
  const resolved = await resolveXPost(network, { id: ID, videoIndex: 3 });
  assert.equal(resolved.id, QUOTED);
  assert.equal(resolved.quotedFrom, ID);
  assert.equal(resolved.handle, "anninhalottin");
  assert.equal(resolved.title, "Eu notei em outra coisa");
  assert.equal(resolved.durationMs, 23405);
  assert.equal(resolved.unmatchedNumber, null);
  assert.equal(resolved.pageUrl, `https://x.com/anninhalottin/status/${QUOTED}`);
  assert.deepEqual(network.requested.map((r) => r.url), [EMBED]);
  // The post's own video wins over a quoted one.
  const own = await resolveXPost(
    fakeNetwork({ [EMBED]: quote([video(VARIANTS)], [video([mp4(480, 270, 1)])]) }),
    { id: ID },
  );
  assert.equal(own.id, ID);
  assert.equal(own.quotedFrom, null);
  // A quoted photo, GIF or malformed quoted ID is not followed.
  for (const media of [[{ type: "photo" }], [{ type: "animated_gif", video_info: { variants: [] } }]])
    await assert.rejects(
      resolveXPost(fakeNetwork({ [EMBED]: quote(media) }), { id: ID }),
      { code: "SOURCE_UNSUPPORTED", detail: "x-post-no-video" },
    );
  const badId = JSON.parse(quote([video(VARIANTS)]));
  badId.quoted_tweet.id_str = "../1";
  await assert.rejects(
    resolveXPost(fakeNetwork({ [EMBED]: JSON.stringify(badId) }), { id: ID }),
    { code: "SOURCE_UNSUPPORTED", detail: "x-post-no-video" },
  );
});

test("unavailable posts and posts without a video are named, not guessed", async () => {
  const cases = [
    [fakeNetwork({}), "SOURCE_UNAVAILABLE", "x-post-unavailable"],
    [fakeNetwork({ [EMBED]: "" }), "SOURCE_UNAVAILABLE", "x-post-unavailable"],
    [
      fakeNetwork({
        [EMBED]: JSON.stringify({ __typename: "TweetTombstone" }),
      }),
      "SOURCE_UNAVAILABLE",
      "x-post-unavailable",
    ],
    [
      fakeNetwork({ [EMBED]: post([video(VARIANTS)], { id_str: "1" }) }),
      "SOURCE_UNAVAILABLE",
      "x-post-unavailable",
    ],
    [
      fakeNetwork({ [EMBED]: post([{ type: "photo" }]) }),
      "SOURCE_UNSUPPORTED",
      "x-post-no-video",
    ],
    [
      // An animated GIF is a silent MP4 loop, not a video with speech.
      fakeNetwork({
        [EMBED]: post([
          {
            type: "animated_gif",
            video_info: {
              variants: [
                {
                  content_type: "video/mp4",
                  bitrate: 0,
                  url: "https://video.twimg.com/tweet_video/A.mp4",
                },
              ],
            },
          },
        ]),
      }),
      "SOURCE_UNSUPPORTED",
      "x-post-no-video",
    ],
    [
      fakeNetwork({ [EMBED]: post([video([VARIANTS[0]])]) }),
      "SOURCE_UNSUPPORTED",
      "x-post-no-video",
    ],
  ];
  for (const [network, code, detail] of cases)
    await assert.rejects(resolveXPost(network, { id: ID }), { code, detail });
  // Transport failures keep their own meaning.
  const offline = {
    text: async () => {
      throw Object.assign(new Error("offline"), {
        code: "NETWORK_UNAVAILABLE",
      });
    },
  };
  await assert.rejects(resolveXPost(offline, { id: ID }), {
    code: "NETWORK_UNAVAILABLE",
  });
  // A broken connection is not reported as a deleted or protected post.
  const reset = {
    text: async () => {
      throw Object.assign(new Error("reset"), {
        code: "SOURCE_ACCESS_DENIED",
        detail: "connection-failed",
      });
    },
  };
  await assert.rejects(resolveXPost(reset, { id: ID }), {
    code: "SOURCE_ACCESS_DENIED",
    detail: "connection-failed",
  });
});

test("the embed token is derived from the ID alone", () => {
  assert.match(embedToken(ID), /^[0-9a-z]+$/);
  assert.equal(embedToken(ID), embedToken(ID));
  assert.notEqual(embedToken(ID), embedToken("20"));
});
