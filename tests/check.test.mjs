import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

async function checkerFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vs-public-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["scripts", "schemas", "references", "internal"])
    await mkdir(path.join(root, directory));
  const script = path.join(root, "scripts", "check.mjs");
  await copyFile(new URL("../scripts/check.mjs", import.meta.url), script);
  for (const name of ["prepare", "validate", "render", "export", "serve"])
    await writeFile(path.join(root, "scripts", `${name}.mjs`), "export {};\n");
  for (const name of ["evidence", "report"])
    await writeFile(path.join(root, "schemas", `${name}.schema.json`), "{}\n");
  await writeFile(
    path.join(root, "SKILL.md"),
    "[Guide](references/public.md)\n",
  );
  await writeFile(
    path.join(root, "references", "public.md"),
    "# Public guide\n",
  );
  await writeFile(
    path.join(root, "internal", "notes.md"),
    "[Old note](missing.md)\n",
  );
  await writeFile(path.join(root, "internal", "draft.json"), "not JSON");
  await writeFile(
    path.join(root, "internal", "draft.mjs"),
    "not valid JavaScript",
  );
  const run = () =>
    execute(process.execPath, [script], {
      cwd: root,
      timeout: 30000,
      windowsHide: true,
    });
  return { root, run };
}

test("public checks do not inspect ignored internal drafts", async (t) => {
  const fixture = await checkerFixture(t);
  const result = JSON.parse((await fixture.run()).stdout);
  assert.equal(result.status, "passed");
  assert.deepEqual(result.errors, []);
  assert.equal(result.counts.markdown, 2);
  assert.equal(result.counts.json, 2);
});

test("public checks reject links into internal even when the target exists", async (t) => {
  const fixture = await checkerFixture(t);
  await writeFile(
    path.join(fixture.root, "references", "public.md"),
    "[Private](../internal/notes.md)\n[Encoded](../%69nternal/notes.md)\n",
  );
  await assert.rejects(fixture.run(), (error) => {
    assert.equal(error.code, 1);
    const result = JSON.parse(error.stdout);
    assert.equal(result.status, "failed");
    assert.equal(result.errors.length, 2);
    for (const message of result.errors)
      assert.match(message, /link to internal document/);
    return true;
  });
});
