import { spawn } from "node:child_process";
import { createReadStream, realpathSync } from "node:fs";
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "subtitle";
import {
  extractYouTubeVideoId,
  inferDirectMediaKind,
  isDirectMediaUrl,
} from "@steipete/summarize-core/content/url";
import { resolveLocalDirectMediaSource } from "@steipete/summarize-core/content/local-file";
import {
  buildYoutubeCaptionTrackUrls,
  parseYoutubeCaptionPayload,
} from "@steipete/summarize-core/content/youtube-captions";
import {
  createSourceNetwork,
  networkError,
  parseSourceUrl,
  publicSourceUrl,
} from "./network.mjs";
import {
  SUBTITLE_VERSION,
  extractionPolicy,
  isolatedEnvironment,
  regularFile,
  sha256,
} from "./ingest.mjs";

import { parseYoutubeCapture } from "./youtube-capture.mjs";
import {
  originalCaptionLanguage,
  rankCaptionTracks,
} from "./caption-tracks.mjs";

const TEXT_LIMIT = 8 * 1024 * 1024;
const issue = (code, message) => ({
  code,
  severity: "warning",
  message,
  path: null,
  retryable: false,
});
const error = (code, message, detail) => {
  throw networkError(code, message, detail);
};
const checkSignal = (signal) => {
  if (signal?.aborted) error("TIMEOUT", "Extraction timed out.");
};

