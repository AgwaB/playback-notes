import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.mjs";
import { render } from "../scripts/render.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
async function injectedExport(f, body) {
  const { stdout } = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import fsp from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import path from 'node:path';
    const out = ${JSON.stringify(f.out)};
    const args = ${JSON.stringify(f.args)};
    const fault = () => Object.assign(new Error('safe injected disk failure'), {code:'ENOSPC'});
    ${body}
    console.log('injected assertions passed');
  `,
    ],
    { cwd: process.cwd(), timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  assert.match(stdout, /injected assertions passed/);
}
import { exportReport } from "../scripts/export.mjs";
import { startServer } from "../lib/server.mjs";
import { fileHash, jsonBytes, readJson } from "../lib/io.mjs";

test("media-copy policy changes require a new revision; fresh no-copy output contains no media", async (t) => {
  const f = await fixture({
    mutate(d) {
      d.request.policy.copyLocalMedia = true;
      d.evidence.source.playback = { kind: "native", locator: "media:fixture" };
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const source = path.join(f.root, "source.mp4");
  await writeFile(source, "synthetic media");
  await writeFile(
    path.join(f.work, "manifest.json"),
    jsonBytes({
      evidenceSha256: f.data.evidenceSha256,
      sourceId: f.data.evidence.source.id,
      mediaPath: source,
      mediaSha256: await fileHash(source),
    }),
  );
  await render(f.args);
  assert.equal(
    await readFile(
      path.join(f.out, "media", f.data.evidence.source.id),
      "utf8",
    ),
    "synthetic media",
  );
  f.data.request.policy.copyLocalMedia = false;
  await writeFile(f.args.request, jsonBytes(f.data.request));
  await assert.rejects(render(f.args), { code: "EVIDENCE_MISMATCH" });
  const out = path.join(f.root, "new-public");
  await render({ ...f.args, "out-dir": out });
  assert.equal(
    (await readJson(path.join(out, "manifest.json"))).data.media,
    null,
  );
  const running = await startServer({ root: out });
  t.after(() => running.close());
  const response = await fetch(
    running.url.replace("index.html", `media/${f.data.evidence.source.id}`),
  );
  await response.text();
  assert.equal(response.status, 404);
});
test("changed analysis cannot silently leave old exports in a current revision", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await exportReport(f.args);
  f.data.analysis.limitations.push("New mandatory limitation");
  await writeFile(f.args.analysis, jsonBytes(f.data.analysis));
  await assert.rejects(render(f.args), { code: "EVIDENCE_MISMATCH" });
  const out = path.join(f.root, "new-public");
  await exportReport({ ...f.args, "out-dir": out });
  assert.ok(
    (await readFile(path.join(out, "report.md"), "utf8")).includes(
      "New mandatory limitation",
    ),
  );
});
test("server serves only current successful inventory, not orphaned files or blocked exports", async (t) => {
  const f = await fixture();
  await render(f.args);
  await writeFile(path.join(f.out, "report.pdf"), "old blocked file");
  await mkdir(path.join(f.out, "media"));
  await writeFile(
    path.join(f.out, "media", f.data.evidence.source.id),
    "old unapproved copy",
  );
  const running = await startServer({ root: f.out });
  t.after(async () => {
    await running.close();
    await rm(f.root, { recursive: true, force: true });
  });
  for (const suffix of ["report.pdf", `media/${f.data.evidence.source.id}`]) {
    const response = await fetch(running.url.replace("index.html", suffix));
    await response.text();
    assert.equal(response.status, 404);
  }
  await exportReport({ ...f.args, formats: "markdown" });
  const md = await fetch(running.url.replace("index.html", "report.md"));
  assert.equal(md.status, 200);
  await md.text();
  const snapshot = await readJson(path.join(f.out, "manifest.json"));
  snapshot.data.artifacts = snapshot.data.artifacts.map((a) =>
    a.format === "markdown"
      ? { format: "markdown", status: "failed", path: null }
      : a,
  );
  await writeFile(path.join(f.out, "manifest.json"), jsonBytes(snapshot.data));
  const stale = await fetch(running.url.replace("index.html", "report.md"));
  assert.equal(stale.status, 404);
  await stale.text();
  const html = await fetch(running.url);
  assert.ok(
    html.headers
      .get("content-security-policy")
      .includes("media-src 'self' http: https:"),
  );
  await html.text();
});

test("a failed first render leaves nothing behind, and a fresh revision refuses a directory holding unowned assets/media", async (t) => {
  const f = await fixture({
    mutate(d) {
      d.request.policy.copyLocalMedia = true;
      d.evidence.source.playback = { kind: "native", locator: "media:fixture" };
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const source = path.join(f.root, "source.mp4");
  await writeFile(source, "synthetic media");
  // Private manifest records a different media hash → the media copy fails after any
  // cited images would already have been written.
  await writeFile(
    path.join(f.work, "manifest.json"),
    jsonBytes({
      evidenceSha256: f.data.evidenceSha256,
      sourceId: f.data.evidence.source.id,
      mediaPath: source,
      mediaSha256: "0".repeat(64),
    }),
  );
  await assert.rejects(render(f.args), { code: "EVIDENCE_MISMATCH" });
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(
    (await readdir(f.out)).filter((n) => n !== ".write.lock"),
    [],
    "the failed attempt removed everything it wrote",
  );
  // Unowned content from elsewhere (e.g. an interrupted attempt) blocks a fresh revision.
  await mkdir(path.join(f.out, "assets"), { recursive: true });
  await writeFile(path.join(f.out, "assets", "stale.jpg"), "stale");
  await writeFile(
    path.join(f.work, "manifest.json"),
    jsonBytes({
      evidenceSha256: f.data.evidenceSha256,
      sourceId: f.data.evidence.source.id,
      mediaPath: source,
      mediaSha256: await fileHash(source),
    }),
  );
  await assert.rejects(render(f.args), { code: "OUTPUT_EXISTS" });
  assert.equal(
    await readFile(path.join(f.out, "assets", "stale.jpg"), "utf8"),
    "stale",
    "unowned files are never deleted",
  );
});

test("U3/U7: a failed first render (after an image copy, or at the HTML stage) empties the directory so a corrected retry works; a failed same-revision re-export keeps the still-valid prior export", async (t) => {
  const { exportReport } = await import("../scripts/export.mjs");
  const { sha256 } = await import("../lib/io.mjs");
  const { readdir } = await import("node:fs/promises");
  const exec = execute;
  // A tiny real JPEG so the cited figure is copied before the media check fails.
  const jpegFile = path.join(
    (await import("node:os")).tmpdir(),
    `u3-${process.pid}.jpg`,
  );
  await exec("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=32x18:d=0.1",
    "-frames:v",
    "1",
    "-q:v",
    "4",
    "-y",
    jpegFile,
  ]);
  const jpeg = await readFile(jpegFile);
  await rm(jpegFile, { force: true });
  const f = await fixture({
    mutate(d) {
      d.request.policy.copyLocalMedia = true;
      d.request.formats = ["html", "markdown"];
      d.evidence.source.playback = { kind: "native", locator: "media:fixture" };
      d.evidence.frames = [
        {
          id: "frame-0001",
          timestampMs: 1000,
          assetPath: "assets/frame-0001.jpg",
          sha256: sha256(jpeg),
          width: 32,
          height: 18,
          ocrText: "card",
        },
      ];
      d.analysis.inspectedFrameIds = ["frame-0001"];
      d.report.sections[0].blocks.unshift({
        type: "figure",
        frameId: "frame-0001",
        alt: "card",
        caption: {
          text: "card",
          attribution: "source",
          citations: [{ kind: "frame", id: "frame-0001" }],
        },
      });
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await mkdir(path.join(f.work, "assets"));
  await writeFile(path.join(f.work, "assets", "frame-0001.jpg"), jpeg);
  const source = path.join(f.root, "source.mp4");
  await writeFile(source, "synthetic media");
  const privateManifest = (hash) =>
    jsonBytes({
      evidenceSha256: f.data.evidenceSha256,
      sourceId: f.data.evidence.source.id,
      mediaPath: source,
      mediaSha256: hash,
    });
  // Scenario A: image copied, then the media hash check fails → directory emptied (no stray assets/).
  await writeFile(
    path.join(f.work, "manifest.json"),
    privateManifest("0".repeat(64)),
  );
  await assert.rejects(render(f.args), { code: "EVIDENCE_MISMATCH" });
  assert.deepEqual(
    (await readdir(f.out)).filter((n) => n !== ".write.lock"),
    [],
  );
  // Corrected retry in the same directory succeeds.
  await writeFile(
    path.join(f.work, "manifest.json"),
    privateManifest(await fileHash(source)),
  );
  await render(f.args);
  const names = await readdir(f.out);
  assert.ok(
    names.includes("manifest.json") &&
      names.includes("assets") &&
      names.includes("media"),
  );
  // Scenario B (fresh dir, HTML stage fails): simulate by making index.html's parent unwritable is
  // platform-dependent; instead verify the transaction helper empties a fresh dir on a body failure.
  const { outputTransaction } = await import("../lib/output.mjs");
  const { loadBundle } = await import("../lib/validation.mjs");
  const freshOut = path.join(f.root, "fresh");
  await mkdir(freshOut);
  const bundle = await loadBundle({ ...f.args, "out-dir": freshOut });
  await assert.rejects(
    outputTransaction(
      bundle,
      { ...f.args, "out-dir": freshOut },
      async (context) => {
        assert.ok(
          (await readdir(context.out)).includes("assets"),
          "image already copied when the later stage fails",
        );
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      },
    ),
    (e) => e.code === "ENOSPC",
  );
  assert.deepEqual(
    await readdir(freshOut),
    [],
    "fresh attempt fully abandoned",
  );
  // U7: markdown exported; a second export whose markdown write fails keeps the prior valid export.
  await exportReport({ ...f.args, formats: "markdown" });
  const before = await readFile(path.join(f.out, "report.md"), "utf8");
  await injectedExport(
    f,
    `
    const open = fsp.open;
    fsp.open = async (...a) => {
      const handle = await open(...a);
      if (String(a[0]).includes('report.md.') && String(a[0]).endsWith('.tmp')) {
        handle.writeFile = async () => { throw fault(); };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const { exportReport } = await import('./scripts/export.mjs');
    const result = await exportReport({ ...args, formats: 'markdown' });
    const manifest = JSON.parse(await fsp.readFile(path.join(out, 'manifest.json')));
    const md = manifest.artifacts.find((a) => a.format === 'markdown');
    assert.equal(md.status, 'reused', 'the verified prior export is kept');
    assert.equal(md.path, 'report.md');
    assert.equal(manifest.overallStatus, 'completed');
    assert.ok(manifest.issues.some((i) => /was kept/.test(i.message)), 'the failed attempt is reported');
    assert.ok((await fsp.readFile(path.join(out, 'index.html'), 'utf8')).includes('href="report.md"'));
  `,
  );
  assert.equal(
    await readFile(path.join(f.out, "report.md"), "utf8"),
    before,
    "prior export bytes untouched",
  );
});
