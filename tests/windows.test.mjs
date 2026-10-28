import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isolatedEnvironment } from "../lib/ingest.mjs";
import { atomicWrite, containedFile } from "../lib/io.mjs";
import { copyMedia } from "../lib/media-copy.mjs";
import { readAsrOutput } from "../lib/asr-output.mjs";
import { runLocalTool } from "../lib/local-tool.mjs";

const execute = promisify(execFile);

test("Windows extraction retains native tool lookup and private temp/profile paths", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "windows café "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = isolatedEnvironment(root);
  assert.equal(env.SystemRoot, process.env.SystemRoot);
  assert.equal(env.TEMP, root);
  assert.equal(env.TMP, root);
  assert.equal(env.USERPROFILE, root);
  assert.ok(env.PATH.split(path.delimiter).length > 1);
  assert.equal(env.NODE_OPTIONS, undefined);
  const { stdout } = await execute("ffmpeg", ["-version"], { env });
  assert.match(stdout, /^ffmpeg version/);
});

test("portable asset paths reject NTFS streams, devices and Windows aliases before IO", async (t) => {
  // This cross-platform test needs a real directory, not macOS's /var alias.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "windows-path-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "input.bin");
  const output = path.join(root, "public");
  await mkdir(output);
  await writeFile(input, "source");
  await writeFile(path.join(output, "manifest.json"), "original");
  for (const relative of [
    "manifest.json:secret", "C:drive-relative", "nested/NUL.txt", "COM1",
    "COM¹.txt", "nested/COM²", "COM³.png", "LPT¹", "LPT².txt", "nested/LPT³.jpg",
    "asset.", "asset ", "nested/../asset", "nested\\asset", "bad\0name",
  ]) {
    await assert.rejects(atomicWrite(output, relative, "hidden"), { code: "UNSAFE_PATH" }, relative);
    await assert.rejects(containedFile(output, relative), { code: "UNSAFE_PATH" }, relative);
    await assert.rejects(copyMedia(input, output, relative, 1024), { code: "UNSAFE_PATH" }, relative);
  }
  assert.equal(await readFile(path.join(output, "manifest.json"), "utf8"), "original");
  await atomicWrite(output, "assets/café frame.txt", "safe");
  assert.equal(await readFile(await containedFile(output, "assets/café frame.txt"), "utf8"), "safe");
});

test("Windows ASR output streams through a private named pipe with a strict byte cap", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "windows-asr-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { workDir: root, timeoutMs: 5000, maxBytes: 1024, signal: AbortSignal.timeout(5000) };
  const emit = (text) => (base, signal) => runLocalTool(process.execPath, [
    "-e", "require('node:fs').writeFileSync(process.argv[1],process.argv[2])", `${base}.srt`, text,
  ], { ...options, signal });
  assert.equal(await readAsrOutput(path.join(root, "output"), options, emit("English 🙂 transcript")), "English 🙂 transcript");
  await assert.rejects(readAsrOutput(path.join(root, "output"), options, emit("x".repeat(2048))), { code: "RESOURCE_LIMIT" });
  await assert.rejects(readAsrOutput(path.join(root, "output"), options, async () => {
    throw Object.assign(new Error("producer failed before opening pipe"), { code: "SOURCE_UNSUPPORTED" });
  }), { code: "SOURCE_UNSUPPORTED" });
  await assert.rejects(readAsrOutput(path.join(root, "output"), {
    ...options, signal: AbortSignal.timeout(100),
  }, async () => {}), { code: "TIMEOUT" });
});
