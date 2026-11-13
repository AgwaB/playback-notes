import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fixture } from "./helpers.mjs";
import { htmlDocument } from "../lib/rendering.mjs";
import { markdownDocument } from "../lib/markdown.mjs";
import { labels } from "../lib/view.mjs";

const inLanguage = (language, warnings = []) =>
  fixture({
    mutate(d) {
      d.request.outputLanguage = language;
      d.report.outputLanguage = language;
      d.evidence.extraction.warnings.push(...warnings);
    },
  });
const warning = (code, message) => ({
  code,
  severity: "warning",
  message,
  path: null,
  retryable: false,
});

test("built-in labels follow the report language where a translation ships, English otherwise", () => {
  const english = labels("en");
  const korean = labels("ko-KR");
  assert.deepEqual(Object.keys(korean), Object.keys(english));
  for (const [key, value] of Object.entries(korean)) {
    assert.ok(typeof value === "string" && value.trim(), key);
    assert.notEqual(value, english[key], `${key} is not translated`);
  }
  assert.deepEqual(labels("ko"), korean);
  assert.deepEqual(labels("fr"), english);
  assert.deepEqual(labels("not a tag"), english);
  assert.deepEqual(labels(undefined), english);
});

test("a Korean report renders Korean headings and reworded warnings in HTML and Markdown; other languages keep English", async (t) => {
  const stored =
    "Frames were sampled at a fixed interval. Inspect a frame before citing it.";
  const specific =
    "seg-000001 came from a second pass. Check it against the audio.";
  const warnings = [
    warning("FRAMES_SAMPLED", stored),
    warning("ASR_GAPS_RETRANSCRIBED", specific),
  ];
  const ko = await inLanguage("ko", warnings);
  t.after(() => rm(ko.root, { recursive: true, force: true }));
  for (const document of [
    htmlDocument(ko.bundle),
    markdownDocument(ko.bundle),
  ]) {
    assert.ok(document.includes("한눈에 보기"));
    assert.ok(document.includes("범위와 한계"));
    assert.ok(!document.includes("At a glance"));
    assert.ok(!document.includes("Scope &amp; limitations"));
    assert.ok(!document.includes("Scope & limitations"));
    // A warning without run-specific detail is reworded for the reader ...
    assert.ok(document.includes("그 사이의 장면은 반영되지 않았습니다"));
    assert.ok(!document.includes("Inspect a frame before citing it"));
    // ... one that names segments keeps its stored message.
    assert.ok(document.includes("came from a second pass"));
  }
  const en = await inLanguage("en", warnings);
  t.after(() => rm(en.root, { recursive: true, force: true }));
  const html = htmlDocument(en.bundle);
  assert.ok(html.includes("At a glance"));
  assert.ok(html.includes("Inspect a frame before citing it"));
  assert.ok(!html.includes("한눈에 보기"));
});
