import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fakeTool } from "./fake-tool.mjs";
import {
  gpuFallbackWarning,
  transcribeWithAcceleration,
} from "../lib/asr-acceleration.mjs";
import { extractSource } from "../lib/ingest.mjs";

const srt = "1\n00:00:00,000 --> 00:00:00,500\nCPU transcription.\n";

test("GPU fallback guidance distinguishes unavailable WSL devices without claiming a cause", () => {
  assert.equal(gpuFallbackWarning(null), null);
  const wsl = gpuFallbackWarning("gpu-unavailable", {
    wsl: true,
    deviceAccessible: false,
  });
  assert.match(wsl, /CPU/);
  assert.match(wsl, /\/dev\/dxg.*unavailable or inaccessible/);
  assert.match(wsl, /sandbox may hide/i);
  assert.doesNotMatch(
    gpuFallbackWarning("gpu-unavailable", {
      wsl: true,
      deviceAccessible: true,
    }),
    /\/dev\/dxg/,
  );
  assert.doesNotMatch(gpuFallbackWarning("gpu-failed"), /WSL|\/dev\/dxg/);
  assert.match(gpuFallbackWarning("gpu-failed"), /failed during transcription/);
});

async function setup(t, gpuBody) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "asr-accel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cpu = await fakeTool(
    path.join(dir, "cpu"),
    `
import fs from 'node:fs';
fs.appendFileSync('trace.log', 'cpu ' + process.argv.slice(2).join(' ') + '\\n');
const args=process.argv.slice(2);
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt', ${JSON.stringify(srt)});
`,
  );
  const gpu =
    gpuBody === null
      ? path.join(dir, "missing.exe")
      : await fakeTool(
          path.join(dir, "gpu"),
          `
import fs from 'node:fs';
const args=process.argv.slice(2);
fs.appendFileSync('trace.log', 'gpu ' + args.join(' ') + '\\n');
${gpuBody}
`,
        );
  const options = {
    cpuExecutable: cpu,
    gpuExecutable: gpu,
    modelPath: "model.bin",
    wavPath: "input.wav",
    workDir: dir,
    timeoutMs: 10000,
    maxBytes: 65536,
    signal: AbortSignal.timeout(10000),
  };
  // Under heavy load a deadline can fire before a fake tool even starts: no trace yet.
  const trace = () =>
    readFile(path.join(dir, "trace.log"), "utf8").catch((error) =>
      error.code === "ENOENT" ? "" : Promise.reject(error),
    );
  return { dir, cpu, gpu, options, trace };
}

test("positive GPU probe uses the GPU without a CPU retry", async (t) => {
  const f = await setup(
    t,
    `
console.error('whisper_backend_init_gpu: using CUDA0 backend');
if (args.includes('--duration')) process.exit(0);
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt', '1\\n00:00:00,000 --> 00:00:00,500\\nGPU transcription.\\n');
`,
  );
  const result = await transcribeWithAcceleration(f.options);
  assert.match(result.raw, /GPU transcription/);
  assert.equal(result.backend, "cuda");
  assert.equal(result.fallback, null);
  const trace = await f.trace();
  assert.doesNotMatch(trace, /^cpu /m);
  assert.match(trace, /^gpu .*--language en .*--duration 1000/m);
  assert.match(trace, /^gpu .*--language auto .*--output-srt/m);
});

test("CPU fallback handles no GPU and a missing accelerated executable", async (t) => {
  for (const body of [
    null,
    `console.error('whisper_backend_init_gpu: no GPU found'); process.exit(0);`,
  ]) {
    const f = await setup(t, body);
    const result = await transcribeWithAcceleration(f.options);
    assert.equal(result.raw, srt);
    assert.equal(result.backend, "cpu");
    assert.equal(result.fallback, "gpu-unavailable");
    assert.match(await f.trace(), /^cpu /m);
  }
});

