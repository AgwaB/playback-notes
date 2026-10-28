import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, mkdir, readdir, writeFile, rm, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { fixture, sampleData } from "./helpers.mjs";
import { prepare } from "../scripts/prepare.mjs";
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
  const customBin = path.join(f.root, "user-tools"), marker = path.join(f.root, "ambient-tool-ran");
  await mkdir(customBin);
  for (const name of ["ffmpeg", "ffprobe"])
    await fakeTool(path.join(customBin, name), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran'); console.log('ambient-only media tool');`);
  await execute(process.execPath, ["scripts/prepare.mjs", "--request", f.args.request,
    "--work-dir", f.work, "--check"], {
    env: { ...process.env, PATH: customBin }, timeout: 30000,
  });
  await assert.rejects(access(marker), "preflight must use the extraction tool environment");
  const caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  for (const name of ["ffmpeg", "ffprobe"])
    assert.notEqual(caps[name].version, "ambient-only media tool");
});

test("Windows preflight and actual extraction resolve relative PATH from fresh child directories", {
  skip: process.platform !== "win32",
}, async (t) => {
  const f = await acquisition(t);
  const callerTools = path.join(f.root, "tools"), workTools = path.join(f.work, "tools");
  const marker = path.join(f.root, "media-tool-calls.jsonl");
  await Promise.all([mkdir(callerTools), mkdir(workTools)]);
  for (const name of ["ffmpeg", "ffprobe"]) {
    const found = await execute(path.join(process.env.SystemRoot, "System32", "where.exe"), [name]);
    const executable = found.stdout.split(/\r?\n/).find((file) => file.toLowerCase().endsWith(".exe"));
    assert.ok(executable, `real ${name} must be available for the extraction regression`);
    for (const [directory, origin] of [[callerTools, "caller"], [workTools, "work"]])
      await fakeTool(path.join(directory, name), `
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({origin:${JSON.stringify(origin)},cwd:process.cwd()})+'\\n');
const result=spawnSync(${JSON.stringify(executable)},process.argv.slice(2),{encoding:'utf8'});
process.stdout.write(result.stdout??'');
process.stderr.write(result.stderr??'');
process.exit(result.status??1);
`);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  const args = [path.resolve("scripts/prepare.mjs"), "--request", f.args.request, "--work-dir", f.work];
  await execute(process.execPath, [...args, "--check"], {
    cwd: f.root, env: { ...env, PATH: "tools" }, timeout: 30000,
  });
  let caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  for (const name of ["ffmpeg", "ffprobe"])
    assert.deepEqual(caps[name], { status: "unavailable", version: null });
  await assert.rejects(execute(process.execPath, args, {
    cwd: f.root, env: { ...env, PATH: "tools" }, timeout: 30000,
  }), (error) => error.code === 3 && JSON.parse(error.stdout).issues.some((issue) => issue.code === "CAPABILITY_MISSING"));
  await assert.rejects(access(marker), "neither preflight nor extraction may resolve tools from the caller or outer job directory");

  const actual = await execute(process.execPath, args, {
    cwd: f.root, env: { ...env, PATH: "../tools" }, timeout: 30000,
  });
  assert.equal(JSON.parse(actual.stdout).status, "ok");
  caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  for (const name of ["ffmpeg", "ffprobe"]) assert.equal(caps[name].status, "available");
  assert.equal((await readJson(path.join(f.work, "evidence.json"))).data.segments.length, 3);
  const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.every((call) => call.origin === "work" && path.dirname(call.cwd).toLowerCase() === f.work.toLowerCase()));
  assert.ok(calls.some((call) => path.basename(call.cwd).startsWith("preflight-")));
  assert.ok(calls.some((call) => path.basename(call.cwd).startsWith("ingest-")));
  assert.ok((await readdir(f.work)).every((name) => !name.startsWith("preflight-")), "temporary probes must be removed");
});

