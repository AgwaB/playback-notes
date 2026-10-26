import test from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.mjs";
import { scaffold } from "../scripts/scaffold.mjs";
import { sha256 } from "../lib/io.mjs";

test("scaffold binds report.json to the exact evidence bytes, never overwrites without --force, and returns an authoring card", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await assert.rejects(
    scaffold({ request: f.args.request, evidence: f.args.evidence, "work-dir": f.work }),
    { code: "OUTPUT_EXISTS" },
    "the fixture already has report.json",
  );
  const out = await scaffold({ request: f.args.request, evidence: f.args.evidence, "work-dir": f.work, force: true });
  const report = JSON.parse(await readFile(path.join(f.work, "report.json"), "utf8"));
  assert.deepEqual(report.evidenceRef, { id: f.data.evidence.id, sha256: sha256(await readFile(f.args.evidence)) });
  assert.equal(report.mode, f.data.request.mode);
  assert.equal(report.outputLanguage, f.data.request.outputLanguage);
  assert.deepEqual([report.title, report.summary, report.sections, report.caveats], ["", [], [], []]);
  assert.ok(out.issues.every((i) => i.severity === "info"));
  assert.ok(out.issues.some((i) => /seg-000001/.test(i.message) && /chunk-00001/.test(i.message)));
});
