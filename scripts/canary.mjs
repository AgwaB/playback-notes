import path from "node:path";
import { rm, mkdtemp } from "node:fs/promises";
import { isMain, optionsFor, required, result, runCli } from "../lib/cli.mjs";
import { AppError, issue, readJson } from "../lib/io.mjs";
import { normalizeRequest } from "../lib/validation.mjs";
import { extractSource } from "../lib/ingest.mjs";
import {
  YTDLP_FORMAT,
  YTDLP_POLICY_ARGS,
  runLocalTool,
} from "../lib/ingest-worker.mjs";
import { parseSourceUrl } from "../lib/network.mjs";
import { extractYouTubeVideoId } from "@steipete/summarize-core/content/url";

/**
 * Classify a caption-acquisition outcome the way yt-dlp/prepublish canaries do: the fixes
 * differ. `blocked` = the platform gates this session (policy/approval question);
 * `broken` = our adapter, token minting or a tool no longer works (code/update question);
 * `no-captions` = this video simply has none (pick another canary);
 * `environment` = this process has no network (run elsewhere).
 * A refusal with no token possible here (`transcript-refused-no-token`) means the
 * Android-app caption list failed too, so it is `blocked`, not an environment limit.
 */
export function classifyCanary(error) {
  if (!error) return { state: "ok", cause: null };
  const cause = error.detail ?? null;
  // Our environment, not YouTube and not the adapter.
  if (error.code === "NETWORK_UNAVAILABLE" || cause === "sandbox-unavailable")
    return { state: "environment", cause: cause ?? error.code };
  if (
    ["ASR_REQUIRED", "TRANSCRIPT_UNAVAILABLE"].includes(error.code) ||
    cause === "no-transcript"
  )
    return { state: "no-captions", cause };
  if (cause?.startsWith("botguard-") || cause === "player-unparsable")
    return { state: "broken", cause };
  if (
    error.code === "SOURCE_ACCESS_DENIED" &&
    [
      "transcript-refused",
      "transcript-refused-no-token",
      "bot-check",
      "transcript-empty",
    ].includes(cause)
  )
    return { state: "blocked", cause };
  if (["SOURCE_ACCESS_DENIED", "SOURCE_UNAVAILABLE"].includes(error.code))
    return { state: "unavailable", cause };
  return { state: "broken", cause: cause ?? error.code };
}

export async function canary(options) {
  required(options, ["request", "work-dir"]);
  const request = normalizeRequest((await readJson(options.request)).data);
  if (request.source.kind !== "url")
    throw new AppError(
      "INVALID_CONTRACT",
      "The canary needs a YouTube URL source.",
      4,
    );
  // Fail closed before any tool sees the request: only a credential-free public YouTube
  // watch URL with a valid video ID is probed, and yt-dlp receives the canonical URL
  // rebuilt from that ID, never the request string.
  let videoId = null;
  try {
    const parsed = parseSourceUrl(request.source.value);
    if (!parsed.username && !parsed.password && parsed.protocol === "https:")
      videoId = extractYouTubeVideoId(parsed.href);
  } catch {
    videoId = null;
  }
  if (!videoId)
    throw new AppError(
      "INVALID_CONTRACT",
      "The canary needs a public YouTube video URL.",
      4,
    );
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const issues = [];
  const probe = {
    ...request,
    transcriptFile: null,
    policy: {
      ...request.policy,
      asr: "off",
      visual: "off",
      extractTimeoutMs: Math.min(request.policy.extractTimeoutMs, 90000),
    },
  };
  const scratch = await mkdtemp(
    path.join(path.resolve(options["work-dir"]), "canary-"),
  );
  let state;
  try {
    const extracted = await extractSource(probe, { workDir: scratch });
    state = { state: "ok", cause: null };
    const warned = (code) =>
      extracted.extraction.warnings.some((w) => w.code === code);
    const via = warned("BOTGUARD_TOKEN")
      ? ", proof-of-origin token used"
      : warned("CAPTIONS_ANDROID_CLIENT")
        ? ", no token here: read from the Android-app caption list"
        : "";
    issues.push(
      issue(
        "CANARY_CAPTIONS_OK",
        `Captions acquired: ${extracted.segments.length} segments, timing ${extracted.extraction.timing}${via}.`,
        "warning",
      ),
    );
  } catch (error) {
    state = classifyCanary(error);
    issues.push(
      issue(
        `CANARY_CAPTIONS_${state.state.toUpperCase().replace("-", "_")}`,
        {
          blocked: `The platform refused this anonymous session (cause: ${state.cause}). ${state.cause === "transcript-refused-no-token" ? "No token could be minted here and the Android-app caption list was refused too: YouTube may have extended its gate; on macOS outside a host sandbox the token path may still work." : "The web track and the Android-app list were both refused: the gate changed."}`,
          broken: `Acquisition itself failed (cause: ${state.cause}). This is a code/update problem, not a permission problem: check bgutils-js/jsdom versions and the adapter.`,
          "no-captions":
            "This video exposes no captions; choose a canary video that has them.",
          unavailable: `The video is unavailable (cause: ${state.cause}); choose another canary video.`,
          environment: `This process cannot run the check (cause: ${state.cause}): no network access here, e.g. inside a host agent's sandboxed shell. Run the canary outside that sandbox; this says nothing about YouTube or the adapter.`,
        }[state.state] ?? "Unknown canary outcome.",
        "error",
      ),
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  if (options["yt-dlp-executable"]) {
    const scratch2 = await mkdtemp(
      path.join(path.resolve(options["work-dir"]), "canary-"),
    );
    try {
      const version = (
        await runLocalTool(options["yt-dlp-executable"], ["--version"], {
          workDir: scratch2,
          timeoutMs: 20000,
          maxBytes: 4096,
        })
      ).trim();
      await runLocalTool(
        options["yt-dlp-executable"],
        [
          "--simulate",
          ...YTDLP_POLICY_ARGS,
          "--js-runtimes",
          `node:${process.execPath}`,
          "-f",
          YTDLP_FORMAT,
          "--",
          canonicalUrl,
        ],
        { workDir: scratch2, timeoutMs: 90000, maxBytes: 1024 * 1024 },
      );
      issues.push(
        issue(
          "CANARY_YTDLP_OK",
          `yt-dlp ${version} can resolve an audio format for this video.`,
          "warning",
        ),
      );
    } catch (error) {
      issues.push(
        issue(
          "CANARY_YTDLP_BROKEN",
          `yt-dlp could not resolve an audio format (${error.code}). It is usually outdated: install the current release.`,
          "error",
        ),
      );
    } finally {
      await rm(scratch2, { recursive: true, force: true });
    }
  }
  const failed = issues.some((i) => i.severity === "error");
  return result(
    "canary",
    [],
    issues,
    failed ? "partial" : "ok",
    failed ? "ask-user" : "continue",
  );
}
if (isMain(import.meta.url))
  await runCli("canary", () =>
    canary(optionsFor(["request", "work-dir", "yt-dlp-executable"])),
  );
