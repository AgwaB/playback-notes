import { spawn } from "node:child_process";
import { isolatedEnvironment, stopLocalTool } from "./runtime.mjs";
import { networkError } from "./network.mjs";

const TEXT_LIMIT = 8 * 1024 * 1024;

/** Bounded argument-array subprocess, always with a freshly constructed environment. */
export async function runLocalTool(
  executable,
  args,
  {
    workDir,
    timeoutMs,
    signal,
    maxBytes = TEXT_LIMIT,
    onChunk,
    onStderr,
    classifyNativeFailure = false,
  } = {},
) {
  return await new Promise((resolve, reject) => {
    // POSIX: each tool leads its own process group, so stopping it also stops anything it
    // started — even after a launcher exits and leaves a child holding its pipes. Inside the
    // extraction worker the group is registered with the parent, which reaps it on
    // cancellation as well (the worker's own group no longer contains the tool).
    const posix = process.platform !== "win32";
    let proc;
    try {
      proc = spawn(executable, args, {
        cwd: workDir,
        env: isolatedEnvironment(workDir),
        shell: false,
        windowsHide: true,
        detached: posix,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // Node refuses .cmd/.bat without a shell (EINVAL) before any process starts.
      reject(
        networkError(
          "CAPABILITY_MISSING",
          "A required local executable could not be started.",
          !posix && /\.(?:cmd|bat)$/i.test(String(executable))
            ? "windows-script-wrapper"
            : undefined,
        ),
      );
      return;
    }
    const notifyGroup = (type) => {
      if (posix && proc.pid && process.connected)
        process.send({ type, pid: proc.pid }, () => {});
    };
    notifyGroup("tool-group");
    let bytes = 0,
      failure,
      settled = false,
      closed = false,
      stopped = false,
      stdout = [],
      writing = Promise.resolve();
    const stop = (err) => {
      failure ??= err;
      if (!closed && !stopped) {
        stopped = true;
        stopLocalTool(proc);
      }
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(failure);
      }
    };
    const timer = setTimeout(
      () => stop(networkError("TIMEOUT", "A local media tool timed out.")),
      Math.min(timeoutMs, 2147483647),
    );
    const abort = () =>
      stop(
        networkError(
          signal?.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED",
          "A local media tool was interrupted.",
        ),
      );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    proc.stderr.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        stop(
          networkError(
            "RESOURCE_LIMIT",
            "A local media tool exceeded its output budget.",
            "output-limit",
          ),
        );
        return;
      }
      try {
        onStderr?.(chunk);
      } catch {
        stop(
          networkError(
            "SOURCE_UNSUPPORTED",
            "A local media tool could not be monitored.",
          ),
        );
      }
    });
    proc.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        stop(
          networkError(
            "RESOURCE_LIMIT",
            "A local media tool exceeded its output budget.",
            "output-limit",
          ),
        );
        return;
      }
      if (onChunk) {
        proc.stdout.pause();
        writing = writing
          .then(() => onChunk(chunk))
          .catch(() =>
            stop(
              networkError(
                "RESOURCE_LIMIT",
                "A local media output could not be saved.",
              ),
            ),
          )
          .finally(() => proc.stdout.resume());
      } else stdout.push(chunk);
    });
    proc.on("error", () =>
      stop(
        networkError(
          "CAPABILITY_MISSING",
          "A required local executable is unavailable.",
        ),
      ),
    );
    proc.on("close", async (code) => {
      // Retire the group promptly, not at the end of a potentially long extraction. Reap
      // children with closed stdio too; delayed output writes must not signal an old PID.
      if (posix && !stopped) stopLocalTool(proc);
      closed = true;
      notifyGroup("tool-group-closed");
      // The deadline and cancellation stay armed until the queued writes have settled, so a
      // stalled final write cannot outlive the tool's own time budget.
      try {
        await writing;
      } catch {
        // Write failures were already recorded through `stop`.
      }
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (settled) return;
      settled = true;
      if (signal?.aborted && !failure)
        failure = networkError(
          signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED",
          "A local media tool was interrupted.",
        );
      if (failure || code !== 0)
        reject(
          failure ??
            networkError(
              "SOURCE_UNSUPPORTED",
              "A local media tool could not process the input.",
              classifyNativeFailure &&
                process.platform === "win32" &&
                [0xc0000135, 0xc000007b, 0xc0000142].includes(code >>> 0)
                ? "gpu-runtime-unavailable"
                : undefined,
            ),
        );
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}