async function boundedFile(filename, limit = TEXT_LIMIT, signal) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of createReadStream(filename, { signal })) {
    bytes += chunk.length;
    if (bytes > limit)
      error("RESOURCE_LIMIT", "Input exceeds its byte budget.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function parseUserTranscript(raw, extension) {
  let segments;
  if (extension === ".txt") {
    segments = raw
      .replace(/^\uFEFF/, "")
      .split(/\r?\n\s*\r?\n/)
      .filter((text) => text.trim())
      .map((text) => ({
        startMs: null,
        endMs: null,
        text: text.trim(),
        speaker: null,
      }));
  } else if ([".srt", ".vtt"].includes(extension)) {
    try {
      segments = parseSync(raw)
        .filter((node) => node.type === "cue")
        .map(({ data }) => ({
          startMs: data.start,
          endMs: data.end,
          text: data.text,
          speaker: null,
        }));
    } catch {
      error("INVALID_CONTRACT", "Transcript subtitles could not be parsed.");
    }
    const cueLines = raw
      .replace(/\r\n?/g, "\n")
      .split(/\n[ \t]*\n/)
      .filter((block) => !/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(block.trim()))
      .flatMap((block) => block.split("\n"))
      .filter((line) => /^\s*\S+\s+-->\s+\S+/.test(line)).length;
    if (segments.length !== cueLines)
      error(
        "INVALID_CONTRACT",
        "Some subtitle cues could not be parsed; input was not truncated.",
      );
  } else
    error(
      "INVALID_CONTRACT",
      "Only SRT, VTT and TXT transcripts are supported.",
    );
  validateSegments(segments);
  return segments;
}
function validateSegments(segments) {
  if (!segments.length)
    error("NO_USABLE_EVIDENCE", "No transcript text was acquired.");
  if (segments.length > 100000)
    error("RESOURCE_LIMIT", "Transcript has too many segments.");
  for (const segment of segments) {
    if (
      typeof segment.text !== "string" ||
      !segment.text.trim() ||
      (segment.startMs !== null &&
        (!Number.isSafeInteger(segment.startMs) || segment.startMs < 0)) ||
      (segment.endMs !== null &&
        (segment.startMs === null ||
          !Number.isSafeInteger(segment.endMs) ||
          segment.endMs <= segment.startMs))
    ) {
      error(
        "INVALID_CONTRACT",
        "Transcript contains invalid timing or empty text.",
      );
    }
  }
}

/** Bounded argument-array subprocess, always with a freshly constructed environment. */
export async function runLocalTool(
  executable,
  args,
  { workDir, timeoutMs, signal, maxBytes = TEXT_LIMIT, onChunk } = {},
) {
  return await new Promise((resolve, reject) => {
    const proc = spawn(executable, args, {
      cwd: workDir,
      env: isolatedEnvironment(workDir),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let bytes = 0,
      failure,
      settled = false,
      stdout = [],
      writing = Promise.resolve();
    const stop = (err) => {
      failure ??= err;
      proc.kill("SIGKILL");
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
      if (bytes > maxBytes)
        stop(
          networkError(
            "RESOURCE_LIMIT",
            "A local media tool exceeded its output budget.",
          ),
        );
    });
    proc.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        stop(
          networkError(
            "RESOURCE_LIMIT",
            "A local media tool exceeded its output budget.",
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
            ),
        );
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

// No playlist/network protocols, demuxer-driven external resources, or source-provided command options.
const FORMATS =
  "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,wav,mp3,flac,ogg,aac,aiff,amr,ac3,mpeg,mpegvideo,mpegts";
async function probeMedia(mediaPath, options) {
  const raw = await runLocalTool(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      FORMATS,
      "-show_entries",
      "format=duration:stream=codec_type,width,height",
      "-of",
      "json",
      mediaPath,
    ],
    options,
  );
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    error("SOURCE_UNSUPPORTED", "Media metadata could not be read.");
  }
  const types = (parsed.streams ?? []).map((stream) => stream.codec_type);
  const seconds = Number(parsed.format?.duration);
  return {
    raw: parsed,
    mediaType: types.includes("video")
      ? "video"
      : types.includes("audio")
        ? "audio"
        : "unknown",
    durationMs:
      Number.isFinite(seconds) &&
      seconds >= 0 &&
      Number.isSafeInteger(Math.round(seconds * 1000))
        ? Math.round(seconds * 1000)
        : null,
  };
}

/** Extract one bounded initial-player JSON object; never execute watch-page scripts. */
export function readYoutubePlayer(html) {
  const marker = /(?:var\s+)?ytInitialPlayerResponse\s*=\s*/g;
  const match = marker.exec(html);
  if (!match) return null;
  const start = match.index + match[0].length;
  if (html[start] !== "{") return null;
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}
function captionUrl(value, videoId) {
  const url = parseSourceUrl(value);
  if (
    url.protocol !== "https:" ||
    !["www.youtube.com", "youtube.com", "video.google.com"].includes(
      url.hostname,
    ) ||
    url.pathname !== "/api/timedtext" ||
    url.searchParams.get("v") !== videoId
  ) {
    error("UNSAFE_URL", "Caption metadata points outside the selected source.");
  }
  return buildYoutubeCaptionTrackUrls(url.href)[0];
}

/** Caption track records as the player lists them; no reordering. */
export function normalizeCaptionTracks(captionTracks) {
  if (!Array.isArray(captionTracks)) return [];
  return captionTracks
    .map((track) => {
      if (!track || typeof track !== "object") return null;
      const baseUrl =
        typeof track.baseUrl === "string"
          ? track.baseUrl
          : typeof track.url === "string"
            ? track.url
            : null;
      if (!baseUrl) return null;
      const name = track.name;
      const label =
        typeof name?.simpleText === "string"
          ? name.simpleText.trim()
          : Array.isArray(name?.runs)
            ? name.runs
                .map((run) => (typeof run?.text === "string" ? run.text : ""))
                .join("")
                .trim()
            : "";
      const kind =
        typeof track.kind === "string" ? track.kind.toLowerCase() : "";
      return {
        baseUrl,
        languageCode:
          typeof track.languageCode === "string"
            ? track.languageCode.toLowerCase()
            : "",
        kind,
        label,
        automatic:
          kind === "asr" || label.toLowerCase().includes("auto-generated"),
      };
    })
    .filter(Boolean);
}
/**
 * Mirrors youtube-transcript-api's playability mapping: sign-in/bot checks and age gates are
 * access denials, removed videos are unavailable, anything else non-OK is unplayable.
 */
export function assertPlayability(status) {
  const state = status?.status;
  if (!state || state === "OK") return;
  const reason = typeof status.reason === "string" ? status.reason : "";
  if (state === "LOGIN_REQUIRED") {
    if (/not a bot/i.test(reason))
      error(
        "SOURCE_ACCESS_DENIED",
        "YouTube requires sign-in for this session.",
        "bot-check",
      );
    if (/inappropriate|age/i.test(reason))
      error(
        "SOURCE_ACCESS_DENIED",
        "The video is age-restricted.",
        "age-restricted",
      );
    error(
      "SOURCE_ACCESS_DENIED",
      "YouTube requires sign-in to view this video.",
      "login-required",
    );
  }
  if (state === "ERROR" && /unavailable/i.test(reason))
    error(
      "SOURCE_UNAVAILABLE",
      "The video is unavailable.",
      "video-unavailable",
    );
  error("SOURCE_UNAVAILABLE", "The video is not playable.", "video-unplayable");
}
/**
 * Command line for a confined Node child (macOS only). OS layer (sandbox-exec): no network,
 * no writes, and file contents under user homes, temp, system databases/logs/keychains,
 * application support/preferences and mounted volumes are unreadable, re-allowed only for
 * the Node install and the allowed code roots. This is a deny list, not a sealed
 * allowlist: a symlink inside an allowed tree can still reach a readable system file
 * outside those roots (OS-level), which is why `--permission` additionally restricts
 * Node-level reads to `allowRead` (lexical paths) and denies child processes, workers,
 * addons and WASI; the heap is capped. sandbox-exec execs node in place, so the child's
 * PID is the sandboxed node and SIGKILL reaches it directly.
 */
export function confinedNodeCommand(scriptPath, allowRead = []) {
  if (process.platform !== "darwin")
    error(
      "CAPABILITY_MISSING",
      "Confined execution requires macOS sandbox-exec; proof-of-origin tokens are unavailable on this platform.",
    );
  // Node's permission checks see real paths, so symlinked locations (/tmp, /var) are
  // resolved here; the child itself may not stat them.
  const real = (p) => {
    const trailing = p.endsWith(path.sep) ? path.sep : "";
    return realpathSync(p) + trailing;
  };
  const script = real(scriptPath);
  const roots = allowRead.map(real);
  const quote = (value) => `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
  const subpath = (p) => `(subpath ${quote(p.replace(/\/+$/, ""))})`;
  const nodeDir = path.dirname(path.dirname(realpathSync(process.execPath)));
  // From the account database, not $HOME: this process itself runs with HOME remapped.
  const home = realpathSync(os.userInfo().homedir);
  const profile = [
    "(version 1)",
    "(deny default)",
    `(allow process-exec (literal ${quote(realpathSync(process.execPath))}))`,
    // System libraries/dyld/ICU need broad reads; user data does not. Metadata (lstat of
    // path components) stays readable so the script path resolves; file contents under
    // home/temp/volumes are denied, then re-allowed only for the Node install and the
    // allowed code. SBPL resolves conflicts by operation specificity, then order: the
    // re-allow must use the same `file-read-data` operation as the deny.
    "(allow file-read*)",
    `(deny file-read-data ${subpath(home)} ${subpath("/Users")} ${subpath("/private/tmp")} ${subpath("/private/var/tmp")} ${subpath("/private/var/folders")} ${subpath("/private/var/db")} ${subpath("/private/var/root")} ${subpath("/private/var/log")} ${subpath("/private/etc")} ${subpath("/Library/Keychains")} ${subpath("/Library/Application Support")} ${subpath("/Library/Preferences")} ${subpath("/Library/Managed Preferences")} ${subpath("/Volumes")})`,
    `(allow file-read-data ${subpath(nodeDir)} (literal ${quote(script)}) ${roots.map((r) => (r.endsWith(path.sep) ? subpath(r) : `(literal ${quote(r)})`)).join(" ")})`,
    "(allow sysctl-read)",
    '(allow mach-lookup (global-name "com.apple.system.logger"))',
    "(deny network*)",
  ].join("");
  return {
    file: "/usr/bin/sandbox-exec",
    args: [
      "-p",
      profile,
      process.execPath,
      "--permission",
      ...[script, ...roots].map((p) => `--allow-fs-read=${p}`),
      "--max-old-space-size=256",
      script,
    ],
  };
}
const RELAY_ORIGIN = "https://www.youtube.com";
const RELAY_PATHS = new Set(["/api/jnn/v1/Create", "/api/jnn/v1/GenerateIT"]);
const RELAY_HEADERS = new Set([
  "content-type",
  "accept",
  "x-goog-api-key",
  "x-user-agent",
  "user-agent",
]);
const RELAY_MAX_REQUESTS = 8;
/**
 * Validate and perform one request relayed from the confined token worker. The worker has
 * no network: this is the only way its traffic leaves, so origin, endpoint, method, header
 * set and body size are fixed here regardless of what the attestation program asked for.
 * The parent owns HTTP framing (Host, Content-Length, connection); the worker cannot supply
 * framing headers, so a body cannot smuggle a second request.
 */
export async function relayWorkerFetch(message, network, state) {
  if ((state.count = (state.count ?? 0) + 1) > RELAY_MAX_REQUESTS)
    error("RESOURCE_LIMIT", "The token worker made too many requests.");
  if (typeof message.url !== "string" || message.url.length > 2048)
    error("UNSAFE_URL", "Token worker request URL is invalid.");
  const url = parseSourceUrl(message.url);
  if (
    url.origin !== RELAY_ORIGIN ||
    !RELAY_PATHS.has(url.pathname) ||
    url.search ||
    url.hash
  )
    error("UNSAFE_URL", "Token worker request outside the allowed endpoints.");
  if (message.method !== "POST")
    error("INVALID_CONTRACT", "Token worker requests must be POST.");
  const headers = {};
  if (
    !message.headers ||
    typeof message.headers !== "object" ||
    Array.isArray(message.headers)
  )
    error("INVALID_CONTRACT", "Token worker sent invalid headers.");
  const entries = Object.entries(message.headers);
  if (entries.length > RELAY_HEADERS.size)
    error("INVALID_CONTRACT", "Token worker sent too many headers.");
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (
      !RELAY_HEADERS.has(lower) ||
      lower in headers ||
      typeof value !== "string" ||
      value.length > 1024 ||
      !/^[\x20-\x7e]*$/.test(value)
    )
      error("INVALID_CONTRACT", "Token worker sent an invalid header.");
    headers[lower] = value;
  }
  if (
    typeof message.body !== "string" ||
    Buffer.byteLength(message.body) > 1024 * 1024
  )
    error("RESOURCE_LIMIT", "Token worker request body is not allowed.");
  const response = await network.buffered(
    url.href,
    { method: "POST", headers, body: message.body },
    4 * 1024 * 1024,
  );
  return { status: response.status, text: response.body.toString("utf8") };
}
const WORKER_LINE_LIMIT = 2 * 1024 * 1024;
const WORKER_TOTAL_LIMIT = 8 * 1024 * 1024;
/**
 * Mint a content-bound proof-of-origin token in a confined child process (see
 * botguard-worker.mjs). Only called when `policy.youtubeTokens` is `botguard`. The child
 * has no network; it speaks newline-delimited JSON on plain stdin/stdout (never Node's
 * privileged IPC channel), with per-line and aggregate byte limits enforced before any
 * parsing, and its requests are relayed through `relayWorkerFetch` on a dedicated
 * byte-budgeted pinned transport owned and cancelled by this process.
 */
let confinedProbe = null;
/**
 * Whether the confined runtime works in THIS process: macOS, sandbox-exec present, and able
 * to apply a profile. Inside another seatbelt sandbox (e.g. a host agent's sandboxed shell)
 * sandbox_apply fails with "Operation not permitted", so a trivial profile is tried first.
 */
export async function confinedRuntimeStatus() {
  confinedProbe ??= (async () => {
    if (process.platform !== "darwin")
      return { available: false, reason: "not-macos" };
    try {
      await access("/usr/bin/sandbox-exec", constants.X_OK);
    } catch {
      return { available: false, reason: "no-sandbox-exec" };
    }
    const applied = await new Promise((resolve) => {
      const child = spawn(
        "/usr/bin/sandbox-exec",
        ["-p", "(version 1)(allow default)", "/usr/bin/true"],
        { stdio: "ignore", shell: false },
      );
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(false);
      }, 5000);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
    return applied
      ? { available: true, reason: null }
      : { available: false, reason: "nested-sandbox" };
  })();
  return confinedProbe;
}
export async function mintYoutubeToken(
  videoId,
  { workDir, timeoutMs, signal, network: injected = null, workerPath = null },
) {
  if (signal?.aborted)
    throw networkError("CANCELLED", "Token minting was cancelled.");
  const confined = await confinedRuntimeStatus();
  if (!confined.available)
    error(
      "CAPABILITY_MISSING",
      "The confined runtime for token minting is unavailable here.",
      "sandbox-unavailable",
    );
  const root = fileURLToPath(new URL("..", import.meta.url));
  // `network`/`workerPath` are offline test seams (hostile-child protocol tests); the CLI
  // and worker IPC never expose them.
  const command = confinedNodeCommand(
    workerPath ?? path.join(root, "lib", "botguard-worker.mjs"),
    [
      path.join(root, "node_modules") + path.sep,
      path.join(root, "package.json"),
    ],
  );
  await regularFile(command.file, "CAPABILITY_MISSING");
  const owned = new AbortController();
  const network =
    injected ??
    createSourceNetwork({
      maxBytes: 16 * 1024 * 1024,
      timeoutMs: Math.min(timeoutMs, 60000),
      signal: signal ? AbortSignal.any([signal, owned.signal]) : owned.signal,
    });
  return await new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      env: isolatedEnvironment(workDir),
      cwd: workDir,
      detached: false,
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false,
      result,
      pending = 0,
      buffered = Buffer.alloc(0),
      total = 0;
    const relayState = {};
    const seenIds = new Set();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const str = (value) => (typeof value === "string" ? value : "");
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      owned.abort();
      if (err) {
        child.kill("SIGKILL");
        reject(err);
      } else resolve(value);
    };
    const timer = setTimeout(
      () => finish(networkError("TIMEOUT", "Token minting timed out.")),
      Math.min(timeoutMs, 90000),
    );
    const abort = () =>
      finish(networkError("CANCELLED", "Token minting was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    // Every field read off a worker message is type-checked before any coercion: a valid
    // JSON object can carry values whose string conversion throws.
    const failure = (message) =>
      networkError(
        /^[A-Z_]{1,40}$/.test(str(message?.code))
          ? message.code
          : "SOURCE_ACCESS_DENIED",
        "Proof-of-origin token could not be minted.",
        /^[a-z-]{1,40}$/.test(str(message?.detail))
          ? message.detail
          : "botguard-failed",
      );
    const write = (message) => {
      if (settled || child.stdin.destroyed) return;
      child.stdin.write(`${JSON.stringify(message)}\n`, (err) => {
        if (err)
          finish(
            networkError(
              "SOURCE_ACCESS_DENIED",
              "Proof-of-origin token could not be minted.",
              "botguard-failed",
            ),
          );
      });
    };
    const handle = (message) => {
      if (!message || typeof message !== "object" || Array.isArray(message))
        return finish(failure(null));
      if (message.type === "fetch") {
        if (
          result ||
          !Number.isSafeInteger(message.id) ||
          message.id < 1 ||
          seenIds.has(message.id)
        )
          return finish(failure(null));
        seenIds.add(message.id);
        pending++;
        relayWorkerFetch(message, network, relayState).then(
          (reply) => {
            pending--;
            write({ type: "fetch-result", id: message.id, ...reply });
          },
          (err) => {
            pending--;
            if (err.code === "RESOURCE_LIMIT" || err.code === "UNSAFE_URL")
              return finish(err);
            write({
              type: "fetch-result",
              id: message.id,
              error: { code: err.code ?? "SOURCE_ACCESS_DENIED", detail: null },
            });
          },
        );
        return;
      }
      if (message.type !== "result" || pending > 0 || result)
        return finish(failure(message));
      const value = message.value;
      if (
        message.ok === true &&
        value &&
        typeof value === "object" &&
        typeof value.poToken === "string" &&
        /^[A-Za-z0-9_-]{16,512}$/.test(value.poToken) &&
        (value.interpreterHash === null ||
          value.interpreterHash === undefined ||
          typeof value.interpreterHash === "string")
      )
        result = {
          poToken: value.poToken,
          interpreterHash: /^[a-f0-9]{64}$/.test(str(value.interpreterHash))
            ? value.interpreterHash
            : null,
          receivedBytes: network.receivedBytes,
        };
      else finish(failure(message));
    };
    // Byte-exact framing: records are split on 0x0a in the raw byte stream, limits are
    // counted in bytes, and each complete record is decoded as strict UTF-8.
    const overBudget = () =>
      finish(
        networkError(
          "RESOURCE_LIMIT",
          "The token worker exceeded its output budget.",
        ),
      );
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > WORKER_TOTAL_LIMIT) return overBudget();
      buffered = Buffer.concat([buffered, chunk]);
      // Each complete record is limited on its own bytes (delimiter excluded); only the
      // still-incomplete tail is measured as a partial record.
      let newline;
      while (!settled && (newline = buffered.indexOf(0x0a)) !== -1) {
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        if (line.length > WORKER_LINE_LIMIT) return overBudget();
        try {
          handle(JSON.parse(decoder.decode(line)));
        } catch {
          return finish(failure(null));
        }
      }
      if (!settled && buffered.length > WORKER_LINE_LIMIT) overBudget();
    });
    child.stdin.on("error", () => {});
    child.on("error", () =>
      finish(
        networkError("CAPABILITY_MISSING", "The token worker could not start."),
      ),
    );
    child.on("close", (code) => {
      // Nothing may follow the result: not even whitespace.
      if (result && code === 0 && pending === 0 && buffered.length === 0)
        finish(null, result);
      else
        finish(
          networkError(
            "SOURCE_ACCESS_DENIED",
            "Proof-of-origin token could not be minted.",
            "botguard-failed",
          ),
        );
    });
    write({ videoId });
  });
}
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export async function fetchYoutubeCaptions(
  videoId,
  network,
  preferredLanguages = [],
  token = null,
) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId))
    error("INVALID_CONTRACT", "A valid YouTube video identifier is required.");
  const html = await network.text(
    `https://www.youtube.com/watch?v=${videoId}`,
    TEXT_LIMIT,
  );
  const player = readYoutubePlayer(html);
  if (!player)
    error(
      "SOURCE_ACCESS_DENIED",
      "YouTube did not expose a playable caption source.",
      "player-unparsable",
    );
  assertPlayability(player.playabilityStatus);
  if (player.videoDetails?.videoId !== videoId)
    error("SOURCE_ACCESS_DENIED", "YouTube returned a different source.");
  if (player.videoDetails?.isLiveContent)
    error("SOURCE_UNSUPPORTED", "Live sources are not supported.");
  // Normalised in platform order: the only ranking applied is the documented one below
  // (upstream's helper would silently pre-sort English first).
  const tracks = normalizeCaptionTracks(
    player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [],
  );
  if (!tracks.length)
    return {
      player,
      payload: null,
      transcript: null,
      language: null,
      automatic: false,
    };
  // Caller's language priority first, then the original language (default audio track),
  // then manual before auto-generated, then platform order.
  const track = rankCaptionTracks(
    tracks,
    preferredLanguages,
    originalCaptionLanguage(player.captions?.playerCaptionsTracklistRenderer),
  )[0];
  // One caption request only: no alternate clients, cookie access, translation, or retry ladder.
  // With an opt-in proof-of-origin token the request carries `pot`/`c=WEB` and browser-like
  // headers, exactly as the web player does; otherwise it is the plain track URL.
  let url = captionUrl(track.baseUrl, videoId);
  let payload;
  if (token?.mint) {
    const minted = await token.mint(videoId);
    const withToken = parseSourceUrl(url);
    withToken.searchParams.set("pot", minted.poToken);
    withToken.searchParams.set("c", "WEB");
    url = withToken.href;
    const response = await network.buffered(
      url,
      {
        headers: {
          "user-agent": BROWSER_UA,
          origin: "https://www.youtube.com",
        },
      },
      TEXT_LIMIT,
    );
    if (response.status !== 200)
      error(
        "SOURCE_ACCESS_DENIED",
        "Caption request was refused.",
        "transcript-refused",
      );
    payload = response.body.toString("utf8");
  } else payload = await network.text(url, TEXT_LIMIT);
  const transcript = parseYoutubeCaptionPayload(payload);
  if (!transcript?.lines?.length)
    error(
      "SOURCE_ACCESS_DENIED",
      "YouTube advertised a caption track but returned no usable caption text. Supply a transcript or another source; local ASR cannot download YouTube media.",
      "transcript-refused",
    );
  return {
    player,
    payload,
    transcript,
    language: track.languageCode || null,
    automatic: track.automatic,
    tokenUsed: Boolean(token?.mint),
  };
}
/**
 * YouTube's own caption track can end after its advertised lengthSeconds (seen with
 * auto-generated tracks). Neither clip the captions nor inflate the duration: leave the
 * duration unknown and say so.
 */
export function reconcileCaptionDuration(durationMs, segments) {
  if (
    durationMs !== null &&
    segments.some((s) => (s.endMs ?? s.startMs ?? 0) > durationMs)
  )
    return {
      durationMs: null,
      warning: issue(
        "DURATION_UNVERIFIED",
        "The caption track ends after the video's advertised length; the duration was left unknown instead of clipping captions or extending the length.",
      ),
    };
  return { durationMs, warning: null };
}
/**
 * yt-dlp invocation policy shared by acquisition and the canary. `--ignore-config` and
 * `--no-plugin-dirs` matter: an installed yt-dlp may carry portable/system configuration or
 * plugins enabling cookies, proxies or `--exec`, which a private HOME alone does not disable.
 */
export const YTDLP_POLICY_ARGS = Object.freeze([
  "--ignore-config",
  "--no-plugin-dirs",
  "--no-playlist",
  "--no-cache-dir",
  "--no-warnings",
  "--no-progress",
  "--quiet",
  "--no-update",
  "--no-remote-components",
]);
/**
 * Audio-only, no fallback to muxed video, and only plain-HTTPS formats: fragmented DASH/HLS
 * formats would be staged as fragment files on disk by yt-dlp regardless of `-o -`, outside
 * this process's byte metering. A video without such a format is refused, not downloaded.
 */
export const YTDLP_FORMAT = "bestaudio[protocol=https]";
/**
 * Video-only, ≤480p, plain HTTPS, H.264 preferred (then VP9, then anything ffmpeg decodes):
 * enough for key-scene frames and on-screen text, a fraction of the full download.
 */
export const YTDLP_VIDEO_FORMAT =
  "bestvideo[height<=480][protocol=https][vcodec^=avc1]/bestvideo[height<=480][protocol=https][vcodec^=vp09]/bestvideo[height<=480][protocol=https]";
/**
 * Audio-only download with an explicitly supplied yt-dlp (opt-in, YouTube only): no
 * playlist, no cache, no config/plugins, no remote components. The stream is written to
 * stdout and saved here through the metered pipe, so the byte budget is enforced while the
 * bytes arrive (yt-dlp is killed past `maxDownloadBytes`), nothing is written by yt-dlp
 * itself (no output template, no `.part` files, no template expansion of the job path),
 * and the single produced file is what this process wrote.
 */
export async function downloadYoutubeAudio(
  videoId,
  options,
  policy,
  toolOptions,
) {
  return downloadYoutubeStream(videoId, options, policy, toolOptions, "audio");
}
/** Same metered stream for the low-resolution video-only format used for key-scene frames. */
export async function downloadYoutubeVideo(
  videoId,
  options,
  policy,
  toolOptions,
) {
  return downloadYoutubeStream(videoId, options, policy, toolOptions, "video");
}
async function downloadYoutubeStream(
  videoId,
  options,
  policy,
  toolOptions,
  kind,
) {
  const executable = await regularFile(
    options.ytDlpExecutable,
    "CAPABILITY_MISSING",
  );
  try {
    await access(executable, constants.X_OK);
  } catch {
    error(
      "CAPABILITY_MISSING",
      "The configured yt-dlp executable is not executable.",
    );
  }
  const produced = path.join(
    options.workDir,
    kind === "video" ? "video.bin" : "media.bin",
  );
  let file;
  try {
    file = await open(produced, "wx", 0o600);
  } catch {
    error("INVALID_CONTRACT", "The job directory already holds a download.");
  }
  let size = 0;
  try {
    await runLocalTool(
      executable,
      [
        ...YTDLP_POLICY_ARGS,
        // yt-dlp needs a JS runtime for YouTube's signature challenge; reuse this Node binary
        // and never let it fetch remote solver components.
        "--js-runtimes",
        `node:${process.execPath}`,
        "--max-filesize",
        String(policy.maxDownloadBytes),
        "-f",
        kind === "video" ? YTDLP_VIDEO_FORMAT : YTDLP_FORMAT,
        "-o",
        "-",
        "--",
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      {
        ...toolOptions,
        maxBytes: policy.maxDownloadBytes,
        onChunk: (chunk) => {
          size += chunk.length;
          return file.writeFile(chunk);
        },
      },
    );
  } catch (err) {
    await file.close();
    await rm(produced, { force: true });
    if (err.code === "RESOURCE_LIMIT")
      error(
        "RESOURCE_LIMIT",
        "Downloaded audio exceeds the approved size limit.",
      );
    if (err.code === "SOURCE_UNSUPPORTED")
      error(
        "SOURCE_ACCESS_DENIED",
        `yt-dlp could not stream a ${kind}-only HTTPS format for this video.`,
        "download-failed",
      );
    throw err;
  }
  await file.close();
  if (size === 0) {
    await rm(produced, { force: true });
    error(
      "SOURCE_ACCESS_DENIED",
      `yt-dlp did not produce a ${kind} stream.`,
      "download-failed",
    );
  }
  return produced;
}
async function localAsr(mediaPath, options, policy) {
  if (!options.localAsrExecutable || !options.localAsrModel)
    error(
      "CAPABILITY_MISSING",
      "An explicit existing whisper.cpp executable and model are required.",
    );
  const executable = await regularFile(
    options.localAsrExecutable,
    "CAPABILITY_MISSING",
  );
  const model = await regularFile(options.localAsrModel, "CAPABILITY_MISSING");
  try {
    await access(executable, constants.X_OK);
  } catch {
    error("CAPABILITY_MISSING", "The configured executable is not executable.");
  }
  const signal = AbortSignal.timeout(Math.min(policy.asrTimeoutMs, 2147483647));
  const toolOptions = {
    workDir: options.workDir,
    timeoutMs: policy.asrTimeoutMs,
    signal,
    maxBytes: TEXT_LIMIT,
  };
  const versionText = await runLocalTool(executable, ["--help"], {
    ...toolOptions,
    timeoutMs: Math.min(policy.asrTimeoutMs, 5000),
  });
  const version =
    /(?:version|build)\s*[:=v]?\s*(\d+(?:\.\d+){1,3})/i.exec(
      versionText,
    )?.[1] ?? "unknown";
  const wavPath = path.join(options.workDir, "asr-input.wav");
  const outputBase = path.join(options.workDir, "asr-output");
  const outputPath = `${outputBase}.srt`;
  const wav = await open(wavPath, "wx", 0o600);
  try {
    await runLocalTool(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        FORMATS,
        "-i",
        mediaPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        "pipe:1",
      ],
      {
        ...toolOptions,
        maxBytes: policy.maxDownloadBytes,
        onChunk: (chunk) => wav.writeFile(chunk),
      },
    );
  } finally {
    await wav.close();
  }
  // Route whisper.cpp's SRT file through a bounded FIFO: no unbounded output file or
  // disk-limit polling race. The existing POSIX tool is required, never installed.
  if (process.platform === "win32")
    error(
      "CAPABILITY_MISSING",
      "Bounded local ASR requires a POSIX FIFO runtime.",
    );
  await runLocalTool("/usr/bin/mkfifo", ["-m", "600", outputPath], toolOptions);
  const controller = new AbortController();
  const activeSignal = AbortSignal.any([signal, controller.signal]);
  let readFailure;
  const reading = boundedFile(
    outputPath,
    Math.min(TEXT_LIMIT, policy.maxDownloadBytes),
    activeSignal,
  ).catch((err) => {
    readFailure = err;
    controller.abort();
    throw err;
  });
  try {
    const [raw] = await Promise.all([
      reading,
      runLocalTool(
        executable,
        [
          "--model",
          model,
          "--language",
          "auto",
          "-mc",
          "0",
          "--output-srt",
          "--output-file",
          outputBase,
          wavPath,
        ],
        { ...toolOptions, signal: activeSignal },
      ),
    ]);
    return {
      segments: parseUserTranscript(raw, ".srt"),
      raw,
      providerVersion: version,
      // Whisper tiny/base/small weigh 75–465 MiB; large-v3-turbo 1.5 GiB. Measured on Korean
      // fixtures: small corrupted or omitted 11/19 sensitive conditions, turbo 8/19 with no omissions.
      compactModel: (await stat(model)).size < 1024 * 1024 * 1024,
    };
  } catch (err) {
    if (readFailure?.code === "RESOURCE_LIMIT") throw readFailure;
    if (signal.aborted) error("TIMEOUT", "Local ASR timed out.");
    throw err;
  } finally {
    controller.abort();
    await rm(wavPath, { force: true });
    await rm(outputPath, { force: true });
  }
}

/** JPEG SOF dimensions, so frame sizes come from the actual file bytes. */
export function jpegSize(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    )
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    offset += 2 + length;
  }
  return null;
}
/**
 * Incremental splitter for a concatenated JPEG (image2pipe/mjpeg) stream. Walks marker
 * segments by length and entropy-coded data by stuffing rules, so an EOI inside table
 * payload cannot end an image early. `state` persists across chunks.
 */
