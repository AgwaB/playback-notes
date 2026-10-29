import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  writeFile,
  rm,
  readFile,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fixture, sampleData } from "./helpers.mjs";
import { asrPreferencePaths, preferredGpu, prepare } from "../scripts/prepare.mjs";
import { cacheKey } from "../lib/cache.mjs";
import { loadBundle } from "../lib/validation.mjs";
import { jsonBytes, readJson } from "../lib/io.mjs";
import { fakeTool } from "./fake-tool.mjs";

const execute = promisify(execFile);

test("preflight ignores media tools that only exist in an extra POSIX shell PATH", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const customBin = path.join(f.root, "user-tools"),
    marker = path.join(f.root, "ambient-tool-ran");
  await mkdir(customBin);
  for (const name of ["ffmpeg", "ffprobe"])
    await fakeTool(
      path.join(customBin, name),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran'); console.log('ambient-only media tool');`,
    );
  await execute(
    process.execPath,
    [
      "scripts/prepare.mjs",
      "--request",
      f.args.request,
      "--work-dir",
      f.work,
      "--check",
    ],
    {
      env: { ...process.env, PATH: customBin },
      timeout: 30000,
    },
  );
  await assert.rejects(
    access(marker),
    "preflight must use the extraction tool environment",
  );
  const caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  for (const name of ["ffmpeg", "ffprobe"])
    assert.notEqual(caps[name].version, "ambient-only media tool");
});

test("Windows preflight and actual extraction resolve relative PATH from fresh child directories", {
  skip: process.platform !== "win32",
}, async (t) => {
  const f = await acquisition(t);
  const callerTools = path.join(f.root, "tools"),
    workTools = path.join(f.work, "tools");
  const marker = path.join(f.root, "media-tool-calls.jsonl");
  await Promise.all([mkdir(callerTools), mkdir(workTools)]);
  for (const name of ["ffmpeg", "ffprobe"]) {
    // where.exe prints in the console code page, which garbles non-ASCII install paths
    // (e.g. WinGet under a Korean user profile); search PATH directly instead.
    let executable;
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.join(
        directory.replace(/^"(.*)"$/, "$1"),
        `${name}.exe`,
      );
      if (
        path.isAbsolute(candidate) &&
        (await access(candidate).then(
          () => true,
          () => false,
        ))
      ) {
        executable = candidate;
        break;
      }
    }
    assert.ok(
      executable,
      `real ${name} must be available for the extraction regression`,
    );
    for (const [directory, origin] of [
      [callerTools, "caller"],
      [workTools, "work"],
    ])
      await fakeTool(
        path.join(directory, name),
        `
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({origin:${JSON.stringify(origin)},cwd:process.cwd()})+'\\n');
const result=spawnSync(${JSON.stringify(executable)},process.argv.slice(2),{encoding:'utf8'});
process.stdout.write(result.stdout??'');
process.stderr.write(result.stderr??'');
process.exit(result.status??1);
`,
      );
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
  );
  const args = [
    path.resolve("scripts/prepare.mjs"),
    "--request",
    f.args.request,
    "--work-dir",
    f.work,
  ];
  await execute(process.execPath, [...args, "--check"], {
    cwd: f.root,
    env: { ...env, PATH: "tools" },
    timeout: 30000,
  });
  let caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  for (const name of ["ffmpeg", "ffprobe"])
    assert.deepEqual(caps[name], { status: "unavailable", version: null });
  await assert.rejects(
    execute(process.execPath, args, {
      cwd: f.root,
      env: { ...env, PATH: "tools" },
      timeout: 30000,
    }),
    (error) =>
      error.code === 3 &&
      JSON.parse(error.stdout).issues.some(
        (issue) => issue.code === "CAPABILITY_MISSING",
      ),
  );
  await assert.rejects(
    access(marker),
    "neither preflight nor extraction may resolve tools from the caller or outer job directory",
  );

  const actual = await execute(process.execPath, args, {
    cwd: f.root,
    env: { ...env, PATH: "../tools" },
    timeout: 30000,
  });
  assert.equal(JSON.parse(actual.stdout).status, "ok");
  caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  for (const name of ["ffmpeg", "ffprobe"])
    assert.equal(caps[name].status, "available");
  assert.equal(
    (await readJson(path.join(f.work, "evidence.json"))).data.segments.length,
    3,
  );
  const calls = (await readFile(marker, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    calls.every(
      (call) =>
        call.origin === "work" &&
        path.dirname(call.cwd).toLowerCase() === f.work.toLowerCase(),
    ),
  );
  assert.ok(
    calls.some((call) => path.basename(call.cwd).startsWith("preflight-")),
  );
  assert.ok(
    calls.some((call) => path.basename(call.cwd).startsWith("ingest-")),
  );
  assert.ok(
    (await readdir(f.work)).every((name) => !name.startsWith("preflight-")),
    "temporary probes must be removed",
  );
});

