import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const SAFE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

/** Keep tool discovery, but never ambient credentials, proxies or runtime options. */
export function isolatedEnvironment(workDir) {
  const windows = process.platform === "win32";
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH");
  return {
    PATH: windows ? process.env[pathKey] ?? "" : SAFE_PATH,
    HOME: workDir,
    TMPDIR: workDir,
    ...(windows ? {
      SystemRoot: process.env.SystemRoot,
      TEMP: workDir,
      TMP: workDir,
      USERPROFILE: workDir,
    } : {}),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP: "1",
    SUMMARIZE_DISABLE_LOCAL_TRANSCRIPTION: "1",
  };
}

/** Stop the extraction worker together with any native media tools it started. */
export function stopWorker(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // A minimal environment: the OS utility needs nothing from ours (no credentials,
    // proxies or runtime options).
    spawnSync(path.join(process.env.SystemRoot, "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore", timeout: 5000,
        env: { SystemRoot: process.env.SystemRoot }, cwd: process.env.SystemRoot });
    child.kill("SIGKILL");
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The process group may already have exited.
    }
  }
}

/**
 * POSIX process tree of `pid` from one `ps` snapshot. Local tools share the extraction
 * worker's process group (so cancelling extraction reaps everything), which means a
 * launcher's children are not reached by killing the launcher alone.
 */
function descendants(pid) {
  const ps = ["/bin/ps", "/usr/bin/ps"].find((candidate) => existsSync(candidate));
  if (!ps) return [];
  const listed = spawnSync(ps, ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000, maxBuffer: 8 * 1024 * 1024,
  });
  if (listed.status !== 0) return [];
  const children = new Map();
  for (const line of listed.stdout.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child > 0 && parent > 0) children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found = [];
  for (let queue = [pid]; queue.length; ) {
    const next = children.get(queue.shift()) ?? [];
    found.push(...next);
    queue.push(...next);
  }
  return found;
}

/** Stop a timed-out or cancelled local tool together with anything it started. */
export function stopLocalTool(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") return stopWorker(child);
  const tree = descendants(child.pid);
  child.kill("SIGKILL");
  for (const pid of tree)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
}
