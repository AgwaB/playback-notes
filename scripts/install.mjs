import path from "node:path";
import os from "node:os";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isMain, optionsFor, result, runCli } from "../lib/cli.mjs";
import { AppError, exists, issue } from "../lib/io.mjs";

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
  const links = [
    ...new Set(
      (options.link ?? "")
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => path.resolve(home(l))),
    ),
  ];
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
    const root = await lstat(dir);
    if (!root.isDirectory() || root.isSymbolicLink()) return false;
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
async function dependencyDirectory(source) {
  try {
    const directory = await realpath(path.join(source, "node_modules"));
    if (!(await lstat(directory)).isDirectory()) throw new Error();
    const pkg = JSON.parse(
      await readFile(path.join(source, "package.json"), "utf8"),
    );
    for (const name of Object.keys(pkg.dependencies ?? {}))
      if (!(await lstat(path.join(directory, name, "package.json"))).isFile())
        throw new Error();
    return directory;
  } catch {
    throw new AppError(
      "CAPABILITY_MISSING",
      "The source's runtime dependencies are missing or incomplete. Run npm ci in the source directory before installing.",
      3,
    );
  }
}
async function installLocked(options, source, target, links) {
  const initiallyPresent = await exists(target);
  if (initiallyPresent && !(await ownedInstall(target))) throw notOwned(target);
  // Build the complete read-only copy beside the target, then swap: a failure at any
  // stage leaves the previous install untouched and usable.
  const stamp = randomUUID().slice(0, 8);
  const staging = `${target}.staging-${stamp}`;
  const dependencies =
    options.withDependencies === false
      ? null
      : await dependencyDirectory(source);
  // Check dependencies before importing the renderer, so a fresh checkout gets a
  // useful install error rather than a top-level module-resolution exception.
  const { rendererIdentity } = await import("../lib/output.mjs");
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
    )) {
      const from =
        part === "node_modules" ? dependencies : path.join(source, part);
      if (part === "node_modules" || (await exists(from)))
        // Materialize a linked dependency root; preserve relative links inside it
        // (such as .bin) so the installed copy remains independent of its source.
        await cp(from, path.join(staging, part), {
          recursive: true,
          verbatimSymlinks: true,
        });
    }
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
  if (
    present !== initiallyPresent ||
    (present && !(await ownedInstall(target)))
  ) {
    await dropStaging();
    throw notOwned(target);
  }
  // The exact directory checked: whatever is renamed aside must be this one, or a
  // replacement made between the check and the rename would be deleted as "previous".
  const identityOf = async (dir) => {
    const info = await lstat(dir, { bigint: true });
    return `${info.dev}:${info.ino}`;
  };
  let claimed = null,
    staged;
  try {
    staged = await identityOf(staging);
    claimed = present ? await identityOf(target) : null;
    await options.beforeSwap?.(); // offline-test seam
  } catch (error) {
    await dropStaging();
    throw error;
  }
  // POSIX chmod is descriptor-bound: a pathname replacement cannot change permissions
  // on another directory. Windows directory read-only attributes are not a write ACL and
  // do not need toggling for rename; leave them alone instead of chmod-ing by pathname.
  const topWritable = async (dir, on, expected) => {
    if (process.platform === "win32") {
      if ((await identityOf(dir)) !== expected) throw notOwned(dir);
      return;
    }
    const handle = await open(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isDirectory() || `${info.dev}:${info.ino}` !== expected)
        throw notOwned(dir);
      await handle.chmod(on ? 0o755 : 0o555);
    } finally {
      await handle.close();
    }
  };
  const recovery = (error, message) => {
    error.message += ` ${message}`;
    error.cleanupNote = `${error.cleanupNote ?? ""} ${message}`;
  };
  const previous = present ? `${target}.previous-${stamp}` : null;
  let swapped = false,
    foreign = false;
  const relinked = []; // { link, before: string|null, backup: string|null }
  const fault = (stage) => {
    if (options.faultAt === stage) throw new Error(`injected ${stage} failure`);
  };
  const pointAt = async (link, value, present = false) => {
    // POSIX can rename over a link atomically. Windows junctions require moving the old
    // link aside first; retain it until the whole install commits so rollback preserves it.
    const temp = `${link}.tmp-${stamp}`;
    let backup = null;
    await symlink(
      value,
      temp,
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      if (process.platform === "win32" && present) {
        backup = `${link}.previous-${stamp}`;
        await rename(link, backup);
        // A real directory that appeared after the initial check must be restored intact.
        if (!(await lstat(backup)).isSymbolicLink())
          throw new AppError(
            "OUTPUT_EXISTS",
            `${link} changed to a real directory.`,
            3,
          );
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
      await topWritable(target, true, claimed);
      fault("swap");
      await rename(target, previous);
      if (
        (await identityOf(previous)) !== claimed ||
        !(await ownedInstall(previous))
      ) {
        foreign = true;
        // Put it back untouched; if that is impossible, say where it is rather than
        // changing whatever now occupies the target.
        try {
          await rename(previous, target);
        } catch {
          throw new AppError(
            "OUTPUT_EXISTS",
            `${target} was replaced during installation; the directory found there was moved to ${previous} and could not be put back. Restore it by hand.`,
            3,
          );
        }
        throw notOwned(target);
      }
    }
    await topWritable(staging, true, staged);
    await rename(staging, target);
    swapped = true;
    await options.afterPublish?.(); // offline-test seam, never a CLI option
    fault("chmod");
    await topWritable(target, false, staged);
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
      // Never recursively delete a live install pathname during rollback. Retain the failed
      // copy for recovery; an unexpected occupant is not moved or chmod-ed.
      const failed = `${target}.failed-${stamp}`;
      try {
        await topWritable(target, true, staged);
        await rename(target, failed);
        await topWritable(failed, false, staged);
        recovery(error, `The failed new copy was retained at ${failed}.`);
      } catch {
        recovery(
          error,
          `Rollback could not safely move the current target; inspect ${target} and ${failed}.`,
        );
      }
    }
    if (previous && !foreign && (await exists(previous))) {
      try {
        if (await exists(target)) throw notOwned(target);
        await topWritable(previous, true, claimed);
        await rename(previous, target);
      } catch {
        await topWritable(previous, false, claimed).catch(() => {});
        recovery(
          error,
          `The previous installation is retained at ${previous}; restore it manually after checking the target.`,
        );
      }
    }
    if (present && !foreign)
      await topWritable(target, false, claimed).catch(() => {});
    await dropStaging();
    throw error;
  }
  for (const { backup } of relinked)
    if (backup)
      await rm(backup, { force: true }).catch(() => {
        issues.push(
          issue(
            "PREVIOUS_LINK_LEFT",
            `The previous link could not be removed: ${backup}`,
            "warning",
          ),
        );
      });
  if (previous) {
    await options.beforeRetain?.(previous); // offline-test seam, never a CLI option
    try {
      await topWritable(previous, false, claimed);
    } catch {
      issues.push(
        issue(
          "PREVIOUS_INSTALL_CHANGED",
          `The displaced directory changed; it was not modified: ${previous}`,
          "warning",
        ),
      );
    }
    // Node has no portable descriptor-relative recursive removal. Keeping the previous
    // tree avoids deleting a replacement between a final identity check and rm().
    issues.push(
      issue(
        "PREVIOUS_INSTALL_RETAINED",
        `Previous installation retained for recovery at ${previous}. After verifying the new install, remove it manually if no longer needed.`,
        "info",
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