test("preflight rejects directories for supplied runtime files and accepts file aliases", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const directory = path.join(f.root, "browser-directory");
  await mkdir(directory);
  const paths = {
    "local-asr-executable": directory,
    "local-asr-gpu-executable": directory,
    "local-asr-model": directory,
    "browser-executable": directory,
    "tesseract-executable": directory,
    "yt-dlp-executable": directory,
  };
  await prepare({
    request: f.args.request,
    "work-dir": f.work,
    ...paths,
    check: true,
  });
  let caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  for (const name of [
    "localAsrExecutable",
    "localAsrGpuExecutable",
    "localAsrModel",
    "pdfBrowser",
    "ocr",
    "ytDlp",
  ])
    assert.equal(caps[name].status, "unavailable", `${name} must be a file`);
  const accepted = [process.execPath];
  if (process.platform !== "win32") {
    const alias = path.join(f.root, "browser-alias");
    await symlink(process.execPath, alias);
    accepted.push(alias);
  }
  for (const browser of accepted) {
    await prepare({
      request: f.args.request,
      "work-dir": f.work,
      "browser-executable": browser,
      check: true,
    });
    caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
    assert.equal(
      caps.pdfBrowser.status,
      "available",
      "explicit regular-file aliases remain eligible for the actual browser launch check",
    );
  }
});

async function acquisition(t) {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const work = path.join(f.root, "acquisition");
  await mkdir(work);
  const source = path.join(f.root, "source.wav");
  await execute(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=6",
      source,
    ],
    { timeout: 30000 },
  );
  const transcript = path.join(f.root, "source.srt");
  const lines = sampleData().evidence.segments;
  await writeFile(
    transcript,
    lines
      .map(
        (line, index) =>
          `${index + 1}\n00:00:0${index * 2},000 --> 00:00:0${index * 2 + 2},000\n${line.text}\n`,
      )
      .join("\n"),
  );
  const request = {
    ...f.data.request,
    source: { kind: "local", value: source },
    transcriptFile: transcript,
  };
  const requestPath = path.join(work, "request.json");
  await writeFile(requestPath, jsonBytes(request));
  return {
    ...f,
    request,
    transcript,
    work,
    args: { request: requestPath, "work-dir": work },
  };
}
test("real prepare integration creates normalized evidence, unreviewed ledger and immutable cache", async (t) => {
  const f = await acquisition(t);
  const prepared = await prepare(f.args);
  assert.equal(prepared.status, "ok");
  const evidence = await readJson(path.join(f.work, "evidence.json"));
  assert.equal(evidence.data.segments.length, 3);
  assert.equal(evidence.data.segments[1].startMs, 2000);
  assert.equal(evidence.data.source.mediaType, "audio");
  const ledger = (await readJson(path.join(f.work, "analysis-ledger.json")))
    .data;
  assert.equal(ledger.status, "partial");
  assert.deepEqual(ledger.reviewedChunkIds, []);
  const raw = await readFile(
    path.join(f.work, "chunks", "chunk-00001.json"),
    "utf8",
  );
  assert.ok(raw.includes("UNTRUSTED SOURCE DATA"));
  f.request.mode = "deep-dive";
  f.request.outputLanguage = "en";
  await writeFile(f.args.request, jsonBytes(f.request));
  const cached = await prepare(f.args);
  assert.equal(cached.artifacts[0].status, "reused");
  assert.equal(
    (await readJson(path.join(f.work, "evidence.json"))).sha256,
    evidence.sha256,
  );
  await writeFile(
    f.transcript,
    "1\n00:00:00,000 --> 00:00:01,000\nDifferent evidence\n",
  );
  await assert.rejects(prepare(f.args), { code: "EVIDENCE_MISMATCH" });
  f.request.source = {
    kind: "url",
    value: "https://example.com/different.mp4",
  };
  await writeFile(f.args.request, jsonBytes(f.request));
  await assert.rejects(
    loadBundle({
      ...f.args,
      evidence: path.join(f.work, "evidence.json"),
      analysis: path.join(f.work, "analysis-ledger.json"),
      report: path.join(f.root, "work", "report.json"),
    }),
    { code: "EVIDENCE_MISMATCH" },
  );
});
test("WMA audio (ASF container), listed in the support matrix, is accepted", async (t) => {
  const f = await acquisition(t);
  const wma = path.join(f.root, "source.wma");
  await execute(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      f.request.source.value,
      "-c:a",
      "wmav2",
      wma,
    ],
    { timeout: 30000 },
  );
  f.request.source = { kind: "local", value: wma };
  await writeFile(f.args.request, jsonBytes(f.request));
  // The last cue, made for the original, ends at 6.000 s. FFmpeg 7+ writes an ASF length of
  // 5.999 s (audio decodes to 5.991 s): like a player, keep the cue and end it with the media.
  // FFmpeg 5 writes 6.036 s, so there the cue already fits.
  const prepared = await prepare(f.args);
  assert.equal(prepared.status, "ok");
  const evidence = (await readJson(path.join(f.work, "evidence.json"))).data;
  assert.equal(evidence.source.mediaType, "audio");
  assert.equal(evidence.segments.length, 3);
  const clamped = evidence.source.durationMs < 6000;
  assert.equal(prepared.issues.some((i) => i.code === "TRANSCRIPT_END_CLAMPED"), clamped);
  assert.equal(evidence.segments[2].endMs, clamped ? evidence.source.durationMs : 6000);
  const raw = (await readJson(path.join(f.work, "raw", "extraction.json"))).data;
  if (clamped) assert.equal(raw.transcriptEndClamped.cues[0].endMs, 6000);
});

