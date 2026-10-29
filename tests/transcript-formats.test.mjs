import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeTranscriptText,
  parseUserTranscript,
} from "../lib/ingest-worker.mjs";

const cues =
  "00:00.500 --> 00:02.000\n<v Alice>Hello <b>world</b>.\n\n00:02.500 --> 00:04.000\nSecond.\n";

test("WebVTT STYLE, REGION and NOTE blocks are skipped; a voice span names the speaker", () => {
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
        [500, 2000, "Hello world.", "Alice"],
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

test("transcripts decode as UTF-8 or BOM-marked UTF-16 without a guess", () => {
  const text = "1\r\n00:00:00,000 --> 00:00:01,000\r\n안녕하세요\r\n";
  const utf16be = Buffer.from(text, "utf16le").swap16();
  for (const [bytes, encoding] of [
    [Buffer.from(text), "utf-8"],
    [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]), "utf-8"],
    [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]), "utf-16le"],
    [Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be]), "utf-16be"],
  ])
    assert.deepEqual(decodeTranscriptText(bytes), { text, encoding, detected: false });
});

test("legacy code pages are detected like mpv does, and too little evidence is refused", () => {
  const cue = "1\n00:00:01,000 --> 00:00:04,000\n";
  // EUC-KR/CP949 and Shift_JIS bytes of a Korean and a Japanese sentence (iconv output).
  const korean = Buffer.concat([
    Buffer.from(cue),
    Buffer.from(
      "bec8b3e7c7cfbcbcbfe42e20bfc0b4c320c8b8c0c7bfa1bcadb4c220b4d9c0bd20bad0b1e220c3e2bdc320c0cfc1a4c0bb20b3edc0c7c7dfbdc0b4cfb4d92e0a",
      "hex",
    ),
  ]);
  const japanese = Buffer.concat([
    Buffer.from(cue),
    Buffer.from(
      "82b182f182c982bf82cd81428da193fa82cd89ef8b6382cc93fa92f682c982c282a282c4986282b582dc82b781420a",
      "hex",
    ),
  ]);
  assert.deepEqual(decodeTranscriptText(korean), {
    text: `${cue}안녕하세요. 오늘 회의에서는 다음 분기 출시 일정을 논의했습니다.\n`,
    encoding: "euc-kr",
    language: "ko",
    detected: true,
  });
  assert.equal(decodeTranscriptText(japanese).encoding, "shift_jis");
  assert.match(decodeTranscriptText(japanese).text, /今日は会議の日程について話します。/);
  // "안녕" alone (4 bytes) is not enough to tell code pages apart.
  const short = Buffer.concat([Buffer.from(cue), Buffer.from([0xbe, 0xc8, 0xb3, 0xe7, 0x0a])]);
  assert.throws(() => decodeTranscriptText(short), {
    code: "INVALID_CONTRACT",
    detail: "transcript-encoding-unsupported",
  });
});

test("cue formatting is dropped: WebVTT spans and references, SubRip tags and ASS overrides", () => {
  const vtt = parseUserTranscript(
    "WEBVTT\n\n00:00.000 --> 00:01.000\n<v.loud Esme>It's a <c.red>blue</c> apple &amp; <00:00.500>tree!\n\n00:01.000 --> 00:02.000\n<v Mary>No way!</v> <v Bob>Yes.</v>\n\n00:02.000 --> 00:03.000\na &lt;b&gt; tag is text\n",
    ".vtt",
  );
  assert.deepEqual(
    vtt.map((s) => [s.speaker, s.text]),
    [
      ["Esme", "It's a blue apple & tree!"],
      [null, "No way! Yes."],
      [null, "a <b> tag is text"],
    ],
  );
  const srt = parseUserTranscript(
    '1\n00:00:00,000 --> 00:00:01,000\n{\\an8}<i>Hello</i> <font color="#ff0">there</font>, 3 < 4\n',
    ".srt",
  );
  assert.deepEqual(srt.map((s) => [s.speaker, s.text]), [[null, "Hello there, 3 < 4"]]);
});

