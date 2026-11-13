// A still image at each requested moment of the job's own local video, for the host to
// look at when no sampled frame shows the name or detail it needs to check. The images go
// to `peek/` in the private job directory and are deliberately not evidence: nothing here
// reads the network or changes evidence.json, the private manifest or the ledger.
import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { isMain, optionsFor, required, result, runCli } from "../lib/cli.mjs";
import {
  AppError,
  artifact,
  atomicWrite,
  containedFile,
  exists,
  issue,
  readJson,
  safeDirectory,
  withLock,
} from "../lib/io.mjs";
import { runLocalTool } from "../lib/local-tool.mjs";
import { FORMATS, jpegSize } from "../lib/ingest-worker.mjs";
import { sameFileSnapshot, verifiedMediaSnapshot } from "../lib/server.mjs";

const MAX_TIMES = 6;
// Peeks are for a few spot checks; a job that needs more wants frame sampling in prepare.
const MAX_PEEKS = 24;
const MAX_WIDTH = 1280;
const PEEK_BYTES = 8 * 1024 * 1024;
const TOOL_MS = 60_000;
const PEEK_DIR = "peek";
const PEEK_NAME = /^peek-\d+\.jpg$/;
// With a colon the seconds (and, after hours, the minutes) are two digits below 60, so
// "13:1" or "1:75:00" is refused rather than guessed at.
const CLOCK = /^(?:(\d{1,3}):([0-5]\d)|(\d{1,3})):([0-5]\d)(?:\.(\d{1,3}))?$/;
const SECONDS = /^(\d{1,7})(?:\.(\d{1,3}))?$/;

/** Milliseconds of `mm:ss`, `h:mm:ss` or plain seconds, each with an optional fraction. */
export function parseAt(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const clock = CLOCK.exec(text);
  const plain = clock ? null : SECONDS.exec(text);
  // The raw value is not echoed: a misplaced path or URL must not reach host-visible output.
  if (!clock && !plain)
    throw new AppError(
      "INVALID_CONTRACT",
      "Each --at must be a time as mm:ss, h:mm:ss or seconds (for example 13:01, 1:02:03 or 781.5).",
      4,
    );
  // Digits are combined as integers: 781.005 * 1000 is not exactly 781005 in floating point.
  const [seconds, fraction = ""] = clock
    ? [
        Number(clock[1] ?? 0) * 3600 +
          Number(clock[2] ?? clock[3]) * 60 +
          Number(clock[4]),
        clock[5],
      ]
    : [Number(plain[1]), plain[2]];
  return seconds * 1000 + Number(fraction.padEnd(3, "0"));
}

export function timeLabel(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60);
  const two = (n) => String(n).padStart(2, "0");
  const fraction = ms % 1000 ? `.${String(ms % 1000).padStart(3, "0")}` : "";
  return `${h ? `${h}:${two(m)}` : two(m)}:${two(total % 60)}${fraction}`;
}

// One cause per message, so the host can tell the user why there is no image without
// guessing. A missing peek never blocks the report.
const noVideo = (cause) =>
  new AppError(
    "NO_LOCAL_VIDEO",
    `${cause} Nothing was downloaded; continue without a peek image.`,
  );

// `V` selects video streams that are not attached pictures: the cover art of a podcast file
// is a "video" stream too, and would otherwise be returned as the frame at every time.
async function probeVideo(file, toolOptions) {
  const raw = await runLocalTool(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      FORMATS,
      "-select_streams",
      "V",
      "-show_entries",
      "format=duration:stream=codec_type",
      "-of",
      "json",
      file,
    ],
    toolOptions,
  );
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AppError(
      "SOURCE_UNSUPPORTED",
      "Media metadata could not be read.",
    );
  }
  const seconds = Number(data.format?.duration);
  const durationMs = Math.round(seconds * 1000);
  return {
    video: (data.streams ?? []).some((s) => s.codec_type === "video"),
    durationMs:
      Number.isFinite(seconds) &&
      seconds >= 0 &&
      Number.isSafeInteger(durationMs)
        ? durationMs
        : null,
  };
}

// The first frame at or after the time, through a pipe: ffmpeg is given no output file, and
// the same protocol and format whitelists as acquisition keep it away from the network.
async function frameBytes(file, ms, toolOptions) {
  const chunks = [];
  await runLocalTool(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      FORMATS,
      "-ss",
      `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}`,
      "-i",
      file,
      "-map",
      "0:V:0",
      "-an",
      "-sn",
      "-dn",
      "-frames:v",
      "1",
      "-vf",
      // Never enlarged; the height follows the aspect ratio (even, as JPEG 4:2:0 needs).
      `scale=w='min(${MAX_WIDTH},iw)':h=-2`,
      "-q:v",
      "2",
      "-pix_fmt",
      "yuvj420p",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "pipe:1",
    ],
    {
      ...toolOptions,
      maxBytes: PEEK_BYTES,
      onChunk: (chunk) => void chunks.push(chunk),
    },
  );
  return Buffer.concat(chunks);
}

async function existingPeeks(workDir) {
  const directory = path.join(workDir, PEEK_DIR);
  if (!(await exists(directory))) return [];
  // Refuses a linked `peek`: neither the count nor a later write may leave the job.
  await safeDirectory(directory);
  return (await readdir(directory)).filter((name) => PEEK_NAME.test(name));
}

