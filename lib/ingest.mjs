import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractYouTubeVideoId } from "@steipete/summarize-core/content/url";
import { networkError, parseSourceUrl } from "./network.mjs";
import { AppError, atomicWrite, jsonBytes } from "./io.mjs";
import { isolatedEnvironment, killGroup, stopWorker } from "./runtime.mjs";
import { validateCodeSwitch } from "./asr-language-recheck.mjs";
export { isolatedEnvironment } from "./runtime.mjs";
import { FAILURE_DETAILS, safeFailureMessage } from "./failure-messages.mjs";
export { FAILURE_DETAILS };

// Bumped whenever acquisition semantics change (timing, ranking, filtering, policy), so
// evidence produced by an earlier adapter is never reused as if it were equivalent.
const EXTRACTOR_VERSION = "summarize-core@0.25.3+adapter.16";
export const SUBTITLE_VERSION = "4.2.2";
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const ASR_FAILURE_DETAILS = new Set([
  "subtitle-parse-failed",
  "subtitle-cue-mismatch",
  "transcript-empty-text",
  "transcript-invalid-timing",
  "transcript-duration-overrun",
]);

/** A failed transcript is private diagnostic data, never evidence or a cache hit. */
export function asrFailureOutput(message, request, byteBudget) {
  if (
    message?.ok !== false ||
    message.code !== "INVALID_CONTRACT" ||
    !ASR_FAILURE_DETAILS.has(message.detail) ||
    request?.policy?.asr !== "local" ||
    request.transcriptFile != null ||
    typeof message.rawSrt !== "string" ||
    !Number.isSafeInteger(byteBudget) ||
    byteBudget <= 0 ||
    Buffer.byteLength(message.rawSrt, "utf8") >
      Math.min(8 * 1024 * 1024, byteBudget)
  )
    return null;
  return message.rawSrt;
}

export function extractionPolicy(request) {
  if (
    !request ||
    !["url", "local"].includes(request.source?.kind) ||
    typeof request.source.value !== "string" ||
    !request.source.value ||
    request.source.value.includes("\0") ||
    (request.transcriptFile != null &&
      typeof request.transcriptFile !== "string")
  ) {
    throw networkError(
      "INVALID_CONTRACT",
      "An explicit URL or local file source is required.",
    );
  }
  const policy = {
    asr: "off",
    visual: "off",
    transcriptLanguages: [],
    maxDownloadBytes: 2 ** 31,
    extractTimeoutMs: 1800000,
    asrTimeoutMs: 3600000,
    ...request.policy,
  };
  if (
    !["off", "frames", "local-ocr"].includes(policy.visual) ||
    !Array.isArray(policy.transcriptLanguages) ||
    policy.transcriptLanguages.length > 8 ||
    policy.transcriptLanguages.some(
      (l) =>
        typeof l !== "string" || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(l),
    ) ||
    !["off", "local"].includes(policy.asr) ||
    ["maxDownloadBytes", "extractTimeoutMs", "asrTimeoutMs"].some(
      (key) => !Number.isSafeInteger(policy[key]) || policy[key] <= 0,
    )
  ) {
    throw networkError("INVALID_CONTRACT", "Extraction policy is invalid.");
  }
  if (request.source.kind === "url") parseSourceUrl(request.source.value);
  return policy;
}
export async function regularFile(value, code = "UNSAFE_PATH") {
  let detail;
  try {
    const resolved = await realpath(value);
    if (!(await stat(resolved)).isFile()) {
      detail = "path-not-file";
      throw new Error();
    }
    return resolved;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
      detail = "path-not-found";
    throw networkError(
      code,
      code === "CAPABILITY_MISSING"
        ? "An explicitly configured local runtime or model is unavailable."
        : "An input must be an existing regular local file.",
      detail,
    );
  }
}
async function hashFile(value, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(value, { signal }))
    hash.update(chunk);
  return hash.digest("hex");
}
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

