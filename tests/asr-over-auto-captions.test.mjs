import test from "node:test";
import assert from "node:assert/strict";
import { extractionPolicy, ingestionFingerprint } from "../lib/ingest.mjs";
import { normalizeRequest } from "../lib/validation.mjs";

const request = (policy = {}) => ({
  schemaVersion: 1,
  source: { kind: "url", value: "https://www.youtube.com/watch?v=Uv0nAf_7tyU" },
  mode: "briefing",
  policy,
});

test("asrOverAutoCaptions is an optional boolean that defaults to off", () => {
  assert.equal(normalizeRequest(request()).policy.asrOverAutoCaptions, false);
  assert.equal(
    normalizeRequest(request({ asr: "local", asrOverAutoCaptions: true }))
      .policy.asrOverAutoCaptions,
    true,
  );
  assert.equal(extractionPolicy(request()).asrOverAutoCaptions, false);
  assert.throws(
    () => normalizeRequest(request({ asrOverAutoCaptions: "yes" })),
    { code: "INVALID_CONTRACT" },
  );
  assert.throws(() => extractionPolicy(request({ asrOverAutoCaptions: 1 })), {
    code: "INVALID_CONTRACT",
  });
});

test("the option changes the evidence cache key only when local ASR could apply it", async () => {
  const plain = await ingestionFingerprint(request({ asr: "local" }));
  const replacing = await ingestionFingerprint(
    request({ asr: "local", asrOverAutoCaptions: true }),
  );
  assert.notEqual(plain, replacing);
  // With ASR off nothing can be replaced, and evidence cached before the option keeps its key.
  assert.equal(
    await ingestionFingerprint(request()),
    await ingestionFingerprint(request({ asrOverAutoCaptions: true })),
  );
  assert.equal(
    plain,
    await ingestionFingerprint(
      request({ asr: "local", asrOverAutoCaptions: false }),
    ),
  );
});
