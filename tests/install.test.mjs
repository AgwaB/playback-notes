import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readlink, writeFile, mkdir, stat, symlink, access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { install } from "../scripts/install.mjs";

test("install makes a read-only copy, relinks only symlinks, and replaces only its own previous install", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vs-install-"));
  t.after(async () => {
    const { chmod } = await import("node:fs/promises");
    const unlock = async (p) => {
      const s = await stat(p).catch(() => null);
      if (!s) return;
      await chmod(p, s.mode | 0o200);
      if (s.isDirectory()) for (const n of await (await import("node:fs/promises")).readdir(p)) await unlock(path.join(p, n));
    };
    await unlock(root);
    await rm(root, { recursive: true, force: true });
  });
  const target = path.join(root, "agents", "video-summarizer");
  const claude = path.join(root, "claude", "video-summarizer");
  const realDir = path.join(root, "codex", "video-summarizer");
  await mkdir(path.dirname(claude), { recursive: true });
  await symlink("/nonexistent/dev-tree", claude);
  await mkdir(realDir, { recursive: true });
  const out = await install({ target, link: `${claude},${realDir}`, withDependencies: false });
  assert.equal(out.status, "ok");
  for (const part of ["SKILL.md", "lib/output.mjs", "templates/report.html", "references/execution.md", ".video-summarizer-install.json"])
    await access(path.join(target, part));
  await assert.rejects(access(path.join(target, "tests")), "tests are not installed");
  await assert.rejects(access(path.join(target, "lib", "view.mjs"), constants.W_OK), "files are read-only");
  await assert.rejects(writeFile(path.join(target, "lib", "patched.mjs"), "x"), "directories are read-only");
  assert.equal(await readlink(claude), target, "symlink re-pointed");
  assert.ok((await stat(realDir)).isDirectory() && out.issues.some((i) => i.code === "LINK_SKIPPED"), "real directory untouched");
  // Re-install replaces its own previous install.
  assert.equal((await install({ target, withDependencies: false })).status, "ok");
  // A foreign directory at the target is refused.
  const foreign = path.join(root, "foreign");
  await mkdir(foreign);
  await writeFile(path.join(foreign, "keep.txt"), "mine");
  await assert.rejects(install({ target: foreign, withDependencies: false }), { code: "OUTPUT_EXISTS" });
});