test("AIFF audio gets an AAC playback copy; cues out of order are sorted; no empty work folder remains", async (t) => {
  const f = await acquisition(t);
  const aiff = path.join(f.root, "source.aiff");
  await execute("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", f.request.source.value, "-c:a", "pcm_s16be", aiff], { timeout: 30000 });
  const srt = (await readFile(f.transcript, "utf8")).split(/\n\n/).filter(Boolean);
  await writeFile(f.transcript, [srt[2], srt[0], srt[1]].join("\n\n") + "\n");
  f.request.source = { kind: "local", value: aiff };
  await writeFile(f.args.request, jsonBytes(f.request));
  const prepared = await prepare(f.args);
  assert.equal(prepared.status, "ok");
  const codes = prepared.issues.map((i) => i.code);
  assert.ok(codes.includes("PLAYBACK_MEDIA_TRANSCODED"));
  assert.ok(codes.includes("TRANSCRIPT_REORDERED"));
  const evidence = (await readJson(path.join(f.work, "evidence.json"))).data;
  assert.deepEqual(evidence.segments.map((s) => s.startMs), [0, 2000, 4000]);
  const manifest = (await readJson(path.join(f.work, "manifest.json"))).data;
  assert.equal(path.basename(manifest.mediaPath), "playback.m4a");
  const probe = await execute("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", manifest.mediaPath]);
  assert.equal(probe.stdout.trim(), "aac");
  // The original WAV needs no copy, and its unused extraction folder is gone.
  f.request.source = { kind: "local", value: path.join(f.root, "source.wav") };
  await writeFile(f.args.request, jsonBytes(f.request));
  const work = path.join(f.root, "wav-job");
  await prepare({ ...f.args, "work-dir": work });
  assert.ok(!(await readdir(work)).some((name) => name.startsWith("ingest-")));
});

test("a new extraction removes extraction folders a killed run left behind", async (t) => {
  const f = await acquisition(t);
  const left = path.join(f.work, "ingest-AbC123");
  await mkdir(path.join(left, "asr-gaps-XyZ789"), { recursive: true });
  await writeFile(path.join(left, "asr-input.wav"), "decoded audio of a killed run");
  const keep = path.join(f.work, "ingest-notes");
  await mkdir(keep);
  // A folder whose owner is still running (a writer that entered through a lock race)
  // is not touched.
  const live = path.join(f.work, "ingest-Live12");
  await mkdir(live);
  await writeFile(path.join(live, ".owner"), String(process.ppid));
  // One whose owner has exited is.
  const gone = path.join(f.work, "ingest-Gone12");
  await mkdir(gone);
  const exited = await execute(process.execPath, ["-e", "console.log(process.pid)"]);
  await writeFile(path.join(gone, ".owner"), exited.stdout.trim());
  const prepared = await prepare(f.args);
  assert.equal(prepared.status, "ok");
  const names = await readdir(f.work);
  assert.ok(!names.includes("ingest-AbC123"));
  assert.ok(!names.includes("ingest-Gone12"));
  assert.ok(names.includes("ingest-Live12"), "a running owner's folder is kept");
  assert.ok(names.includes("ingest-notes"), "only extraction folder names are removed");
  assert.ok(
    !names.some((n) => /^ingest-[A-Za-z0-9]{6}$/.test(n) && !["ingest-Live12"].includes(n)),
    "the new run removed its own folder with its owner file",
  );
});

