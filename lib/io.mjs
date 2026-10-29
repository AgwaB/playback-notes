import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

export class AppError extends Error {
  constructor(code, message, exitCode = 1, issues = []) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.exitCode = exitCode;
    this.issues = issues;
  }
}
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
export const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const issue = (code, message, severity = "error", pointer = null) => ({
  code,
  severity,
  message,
  path: pointer,
  retryable: false,
});
export function within(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
/** Report-relative paths have the same meaning on POSIX and NTFS. */
export function assertRelativePath(relative) {
  if (
    typeof relative !== "string" ||
    path.isAbsolute(relative) ||
    /[\\<>:"|?*\u0000-\u001f]/.test(relative) ||
    relative
      .split("/")
      .some(
        (part) =>
          !part ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
      )
  )
    throw new AppError(
      "UNSAFE_PATH",
      "Asset path must be a safe portable relative path.",
    );
}
export async function regularFile(file, maxBytes = 32 * 1024 * 1024) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new AppError("UNSAFE_PATH", "Expected a regular, non-symlink file.");
  if (stat.size > maxBytes)
    throw new AppError(
      "RESOURCE_LIMIT",
      "File exceeds the configured size limit.",
    );
  return stat;
}
export async function readJson(file) {
  await regularFile(file);
  const bytes = await readFile(file);
  try {
    return { data: JSON.parse(bytes.toString("utf8")), sha256: sha256(bytes) };
  } catch {
    throw new AppError("INVALID_CONTRACT", "Input is not valid JSON.");
  }
}
export async function fileHash(file, signal) {
  signal?.throwIfAborted();
  await regularFile(file, Number.MAX_SAFE_INTEGER);
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(
    file,
    signal ? { signal } : undefined,
  ))
    hash.update(chunk);
  signal?.throwIfAborted();
  return hash.digest("hex");
}
export async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
// Check each existing ancestor before creating children. Never follow a symlink.
export async function safeDirectory(dir) {
  const absolute = path.resolve(dir);
  const parts = absolute
    .slice(path.parse(absolute).root.length)
    .split(path.sep)
    .filter(Boolean);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new AppError(
        "UNSAFE_PATH",
        "Directory path contains a symlink or non-directory.",
      );
  }
  return realpath(absolute);
}
export async function containedFile(
  root,
  relative,
  maxBytes = 32 * 1024 * 1024,
) {
  assertRelativePath(relative);
  const base = await realpath(root);
  const candidate = path.resolve(base, relative);
  if (!within(base, candidate))
    throw new AppError("UNSAFE_PATH", "Path escapes the permitted root.");
  await regularFile(candidate, maxBytes);
  const resolved = await realpath(candidate);
  if (!within(base, resolved))
    throw new AppError("UNSAFE_PATH", "Symlink escapes the permitted root.");
  return resolved;
}
export async function atomicWrite(root, relative, content, signal) {
  signal?.throwIfAborted();
  assertRelativePath(relative);
  const base = await safeDirectory(root);
  const target = path.resolve(base, relative);
  if (!within(base, target) || target === base)
    throw new AppError("UNSAFE_PATH", "Invalid output path.");
  await safeDirectory(path.dirname(target));
  if (await exists(target)) await regularFile(target, Number.MAX_SAFE_INTEGER);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let handle;
  try {
    signal?.throwIfAborted();
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, signal ? { signal } : undefined);
    signal?.throwIfAborted();
    await handle.sync();
    await handle.close();
    handle = null;
    signal?.throwIfAborted();
    await rename(temporary, target);
  } finally {
    try {
      await handle?.close();
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return target;
}
// As in proper-lockfile: the holder refreshes the lock's mtime while it writes, so a lock
// that has not been refreshed for LOCK_STALE_MS belongs to a writer that was killed (a
// closed terminal or a cancelled host never runs the release) and is taken over.
export const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 5_000;
export async function withLock(
  root,
  callback,
  { staleMs = LOCK_STALE_MS, updateMs = LOCK_UPDATE_MS } = {},
) {
  const base = await safeDirectory(root);
  const lock = path.join(base, ".write.lock");
  const busy = () =>
    new AppError(
      "BUSY",
      `Another writer owns this directory (its lock was refreshed within the last ${Math.round(staleMs / 1000)} s). Do not remove a live lock.`,
    );
  const token = randomUUID();
  let handle,
    recovered = false;
  try {
    handle = await open(lock, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    recovered = await takeOverStaleLock(lock, `${lock}.${token}`, staleMs, busy);
    try {
      handle = await open(lock, "wx", 0o600);
    } catch (retry) {
      throw retry.code === "EEXIST" ? busy() : retry;
    }
  }
  let written = false,
    compromised = false,
    timer,
    mine = null;
  // This writer's lock is the file it created (same identity) still holding its token.
  const owned = async () => {
    try {
      const current = await lstat(lock);
      if (mine && (current.ino !== mine.ino || current.dev !== mine.dev))
        return false;
      return !written || (await readFile(lock, "utf8")) === token;
    } catch {
      return false;
    }
  };
  try {
    mine = await handle.stat();
    await handle.writeFile(token);
    written = true;
    timer = setInterval(async () => {
      try {
        if ((await readFile(lock, "utf8")) !== token) compromised = true;
        else {
          const now = new Date();
          await handle.utimes(now, now);
        }
      } catch (error) {
        if (error.code === "ENOENT") compromised = true;
      }
    }, updateMs);
    timer.unref();
    const result = await callback(base);
    // Checked again at the end: a takeover between refreshes must not pass as success.
    if (compromised || !(await owned()))
      throw new AppError(
        "LOCK_COMPROMISED",
        "Another writer took over this directory's lock while this one was still writing; check the output before using it.",
      );
    if (recovered && Array.isArray(result?.issues))
      result.issues.push(
        issue(
          "STALE_LOCK_RECOVERED",
          `A lock left by a writer that stopped without releasing it (not refreshed for ${Math.round(staleMs / 1000)} s) was replaced.`,
          "warning",
        ),
      );
    return result;
  } finally {
    clearInterval(timer);
    try {
      await handle.close();
    } finally {
      // Remove only this writer's lock: one taken over as stale belongs to its new owner.
      if (await owned()) await rm(lock, { force: true });
    }
  }
}
/**
 * Move a stale lock aside under a name only this writer uses, so that of several writers
 * that saw it stale exactly one moves it. A writer that finds it moved a different lock
 * (renewed after it looked) puts that lock back and reports the directory as busy.
 * Returns whether a stale lock was removed.
 */
async function takeOverStaleLock(lock, aside, staleMs, busy) {
  let seen;
  try {
    seen = await lstat(lock);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (Date.now() - seen.mtimeMs <= staleMs) throw busy();
  try {
    await rename(lock, aside);
  } catch (error) {
    // Another writer moved the stale lock first; whichever writer enters reports it.
    if (error.code === "ENOENT") return true;
    throw error;
  }
  let moved;
  try {
    moved = await lstat(aside);
  } catch (error) {
    // Windows renames through an open handle, which follows the file: a writer that opened
    // the stale lock before this rename can still move it on from this writer's name. That
    // writer took it; this one goes on as if it had removed the stale lock itself.
    if (error.code === "ENOENT") return true;
    throw error;
  }
  if (
    moved.ino === seen.ino &&
    moved.dev === seen.dev &&
    moved.mtimeMs === seen.mtimeMs &&
    Date.now() - moved.mtimeMs > staleMs
  ) {
    await rm(aside, { force: true });
    return true;
  }
  try {
    await link(aside, lock);
  } catch {
    // A new lock took its place, or links are unsupported: its owner sees the loss.
  }
  await rm(aside, { force: true });
  throw busy();
}
export async function checkOutputRoots(workDir, outDir, inputFiles = []) {
  const work = await realpath(workDir);
  const out = await safeDirectory(outDir);
  if (within(out, work) || within(work, out))
    throw new AppError(
      "UNSAFE_PATH",
      "Private work and public output roots must be separate.",
    );
  for (const input of inputFiles.filter(Boolean)) {
    const resolved = await realpath(input);
    if (within(out, resolved))
      throw new AppError(
        "UNSAFE_PATH",
        "Public output must not contain source or private input files.",
      );
  }
  return { work, out };
}
export async function artifact(
  root,
  relative,
  format,
  status = "created",
  signal,
) {
  signal?.throwIfAborted();
  const file = await containedFile(root, relative, Number.MAX_SAFE_INTEGER);
  const stat = await lstat(file);
  return {
    format,
    path: relative,
    status,
    bytes: stat.size,
    sha256: await fileHash(file, signal),
  };
}
