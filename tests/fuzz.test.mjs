// Deterministic fuzz tests: random inputs from a fixed seed, checked against invariants.
import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parseUserTranscript } from "../lib/ingest-worker.mjs";
import { htmlTranscriptText, parsePodcastJson } from "../lib/podcast.mjs";
import { htmlDocument } from "../lib/rendering.mjs";
import { markdownDocument } from "../lib/markdown.mjs";
import { phraseHtml } from "../lib/phrases.mjs";
import { fixture } from "./helpers.mjs";

function random(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  const pick = (list) => list[int(list.length)];
  return { next, int, pick };
}
const PIECES = [
  "hello", "안녕하세요", "مرحبا", "日本語", "😀", " ", "  ", "\t", ".", "!", "?", "|", "*", "_", "`", "~",
  "#", ">", "-", "+", "1.", "[", "]", "(", ")", "\\", "<", ">", "&", "&amp;", "<b>", "</b>",
  "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "javascript:alert(1)",
  "[x](javascript:alert(1))", "<v Alice>", "</v>", "-->", "00:00:01,000", "WEBVTT", "NOTE", "STYLE",
  "\u200f", "\u202e", "\u0000", "\uFEFF", "%s", "{{x}}", "${x}", "\r", "\n",
];
const words = (r, max = 12) =>
  Array.from({ length: 1 + r.int(max) }, () => r.pick(PIECES)).join("");
