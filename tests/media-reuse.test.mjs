import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fixture } from "./helpers.mjs";
import { fileHash, jsonBytes, sha256 } from "../lib/io.mjs";
import { render } from "../scripts/render.mjs";
import { exportReport } from "../scripts/export.mjs";

// Minimal JPEG markers suffice for the output contract; the fixture is never decoded.
const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
async function copiedFixture(t) {
  const f = await fixture({ mutate(d) {
    d.request.formats = ["html", "markdown"];
    d.request.policy.copyLocalMedia = true;
    d.evidence.source.playback = { kind: "native", locator: "media:fixture" };
    d.evidence.frames = [{ id: "frame-reuse", timestampMs: 1000, assetPath: "assets/frame.jpg",
      sha256: sha256(image), width: 1, height: 1, ocrText: null }];
    d.analysis.inspectedFrameIds = ["frame-reuse"];
    d.report.sections[0].blocks.push({ type: "figure", frameId: "frame-reuse", alt: "fixture",
      caption: { text: "fixture", attribution: "source", citations: [{ kind: "frame", id: "frame-reuse" }] } });
  } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await mkdir(path.join(f.work, "assets"));
  await writeFile(path.join(f.work, "assets", "frame.jpg"), image);
  const source = path.join(f.root, "source.mp4");
  await writeFile(source, Buffer.alloc(1048576, 7));
  await writeFile(path.join(f.work, "manifest.json"), jsonBytes({
    evidenceSha256: f.data.evidenceSha256, sourceId: f.data.evidence.source.id,
    mediaPath: source, mediaSha256: await fileHash(source),
  }));
  await render(f.args);
  return { ...f, source, media: path.join(f.out, "media", f.data.evidence.source.id), image: path.join(f.out, "assets", "frame.jpg") };
}

test("same-revision exports reuse verified media and images without replacing their files", async (t) => {
  const f = await copiedFixture(t);
  const beforeMedia = await stat(f.media, { bigint: true });
  const beforeImage = await stat(f.image, { bigint: true });
  for (let i = 0; i < 2; i++) {
    const result = await exportReport({ ...f.args, formats: "markdown" });
    assert.equal(result.status, "ok");
    for (const [file, before] of [[f.media, beforeMedia], [f.image, beforeImage]]) {
      const after = await stat(file, { bigint: true });
      assert.equal(after.ino, before.ino);
      assert.equal(after.mtimeNs, before.mtimeNs);
      assert.equal(after.ctimeNs, before.ctimeNs);
    }
    const manifest = JSON.parse(await readFile(path.join(f.out, "manifest.json"), "utf8"));
    assert.equal(manifest.media.status, "reused");
    assert.equal(manifest.assets[0].status, "reused");
  }
});

test("re-export refuses tampered copied media or images instead of silently repairing them", async (t) => {
  const f = await copiedFixture(t);
  const media = await readFile(f.media);
  await writeFile(f.media, Buffer.alloc(media.length, 9));
  await assert.rejects(exportReport({ ...f.args, formats: "markdown" }), { code: "EVIDENCE_MISMATCH" });
  assert.equal((await readFile(f.media))[0], 9);
  await writeFile(f.media, media);
  await writeFile(f.image, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  await assert.rejects(exportReport({ ...f.args, formats: "markdown" }), { code: "EVIDENCE_MISMATCH" });
  assert.equal((await readFile(f.image)).at(-1), 0);
});
