import path from "node:path";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { readAsrOutput } from "./asr-output.mjs";
import { runLocalTool } from "./local-tool.mjs";
import { networkError } from "./network.mjs";

const MAX_SCANS = 120;
const MAX_RETRIES = 24;
const MIN_KOREAN_PROBABILITY = 0.9;
const BYTE_RATE = 32000; // The acquisition adapter supplies mono PCM16 at 16 kHz.

export function validateCodeSwitch(value) {
  if (value != null && value !== "ko-en")
    throw networkError(
      "INVALID_CONTRACT",
      "Local ASR code-switch mode must be ko-en.",
    );
}

async function pcmLayout(file) {
  const size = (await file.stat()).size;
  const header = Buffer.alloc(12);
  await file.read(header, 0, 12, 0);
  if (
    header.toString("ascii", 0, 4) !== "RIFF" ||
    header.toString("ascii", 8, 12) !== "WAVE"
  )
    throw networkError(
      "SOURCE_UNSUPPORTED",
      "Language recheck needs a PCM WAV input.",
    );
  let offset = 12,
    format = false;
  while (offset + 8 <= Math.min(size, 65536)) {
    const chunk = Buffer.alloc(8);
    await file.read(chunk, 0, 8, offset);
    const length = chunk.readUInt32LE(4),
      type = chunk.toString("ascii", 0, 4);
    if (type === "fmt " && length >= 16) {
      const fmt = Buffer.alloc(16);
      await file.read(fmt, 0, 16, offset + 8);
      format =
        fmt.readUInt16LE(0) === 1 &&
        fmt.readUInt16LE(2) === 1 &&
        fmt.readUInt32LE(4) === 16000 &&
        fmt.readUInt16LE(12) === 2 &&
        fmt.readUInt16LE(14) === 16;
    }
    if (type === "data" && format) {
      // FFmpeg stdout WAVs have an unknown data length (0xffffffff).
      return { offset: offset + 8, bytes: Math.min(length, size - offset - 8) };
    }
    offset += 8 + length + (length % 2);
  }
  throw networkError(
    "SOURCE_UNSUPPORTED",
    "Language recheck needs mono PCM16 at 16 kHz.",
  );
}

async function clipPcm(file, layout, segment, target) {
  const start = (segment.startMs * BYTE_RATE) / 1000;
  const length = ((segment.endMs - segment.startMs) * BYTE_RATE) / 1000;
  if (start + length > layout.bytes) return false;
  const pcm = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const next = await file.read(
      pcm,
      read,
      length - read,
      layout.offset + start + read,
    );
    if (!next.bytesRead)
      throw networkError(
        "SOURCE_UNSUPPORTED",
        "The ASR audio changed during language recheck.",
      );
    read += next.bytesRead;
  }
  // Skip only digital silence, never quiet speech or energy/VAD classifications.
  if (!pcm.some((byte) => byte !== 0)) return false;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(BYTE_RATE, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(length, 40);
  await writeFile(target, Buffer.concat([header, pcm]), {
    flag: "wx",
    mode: 0o600,
  });
  return true;
}

