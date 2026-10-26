import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { fixture, sampleData } from "./helpers.mjs";
import { prepare } from "../scripts/prepare.mjs";
import { cacheKey } from "../lib/cache.mjs";
import { loadBundle } from "../lib/validation.mjs";
import { jsonBytes, readJson } from "../lib/io.mjs";

const execute = promisify(execFile);
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
  const executable = path.join(f.root, "explicit-tool"),
    model = path.join(f.root, "model.bin");
  await writeFile(executable, "version one");
  await writeFile(model, "model");
  const opts = { localAsrExecutable: executable, localAsrModel: model };
  const before = await cacheKey(f.request, opts);
  await writeFile(executable, "version two");
  assert.notEqual(await cacheKey(f.request, opts), before);
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