test("podcast transcripts carry the speaker until it changes (Podcasting 2.0 VTT and SRT)", () => {
  const vtt = parseUserTranscript(
    "WEBVTT\n\n00:00.000 --> 00:01.000\n<v John>Podcasting 2.0 is changing the game.\n\n00:01.000 --> 00:02.000\n<v Tom>Yeah, absolutely.\n\n00:02.000 --> 00:03.000\nIt's amazing.\n",
    ".vtt",
    { podcast: true },
  );
  assert.deepEqual(vtt.map((s) => s.speaker), ["John", "Tom", "Tom"]);
  const srt = (cards) =>
    cards.map((text, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i + 1},000\n${text}\n`).join("\n");
  const cards = [
    "Sarah: In today's episode, you'll learn",
    "whether you should have a trailer.",
    "Note: this card names no speaker",
    "Gillian: Hi Buzzsprout, Gillian here",
    "Sarah: Welcome.",
    "Gillian: Thanks.",
  ];
  const podcast = parseUserTranscript(srt(cards), ".srt", { podcast: true });
  assert.deepEqual(
    podcast.map((s) => [s.speaker, s.text]),
    [
      ["Sarah", "In today's episode, you'll learn"],
      ["Sarah", "whether you should have a trailer."],
      ["Sarah", "Note: this card names no speaker"],
      ["Gillian", "Hi Buzzsprout, Gillian here"],
      ["Sarah", "Welcome."],
      ["Gillian", "Thanks."],
    ],
  );
  // Publishers also write "Name:" in VTT and plain text (Darknet Diaries, Acquired).
  assert.deepEqual(
    parseUserTranscript(
      "WEBVTT\n\n00:00.000 --> 00:01.000\nJACK: [Music] There's a kind of silence\n\n00:01.000 --> 00:02.000\nthat follows an attack.\n\n00:02.000 --> 00:03.000\nJACK: Your throat gets dry.\n",
      ".vtt",
      { podcast: true },
    ).map((s) => [s.speaker, s.text]),
    [
      ["JACK", "[Music] There's a kind of silence"],
      ["JACK", "that follows an attack."],
      ["JACK", "Your throat gets dry."],
    ],
  );
  assert.deepEqual(
    parseUserTranscript(
      "Ben: All right, David.\n\nDavid: Oh, yes!\n\nBen: Let's go.\n\nDavid: Sure.\n",
      ".txt",
      { podcast: true },
    ).map((s) => s.speaker),
    ["Ben", "David", "Ben", "David"],
  );
  // A name opening a single cue is unconfirmed: it keeps its text and ends the previous
  // speaker's turn instead of being attributed to them.
  assert.deepEqual(
    parseUserTranscript(
      "Alice: First question.\n\nBob: My answer.\n\nMore from Bob.\n\nAlice: Thank you.\n",
      ".txt",
      { podcast: true },
    ).map((s) => [s.speaker, s.text]),
    [
      ["Alice", "First question."],
      [null, "Bob: My answer."],
      [null, "More from Bob."],
      ["Alice", "Thank you."],
    ],
  );
  // Outside podcasts, a user's SRT keeps "Name:" as text and VTT voices do not carry over.
  assert.equal(parseUserTranscript(srt(cards), ".srt")[0].text, cards[0]);
  assert.deepEqual(
    parseUserTranscript(
      "WEBVTT\n\n00:00.000 --> 00:01.000\n<v Tom>Hi.\n\n00:01.000 --> 00:02.000\nNext.\n",
      ".vtt",
    ).map((s) => s.speaker),
    ["Tom", null],
  );
});

test("podcast speakers: labels and numbers are not names, and speakers follow time order", () => {
  const txt = (paragraphs) =>
    parseUserTranscript(paragraphs.join("\n\n"), ".txt", { podcast: true }).map((s) => [
      s.speaker,
      s.text,
    ]);
  // A repeated "Note:" or "10:" is ordinary text, kept whole and attributed to nobody.
  assert.deepEqual(txt(["Note: use the switch.", "Note: then reboot.", "More text."]), [
    [null, "Note: use the switch."],
    [null, "Note: then reboot."],
    [null, "More text."],
  ]);
  assert.deepEqual(txt(["10: first", "10: second"]), [
    [null, "10: first"],
    [null, "10: second"],
  ]);
  // Cues listed out of time order: the unmarked cue at 11 s continues Bob at 10 s, not
  // Alice, who is listed after Bob but speaks at 0 s.
  const vtt = parseUserTranscript(
    "WEBVTT\n\n00:10.000 --> 00:11.000\n<v Bob>Later turn.\n\n00:00.000 --> 00:01.000\n<v Alice>First turn.\n\n00:11.000 --> 00:12.000\nStill Bob speaking.\n",
    ".vtt",
    { podcast: true },
  );
  assert.deepEqual(
    vtt.map((s) => [s.startMs, s.speaker]),
    [
      [10000, "Bob"],
      [0, "Alice"],
      [11000, "Bob"],
    ],
  );
});

test("a cue whose text starts with the word STYLE is still a cue", () => {
  const segments = parseUserTranscript(
    "WEBVTT\n\n00:00.500 --> 00:02.000\nSTYLE matters here.\n",
    ".vtt",
  );
  assert.equal(segments[0].text, "STYLE matters here.");
});
