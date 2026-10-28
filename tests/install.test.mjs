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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { install } from "../scripts/install.mjs";

const windows = process.platform === "win32";
const linkDirectory = (target, link) =>
  symlink(target, link, windows ? "junction" : "dir");
const execute = promisify(execFile);

async function isolatedInstaller(t) {
  const { cp, chmod, lstat, readdir, realpath } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vs-install-dependencies-")));
  t.after(async () => {
    const writable = async (file) => {
      const info = await lstat(file);
      if (info.isSymbolicLink()) return;
      await chmod(file, info.mode | 0o200);
      if (info.isDirectory()) for (const name of await readdir(file)) await writable(path.join(file, name));
    };
    await writable(root);
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source"), target = path.join(root, "installed");
  await mkdir(path.join(source, "scripts"), { recursive: true });
  await mkdir(path.join(source, "lib"));
  const repo = fileURLToPath(new URL("..", import.meta.url));
  for (const part of ["scripts/install.mjs", "lib/cli.mjs", "lib/io.mjs"])
    await cp(path.join(repo, part), path.join(source, part));
  await writeFile(path.join(source, "package.json"), JSON.stringify({ type: "module", dependencies: { "vs-install-probe": "1.0.0" } }));
  // The fixture uses the real installer but a tiny renderer dependency: no network
  // install or copied development node_modules can mask the packaging boundary.
  await writeFile(path.join(source, "lib/output.mjs"), `import value from 'vs-install-probe'; export async function rendererIdentity() { return { name: value, version: '1', sha256: '${"a".repeat(64)}' }; }`);
  await writeFile(path.join(source, "scripts/probe.mjs"), "import value from 'vs-install-probe'; console.log(value);");
  const dependencies = async (directory) => {
    const pkg = path.join(directory, "vs-install-probe");
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "vs-install-probe", version: "1.0.0", type: "module", main: "index.mjs", dependencies: { "vs-install-helper": "1.0.0" } }));
    await writeFile(path.join(pkg, "index.mjs"), "export { default } from 'vs-install-helper';");
    const helper = path.join(directory, "vs-install-helper");
    await mkdir(helper);
    await writeFile(path.join(helper, "package.json"), JSON.stringify({ name: "vs-install-helper", version: "1.0.0", type: "module", main: "index.mjs" }));
    await writeFile(path.join(helper, "index.mjs"), "export default 'self-contained dependency';");
  };
  const run = (file, args = []) => execute(process.execPath, [file, ...args], {
    cwd: root, env: { ...process.env, NODE_PATH: "" }, timeout: 20000, windowsHide: true,
  });
  return { root, source, target, dependencies, run };
}

test("install refuses missing or incomplete local dependencies even when an ancestor can resolve them", async (t) => {
  const f = await isolatedInstaller(t);
  await f.dependencies(path.join(f.root, "node_modules"));
  assert.equal((await f.run(path.join(f.source, "scripts/probe.mjs"))).stdout.trim(), "self-contained dependency");
  for (const incomplete of [false, true]) {
    if (incomplete) await mkdir(path.join(f.source, "node_modules"));
    await assert.rejects(f.run(path.join(f.source, "scripts/install.mjs"), ["--target", f.target]), (error) => {
      assert.equal(error.code, 3);
      const envelope = JSON.parse(error.stdout);
      assert.equal(envelope.status, "needs-input");
      assert.equal(envelope.issues[0].code, "CAPABILITY_MISSING");
      assert.match(envelope.issues[0].message, /npm ci/);
      assert.doesNotMatch(error.stderr, /ERR_MODULE_NOT_FOUND/);
      return true;
    });
    await assert.rejects(access(f.target));
    await assert.rejects(access(`${f.target}.install-lock`));
  }
});

test("install materializes a linked dependency root and remains usable after source and shared dependencies move", async (t) => {
  const { lstat, rename } = await import("node:fs/promises");
  const f = await isolatedInstaller(t);
  const shared = path.join(f.root, "shared-tree", "node_modules");
  await f.dependencies(shared);
  await mkdir(path.join(shared, ".bin"));
  if (windows) await writeFile(path.join(shared, ".bin/probe.cmd"), "@echo fixture\r\n");
  else await symlink("../vs-install-probe/index.mjs", path.join(shared, ".bin/probe"));
  await linkDirectory(shared, path.join(f.source, "node_modules"));
  const installed = JSON.parse((await f.run(path.join(f.source, "scripts/install.mjs"), ["--target", f.target])).stdout);
  assert.equal(installed.status, "ok");
  const copied = await lstat(path.join(f.target, "node_modules"));
  assert.ok(copied.isDirectory() && !copied.isSymbolicLink());
  if (!windows) assert.equal(await readlink(path.join(f.target, "node_modules/.bin/probe")), "../vs-install-probe/index.mjs");
  // Both paths are inside this test's own mkdtemp root; the original dependency
  // location no longer exists when the new process loads the installed module.
  await rename(f.source, path.join(f.root, "source-unavailable"));
  await rename(shared, path.join(f.root, "dependencies-unavailable"));
  assert.equal((await f.run(path.join(f.target, "scripts/probe.mjs"))).stdout.trim(), "self-contained dependency");
});

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
    const retainedBefore = (await readdir(parent)).filter((name) => name.includes(".failed-")).length;
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
    const names = await readdir(parent);
    assert.deepEqual(names.filter((name) => !name.includes(".failed-")).sort(), ["video-summarizer"], `${faultAt}: no staging/previous/lock left`);
    const retained = names.filter((name) => name.includes(".failed-"));
    assert.equal(retained.length, retainedBefore + (faultAt === "swap" ? 0 : 1), "failed new copies are retained, not recursively deleted");
    for (const name of retained) assert.equal((await stat(path.join(parent, name, "SKILL.md"))).mode & 0o222, 0);
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

