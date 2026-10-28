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
