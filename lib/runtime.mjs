import { spawnSync } from "node:child_process";
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
    spawnSync(path.join(process.env.SystemRoot, "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore", timeout: 5000 });
    child.kill("SIGKILL");
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The process group may already have exited.
    }
  }
}

export function stopLocalTool(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") stopWorker(child);
  else child.kill("SIGKILL");
}
