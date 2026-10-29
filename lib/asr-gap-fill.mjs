import path from "node:path";
import { mkdtemp, open, rm } from "node:fs/promises";
import { readAsrOutput } from "./asr-output.mjs";
import { clipPcm, pcmLayout } from "./asr-language-recheck.mjs";
import { runLocalTool } from "./local-tool.mjs";
import { networkError } from "./network.mjs";

const MAX_GAPS = 24;
const STAGE_MS = 180000;

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
  let input;
  try {
    input = await open(path.resolve(workDir, wavPath), "r");
    const layout = await pcmLayout(input);
    for (const [i, gap] of gaps.slice(0, MAX_GAPS).entries()) {
      if (stageSignal.aborted) {
        audit.status = "partial";
        audit.failure = "TIMEOUT";
        break;
      }
      const file = path.join(dir, `gap-${i}.wav`);
      if (!(await clipPcm(input, layout, gap, file))) continue;
      const raw = await readAsrOutput(
        path.join(dir, `gap-${i}`),
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
      const length = gap.endMs - gap.startMs;
      const kept = found
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
          startMs: gap.startMs + s.startMs,
          endMs: gap.startMs + s.endMs,
          text: s.text,
          speaker: null,
        }));
      audit.retried.push({
        startMs: gap.startMs,
        endMs: gap.endMs,
        segments: kept.length,
      });
      added.push(...kept);
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
