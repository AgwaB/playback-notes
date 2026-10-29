import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

// Coverage checks for local ASR output. They only add warnings: nothing is removed or
// rewritten, because quiet speech, music and real "thank you"s all exist.

export const FRAME_MS = 100;
const FRAME_BYTES = (16000 * 2 * FRAME_MS) / 1000;
// About -45 dBFS RMS: below ordinary speech, above digital silence and most room noise.
export const SOUND_DBFS = -45;
const SOUND_RMS = 32768 * 10 ** (SOUND_DBFS / 20);

function dataOffset(header) {
  if (
    header.length < 12 ||
    header.toString("ascii", 0, 4) !== "RIFF" ||
    header.toString("ascii", 8, 12) !== "WAVE"
  )
    return null;
  let position = 12;
  while (position + 8 <= header.length) {
    const id = header.toString("ascii", position, position + 4);
    const size = header.readUInt32LE(position + 4);
    if (id === "data") return position + 8;
    position += 8 + size + (size & 1);
  }
  return null;
}

function frameHasSound(buffer, start, length) {
  let sum = 0;
  for (let i = start; i < start + length; i += 2) {
    const value = buffer.readInt16LE(i);
    sum += value * value;
  }
  return Math.sqrt(sum / (length / 2)) >= SOUND_RMS ? 1 : 0;
}

/**
 * Per-100 ms sound flags for the 16 kHz mono s16le WAV the ASR adapter feeds to Whisper.
 * The data chunk is read to the end of the file: a WAV written to a pipe has no final size.
 */
export async function audioActivity(wavPath, signal) {
  const handle = await open(wavPath, "r");
  let offset;
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    offset = dataOffset(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
  if (offset === null) return null;
  const frames = [];
  let samples = 0;
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(wavPath, { start: offset, signal })) {
    const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let position = 0;
    for (; position + FRAME_BYTES <= buffer.length; position += FRAME_BYTES)
      frames.push(frameHasSound(buffer, position, FRAME_BYTES));
    samples += position / 2;
    carry = Buffer.from(buffer.subarray(position));
  }
  const tail = carry.length - (carry.length % 2);
  if (tail) {
    frames.push(frameHasSound(carry, 0, tail));
    samples += tail / 2;
  }
  return { active: Uint8Array.from(frames), samples };
}

const timed = (segment) =>
  Number.isFinite(segment?.startMs) &&
  Number.isFinite(segment?.endMs) &&
  segment.endMs > segment.startMs;

// Short sign-offs Whisper emits over silence and music (the English ones top the list in
// Barański et al. 2025); only a segment that consists of nothing else is considered.
const LONE_PHRASES = new Set([
  "thank you",
  "thank you very much",
  "thank you so much",
  "thanks",
  "you",
  "so",
  "bye",
  "okay",
  "oh",
  "감사합니다",
  "고맙습니다",
  "감사합니다 감사합니다",
  "ありがとうございました",
  "ありがとうございます",
  "谢谢",
  "謝謝",
]);
export const normalizePhrase = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

function silentShare(activity, startMs, endMs) {
  const from = Math.max(0, Math.floor(startMs / FRAME_MS));
  const to = Math.min(activity.length, Math.ceil(endMs / FRAME_MS));
  if (to <= from) return 1;
  let sound = 0;
  for (let i = from; i < to; i++) sound += activity[i];
  return 1 - sound / (to - from);
}

/** Indexes of segments that are only a sign-off phrase stretched over a long or silent span. */
export function loneSignOffs(
  segments,
  activity,
  { longMs = 5000, silentShareMin = 0.8 } = {},
) {
  const found = [];
  segments.forEach((segment, index) => {
    if (!timed(segment) || !LONE_PHRASES.has(normalizePhrase(segment.text)))
      return;
    if (
      segment.endMs - segment.startMs >= longMs ||
      (activity?.length &&
        silentShare(activity, segment.startMs, segment.endMs) >= silentShareMin)
    )
      found.push(index);
  });
  return found;
}

/**
 * Stretches with sound that no timed segment covers. ASR timing is approximate, so each
 * segment covers a margin on both sides; short pauses and quiet noise are not reported.
 * `durationMs` (the decoded length) keeps a stretch that reaches the end inside the
 * audio: the last frame is usually shorter than 100 ms.
 */
export function untranscribedSound(
  segments,
  activity,
  {
    minGapMs = 5000,
    minSoundMs = 3000,
    marginMs = 500,
    durationMs = Infinity,
  } = {},
) {
  if (!activity?.length) return [];
  const covered = new Uint8Array(activity.length);
  for (const segment of segments) {
    if (!timed(segment)) continue;
    const from = Math.max(0, Math.floor((segment.startMs - marginMs) / FRAME_MS));
    const to = Math.min(
      activity.length,
      Math.ceil((segment.endMs + marginMs) / FRAME_MS),
    );
    covered.fill(1, from, to);
  }
  const stretches = [];
  let start = null,
    sound = 0;
  for (let i = 0; i <= activity.length; i++) {
    if (i < activity.length && !covered[i]) {
      if (start === null) {
        start = i;
        sound = 0;
      }
      sound += activity[i];
      continue;
    }
    if (start !== null) {
      const startMs = start * FRAME_MS,
        endMs = Math.min(i * FRAME_MS, durationMs);
      const lengthMs = endMs - startMs;
      const soundMs = Math.min(sound * FRAME_MS, lengthMs);
      if (lengthMs >= minGapMs && soundMs >= minSoundMs)
        stretches.push({ startMs, endMs, soundMs });
      start = null;
    }
  }
  return stretches;
}
