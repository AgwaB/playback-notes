import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractSource, isolatedEnvironment } from "../lib/ingest.mjs";

const exec = promisify(execFile);
let root, digits, cuts, builds;
const box = (x, y, w, h, enabled = "") =>
  `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black:t=fill${enabled}`;
const zero = (x, enabled = "") => [
  box(x, 78, 12, 2, enabled),
  box(x, 96, 12, 2, enabled),
  box(x, 78, 2, 20, enabled),
  box(x + 10, 78, 2, 20, enabled),
];
async function encode(filename, duration, filter) {
  await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      `color=c=white:s=320x180:r=2:d=${duration}`,
      "-vf",
      filter,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "12",
      "-pix_fmt",
      "yuv420p",
      "-y",
      filename,
    ],
    { env: isolatedEnvironment(root), timeout: 30000, windowsHide: true },
  );
}
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "frame-sampling-test-"));
  digits = path.join(root, "decimal.mp4");
  cuts = path.join(root, "early-cuts.mp4");
  builds = path.join(root, "gradual-builds.mp4");
  // A seven-segment 0.5 gains one zero for two seconds, changing only 0.2% of pixels.
  const brief = ":enable='gte(t,16)*lt(t,18)'";
  await encode(
    digits,
    120,
    [
      ...zero(116),
      box(132, 96, 2, 2),
      box(154, 78, 12, 2),
      box(154, 87, 12, 2),
      box(154, 96, 12, 2),
      box(154, 78, 2, 10),
      box(164, 87, 2, 11),
      ...zero(138, brief),
    ].join(","),
  );
  await encode(
    cuts,
    48,
    "geq=lum='if(lt(T,12),if(mod(floor(N/2),2),16,235),235)':cb=128:cr=128",
  );
  await encode(
    builds,
    20,
    Array.from({ length: 4 }, (_, i) =>
      box(40, 30 + i * 25, 80, 2, `:enable='gte(t,${(i + 1) * 4})'`),
    ).join(","),
  );
});
after(async () => {
  if (root) {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
async function sample(filename, label, options = {}) {
  return extractSource(
    {
      source: { kind: "local", value: filename },
      policy: { asr: "off", visual: "frames", extractTimeoutMs: 30000 },
    },
    { workDir: path.join(root, label), ...options },
  );
}
const critical = (result) =>
  result.frames.filter(
    (frame) => frame.timestampMs >= 16000 && frame.timestampMs < 18000,
  );
const warning = (result, code) =>
  result.extraction.warnings.some((entry) => entry.code === code);
async function darkPixels(filename, at = null) {
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      ...(at === null ? [] : ["-ss", String(at)]),
      "-i",
      filename,
      "-vf",
      "crop=12:20:138:78,format=gray",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    {
      encoding: "buffer",
      env: isolatedEnvironment(root),
      timeout: 10000,
      windowsHide: true,
    },
  );
  assert.equal(
    stdout.length,
    240,
    "the transient digit region decodes completely",
  );
  return [...stdout].filter((value) => value < 80).length;
}

test("default short-video sampling retains a brief low-area decimal change", async (t) => {
  assert.equal(await darkPixels(digits, 0), 0);
  assert.ok(
    (await darkPixels(digits, 17)) > 60,
    "encoded source contains the added zero",
  );
  const coarse = await sample(digits, "coarse", { ocrSampleSeconds: 20 });
  const scene = await sample(digits, "scene", { ocrSceneThreshold: 0.02 });
  const dense = await sample(digits, "dense", { ocrSampleSeconds: 2 });
  const result = await sample(digits, "default");
  t.diagnostic(
    JSON.stringify({
      coarse: coarse.frames.map((frame) => frame.timestampMs),
      scene: scene.frames.map((frame) => frame.timestampMs),
      denseCritical: critical(dense).map((frame) => frame.timestampMs),
      defaultCritical: critical(result).map((frame) => frame.timestampMs),
      defaultCount: result.frames.length,
    }),
  );
  assert.equal(
    critical(coarse).length,
    0,
    "20-second intervals miss the brief change",
  );
  assert.equal(
    critical(scene).length,
    0,
    "even the lowest scene threshold misses it",
  );
  assert.ok(
    critical(dense).length > 0,
    "dense intervals isolate the sampling cause",
  );
  assert.ok(
    critical(result).length > 0,
    `No default candidate contains the brief decimal change: ${result.frames.map((f) => f.timestampMs)}`,
  );
  for (const frame of critical(result)) {
    assert.ok(
      (await darkPixels(path.join(result.assetRoot, frame.assetPath))) > 60,
      "the selected JPEG contains the extra zero, not just a matching timestamp",
    );
  }
  assert.ok(result.frames.length <= 120);
  assert.ok(
    result.frames.at(-1).timestampMs >= 118000,
    "late frames remain represented",
  );
  assert.equal(result.raw.visualOcr.coverage.cutsDropped, false);
  assert.equal(warning(result, "FRAMES_TRUNCATED"), false);
});

test("gradual low-area builds retain every sampled state and are never discarded by similarity hints", async (t) => {
  const result = await sample(builds, "builds", { ocrSampleSeconds: 2 });
  const states = [];
  for (const frame of result.frames) {
    const { stdout } = await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-i",
        path.join(result.assetRoot, frame.assetPath),
        "-vf",
        "format=gray",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      {
        encoding: "buffer",
        env: isolatedEnvironment(root),
        timeout: 10000,
        windowsHide: true,
      },
    );
    const dark = [...stdout].filter((value) => value < 80).length;
    states.push(Math.round(dark / 160));
  }
  assert.equal(result.frames.length, 10, "all two-second samples retained");
  assert.deepEqual(
    states,
    [0, 0, 1, 1, 2, 2, 3, 3, 4, 4],
    "JPEG content preserves every incremental build",
  );
  const runs = result.raw.visualOcr.contactSheet.lookAlikeRuns;
  assert.ok(
    runs.some((run) => run.kind === "builds"),
    "cumulative drift cannot remain near-identical",
  );
  t.diagnostic(JSON.stringify({ states, runs }));
});

test("a small default frame budget drops excess early cuts and still reaches late footage", async (t) => {
  const result = await sample(cuts, "cut-cap", { ocrMaxFrames: 6 });
  t.diagnostic(
    JSON.stringify({
      times: result.frames.map((f) => f.timestampMs),
      coverage: result.raw.visualOcr.coverage,
    }),
  );
  assert.ok(result.frames.length <= 6, "the supplied cap is enforced");
  assert.equal(result.frames[0].timestampMs, 0);
  assert.ok(
    result.frames.at(-1).timestampMs >= 40000,
    "early cuts cannot consume late slots",
  );
  assert.equal(result.raw.visualOcr.coverage.cutsDropped, true);
  assert.equal(result.raw.visualOcr.coverage.complete, true);
  assert.equal(warning(result, "FRAMES_CUTS_DROPPED"), true);
  assert.equal(warning(result, "FRAMES_TRUNCATED"), false);
});

test("an explicit dense interval that exhausts the cap discloses missing late footage", async (t) => {
  const result = await sample(digits, "explicit-cap", {
    ocrSampleSeconds: 1,
    ocrMaxFrames: 6,
  });
  t.diagnostic(
    JSON.stringify({
      times: result.frames.map((f) => f.timestampMs),
      coverage: result.raw.visualOcr.coverage,
    }),
  );
  assert.equal(result.frames.length, 6);
  assert.equal(result.frames.at(-1).timestampMs, 5000);
  assert.equal(result.raw.visualOcr.coverage.capReached, true);
  assert.equal(result.raw.visualOcr.coverage.complete, false);
  assert.equal(warning(result, "FRAMES_TRUNCATED"), true);
});
