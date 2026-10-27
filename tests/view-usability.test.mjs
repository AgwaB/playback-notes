import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { fixture } from "./helpers.mjs";
import { htmlDocument } from "../lib/rendering.mjs";
import { markdownDocument } from "../lib/markdown.mjs";

const warning = (code, message) => ({ code, message, severity: "warning", path: null, retryable: false });

test("reader-facing limitations stay visible while implementation diagnostics are folded and escaped", async (t) => {
  const f = await fixture({ mutate(d) {
    d.evidence.extraction.warnings = [
      warning("ASR_UNVERIFIED", "Automatic speech recognition needs checking."),
      warning("ASR_LANGUAGE_RECHECK", "Scanned 120 segments and revised 3."),
      warning("ASR_GPU_FALLBACK", "Used CPU because CUDA was unavailable."),
      warning("CAPTIONS_ANDROID_CLIENT", "Caption transport via Android <script>bad()</script>."),
      warning("UNKNOWN_LIMITATION", "A new substantive limitation."),
    ];
  } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const document = new JSDOM(htmlDocument(f.bundle)).window.document;
  const visible = document.querySelector("#limitations").textContent;
  assert.match(visible, /자동 음성 인식 결과/);
  assert.match(visible, /이름·숫자/);
  assert.match(visible, /A new substantive limitation/);
  assert.doesNotMatch(visible, /120|CUDA|Android/);
  const details = document.querySelector("footer details");
  assert.equal(details.open, false);
  assert.match(details.textContent, /120 segments/);
  assert.match(details.textContent, /CUDA/);
  assert.equal(details.querySelector("script"), null);
  const markdown = markdownDocument(f.bundle);
  const technicalAt = markdown.indexOf("<details>");
  assert.ok(technicalAt > markdown.indexOf("분석 범위와 한계"));
  assert.ok(markdown.indexOf("120 segments") > technicalAt);
  assert.doesNotMatch(markdown, /(?<!\\)<script>bad/);
});

test("header uses source and duration without a language code, source identifier or chunk-coverage ratio", async (t) => {
  const f = await fixture({ mutate(d) {
    d.evidence.source.title = "YouTube jNQXAC9IVRw";
    d.evidence.source.displayName = "YouTube jNQXAC9IVRw";
    d.evidence.source.durationMs = 3600000;
  } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const document = new JSDOM(htmlDocument(f.bundle)).window.document;
  const metadata = document.querySelector(".metadata").textContent;
  assert.equal(metadata, "YouTube 영상 · 1시간");
  assert.doesNotMatch(metadata, /jNQXAC9IVRw|1\/1|\bko\b/);
  assert.match(document.querySelector("footer details").textContent, /검토한 전사 묶음 1\/1/);
  assert.equal(document.querySelector("#source-panel").hidden, true);
});

test("recheck-only imported evidence still presents a localized correctness caveat", async (t) => {
  const f = await fixture({ mutate(d) {
    d.evidence.extraction.warnings = [warning("ASR_LANGUAGE_RECHECK", "Internal scan counts.")];
  } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const document = new JSDOM(htmlDocument(f.bundle)).window.document;
  assert.match(document.querySelector("#limitations").textContent, /자동 음성 인식 결과/);
  assert.match(document.querySelector("footer details").textContent, /Internal scan counts/);
});