// ASR runtimes can depend on adjacent native libraries, not only the CLI.
async function asrRuntimeIdentity(
  value,
  hashResolvedFile,
  includeExecutable = true,
) {
  if (!value) return null;
  let executable;
  try {
    executable = await regularFile(value, "CAPABILITY_MISSING");
  } catch (err) {
    if (err.code === "CAPABILITY_MISSING") return { status: "unavailable" };
    throw err;
  }
  const names = (await readdir(path.dirname(executable)))
    .filter((name) =>
      /^(?:lib)?(?:ggml.*|whisper|cublas.*|cudart.*|nvrtc.*)\.(?:dll|dylib|so(?:\.\d+)*|metallib)$/i.test(
        name,
      ),
    )
    .sort();
  if (names.length > 128)
    throw networkError("RESOURCE_LIMIT", "Too many native ASR libraries.");
  const libraries = [];
  for (const name of names) {
    try {
      const file = await regularFile(
        path.join(path.dirname(executable), name),
        "CAPABILITY_MISSING",
      );
      libraries.push({ name, sha256: await hashResolvedFile(file) });
    } catch (err) {
      if (err.code !== "CAPABILITY_MISSING") throw err;
      libraries.push({ name, status: "unavailable" });
    }
  }
  return {
    status: "available",
    ...(includeExecutable
      ? { executable: await hashResolvedFile(executable) }
      : {}),
    libraries,
  };
}

/** Private cache identity, not a claim that a remote source has not changed. */
export async function ingestionFingerprint(request, options = {}) {
  validateCodeSwitch(options.localAsrCodeSwitch);
  const policy = extractionPolicy(request);
  // Each argument below comes from regularFile(), so aliases share the canonical key.
  // This cache exists only for this fingerprint; later calls always read current bytes.
  const hashes = new Map();
  const hashResolvedFile = async (file) => {
    options.signal?.throwIfAborted();
    if (!hashes.has(file)) hashes.set(file, hashFile(file, options.signal));
    return hashes.get(file);
  };
  const mayUseAsr =
    policy.asr === "local" &&
    !request.transcriptFile &&
    !options.youtubeCapture;
  const source =
    request.source.kind === "local"
      ? await hashResolvedFile(await regularFile(request.source.value))
      : (() => {
          const url = parseSourceUrl(request.source.value).href;
          const id = extractYouTubeVideoId(url);
          return id ? `youtube:${id}` : url;
        })();
  const transcript = request.transcriptFile
    ? {
        format: path.extname(request.transcriptFile).toLowerCase(),
        hash: await hashResolvedFile(await regularFile(request.transcriptFile)),
      }
    : null;
  const asr = mayUseAsr
    ? {
        // 7: restore multilingual lexical rules and notation-preserving rechecks.
        version: "7",
        codeSwitch: options.localAsrCodeSwitch ?? null,
        executable: options.localAsrExecutable
          ? await hashResolvedFile(
              await regularFile(
                options.localAsrExecutable,
                "CAPABILITY_MISSING",
              ),
            )
          : null,
        accelerated: await asrRuntimeIdentity(
          options.localAsrGpuExecutable,
          hashResolvedFile,
        ),
        cpuLibraries: options.localAsrExecutable
          ? (
              await asrRuntimeIdentity(
                options.localAsrExecutable,
                hashResolvedFile,
                false,
              )
            )?.libraries
          : null,
        model: options.localAsrModel
          ? await hashResolvedFile(
              await regularFile(options.localAsrModel, "CAPABILITY_MISSING"),
            )
          : null,
      }
    : null;
  return sha256(
    JSON.stringify({
      adapter: EXTRACTOR_VERSION,
      subtitle: SUBTITLE_VERSION,
      source,
      transcript,
      ...(options.youtubeCapture
        ? {
            youtubeCapture: {
              version: "1",
              hash: await hashResolvedFile(
                await regularFile(options.youtubeCapture),
              ),
            },
          }
        : {}),
      asr,
      // yt-dlp may run for ASR audio or for the frames/OCR video stream: fingerprint it
      // whenever either path can use it.
      ...((mayUseAsr || policy.visual !== "off") &&
      !options.youtubeCapture &&
      options.ytDlpExecutable
        ? {
            ytDlp: {
              version: "2",
              executable: await hashResolvedFile(
                await regularFile(
                  options.ytDlpExecutable,
                  "CAPABILITY_MISSING",
                ),
              ),
            },
          }
        : {}),
      ...(policy.visual !== "off"
        ? {
            visual: {
              // 6: known-duration frame intervals use the budget down to 1 s.
              version: "6",
              mode: policy.visual,
              executable: options.tesseractExecutable
                ? await hashResolvedFile(
                    await regularFile(
                      options.tesseractExecutable,
                      "CAPABILITY_MISSING",
                    ),
                  )
                : null,
              languages: options.ocrLanguages ?? null,
              maxFrames: options.ocrMaxFrames ?? null,
              sceneThreshold: options.ocrSceneThreshold ?? null,
              sampleSeconds: options.ocrSampleSeconds ?? null,
              psm: options.ocrPsm ?? null,
              engine: options.ocrEngine ?? null,
              region: options.ocrRegion ?? null,
              helper: options.ocrExecutable
                ? await hashResolvedFile(
                    await regularFile(
                      options.ocrExecutable,
                      "CAPABILITY_MISSING",
                    ),
                  )
                : null,
            },
          }
        : {}),
      policy: {
        asr: policy.asr,
        visual: policy.visual,
        transcriptLanguages: policy.transcriptLanguages,
        maxDownloadBytes: policy.maxDownloadBytes,
        extractTimeoutMs: policy.extractTimeoutMs,
        asrTimeoutMs: policy.asrTimeoutMs,
      },
    }),
  );
}