test("a leftover extraction folder that cannot be removed does not stop a new extraction", {
  skip: process.platform !== "win32",
}, async (t) => {
  const f = await acquisition(t);
  const left = path.join(f.work, "ingest-Busy12");
  await mkdir(left);
  // Windows refuses to delete a file another process holds open without sharing delete.
  const held = path.join(left, "asr-input.wav");
  await writeFile(held, "still open");
  const holder = spawn("powershell.exe", [
    "-NoProfile",
    "-Command",
    `$f=[IO.File]::Open('${held.replace(/'/g, "''")}','Open','Read','Read'); Start-Sleep 20; $f.Close()`,
  ], { stdio: "ignore" });
  const exited = new Promise((resolve) => holder.once("exit", resolve));
  try {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const prepared = await prepare(f.args);
    assert.equal(prepared.status, "ok");
    assert.ok((await readdir(f.work)).includes("ingest-Busy12"), "kept for a later run");
  } finally {
    // Release the file before the fixture's temporary folder is removed.
    holder.kill();
    await exited;
  }
});

test("audio length comes from decoding: a cut-short file is corrected, a header-only one refused", async (t) => {
  const f = await acquisition(t);
  const mp3 = path.join(f.root, "full.mp3");
  await execute("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=20", "-c:a", "libmp3lame", "-b:a", "64k", mp3], { timeout: 30000 });
  const bytes = await readFile(mp3);
  const cut = path.join(f.root, "cut.mp3");
  await writeFile(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
  // The header still says 20 s; only about 10 s decode.
  f.request.source = { kind: "local", value: cut };
  await writeFile(f.args.request, jsonBytes(f.request));
  const prepared = await prepare(f.args);
  assert.equal(prepared.status, "ok");
  assert.ok(prepared.issues.some((i) => i.code === "MEDIA_DURATION_CORRECTED"));
  const evidence = (await readJson(path.join(f.work, "evidence.json"))).data;
  assert.ok(Math.abs(evidence.source.durationMs - 10000) < 600, String(evidence.source.durationMs));
  // A transcript for the whole recording names the cut-short file as the cause.
  await writeFile(
    f.transcript,
    "1\n00:00:00,000 --> 00:00:15,000\nThe whole recording.\n",
  );
  await assert.rejects(prepare({ ...f.args, "work-dir": path.join(f.root, "cut-job") }), {
    code: "INVALID_CONTRACT",
    detail: "transcript-past-decoded-audio",
  });
  // A cut of 0.6 s is under 1 s but over 2 % of 20 s: the decoded length still wins.
  const shaved = path.join(f.root, "shaved.mp3");
  await writeFile(shaved, bytes.subarray(0, Math.floor(bytes.length * 0.97)));
  await writeFile(f.transcript, "1\n00:00:00,000 --> 00:00:19,900\nThe whole recording.\n");
  f.request.source = { kind: "local", value: shaved };
  await writeFile(f.args.request, jsonBytes(f.request));
  await assert.rejects(prepare({ ...f.args, "work-dir": path.join(f.root, "shaved-job") }), {
    code: "INVALID_CONTRACT",
    detail: "transcript-past-decoded-audio",
  });
  await writeFile(f.transcript, "1\n00:00:00,000 --> 00:00:15,000\nThe whole recording.\n");
  // A header with almost no audio behind it cannot carry the transcript either.
  const header = path.join(f.root, "header.mp3");
  await writeFile(header, bytes.subarray(0, 1024));
  f.request.source = { kind: "local", value: header };
  await writeFile(f.args.request, jsonBytes(f.request));
  await assert.rejects(prepare({ ...f.args, "work-dir": path.join(f.root, "header-job") }), {
    code: "INVALID_CONTRACT",
    detail: "transcript-past-decoded-audio",
  });
  // A file whose audio stream decodes to nothing is refused as such.
  const empty = path.join(f.root, "empty.wav");
  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  await writeFile(empty, wav);
  f.request.source = { kind: "local", value: empty };
  await writeFile(f.args.request, jsonBytes(f.request));
  await assert.rejects(prepare({ ...f.args, "work-dir": path.join(f.root, "empty-job") }), {
    code: "SOURCE_UNSUPPORTED",
    detail: "no-decodable-audio",
  });
});
test("cache includes transcript format and explicit ASR executable bytes", async (t) => {
  const f = await acquisition(t);
  const first = await cacheKey(f.request);
  const textPath = path.join(f.root, "source.txt");
  await writeFile(textPath, await readFile(f.transcript));
  assert.notEqual(
    await cacheKey({ ...f.request, transcriptFile: textPath }),
    first,
  );
  f.request.policy.asr = "local";
  f.request.transcriptFile = null;
  const executable = path.join(f.root, "explicit-tool"),
    model = path.join(f.root, "model.bin");
  await writeFile(executable, "version one");
  await writeFile(model, "model");
  const opts = { localAsrExecutable: executable, localAsrModel: model };
  const before = await cacheKey(f.request, opts);
  await writeFile(executable, "version two");
  assert.notEqual(await cacheKey(f.request, opts), before);
  const gpu = path.join(f.root, "gpu-tool");
  const dependency = path.join(f.root, "ggml-cuda.dll");
  const accelerated = { ...opts, localAsrGpuExecutable: gpu };
  const missingGpu = await cacheKey(f.request, accelerated);
  await writeFile(gpu, "gpu version one");
  await writeFile(dependency, "dependency version one");
  const firstGpu = await cacheKey(f.request, accelerated);
  assert.notEqual(
    firstGpu,
    missingGpu,
    "a newly available GPU runtime invalidates cache",
  );
  await writeFile(dependency, "dependency version two");
  assert.notEqual(
    await cacheKey(f.request, accelerated),
    firstGpu,
    "GPU library changes invalidate cache",
  );
  const cpuDependency = path.join(f.root, "ggml-cpu.dll");
  await writeFile(cpuDependency, "CPU dependency one");
  const firstCpu = await cacheKey(f.request, opts);
  await writeFile(cpuDependency, "CPU dependency two");
  assert.notEqual(
    await cacheKey(f.request, opts),
    firstCpu,
    "CPU library changes invalidate cache",
  );
});
test("configured GPU is selected automatically for the matching local ASR preference", async (t) => {
  const f = await acquisition(t);
  const cpu = path.join(f.root, "cpu-exe"),
    model = path.join(f.root, "speech-model"),
    gpu = path.join(f.root, "gpu-exe");
  const preference = path.join(f.root, "preference.json");
  await Promise.all([
    writeFile(cpu, "cpu"),
    writeFile(model, "model"),
    writeFile(gpu, "gpu"),
  ]);
  await Promise.all([chmod(cpu, 0o755), chmod(gpu, 0o755)]);
  await writeFile(
    preference,
    JSON.stringify({
      localAsrExecutable: cpu,
      localAsrModel: model,
      localAsrGpuExecutable: gpu,
    }),
  );
  f.request.policy.asr = "local";
  await writeFile(f.args.request, jsonBytes(f.request));
  const options = {
    ...f.args,
    check: true,
    "local-asr-executable": cpu,
    "local-asr-model": model,
  };
  await prepare(options, { asrPreferencePath: preference });
  let caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  assert.equal(caps.localAsrGpuExecutable.status, "available");
  const other = path.join(f.root, "other-cpu");
  await writeFile(other, "other");
  await prepare(
    { ...options, "local-asr-executable": other },
    { asrPreferencePath: preference },
  );
  caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  assert.equal(
    caps.localAsrGpuExecutable.status,
    "unavailable",
    "unrelated explicit runtime must not inherit the preference",
  );
  const chosen = path.join(f.root, "explicit-gpu");
  await prepare(
    { ...options, "local-asr-gpu-executable": chosen },
    { asrPreferencePath: preference },
  );
  caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  assert.equal(
    caps.localAsrGpuExecutable.status,
    "unavailable",
    "explicit GPU path must override the stored preference",
  );
  await writeFile(preference, "invalid json");
  await prepare(options, { asrPreferencePath: preference });
  caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  assert.equal(
    caps.localAsrGpuExecutable.status,
    "unavailable",
    "invalid optional preferences must not break CPU use",
  );
});

