import path from "node:path";
import os from "node:os";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
  const home = (value) => value.replace(/^~(?=\/|$)/, os.homedir());
  const target = path.resolve(
    options.target
      ? home(options.target)
      : path.join(os.homedir(), ".agents", "skills", "video-summarizer"),
  );
  if (path.resolve(source) === target)
    throw new AppError("INVALID_CONTRACT", "Target is the source tree.", 4);
  // Only a previous install (a regular, well-formed marker file) may be replaced.
  if (await exists(target)) {
    let owned = false;
    try {
      const info = await lstat(path.join(target, MARKER));
      const marker = info.isFile()
        ? JSON.parse(await readFile(path.join(target, MARKER), "utf8"))
        : null;
      owned =
        typeof marker?.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(marker.sha256) &&
        typeof marker.source === "string";
    } catch {
      owned = false;
    }
    if (!owned)
      throw new AppError(
        "OUTPUT_EXISTS",
        `${target} exists and is not a previous install; remove it or choose another --target.`,
        3,
      );
  }
  // Build the complete read-only copy beside the target, then swap: a failure at any
  // stage leaves the previous install untouched and usable.
  const stamp = randomUUID().slice(0, 8);
  const staging = `${target}.staging-${stamp}`;
  const identity = await rendererIdentity();
  try {
    await mkdir(staging, { recursive: true });
    // `withDependencies: false` is an offline-test seam (skips copying node_modules).
    for (const part of PARTS.filter(
      (p) => options.withDependencies !== false || p !== "node_modules",
    ))
      if (await exists(path.join(source, part)))
        await cp(path.join(source, part), path.join(staging, part), {
          recursive: true,
          verbatimSymlinks: true,
        });
    await writeFile(
      path.join(staging, MARKER),
      `${JSON.stringify({ ...identity, source, installedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    await setWritable(staging, false);
  } catch (error) {
    await setWritable(staging, true).catch(() => {});
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  // macOS refuses to rename a directory that is itself read-only, so only the two top
  // directories are made writable for the swap and read-only again afterwards.
  const topWritable = (dir, on) => chmod(dir, on ? 0o755 : 0o555);
  const previous = (await exists(target)) ? `${target}.previous-${stamp}` : null;
  if (previous) {
    await topWritable(target, true);
    await rename(target, previous);
  }
  try {
    await topWritable(staging, true);
    await rename(staging, target);
    await topWritable(target, false);
  } catch (error) {
    if (previous && !(await exists(target))) {
      await rename(previous, target);
      await topWritable(target, false).catch(() => {});
    }
    await setWritable(staging, true).catch(() => {});
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const cleanupIssues = [];
  if (previous)
    try {
      await setWritable(previous, true);
      await rm(previous, { recursive: true, force: true });
    } catch {
      cleanupIssues.push(
        issue(
          "PREVIOUS_INSTALL_LEFT",
          `The new install is in place; the previous copy could not be removed: ${previous}`,
          "warning",
        ),
      );
    }
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
  issues.push(...cleanupIssues);
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