export function splitJpegStream(chunk, state) {
  state.buffer = state.buffer ? Buffer.concat([state.buffer, chunk]) : chunk;
  const buf = state.buffer;
  const frames = [];
  let pos = state.pos ?? 0,
    inScan = state.inScan ?? false,
    start = 0;
  for (;;) {
    if (inScan) {
      let i = pos;
      for (; i + 1 < buf.length; i++) {
        if (buf[i] !== 0xff) continue;
        const next = buf[i + 1];
        if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7))
          continue;
        break;
      }
      pos = i;
      if (i + 1 >= buf.length) break;
      inScan = false;
    }
    if (pos + 1 >= buf.length) break;
    if (buf[pos] !== 0xff) {
      state.corrupt = true;
      break;
    }
    const marker = buf[pos + 1];
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      pos += 2;
      continue;
    }
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    if (marker === 0xd9) {
      frames.push(buf.subarray(start, pos + 2));
      start = pos + 2;
      pos = start;
      continue;
    }
    if (pos + 3 >= buf.length) break;
    const length = buf.readUInt16BE(pos + 2);
    if (length < 2) {
      state.corrupt = true;
      break;
    }
    if (pos + 2 + length > buf.length) break;
    pos += 2 + length;
    if (marker === 0xda) inScan = true;
  }
  state.buffer = buf.subarray(start);
  state.pos = pos - start;
  state.inScan = inScan;
  return frames;
}
const OCR_LANGS = /^[a-z_]{3,16}(?:\+[a-z_]{3,16}){0,7}$/;
const VISION_LANGS =
  /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?(?:,[a-z]{2,3}(?:-[A-Za-z]{2,4})?){0,7}$/;