test("prepare passes the stored GPU candidate through to actual transcription", async (t) => {
  const f = await acquisition(t);
  const cpu = await fakeTool(path.join(f.root, "cpu-asr"), "process.exit(2);");
  const gpu = await fakeTool(
    path.join(f.root, "gpu-asr"),
    `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('whisper.cpp version: 1.9.5'); process.exit(0); }
console.error('whisper_backend_init_gpu: using CUDA0 backend');
if (args.includes('--duration')) process.exit(0);
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt', '1\\n00:00:00,000 --> 00:00:01,000\\nGPU transcription.\\n');
`,
  );
  const model = path.join(f.root, "model.bin"),
    preference = path.join(f.root, "preference.json");
  await writeFile(model, "model");
  await writeFile(
    preference,
    JSON.stringify({
      localAsrExecutable: cpu,
      localAsrModel: model,
      localAsrGpuExecutable: gpu,
    }),
  );
  f.request.transcriptFile = null;
  f.request.policy.asr = "local";
  await writeFile(f.args.request, jsonBytes(f.request));
  const result = await prepare(
    { ...f.args, "local-asr-executable": cpu, "local-asr-model": model },
    { asrPreferencePath: preference },
  );
  assert.equal(result.status, "ok");
  const raw = (await readJson(path.join(f.work, "raw", "extraction.json")))
    .data;
  assert.deepEqual(raw.localAsrRuntime, { backend: "cuda", fallback: null });
  assert.equal(
    (await readJson(path.join(f.work, "evidence.json"))).data.segments[0].text,
    "GPU transcription.",
  );
});