export async function frameAt(options) {
  required(options, ["work-dir"]);
  const given = options.at ?? [];
  if (!Array.isArray(given) || !given.length || given.length > MAX_TIMES)
    throw new AppError(
      "INVALID_CONTRACT",
      `Pass 1 to ${MAX_TIMES} --at times per call.`,
      4,
    );
  const times = [...new Set(given.map(parseAt))];
  // Checked before locking: the lock would otherwise create a mistyped directory.
  for (const name of ["manifest.json", "evidence.json"])
    if (!(await exists(path.join(options["work-dir"], name))))
      throw new AppError(
        "INVALID_CONTRACT",
        "--work-dir is not a prepared job (manifest.json and evidence.json are required). Run prepare first.",
        4,
      );
  // The job's writer lock: not while prepare is still writing, and the per-job cap holds
  // when two calls run at once.
  return withLock(options["work-dir"], async (workDir) => {
    const manifest = (await readJson(path.join(workDir, "manifest.json"))).data;
    const evidence = await readJson(path.join(workDir, "evidence.json"));
    if (evidence.sha256 !== manifest.evidenceSha256)
      throw new AppError(
        "EVIDENCE_MISMATCH",
        "Evidence differs from this acquisition job.",
      );
    // Only a file prepare recorded, and only while it still has the recorded hash: the
    // job's media, or when that is absent or audio only, the video stream a YouTube job
    // downloaded to sample frames. That one is recorded relative to the job and must be a
    // regular file inside it.
    const recorded = [];
    if (manifest.mediaPath)
      recorded.push({
        locate: () => manifest.mediaPath,
        sha256: manifest.mediaSha256,
      });
    if (manifest.frameVideoPath)
      recorded.push({
        locate: () =>
          containedFile(
            workDir,
            manifest.frameVideoPath,
            Number.MAX_SAFE_INTEGER,
          ),
        sha256: manifest.frameVideoSha256,
      });
    const toolOptions = { workDir, timeoutMs: TOOL_MS };
    let media = null;
    for (const candidate of recorded) {
      let file, snapshot;
      try {
        file = await candidate.locate();
        snapshot = await verifiedMediaSnapshot(file, candidate.sha256);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          "EVIDENCE_MISMATCH",
          "The job's local media can no longer be read at its recorded path.",
        );
      }
      const probed = await probeVideo(file, toolOptions);
      if (probed.video) {
        media = { file, snapshot, durationMs: probed.durationMs };
        break;
      }
    }
    if (!media)
      throw noVideo(
        // A job prepared before the frame video's hash was recorded: the file may still be
        // there, but nothing says it is the one the frames came from.
        !manifest.frameVideoPath &&
          evidence.data?.source?.kind === "youtube" &&
          evidence.data.frames?.length
          ? "This job's frames were sampled from a downloaded video stream whose hash was not recorded (the job was prepared by an earlier version), so that file cannot be verified and is not used."
          : recorded.length
            ? "This job's local media has no video stream (audio only), so there is no frame to take."
            : "This job has no local media file: it was prepared from captions or a transcript only, so there is no video to take a frame from.",
      );
    const known = evidence.data?.source?.durationMs;
    const durationMs = Number.isSafeInteger(known) ? known : media.durationMs;
    const late =
      durationMs === null ? [] : times.filter((ms) => ms > durationMs);
    if (late.length)
      throw new AppError(
        "INVALID_CONTRACT",
        `--at ${late.map(timeLabel).join(", ")} is outside the source's known duration (${timeLabel(durationMs)}).`,
        4,
      );
    const wanted = times.map((ms) => ({
      ms,
      relative: `${PEEK_DIR}/peek-${ms}.jpg`,
    }));
    // A repeated time replaces its own file and does not count twice.
    const existing = await existingPeeks(workDir);
    const total = new Set([
      ...existing,
      ...wanted.map((peek) => path.posix.basename(peek.relative)),
    ]).size;
    if (total > MAX_PEEKS)
      throw new AppError(
        "RESOURCE_LIMIT",
        `A job keeps at most ${MAX_PEEKS} peek images (${existing.length} exist). Delete those no longer needed from ${PEEK_DIR}/ and retry, or sample frames in prepare.`,
      );
    for (const peek of wanted) {
      peek.bytes = await frameBytes(media.file, peek.ms, toolOptions);
      if (!peek.bytes.length)
        throw new AppError(
          "FRAME_UNAVAILABLE",
          `The video has no frame at or after ${timeLabel(peek.ms)}; try a slightly earlier time.`,
        );
      peek.size = jpegSize(peek.bytes);
      if (!peek.size || peek.size.width > MAX_WIDTH)
        throw new AppError(
          "SOURCE_UNSUPPORTED",
          "The extracted frame is not a readable JPEG of the expected size.",
        );
    }
    // The hash was taken before ffmpeg read the file: a file replaced or edited in between
    // would yield frames of something else, so nothing is written unless it is unchanged.
    if (
      !sameFileSnapshot(
        media.snapshot,
        await stat(media.file, { bigint: true }),
      )
    )
      throw new AppError(
        "EVIDENCE_MISMATCH",
        "Media no longer matches the committed snapshot.",
      );
    const artifacts = [],
      peeks = [];
    for (const peek of wanted) {
      await atomicWrite(workDir, peek.relative, peek.bytes);
      artifacts.push(await artifact(workDir, peek.relative, "jpg"));
      peeks.push({
        at: timeLabel(peek.ms),
        timestampMs: peek.ms,
        path: peek.relative,
        width: peek.size.width,
        height: peek.size.height,
      });
    }
    return {
      ...result("frame-at", artifacts, [
        issue(
          "PEEK_NOT_EVIDENCE",
          "Peek images are NOT evidence. Open them only to check a spelling or a detail against the picture; each shows the first video frame at or after its time. They are not in evidence.json: never cite them, never add them to inspectedFrameIds and never show them as figures. A claim still needs a transcript segment or an inspected evidence frame.",
          "warning",
        ),
      ]),
      peeks,
    };
  });
}

if (isMain(import.meta.url))
  await runCli("frame-at", () => frameAt(optionsFor(["work-dir"], [], ["at"])));