const normalizeLine = (text) => text.replace(/\s+/g, " ").trim();
/**
 * Comparison key for a caption line: NFC and whitespace collapsing, nothing else. Every
 * other character is significant — ".5 mg" ≠ "5 mg", "5'" ≠ "5", "5·10" ≠ "5 10",
 * "MPa" ≠ "mPa" — because a deleted frame cannot be recovered; OCR jitter in punctuation
 * therefore costs an extra retained frame rather than evidence.
 */
export function captionKey(text) {
  return normalizeLine(text.normalize("NFC"));
}
/** Two OCR lines are the same caption only when their keys are identical. */
export function sameCaption(a, b) {
  return captionKey(a) === captionKey(b);
}
/**
 * Lines whose key was not seen in the recent window are new; a caption that stays on
 * screen, a logo or a fixed label is therefore reported once per sampled appearance. A
 * line with any change at all is new — similarity is never used to discard evidence; only
 * single-character fragments are ignored.
 */
export function newLines(lines, recent) {
  const seen = new Set(recent.map(captionKey));
  const fresh = [];
  for (const line of lines) {
    const key = captionKey(line);
    if ([...key].length < 2 || seen.has(key)) continue;
    seen.add(key);
    fresh.push(line);
  }
  return fresh;
}
/** A caption absent for longer than this (source time) is reported again when it returns. */
const RECENT_WINDOW_MS = 10000;
const OCR_ASSET_BUDGET = 64 * 1024 * 1024;
/** Parse the vision helper's TSV: confidence, x, y, w, h (Vision coordinates, y from bottom), text. */
export function parseVisionLines(stdout) {
  const unit = (v) =>
    /^\d+(?:\.\d+)?$/.test(v) && Number(v) >= 0 && Number(v) <= 1;
  return stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => cols.length >= 6 && cols.slice(0, 5).every(unit))
    .map((cols) => ({
      confidence: Number(cols[0]),
      x: Number(cols[1]),
      y: Number(cols[2]),
      width: Number(cols[3]),
      height: Number(cols[4]),
      text: normalizeLine(cols.slice(5).join(" ")),
    }))
    .filter((l) => l.text);
}
/** Region filter on Vision boxes (y measured from the bottom). */
export function inRegion(line, region) {
  if (region === "bottom") return line.y + line.height <= 0.4;
  if (region === "top") return line.y >= 0.6;
  return true;
}
/**
 * Local OCR of sampled frames (scene changes or a fixed interval), modelled on Fabric's
 * visual extraction and videocr's subtitle handling but bounded: explicit executable, frame
 * cap, region filter, similarity-based line dedupe, timestamps only from ffmpeg's own frame
 * metadata and never an inferred end time. Engines: tesseract (any OS) or the Apple Vision
 * helper (scripts/vision-ocr.swift, compiled by the user) which reads real footage far better.
 */
