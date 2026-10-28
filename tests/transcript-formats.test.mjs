import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeTranscriptText,
  parseUserTranscript,
} from "../lib/ingest-worker.mjs";

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

test("WebVTT cue identifiers of any form are skipped, not parsed as cue text", () => {
  for (const id of ["c0", "intro-1", "5f3c1a2e-aaaa", "7", "회의 1"]) {
    const segments = parseUserTranscript(
      `WEBVTT - title\n\n${id}\n00:00.500 --> 00:02.000 align:start\nHello.\n\n${id}b\n00:02.500 --> 00:04.000\nSecond.\n`,
      ".vtt",
    );
    assert.deepEqual(
      segments.map((s) => [s.startMs, s.endMs, s.text]),
      [
        [500, 2000, "Hello."],
        [2500, 4000, "Second."],
      ],
      id,
    );
  }
});

test("transcripts decode as UTF-8 or BOM-marked UTF-16; legacy code pages are refused", () => {
  const text = "1\r\n00:00:00,000 --> 00:00:01,000\r\n안녕하세요\r\n";
  const utf16be = Buffer.from(text, "utf16le").swap16();
  for (const bytes of [
    Buffer.from(text),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
    Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be]),
  ])
    assert.equal(decodeTranscriptText(bytes), text);
  // "안녕" in EUC-KR/CP949 is not valid UTF-8.
  const cp949 = Buffer.concat([
    Buffer.from("1\n00:00:00,000 --> 00:00:01,000\n"),
    Buffer.from([0xbe, 0xc8, 0xb3, 0xe7]),
    Buffer.from("\n"),
  ]);
  assert.throws(() => decodeTranscriptText(cp949), {
    code: "INVALID_CONTRACT",
    detail: "transcript-encoding-unsupported",
  });
});

test("a cue whose text starts with the word STYLE is still a cue", () => {
  const segments = parseUserTranscript(
    "WEBVTT\n\n00:00.500 --> 00:02.000\nSTYLE matters here.\n",
    ".vtt",
  );
  assert.equal(segments[0].text, "STYLE matters here.");
});
