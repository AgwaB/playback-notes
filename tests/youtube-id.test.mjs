import { test } from "node:test";
import assert from "node:assert/strict";
import { youtubeVideoId } from "../lib/youtube-id.mjs";

test("YouTube links keep their video ID", () => {
  assert.equal(
    youtubeVideoId("https://www.youtube.com/watch?v=ne99laPUxN4"),
    "ne99laPUxN4",
  );
  assert.equal(youtubeVideoId("https://youtu.be/ne99laPUxN4"), "ne99laPUxN4");
});

test("HackerTube watch links resolve to the YouTube video ID", () => {
  assert.equal(
    youtubeVideoId("https://hackertube.org/watch/ne99laPUxN4"),
    "ne99laPUxN4",
  );
  assert.equal(
    youtubeVideoId("https://www.hackertube.org/watch/ne99laPUxN4/"),
    "ne99laPUxN4",
  );
});

test("other HackerTube pages and unsafe forms are not videos", () => {
  for (const href of [
    "https://hackertube.org/",
    "https://hackertube.org/about",
    "https://hackertube.org/watch/short",
    "https://hackertube.org/watch/ne99laPUxN4/extra",
    "http://hackertube.org/watch/ne99laPUxN4",
    "https://user:pw@hackertube.org/watch/ne99laPUxN4",
    "https://hackertube.org.evil.example/watch/ne99laPUxN4",
    "not a url",
  ])
    assert.equal(youtubeVideoId(href), null, href);
});
