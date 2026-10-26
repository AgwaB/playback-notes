import path from "node:path";
import os from "node:os";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isMain, optionsFor, result, runCli } from "../lib/cli.mjs";
import { AppError, exists, issue } from "../lib/io.mjs";
import { rendererIdentity } from "../lib/output.mjs";

const PARTS = [
  "SKILL.md",
  "README.md",
  "package.json",
  "package-lock.json",
  "lib",
  "scripts",
  "schemas",
  "templates",
  "references",
  "node_modules",
];
const MARKER = ".video-summarizer-install.json";

async function setWritable(target, writable) {
  const info = await lstat(target);
  if (info.isSymbolicLink()) return;
  const mode = writable ? info.mode | 0o200 : info.mode & ~0o222;
  if (info.isDirectory()) {
    // Directories: make writable before descending, read-only after.
    if (writable) await chmod(target, mode & 0o7777);
    for (const name of await readdir(target))
      await setWritable(path.join(target, name), writable);
    if (!writable) await chmod(target, mode & 0o7777);
  } else await chmod(target, mode & 0o7777);
}

/**
 * Install this skill as a read-only copy (default `~/.agents/skills/video-summarizer`) and
 * point host skill directories at it with symlinks. A read-only copy keeps a host agent
 * running with broad file access from patching the skill mid-task (as a Codex run once
 * did through a development symlink). Re-running replaces only a previous install
 * (identified by its marker) and only replaces symlinks, never real directories.
 */
export async function install(options) {
  const source = fileURLToPath(new URL("..", import.meta.url));
  const target = path.resolve(
    options.target ??
      path.join(os.homedir(), ".agents", "skills", "video-summarizer"),
  );
  if (path.resolve(source) === target)
    throw new AppError("INVALID_CONTRACT", "Target is the source tree.", 4);
  if (await exists(target)) {
    if (!(await exists(path.join(target, MARKER))))
      throw new AppError(
        "OUTPUT_EXISTS",
        `${target} exists and is not a previous install; remove it or choose another --target.`,
        3,
      );
    await setWritable(target, true);
    await rm(target, { recursive: true, force: true });
  }
  await mkdir(target, { recursive: true });
  // `withDependencies: false` is an offline-test seam (skips copying node_modules).
  for (const part of PARTS.filter(
    (p) => options.withDependencies !== false || p !== "node_modules",
  ))
    if (await exists(path.join(source, part)))
      await cp(path.join(source, part), path.join(target, part), {
        recursive: true,
        verbatimSymlinks: true,
      });
  const identity = await rendererIdentity();
  await writeFile(
    path.join(target, MARKER),
    `${JSON.stringify({ ...identity, source, installedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  await setWritable(target, false);
  const links = (options.link ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => path.resolve(l.replace(/^~(?=\/|$)/, os.homedir())));
  const issues = [];
  for (const link of links) {
    let current = null;
    try {
      current = await lstat(link);
    } catch {
      current = null;
    }
    if (current && !current.isSymbolicLink()) {
      issues.push(
        issue(
          "LINK_SKIPPED",
          `${link} is a real directory, not a symlink; left untouched.`,
          "warning",
        ),
      );
      continue;
    }
    const previous = current ? await readlink(link) : null;
    if (current) await rm(link);
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(target, link);
    issues.push(
      issue(
        "LINKED",
        `${link} → ${target}${previous ? ` (previously → ${previous})` : ""}`,
        "info",
      ),
    );
  }
  issues.unshift(
    issue(
      "INSTALLED",
      `${identity.name} ${identity.version ?? ""} installed read-only at ${target} (renderer ${identity.sha256.slice(0, 12)}).`,
      "info",
    ),
  );
  return result("install", [], issues);
}
if (isMain(import.meta.url))
  await runCli("install", () => install(optionsFor(["target", "link"])));
