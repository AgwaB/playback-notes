import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { readAsrOutput } from "../lib/asr-output.mjs";
import { runLocalTool } from "../lib/local-tool.mjs";

async function setup(t, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "asr-output-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { base: path.join(dir, "transcript"), options: {
    workDir: dir, timeoutMs: 10000, maxBytes: 1024 * 1024,
    signal: AbortSignal.timeout(10000), ...overrides,
  } };
}

test("Windows producer success without an output connection fails before the job deadline", {
  skip: process.platform !== "win32",
}, async (t) => {
  const { base, options } = await setup(t);
  let producerExited = false;
  const start = performance.now();
  await assert.rejects(readAsrOutput(base, options, async () => {
    await runLocalTool(process.execPath, ["-e", ""], options);
    producerExited = true;
  }), { code: "NO_USABLE_EVIDENCE" });
  assert.equal(producerExited, true);
  assert.ok(performance.now() - start < 5000, "must not wait for the 10-second job deadline");
});

test("fast successful writers drain every byte without a false missing-output failure", async (t) => {
  const { base, options } = await setup(t);
  for (const count of [1, 1024, 32768, 1, 32768]) {
    const expected = "한영 output\n".repeat(count);
    const raw = await readAsrOutput(base, options, (output, signal) =>
      runLocalTool(process.execPath, ["-e",
        "require('node:fs').writeFileSync(process.argv[1], '한영 output\\n'.repeat(Number(process.argv[2])))",
        `${output}.srt`, String(count)], { ...options, signal }));
    assert.equal(raw, expected);
  }
});

test("a Windows pipe connection queued just after producer completion can still deliver output", {
  skip: process.platform !== "win32",
}, async (t) => {
  const { base, options } = await setup(t);
  let pending;
  let writerFinished;
  try {
    const raw = await readAsrOutput(base, options, async (output) => {
      writerFinished = new Promise((resolve, reject) => {
        pending = setTimeout(() => {
          const writer = createConnection(`${output}.srt`);
          writer.once("error", reject);
          writer.once("connect", () => writer.end("late connection output"));
          writer.once("close", resolve);
        }, 100);
      });
      // Record possible rejection immediately, even if the reader itself fails first.
      writerFinished.catch(() => {});
    });
    assert.equal(raw, "late connection output");
    await writerFinished;
  } finally {
    clearTimeout(pending);
  }
});

test("producer failures and output byte-budget failures preserve their error codes", async (t) => {
  const { base, options } = await setup(t);
  await assert.rejects(readAsrOutput(base, options, (_output, signal) =>
    runLocalTool(process.execPath, ["-e", "process.exit(1)"], { ...options, signal })),
  { code: "SOURCE_UNSUPPORTED" });
  const small = { ...options, maxBytes: 128 };
  await assert.rejects(readAsrOutput(base, small, (output, signal) =>
    runLocalTool(process.execPath, ["-e",
      "require('node:fs').writeFileSync(process.argv[1], 'x'.repeat(4096))", `${output}.srt`], { ...small, signal })),
  { code: "RESOURCE_LIMIT" });
});

test("a Windows job deadline still interrupts a missing output during connection grace", {
  skip: process.platform !== "win32",
}, async (t) => {
  const { base, options } = await setup(t, { signal: AbortSignal.timeout(200) });
  await assert.rejects(readAsrOutput(base, options, async () => {}), { code: "TIMEOUT" });
});

test("POSIX producer success without output still closes the FIFO reader", {
  skip: process.platform === "win32",
}, async (t) => {
  const { base, options } = await setup(t);
  const raw = await readAsrOutput(base, options, async () => {
    await runLocalTool(process.execPath, ["-e", ""], options);
  });
  assert.equal(raw, "");
});
