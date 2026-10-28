import test from "node:test";
import assert from "node:assert/strict";
import { phraseHtml } from "../lib/phrases.mjs";

test("phrase grouping stays linear on a long connected token (round 7 F4) and keeps short groups", () => {
  const long = "a1".repeat(10000);
  const started = performance.now();
  assert.equal(
    phraseHtml(long),
    long,
    "a 20,000-character token is never grouped",
  );
  assert.ok(
    performance.now() - started < 1000,
    "was ~3 s when every match rescanned the token",
  );
  assert.match(
    phraseHtml("Model: GPT-4o; accuracy: 97%."),
    /<span class="source-phrase">GPT-4o;<\/span>/,
  );
  assert.match(
    phraseHtml("Model: GPT-4o; accuracy: 97%."),
    /<span class="source-phrase">97%\.<\/span>/,
  );
  // Round 8 R8-6: a long bracketed run still excludes its connected tail, exactly as before.
  const bracketed = "(" + "a".repeat(51) + ")foo 12";
  assert.equal(
    phraseHtml(bracketed),
    `(${"a".repeat(51)})foo <span class="source-phrase">12</span>`,
  );
});
