import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFile,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeTool } from "./fake-tool.mjs";
import { sampleData } from "./helpers.mjs";
import { exists, fileHash, jsonBytes, sha256 } from "../lib/io.mjs";
import { jpegSize } from "../lib/ingest-worker.mjs";
import { isolatedEnvironment } from "../lib/runtime.mjs";
import { prepare } from "../scripts/prepare.mjs";
import { frameAt, parseAt, timeLabel } from "../scripts/frame-at.mjs";

const exec = promisify(execFile);
const script = fileURLToPath(
  new URL("../scripts/frame-at.mjs", import.meta.url),
);
const DURATION_MS = 12000;
let root, video, audio, prepared;

async function ffmpeg(args) {
  await exec(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-nostdin", ...args],
    { env: isolatedEnvironment(root), timeout: 30000, windowsHide: true },
  );
}
// A job as prepare leaves it, without running an extraction: the private manifest binds
// the evidence and the media by hash.
async function job(name, { media = video, mutate } = {}) {
  const work = path.join(root, name);
  await mkdir(work);
  const evidence = sampleData().evidence;
  evidence.source.durationMs = DURATION_MS;
  const bytes = jsonBytes(evidence);
  const manifest = {
    schemaVersion: 1,
    evidenceSha256: sha256(bytes),
    sourceId: evidence.source.id,
    mediaPath: media,
    mediaSha256: media ? await fileHash(media) : null,
  };
  mutate?.(manifest);
  await writeFile(path.join(work, "evidence.json"), bytes);
  await writeFile(path.join(work, "manifest.json"), jsonBytes(manifest));
  await writeFile(
    path.join(work, "analysis-ledger.json"),
    jsonBytes({ schemaVersion: 1, inspectedFrameIds: [] }),
  );
  return work;
}
const PRIVATE = ["evidence.json", "manifest.json", "analysis-ledger.json"];
const hashes = (work) =>
  Promise.all(PRIVATE.map((name) => fileHash(path.join(work, name))));
// The mean colour of an image, to tell which part of the video a frame came from.
async function colour(file) {
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      file,
      "-vf",
      "scale=1:1:flags=area",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    {
      env: isolatedEnvironment(root),
      timeout: 30000,
      windowsHide: true,
      encoding: "buffer",
    },
  );
  return [...stdout.subarray(0, 3)];
}
// The CLI's JSON envelope and exit code, also when it exits non-zero.
async function cli(args) {
  const done = await exec(process.execPath, [script, ...args], {
    timeout: 60000,
    windowsHide: true,
  }).catch((error) => error);
  return { code: done.code ?? 0, response: JSON.parse(done.stdout) };
}

