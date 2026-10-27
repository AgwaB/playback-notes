import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readlink,
  readFile,
  writeFile,
  mkdir,
  stat,
  symlink,
  access,
  constants,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { install } from "../scripts/install.mjs";

const windows = process.platform === "win32";
const linkDirectory = (target, link) =>
  symlink(target, link, windows ? "junction" : "dir");

test("install makes files read-only, relinks only directory links, and replaces only its own previous install", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vs-install-"));
  t.after(async () => {
    const { chmod } = await import("node:fs/promises");
    const unlock = async (p) => {
      const s = await stat(p).catch(() => null);
      if (!s) return;
      await chmod(p, s.mode | 0o200);
      if (s.isDirectory())
        for (const n of await (await import("node:fs/promises")).readdir(p))
          await unlock(path.join(p, n));
    };
    await unlock(root);
    await rm(root, { recursive: true, force: true });
  });
  const target = path.join(root, "agents", "video-summarizer");
  const claude = path.join(root, "claude", "video-summarizer");
  const realDir = path.join(root, "codex", "video-summarizer");
  await mkdir(path.dirname(claude), { recursive: true });
  await linkDirectory(path.join(root, "nonexistent", "dev-tree"), claude);
  await mkdir(realDir, { recursive: true });
  await writeFile(path.join(realDir, "keep.txt"), "mine");
  const out = await install({
    target,
    link: `${claude},${realDir}`,
    withDependencies: false,
  });
  assert.equal(out.status, "ok");
  for (const part of [
    "SKILL.md",
    "lib/output.mjs",
    "templates/report.html",
    "references/execution.md",
    ".video-summarizer-install.json",
  ])
    await access(path.join(target, part));
  await assert.rejects(
    access(path.join(target, "tests")),
    "tests are not installed",
  );
  await access(path.join(target, "docs", "windows-support.md"));
  await access(path.join(target, "references", "wsl.md"));
  await assert.rejects(
    access(path.join(target, "lib", "view.mjs"), constants.W_OK),
    "files are read-only",
  );
  if (!windows)
    await assert.rejects(
      writeFile(path.join(target, "lib", "patched.mjs"), "x"),
      "POSIX directory permissions prevent creating files",
    );
  assert.equal(await readlink(claude), target, "symlink re-pointed");
  assert.ok(
    (await stat(realDir)).isDirectory() &&
      out.issues.some((i) => i.code === "LINK_SKIPPED"),
    "real directory untouched",
  );
  assert.equal(await readFile(path.join(realDir, "keep.txt"), "utf8"), "mine");
  // Re-install replaces its own previous install.
  assert.equal(
    (await install({ target, link: `${claude},${claude}`, withDependencies: false })).status,
    "ok",
  );
  assert.equal(await readlink(claude), target, "existing directory link replaced");
  assert.deepEqual(
    await (await import("node:fs/promises")).readdir(path.dirname(claude)),
    ["video-summarizer"],
    "no previous junction left after commit",
  );
  // A foreign directory at the target is refused.
  const foreign = path.join(root, "foreign");
  await mkdir(foreign);
  await writeFile(path.join(foreign, "keep.txt"), "mine");
  await assert.rejects(install({ target: foreign, withDependencies: false }), {
    code: "OUTPUT_EXISTS",
  });
});

test("a failed staging operation leaves the previous install usable; invalid markers do not authorise replacement", async (t) => {
  const { chmod, readdir, readFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "vs-install5-"));
  const unlock = async (p) => {
    const s = await stat(p).catch(() => null);
    if (!s) return;
    await chmod(p, s.mode | 0o200);
    if (s.isDirectory())
      for (const n of await readdir(p)) await unlock(path.join(p, n));
  };
  t.after(async () => {
    await unlock(root);
    await rm(root, { recursive: true, force: true });
  });
  const parent = path.join(root, "agents");
  const target = path.join(parent, "video-summarizer");
  await mkdir(parent);
  assert.equal(
    (await install({ target, withDependencies: false })).status,
    "ok",
  );
  const before = await readFile(path.join(target, "SKILL.md"), "utf8");
  await assert.rejects(
    install({
      target,
      withDependencies: false,
      afterStaging: () => {
        throw new Error("staging failed");
      },
    }),
    /staging failed/,
  );
  // Windows read-only directory attributes do not enforce a write ACL.
  if (!windows) {
    await chmod(parent, 0o555);
    await assert.rejects(install({ target, withDependencies: false }));
    await chmod(parent, 0o755);
  }
  assert.equal(
    await readFile(path.join(target, "SKILL.md"), "utf8"),
    before,
    "previous install intact",
  );
  assert.deepEqual(
    (await readdir(parent)).sort(),
    ["video-summarizer"],
    "no staging leftovers",
  );
  // A directory named like the marker is not ownership.
  const foreign = path.join(root, "foreign");
  await mkdir(path.join(foreign, ".video-summarizer-install.json"), {
    recursive: true,
  });
  await writeFile(path.join(foreign, "keep.txt"), "mine");
  await assert.rejects(install({ target: foreign, withDependencies: false }), {
    code: "OUTPUT_EXISTS",
  });
  assert.equal(await readFile(path.join(foreign, "keep.txt"), "utf8"), "mine");
});