const ALLOWED = new Set(["INVALID_CONTRACT", "NO_USABLE_EVIDENCE", "RESOURCE_LIMIT"]);
const validSegments = (segments) => {
  for (const s of segments) {
    assert.equal(typeof s.text, "string");
    assert.ok(s.text.trim(), "segment text is never empty");
    if (s.startMs === null) assert.equal(s.endMs, null);
    else {
      assert.ok(Number.isSafeInteger(s.startMs) && s.startMs >= 0);
      assert.ok(s.endMs === null || (Number.isSafeInteger(s.endMs) && s.endMs > s.startMs));
    }
  }
};
const controlled = (fn) => {
  try {
    return { value: fn() };
  } catch (error) {
    assert.ok(ALLOWED.has(error.code), `unexpected ${error.name}: ${error.message}`);
    return { error };
  }
};
const clock = (ms, sep) => {
  const h = Math.floor(ms / 3600000),
    m = Math.floor(ms / 60000) % 60,
    s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`;
};

test("random subtitle files either parse into valid segments or fail with a contract error", () => {
  const r = random(20261029);
  for (let i = 0; i < 400; i++) {
    const lines = Array.from({ length: 1 + r.int(14) }, () =>
      r.next() < 0.3 ? `${clock(r.int(9000000), r.pick([",", "."]))} --> ${clock(r.int(9000000), r.pick([",", "."]))}` : words(r, 6),
    );
    const raw = (r.next() < 0.5 ? "WEBVTT\n\n" : "") + lines.join(r.pick(["\n", "\r\n", "\n\n"]));
    for (const ext of [".srt", ".vtt", ".txt"]) {
      const { value } = controlled(() => parseUserTranscript(raw, ext));
      if (value) validSegments(value);
    }
  }
});

test("well-formed generated subtitles round-trip their cue times and text", () => {
  const r = random(7);
  for (let i = 0; i < 200; i++) {
    let at = r.int(5000);
    const cues = Array.from({ length: 1 + r.int(8) }, () => {
      const start = at,
        end = at + 1 + r.int(4000);
      at = end + r.int(2000);
      // Cue text: no blank lines, no arrows and no leading WEBVTT keyword.
      const text = words(r, 5).replace(/-->|\r|\n|\u0000/g, " ").replace(/^\s*(WEBVTT|NOTE|STYLE)/, "x").trim() || "x";
      return { start, end, text };
    });
    const vtt = r.next() < 0.5;
    const raw = vtt
      ? `WEBVTT\n\n${cues.map((c) => `${clock(c.start, ".")} --> ${clock(c.end, ".")}\n${c.text}`).join("\n\n")}\n`
      : `${cues.map((c, n) => `${n + 1}\n${clock(c.start, ",")} --> ${clock(c.end, ",")}\n${c.text}`).join("\n\n")}\n`;
    const { value, error } = controlled(() => parseUserTranscript(raw, vtt ? ".vtt" : ".srt"));
    if (error) continue; // e.g. text that the subtitle grammar treats as a cue setting
    assert.deepEqual(
      value.map((s) => [s.startMs, s.endMs]),
      cues.map((c) => [c.start, c.end]),
    );
    value.forEach((s, n) => assert.equal(s.text.trim(), cues[n].text.trim()));
  }
});

test("random Podcasting 2.0 JSON transcripts yield valid segments or a contract error", () => {
  const r = random(42);
  for (let i = 0; i < 400; i++) {
    const entries = Array.from({ length: r.int(30) }, () => ({
      ...(r.next() < 0.8 ? { startTime: r.pick([r.next() * 100, -1, "3", null, NaN, 1e12]) } : {}),
      ...(r.next() < 0.8 ? { endTime: r.pick([r.next() * 120, 0, "x", null]) } : {}),
      ...(r.next() < 0.9 ? { body: r.pick([words(r, 3), "", 5, null]) } : {}),
      ...(r.next() < 0.5 ? { speaker: r.pick([words(r, 2), "A".repeat(500), 3, null]) } : {}),
    }));
    const raw = r.next() < 0.1 ? words(r) : JSON.stringify({ segments: r.next() < 0.05 ? "nope" : entries });
    try {
      const segments = parsePodcastJson(raw);
      validSegments(segments);
      for (const s of segments) assert.ok(s.speaker === null || (typeof s.speaker === "string" && s.speaker.length <= 100));
    } catch (error) {
      assert.ok(ALLOWED.has(error.code), `unexpected ${error.name}: ${error.message}`);
    }
  }
});

test("HTML transcripts never keep script text or markup", () => {
  const r = random(99);
  for (let i = 0; i < 60; i++) {
    const body = Array.from({ length: 1 + r.int(6) }, () =>
      r.pick([`<p>${words(r, 4)}</p>`, `<script>SECRET${i}</script>`, `<style>SECRET${i}</style>`, `<li>${words(r, 3)}</li>`, words(r, 3)]),
    ).join("");
    const text = htmlTranscriptText(`<html><body>${body}</body></html>`);
    assert.ok(!text.includes(`SECRET${i}`));
    assert.ok(!/<script|<style/i.test(text));
  }
});

test("random report text renders as text: no live markup, scripts or javascript: links", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const r = random(1234);
  const baselineScripts = new JSDOM(htmlDocument(f.bundle)).window.document.querySelectorAll("script").length;
  for (let i = 0; i < 40; i++) {
    const text = words(r, 16).replace(/\u0000/g, "") || "x";
    f.bundle.report.summary[0].text = text;
    f.bundle.report.title = words(r, 6).replace(/\u0000/g, "") || "x";
    const document = new JSDOM(htmlDocument(f.bundle)).window.document;
    assert.equal(document.querySelectorAll("script").length, baselineScripts, "no injected script");
    assert.equal(document.querySelectorAll("img[onerror], [onerror], [onclick]").length, 0);
    for (const link of document.querySelectorAll("a[href]"))
      assert.ok(!/^\s*javascript:/i.test(link.getAttribute("href")));
    const summary = document.querySelector("#overview li");
    assert.ok(summary.textContent.replace(/\s+/g, " ").includes(text.replace(/\s+/g, " ").trim()));
    const tree = fromMarkdown(markdownDocument(f.bundle));
    const visit = (node) => {
      if (node.type === "html") assert.ok(!/script|onerror|<img/i.test(node.value), node.value);
      if (node.type === "link" || node.type === "image") assert.match(node.url, /^https:\/\/www\.youtube\.com\//);
      node.children?.forEach(visit);
    };
    visit(tree);
  }
});

test("phrase grouping keeps every character of random text and adds no markup", () => {
  const r = random(5);
  for (let i = 0; i < 150; i++) {
    const text = words(r, 20).replace(/\u0000/g, "");
    const paragraph = new JSDOM(`<p>${phraseHtml(text)}</p>`).window.document.querySelector("p");
    assert.equal(paragraph.textContent, text.replace(/\r\n?/g, "\n"));
    assert.equal(paragraph.querySelectorAll("*:not(span.source-phrase)").length, 0);
  }
});