before(async () => {
  // macOS temporary paths begin with /var, a symlink the job writer refuses to follow.
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "frame-at-test-")),
  );
  video = path.join(root, "talk.mp4");
  audio = path.join(root, "talk.wav");
  // Wider than the 1280-pixel limit; red for six seconds, then blue.
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=1600x900:r=2:d=6",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=1600x900:r=2:d=6",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-y",
    video,
  ]);
  await ffmpeg(["-f", "lavfi", "-i", "sine=duration=2", "-y", audio]);
  // One job from the real prepare, so the manifest fields this reads are the ones it writes.
  prepared = path.join(root, "prepared");
  const request = path.join(root, "request.json");
  await writeFile(
    request,
    jsonBytes({
      schemaVersion: 1,
      mode: "briefing",
      outputLanguage: "en",
      source: { kind: "local", value: video },
      policy: { asr: "off", visual: "frames", extractTimeoutMs: 30000 },
    }),
  );
  const response = await prepare(
    { request, "work-dir": prepared },
    { asrPreferencePath: [] },
  );
  assert.equal(response.status, "ok");
});
after(async () => {
  if (root) {
    assert.equal(path.dirname(path.resolve(root)), await realpath(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});

test("--at accepts mm:ss, h:mm:ss and seconds, and refuses anything ambiguous", () => {
  for (const [text, ms] of [
    ["13:01", 781000],
    ["0:07", 7000],
    ["75:30", 4530000],
    ["1:02:03", 3723000],
    ["0:00:19", 19000],
    ["781", 781000],
    ["781.5", 781500],
    ["781.005", 781005],
    ["13:01.25", 781250],
    [" 9 ", 9000],
    ["0", 0],
  ])
    assert.equal(parseAt(text), ms, text);
  for (const text of [
    "",
    "13:1",
    "13:60",
    "1:75:00",
    "1:2:03",
    "-5",
    "1e3",
    "12.3456",
    "1:02:03:04",
    "12s",
    "12,5",
    "https://example.com/v?t=12",
    undefined,
    12,
  ])
    assert.throws(
      () => parseAt(text),
      (error) =>
        error.code === "INVALID_CONTRACT" &&
        error.exitCode === 4 &&
        // The rejected value itself is never repeated in the message.
        !error.message.includes("example.com"),
      String(text),
    );
  assert.equal(timeLabel(781000), "13:01");
  assert.equal(timeLabel(3723005), "1:02:03.005");
  assert.equal(timeLabel(0), "00:00");
});

test("frame-at writes peek JPEGs from the prepared job's verified video and changes nothing else", async () => {
  const entries = await readdir(prepared);
  const privateFiles = await hashes(prepared);
  // Two spellings of one time are one image.
  const response = await frameAt({
    "work-dir": prepared,
    at: ["0:03", "9.5", "0:00:03"],
  });
  assert.equal(response.stage, "frame-at");
  assert.equal(response.status, "ok");
  assert.equal(response.nextAction, "continue");
  assert.deepEqual(
    response.peeks.map((peek) => [peek.at, peek.timestampMs, peek.path]),
    [
      ["00:03", 3000, "peek/peek-3000.jpg"],
      ["00:09.500", 9500, "peek/peek-9500.jpg"],
    ],
  );
  assert.deepEqual(
    response.artifacts.map((a) => [a.format, a.path, a.status]),
    [
      ["jpg", "peek/peek-3000.jpg", "created"],
      ["jpg", "peek/peek-9500.jpg", "created"],
    ],
  );
  for (const [index, peek] of response.peeks.entries()) {
    const bytes = await readFile(path.join(prepared, peek.path));
    assert.equal(sha256(bytes), response.artifacts[index].sha256);
    // Scaled down to the limit, keeping the 16:9 shape.
    assert.deepEqual(jpegSize(bytes), { width: 1280, height: 720 });
    assert.deepEqual([peek.width, peek.height], [1280, 720]);
  }
  // Each image is the video at its own time: red before six seconds, blue after.
  const [red, blue] = await Promise.all(
    response.peeks.map((peek) => colour(path.join(prepared, peek.path))),
  );
  assert.ok(red[0] > 200 && red[2] < 60, `3 s is red: ${red}`);
  assert.ok(blue[2] > 200 && blue[0] < 60, `9.5 s is blue: ${blue}`);
  const [warning] = response.issues;
  assert.equal(response.issues.length, 1);
  assert.equal(warning.code, "PEEK_NOT_EVIDENCE");
  assert.equal(warning.severity, "warning");
  assert.match(warning.message, /NOT evidence/);
  assert.match(warning.message, /spelling/);
  assert.match(warning.message, /never cite/);
  assert.match(warning.message, /never show them as figures/);
  // Evidence, the private manifest and the ledger are untouched; only peek/ was added
  // (no lock or temporary file is left behind).
  assert.deepEqual(await hashes(prepared), privateFiles);
  assert.deepEqual(await readdir(prepared), [...entries, "peek"].sort());
  assert.deepEqual(await readdir(path.join(prepared, "peek")), [
    "peek-3000.jpg",
    "peek-9500.jpg",
  ]);

  // The command line: repeated --at flags, one JSON envelope, exit code 0.
  const run = await cli(["--work-dir", prepared, "--at", "0:03", "--at", "11"]);
  assert.equal(run.code, 0);
  assert.equal(run.response.status, "ok");
  assert.deepEqual(
    run.response.peeks.map((peek) => peek.path),
    ["peek/peek-3000.jpg", "peek/peek-11000.jpg"],
  );
  assert.equal(run.response.issues[0].code, "PEEK_NOT_EVIDENCE");
  assert.deepEqual(await hashes(prepared), privateFiles);
});

test("frame-at takes one to six times per call and keeps at most 24 peek images per job", async () => {
  const work = await job("limits");
  const refused = (at, code) =>
    assert.rejects(frameAt({ "work-dir": work, at }), { code });
  await refused(undefined, "INVALID_CONTRACT");
  await refused([], "INVALID_CONTRACT");
  await refused(["1", "2", "3", "4", "5", "6", "7"], "INVALID_CONTRACT");
  await refused(["1", "soon"], "INVALID_CONTRACT");
  assert.equal(await exists(path.join(work, "peek")), false);
  const tooMany = await cli([
    "--work-dir",
    work,
    ...["1", "2", "3", "4", "5", "6", "7"].flatMap((at) => ["--at", at]),
  ]);
  assert.equal(tooMany.code, 4);
  assert.equal(tooMany.response.status, "error");
  assert.equal(tooMany.response.issues[0].code, "INVALID_CONTRACT");
  assert.match(tooMany.response.issues[0].message, /1 to 6 --at times/);

  const six = await frameAt({
    "work-dir": work,
    at: ["1", "2", "3", "4", "5", "6"],
  });
  assert.equal(six.peeks.length, 6);
  // Seventeen earlier peeks: 23 in all. Files with other names do not count.
  const peek = path.join(work, "peek");
  for (let i = 0; i < 17; i++)
    await writeFile(path.join(peek, `peek-${100000 + i}.jpg`), "earlier");
  await writeFile(path.join(peek, "notes.txt"), "not a peek image");
  const names = await readdir(peek);
  await assert.rejects(frameAt({ "work-dir": work, at: ["7", "8"] }), {
    code: "RESOURCE_LIMIT",
    message: /at most 24 peek images \(23 exist\)/,
  });
  assert.deepEqual(await readdir(peek), names, "nothing written past the cap");
  assert.equal(
    (await frameAt({ "work-dir": work, at: ["7"] })).peeks[0].path,
    "peek/peek-7000.jpg",
  );
  // A time already taken replaces its own file; a new one would be the 25th.
  assert.equal(
    (await frameAt({ "work-dir": work, at: ["0:07", "1"] })).peeks.length,
    2,
  );
  await assert.rejects(frameAt({ "work-dir": work, at: ["8"] }), {
    code: "RESOURCE_LIMIT",
  });
  assert.equal(
    (await readdir(peek)).filter((name) => name.endsWith(".jpg")).length,
    24,
  );
});

test("frame-at names the cause when the job has no local video", async () => {
  const captions = await job("captions-only", { media: null });
  await assert.rejects(frameAt({ "work-dir": captions, at: ["0:03"] }), {
    code: "NO_LOCAL_VIDEO",
    message:
      /no local media file.*captions or a transcript only.*Nothing was downloaded/,
  });
  const audioOnly = await job("audio-only", { media: audio });
  await assert.rejects(frameAt({ "work-dir": audioOnly, at: ["0:01"] }), {
    code: "NO_LOCAL_VIDEO",
    message: /no video stream \(audio only\).*Nothing was downloaded/,
  });
  // A podcast file's cover art is a video stream to ffprobe, but not a frame of the talk.
  const cover = path.join(root, "cover.m4a");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=duration=2",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x180:d=1",
    "-map",
    "0:a",
    "-map",
    "1:v",
    "-c:a",
    "aac",
    "-c:v",
    "mjpeg",
    "-frames:v",
    "1",
    "-disposition:v",
    "attached_pic",
    "-y",
    cover,
  ]);
  const coverArt = await job("cover-art", { media: cover });
  await assert.rejects(frameAt({ "work-dir": coverArt, at: ["0:01"] }), {
    code: "NO_LOCAL_VIDEO",
    message: /audio only/,
  });
  for (const work of [captions, audioOnly, coverArt])
    assert.equal(await exists(path.join(work, "peek")), false);
  const run = await cli(["--work-dir", captions, "--at", "0:03"]);
  assert.equal(run.code, 1);
  assert.equal(run.response.status, "error");
  assert.deepEqual(run.response.artifacts, []);
  assert.equal(run.response.issues[0].code, "NO_LOCAL_VIDEO");
  assert.match(run.response.issues[0].message, /captions or a transcript only/);
});

test("frame-at refuses a time outside the known duration", async () => {
  const work = await job("out-of-range");
  await assert.rejects(frameAt({ "work-dir": work, at: ["0:03", "0:13"] }), {
    code: "INVALID_CONTRACT",
    exitCode: 4,
    message: "--at 00:13 is outside the source's known duration (00:12).",
  });
  await assert.rejects(frameAt({ "work-dir": work, at: ["1:00:00"] }), {
    code: "INVALID_CONTRACT",
  });
  // Inside the duration but after the last frame (2 frames per second end at 11.5 s).
  await assert.rejects(frameAt({ "work-dir": work, at: ["0:12"] }), {
    code: "FRAME_UNAVAILABLE",
    message: /no frame at or after 00:12/,
  });
  // The whole call is refused: the valid time beside a late one writes nothing.
  assert.equal(await exists(path.join(work, "peek")), false);
  assert.equal(
    (await frameAt({ "work-dir": work, at: ["11.5"] })).peeks[0].timestampMs,
    11500,
  );
});

test("frame-at stays inside the job: verified media only, no links, no stray directories", async () => {
  // A peek directory that is a link would put images outside the job.
  const linked = await job("linked");
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(
    outside,
    path.join(linked, "peek"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(frameAt({ "work-dir": linked, at: ["0:03"] }), {
    code: "UNSAFE_PATH",
  });
  assert.deepEqual(await readdir(outside), []);

  // Media edited after preparation is not the verified video any more.
  const edited = path.join(root, "edited.mp4");
  await copyFile(video, edited);
  const changed = await job("changed", { media: edited });
  await appendFile(edited, Buffer.from([0]));
  await assert.rejects(frameAt({ "work-dir": changed, at: ["0:03"] }), {
    code: "EVIDENCE_MISMATCH",
  });
  await rm(edited);
  await assert.rejects(frameAt({ "work-dir": changed, at: ["0:03"] }), {
    code: "EVIDENCE_MISMATCH",
    message: /can no longer be read/,
  });
  // A video beside the recorded one is not picked up in its place: only the recorded
  // path with the recorded hash is read.
  const other = await job("other-hash", {
    mutate: (manifest) => {
      manifest.mediaSha256 = "0".repeat(64);
    },
  });
  await assert.rejects(frameAt({ "work-dir": other, at: ["0:03"] }), {
    code: "EVIDENCE_MISMATCH",
  });
  // Evidence that is not the manifest's evidence is another job's.
  const foreign = await job("foreign");
  await appendFile(path.join(foreign, "evidence.json"), "\n");
  await assert.rejects(frameAt({ "work-dir": foreign, at: ["0:03"] }), {
    code: "EVIDENCE_MISMATCH",
  });
  for (const work of [changed, other, foreign])
    assert.deepEqual((await readdir(work)).sort(), [...PRIVATE].sort());

  // A mistyped job directory is reported, not created.
  const missing = path.join(root, "no-such-job");
  await assert.rejects(frameAt({ "work-dir": missing, at: ["0:03"] }), {
    code: "INVALID_CONTRACT",
    message: /not a prepared job/,
  });
  assert.equal(await exists(missing), false);
  await assert.rejects(frameAt({ at: ["0:03"] }), {
    code: "INVALID_CONTRACT",
    message: "Missing --work-dir.",
  });
});

test("frame-at reads a YouTube job's downloaded frame video at its recorded place and hash only", async () => {
  // What the fake yt-dlp streams: a 360p video-only file, red for six seconds, then blue.
  const stream = path.join(root, "stream.mp4");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=640x360:r=2:d=6",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=640x360:r=2:d=6",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-y",
    stream,
  ]);
  // Every start is logged, to show that only prepare ever ran it.
  const runs = path.join(root, "yt-dlp-runs.txt");
  const ytDlp = await fakeTool(
    path.join(root, "yt-dlp"),
    `import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(runs)}, "run\\n");\nprocess.stdout.write(readFileSync(${JSON.stringify(stream)}));\n`,
  );
  const srt = path.join(root, "talk.srt");
  await writeFile(srt, "1\n00:00:00,500 --> 00:00:01,500\nA spoken line.\n");
  const request = path.join(root, "youtube-request.json");
  await writeFile(
    request,
    jsonBytes({
      schemaVersion: 1,
      mode: "briefing",
      outputLanguage: "en",
      source: {
        kind: "url",
        value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
      transcriptFile: srt,
      policy: { asr: "off", visual: "frames", extractTimeoutMs: 30000 },
    }),
  );
  const work = path.join(root, "youtube");
  const options = {
    request,
    "work-dir": work,
    "yt-dlp-executable": ytDlp,
    "ocr-sample-seconds": 2,
  };
  const response = await prepare(options, { asrPreferencePath: [] });
  assert.equal(response.status, "ok");
  assert.ok(
    response.issues.some((w) => w.code === "PLATFORM_VIDEO_DOWNLOADED"),
  );
  // The download is not the player's media; it is recorded on its own, relative to the job.
  const manifestFile = path.join(work, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assert.equal(manifest.mediaPath, null);
  assert.equal(manifest.mediaSha256, null);
  assert.match(manifest.frameVideoPath, /^ingest-[A-Za-z0-9]{6}\/video\.bin$/);
  assert.equal(manifest.frameVideoSha256, await fileHash(stream));
  assert.equal(
    await fileHash(path.join(work, manifest.frameVideoPath)),
    manifest.frameVideoSha256,
  );
  // Every file of the job with its hash, peek images aside.
  const tree = async (directory) => {
    const files = {};
    for (const entry of await readdir(directory, {
      recursive: true,
      withFileTypes: true,
    })) {
      const file = path.join(entry.parentPath, entry.name);
      const relative = path.relative(directory, file);
      if (entry.isFile() && relative.split(path.sep)[0] !== "peek")
        files[relative] = await fileHash(file);
    }
    return files;
  };
  const before = await tree(work);
  const outside = (await readdir(root)).sort();

  const taken = await frameAt({ "work-dir": work, at: ["0:03", "9.5"] });
  assert.equal(taken.status, "ok");
  assert.deepEqual(
    taken.peeks.map((peek) => [peek.path, peek.width, peek.height]),
    [
      ["peek/peek-3000.jpg", 640, 360],
      ["peek/peek-9500.jpg", 640, 360],
    ],
  );
  const [red, blue] = await Promise.all(
    taken.peeks.map((peek) => colour(path.join(work, peek.path))),
  );
  assert.ok(red[0] > 200 && red[2] < 60, `3 s is red: ${red}`);
  assert.ok(blue[2] > 200 && blue[0] < 60, `9.5 s is blue: ${blue}`);
  assert.equal(taken.issues[0].code, "PEEK_NOT_EVIDENCE");
  // Only peek/ was added: evidence, manifest, ledger, frames and the download are as
  // they were, nothing appeared beside the job, and yt-dlp did not run again.
  assert.deepEqual(await tree(work), before);
  assert.deepEqual(await readdir(path.join(work, "peek")), [
    "peek-3000.jpg",
    "peek-9500.jpg",
  ]);
  assert.deepEqual((await readdir(root)).sort(), outside);
  assert.equal(await readFile(runs, "utf8"), "run\n");

  // A second prepare reuses the evidence: the manifest and the kept download still agree.
  const again = await prepare(options, { asrPreferencePath: [] });
  assert.equal(again.artifacts[0].status, "reused");
  assert.equal(await readFile(runs, "utf8"), "run\n");
  assert.equal((await tree(work))["manifest.json"], before["manifest.json"]);
  assert.equal(
    (await frameAt({ "work-dir": work, at: ["0:03"] })).peeks[0].path,
    "peek/peek-3000.jpg",
  );

  // Copies of the job, each with one thing changed. The path is relative, so a copy is a job.
  let copies = 0;
  const variant = async (mutate) => {
    const copy = path.join(root, `youtube-${++copies}`);
    await cp(work, copy, { recursive: true });
    await rm(path.join(copy, "peek"), { recursive: true });
    const changed = structuredClone(manifest);
    await mutate?.(changed, path.join(copy, manifest.frameVideoPath));
    await writeFile(path.join(copy, "manifest.json"), jsonBytes(changed));
    return copy;
  };
  const refused = async (copy, expected) => {
    await assert.rejects(frameAt({ "work-dir": copy, at: ["0:03"] }), expected);
    assert.equal(await exists(path.join(copy, "peek")), false);
  };
  await refused(
    await variant((_, file) => appendFile(file, Buffer.from([0]))),
    { code: "EVIDENCE_MISMATCH" },
  );
  await refused(await variant((_, file) => rm(file)), {
    code: "EVIDENCE_MISMATCH",
    message: /can no longer be read/,
  });
  // The same bytes reached through a linked folder are outside the job, and so is a
  // recorded path that leaves it.
  await refused(
    await variant(async (_, file) => {
      const elsewhere = path.join(root, "elsewhere");
      await mkdir(elsewhere);
      await copyFile(stream, path.join(elsewhere, "video.bin"));
      await rm(path.dirname(file), { recursive: true });
      await symlink(
        elsewhere,
        path.dirname(file),
        process.platform === "win32" ? "junction" : "dir",
      );
    }),
    { code: "UNSAFE_PATH" },
  );
  await refused(
    await variant((changed) => {
      changed.frameVideoPath = "../stream.mp4";
    }),
    { code: "UNSAFE_PATH" },
  );
  // A job prepared before the hash was recorded: the file is there, but unverifiable.
  const older = await variant((changed) => {
    delete changed.frameVideoPath;
    delete changed.frameVideoSha256;
  });
  await refused(older, {
    code: "NO_LOCAL_VIDEO",
    message: /hash was not recorded.*Nothing was downloaded/,
  });
  const run = await cli(["--work-dir", older, "--at", "0:03"]);
  assert.equal(run.code, 1);
  assert.equal(run.response.issues[0].code, "NO_LOCAL_VIDEO");
  // Audio downloaded for transcription is the job's media; the frame video is still the
  // only video. A real local video, when the job has one, comes first.
  const withAudio = await variant(async (changed) => {
    changed.mediaPath = audio;
    changed.mediaSha256 = await fileHash(audio);
  });
  assert.equal(
    (await frameAt({ "work-dir": withAudio, at: ["0:03"] })).peeks[0].width,
    640,
  );
  const withVideo = await variant(async (changed) => {
    changed.mediaPath = video;
    changed.mediaSha256 = await fileHash(video);
  });
  assert.equal(
    (await frameAt({ "work-dir": withVideo, at: ["0:03"] })).peeks[0].width,
    1280,
  );
});
