import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fakeTool } from "./fake-tool.mjs";
import { extractSource, ingestionFingerprint } from "../lib/ingest.mjs";
import { parseUserTranscript } from "../lib/ingest-worker.mjs";
import { recheckKoreanSegments } from "../lib/asr-language-recheck.mjs";

function wave(seconds) {
  const pcm = Buffer.alloc(seconds * 32000);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(Math.sin(i / 15) * 1000), i);
  const h = Buffer.alloc(44);
  h.write("RIFF"); h.writeUInt32LE(pcm.length + 36, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
async function setup(t, body, seconds = 6) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "asr-recheck-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const audio = path.join(dir, "audio.wav");
  await writeFile(audio, wave(seconds));
  const model = path.join(dir, "model.bin"); await writeFile(model, "model");
  const executable = await fakeTool(path.join(dir, "whisper"), `
import fs from 'node:fs';
const args=process.argv.slice(2);
if (args.includes('--version')) { console.log('whisper.cpp version: 1.9.5'); process.exit(0); }
console.error('whisper_backend_init_gpu: using CPU backend');
${body}
`);
  const options = { wavPath: audio, modelPath: model, executable, backend: "cpu", workDir: dir,
    timeoutMs: 30000, maxBytes: 1048576, signal: AbortSignal.timeout(30000), parseSrt: (raw) => parseUserTranscript(raw, ".srt") };
  return { dir, audio, model, executable, options };
}
const baseline = "1\n00:00:00,000 --> 00:00:02,000\nDong-ji-tong-yook.\n\n2\n00:00:02,000 --> 00:00:04,000\nI love this show.\n\n3\n00:00:04,000 --> 00:00:06,000\n한국어입니다.\n";

test("explicit ko-en extraction repairs detected Korean with the same runtime, keeps English/times and audits originals", async (t) => {
  const f = await setup(t, `
if (args.includes('--detect-language')) {
  for (const file of args.filter(x => /segment-\\d+\\.wav$/.test(x))) {
    console.error('whisper_full_with_state: auto-detected language: '+(file.includes('segment-0.')?'ko':'en')+' (p = 0.99)');
  }
  process.exit(0);
}
const retry=args.at(-1).includes('segment-');
if (retry && !args.includes('--no-gpu')) process.exit(1);
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt', retry ? '1\\n00:00:00,000 --> 00:00:02,000\\n동시 통역\\n' : ${JSON.stringify(baseline)});
`);
  const request = { source: { kind: "local", value: f.audio }, transcriptFile: null, policy: { asr: "local", visual: "off" } };
  const options = { workDir: path.join(f.dir, "job"), localAsrExecutable: f.executable, localAsrModel: f.model };
  const primary = await extractSource(request, options);
  assert.match(primary.segments[0].text, /Dong/);
  const repaired = await extractSource(request, { ...options, localAsrCodeSwitch: "ko-en" });
  assert.equal(repaired.segments[0].text.trim(), "동시 통역");
  assert.equal(repaired.segments[1].text, primary.segments[1].text);
  assert.deepEqual(repaired.segments.map((s) => [s.startMs, s.endMs]), primary.segments.map((s) => [s.startMs, s.endMs]));
  assert.equal(repaired.raw.localAsr, primary.raw.localAsr);
  assert.equal(repaired.raw.localAsrLanguageRecheck.changes.length, 1);
  assert.equal(repaired.raw.localAsrLanguageRecheck.changes[0].original, "Dong-ji-tong-yook.");
  assert.ok(repaired.extraction.warnings.some((w) => w.code === "ASR_LANGUAGE_RECHECK"));
  assert.notEqual(await ingestionFingerprint(request, options), await ingestionFingerprint(request, { ...options, localAsrCodeSwitch: "ko-en" }));
  await assert.rejects(extractSource(request, { ...options, localAsrCodeSwitch: "guess" }), { code: "INVALID_CONTRACT" });
});

test("low-confidence, mixed-script, numeric-change and out-of-range retries keep the primary segment", async (t) => {
  const f = await setup(t, `
if (args.includes('--detect-language')) {
  for (const file of args.filter(x=>/segment-\\d+\\.wav$/.test(x))) console.error('whisper_full_with_state: auto-detected language: ko (p = '+(file.includes('segment-0.')?'0.89':'0.99')+')');
  process.exit(0);
}
const index=Number(/segment-(\\d+)/.exec(args.at(-1))[1]);
const text=index===1?'한국어 and English':index===2?'숫자가 25입니다':'한국어입니다';
const end=index===3?'00:00:29,980':'00:00:02,000';
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt','1\\n00:00:00,000 --> '+end+'\\n'+text+'\\n');
`, 8);
  const segments = Array.from({ length: 4 }, (_, i) => ({ startMs: i * 2000, endMs: (i + 1) * 2000, text: i === 2 ? "It is 20." : "A primary English phrase.", speaker: null }));
  const result = await recheckKoreanSegments({ ...f.options, segments });
  assert.deepEqual(result.segments, segments);
  assert.equal(result.audit.retried, 3);
  assert.equal(result.audit.changes.length, 0);
  assert.equal((await readdir(f.dir)).some((name) => name.startsWith("asr-recheck-")), false);
});

