import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { fakeTool } from "./fake-tool.mjs";
import { review } from "../scripts/asr-review.mjs";

const exec = promisify(execFile);

async function setup(t, { badTimes = false } = {}) {
  // macOS temporary paths may begin with /var, a symlink to /private/var.
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "asr-review-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source.wav");
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-ac", "1", "-ar", "16000", source]);
  const cpu = await fakeTool(path.join(dir, "cpu"), `
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.writeFileSync(args[args.indexOf('--output-file') + 1] + '.srt', ${JSON.stringify(`1\n00:00:00,100 --> ${badTimes ? "00:00:29,980" : "00:00:00,500"}\nKorean English candidate.\n`)});
`);
  const gpu = await fakeTool(path.join(dir, "gpu"), `
import fs from 'node:fs';
const args = process.argv.slice(2);
console.error('whisper_backend_init_gpu: using CUDA0 backend');
if (args.includes('--duration')) process.exit(0);
fs.writeFileSync(args[args.indexOf('--output-file') + 1] + '.srt', '1\\n00:00:00,100 --> 00:00:00,500\\nGPU candidate.\\n');
`);
  const model = path.join(dir, "model.bin");
  await writeFile(model, "fake model");
  const preference = path.join(dir, "preference.json");
  const options = { source, "work-dir": path.join(dir, "work"), "start-ms": "1000", "end-ms": "11000", "local-asr-executable": cpu, "local-asr-model": model };
  return { dir, source, cpu, gpu, model, preference, options };
}

test("review preserves source and reports overlapping unverified alternatives at source times", async (t) => {
  const f = await setup(t);
  const before = await readFile(f.source);
  await writeFile(f.preference, JSON.stringify({ localAsrExecutable: f.cpu, localAsrGpuExecutable: f.gpu, localAsrModel: f.model }));
  const response = await review(f.options, { asrPreferencePath: f.preference });
  assert.equal(response.status, "ok");
  assert.equal(response.issues[0].code, "ASR_REVIEW_UNVERIFIED");
  const data = JSON.parse(await readFile(path.join(f.options["work-dir"], "review.json"), "utf8"));
  assert.match(data.notice, /UNTRUSTED, UNVERIFIED/);
  assert.deepEqual(data.windows.map(({startMs, endMs}) => [startMs, endMs]), [[1000, 7000], [1000, 9000], [7000, 11000]]);
  assert.deepEqual(data.windows.map((w) => w.backend), ["cuda", "cuda", "cuda"]);
  assert.deepEqual(data.windows.map((w) => [w.segments[0].startMs, w.segments[0].endMs]), [[1100, 1500], [1100, 1500], [7100, 7500]]);
  assert.equal(data.windows[0].segments[0].text, "GPU candidate.");
  assert.deepEqual(await readFile(f.source), before);
  for (const name of await readdir(path.join(f.options["work-dir"], "windows"))) {
    assert.ok(!(await readdir(path.join(f.options["work-dir"], "windows", name))).includes("clip.wav"));
  }
  await assert.rejects(review(f.options, { asrPreferencePath: f.preference }), { code: "OUTPUT_EXISTS" });
});

test("out-of-range model timestamps are withheld and marked partial", async (t) => {
  const f = await setup(t, { badTimes: true });
  const response = await review(f.options, { asrPreferencePath: f.preference });
  assert.equal(response.status, "partial");
  const data = JSON.parse(await readFile(path.join(f.options["work-dir"], "review.json"), "utf8"));
  assert.ok(data.windows.every((w) => w.status === "unavailable" && w.segments.length === 0));
});

test("invalid ranges fail and a missing GPU preference falls back to CPU", async (t) => {
  const f = await setup(t);
  await assert.rejects(review({ ...f.options, "start-ms": "-1" }, { asrPreferencePath: f.preference }), { code: "INVALID_CONTRACT" });
  await assert.rejects(review({ ...f.options, "end-ms": "121001" }, { asrPreferencePath: f.preference }), { code: "INVALID_CONTRACT" });
  await writeFile(f.preference, JSON.stringify({ localAsrExecutable: f.cpu, localAsrGpuExecutable: path.join(f.dir, "missing"), localAsrModel: f.model }));
  const response = await review(f.options, { asrPreferencePath: f.preference });
  assert.equal(response.status, "ok");
  const data = JSON.parse(await readFile(path.join(f.options["work-dir"], "review.json"), "utf8"));
  assert.ok(data.windows.every((w) => w.backend === "cpu"));
});

test("review refuses to replace an existing review artifact", async (t) => {
  const f = await setup(t);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(f.options["work-dir"]);
  const existing = path.join(f.options["work-dir"], "review.json");
  await writeFile(existing, "keep this existing file");
  await assert.rejects(review(f.options, { asrPreferencePath: f.preference }), { code: "OUTPUT_EXISTS" });
  assert.equal(await readFile(existing, "utf8"), "keep this existing file");
});

test("review does not publish success when the deadline expires during final fsync", async (t) => {
  const f = await setup(t);
  const controller = new AbortController();
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (ms) => ms === 20 * 60_000 ? controller.signal : timeout(ms));
  const handle = await open(f.source, "r");
  const prototype = Object.getPrototypeOf(handle);
  const sync = prototype.sync;
  await handle.close();
  t.mock.method(prototype, "sync", async function (...args) {
    await sync.apply(this, args);
    controller.abort(new DOMException("Deadline reached", "TimeoutError"));
  });
  await assert.rejects(review(f.options, { asrPreferencePath: f.preference }), { code: "TIMEOUT" });
  assert.equal(controller.signal.aborted, true, "the final write was reached");
  assert.deepEqual(await readdir(f.options["work-dir"]), ["windows"], "no review, lock or temporary file remains");
});
