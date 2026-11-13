import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fixture } from "./helpers.mjs";
import { htmlDocument } from "../lib/rendering.mjs";
import { markdownDocument } from "../lib/markdown.mjs";
import { buildView, labels } from "../lib/view.mjs";

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
  for (const [language, regionTags] of [
    ["ko", ["ko-KR"]],
    ["ja", ["ja-JP"]],
    ["zh", ["zh-CN", "zh-Hans"]],
    ["es", ["es-MX"]],
  ]) {
    const translated = labels(language);
    assert.deepEqual(Object.keys(translated), Object.keys(english), language);
    for (const [key, value] of Object.entries(translated)) {
      assert.ok(
        typeof value === "string" && value.trim(),
        `${language} ${key}`,
      );
      assert.notEqual(
        value,
        english[key],
        `${language} ${key} is not translated`,
      );
    }
    for (const tag of regionTags)
      assert.deepEqual(labels(tag), translated, tag);
  }
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

test("every translation rewords the same extraction warnings", async (t) => {
  const stored = "Stored English wording of the notice.";
  const warnings = [
    "ASR_END_CLAMPED",
    "FRAMES_CUTS_DROPPED",
    "ASR_UNVERIFIED",
    "AUTOMATIC_CAPTIONS",
    "AUTO_CAPTIONS_REPLACED",
    "COVERAGE_UNVERIFIED",
    "DURATION_UNVERIFIED",
    "FRAMES_SAMPLED",
    "PLATFORM_MEDIA_DOWNLOADED",
    "PLATFORM_VIDEO_DOWNLOADED",
    "PODCAST_PUBLISHER_TRANSCRIPT",
  ].map((code) => warning(code, stored));
  const shown = new Map();
  for (const language of ["ko", "ja", "zh", "es", "fr"]) {
    const f = await inLanguage(language, warnings);
    t.after(() => rm(f.root, { recursive: true, force: true }));
    shown.set(language, buildView(f.bundle).limitations);
  }
  // French ships no translation, so each notice keeps its stored text.
  const count = (language) =>
    shown.get(language).filter((text) => text === stored).length;
  assert.equal(count("fr"), warnings.length);
  for (const language of ["ko", "ja", "zh", "es"]) {
    assert.equal(count(language), 0, language);
    assert.equal(shown.get(language).length, shown.get("fr").length, language);
  }
});

test("frames that were sampled but never cited are not reported as visuals that were not analyzed", async (t) => {
  const frame = {
    id: "frame-0001",
    timestampMs: 1000,
    assetPath: "assets/frame-0001.jpg",
    sha256: "0".repeat(64),
    width: 320,
    height: 180,
    ocrText: null,
  };
  const sampled = await fixture({
    mutate(d) {
      d.evidence.frames = [frame];
    },
  });
  t.after(() => rm(sampled.root, { recursive: true, force: true }));
  const english = labels("en");
  const html = htmlDocument(sampled.bundle);
  assert.ok(html.includes(english.sampledOnly));
  assert.ok(!html.includes(english.noVisual));
  assert.ok(markdownDocument(sampled.bundle).includes(english.sampledOnly));
  const transcriptOnly = await fixture();
  t.after(() => rm(transcriptOnly.root, { recursive: true, force: true }));
  const plain = htmlDocument(transcriptOnly.bundle);
  assert.ok(plain.includes(english.noVisual));
  assert.ok(!plain.includes(english.sampledOnly));
});
