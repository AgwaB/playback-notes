import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractSource } from "../lib/ingest.mjs";
import { fakeTool } from "./fake-tool.mjs";

const exec = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asr-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.wav"), model = path.join(root, "model.bin");
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=1", "-ac", "1", "-ar", "16000", source]);
  await writeFile(model, "fixture model");
  const log = path.join(root, "cpu.log");
  await writeFile(log, "");
  const cpu = await fakeTool(path.join(root, "cpu"), `
import fs from 'node:fs';
const args = process.argv.slice(2);
const metadata = args.includes('--version') || args.includes('--help');
fs.appendFileSync(${JSON.stringify(log)}, (metadata ? args[0] : 'transcribe') + '\\n');
if (metadata) setTimeout(() => {}, 60000);
else fs.writeFileSync(args[args.indexOf('--output-file') + 1] + '.srt', '1\\n00:00:00,100 --> 00:00:00,700\\nSelected transcript.\\n');
`);
  return { root, source, model, cpu, log };
}
const request = (source) => ({ source: { kind: "local", value: source }, policy: { asr: "local", asrTimeoutMs: 8000, extractTimeoutMs: 20000 } });

test("a healthy selected GPU does not probe the unused CPU runtime's hanging metadata", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const gpu = await fakeTool(path.join(f.root, "gpu"), `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('--help')) { console.log('whisper.cpp version: 1.9.5'); process.exit(0); }
console.error('whisper_backend_init_gpu: using CUDA0 backend');
if (!args.includes('--duration')) fs.writeFileSync(args[args.indexOf('--output-file') + 1] + '.srt', '1\\n00:00:00,100 --> 00:00:00,700\\nGPU transcript.\\n');
`);
  const result = await extractSource(request(f.source), { workDir: path.join(f.root, "work"), localAsrExecutable: f.cpu, localAsrGpuExecutable: gpu, localAsrModel: f.model });
  assert.equal(result.segments[0].text, "GPU transcript.");
  assert.equal(await readFile(f.log, "utf8"), "", "unused CPU executable was never launched");
});

for (const stream of [1, 2]) test(`optional metadata overflow on stream ${stream} keeps usable transcription with unknown provenance`, { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const noisy = await fakeTool(path.join(f.root, "verbose"), `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('--help')) fs.writeSync(${stream}, 'x'.repeat(65537));
else fs.writeFileSync(args[args.indexOf('--output-file') + 1] + '.srt', '1\\n00:00:00,100 --> 00:00:00,700\\nKept after metadata overflow.\\n');
`);
  const result = await extractSource(request(f.source), { workDir: path.join(f.root, "work"), localAsrExecutable: noisy, localAsrModel: f.model });
  assert.equal(result.segments[0].text, "Kept after metadata overflow.");
  assert.equal(result.extraction.providerVersion, "unknown");
});

test("selected runtime's hanging provenance is bounded and cannot consume the inference budget", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const result = await extractSource(request(f.source), { workDir: path.join(f.root, "work"), localAsrExecutable: f.cpu, localAsrModel: f.model });
  assert.equal(result.segments[0].text, "Selected transcript.");
  assert.equal(result.extraction.providerVersion, "unknown");
  assert.deepEqual((await readFile(f.log, "utf8")).trim().split("\n"), ["--version", "transcribe"]);
});
