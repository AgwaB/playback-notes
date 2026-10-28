import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, sampleData } from "./helpers.mjs";
import { chunkDocument, makeChunks } from "../lib/evidence.mjs";
import { jsonBytes, sha256, withLock, atomicWrite } from "../lib/io.mjs";
import { validateData, validateEvidence } from "../lib/validation.mjs";
import { render } from "../scripts/render.mjs";
import { extractSource } from "../lib/ingest.mjs";

const execute = promisify(execFile);
const cwd = fileURLToPath(new URL("../", import.meta.url));

function longData() {
  const d = sampleData();
  d.evidence.source.durationMs = 10000 * 10000;
  d.evidence.segments = Array.from({ length: 10000 }, (_, i) => ({
    id: `seg-${String(i + 1).padStart(6, "0")}`,
    startMs: i * 10000,
    endMs: (i + 1) * 10000,
    text:
      i === 9999
        ? "LONG_SOURCE_FINAL_SENTINEL"
        : `Line ${i}: ${"bounded café 🙂 ".repeat(24)}`,
    speaker: null,
  }));
  d.evidence.chunks = makeChunks(d.evidence.segments);
  d.analysis.reviewedChunkIds = d.evidence.chunks.map((c) => c.id);
  d.evidenceSha256 = sha256(jsonBytes(d.evidence));
  d.report.evidenceRef.sha256 = d.evidenceSha256;
  d.report.sections[0].blocks = [
    { type: "paragraph", statement: d.report.summary[0] },
  ];
  d.report.caveats = [];
  return d;
}

