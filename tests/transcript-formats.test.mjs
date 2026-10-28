import test from "node:test";
import assert from "node:assert/strict";
import { parseUserTranscript } from "../lib/ingest-worker.mjs";

const cues =
  "00:00.500 --> 00:02.000\n<v Alice>Hello <b>world</b>.\n\n00:02.500 --> 00:04.000\nSecond.\n";

test("WebVTT STYLE, REGION and NOTE blocks are skipped; cue text stays literal", () => {
  for (const prefix of [
    "STYLE\n::cue { color: red }\n\n",
    "REGION\nid:fred width:40%\n\n",
    "NOTE a comment\nover two lines\n\n",
    "STYLE\n::cue(v[voice=\"Alice\"]) { color: blue }\n\nREGION\nid:a\n\nNOTE x\n\n",
  ]) {
    const segments = parseUserTranscript(`WEBVTT\r\n\r\n${prefix.replace(/\n/g, "\r\n")}${cues}`, ".vtt");
    assert.deepEqual(
      segments.map((s) => [s.startMs, s.endMs, s.text, s.speaker]),
      [
        [500, 2000, "<v Alice>Hello <b>world</b>.", null],
        [2500, 4000, "Second.", null],
      ],
      prefix,
    );
  }
});

test("a cue whose text starts with the word STYLE is still a cue", () => {
  const segments = parseUserTranscript(
    "WEBVTT\n\n00:00.500 --> 00:02.000\nSTYLE matters here.\n",
    ".vtt",
  );
  assert.equal(segments[0].text, "STYLE matters here.");
});
