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
  "docs",
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
 * Install a copy with read-only files (default `~/.agents/skills/video-summarizer`) and
 * point host skill directories at it with directory links (junctions on Windows).
 * POSIX directory permissions also prevent creating files; Windows read-only directory
 * attributes do not enforce a write ACL. These permissions are not an isolation boundary.
 * Re-running replaces only a previous install (identified by its marker) and only
 * replaces directory links, never real directories.
 */
export async function install(options) {
  const source = fileURLToPath(new URL("..", import.meta.url));
  const home = (value) => value.replace(/^~(?=[\\/]|$)/, () => os.homedir());
  const target = path.resolve(
    options.target
      ? home(options.target)
      : path.join(os.homedir(), ".agents", "skills", "video-summarizer"),
  );
  if (path.resolve(source) === target)
    throw new AppError("INVALID_CONTRACT", "Target is the source tree.", 4);
  const links = [...new Set(
    (options.link ?? "")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => path.resolve(home(l))),
  )];
  // One installer per target at a time (mkdir is atomic); a crashed run leaves the lock,
  // which the error names.
  const lock = `${target}.install-lock`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new AppError(
      "BUSY",
      `Another install into ${target} is running (or crashed): remove ${lock} if none is.`,
      3,
    );
  }
  try {
    return await installLocked(options, source, target, links);
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}
/** Only a previous install (a regular, well-formed marker file) may be replaced. */
async function ownedInstall(dir) {
  try {
    const info = await lstat(path.join(dir, MARKER));
    const marker = info.isFile()
      ? JSON.parse(await readFile(path.join(dir, MARKER), "utf8"))
      : null;
    return (
      typeof marker?.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(marker.sha256) &&
      typeof marker.source === "string"
    );
  } catch {
    return false;
  }
}
const notOwned = (target) =>
  new AppError(
    "OUTPUT_EXISTS",
    `${target} exists and is not a previous install; remove it or choose another --target.`,
    3,
  );
async function installLocked(options, source, target, links) {
  const initiallyPresent = await exists(target);
  if (initiallyPresent && !(await ownedInstall(target))) throw notOwned(target);
  // Build the complete read-only copy beside the target, then swap: a failure at any
  // stage leaves the previous install untouched and usable.
  const stamp = randomUUID().slice(0, 8);
  const staging = `${target}.staging-${stamp}`;
  const identity = await rendererIdentity();
  const dropStaging = async () => {
    await setWritable(staging, true).catch(() => {});
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  };
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
    await options.afterStaging?.(); // offline-test seam
  } catch (error) {
    await dropStaging();
    throw error;
  }
  // Ownership again, right before the swap: whatever sits at the target now must be the
  // install checked above. A target that appeared meanwhile is never replaced.
  const present = await exists(target);
  if (present !== initiallyPresent || (present && !(await ownedInstall(target)))) {
    await dropStaging();
    throw notOwned(target);
  }
  // Everything from here to the last link is one transaction: on any failure the links are
  // restored, the new copy removed and the previous install moved back, read-only.
  // macOS refuses to rename a directory that is itself read-only, so only the two top
  // directories are made writable for the swap and read-only again afterwards.
  const topWritable = (dir, on) => chmod(dir, on ? 0o755 : 0o555);
  const previous = present ? `${target}.previous-${stamp}` : null;
  let swapped = false;
  const relinked = []; // { link, before: string|null, backup: string|null }
  const fault = (stage) => {
    if (options.faultAt === stage) throw new Error(`injected ${stage} failure`);
  };
  const pointAt = async (link, value, present = false) => {
    // POSIX can rename over a link atomically. Windows junctions require moving the old
    // link aside first; retain it until the whole install commits so rollback preserves it.
    const temp = `${link}.tmp-${stamp}`;
    let backup = null;
    await symlink(value, temp, process.platform === "win32" ? "junction" : "dir");
    try {
      if (process.platform === "win32" && present) {
        backup = `${link}.previous-${stamp}`;
        await rename(link, backup);
        // A real directory that appeared after the initial check must be restored intact.
        if (!(await lstat(backup)).isSymbolicLink())
          throw new AppError("OUTPUT_EXISTS", `${link} changed to a real directory.`, 3);
      }
      fault("link-swap");
      await rename(temp, link);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      if (backup) await rename(backup, link).catch(() => {});
      throw error;
    }
    return backup;
  };
  const issues = [];
  try {
    if (previous) {
      await topWritable(target, true);
      fault("swap");
      await rename(target, previous);
    }
    await topWritable(staging, true);
    await rename(staging, target);
    swapped = true;
    fault("chmod");
    await topWritable(target, false);
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
      const before = current ? await readlink(link) : null;
      await mkdir(path.dirname(link), { recursive: true });
      fault("link");
      const backup = await pointAt(link, target, current !== null);
      relinked.push({ link, before, backup });
      issues.push(
        issue(
          "LINKED",
          `${link} → ${target}${before ? ` (previously → ${before})` : ""}`,
          "info",
        ),
      );
    }
    fault("linked");
  } catch (error) {
    for (const { link, before, backup } of relinked.reverse())
      await (async () => {
        if (backup) {
          await rm(link, { force: true });
          await rename(backup, link);
        } else if (before) await pointAt(link, before);
        else await rm(link, { force: true });
      })().catch(() => {});
    if (swapped) {
      await setWritable(target, true).catch(() => {});
      await rm(target, { recursive: true, force: true }).catch(() => {});
    }
    if (previous && (await exists(previous)) && !(await exists(target)))
      await rename(previous, target).catch(() => {});
    if (present) await topWritable(target, false).catch(() => {});
    await dropStaging();
    throw error;
  }
  for (const { backup } of relinked)
    if (backup)
      await rm(backup, { force: true }).catch(() => {
        issues.push(
          issue("PREVIOUS_LINK_LEFT", `The previous link could not be removed: ${backup}`, "warning"),
        );
      });
  if (previous)
    try {
      await setWritable(previous, true);
      await rm(previous, { recursive: true, force: true });
    } catch {
      issues.push(
        issue(
          "PREVIOUS_INSTALL_LEFT",
          `The new install is in place; the previous copy could not be removed: ${previous}`,
          "warning",
        ),
      );
    }
  issues.unshift(
    issue(
      "INSTALLED",
      `${identity.name} ${identity.version ?? ""} installed with read-only files at ${target} (renderer ${identity.sha256.slice(0, 12)}).`,
      "info",
    ),
  );
  return result("install", [], issues);
}
if (isMain(import.meta.url))
  await runCli("install", () => install(optionsFor(["target", "link"])));