async function gapFixture(t, gapCue) {
  const f = await acquisition(t);
  const tracks = path.join(f.root, "two-tracks.mkv");
  await execute(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      f.request.source.value,
      "-i",
      f.request.source.value,
      "-map",
      "0:a",
      "-map",
      "1:a",
      "-c:a",
      "pcm_s16le",
      "-metadata:s:a:0",
      "language=kor",
      "-metadata:s:a:1",
      "language=eng",
      tracks,
    ],
    { timeout: 30000 },
  );
  // The first pass "hears" only the first half second of a six-second tone; a second pass
  // over a skipped stretch (its clip is named gap-N.wav) answers with `gapCue`.
  const cpu = await fakeTool(
    path.join(f.root, "cpu-asr"),
    `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('whisper.cpp version: 1.9.5'); process.exit(0); }
const gap = /gap-\\d+\\.wav$/.test(args.at(-1));
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt', gap ? ${JSON.stringify(gapCue)} : '1\\n00:00:00,000 --> 00:00:00,500\\nHello there.\\n');
`,
  );
  const model = path.join(f.root, "model.bin");
  await writeFile(model, "model");
  f.request.source = { kind: "local", value: tracks };
  f.request.transcriptFile = null;
  f.request.policy.asr = "local";
  await writeFile(f.args.request, jsonBytes(f.request));
  const result = await prepare(
    { ...f.args, "local-asr-executable": cpu, "local-asr-model": model },
    { asrPreferencePath: path.join(f.root, "no-preference.json") },
  );
  assert.equal(result.status, "ok");
  return { f, result };
}

test("an AIFF playback copy is made inside the extraction budget, so a long ASR run does not expire it", async (t) => {
  const f = await acquisition(t);
  const aiff = path.join(f.root, "source.aiff");
  await execute("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", f.request.source.value, "-c:a", "pcm_s16be", aiff], { timeout: 30000 });
  // Transcription outlasts the whole extraction budget but stays inside its own.
  const cpu = await fakeTool(
    path.join(f.root, "slow-asr"),
    `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('whisper.cpp version: 1.9.5'); process.exit(0); }
if (!/gap-/.test(args.at(-1))) await new Promise((r) => setTimeout(r, 7000));
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt', '1\\n00:00:00,000 --> 00:00:05,900\\nA long answer.\\n');
`,
  );
  const model = path.join(f.root, "model.bin");
  await writeFile(model, "model");
  f.request.source = { kind: "local", value: aiff };
  f.request.transcriptFile = null;
  f.request.policy = { ...f.request.policy, asr: "local", extractTimeoutMs: 5000, asrTimeoutMs: 30000 };
  await writeFile(f.args.request, jsonBytes(f.request));
  const result = await prepare(
    { ...f.args, "local-asr-executable": cpu, "local-asr-model": model },
    { asrPreferencePath: path.join(f.root, "no-preference.json") },
  );
  assert.equal(result.status, "ok");
  assert.ok(result.issues.some((i) => i.code === "PLAYBACK_MEDIA_TRANSCODED"));
  const manifest = (await readJson(path.join(f.work, "manifest.json"))).data;
  assert.equal(path.basename(manifest.mediaPath), "playback.m4a");
});

