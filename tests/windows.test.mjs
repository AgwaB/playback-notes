import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { extractSource, isolatedEnvironment } from "../lib/ingest.mjs";
import { atomicWrite, containedFile } from "../lib/io.mjs";
import { copyMedia } from "../lib/media-copy.mjs";
import { readAsrOutput } from "../lib/asr-output.mjs";
import { runLocalTool } from "../lib/local-tool.mjs";
import { fakeTool } from "./fake-tool.mjs";
import { WINDOWS_WORK_DIR_MAX, prepare } from "../scripts/prepare.mjs";

const execute = promisify(execFile);

test("a job folder deeper than Windows tools can work in is refused before anything runs", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "긴 작업 ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const media = path.join(root, "source.wav");
  await execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:duration=2", "-c:a", "pcm_s16le", media], { timeout: 15000 });
  const transcript = path.join(root, "source.srt");
  await writeFile(transcript, "1\n00:00:00,000 --> 00:00:02,000\n짧은 문장.\n");
  const request = path.join(root, "request.json");
  await writeFile(request, JSON.stringify({ schemaVersion: 1, source: { kind: "local", value: media },
    transcriptFile: transcript, mode: "briefing", outputLanguage: "ko", policy: { asr: "off" } }));
  const at = (length) => {
    let dir = root;
    while (dir.length < length - 12) dir = path.join(dir, "깊은 폴더");
    return path.join(dir, "j".repeat(length - dir.length - 1));
  };
  const allowed = at(WINDOWS_WORK_DIR_MAX);
  assert.equal(allowed.length, WINDOWS_WORK_DIR_MAX);
  assert.equal((await prepare({ request, "work-dir": allowed })).status, "ok");
  const deeper = at(WINDOWS_WORK_DIR_MAX + 1);
  await assert.rejects(prepare({ request, "work-dir": deeper }), (error) => {
    assert.equal(error.code, "PATH_TOO_LONG");
    assert.equal(error.exitCode, 4);
    assert.match(error.message, /201 characters long; on Windows it can be at most 200/);
    return true;
  });
  await assert.rejects(access(deeper), { code: "ENOENT" }, "nothing is created");
});

test("a stopped extraction reports its own failure while a stopped tool still holds a file", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "held 정리 ")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10 }));
  const media = path.join(root, "source.wav");
  await execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:duration=3", "-c:a", "pcm_s16le", media], { timeout: 15000 });
  const model = path.join(root, "model.bin");
  await writeFile(model, "test model, not inference");
  const running = path.join(root, "running");
  const whisper = await fakeTool(path.join(root, "whisper"), `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('--help')) { console.log('whisper.cpp version 1.9.5'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(running)}, '');
setInterval(() => {}, 1000);
`);
  const work = path.join(root, "work");
  await mkdir(work);
  const until = async (file) => {
    for (let waited = 0; !(await access(file).then(() => true, () => false)); waited += 100) {
      assert.ok(waited < 30000, `${path.basename(file)} did not appear`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const controller = new AbortController();
  const extraction = extractSource(
    {
      source: { kind: "local", value: media },
      transcriptFile: null,
      policy: { asr: "local", visual: "off", extractTimeoutMs: 60000, asrTimeoutMs: 60000 },
    },
    { workDir: work, localAsrExecutable: whisper, localAsrModel: model, signal: controller.signal },
  );
  extraction.catch(() => {});
  await until(running);
  // While transcription runs, a process outside the tool's tree holds its input without
  // delete sharing for a moment, as a stopped native tool that is still shutting down (a
  // GPU runtime releasing its files) or an antivirus scan does.
  const [folder] = (await readdir(work)).filter((name) => name.startsWith("ingest-"));
  const input = path.join(work, folder, "asr-input.wav");
  const held = path.join(root, "held");
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  const holder = spawn("powershell.exe", ["-NoProfile", "-Command",
    `$f=[IO.File]::Open(${quote(input)},'Open','Read','Read'); New-Item -ItemType File ${quote(held)} | Out-Null; Start-Sleep -Milliseconds 2500; $f.Close()`,
  ], { stdio: "ignore" });
  const released = new Promise((resolve) => holder.once("exit", resolve));
  t.after(() => holder.kill());
  await until(held);
  controller.abort();
  await assert.rejects(extraction, { code: "CANCELLED" });
  await released;
  assert.deepEqual(
    (await readdir(work)).filter((name) => name.startsWith("ingest-")),
    [],
    "the folder is removed once the file is released",
  );
});

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

test("a .cmd wrapper configured as a tool is refused with its own cause", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "windows wrapper "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wrapper = path.join(root, "whisper.cmd");
  await writeFile(wrapper, "@echo off\r\nexit /b 0\r\n");
  await assert.rejects(
    runLocalTool(wrapper, ["--help"], { workDir: root, timeoutMs: 10000 }),
    { code: "CAPABILITY_MISSING", detail: "windows-script-wrapper" },
  );
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
