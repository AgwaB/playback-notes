import path from "node:path";
import { readAsrOutput } from "./asr-output.mjs";
import { runLocalTool } from "./local-tool.mjs";
import { networkError } from "./network.mjs";

// Only retain a short rolling window and fixed diagnostic flags, never tool logs or paths.
function monitor() {
  let tail = "",
    backend = "unknown",
    gpuFailure = false;
  return {
    observe(chunk) {
      tail = (tail + chunk.toString("utf8")).slice(-8192);
      const selected =
        /(?:^|[\r\n])whisper_backend_init_gpu:\s*using\s+(CUDA\d*|Metal\d*|Vulkan\d*)\s+backend/i.exec(
          tail,
        );
      if (selected) backend = selected[1].replace(/\d+$/, "").toLowerCase();
      // The upstream "using ... backend" line precedes device initialization. A later
      // failure means a successful process may have used CPU instead.
      if (
        /(?:^|[\r\n])whisper_backend_init_gpu:\s*(?:no GPU found|failed to initialize\s+(?:CUDA\d*|Metal\d*|Vulkan\d*)\s+backend)|(?:^|[\r\n])whisper_backend_init_gpu:\s*using CPU backend/i.test(
          tail,
        )
      )
        backend = "cpu";
      if (
        /(?:CUDA|Vulkan|Metal|ggml_cuda|ggml_vulkan|ggml_metal)[^\r\n]{0,160}(?:out of memory|allocation failed|failed to alloc|error|failed to initialize|init failed)/i.test(
          tail,
        ) ||
        /(?:out of memory|failed to alloc|failed to initialize)[^\r\n]{0,100}(?:CUDA|Vulkan|Metal)/i.test(
          tail,
        ) ||
        /(?:^|[\r\n])(?:dyld(?:\[\d+\])?:\s+Library not loaded:|[^\r\n]*error while loading shared libraries:)/i.test(
          tail,
        )
      )
        gpuFailure = true;
    },
    get backend() {
      return backend;
    },
    get gpuFailure() {
      return gpuFailure;
    },
  };
}

const gpuBackends = new Set(["cuda", "metal", "vulkan"]);

// Keep diagnostics bounded and avoid echoing native logs or user paths.
export function gpuFallbackWarning(
  fallback,
  { wsl = false, deviceAccessible = true } = {},
) {
  if (!fallback) return null;
  const reason =
    fallback === "gpu-failed"
      ? "failed during transcription"
      : "was unavailable";
  const deviceHint =
    wsl && !deviceAccessible
      ? " In WSL, /dev/dxg is unavailable or inaccessible to this process; check WSL GPU support and the host's device-access policy. A sandbox may hide the device."
      : "";
  return `The GPU runtime ${reason}; local ASR used the CPU. Check the compatible runtime and its native libraries.${deviceHint}`;
}

/** Probe a configured accelerated binary, then execute exactly one clean output attempt at a time. */
export async function transcribeWithAcceleration({
  cpuExecutable,
  gpuExecutable,
  modelPath,
  wavPath,
  workDir,
  timeoutMs,
  maxBytes,
  signal,
  beforeAttempt,
}) {
  const options = { workDir, timeoutMs, maxBytes, signal };
  let executable = cpuExecutable,
    forcedCpu = false,
    fallback = null;
  if (gpuExecutable) {
    const probe = monitor();
    try {
      await runLocalTool(
        gpuExecutable,
        [
          // The first second can be silence; language detection is unnecessary for a
          // backend probe and can fail before the actual speech is reached.
          "--model",
          modelPath,
          "--language",
          "en",
          "-mc",
          "0",
          "--duration",
          "1000",
          wavPath,
        ],
        {
          ...options,
          timeoutMs: Math.min(timeoutMs, 30000),
          onStderr: probe.observe,
          classifyNativeFailure: true,
        },
      );
      if (gpuBackends.has(probe.backend) && !probe.gpuFailure)
        executable = gpuExecutable;
      else {
        forcedCpu = true;
        fallback = "gpu-unavailable";
      }
    } catch (error) {
      // A probe's own shorter deadline is not the overall ASR deadline. If the
      // shared signal still has time, skip the unresponsive GPU candidate.
      if (
        !signal?.aborted &&
        (error.code === "TIMEOUT" ||
          error.code === "CAPABILITY_MISSING" ||
          (error.code === "SOURCE_UNSUPPORTED" &&
            (probe.gpuFailure || error.detail === "gpu-runtime-unavailable")))
      ) {
        forcedCpu = true;
        fallback = "gpu-unavailable";
      } else throw error;
    }
  }
  const attempt = async (activeExecutable, forceCpu, name) => {
    await beforeAttempt?.(activeExecutable);
    const observed = monitor();
    try {
      const raw = await readAsrOutput(
        path.join(workDir, `asr-output-${name}`),
        options,
        (base, activeSignal) =>
          runLocalTool(
            activeExecutable,
            [
              "--model",
              modelPath,
              "--language",
              "auto",
              "-mc",
              "0",
              ...(forceCpu ? ["--no-gpu"] : []),
              "--output-srt",
              "--output-file",
              base,
              wavPath,
            ],
            {
              ...options,
              signal: activeSignal,
              onStderr: observed.observe,
              classifyNativeFailure: true,
            },
          ),
      );
      return {
        raw,
        backend: forceCpu ? "cpu" : observed.backend,
        gpuFailure: observed.gpuFailure,
      };
    } catch (error) {
      // Internal flags are bounded enums and never include stderr or file paths.
      error.asrGpuFailure = observed.gpuFailure;
      throw error;
    }
  };
  try {
    const result = await attempt(executable, forcedCpu, "primary");
    if (result.gpuFailure && !forcedCpu && result.backend !== "cpu") {
      forcedCpu = true;
      const retry = await attempt(cpuExecutable, true, "cpu-retry");
      return {
        raw: retry.raw,
        backend: "cpu",
        fallback: "gpu-failed",
        executable: cpuExecutable,
      };
    }
    if (
      result.backend === "cpu" &&
      (result.gpuFailure || (gpuExecutable && executable === gpuExecutable))
    )
      fallback = "gpu-unavailable";
    return { raw: result.raw, backend: result.backend, fallback, executable };
  } catch (error) {
    if (signal?.aborted)
      throw networkError(
        signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED",
        "Local ASR was interrupted.",
      );
    const lostCandidate =
      error.code === "CAPABILITY_MISSING" &&
      gpuExecutable &&
      executable === gpuExecutable &&
      gpuExecutable !== cpuExecutable;
    if (
      forcedCpu ||
      (!lostCandidate &&
        (error.code !== "SOURCE_UNSUPPORTED" ||
          !(error.asrGpuFailure || error.detail === "gpu-runtime-unavailable")))
    )
      throw error;
    const result = await attempt(cpuExecutable, true, "cpu-retry");
    return {
      raw: result.raw,
      backend: "cpu",
      fallback: "gpu-failed",
      executable: cpuExecutable,
    };
  }
}