test("large scans are bounded and distributed through the source; unsupported detection keeps originals", async (t) => {
  const f = await setup(t, `
if (args.includes('--detect-language')) {
  fs.writeFileSync('scanned.json', JSON.stringify(args.filter(x=>/segment-\\d+\\.wav$/.test(x))));
  for (const file of args.filter(x=>/segment-\\d+\\.wav$/.test(x))) console.error('whisper_full_with_state: auto-detected language: en (p = 0.99)');
}
`, 225);
  const segments = Array.from({ length: 150 }, (_, i) => ({ startMs: i * 1500, endMs: (i + 1) * 1500, text: "Some English speech.", speaker: null }));
  const result = await recheckKoreanSegments({ ...f.options, segments });
  assert.equal(result.audit.scanned, 120);
  assert.equal(result.audit.status, "partial");
  const scanned = JSON.parse(await readFile(path.join(f.dir, "scanned.json"), "utf8"));
  assert.match(scanned[0], /segment-0.wav$/);
  assert.match(scanned.at(-1), /segment-149.wav$/);
  const noDetection = await fakeTool(path.join(f.dir, "unsupported"), "console.error('private path must not escape');");
  const failed = await recheckKoreanSegments({ ...f.options, executable: noDetection, segments: segments.slice(0, 1) });
  assert.deepEqual(failed.segments, segments.slice(0, 1));
  assert.equal(failed.audit.failure, "SOURCE_UNSUPPORTED");
  assert.doesNotMatch(JSON.stringify(failed.audit), /private path/);
});

test("automatic retries preserve signed, decimal and percentage notation without guessing numeric transformations", async (t) => {
  const cases = [
    ["It was -20 degrees.", "온도는 20도입니다", false],
    ["It was +20 degrees.", "온도는 20도입니다", false],
    ["It was −20 degrees.", "온도는 20도입니다", false],
    ["It was –20 degrees.", "온도는 20도입니다", false],
    ["It was ＋20 degrees.", "온도는 20도입니다", false],
    ["It was 20-.", "숫자는 20입니다", false],
    ["It was 1.5.", "숫자는 1,5입니다", false],
    ["It was 1,000.", "숫자는 1.000입니다", false],
    ["It was 20%.", "비율은 20입니다", false],
    ["It was %20.", "비율은 20입니다", false],
    ["It was 20.", "비율은 20%입니다", false],
    ["It cost $20.", "가격은 ₩20입니다", false],
    ["It was (20).", "숫자는 20입니다", false],
    ["It was 1/2.", "숫자는 1 2입니다", false],
    ["It was 1e3.", "숫자는 1 3입니다", false],
    ["It was minus 20 degrees.", "온도는 20도입니다", false],
    ["It was 20 percent.", "비율은 20입니다", false],
    ["It was 20 degrees.", "온도는 영하 20도입니다", false],
    ["It was 20.", "비율은 20퍼센트입니다", false],
    ["It was 20.", "숫자는 ２０입니다", false],
    ["It was -20.5%.", "비율은 -20.5%입니다", true],
    ["It was 20.", "숫자는 20입니다.", true],
    ["It cost $1,000.", "가격은 $1,000입니다", true],
    ["It was 1/2.", "비율은 1/2입니다", true],
  ];
  const f = await setup(t, `
if (args.includes('--detect-language')) {
  for (const file of args.filter(x=>/segment-\\d+\\.wav$/.test(x))) console.error('whisper_full_with_state: auto-detected language: ko (p = 0.99)');
  process.exit(0);
}
const index=Number(/segment-(\\d+)/.exec(args.at(-1))[1]);
const candidates=${JSON.stringify(cases.map(([, text]) => text))};
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt','1\\n00:00:00,000 --> 00:00:02,000\\n'+candidates[index]+'\\n');
`, cases.length * 2);
  const segments = cases.map(([text], i) => ({ startMs: i * 2000, endMs: (i + 1) * 2000, text, speaker: null }));
  const result = await recheckKoreanSegments({ ...f.options, segments });
  assert.equal(result.audit.retried, cases.length);
  assert.equal(result.audit.changes.length, cases.filter(([, , accepted]) => accepted).length);
  for (const [i, [original, candidate, accepted]] of cases.entries()) {
    assert.equal(result.segments[i].text, accepted ? candidate : original, original);
    assert.equal(result.audit.decisions[i].outcome, accepted ? "changed" : "rejected", original);
  }
});

test("digital silence is never retried and cancellation does not become a successful repair", async (t) => {
  const f = await setup(t, "throw new Error('must not run');", 2);
  const silent = wave(2); silent.fill(0, 44);
  await writeFile(f.audio, silent);
  const segments = [{ startMs: 0, endMs: 2000, text: "Thank you.", speaker: null }];
  const result = await recheckKoreanSegments({ ...f.options, segments });
  assert.equal(result.audit.scanned, 0);
  assert.equal(result.audit.retried, 0);
  assert.deepEqual(result.segments, segments);
  await assert.rejects(recheckKoreanSegments({ ...f.options, segments, signal: AbortSignal.abort() }), { code: "CANCELLED" });
});