test("round 7 F5: a directory swapped in between the ownership check and the rename is restored, never deleted", async (t) => {
  const { chmod, readdir, readFile, rename } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "vs-install7-"));
  const unlock = async (p) => {
    const s = await stat(p).catch(() => null);
    if (!s) return;
    await chmod(p, s.mode | 0o200);
    if (s.isDirectory()) for (const n of await readdir(p)) await unlock(path.join(p, n));
  };
  t.after(async () => {
    await unlock(root);
    await rm(root, { recursive: true, force: true });
  });
  const target = path.join(root, "agents", "video-summarizer");
  await mkdir(path.dirname(target));
  assert.equal((await install({ target, withDependencies: false })).status, "ok");
  const ours = path.join(root, "moved-install");
  await assert.rejects(
    install({
      target,
      withDependencies: false,
      beforeSwap: async () => {
        // Someone moves our install away and puts their own directory (with a copied
        // marker) at the target after the check.
        await chmod(target, 0o755);
        await rename(target, ours);
        await mkdir(target);
        await writeFile(path.join(target, ".video-summarizer-install.json"), await readFile(path.join(ours, ".video-summarizer-install.json")));
        await writeFile(path.join(target, "keep.txt"), "mine");
      },
    }),
    { code: "OUTPUT_EXISTS" },
  );
  assert.equal(await readFile(path.join(target, "keep.txt"), "utf8"), "mine");
  assert.deepEqual((await readdir(path.dirname(target))).sort(), ["video-summarizer"], "no staging, previous or lock left");
  // R8-3: a failure between the ownership check and the swap still removes the staged copy.
  await rm(target, { recursive: true, force: true });
  await rename(ours, target);
  await assert.rejects(
    install({ target, withDependencies: false, beforeSwap: async () => { throw new Error("injected"); } }),
    /injected/,
  );
  assert.deepEqual((await readdir(path.dirname(target))).sort(), ["video-summarizer"], "staging removed");
});

test("previous installs are retained; a replacement during final retention is never chmod-ed or deleted", async (t) => {
  const { rename, chmod, lstat } = await import("node:fs/promises");
  const f = await isolatedInstaller(t);
  await install({ target: f.target, withDependencies: false });
  const saved = path.join(f.root, "saved-previous");
  let displaced, mode;
  const result = await install({ target: f.target, withDependencies: false, beforeRetain: async (previous) => {
    displaced = previous;
    await chmod(previous, 0o755);
    await rename(previous, saved);
    await mkdir(previous, { mode: 0o700 });
    await writeFile(path.join(previous, "keep.txt"), "unowned contents");
    mode = (await lstat(previous)).mode;
  } });
  assert.equal(result.status, "ok");
  assert.ok(result.issues.some((item) => item.code === "PREVIOUS_INSTALL_RETAINED" && item.message.includes(displaced)));
  assert.ok(result.issues.some((item) => item.code === "PREVIOUS_INSTALL_CHANGED"));
  assert.equal(await readFile(path.join(displaced, "keep.txt"), "utf8"), "unowned contents");
  assert.equal((await lstat(displaced)).mode, mode, "replacement directory permissions unchanged");
  await access(path.join(saved, "SKILL.md"));
  await access(path.join(f.target, "SKILL.md"));
});

test("rollback preserves a replacement target and reports the retained original instead of deleting either", async (t) => {
  const { rename, lstat, readdir } = await import("node:fs/promises");
  const f = await isolatedInstaller(t);
  await install({ target: f.target, withDependencies: false });
  const marker = await readFile(path.join(f.target, ".video-summarizer-install.json"), "utf8");
  let mode;
  await assert.rejects(install({ target: f.target, withDependencies: false, afterPublish: async () => {
    await rename(f.target, path.join(f.root, "new-copy-moved"));
    await mkdir(f.target, { mode: 0o700 });
    await writeFile(path.join(f.target, "keep.txt"), "user files");
    mode = (await lstat(f.target)).mode;
    throw new Error("injected post-publication failure");
  } }), (error) => {
    assert.match(error.message, /previous installation is retained/);
    return true;
  });
  assert.equal(await readFile(path.join(f.target, "keep.txt"), "utf8"), "user files");
  assert.equal((await lstat(f.target)).mode, mode);
  const previous = (await readdir(f.root)).find((name) => name.startsWith("installed.previous-"));
  assert.ok(previous);
  assert.equal(await readFile(path.join(f.root, previous, ".video-summarizer-install.json"), "utf8"), marker);
  if (!windows) assert.equal((await lstat(path.join(f.root, previous))).mode & 0o222, 0);
});