test("round 5: renderer identity refuses a symlink in the runtime tree (its referent could change unhashed)", async (t) => {
  const { cp } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "vs-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL("..", import.meta.url));
  for (const part of ["lib", "templates", "schemas", "scripts", "package.json"])
    await cp(path.join(repo, part), path.join(root, part), { recursive: true });
  await linkDirectory(path.join(repo, "node_modules"), path.join(root, "node_modules"));
  const outputUrl = pathToFileURL(path.join(root, "lib", "output.mjs"));
  const copy = await import(`${outputUrl.href}?clean`);
  assert.match((await copy.rendererIdentity()).sha256, /^[a-f0-9]{64}$/);
  await mkdir(path.join(root, "shared"));
  await writeFile(path.join(root, "shared", "extra.html"), "<p>outside</p>");
  await linkDirectory(
    path.join(root, "shared"),
    path.join(root, "templates", "external"),
  );
  const linked = await import(`${outputUrl.href}?linked`);
  await assert.rejects(linked.rendererIdentity(), { code: "UNSAFE_PATH" });
});

test("round 6: swap, permission and link failures roll back to the previous install and links; a target that appears during staging is never replaced; one installer at a time", async (t) => {
  const { chmod, readdir, readFile, readlink } = await import(
    "node:fs/promises"
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "vs-install6-"));
  const unlock = async (p) => {
    const s = await stat(p).catch(() => null);
    if (!s) return;
    await chmod(p, s.mode | 0o200);
    if (s.isDirectory())
      for (const n of await readdir(p)) await unlock(path.join(p, n));
  };
  t.after(async () => {
    await unlock(root);
    await rm(root, { recursive: true, force: true });
  });
  const parent = path.join(root, "agents");
  const target = path.join(parent, "video-summarizer");
  const hostLink = path.join(root, "host", "video-summarizer");
  const newLink = path.join(root, "new-host", "video-summarizer");
  const elsewhere = path.join(root, "old-skill");
  await mkdir(elsewhere);
  await mkdir(path.dirname(hostLink));
  await linkDirectory(elsewhere, hostLink);
  assert.equal(
    (await install({ target, withDependencies: false })).status,
    "ok",
  );
  const marker = await readFile(
    path.join(target, ".video-summarizer-install.json"),
    "utf8",
  );
  for (const faultAt of ["swap", "chmod", "link", "link-swap", "linked"]) {
    await assert.rejects(
      install({ target, link: `${hostLink},${newLink}`, withDependencies: false, faultAt }),
      /injected/,
    );
    assert.equal(
      await readFile(
        path.join(target, ".video-summarizer-install.json"),
        "utf8",
      ),
      marker,
      `${faultAt}: previous install restored`,
    );
    assert.equal(
      (await stat(path.join(target, "SKILL.md"))).mode & 0o222,
      0,
      `${faultAt}: files still read-only`,
    );
    assert.equal(
      await readlink(hostLink),
      elsewhere,
      `${faultAt}: host link restored`,
    );
    await assert.rejects(access(newLink), `${faultAt}: newly created link removed`);
    assert.deepEqual(
      await readdir(path.dirname(hostLink)),
      ["video-summarizer"],
      `${faultAt}: no temporary link left`,
    );
    assert.deepEqual(
      (await readdir(parent)).sort(),
      ["video-summarizer"],
      `${faultAt}: no staging/previous/lock left`,
    );
  }
  // Initially absent target created by someone else during staging: refused, untouched.
  const fresh = path.join(root, "fresh", "video-summarizer");
  await assert.rejects(
    install({
      target: fresh,
      withDependencies: false,
      afterStaging: async () => {
        await mkdir(fresh);
        await writeFile(path.join(fresh, "keep.txt"), "mine");
      },
    }),
    { code: "OUTPUT_EXISTS" },
  );
  assert.equal(await readFile(path.join(fresh, "keep.txt"), "utf8"), "mine");
  // A concurrent installer is refused while the lock is held.
  await mkdir(`${target}.install-lock`);
  await assert.rejects(install({ target, withDependencies: false }), {
    code: "BUSY",
  });
  await rm(`${target}.install-lock`, { recursive: true });
  assert.equal(
    (await install({ target, link: hostLink, withDependencies: false })).status,
    "ok",
  );
  assert.equal(await readlink(hostLink), target);
});