async function localOcrFrames(mediaPath, options, policy) {
  // `frames` mode samples key-scene candidates without any OCR: every sampled frame is
  // kept (there is no text to de-duplicate on) and a contact sheet is written so the host
  // can review all candidates in one image before opening the ones it will cite.
  const framesOnly = policy.visual === "frames";
  const engine = framesOnly ? "none" : (options.ocrEngine ?? "tesseract");
  if (!["tesseract", "vision", "none"].includes(engine))
    error("INVALID_CONTRACT", "OCR engine must be tesseract or vision.");
  let executable = null;
  if (!framesOnly) {
    executable = await regularFile(
      options.ocrExecutable ?? options.tesseractExecutable,
      "CAPABILITY_MISSING",
    );
    try {
      await access(executable, constants.X_OK);
    } catch {
      error(
        "CAPABILITY_MISSING",
        "The configured OCR executable is not executable.",
      );
    }
  }
  const languages = framesOnly
    ? null
    : (options.ocrLanguages ?? (engine === "vision" ? "ko-KR,en-US" : "eng"));
  if (
    !framesOnly &&
    !(engine === "vision" ? VISION_LANGS : OCR_LANGS).test(languages)
  )
    error("INVALID_CONTRACT", "OCR language list is invalid.");
  const region = options.ocrRegion ?? "full";
  if (!["full", "bottom", "top"].includes(region))
    error("INVALID_CONTRACT", "OCR region must be full, bottom or top.");
  // Key-scene mode defaults to 120 candidates (five 24-tile contact sheets); OCR to 60.
  const maxFrames = Math.min(
    600,
    Math.max(1, Number(options.ocrMaxFrames) || (framesOnly ? 120 : 60)),
  );
  // 0.1 catches cuts between text cards (flat colours score ~0.05–0.12); live-action cuts score 0.3+.
  const threshold = Math.min(
    0.95,
    Math.max(0.02, Number(options.ocrSceneThreshold) || 0.1),
  );
  // Key scenes: by default every 20 s plus hard cuts (real cuts score 0.4–0.8, flat
  // transitions far less), so slowly built whiteboards and sudden slide changes are both
  // represented; the host picks from the contact sheet.
  // On long videos the default interval widens so interval samples alone always fit the
  // frame cap and reach the end (a 1-hour video at 120 frames: every 31 s).
  const autoInterval =
    framesOnly && !Number(options.ocrSampleSeconds) && options.ocrSceneThreshold == null;
  const durationMs = (await probeMedia(mediaPath, {
    workDir: options.workDir,
    timeoutMs: Math.min(policy.extractTimeoutMs, 60000),
    maxBytes: TEXT_LIMIT,
  })).durationMs;
  const sampleSeconds =
    Number(options.ocrSampleSeconds) ||
    (autoInterval
      ? Math.max(
          20,
          durationMs ? Math.ceil(durationMs / 1000 / Math.max(1, maxFrames - 1)) : 20,
        )
      : 0);
  const psmValue =
    options.ocrPsm === null || options.ocrPsm === undefined
      ? 6
      : Number(options.ocrPsm);
  if (!Number.isInteger(psmValue) || psmValue < 0 || psmValue > 13)
    error("INVALID_CONTRACT", "OCR page segmentation mode is invalid.");
  const psm = psmValue;
  const signal = AbortSignal.timeout(
    Math.min(policy.extractTimeoutMs, 2147483647),
  );
  const toolOptions = {
    workDir: options.workDir,
    timeoutMs: policy.extractTimeoutMs,
    signal,
    maxBytes: TEXT_LIMIT,
  };
  const assets = path.join(options.workDir, "assets");
  await mkdir(assets, { recursive: true, mode: 0o700 });
  // ffmpeg runs with the job directory as cwd; the metadata file is a relative name, so
  // job paths never enter the filter graph (whose escaping differs from option escaping).
  const meta = path.join(options.workDir, "frames-meta.txt");
  // Both selectors pick existing source frames and keep their presentation timestamps
  // (`fps=` would resample and rewrite them). The first frame is always kept.
  const interval = Math.min(3600, Math.max(1, Math.round(sampleSeconds)));
  const intervalSelector = `select='eq(n,0)+gte(t-prev_selected_t,${interval})'`;
  let selector =
    sampleSeconds > 0 && autoInterval
      ? `select='eq(n,0)+gte(t-prev_selected_t,${interval})+gt(scene,0.3)'`
      : sampleSeconds > 0
        ? intervalSelector
        : `select='eq(n,0)+gt(scene,${threshold})'`;
  // Tesseract gets a cropped band for bottom/top; Vision returns boxes, so it is filtered after.
  const crop =
    engine === "tesseract" && region !== "full"
      ? `,crop=iw:ih*0.4:0:${region === "bottom" ? "ih*0.6" : "0"}`
      : "";
  // Frames arrive as one mjpeg stream on stdout and are split and written here, so the
  // byte budget is enforced while sampling (runLocalTool kills ffmpeg past `maxBytes`),
  // and `-fps_mode passthrough` guarantees one image per printed metadata record — a
  // duplicate-PTS source cannot shift images against their timestamps.
  const samplePass = async (select) => {
    for (const name of await readdir(assets))
      if (/^frame-\d{4}\.jpg$/.test(name))
        await rm(path.join(assets, name), { force: true });
    await rm(meta, { force: true });
    const split = {};
    const files = [];
    // Returning the writes lets runLocalTool pause stdout until they land (backpressure)
    // and surfaces a write failure as the tool failure.
    const onChunk = (chunk) => {
      const writes = [];
      for (const frame of splitJpegStream(chunk, split)) {
        const name = `frame-${String(files.length + 1).padStart(4, "0")}.jpg`;
        files.push(name);
        writes.push(writeFile(path.join(assets, name), frame, { mode: 0o600 }));
      }
      if (split.corrupt) throw new Error("corrupt mjpeg stream");
      return Promise.all(writes);
    };
    await runLocalTool(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "fatal",
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        FORMATS,
        "-i",
        mediaPath,
        "-an",
        "-vf",
        // Fit within 1280×720 (bounded pixel count); `metadata=add` guarantees a printed
        // header (pts_time) for every sampled frame; `setpts=N/TB` AFTER the print gives the
        // encoder strictly increasing stamps so duplicate-PTS sources are emitted in full.
        `${select},scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2${crop},metadata=mode=add:key=vs:value=1,metadata=mode=print:file=frames-meta.txt,setpts=N/TB`,
        "-fps_mode",
        "passthrough",
        "-frames:v",
        String(maxFrames),
        "-q:v",
        "4",
        "-pix_fmt",
        "yuvj420p",
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        "pipe:1",
      ],
      { ...toolOptions, maxBytes: OCR_ASSET_BUDGET, onChunk },
    );
    // EOF: nothing may remain unframed (a truncated final image is a failure, not a drop).
    if (split.buffer?.length)
      error("SOURCE_UNSUPPORTED", "Frame sampling ended mid-image.");
    const stamps = [
      ...(await readFile(meta, "utf8").catch(() => "")).matchAll(
        /pts_time:(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g,
      ),
    ].map((m) => Number(m[1]));
    if (!files.length) return { files, times: [] };
    // One record per image; at the frame cap exactly one trailing record (the next selected
    // frame, which ffmpeg evaluates before stopping) is tolerated, nothing else.
    if (
      stamps.length !== files.length &&
      !(files.length === maxFrames && stamps.length === files.length + 1)
    )
      error("SOURCE_UNSUPPORTED", "Frame timestamps could not be established.");
    if (stamps.some((t) => !Number.isFinite(t) || t < 0 || t > 1e7))
      error("SOURCE_UNSUPPORTED", "Frame timestamps could not be established.");
    const times = stamps
      .slice(0, files.length)
      .map((t) => Math.round(t * 1000));
    if (times.some((t, i) => i && t < times[i - 1]))
      error("SOURCE_UNSUPPORTED", "Frame timestamps are not monotonic.");
    return { files, times };
  };
  // A pass that hit the cap well before the end has not covered the video. In the default
  // key-scene mode the cuts are dropped and the interval-only pass (which always fits) is
  // used instead; with explicit settings the gap is reported, never silent.
  const coversEnd = (pass) =>
    pass.files.length < maxFrames ||
    durationMs === null ||
    pass.times.at(-1) + Math.max(interval * 1000, 10000) >= durationMs;
  let pass = await samplePass(selector);
  let cutsDropped = false;
  if (!coversEnd(pass) && autoInterval && durationMs !== null) {
    selector = intervalSelector;
    pass = await samplePass(selector);
    cutsDropped = true;
  }
  const { files, times } = pass;
  const coverage = {
    durationMs,
    lastFrameMs: times.at(-1) ?? null,
    capReached: files.length >= maxFrames,
    complete: coversEnd(pass),
    cutsDropped,
  };
  if (!files.length) {
    await rm(meta, { force: true });
    return {
      frames: [],
      raw: { engine, selector, languages, region, sampled: 0, coverage },
    };
  }

  const frames = [];
  // caption key → source time last seen; continuous display never re-reports.
  const lastSeen = new Map();
  let kept = 0;
  for (const [i, file] of files.entries()) {
    const full = path.join(assets, file);
    let lines;
    if (engine === "none") {
      lines = [];
    } else if (engine === "vision") {
      const out = await runLocalTool(
        executable,
        [full, languages],
        toolOptions,
      );
      lines = parseVisionLines(out)
        .filter((l) => inRegion(l, region))
        .map((l) => l.text);
    } else {
      // psm 6 (one uniform text block) reads centred caption cards far better than auto layout (psm 3).
      const out = await runLocalTool(
        executable,
        [full, "-", "-l", languages, "--psm", String(psm)],
        toolOptions,
      );
      lines = out.split("\n").map(normalizeLine).filter(Boolean);
    }
    for (const [key, at] of lastSeen)
      if (at <= times[i] - RECENT_WINDOW_MS) lastSeen.delete(key);
    const fresh = newLines(lines, [...lastSeen.keys()]);
    for (const line of lines) lastSeen.set(captionKey(line), times[i]);
    if (!fresh.length && !framesOnly) {
      await rm(full, { force: true });
      continue;
    }
    const bytes = await readFile(full);
    const size = jpegSize(bytes);
    if (!size)
      error("SOURCE_UNSUPPORTED", "A sampled frame is not a readable JPEG.");
    kept++;
    const name = `frame-${String(kept).padStart(4, "0")}.jpg`;
    if (name !== file) await rename(full, path.join(assets, name));
    frames.push({
      id: `frame-${String(kept).padStart(4, "0")}`,
      timestampMs: times[i],
      assetPath: `assets/${name}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: size.width,
      height: size.height,
      ...(framesOnly ? {} : { ocrText: fresh.join("\n").slice(0, 20000) }),
    });
  }
  await rm(meta, { force: true });
  let contactSheet = null;
  if (framesOnly && frames.length)
    contactSheet = await writeContactSheet(assets, frames, toolOptions);
  return {
    frames,
    raw: {
      engine,
      selector,
      languages,
      region,
      psm: engine === "tesseract" ? psm : null,
      sampled: files.length,
      kept,
      maxFrames,
      intervalSeconds: sampleSeconds > 0 ? interval : null,
      coverage,
      contactSheet,
    },
  };
}
const SHEET_COLUMNS = 4;
const SHEET_TILES = 24;
/**
 * Review images of all kept frames, 24 tiles (4 × 6, 320 px each) per sheet so every sheet
 * stays legible when a host views it whole, plus one text index
 * (`assets/contact-sheet.txt`: sheet, tile → frame id → time → file) so the host never
 * has to work out which tile is which frame. Review aids, not evidence.
 */
async function writeContactSheet(assets, frames, toolOptions) {
  const count = frames.length;
  const sheetCount = Math.ceil(count / SHEET_TILES);
  const sheets = [];
  for (let sheet = 0; sheet < sheetCount; sheet++) {
    const n = Math.min(SHEET_TILES, count - sheet * SHEET_TILES);
    const columns = Math.min(SHEET_COLUMNS, n);
    const rows = Math.ceil(n / columns);
    const name = `assets/contact-sheet-${String(sheet + 1).padStart(2, "0")}.jpg`;
    await runLocalTool(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-framerate",
        "1",
        "-start_number",
        String(sheet * SHEET_TILES + 1),
        "-i",
        "assets/frame-%04d.jpg",
        "-vf",
        `scale=320:-2,pad=322:ih+2:1:1:color=white,tile=${columns}x${rows}:padding=0:color=white`,
        "-frames:v",
        "1",
        "-q:v",
        "5",
        "-y",
        name,
      ],
      toolOptions,
    );
    sheets.push(name);
  }
  const lines = [
    `Contact sheets: ${sheetCount} (${SHEET_COLUMNS} columns, up to ${SHEET_TILES} tiles each), read left to right, top to bottom.`,
    "Open the frame files of promising tiles at full size before citing them.",
    "",
    "sheet  tile  frame       time      file",
    ...frames.map((frame, i) => {
      const sheet = Math.floor(i / SHEET_TILES);
      const n = Math.min(SHEET_TILES, count - sheet * SHEET_TILES);
      const columns = Math.min(SHEET_COLUMNS, n);
      const k = i % SHEET_TILES;
      const tile = `r${Math.floor(k / columns) + 1}c${(k % columns) + 1}`;
      return `${String(sheet + 1).padEnd(6)} ${tile.padEnd(5)} ${frame.id}  ${timestampLabel(frame.timestampMs).padEnd(9)} ${frame.assetPath}`;
    }),
    "",
  ];
  await writeFile(path.join(assets, "contact-sheet.txt"), lines.join("\n"), {
    mode: 0o600,
  });
  return { sheets, index: "assets/contact-sheet.txt", tilesPerSheet: SHEET_TILES };
}
function timestampLabel(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    sec = total % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

/** Called only by isolated IPC in production. No remote transcription provider is imported/called. */
export async function runExtraction(request, options) {
  const policy = extractionPolicy(request);
  const deadline = AbortSignal.timeout(
    Math.min(policy.extractTimeoutMs, 2147483647),
  );
  if (options.youtubeCapture) {
    const filename = await regularFile(options.youtubeCapture);
    const raw = await boundedFile(
      filename,
      Math.min(TEXT_LIMIT, policy.maxDownloadBytes),
      deadline,
    );
    return parseYoutubeCapture(raw, request);
  }
  const toolOptions = {
    workDir: options.workDir,
    timeoutMs: policy.extractTimeoutMs,
    signal: deadline,
  };
  const network = createSourceNetwork({
    maxBytes: policy.maxDownloadBytes,
    timeoutMs: policy.extractTimeoutMs,
    signal: deadline,
  });
  let mediaPath = null,
    source,
    segments,
    method,
    provider,
    providerVersion,
    raw = {},
    warnings = [];
  if (request.source.kind === "local") {
    mediaPath = await regularFile(request.source.value);
    const local = resolveLocalDirectMediaSource(mediaPath);
    if (!local)
      error("SOURCE_UNSUPPORTED", "Local file is not a recognized media type.");
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(mediaPath, { signal: deadline }))
      hash.update(chunk);
    const identity = hash.digest("hex");
    const probed = await probeMedia(mediaPath, toolOptions);
    raw.mediaProbe = probed.raw;
    source = {
      id: `src-${identity.slice(0, 24)}`,
      kind: "local-media",
      mediaType: probed.mediaType,
      title: path.basename(mediaPath),
      displayName: path.basename(mediaPath),
      canonicalUrl: null,
      platformId: null,
      sourceLanguage: null,
      durationMs: probed.durationMs,
      playback: { kind: "native", locator: `media:${identity.slice(0, 24)}` },
    };
  } else {
    const url = await network.validate(request.source.value);
    const videoId = extractYouTubeVideoId(url.href);
    const direct = isDirectMediaUrl(url.href);
    const identity = sha256(videoId ? `youtube:${videoId}` : url.href);
    const canonicalUrl = videoId
      ? `https://www.youtube.com/watch?v=${videoId}`
      : publicSourceUrl(request.source.value);
    source = {
      id: `src-${identity.slice(0, 24)}`,
      kind: videoId ? "youtube" : direct ? "direct-media" : "other",
      mediaType: videoId
        ? "video"
        : direct
          ? (inferDirectMediaKind(url.href) ?? "unknown")
          : "unknown",
      title: videoId ? `YouTube ${videoId}` : url.hostname,
      displayName: videoId ? `YouTube ${videoId}` : url.hostname,
      canonicalUrl,
      platformId: videoId,
      sourceLanguage: null,
      durationMs: null,
      playback: {
        kind: videoId
          ? "youtube"
          : direct && canonicalUrl
            ? "native"
            : canonicalUrl
              ? "link-only"
              : "none",
        locator: videoId ?? canonicalUrl,
      },
    };
    if (!request.transcriptFile && videoId) {
      // `auto` (default): mint a proof-of-origin token wherever the confined runtime exists
      // (macOS sandbox-exec); elsewhere fall back to the plain request and say so.
      // `botguard` insists (refused where unavailable); `off` never mints.
      let tokens = policy.youtubeTokens;
      if (tokens === "auto") {
        const confined = await confinedRuntimeStatus();
        tokens = confined.available ? "botguard" : "off";
        if (!confined.available)
          warnings.push(
            issue(
              "BOTGUARD_UNAVAILABLE",
              confined.reason === "nested-sandbox"
                ? "sandbox-exec cannot apply a profile here (this process already runs inside a host sandbox), so no proof-of-origin token was minted; the caption request was made without one and may be refused."
                : "No confined runtime for proof-of-origin tokens on this platform (macOS sandbox-exec required); the caption request was made without a token and may be refused.",
            ),
          );
      }
      const acquired = await fetchYoutubeCaptions(
        videoId,
        network,
        policy.transcriptLanguages,
        tokens === "botguard"
          ? {
              mint: (id) =>
                mintYoutubeToken(id, {
                  workDir: options.workDir,
                  timeoutMs: policy.extractTimeoutMs,
                  signal: deadline,
                }),
            }
          : null,
      );
      if (acquired.tokenUsed)
        warnings.push(
          issue(
            "BOTGUARD_TOKEN",
            "Captions were requested with a locally minted proof-of-origin token (Google's BotGuard attestation program ran in a confined child process: no network, no writes, reads limited by a deny list and to its code tree), as every YouTube client does; set policy.youtubeTokens to \"off\" to disable.",
          ),
        );
      raw.youtubePlayer = acquired.player;
      raw.captionPayload = acquired.payload;
      const details = acquired.player.videoDetails;
      source.title =
        typeof details?.title === "string" && details.title.trim()
          ? details.title
          : source.title;
      const seconds = /^\d+(?:\.\d+)?$/.test(String(details?.lengthSeconds))
        ? Number(details.lengthSeconds)
        : NaN;
      source.durationMs =
        Number.isSafeInteger(seconds * 1000) && seconds >= 0
          ? seconds * 1000
          : null;
      source.sourceLanguage = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(
        acquired.language ?? "",
      )
        ? acquired.language
        : null;
      if (acquired.transcript) {
        segments = acquired.transcript.lines.map((line) => ({
          ...line,
          speaker: null,
        }));
        method = "captions";
        provider = "@steipete/summarize-core";
        providerVersion = "0.25.3";
        if (acquired.automatic)
          warnings.push(
            issue(
              "AUTOMATIC_CAPTIONS",
              "The source captions were automatically generated and may contain transcription errors.",
            ),
          );
        const reconciled = reconcileCaptionDuration(
          source.durationMs,
          segments,
        );
        source.durationMs = reconciled.durationMs;
        if (reconciled.warning) warnings.push(reconciled.warning);
      }
    }
    if (!request.transcriptFile && !segments && policy.asr === "local") {
      if (videoId && !options.ytDlpExecutable)
        error(
          "CAPABILITY_MISSING",
          "Local ASR for YouTube needs an explicitly supplied yt-dlp executable to download the audio.",
        );
      if (!videoId && !direct)
        error(
          "SOURCE_UNSUPPORTED",
          "Safe local ASR download is supported only for direct media or YouTube with yt-dlp.",
        );
      if (!options.localAsrExecutable || !options.localAsrModel)
        error(
          "CAPABILITY_MISSING",
          "An explicit local ASR runtime and model are required.",
        );
      await regularFile(options.localAsrExecutable, "CAPABILITY_MISSING");
      await regularFile(options.localAsrModel, "CAPABILITY_MISSING");
      if (videoId) {
        mediaPath = await downloadYoutubeAudio(
          videoId,
          options,
          policy,
          toolOptions,
        );
        warnings.push(
          issue(
            "PLATFORM_MEDIA_DOWNLOADED",
            "Audio was downloaded with yt-dlp into the private job directory for local transcription (user-approved; YouTube's terms restrict downloading). It is not copied into shared output.",
          ),
        );
      } else {
        mediaPath = path.join(
          options.workDir,
          `media${path.extname(url.pathname).toLowerCase()}`,
        );
        const file = await open(mediaPath, "wx", 0o600);
        try {
          await network.consume(url.href, (chunk) => file.writeFile(chunk));
        } finally {
          await file.close();
        }
      }
      const probed = await probeMedia(mediaPath, toolOptions);
      if (videoId && probed.mediaType !== "audio")
        error(
          "SOURCE_UNSUPPORTED",
          "The platform download is not an audio-only stream; video is never downloaded for ASR.",
          "download-failed",
        );
      source.mediaType = probed.mediaType;
      source.durationMs = probed.durationMs;
      raw.mediaProbe = probed.raw;
      source.playback = {
        kind: "native",
        locator: `media:${identity.slice(0, 24)}`,
      };
    }
  }
  checkSignal(deadline);
  // Explicitly approved frame sampling (key scenes) or local OCR: from the local file, or
  // for YouTube from a low-resolution video-only stream fetched with the explicit yt-dlp.
  let frames = [];
  if (policy.visual !== "off") {
    let visualPath = request.source.kind === "local" ? mediaPath : null;
    if (!visualPath && source.kind === "youtube") {
      if (!options.ytDlpExecutable)
        error(
          "CAPABILITY_MISSING",
          "Frames from a YouTube video need an explicitly supplied yt-dlp executable to stream a low-resolution video track.",
        );
      visualPath = await downloadYoutubeVideo(
        source.platformId,
        options,
        policy,
        toolOptions,
      );
      const probed = await probeMedia(visualPath, toolOptions);
      if (probed.mediaType !== "video")
        error(
          "SOURCE_UNSUPPORTED",
          "The platform download is not a video-only stream.",
          "download-failed",
        );
      raw.videoProbe = probed.raw;
      warnings.push(
        issue(
          "PLATFORM_VIDEO_DOWNLOADED",
          "A low-resolution (≤480p) video-only stream was downloaded with yt-dlp into the private job directory to sample frames (user-approved; YouTube's terms restrict downloading). It is not copied into shared output.",
        ),
      );
    }
    if (!visualPath)
      error(
        "SOURCE_UNSUPPORTED",
        "Frame sampling needs a local media file or a YouTube video with yt-dlp.",
      );
    const ocr = await localOcrFrames(visualPath, options, policy);
    frames = ocr.frames;
    raw.visualOcr = ocr.raw;
    const coverage = ocr.raw.coverage;
    if (coverage?.cutsDropped)
      warnings.push(
        issue(
          "FRAMES_CUTS_DROPPED",
          `Interval and cut sampling exceeded the ${ocr.raw.maxFrames}-frame cap before the end, so only the ${ocr.raw.intervalSeconds} s interval samples were kept; they cover the whole video, but a short scene between them may be missing.`,
        ),
      );
    if (coverage && !coverage.complete)
      warnings.push(
        issue(
          "FRAMES_TRUNCATED",
          `Sampling stopped at the ${ocr.raw.maxFrames}-frame cap at ${timestampLabel(coverage.lastFrameMs)} of ${timestampLabel(coverage.durationMs)}; later scenes are not represented. Raise --ocr-max-frames or the sample interval.`,
        ),
      );
    warnings.push(
      policy.visual === "frames"
        ? issue(
            "FRAMES_SAMPLED",
            "Frames were sampled at a fixed interval and at hard cuts as key-scene candidates; scenes between samples are not represented. Inspect a frame before citing it.",
          )
        : issue(
            "VISUAL_OCR_UNVERIFIED",
            "Frame text was machine-read from sampled scene changes; OCR errors and unsampled scenes are possible. Inspect a frame before citing it.",
          ),
    );
  }
  if (request.transcriptFile) {
    const transcriptPath = await regularFile(request.transcriptFile);
    const text = await boundedFile(
      transcriptPath,
      Math.min(TEXT_LIMIT, policy.maxDownloadBytes),
      deadline,
    );
    segments = parseUserTranscript(
      text,
      path.extname(transcriptPath).toLowerCase(),
    );
    method = "user-transcript";
    provider =
      path.extname(transcriptPath).toLowerCase() === ".txt"
        ? "video-summarizer/text"
        : "subtitle";
    providerVersion = provider === "subtitle" ? SUBTITLE_VERSION : "1";
    raw.userTranscript = text;
    warnings.push(
      issue(
        "USER_TRANSCRIPT_UNVERIFIED",
        "The user supplied this transcript for this source; correspondence and completeness were not independently verified.",
      ),
    );
  }
  if (!segments && frames.length && policy.asr === "off") {
    // Visual-only evidence: the host cites inspected frames; no transcript is invented.
    segments = [];
    method = "none";
    provider = "video-summarizer/visual-ocr";
    providerVersion = "1";
  }
  if (!segments) {
    if (policy.asr === "off")
      error("ASR_REQUIRED", "No transcript was acquired; ASR is off.");
    if (!options.localAsrExecutable || !options.localAsrModel)
      error(
        "CAPABILITY_MISSING",
        "An explicit existing local ASR runtime and model are required.",
      );
    if (!mediaPath)
      error(
        "SOURCE_UNSUPPORTED",
        "This source has no safe media path for local ASR.",
      );
    const asr = await localAsr(mediaPath, options, policy);
    segments = asr.segments;
    raw.localAsr = asr.raw;
    method = "local-asr";
    provider = "whisper.cpp";
    providerVersion = asr.providerVersion;
    warnings.push(
      issue(
        "ASR_UNVERIFIED",
        "Local ASR may contain transcription errors; review against the source.",
      ),
    );
    if (asr.compactModel)
      warnings.push(
        issue(
          "ASR_MODEL_COMPACT",
          "A compact Whisper model (<1 GiB) was used; for non-English or instruction-bearing speech prefer ggml-large-v3-turbo.",
        ),
      );
  }
  if (segments.length || !frames.length) validateSegments(segments);
  if (
    source.durationMs !== null &&
    segments.some(
      (segment) =>
        segment.startMs > source.durationMs ||
        segment.endMs > source.durationMs,
    )
  ) {
    error(
      "INVALID_CONTRACT",
      "Transcript timestamps exceed the known source duration.",
    );
  }
  const timed = segments.filter((segment) => segment.startMs !== null).length;
  const timing =
    segments.length && timed === segments.length
      ? "complete"
      : timed
        ? "partial"
        : "none";
  if (timing !== "complete" && segments.length)
    warnings.push(
      issue(
        "TIMING_UNAVAILABLE",
        "Some or all transcript timestamps are unavailable; no times were invented.",
      ),
    );
  if (source.kind !== "local-media" && method === "user-transcript")
    warnings.push(
      issue(
        "REMOTE_METADATA_UNVERIFIED",
        "Remote media metadata and availability were not fetched for this user transcript.",
      ),
    );
  // Caption/utterance boundaries do not prove silence or whole-media coverage.
  warnings.push(
    issue(
      "COVERAGE_UNVERIFIED",
      "Transcript acquisition does not verify every spoken word or visual content; no whole-duration coverage percentage is claimed.",
    ),
  );
  return {
    source,
    segments,
    extraction: {
      status: "complete",
      method,
      provider,
      providerVersion,
      retrievedAt: new Date().toISOString(),
      timing,
      processedRanges: [],
      gaps: [],
      warnings,
    },
    raw,
    mediaPath,
    frames,
    // Private root the frame assets were written under; prepare copies them into the job.
    assetRoot: frames.length ? options.workDir : null,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.send
) {
  process.once("message", async ({ request, options }) => {
    try {
      const value = await runExtraction(request, options);
      if (Buffer.byteLength(JSON.stringify(value)) > 30 * 1024 * 1024)
        error("RESOURCE_LIMIT", "Extraction result is too large.");
      process.send({ ok: true, value }, () => process.exit(0));
    } catch (err) {
      const code =
        err.name === "AbortError" && err.cause?.name === "TimeoutError"
          ? "TIMEOUT"
          : (err.code ?? "SOURCE_ACCESS_DENIED");
      const detail = /^[a-z][a-z-]{1,40}$/.test(err.detail ?? "")
        ? err.detail
        : null;
      process.send({ ok: false, code, detail }, () => process.exit(1));
    }
  });
}
