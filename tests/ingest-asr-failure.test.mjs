import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { asrFailureOutput } from "../lib/ingest.mjs";
import { fakeTool } from "./fake-tool.mjs";

const exec = promisify(execFile);
const limit = 8 * 1024 * 1024;
const local = { policy: { asr: "local" }, transcriptFile: null };

test("failed ASR diagnostic gate accepts only bounded validation-error text for local ASR", () => {
  const allowed = { ok: false, code: "INVALID_CONTRACT", detail: "transcript-invalid-timing", rawSrt: "ok🙂\n" };
  assert.equal(asrFailureOutput(allowed, local, 7), "ok🙂\n");
  for (const message of [
    { ...allowed, ok: true }, { ...allowed, ok: undefined },
    { ...allowed, code: "TIMEOUT" }, { ...allowed, code: "RESOURCE_LIMIT" },
    { ...allowed, detail: "worker-controlled-path" }, { ...allowed, detail: "../../secret" },
    ...[null, {}, [], 42].map((rawSrt) => ({ ...allowed, rawSrt })),
    { ...allowed, rawSrt: "x".repeat(limit + 1) },
  ]) assert.equal(asrFailureOutput(message, local, limit + 100), null);
  assert.equal(asrFailureOutput(allowed, local, 6), null, "limit counts UTF-8 bytes");
  for (const budget of [0, -1, Infinity, NaN, "7"])
    assert.equal(asrFailureOutput(allowed, local, budget), null);
  assert.equal(asrFailureOutput(allowed, { ...local, transcriptFile: "supplied.srt" }, limit), null);
  assert.equal(asrFailureOutput(allowed, { policy: { asr: "off" } }, limit), null);
});

async function fixture(t, raw) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "asr-failure-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = path.join(root, "work"), media = path.join(root, "source.wav");
  await mkdir(work);
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "sine=frequency=440:duration=2", "-c:a", "pcm_s16le", media], { timeout: 15000 });
  const model = path.join(root, "model.bin");
  await writeFile(model, "test model, not inference");
  const executable = await fakeTool(path.join(root, "whisper"), `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('--help')) console.log('whisper.cpp version 1.9.5');
else fs.writeFileSync(args[args.indexOf('--output-file') + 1] + '.srt', ${JSON.stringify(raw)});
`);
  const request = path.join(root, "request.json");
  const data = { schemaVersion: 1, source: { kind: "local", value: media }, mode: "briefing",
    outputLanguage: "en", policy: { asr: "local", visual: "off", extractTimeoutMs: 15000,
      asrTimeoutMs: 15000, maxDownloadBytes: 4 * 1024 * 1024 } };
  await writeFile(request, JSON.stringify(data));
  const run = () => exec(process.execPath, ["scripts/prepare.mjs", "--request", request,
    "--work-dir", work, "--local-asr-executable", executable, "--local-asr-model", model],
  { timeout: 30000 });
  return { root, work, request, data, run };
}

async function rejected(f, cause) {
  let failure;
  await assert.rejects(f.run(), (error) => {
    failure = error;
    assert.equal(error.code, 1);
    const response = JSON.parse(error.stdout);
    assert.equal(response.status, "error");
    assert.equal(response.issues[0].code, "INVALID_CONTRACT");
    assert.match(response.issues[0].message, cause);
    assert.ok(!error.stdout.includes(f.root));
    assert.ok(!error.stdout.includes("private-secret"));
    return true;
  });
  const names = await readdir(f.work);
  assert.ok(!names.some((name) => name.startsWith("ingest-")), "failed native work is cleaned");
  for (const name of ["evidence.json", "manifest.json", "analysis-ledger.json"])
    assert.ok(!names.includes(name), `failure must not create ${name}`);
  return failure;
}

async function retained(f) {
  const parent = path.join(f.work, "raw/asr-failures");
  const attempts = await readdir(parent);
  assert.equal(attempts.length, 1);
  const directory = path.join(parent, attempts[0]);
  const raw = await readFile(path.join(directory, "transcript.srt"));
  const receiptBytes = await readFile(path.join(directory, "receipt.json"));
  const receipt = JSON.parse(receiptBytes);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  assert.deepEqual(receipt.transcript, { path: "transcript.srt", bytes: raw.length, sha256: hash(raw) });
  assert.equal(receipt.requestSha256, hash(JSON.stringify(receipt.request)));
  assert.equal(receipt.request.policy.asr, "local");
  assert.equal(receipt.request.policy.asrTimeoutMs, 15000);
  assert.equal(receipt.status, "rejected");
  assert.equal(receipt.evidence, false);
  assert.ok(Number.isFinite(Date.parse(receipt.createdAt)));
  return { directory, raw, receiptBytes, receipt };
}