function numericNotation(text) {
  // Do not infer numeric equivalence from translated words or unfamiliar digits.
  // A Korean-language retry can otherwise turn "minus 20" into an unsigned 20.
  if (
    [...text].some(
      (character) => /\p{N}/u.test(character) && !/[0-9]/.test(character),
    ) ||
    (/\d/.test(text) &&
      /\b(?:minus|plus|negative|positive|percent(?:age)?|per\s+cent|basis\s+points?)\b/i.test(
        text,
      )) ||
    /(?:마이너스|플러스|영하|영상)\s*[+\-−]?\s*\d|\d\s*(?:퍼센트|프로|퍼밀|베이시스\s*포인트)/u.test(
      text,
    )
  )
    return null;
  // Keep signs, decimal/group separators, exponents, fractions, percentages and
  // currencies verbatim. Only spacing around notation is insignificant; 1.5 and
  // 1,5 (or 20% and 0.2) are deliberately not treated as interchangeable.
  return [
    ...text.matchAll(
      /(?:[\p{Sm}\p{Pd}\p{Sc}%‰‱％(]\s*)*(?:\d+(?:[.,'’]\d+)*|\.\d+)(?:[eE]\s*[+\-−]?\s*\d+)?(?:\s*[\p{Sm}\p{Pd}\p{Sc}%‰‱％/:)])*/gu,
    ),
  ].map(([notation]) => notation.replace(/\s/g, ""));
}

function acceptable(original, candidate) {
  const duration = original.endMs - original.startMs;
  const text = candidate.map((s) => s.text.trim()).join(" ");
  const previousNumbers = numericNotation(original.text),
    nextNumbers = numericNotation(text);
  return candidate.length > 0 &&
    candidate.every(
      (s) =>
        Number.isSafeInteger(s.startMs) &&
        Number.isSafeInteger(s.endMs) &&
        s.startMs >= 0 &&
        s.startMs < s.endMs &&
        s.endMs <= duration,
    ) &&
    text.length <= Math.max(80, duration * 0.03) &&
    (text.match(/[가-힣]/g) ?? []).length >= 4 &&
    !/[A-Za-z]/.test(text) &&
    previousNumbers !== null &&
    nextNumbers !== null &&
    JSON.stringify(nextNumbers) === JSON.stringify(previousNumbers)
    ? text
    : null;
}

/** Opt-in ko/en repair: the same Whisper model rechecks short Latin-only segments. */
export async function recheckKoreanSegments({
  segments,
  wavPath,
  modelPath,
  executable,
  backend,
  workDir,
  timeoutMs,
  maxBytes,
  signal,
  parseSrt,
}) {
  if (signal.aborted)
    throw networkError(
      signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED",
      "Language recheck was interrupted.",
    );
  const revised = segments.map((s) => ({ ...s }));
  const eligible = segments.flatMap((s, index) =>
    Number.isSafeInteger(s.startMs) &&
    Number.isSafeInteger(s.endMs) &&
    s.startMs >= 0 &&
    s.endMs - s.startMs >= 1500 &&
    s.endMs - s.startMs <= 10000 &&
    /[A-Za-z]/.test(s.text) &&
    !/\p{Script=Hangul}/u.test(s.text)
      ? [index]
      : [],
  );
  const selected =
    eligible.length <= MAX_SCANS
      ? eligible
      : Array.from(
          { length: MAX_SCANS },
          (_, i) =>
            eligible[Math.floor((i * (eligible.length - 1)) / (MAX_SCANS - 1))],
        );
  const audit = {
    mode: "ko-en",
    status: eligible.length > MAX_SCANS ? "partial" : "complete",
    eligible: eligible.length,
    scanned: 0,
    retried: 0,
    changes: [],
    decisions: [],
    failure: null,
  };
  if (!eligible.length) return { segments: revised, audit };
  const dir = await mkdtemp(path.join(workDir, "asr-recheck-"));
  const stageSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
  const options = {
    workDir,
    timeoutMs: Math.min(timeoutMs, 120000),
    maxBytes,
    signal: stageSignal,
  };
  const gpuArgs = backend === "cpu" ? ["--no-gpu"] : [];
  let input;
  try {
    input = await open(path.resolve(workDir, wavPath), "r");
    const layout = await pcmLayout(input);
    const clips = [];
    for (const index of selected) {
      if (stageSignal.aborted)
        throw networkError("TIMEOUT", "Language recheck timed out.");
      const file = path.join(dir, `segment-${index}.wav`);
      if (await clipPcm(input, layout, segments[index], file))
        clips.push({ index, file: path.relative(workDir, file) });
    }
    if (!clips.length) return { segments: revised, audit };
    let diagnostic = "";
    await runLocalTool(
      executable,
      [
        "--model",
        modelPath,
        "--language",
        "auto",
        "-mc",
        "0",
        "--detect-language",
        ...gpuArgs,
        ...clips.map((c) => c.file),
      ],
      {
        ...options,
        onStderr: (chunk) => {
          diagnostic += chunk.toString("utf8");
        },
      },
    );
    const detected = [
      ...diagnostic.matchAll(
        /^whisper_full(?:_with_state)?:\s*auto-detected language:\s*(\w+)\s*\(p\s*=\s*([0-9.]+)\)/gm,
      ),
    ].map((m) => ({ language: m[1], probability: Number(m[2]) }));
    if (
      detected.length !== clips.length ||
      detected.some(
        (d) =>
          !Number.isFinite(d.probability) ||
          d.probability < 0 ||
          d.probability > 1,
      )
    )
      throw networkError(
        "SOURCE_UNSUPPORTED",
        "Language detection did not cover the requested segments.",
      );
    audit.scanned = clips.length;
    for (const [i, clip] of clips.entries()) {
      const decision = {
        segmentIndex: clip.index,
        ...detected[i],
        outcome: "retained",
      };
      audit.decisions.push(decision);
      if (
        decision.language !== "ko" ||
        decision.probability < MIN_KOREAN_PROBABILITY
      )
        continue;
      if (audit.retried >= MAX_RETRIES) {
        audit.status = "partial";
        decision.outcome = "limit";
        continue;
      }
      audit.retried++;
      const raw = await readAsrOutput(
        path.join(dir, `retry-${i}`),
        options,
        (base, activeSignal) =>
          runLocalTool(
            executable,
            [
              "--model",
              modelPath,
              "--language",
              "auto",
              "-mc",
              "0",
              ...gpuArgs,
              "--output-srt",
              "--output-file",
              base,
              clip.file,
            ],
            { ...options, signal: activeSignal },
          ),
      );
      let text = null;
      try {
        text = acceptable(segments[clip.index], parseSrt(raw));
      } catch (error) {
        if (!["INVALID_CONTRACT", "NO_USABLE_EVIDENCE"].includes(error.code))
          throw error;
      }
      if (text) {
        // Keep the parent's interval; do not present short-window guesses as better timestamps.
        revised[clip.index].text = text;
        audit.changes.push({
          segmentIndex: clip.index,
          startMs: segments[clip.index].startMs,
          endMs: segments[clip.index].endMs,
          original: segments[clip.index].text,
          replacement: text,
        });
        decision.outcome = "changed";
      } else decision.outcome = "rejected";
    }
  } catch (error) {
    if (signal.aborted)
      throw networkError(
        signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED",
        "Language recheck was interrupted.",
      );
    if (
      ![
        "TIMEOUT",
        "CANCELLED",
        "CAPABILITY_MISSING",
        "SOURCE_UNSUPPORTED",
        "RESOURCE_LIMIT",
        "INVALID_CONTRACT",
        "NO_USABLE_EVIDENCE",
      ].includes(error.code)
    )
      throw error;
    audit.status = "partial";
    audit.failure = error.code;
  } finally {
    await input?.close();
    await rm(dir, { recursive: true, force: true });
  }
  return { segments: revised, audit };
}