test("preflight rejects directories for supplied runtime files and accepts file aliases", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const directory = path.join(f.root, "browser-directory");
  await mkdir(directory);
  const paths = { "local-asr-executable": directory, "local-asr-gpu-executable": directory,
    "local-asr-model": directory, "browser-executable": directory,
    "tesseract-executable": directory, "yt-dlp-executable": directory };
  await prepare({ request: f.args.request, "work-dir": f.work, ...paths, check: true });
  let caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  for (const name of ["localAsrExecutable", "localAsrGpuExecutable", "localAsrModel", "pdfBrowser", "ocr", "ytDlp"])
    assert.equal(caps[name].status, "unavailable", `${name} must be a file`);
  const accepted = [process.execPath];
  if (process.platform !== "win32") {
    const alias = path.join(f.root, "browser-alias");
    await symlink(process.execPath, alias);
    accepted.push(alias);
  }
  for (const browser of accepted) {
    await prepare({ request: f.args.request, "work-dir": f.work,
      "browser-executable": browser, check: true });
    caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
    assert.equal(caps.pdfBrowser.status, "available", "explicit regular-file aliases remain eligible for the actual browser launch check");
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
  assert.notEqual(firstGpu, missingGpu, "a newly available GPU runtime invalidates cache");
  await writeFile(dependency, "dependency version two");
  assert.notEqual(await cacheKey(f.request, accelerated), firstGpu, "GPU library changes invalidate cache");
  const cpuDependency = path.join(f.root, "ggml-cpu.dll");
  await writeFile(cpuDependency, "CPU dependency one");
  const firstCpu = await cacheKey(f.request, opts);
  await writeFile(cpuDependency, "CPU dependency two");
  assert.notEqual(await cacheKey(f.request, opts), firstCpu, "CPU library changes invalidate cache");
});
test("configured GPU is selected automatically for the matching local ASR preference", async (t) => {
  const f = await acquisition(t);
  const cpu = path.join(f.root, "cpu-exe"), model = path.join(f.root, "speech-model"), gpu = path.join(f.root, "gpu-exe");
  const preference = path.join(f.root, "preference.json");
  await Promise.all([writeFile(cpu, "cpu"), writeFile(model, "model"), writeFile(gpu, "gpu")]);
  await Promise.all([chmod(cpu, 0o755), chmod(gpu, 0o755)]);
  await writeFile(preference, JSON.stringify({ localAsrExecutable: cpu, localAsrModel: model, localAsrGpuExecutable: gpu }));
  f.request.policy.asr = "local";
  await writeFile(f.args.request, jsonBytes(f.request));
  const options = { ...f.args, check: true, "local-asr-executable": cpu, "local-asr-model": model };
  await prepare(options, { asrPreferencePath: preference });
  let caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  assert.equal(caps.localAsrGpuExecutable.status, "available");
  const other = path.join(f.root, "other-cpu");
  await writeFile(other, "other");
  await prepare({ ...options, "local-asr-executable": other }, { asrPreferencePath: preference });
  caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  assert.equal(caps.localAsrGpuExecutable.status, "unavailable", "unrelated explicit runtime must not inherit the preference");
  const chosen = path.join(f.root, "explicit-gpu");
  await prepare({ ...options, "local-asr-gpu-executable": chosen }, { asrPreferencePath: preference });
  caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  assert.equal(caps.localAsrGpuExecutable.status, "unavailable", "explicit GPU path must override the stored preference");
  await writeFile(preference, "invalid json");
  await prepare(options, { asrPreferencePath: preference });
  caps = (await readJson(path.join(f.work, "capabilities.json"))).data;
  assert.equal(caps.localAsrGpuExecutable.status, "unavailable", "invalid optional preferences must not break CPU use");
});

test("prepare passes the stored GPU candidate through to actual transcription", async (t) => {
  const f = await acquisition(t);
  const cpu = await fakeTool(path.join(f.root, "cpu-asr"), "process.exit(2);");
  const gpu = await fakeTool(path.join(f.root, "gpu-asr"), `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('whisper.cpp version: 1.9.5'); process.exit(0); }
console.error('whisper_backend_init_gpu: using CUDA0 backend');
if (args.includes('--duration')) process.exit(0);
fs.writeFileSync(args[args.indexOf('--output-file')+1]+'.srt', '1\\n00:00:00,000 --> 00:00:01,000\\nGPU transcription.\\n');
`);
  const model = path.join(f.root, "model.bin"), preference = path.join(f.root, "preference.json");
  await writeFile(model, "model");
  await writeFile(preference, JSON.stringify({ localAsrExecutable: cpu, localAsrModel: model, localAsrGpuExecutable: gpu }));
  f.request.transcriptFile = null;
  f.request.policy.asr = "local";
  await writeFile(f.args.request, jsonBytes(f.request));
  const result = await prepare({ ...f.args, "local-asr-executable": cpu, "local-asr-model": model }, { asrPreferencePath: preference });
  assert.equal(result.status, "ok");
  const raw = (await readJson(path.join(f.work, "raw", "extraction.json"))).data;
  assert.deepEqual(raw.localAsrRuntime, { backend: "cuda", fallback: null });
  assert.equal((await readJson(path.join(f.work, "evidence.json"))).data.segments[0].text, "GPU transcription.");
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
