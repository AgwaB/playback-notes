import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  audioActivity,
  loneSignOffs,
  untranscribedSound,
} from "../lib/asr-coverage.mjs";
import { fillUntranscribedGaps, retryRanges } from "../lib/asr-gap-fill.mjs";
import { parseUserTranscript } from "../lib/ingest-worker.mjs";
import { fakeTool } from "./fake-tool.mjs";

// 16 kHz mono s16le, written like FFmpeg to a pipe: a LIST chunk and no final data size.
function pipeWav(parts) {
  const pcm = Buffer.concat(
    parts.map(([seconds, amplitude]) => {
      const samples = Math.round(seconds * 16000);
      const buffer = Buffer.alloc(samples * 2);
      for (let i = 0; i < samples; i++)
        buffer.writeInt16LE(
          Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 440 * i) / 16000)),
          i * 2,
        );
      return buffer;
    }),
  );
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(16000, 12);
  fmt.writeUInt32LE(32000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const list = Buffer.concat([Buffer.from("LIST"), Buffer.from([6, 0, 0, 0]), Buffer.from("INFOab")]);
  const head = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from("WAVE"), fmt, list]);
  return Buffer.concat([head, Buffer.from("data"), Buffer.from([0xff, 0xff, 0xff, 0xff]), pcm]);
}

test("sound flags follow the decoded WAV in 100 ms frames, including a pipe-written header", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "asr-coverage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "asr-input.wav");
  await writeFile(file, pipeWav([[1, 0], [2, 0.3], [1, 0.002]]));
  const { active, samples } = await audioActivity(file);
  assert.equal(samples, 64000);
  assert.equal(active.length, 40);
  assert.deepEqual([...active.slice(0, 10)], Array(10).fill(0), "digital silence");
  assert.deepEqual([...active.slice(10, 30)], Array(20).fill(1), "a -10 dBFS tone");
  assert.deepEqual([...active.slice(30)], Array(10).fill(0), "-54 dBFS stays below the sound level");
  await writeFile(file, "not a wav");
  assert.equal(await audioActivity(file), null);
});

test("untranscribed sound is reported only for long stretches with enough sound", () => {
  const activity = new Uint8Array(400); // 40 s
  activity.fill(1, 0, 60); // 0-6 s speech
  activity.fill(1, 70, 120); // 7-12 s speech nobody transcribed
  activity.fill(1, 130, 200); // 13-20 s speech
  activity.fill(1, 300, 320); // 30-32 s: only 2 s of sound
  const segments = [
    { startMs: 0, endMs: 6000, text: "a" },
    { startMs: 13000, endMs: 20000, text: "b" },
    { startMs: null, endMs: null, text: "untimed text covers nothing" },
  ];
  assert.deepEqual(untranscribedSound(segments, activity), [
    { startMs: 6500, endMs: 12500, soundMs: 5000 },
  ]);
  assert.deepEqual(untranscribedSound(segments, null), []);
  // Ordinary pauses between transcribed segments are not reported.
  assert.deepEqual(
    untranscribedSound(
      [
        { startMs: 0, endMs: 6000, text: "a" },
        { startMs: 6800, endMs: 12000, text: "b" },
        { startMs: 13000, endMs: 20000, text: "c" },
      ],
      activity.slice(0, 200),
    ),
    [],
  );
});

test("a lone sign-off is suspect only when stretched over a long or silent span", () => {
  const activity = new Uint8Array(400).fill(1);
  activity.fill(0, 200, 300); // 20-30 s silence
  const segments = [
    { startMs: 0, endMs: 29980, text: " Thank you." }, // stretched over 30 s
    { startMs: 20500, endMs: 22500, text: "감사합니다." }, // over silence
    { startMs: 31920, endMs: 32340, text: " 감사합니다." }, // a real closing
    { startMs: 33000, endMs: 39000, text: "Thank you for coming today." }, // more than a sign-off
    { startMs: null, endMs: null, text: "Thank you." },
  ];
  assert.deepEqual(loneSignOffs(segments, activity), [0, 1]);
  assert.deepEqual(loneSignOffs(segments, null), [0]);
});