/** Extract in a fresh process; the only IPC payload is this request and explicit options. */
export async function extractSource(request, options = {}) {
  validateCodeSwitch(options.localAsrCodeSwitch);
  const policy = extractionPolicy(request);
  if (options.signal?.aborted)
    throw networkError("CANCELLED", "Extraction was cancelled.");
  if (typeof options.workDir !== "string" || !options.workDir)
    throw networkError(
      "INVALID_CONTRACT",
      "A private work directory is required.",
    );
  await mkdir(options.workDir, { recursive: true, mode: 0o700 });
  const root = await realpath(options.workDir);
  const workDir = await mkdtemp(path.join(root, "ingest-"));
  // Resolve relative input paths before changing the worker's working directory.
  const input = {
    ...request,
    source: {
      ...request.source,
      value:
        request.source.kind === "local"
          ? path.resolve(request.source.value)
          : request.source.value,
    },
    transcriptFile: request.transcriptFile
      ? path.resolve(request.transcriptFile)
      : null,
    policy,
  };
  const workerOptions = {
    workDir,
    youtubeCapture: options.youtubeCapture
      ? path.resolve(options.youtubeCapture)
      : null,
    localAsrExecutable: options.localAsrExecutable
      ? path.resolve(options.localAsrExecutable)
      : null,
    localAsrGpuExecutable: options.localAsrGpuExecutable
      ? path.resolve(options.localAsrGpuExecutable)
      : null,
    localAsrModel: options.localAsrModel
      ? path.resolve(options.localAsrModel)
      : null,
    localAsrCodeSwitch: options.localAsrCodeSwitch ?? null,
    tesseractExecutable: options.tesseractExecutable
      ? path.resolve(options.tesseractExecutable)
      : null,
    ocrLanguages: options.ocrLanguages ?? null,
    ocrMaxFrames: options.ocrMaxFrames ?? null,
    ocrSceneThreshold: options.ocrSceneThreshold ?? null,
    ocrSampleSeconds: options.ocrSampleSeconds ?? null,
    ocrPsm: options.ocrPsm ?? null,
    ocrEngine: options.ocrEngine ?? null,
    ocrRegion: options.ocrRegion ?? null,
    ocrExecutable: options.ocrExecutable
      ? path.resolve(options.ocrExecutable)
      : null,
    ytDlpExecutable: options.ytDlpExecutable
      ? path.resolve(options.ytDlpExecutable)
      : null,
  };
  let failedAsrRaw = null;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./ingest-worker.mjs", import.meta.url))],
        {
          env: isolatedEnvironment(workDir),
          cwd: workDir,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          serialization: "json",
          shell: false,
          windowsHide: true,
        },
      );
      let result,
        failure,
        bytes = 0,
        stopped = false;
      // Process groups of the local tools the worker started (POSIX), reaped with it.
      const toolGroups = new Set();
      const reapTools = () => {
        for (const pid of toolGroups) killGroup(pid);
        toolGroups.clear();
      };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        stopWorker(child);
        reapTools();
      };
      const fail = (error) => {
        failure ??= error;
        stop();
      };
      const timer = setTimeout(
        () => fail(networkError("TIMEOUT", "Source extraction timed out.")),
        Math.min(
          policy.extractTimeoutMs +
            (policy.asr === "local" ? policy.asrTimeoutMs : 0),
          2147483647,
        ),
      );
      const abort = () =>
        fail(networkError("CANCELLED", "Extraction was cancelled."));
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024)
            fail(
              networkError(
                "RESOURCE_LIMIT",
                "Extraction log output exceeded its byte budget.",
              ),
            );
          // Intentionally do not relay untrusted extractor logs.
        });
      child.on("message", (message) => {
        if (["tool-group", "tool-group-closed"].includes(message?.type)) {
          if (Number.isSafeInteger(message.pid) && message.pid > 1) {
            if (message.type === "tool-group-closed")
              toolGroups.delete(message.pid);
            else if (stopped)
              killGroup(message.pid); // Registration already in flight at cancellation.
            else if (toolGroups.size < 10000) toolGroups.add(message.pid);
          }
          return;
        }
        if (Buffer.byteLength(JSON.stringify(message)) > MAX_RESULT_BYTES)
          return fail(
            networkError(
              "RESOURCE_LIMIT",
              "Extraction result exceeded its byte budget.",
            ),
          );
        if (message?.ok) result = message.value;
        else {
          if (!failure)
            failedAsrRaw = asrFailureOutput(
              message,
              input,
              policy.maxDownloadBytes,
            );
          fail(
            networkError(
              /^[A-Z_]+$/.test(message?.code ?? "")
                ? message.code
                : "SOURCE_ACCESS_DENIED",
              safeFailureMessage(message?.code, message?.detail),
              FAILURE_DETAILS[message?.detail] ? message.detail : undefined,
            ),
          );
        }
      });
      child.on("error", () => {
        failure = networkError(
          "CAPABILITY_MISSING",
          "The extraction worker could not be started.",
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (failure || code !== 0 || !result) {
          stop(); // Also reap any descendants left behind by a failing local tool.
          reject(
            failure ??
              networkError(
                "SOURCE_ACCESS_DENIED",
                "Extraction did not return usable evidence.",
              ),
          );
        } else {
          // Anything a finished tool left running in its own group is ours to stop.
          reapTools();
          resolve(result);
        }
      });
      child.send({ request: input, options: workerOptions }, (error) => {
        if (error)
          fail(
            networkError(
              "CAPABILITY_MISSING",
              "The extraction worker could not be initialized.",
            ),
          );
      });
    });
  } catch (error) {
    let diagnosticPath = null;
    const diagnostic = asrFailureOutput(
      {
        ok: false,
        code: error.code,
        detail: error.detail,
        rawSrt: failedAsrRaw,
      },
      input,
      policy.maxDownloadBytes,
    );
    if (diagnostic !== null) {
      try {
        // Only this parent chooses the destination. Do not copy worker files or
        // retain its media, native logs, FIFO or model links after a failure.
        const directory = `raw/asr-failures/${path.basename(workDir)}`;
        const relative = `${directory}/transcript.srt`;
        await atomicWrite(root, relative, diagnostic);
        await atomicWrite(
          root,
          `${directory}/receipt.json`,
          jsonBytes({
            schemaVersion: 1,
            status: "rejected",
            evidence: false,
            createdAt: new Date().toISOString(),
            code: error.code,
            detail: error.detail,
            transcript: {
              path: "transcript.srt",
              bytes: Buffer.byteLength(diagnostic, "utf8"),
              sha256: sha256(diagnostic),
            },
            requestSha256: sha256(JSON.stringify(input)),
            request: input,
            configuredRuntime: {
              cpuExecutable: workerOptions.localAsrExecutable,
              gpuExecutable: workerOptions.localAsrGpuExecutable,
              model: workerOptions.localAsrModel,
            },
          }),
        );
        diagnosticPath = relative;
      } catch {
        // A diagnostic write must not replace the original acquisition failure.
      }
    }
    await rm(workDir, { recursive: true, force: true });
    // Our own sanitized extraction failures surface verbatim to the host; anything else
    // (system errors can carry paths) stays generic at the CLI boundary.
    if (!(error instanceof AppError) && SAFE_CODES.has(error?.code))
      throw Object.assign(
        new AppError(
          error.code,
          error.message +
            (diagnosticPath
              ? ` Rejected local ASR output was saved privately to ${diagnosticPath} for inspection; it is not validated evidence.`
              : ""),
          NEEDS_INPUT.has(error.code) ? 3 : 1,
        ),
        FAILURE_DETAILS[error.detail] ? { detail: error.detail } : {},
      );
    throw error;
  }
}
const NEEDS_INPUT = new Set([
  "ASR_REQUIRED",
  "CAPABILITY_MISSING",
  "SOURCE_UNSUPPORTED",
  "SOURCE_ACCESS_DENIED",
  "SOURCE_UNAVAILABLE",
  "TRANSCRIPT_UNAVAILABLE",
  "NO_USABLE_EVIDENCE",
]);
const SAFE_CODES = new Set([
  ...NEEDS_INPUT,
  "NETWORK_UNAVAILABLE",
  "RESOURCE_LIMIT",
  "TIMEOUT",
  "CANCELLED",
  "UNSAFE_URL",
  "UNSAFE_PATH",
  "INVALID_CONTRACT",
]);