test("probe-specific timeout falls back to CPU when the shared deadline has time left", async (t) => {
  // The per-tool budget also bounds the CPU run, so it must leave room for a loaded host.
  const f = await setup(t, `await new Promise(r => setTimeout(r, 30000));`);
  f.options.timeoutMs = 4000;
  f.options.signal = AbortSignal.timeout(30000);
  const result = await transcribeWithAcceleration(f.options);
  assert.equal(result.raw, srt);
  assert.equal(result.backend, "cpu");
  assert.equal(result.fallback, "gpu-unavailable");
  assert.match(await f.trace(), /^cpu /m);
});

test("Metal's preliminary backend message followed by initialization failure selects CPU", async (t) => {
  const f = await setup(
    t,
    `
console.error('whisper_backend_init_gpu: using Metal backend');
console.error('whisper_backend_init_gpu: failed to initialize Metal backend');
process.exit(0);
`,
  );
  const result = await transcribeWithAcceleration(f.options);
  assert.equal(result.raw, srt);
  assert.equal(result.backend, "cpu");
  assert.equal(result.fallback, "gpu-unavailable");
  assert.match(await f.trace(), /^cpu /m);
});

test("a missing macOS dynamic library in the GPU executable selects CPU", async (t) => {
  const f = await setup(
    t,
    `
console.error('dyld: Library not loaded: @rpath/libggml-metal.dylib');
process.exit(127);
`,
  );
  const result = await transcribeWithAcceleration(f.options);
  assert.equal(result.raw, srt);
  assert.equal(result.backend, "cpu");
  assert.equal(result.fallback, "gpu-unavailable");
  assert.match(await f.trace(), /^cpu /m);
});

test("a successful GPU probe reporting an allocation error is not treated as GPU available", async (t) => {
  const f = await setup(
    t,
    `
console.error('whisper_backend_init_gpu: using CUDA0 backend');
console.error('CUDA error: allocation failed');
process.exit(0);
`,
  );
  const result = await transcribeWithAcceleration(f.options);
  assert.equal(result.backend, "cpu");
  assert.equal(result.fallback, "gpu-unavailable");
  assert.match(await f.trace(), /^cpu /m);
});

test("a successful transcription reporting a GPU allocation error is retried on CPU", async (t) => {
  const f = await setup(
    t,
    `
console.error('whisper_backend_init_gpu: using CUDA0 backend');
if (args.includes('--duration')) process.exit(0);
console.error('CUDA error: allocation failed');
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt', 'partial');
`,
  );
  const result = await transcribeWithAcceleration(f.options);
  assert.equal(result.raw, srt);
  assert.equal(result.backend, "cpu");
  assert.equal(result.fallback, "gpu-failed");
  assert.match(await f.trace(), /^cpu .*--no-gpu/m);
});

test("transcript text cannot forge the GPU backend signal", async (t) => {
  const f = await setup(
    t,
    `
console.log('whisper_backend_init_gpu: using CUDA0 backend');
console.error('whisper_backend_init_gpu: no GPU found');
process.exit(0);
`,
  );
  const result = await transcribeWithAcceleration(f.options);
  assert.equal(result.backend, "cpu");
  assert.equal(result.fallback, "gpu-unavailable");
  assert.match(await f.trace(), /^cpu /m);
});

test("GPU allocation failure after partial output retries with a clean pipe on CPU", async (t) => {
  const f = await setup(
    t,
    `
console.error('whisper_backend_init_gpu: using CUDA0 backend');
if (args.includes('--duration')) process.exit(0);
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt', 'partial secret output');
console.error('CUDA error: out of memory'); process.exit(1);
`,
  );
  const result = await transcribeWithAcceleration(f.options);
  assert.equal(result.raw, srt);
  assert.equal(result.backend, "cpu");
  assert.equal(result.fallback, "gpu-failed");
  assert.doesNotMatch(result.raw, /partial/);
  assert.match(await f.trace(), /^cpu .*--no-gpu/m);
});

