import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractYouTubeVideoId } from "@steipete/summarize-core/content/url";
import { networkError, parseSourceUrl } from "./network.mjs";
import { AppError } from "./io.mjs";

// Bumped whenever acquisition semantics change (timing, ranking, filtering, policy), so
// evidence produced by an earlier adapter is never reused as if it were equivalent.
const EXTRACTOR_VERSION = "summarize-core@0.25.3+adapter.4";
export const SUBTITLE_VERSION = "4.2.2";
const SAFE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const MAX_RESULT_BYTES = 32 * 1024 * 1024;

/** No ambient keys, proxies, node options, tool config, or actual HOME reach extraction. */
export function isolatedEnvironment(workDir) {
  return {
    PATH: SAFE_PATH,
    HOME: workDir,
    TMPDIR: workDir,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP: "1",
    SUMMARIZE_DISABLE_LOCAL_TRANSCRIPTION: "1",
  };
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
    youtubeTokens: "auto",
    transcriptLanguages: [],
    maxDownloadBytes: 2 ** 31,
    extractTimeoutMs: 1800000,
    asrTimeoutMs: 3600000,
    ...request.policy,
  };
  if (
    !["off", "frames", "local-ocr"].includes(policy.visual) ||
    !["off", "auto", "botguard"].includes(policy.youtubeTokens) ||
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
  try {
    const resolved = await realpath(value);
    if (!(await stat(resolved)).isFile()) throw new Error();
    return resolved;
  } catch {
    throw networkError(
      code,
      code === "CAPABILITY_MISSING"
        ? "An explicitly configured local runtime or model is unavailable."
        : "An input must be an existing regular local file.",
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

/** Private cache identity, not a claim that a remote source has not changed. */
export async function ingestionFingerprint(request, options = {}) {
  const policy = extractionPolicy(request);
  const source =
    request.source.kind === "local"
      ? await hashFile(await regularFile(request.source.value), options.signal)
      : (() => {
          const url = parseSourceUrl(request.source.value).href;
          const id = extractYouTubeVideoId(url);
          return id ? `youtube:${id}` : url;
        })();
  const transcript = request.transcriptFile
    ? {
        format: path.extname(request.transcriptFile).toLowerCase(),
        hash: await hashFile(
          await regularFile(request.transcriptFile),
          options.signal,
        ),
      }
    : null;
  const asr =
    policy.asr === "local"
      ? {
          // 2: ASR_SUSPECT_SEGMENTS warning.
          version: "2",
          executable: options.localAsrExecutable
            ? await hashFile(
                await regularFile(
                  options.localAsrExecutable,
                  "CAPABILITY_MISSING",
                ),
                options.signal,
              )
            : null,
          model: options.localAsrModel
            ? await hashFile(
                await regularFile(options.localAsrModel, "CAPABILITY_MISSING"),
                options.signal,
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
              hash: await hashFile(
                await regularFile(options.youtubeCapture),
                options.signal,
              ),
            },
          }
        : {}),
      asr,
      // yt-dlp may run for ASR audio or for the frames/OCR video stream: fingerprint it
      // whenever either path can use it.
      ...((policy.asr === "local" || policy.visual !== "off") &&
      options.ytDlpExecutable
        ? {
            ytDlp: {
              version: "2",
              executable: await hashFile(
                await regularFile(
                  options.ytDlpExecutable,
                  "CAPABILITY_MISSING",
                ),
                options.signal,
              ),
            },
          }
        : {}),
      ...(policy.visual !== "off"
        ? {
            visual: {
              // 5: look-alike runs in the contact sheet; capped scene-only passes incomplete.
              version: "5",
              mode: policy.visual,
              executable: options.tesseractExecutable
                ? await hashFile(
                    await regularFile(
                      options.tesseractExecutable,
                      "CAPABILITY_MISSING",
                    ),
                    options.signal,
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
                ? await hashFile(
                    await regularFile(
                      options.ocrExecutable,
                      "CAPABILITY_MISSING",
                    ),
                    options.signal,
                  )
                : null,
            },
          }
        : {}),
      policy: {
        asr: policy.asr,
        visual: policy.visual,
        youtubeTokens: policy.youtubeTokens,
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
    localAsrModel: options.localAsrModel
      ? path.resolve(options.localAsrModel)
      : null,
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
        },
      );
      let result,
        failure,
        bytes = 0,
        stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
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
        if (Buffer.byteLength(JSON.stringify(message)) > MAX_RESULT_BYTES)
          return fail(
            networkError(
              "RESOURCE_LIMIT",
              "Extraction result exceeded its byte budget.",
            ),
          );
        if (message?.ok) result = message.value;
        else
          fail(
            networkError(
              /^[A-Z_]+$/.test(message?.code ?? "")
                ? message.code
                : "SOURCE_ACCESS_DENIED",
              safeWorkerMessage(message?.code, message?.detail),
              FAILURE_DETAILS[message?.detail] ? message.detail : undefined,
            ),
          );
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
        } else resolve(result);
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
    await rm(workDir, { recursive: true, force: true });
    // Our own sanitized extraction failures surface verbatim to the host; anything else
    // (system errors can carry paths) stays generic at the CLI boundary.
    if (!(error instanceof AppError) && SAFE_CODES.has(error?.code))
      throw Object.assign(
        new AppError(
          error.code,
          error.message,
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
// Fixed cause phrases keyed by the worker's `detail`; modelled on youtube-transcript-api's
// exception set so hosts can tell blocked / disabled / unavailable / restricted apart.
export const FAILURE_DETAILS = Object.freeze({
  "bot-check":
    "YouTube answered with a sign-in/bot check for this anonymous session; no cookies, tokens or proxies are used.",
  "age-restricted":
    "The video is age-restricted and requires a signed-in session, which this skill does not use.",
  "login-required": "YouTube requires a signed-in session to view this video.",
  "video-unavailable":
    "The video is unavailable (removed, private or an invalid ID).",
  "video-unplayable":
    "YouTube reports the video as unplayable in this region or session.",
  "player-unparsable":
    "The watch page did not contain a readable player response.",
  "no-transcript":
    "The video exposes no transcript (captions disabled or none uploaded).",
  "transcript-refused":
    "YouTube accepted the request but refused the transcript body for this anonymous session (proof-of-origin gate).",
  "transcript-empty":
    "The selected transcript track loaded no rows.",
  "botguard-challenge":
    "The BotGuard attestation challenge could not be fetched or was incomplete.",
  "botguard-integrity":
    "The attestation server refused to issue an integrity token.",
  "botguard-mint": "The proof-of-origin token could not be minted.",
  "botguard-failed": "The token worker failed.",
  "transcript-refused-no-token":
    "YouTube refused the caption body, and no proof-of-origin token could be minted because the confined runtime is unavailable here (not macOS, or this process runs inside a host sandbox where sandbox-exec cannot apply a profile). Run the skill's commands outside the host sandbox, or supply a transcript.",
  "sandbox-unavailable":
    "The confined runtime for token minting cannot run here (not macOS, or this process already runs inside a host sandbox where sandbox-exec cannot apply a profile). Use youtubeTokens \"auto\" to continue without a token, or run outside the host sandbox.",
  "network-unavailable":
    "A DNS lookup or connection failed from this process.",
  "download-failed":
    "yt-dlp did not produce a single audio file within the size budget.",
});
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
function safeWorkerMessage(code, detail) {
  const cause = FAILURE_DETAILS[detail];
  const base =
    {
      ASR_REQUIRED:
        "No captions were acquired. Supply a transcript or explicitly enable prepared local ASR.",
      CAPABILITY_MISSING:
        "A required local capability is unavailable (an explicitly configured executable or model, a media tool, or the confined token runtime).",
      SOURCE_UNSUPPORTED:
        "This source cannot be extracted with the available safe adapters.",
      SOURCE_ACCESS_DENIED:
        "Source access was denied or no transcript track was available; no bypass was attempted. Supply a transcript file or an explicitly approved browser capture.",
      NO_USABLE_EVIDENCE:
        "The source did not provide usable transcript evidence.",
      RESOURCE_LIMIT: "Extraction exceeded a configured resource budget.",
      TIMEOUT: "Source extraction timed out.",
      CANCELLED: "Extraction was cancelled.",
      NETWORK_UNAVAILABLE:
        "The source could not be reached from this process: the host name did not resolve or network access is not permitted here. If the URL is correct, the command environment probably has no network access (for example a host agent's sandboxed shell such as Codex workspace-write); otherwise check the URL. This is not a refusal by the source.",
      UNSAFE_URL:
        "Only credential-free public HTTP(S) destinations are allowed.",
      UNSAFE_PATH: "An input must be an existing regular local file.",
      SOURCE_UNAVAILABLE: "The source video is unavailable.",
      TRANSCRIPT_UNAVAILABLE:
        "The source exposes no transcript. Supply a transcript file, an explicitly approved browser capture, or (local media only) approve local ASR/OCR.",
      INVALID_CONTRACT: "The transcript or extraction input is invalid.",
    }[code] ?? "Source extraction failed safely.";
  return cause ? `${base} Cause: ${cause}` : base;
}