test("native subtitle validation failures preserve exact private SRT with safe precise causes", async (t) => {
  const cases = [
    ["1\r\n00:00:00,100 --> 00:00:00,100\r\nprivate-secret ok🙂\r\n", /invalid or non-positive time interval/],
    ["1\n00:00:00,100 --> 00:00:00,700\n   \n", /empty text/],
    ["1\ninvalid --> 00:00:00,700\nprivate-secret\n", /could not be parsed/],
    ["1\n00:00:00,100 --> 00:00:00,700\nprivate-secret\nfoo --> bar\n", /Some subtitle cues/],
  ];
  for (const [raw, cause] of cases) {
    const f = await fixture(t, raw);
    const error = await rejected(f, cause);
    assert.match(error.stdout, /saved privately to raw\/asr-failures\/ingest-[^/]+\/transcript\.srt/);
    assert.deepEqual((await retained(f)).raw, Buffer.from(raw));
  }
});

test("a later failed retry cannot make an earlier rejected transcript look current", async (t) => {
  const f = await fixture(t, "1\n00:00:00,100 --> 00:00:00,100\nprivate-secret\n");
  await rejected(f, /invalid or non-positive time interval/);
  const before = await retained(f);
  await writeFile(f.request, JSON.stringify({ ...f.data, policy: { ...f.data.policy, asrTimeoutMs: 1 } }));
  await assert.rejects(f.run(), (error) => {
    assert.equal(JSON.parse(error.stdout).issues[0].code, "TIMEOUT");
    assert.ok(!error.stdout.includes("saved privately"));
    return true;
  });
  const after = await retained(f);
  assert.equal(after.directory, before.directory);
  assert.deepEqual(after.raw, before.raw);
  assert.deepEqual(after.receiptBytes, before.receiptBytes);
  assert.ok(!(await readdir(f.work)).some((name) => name.startsWith("ingest-")));
});

test("diagnostic destination refusal preserves the original error and cannot escape through a link", async (t) => {
  const raw = "1\n00:00:00,100 --> 00:00:00,100\nprivate-secret\n";
  const f = await fixture(t, raw), outside = path.join(f.root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(f.work, "raw"), process.platform === "win32" ? "junction" : "dir");
  const error = await rejected(f, /invalid or non-positive time interval/);
  assert.ok(!error.stdout.includes("saved privately"));
  assert.deepEqual(await readdir(outside), []);
});

test("supplied subtitle errors remain strict and do not create native ASR diagnostics", async (t) => {
  const raw = "1\n00:00:01,900 --> 00:00:02,100\nprivate-secret\n";
  const f = await fixture(t, raw), transcript = path.join(f.root, "supplied.srt");
  await writeFile(transcript, raw);
  await writeFile(f.request, JSON.stringify({ ...f.data, transcriptFile: transcript }));
  const error = await rejected(f, /exceeds the known source duration/);
  assert.ok(!error.stdout.includes("saved privately"));
  assert.ok(!(await readdir(f.work)).includes("raw"));
});

test("ASR duration overruns preserve every cue as untimed without clipping or dropping text", async (t) => {
  const raw = "1\n00:00:00,100 --> 00:00:00,700\nFirst ok🙂\n\n" +
    "2\n00:00:01,800 --> 00:00:02,500\nEnd overrun\n\n" +
    "3\n00:00:02,500 --> 00:00:03,000\nBoth overrun\n\n" +
    "4\n00:00:01,200 --> 00:00:01,500\nLater cue order\n\n" +
    "5\n00:00:01,900 --> 00:00:02,000\nExact end\n";
  const f = await fixture(t, raw);
  const { stdout } = await f.run();
  assert.equal(JSON.parse(stdout).status, "ok");
  const evidence = JSON.parse(await readFile(path.join(f.work, "evidence.json"), "utf8"));
  const extraction = JSON.parse(await readFile(path.join(f.work, "raw/extraction.json"), "utf8"));
  assert.equal(evidence.source.durationMs, 2000);
  assert.deepEqual(evidence.segments.map(({ startMs, endMs, text }) => [startMs, endMs, text]), [
    [100, 700, "First ok🙂"], [null, null, "End overrun"], [null, null, "Both overrun"],
    [1200, 1500, "Later cue order"], [1900, 2000, "Exact end"],
  ]);
  assert.equal(extraction.localAsr, raw);
  assert.deepEqual(extraction.localAsrTiming, { sourceDurationMs: 2000, rejectedIntervals: [
    { segmentIndex: 1, startMs: 1800, endMs: 2500, reason: "source-duration-overrun" },
    { segmentIndex: 2, startMs: 2500, endMs: 3000, reason: "source-duration-overrun" },
  ] });
  assert.equal(evidence.extraction.timing, "partial");
  assert.ok(evidence.extraction.warnings.some(({ code }) => code === "TIMING_UNAVAILABLE"));
  assert.ok(!(await readdir(path.join(f.work, "raw"))).includes("asr-failures"));
});