test("GPU allocation failure before opening the output falls back without hanging", async (t) => {
  const f = await setup(
    t,
    `
console.error('whisper_backend_init_gpu: using CUDA0 backend');
if (args.includes('--duration')) process.exit(0);
console.error('CUDA error: out of memory'); process.exit(1);
`,
  );
  const result = await transcribeWithAcceleration(f.options);
  assert.equal(result.raw, srt);
  assert.equal(result.backend, "cpu");
  assert.equal(result.fallback, "gpu-failed");
  assert.match(await f.trace(), /^cpu .*--no-gpu/m);
});

test("ordinary model errors and shared deadline are not retried", async (t) => {
  for (const body of [
    `console.error('invalid model'); process.exit(1);`,
    `await new Promise(r => setTimeout(r, 5000));`,
  ]) {
    const f = await setup(t, body);
    f.options.signal = AbortSignal.timeout(800);
    f.options.timeoutMs = 10000;
    await assert.rejects(transcribeWithAcceleration(f.options), (err) =>
      ["SOURCE_UNSUPPORTED", "TIMEOUT"].includes(err.code),
    );
    assert.doesNotMatch(await f.trace(), /^cpu /m);
  }
});

test("a failed transcription with an invalid model, timeout or cancellation never runs CPU", async (t) => {
  const cases = [
    {
      body: `console.error('invalid model'); process.exit(1);`,
      code: "SOURCE_UNSUPPORTED",
    },
    { body: `await new Promise(r => setTimeout(r, 5000));`, code: "TIMEOUT" },
    {
      body: `await new Promise(r => setTimeout(r, 5000));`,
      code: "CANCELLED",
      cancel: true,
    },
  ];
  for (const c of cases) {
    const f = await setup(
      t,
      `
console.error('whisper_backend_init_gpu: using CUDA0 backend');
if (args.includes('--duration')) process.exit(0);
${c.body}
`,
    );
    if (c.cancel) {
      const controller = new AbortController();
      f.options.signal = controller.signal;
      setTimeout(() => controller.abort(), 1000);
    } else if (c.code === "TIMEOUT")
      f.options.signal = AbortSignal.timeout(1000);
    await assert.rejects(
      transcribeWithAcceleration(f.options),
      (err) => err.code === c.code,
    );
    assert.doesNotMatch(await f.trace(), /^cpu /m);
  }
});

test("GPU binary that silently falls back to CPU is reported without retranscribing", async (t) => {
  const f = await setup(
    t,
    `
if (args.includes('--duration')) { console.error('whisper_backend_init_gpu: using CUDA0 backend'); process.exit(0); }
console.error('whisper_backend_init_gpu: no GPU found');
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt', ${JSON.stringify(srt)});
`,
  );
  const result = await transcribeWithAcceleration(f.options);
  assert.equal(result.raw, srt);
  assert.equal(result.backend, "cpu");
  assert.equal(result.fallback, "gpu-unavailable");
  assert.doesNotMatch(await f.trace(), /^cpu /m);
});

test("resource limit failures never trigger CPU retry", async (t) => {
  const f = await setup(
    t,
    `
console.error('whisper_backend_init_gpu: using CUDA0 backend');
if (args.includes('--duration')) process.exit(0);
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt', 'x'.repeat(300000));
`,
  );
  await assert.rejects(
    transcribeWithAcceleration(f.options),
    (err) => err.code === "RESOURCE_LIMIT",
  );
  assert.doesNotMatch(await f.trace(), /^cpu /m);
});

test("without a separate GPU candidate the explicit binary keeps its own automatic backend", async (t) => {
  const f = await setup(t, null);
  f.options.gpuExecutable = undefined;
  const result = await transcribeWithAcceleration(f.options);
  assert.equal(result.raw, srt);
  assert.equal(result.fallback, null);
  assert.doesNotMatch(await f.trace(), /--no-gpu/);
});