test("long-source chunks preserve every segment, Unicode budgets, context and final sentinel", (t) => {
  const started = performance.now();
  const d = longData();
  const maps = validateData(d);
  assert.equal(maps.segments.size, 10000);
  assert.ok(d.evidence.chunks.length > 200);
  assert.deepEqual(
    d.evidence.chunks.flatMap((c) => c.segmentIds),
    d.evidence.segments.map((s) => s.id),
  );
  for (const [i, chunk] of d.evidence.chunks.entries()) {
    const document = chunkDocument(d.evidence, chunk);
    assert.match(document.notice, /UNTRUSTED SOURCE DATA/);
    assert.ok(
      document.segments.reduce((n, s) => n + [...s.text].length, 0) <= 12000,
    );
    assert.deepEqual(
      chunk.contextSegmentIds,
      i ? [d.evidence.chunks[i - 1].segmentIds.at(-1)] : [],
    );
    assert.ok(
      document.context.every((s) => s && !chunk.segmentIds.includes(s.id)),
    );
  }
  assert.equal(
    chunkDocument(d.evidence, d.evidence.chunks.at(-1)).segments.at(-1).text,
    "LONG_SOURCE_FINAL_SENTINEL",
  );
  for (const mutate of [
    (e) => e.chunks.pop(),
    (e) => e.chunks.at(-1).segmentIds.reverse(),
    (e) => e.chunks.at(-1).segmentIds.push(e.segments[0].id),
    (e) => e.chunks.at(-1).contextSegmentIds.push("seg-absent"),
  ]) {
    const evidence = structuredClone(d.evidence);
    mutate(evidence);
    assert.throws(
      () => validateEvidence(evidence),
      (error) => ["INVALID_CONTRACT", "INVALID_REFERENCE"].includes(error.code),
    );
  }
  t.diagnostic(
    JSON.stringify({
      segments: 10000,
      durationHours: d.evidence.source.durationMs / 3600000,
      chunks: d.evidence.chunks.length,
      evidenceBytes: Buffer.byteLength(jsonBytes(d.evidence)),
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
});

test("unreviewed long-source tail cannot render or create a completion manifest", async (t) => {
  const d = longData();
  d.analysis.reviewedChunkIds.pop();
  assert.throws(() => validateData(d), { code: "INVALID_CONTRACT" });
  d.analysis.status = "partial";
  assert.throws(() => validateData(d), { code: "UNREVIEWED_EVIDENCE" });
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const name of ["request", "evidence", "analysis", "report"])
    await writeFile(f.args[name], jsonBytes(d[name]));
  await assert.rejects(render(f.args), { code: "UNREVIEWED_EVIDENCE" });
  assert.deepEqual(await readdir(f.out), []);
});

// Mutation of built-in syscalls is confined to a fresh child, never the test runner.
async function injected(f, body) {
  const { stdout } = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { Writable, Readable } from 'node:stream';
    import path from 'node:path';
    const root = ${JSON.stringify(f.root)};
    const out = ${JSON.stringify(f.out)};
    const args = ${JSON.stringify(f.args)};
    const fault = () => Object.assign(new Error('safe injected disk failure'), {code:'ENOSPC'});
    ${body}
    console.log('injected assertions passed');
  `,
    ],
    { cwd, timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  assert.match(stdout, /injected assertions passed/);
}

for (const operation of ["writeFile", "sync", "close", "rename"]) {
  test(`atomic write injected ${operation} failure preserves original and removes temporary files`, async (t) => {
    const f = await fixture();
    t.after(() => rm(f.root, { recursive: true, force: true }));
    await writeFile(path.join(f.out, "target.txt"), "original");
    await injected(
      f,
      `
      const operation = ${JSON.stringify(operation)};
      const originalOpen = fsp.open;
      const originalRename = fsp.rename;
      fsp.open = async (...args) => {
        const handle = await originalOpen(...args);
        if (String(args[0]).endsWith('.tmp') && operation !== 'rename') {
          if (operation === 'close') {
            const close = handle.close.bind(handle);
            handle.close = async () => { await close(); throw fault(); };
          } else if (operation === 'writeFile') {
            const write = handle.writeFile.bind(handle);
            handle.writeFile = async () => { await write('bounded partial write'); throw fault(); };
          } else handle[operation] = async () => { throw fault(); };
        }
        return handle;
      };
      fsp.rename = async (...args) => { if (operation === 'rename') throw fault(); return originalRename(...args); };
      syncBuiltinESMExports();
      const {atomicWrite} = await import('./lib/io.mjs');
      await assert.rejects(atomicWrite(out, 'target.txt', 'replacement'), {code:'ENOSPC'});
      assert.equal(await fsp.readFile(path.join(out,'target.txt'),'utf8'), 'original');
      assert.deepEqual(await fsp.readdir(out), ['target.txt']);
    `,
    );
  });
}

test("disk failure during export is incomplete, has no failed download link and releases writer lock", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await injected(
    f,
    `
    const open = fsp.open;
    fsp.open = async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).includes('report.md.') && String(args[0]).endsWith('.tmp')) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async () => { await write('bounded partial export'); throw fault(); };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const {exportReport} = await import('./scripts/export.mjs');
    const result = await exportReport(args);
    assert.equal(result.status, 'partial');
    const manifest = JSON.parse(await fsp.readFile(path.join(out,'manifest.json')));
    assert.equal(manifest.overallStatus,'incomplete');
    assert.deepEqual(manifest.artifacts.find(a=>a.format==='markdown'), {format:'markdown',path:null,status:'failed'});
    assert.ok(!((await fsp.readFile(path.join(out,'index.html'),'utf8')).includes('href="report.md"')));
    assert.ok(!(await fsp.readdir(out)).some(n=>n.endsWith('.tmp') || n==='.write.lock'));
  `,
  );
});

test("lock rejects concurrent writers and releases after cancellation rejection", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = withLock(f.out, async () => {
    entered();
    await gate;
    throw Object.assign(new Error("test cancellation"), { code: "CANCELLED" });
  });
  const rejection = assert.rejects(first, { code: "CANCELLED" });
  await started;
  try {
    await assert.rejects(
      withLock(f.out, () => assert.fail("second writer entered")),
      { code: "BUSY" },
    );
    assert.deepEqual(await readdir(f.out), [".write.lock"]);
  } finally {
    release();
  }
  await rejection;
  await withLock(f.out, () => atomicWrite(f.out, "after.txt", "ok"));
  assert.deepEqual(await readdir(f.out), ["after.txt"]);
});

test("lock close failure still removes its owned lock", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await injected(
    f,
    `
    const open = fsp.open;
    fsp.open = async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.write.lock')) {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); throw fault(); };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const {withLock} = await import('./lib/io.mjs');
    await assert.rejects(withLock(out, async()=>{}), {code:'ENOSPC'});
    assert.deepEqual(await fsp.readdir(out), []);
  `,
  );
});

for (const mode of ["disk", "hash", "growth"]) {
  test(`streamed media ${mode} failure cleans temporary output and preserves previous media`, async (t) => {
    const f = await fixture();
    t.after(() => rm(f.root, { recursive: true, force: true }));
    const source = path.join(f.root, "source.bin");
    await writeFile(source, Buffer.alloc(65536, 7));
    await writeFile(path.join(f.out, "media.bin"), "previous");
    await injected(
      f,
      `
      const mode = ${JSON.stringify(mode)};
      let partialBytes = 0;
      if (mode === 'disk') {
        const create = fs.createWriteStream;
        fs.createWriteStream = (...args) => {
          const stream = create(...args), write = stream._write.bind(stream);
          stream._write = (chunk, encoding, callback) => write(chunk.subarray(0,1024),encoding,(error)=> {
            partialBytes = fs.fstatSync(stream.fd).size;
            callback(error ?? fault());
          });
          return stream;
        };
      }
      if (mode === 'growth') fs.createReadStream = () => Readable.from([Buffer.alloc(131072)]);
      syncBuiltinESMExports();
      const {copyMedia} = await import('./lib/media-copy.mjs');
      await assert.rejects(copyMedia(path.join(root,'source.bin'),out,'media.bin',65536,'0'.repeat(64)), {code:mode==='disk'?'ENOSPC':mode==='hash'?'EVIDENCE_MISMATCH':'RESOURCE_LIMIT'});
      assert.equal(await fsp.readFile(path.join(out,'media.bin'),'utf8'), 'previous');
      assert.deepEqual(await fsp.readdir(out), ['media.bin']);
      if (mode === 'disk') assert.equal(partialBytes,1024);
    `,
    );
  });
}

test("in-flight extraction cancellation removes only its own private job and permits a later job", {
  timeout: 30000,
}, async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const media = path.join(f.root, "audio.wav");
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
      "sine=duration=1",
      media,
    ],
    { timeout: 10000 },
  );
  const jobs = path.join(f.root, "jobs");
  await mkdir(jobs);
  await writeFile(path.join(jobs, "unrelated.txt"), "retain");
  const controller = new AbortController();
  const request = {
    source: { kind: "local", value: media },
    policy: { asr: "off", extractTimeoutMs: 10000, maxDownloadBytes: 1048576 },
  };
  const pending = extractSource(request, {
    workDir: jobs,
    signal: controller.signal,
  });
  const rejection = assert.rejects(pending, { code: "CANCELLED" });
  try {
    for (let i = 0; i < 100; i++) {
      if ((await readdir(jobs)).some((name) => name.startsWith("ingest-")))
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok((await readdir(jobs)).some((name) => name.startsWith("ingest-")));
  } finally {
    controller.abort();
  }
  await rejection;
  assert.deepEqual(await readdir(jobs), ["unrelated.txt"]);
  const transcript = path.join(f.root, "transcript.txt");
  await writeFile(transcript, "Later bounded job succeeds.");
  const result = await extractSource(
    { ...request, transcriptFile: transcript },
    { workDir: jobs },
  );
  assert.ok(result.segments.some((s) => s.text.includes("Later bounded job")));
  assert.equal(
    await readFile(path.join(jobs, "unrelated.txt"), "utf8"),
    "retain",
  );
});
