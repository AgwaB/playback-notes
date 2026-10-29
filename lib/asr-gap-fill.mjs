import path from "node:path";
import { mkdtemp, open, rm } from "node:fs/promises";
import { readAsrOutput } from "./asr-output.mjs";
import { clipPcm, pcmLayout } from "./asr-language-recheck.mjs";
import { runLocalTool } from "./local-tool.mjs";
import { networkError } from "./network.mjs";

const MAX_GAPS = 24;
const MAX_CLIPS = 64;
const STAGE_MS = 180000;
// A stretch the whole-stretch pass leaves empty is retried in windows of this length, as
// asr-review does: music or a language change at the start of a long clip can keep
// Whisper from transcribing any of it. A short tail is joined to the last window.
const WINDOW_MS = 8000;
const MIN_TAIL_MS = 2000;
// A clip is read into memory whole; longer stretches are retried in parts of this length
// (16 kHz mono PCM16: about 9.6 MB each).
const MAX_RANGE_MS = 300000;
const PCM_BYTES_PER_MS = 32;

/** Stretches cut to the decoded audio and split into parts no longer than MAX_RANGE_MS. */
export function retryRanges(gaps, audioMs) {
  const ranges = [];
  for (const gap of gaps) {
    const endMs = Math.min(gap.endMs, audioMs);
    for (let at = gap.startMs; at < endMs; at += MAX_RANGE_MS)
      ranges.push({ startMs: at, endMs: Math.min(endMs, at + MAX_RANGE_MS) });
  }
  return ranges;
}

export function splitWindows({ startMs, endMs }) {
  const windows = [];
  for (let at = startMs; at < endMs; at += WINDOW_MS) {
    const until = Math.min(endMs, at + WINDOW_MS);
    if (windows.length && until - at < MIN_TAIL_MS) windows.at(-1).endMs = until;
    else windows.push({ startMs: at, endMs: until });
  }
  return windows;
}

/**
 * Second pass over audio the first pass skipped. Whisper decides the language once per
 * 30 s window and can drop a passage in another language; transcribing each skipped
 * stretch on its own lets its language be detected separately, as WhisperX and
 * faster-whisper's multilingual mode transcribe VAD chunks. Only stretches with sound and
 * no transcript are retried, results stay inside their stretch, and nothing is replaced.
 */
export async function fillUntranscribedGaps({
  segments,
  gaps,
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
  const audit = {
    status: gaps.length > MAX_GAPS ? "partial" : "complete",
    gaps: gaps.length,
    retried: [],
    failure: null,
  };
  const added = [];
  if (!gaps.length) return { segments, added: [], audit };
  // Merging needs a timeline; a first pass with untimed cues is left as it is.
  if (segments.some((s) => !Number.isSafeInteger(s.startMs)))
    return {
      segments,
      added: [],
      audit: { ...audit, status: "partial", failure: "untimed-first-pass" },
    };
  const dir = await mkdtemp(path.join(workDir, "asr-gaps-"));
  const stageSignal = AbortSignal.any([signal, AbortSignal.timeout(STAGE_MS)]);
  const options = {
    workDir,
    timeoutMs: Math.min(timeoutMs, STAGE_MS),
    maxBytes,
    signal: stageSignal,
  };
  let input,
    clips = 0;
  // Transcribe one range on its own; segments outside it are dropped.
  const transcribe = async (layout, range, name) => {
    clips++;
    const file = path.join(dir, `${name}.wav`);
    if (!(await clipPcm(input, layout, range, file))) return [];
    const raw = await readAsrOutput(path.join(dir, name), options, (base, activeSignal) =>
      runLocalTool(
        executable,
        [
          "--model",
          modelPath,
          "--language",
          "auto",
          "-mc",
          "0",
          ...(backend === "cpu" ? ["--no-gpu"] : []),
          "--output-srt",
          "--output-file",
          base,
          path.relative(workDir, file),
        ],
        { ...options, signal: activeSignal },
      ),
    );
    let found = [];
    try {
      found = parseSrt(raw);
    } catch (error) {
      if (!["INVALID_CONTRACT", "NO_USABLE_EVIDENCE"].includes(error.code))
        throw error;
    }
    const length = range.endMs - range.startMs;
    return found
      .filter(
        (s) =>
          Number.isSafeInteger(s.startMs) &&
          Number.isSafeInteger(s.endMs) &&
          s.startMs >= 0 &&
          s.startMs < s.endMs &&
          s.endMs <= length &&
          s.text.trim(),
      )
      .map((s) => ({
        startMs: range.startMs + s.startMs,
        endMs: range.startMs + s.endMs,
        text: s.text,
        speaker: null,
      }));
  };
  try {
    input = await open(path.resolve(workDir, wavPath), "r");
    const layout = await pcmLayout(input);
    const ranges = retryRanges(
      gaps.slice(0, MAX_GAPS),
      Math.floor(layout.bytes / PCM_BYTES_PER_MS),
    );
    for (const [i, gap] of ranges.entries()) {
      if (stageSignal.aborted || clips >= MAX_CLIPS) {
        audit.status = "partial";
        audit.failure = stageSignal.aborted ? "TIMEOUT" : "clip-limit";
        break;
      }
      let kept = [],
        windows = 0;
      // What a stretch yielded is kept even when a later window of it fails.
      const record = (failure) => {
        audit.retried.push({
          startMs: gap.startMs,
          endMs: gap.endMs,
          segments: kept.length,
          ...(windows ? { windows } : {}),
          ...(failure ? { failure } : {}),
        });
        added.push(...kept);
      };
      try {
        kept = await transcribe(layout, gap, `gap-${i}`);
        if (!kept.length && gap.endMs - gap.startMs > WINDOW_MS + MIN_TAIL_MS) {
          for (const [w, window] of splitWindows(gap).entries()) {
            if (stageSignal.aborted || clips >= MAX_CLIPS) {
              audit.status = "partial";
              break;
            }
            windows++;
            kept = kept.concat(await transcribe(layout, window, `gap-${i}-w${w}`));
          }
        }
      } catch (error) {
        record(error.code ?? "error");
        throw error;
      }
      record(null);
    }
  } catch (error) {
    if (signal.aborted)
      throw networkError(
        signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED",
        "Gap transcription was interrupted.",
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
  // Merge by start time; the first pass's segments keep their relative order.
  const merged = [
    ...segments.map((segment, order) => ({ segment, order, added: false })),
    ...added.map((segment, order) => ({
      segment,
      order: segments.length + order,
      added: true,
    })),
  ].sort((a, b) => {
    const at = a.segment.startMs ?? Infinity,
      bt = b.segment.startMs ?? Infinity;
    return at === bt ? a.order - b.order : at - bt;
  });
  return {
    segments: merged.map((m) => m.segment),
    added: merged.flatMap((m, index) => (m.added ? [index] : [])),
    audit,
  };
}