test("local ASR coverage: a stretch the second pass also leaves empty and extra audio tracks are reported", async (t) => {
  const { f, result } = await gapFixture(t, "");
  const issues = Object.fromEntries(result.issues.map((i) => [i.code, i.message]));
  assert.match(issues.ASR_UNTRANSCRIBED_AUDIO, /^1 stretch with sound has no transcript: 00:01–00:06\./);
  assert.match(issues.MULTIPLE_AUDIO_TRACKS, /2 audio tracks \(kor, eng\)/);
  const evidence = (await readJson(path.join(f.work, "evidence.json"))).data;
  assert.deepEqual(evidence.segments.map((s) => s.text), ["Hello there."]);
  const raw = (await readJson(path.join(f.work, "raw", "extraction.json"))).data;
  assert.deepEqual(raw.localAsrCoverage.untranscribed, [
    { startMs: 1000, endMs: 6000, soundMs: 5000 },
  ]);
  assert.deepEqual(raw.localAsrGapFill.retried, [
    { startMs: 1000, endMs: 6000, segments: 0 },
  ]);
});

test("a long skipped stretch the whole-stretch pass leaves empty is retried in 8 s windows", async (t) => {
  const f = await acquisition(t);
  const tone = path.join(f.root, "tone.wav");
  await execute("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=20", "-ac", "1", "-ar", "16000", tone], { timeout: 30000 });
  // First pass: 0.5 s heard. Whole-stretch retry (gap-N.wav): nothing, as over intro music.
  // Window retries (gap-N-wM.wav): one cue each.
  const cpu = await fakeTool(
    path.join(f.root, "cpu-asr"),
    `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('whisper.cpp version: 1.9.5'); process.exit(0); }
const clip = args.at(-1);
const out = /gap-\\d+-w\\d+\\.wav$/.test(clip) ? '1\\n00:00:00,200 --> 00:00:02,000\\nWindow text.\\n'
  : /gap-\\d+\\.wav$/.test(clip) ? '' : '1\\n00:00:00,000 --> 00:00:00,500\\nHello there.\\n';
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt', out);
`,
  );
  const model = path.join(f.root, "model.bin");
  await writeFile(model, "model");
  f.request.source = { kind: "local", value: tone };
  f.request.transcriptFile = null;
  f.request.policy.asr = "local";
  await writeFile(f.args.request, jsonBytes(f.request));
  const result = await prepare(
    { ...f.args, "local-asr-executable": cpu, "local-asr-model": model },
    { asrPreferencePath: path.join(f.root, "no-preference.json") },
  );
  assert.equal(result.status, "ok");
  const evidence = (await readJson(path.join(f.work, "evidence.json"))).data;
  assert.deepEqual(
    evidence.segments.map((s) => [s.startMs, s.endMs, s.text]),
    [
      [0, 500, "Hello there."],
      [1200, 3000, "Window text."],
      [9200, 11000, "Window text."],
      [17200, 19000, "Window text."],
    ],
  );
  const raw = (await readJson(path.join(f.work, "raw", "extraction.json"))).data;
  assert.deepEqual(raw.localAsrGapFill.retried, [
    { startMs: 1000, endMs: 20000, segments: 3, windows: 3 },
  ]);
});

test("a stretch the first pass skipped is transcribed on its own and merged in time order", async (t) => {
  const { f, result } = await gapFixture(
    t,
    "1\n00:00:00,200 --> 00:00:02,000\nSecond pass.\n",
  );
  const issues = Object.fromEntries(result.issues.map((i) => [i.code, i.message]));
  assert.match(issues.ASR_GAPS_RETRANSCRIBED, /^seg-000002 came from a second pass over 1 stretch/);
  assert.equal(issues.ASR_UNTRANSCRIBED_AUDIO, undefined);
  const evidence = (await readJson(path.join(f.work, "evidence.json"))).data;
  assert.deepEqual(
    evidence.segments.map((s) => [s.startMs, s.endMs, s.text]),
    [
      [0, 500, "Hello there."],
      [1200, 3000, "Second pass."],
    ],
  );
  const raw = (await readJson(path.join(f.work, "raw", "extraction.json"))).data;
  assert.deepEqual(raw.localAsrGapFill.added, [1]);
});

