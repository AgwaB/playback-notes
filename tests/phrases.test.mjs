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
    phraseHtml("모델은 GPT-4o 기준 97% 정확도"),
    /<span class="source-phrase">GPT-4o<\/span>/,
  );
  assert.match(
    phraseHtml("모델은 GPT-4o 기준 97% 정확도"),
    /<span class="source-phrase">97%<\/span>/,
  );
});