test("the real extraction worker carries the GPU candidate and exposes only fixed runtime data", async (t) => {
  const f = await setup(
    t,
    `
if (args.includes('--version')) { console.log('whisper.cpp version: 1.9.5'); process.exit(0); }
console.error('whisper_backend_init_gpu: using CUDA0 backend');
if (args.includes('--duration')) process.exit(0);
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt', '1\\n00:00:00,000 --> 00:00:00,500\\nGPU transcription.\\n');
`,
  );
  const audio = path.join(f.dir, "source.wav"),
    model = path.join(f.dir, "model.bin");
  await promisify(execFile)("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=1",
    audio,
  ]);
  await writeFile(model, "offline test model");
  const result = await extractSource(
    {
      source: { kind: "local", value: audio },
      transcriptFile: null,
      policy: {
        asr: "local",
        maxDownloadBytes: 1024 * 1024,
        extractTimeoutMs: 10000,
        asrTimeoutMs: 60000,
      },
    },
    {
      workDir: f.dir,
      localAsrExecutable: f.cpu,
      localAsrGpuExecutable: f.gpu,
      localAsrModel: model,
      // The version is asserted below: give a loaded test machine 10 s, not 2 s.
      runtimeVersionBudgetMs: 10000,
    },
  );
  assert.equal(result.segments[0].text, "GPU transcription.");
  assert.deepEqual(result.raw.localAsrRuntime, {
    backend: "cuda",
    fallback: null,
  });
  assert.ok(
    !result.extraction.warnings.some((w) => w.code === "ASR_GPU_FALLBACK"),
  );
  assert.equal(result.extraction.providerVersion, "1.9.5");
  assert.doesNotMatch(JSON.stringify(result.raw.localAsrRuntime), /[\\/]/);
});

test("real extraction reports a GPU fallback in evidence without disclosing native logs", async (t) => {
  const f = await setup(
    t,
    `console.error('whisper_backend_init_gpu: no GPU found'); process.exit(0);`,
  );
  const cpu = await fakeTool(
    path.join(f.dir, "cpu-versioned"),
    `
import fs from 'node:fs';
const args=process.argv.slice(2);
if (args.includes('--version')) { console.log('whisper.cpp version: 1.9.5'); process.exit(0); }
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt', ${JSON.stringify(srt)});
`,
  );
  const audio = path.join(f.dir, "fallback.wav"),
    model = path.join(f.dir, "model.bin");
  await promisify(execFile)("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=1",
    audio,
  ]);
  await writeFile(model, "offline test model");
  const result = await extractSource(
    {
      source: { kind: "local", value: audio },
      transcriptFile: null,
      policy: {
        asr: "local",
        maxDownloadBytes: 1024 * 1024,
        extractTimeoutMs: 10000,
        asrTimeoutMs: 10000,
      },
    },
    {
      workDir: f.dir,
      localAsrExecutable: cpu,
      localAsrGpuExecutable: f.gpu,
      localAsrModel: model,
    },
  );
  assert.deepEqual(result.raw.localAsrRuntime, {
    backend: "cpu",
    fallback: "gpu-unavailable",
  });
  const warning = result.extraction.warnings.find(
    (w) => w.code === "ASR_GPU_FALLBACK",
  );
  assert.equal(warning?.severity, "warning");
  assert.match(warning.message, /CPU/);
  assert.doesNotMatch(
    warning.message,
    /no GPU found|fallback\.wav|cpu-versioned/,
  );
});

test("single Metal runtime reports internal initialization failure and CPU fallback", async (t) => {
  const f = await setup(
    t,
    `
console.error('whisper_backend_init_gpu: using Metal backend');
console.error('whisper_backend_init_gpu: failed to initialize Metal backend');
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt', ${JSON.stringify(srt)});
`,
  );
  f.options.cpuExecutable = f.gpu;
  f.options.gpuExecutable = undefined;
  const result = await transcribeWithAcceleration(f.options);
  assert.equal(result.backend, "cpu");
  assert.equal(result.fallback, "gpu-unavailable");
});