test("a failing ASR runtime is reported as the runtime, not as an unsupported source", async (t) => {
  const f = await acquisition(t);
  const cpu = await fakeTool(path.join(f.root, "broken-asr"), "process.exit(3);");
  const model = path.join(f.root, "model.bin");
  await writeFile(model, "not a model");
  f.request.transcriptFile = null;
  f.request.policy.asr = "local";
  await writeFile(f.args.request, jsonBytes(f.request));
  await assert.rejects(
    prepare(
      { ...f.args, "local-asr-executable": cpu, "local-asr-model": model },
      { asrPreferencePath: path.join(f.root, "no-preference.json") },
    ),
    (error) =>
      error.code === "CAPABILITY_MISSING" &&
      error.detail === "asr-runtime-failed" &&
      /the source itself was not rejected/i.test(error.message),
  );
});

test("CLI failures before extraction name their cause without echoing the path", async (t) => {
  const f = await acquisition(t);
  f.request.source = { kind: "local", value: path.join(f.root, "typo.mp3") };
  await writeFile(f.args.request, jsonBytes(f.request));
  const failed = await execute(
    process.execPath,
    ["scripts/prepare.mjs", "--request", f.args.request, "--work-dir", f.work],
    { timeout: 30000 },
  ).catch((error) => error);
  const envelope = JSON.parse(failed.stdout);
  assert.equal(envelope.issues[0].code, "UNSAFE_PATH");
  assert.match(envelope.issues[0].message, /Cause: The path does not exist/);
  assert.ok(!failed.stdout.includes("typo.mp3"));
});

test("CLI default-ASR-off failure asks for user input and does not disclose source paths", async (t) => {
  const f = await acquisition(t);
  f.request.transcriptFile = null;
  await writeFile(f.args.request, jsonBytes(f.request));
  let error;
  try {
    await execute(
      process.execPath,
      [
        "scripts/prepare.mjs",
        "--request",
        f.args.request,
        "--work-dir",
        f.work,
      ],
      { timeout: 30000 },
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  const envelope = JSON.parse(error.stdout);
  assert.equal(error.code, 3);
  assert.equal(envelope.status, "needs-input");
  assert.equal(envelope.nextAction, "ask-user");
  assert.ok(envelope.issues.some((i) => i.code === "ASR_REQUIRED"));
  assert.ok(!error.stdout.includes(f.root));
});

test("the ASR preference falls back to the pre-rename file and the new file takes precedence", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "playback-notes-pref-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".agents"));
  const [current, legacy] = asrPreferencePaths(home);
  assert.equal(path.basename(current), "playback-notes-asr.json");
  assert.equal(path.basename(legacy), "video-summarizer-asr.json");
  const cpu = path.join(home, "cpu"),
    model = path.join(home, "model.bin");
  const options = { "local-asr-executable": cpu, "local-asr-model": model };
  const local = { policy: { asr: "local" } };
  const preference = (gpu) =>
    JSON.stringify({ localAsrExecutable: cpu, localAsrModel: model, localAsrGpuExecutable: gpu });

  assert.equal((await preferredGpu(options, local, [current, legacy]))["local-asr-gpu-executable"], undefined);
  await writeFile(legacy, preference(path.join(home, "legacy-gpu")));
  assert.equal(
    (await preferredGpu(options, local, [current, legacy]))["local-asr-gpu-executable"],
    path.join(home, "legacy-gpu"),
    "a preference saved under the old name keeps working",
  );
  await writeFile(current, preference(path.join(home, "current-gpu")));
  assert.equal(
    (await preferredGpu(options, local, [current, legacy]))["local-asr-gpu-executable"],
    path.join(home, "current-gpu"),
  );
  await writeFile(current, "invalid json");
  assert.equal(
    (await preferredGpu(options, local, [current, legacy]))["local-asr-gpu-executable"],
    undefined,
    "an existing new preference is authoritative even when malformed",
  );
});
