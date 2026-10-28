import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { normalizeRequest } from "../lib/validation.mjs";
import { htmlDocument } from "../lib/rendering.mjs";
import { markdownDocument } from "../lib/markdown.mjs";
import {
  originalCaptionLanguage,
  rankCaptionTracks,
} from "../lib/caption-tracks.mjs";
import { fixture } from "./helpers.mjs";

const request = {
  schemaVersion: 1,
  source: { kind: "url", value: "https://example.com/video.mp4" },
  mode: "briefing",
};
const samples = [
  ["en", "Preserve the source text."],
  ["ko", "원문을 그대로 보존합니다."],
  ["ja-JP", "原文をそのまま保持します。"],
  ["zh-Hant", "保留原始文字。"],
  ["es-MX", "Conserva el texto original."],
  ["ar", "احتفظ بالنص الأصلي."],
  ["hi", "मूल पाठ को सुरक्षित रखें।"],
  ["ru", "Сохраните исходный текст."],
];

test("English is the omitted report-language default, not a source-language preference", () => {
  const normalized = normalizeRequest(request);
  assert.equal(normalized.outputLanguage, "en");
  assert.deepEqual(normalized.policy.transcriptLanguages, []);
  assert.equal(Object.hasOwn(request, "outputLanguage"), false);
  for (const [outputLanguage] of samples)
    assert.equal(
      normalizeRequest({ ...request, outputLanguage }).outputLanguage,
      outputLanguage,
    );
  for (const outputLanguage of ["", null, "not a locale"])
    assert.throws(() => normalizeRequest({ ...request, outputLanguage }), {
      code: "INVALID_CONTRACT",
    });
});

for (const [language, title] of samples) {
  test(`report locale ${language} preserves authored text and independent source text`, async (t) => {
    const source = "原文をそのまま保持します。";
    const f = await fixture({
      mutate(d) {
        d.request.outputLanguage = d.report.outputLanguage = language;
        d.report.title = title;
        d.report.summary[0].text = title;
        d.evidence.source.sourceLanguage = "ja";
        d.evidence.segments[0].text = source;
        d.report.sections[0].blocks[3].statement.text = source;
      },
    });
    t.after(() => rm(f.root, { recursive: true, force: true }));
    const document = new JSDOM(htmlDocument(f.bundle)).window.document;
    assert.equal(document.documentElement.lang, language);
    assert.equal(document.querySelector("h1").textContent, title);
    assert.ok(
      document.querySelector("#tx-seg-000001").textContent.includes(source),
    );
    assert.ok(
      document.querySelector("blockquote").textContent.includes(source),
    );
    const markdown = markdownDocument(f.bundle);
    assert.ok(markdown.includes(title));
    assert.ok(markdown.includes(source));
    assert.equal(f.bundle.evidence.source.sourceLanguage, "ja");
  });
}

test("localized original-audio markers outrank a translated default track", () => {
  for (const [language, displayName] of [
    ["en", "English (original)"],
    ["ko", "한국어 (원본)"],
    ["ja", "日本語 (オリジナル)"],
    ["zh", "中文（原始）"],
    ["ru", "Русский оригинал"],
  ]) {
    const original = originalCaptionLanguage({
      streamingData: {
        adaptiveFormats: [
          {
            audioTrack: {
              id: "fr.4",
              displayName: "French",
              audioIsDefault: true,
            },
          },
          {
            audioTrack: {
              id: `${language}.4`,
              displayName,
              audioIsDefault: false,
            },
          },
        ],
      },
    });
    assert.equal(original, language, displayName);
    const tracks = [
      { languageCode: "fr", automatic: false },
      { languageCode: language, automatic: true },
    ];
    assert.equal(
      rankCaptionTracks(tracks, [], original)[0].languageCode,
      language,
    );
    assert.equal(
      rankCaptionTracks(tracks, ["fr"], original)[0].languageCode,
      "fr",
    );
  }
});