test("retry ranges stay inside the decoded audio and are split into bounded parts", () => {
  assert.deepEqual(retryRanges([{ startMs: 1500, endMs: 7600 }], 7501), [
    { startMs: 1500, endMs: 7501 },
  ]);
  assert.deepEqual(retryRanges([{ startMs: 8000, endMs: 9000 }], 7501), []);
  assert.deepEqual(retryRanges([{ startMs: 0, endMs: 700000 }], 800000), [
    { startMs: 0, endMs: 300000 },
    { startMs: 300000, endMs: 600000 },
    { startMs: 600000, endMs: 700000 },
  ]);
});

// A fake Whisper: the clip's file name decides its answer.
async function gapRun(t, wav, script, gaps, segments, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "asr-gap-fill-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "asr-input.wav");
  await writeFile(file, wav);
  const executable = await fakeTool(
    path.join(dir, "fake-asr"),
    `import fs from 'node:fs';
const args = process.argv.slice(2);
const clip = args.at(-1);
const out = args[args.indexOf('--output-file') + 1] + '.srt';
${script}`,
  );
  const activity = await audioActivity(file);
  return fillUntranscribedGaps({
    segments,
    gaps:
      gaps ??
      untranscribedSound(segments, activity.active, {
        durationMs: Math.floor(activity.samples / 16),
      }),
    wavPath: file,
    modelPath: path.join(dir, "model.bin"),
    executable,
    backend: "cpu",
    workDir: dir,
    timeoutMs: 20000,
    maxBytes: 1 << 20,
    signal: new AbortController().signal,
    parseSrt: (raw) => parseUserTranscript(raw, ".srt"),
    ...options,
  });
}

test("a skipped stretch that runs to the end of the audio is retried", async (t) => {
  // 7.501 s of tone: the last 100 ms frame is short, and the stretch ends with the audio.
  const result = await gapRun(
    t,
    pipeWav([[7.501, 0.3]]),
    "fs.writeFileSync(out, '1\\n00:00:00,200 --> 00:00:01,000\\nTail words.\\n');",
    null,
    [{ startMs: 0, endMs: 1000, text: "Start.", speaker: null }],
  );
  assert.deepEqual(result.audit.retried, [
    { startMs: 1500, endMs: 7501, segments: 1 },
  ]);
  assert.deepEqual(
    result.segments.map((s) => [s.startMs, s.endMs, s.text]),
    [
      [0, 1000, "Start."],
      [1700, 2500, "Tail words."],
    ],
  );
});

test("speech recovered from earlier windows is kept when a later window fails", async (t) => {
  // The whole-stretch pass hears nothing, window 0 hears words, window 1 never answers.
  const result = await gapRun(
    t,
    pipeWav([[24, 0.3]]),
    `if (/-w1\\.wav$/.test(clip)) await new Promise((r) => setTimeout(r, 10000));
fs.writeFileSync(out, /-w0\\.wav$/.test(clip) ? '1\\n00:00:00,500 --> 00:00:02,000\\nRecovered words.\\n' : '');`,
    [{ startMs: 1500, endMs: 24000, soundMs: 22500 }],
    [{ startMs: 0, endMs: 1000, text: "Start.", speaker: null }],
    { timeoutMs: 3000 },
  );
  assert.equal(result.audit.status, "partial");
  assert.equal(result.audit.failure, "TIMEOUT");
  assert.deepEqual(result.audit.retried, [
    { startMs: 1500, endMs: 24000, segments: 1, windows: 2, failure: "TIMEOUT" },
  ]);
  assert.deepEqual(
    result.segments.map((s) => s.text),
    ["Start.", "Recovered words."],
  );
  assert.deepEqual(result.added, [1]);
});
