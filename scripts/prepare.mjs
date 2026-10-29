import path from "node:path";
import os from "node:os";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  artifact,
  atomicWrite,
  fileHash,
  jsonBytes,
  readJson,
  sha256,
  withLock,
  issue,
} from "../lib/io.mjs";
import { cacheKey, existingEvidence, requestRevision } from "../lib/cache.mjs";
import { makeEvidence, chunkDocument, indexEvidence } from "../lib/evidence.mjs";
import { normalizeRequest } from "../lib/validation.mjs";
import { isMain, optionsFor, required, result, runCli } from "../lib/cli.mjs";
import { validateCodeSwitch } from "../lib/asr-language-recheck.mjs";
import { isolatedEnvironment } from "../lib/runtime.mjs";

function tool(command, workDir) {
  const result = spawnSync(command, ["-version"], {
    timeout: 5000,
    maxBuffer: 4096,
    encoding: "utf8",
    env: isolatedEnvironment(workDir),
    cwd: workDir,
    windowsHide: true,
  });
  return {
    status: result.error || result.status !== 0 ? "unavailable" : "available",
    version:
      result.status === 0 ? result.stdout.split("\n")[0].slice(0, 200) : null,
  };
}
async function provided(file, executable = false) {
  if (!file) return { status: "unavailable", version: null };
  try {
    await access(file, executable ? constants.X_OK : constants.R_OK);
    if (!(await stat(file)).isFile()) return { status: "unavailable", version: null };
    return { status: "available", version: null };
  } catch {
    return { status: "unavailable", version: null };
  }
}
async function capabilities(options, workDir) {
  // Extraction launches tools inside a fresh child directory, not the outer job.
  // Match that boundary so relative Windows PATH entries resolve identically.
  const probeDir = await mkdtemp(path.join(workDir, "preflight-"));
  try {
    return {
      schemaVersion: 1,
      node: { status: "available", version: process.version },
      extractor: { status: "available", version: "0.25.3" },
      ffmpeg: tool("ffmpeg", probeDir),
      ffprobe: tool("ffprobe", probeDir),
      localAsrExecutable: await provided(options["local-asr-executable"], true),
      localAsrGpuExecutable: await provided(options["local-asr-gpu-executable"], true),
      localAsrModel: await provided(options["local-asr-model"]),
      pdfBrowser: await provided(options["browser-executable"], true),
      ocr: await provided(
        options["ocr-executable"] ?? options["tesseract-executable"],
        true,
      ),
      ytDlp: await provided(options["yt-dlp-executable"], true),
      hostVision: { status: "unknown", version: null },
    };
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}
// A user-owned preference applies only to its matching explicit CPU runtime and model.
/** ASR preference files in priority order; the second is the name used before the rename. */
export const asrPreferencePaths = (home = os.homedir()) => [
  path.join(home, ".agents", "playback-notes-asr.json"),
  path.join(home, ".agents", "video-summarizer-asr.json"),
];

// The first preference file that exists wins, even if it is malformed or does not match.
async function existingPreference(paths) {
  for (const candidate of [paths].flat()) {
    try {
      return { path: candidate, info: await stat(candidate) };
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return null;
    }
  }
  return null;
}

export async function preferredGpu(options, request, preferencePaths) {
  if (request.policy.asr !== "local" || options["local-asr-gpu-executable"] ||
      !options["local-asr-executable"] || !options["local-asr-model"]) return options;
  try {
    const found = await existingPreference(preferencePaths);
    if (!found || found.info.size > 64 * 1024) return options;
    const preferencePath = found.path;
    const preference = JSON.parse(await readFile(preferencePath, "utf8"));
    const values = [preference.localAsrExecutable, preference.localAsrModel, preference.localAsrGpuExecutable];
    if (!values.every((value) => typeof value === "string" && path.isAbsolute(value))) return options;
    const normalize = (value) => {
      const resolved = path.resolve(value);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    if (normalize(values[0]) !== normalize(options["local-asr-executable"]) ||
        normalize(values[1]) !== normalize(options["local-asr-model"])) return options;
    return { ...options, "local-asr-gpu-executable": values[2] };
  } catch {
    // A missing or malformed optional preference must not disable explicit CPU ASR.
    return options;
  }
}
export async function prepare(options, { asrPreferencePath = asrPreferencePaths() } = {}) {
  required(options, ["request", "work-dir"]);
  validateCodeSwitch(options["local-asr-code-switch"]);
  const request = normalizeRequest((await readJson(options.request)).data);
  options = await preferredGpu(options, request, asrPreferencePath);
  return withLock(options["work-dir"], async (workDir) => {
    const caps = await capabilities(options, workDir);
    await atomicWrite(workDir, "capabilities.json", jsonBytes(caps));
    if (options.check)
      return result(
        "preflight",
        [await artifact(workDir, "capabilities.json", "capabilities")],
        [
          issue(
            "CAPABILITY_NOTICE",
            `Unavailable for this invocation: ${
              Object.entries(caps)
                .filter(([, value]) => value?.status === "unavailable")
                .map(([name]) => name)
                .join(", ") || "none"
            }. Optional tools require a user decision before installation; host vision is not inferred. capabilities.json reflects the options passed to this call.${
              process.platform !== "win32" && [caps.ffmpeg, caps.ffprobe].some((cap) => cap.status === "unavailable")
                ? " Media tools must be available in the extraction worker's tool directories: /opt/homebrew/bin, /usr/local/bin, /usr/bin or /bin."
                : ""
            }`,
            "warning",
          ),
        ],
      );
    const extractionOptions = {
      workDir,
      localAsrExecutable: options["local-asr-executable"],
      localAsrGpuExecutable: options["local-asr-gpu-executable"],
      localAsrModel: options["local-asr-model"],
      localAsrCodeSwitch: options["local-asr-code-switch"],
      youtubeCapture: options["youtube-capture"],
      tesseractExecutable: options["tesseract-executable"],
      ocrLanguages: options["ocr-languages"],
      ocrMaxFrames: options["ocr-max-frames"],
      ocrSceneThreshold: options["ocr-scene-threshold"],
      ocrSampleSeconds: options["ocr-sample-seconds"],
      ocrPsm: options["ocr-psm"],
      ocrEngine: options["ocr-engine"],
      ocrRegion: options["ocr-region"],
      ocrExecutable: options["ocr-executable"],
      ytDlpExecutable: options["yt-dlp-executable"],
    };
    const key = await cacheKey(request, extractionOptions);
    const reused = await existingEvidence(workDir, key, options.refresh);
    await atomicWrite(workDir, requestRevision(request), jsonBytes(request));
    if (reused)
      return result(
        "prepare",
        [await artifact(workDir, "evidence.json", "evidence", "reused")],
        request.source.kind === "url"
          ? [
              issue(
                "CACHED_SOURCE",
                "Reused an existing source snapshot; remote freshness was not rechecked. Use --refresh with a new work directory to reacquire it.",
                "warning",
              ),
            ]
          : [],
      );
    // No evidence was committed here, so extraction folders whose owner is gone are from a
    // run killed before it could remove them (a closed terminal or a cancelled host); they
    // can hold a decoded WAV and a copied model. A folder still in use (a native tool of the
    // killed run holding a file open, which Windows refuses to delete) is left for a later
    // run rather than failing this one.
    const { extractSource, leftoverExtractionFolders } = await import(
      "../lib/ingest.mjs"
    );
    for (const folder of await leftoverExtractionFolders(workDir))
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    const extracted = await extractSource(request, extractionOptions);
    const evidence = makeEvidence(extracted);
    // Sampled frames move from the private extraction root into the job's assets/ so the
    // renderer's contained-path checks resolve; bytes are re-hashed on the way.
    for (const frame of evidence.frames) {
      const frameBytes = await readFile(
        path.join(extracted.assetRoot, frame.assetPath),
      );
      if (sha256(frameBytes) !== frame.sha256)
        throw new Error("Frame changed during extraction.");
      await atomicWrite(workDir, frame.assetPath, frameBytes);
    }
    // The contact sheet and its index are review aids for the host (not evidence); they
    // travel with the frames.
    const sheet = extracted.raw?.visualOcr?.contactSheet;
    if (sheet && extracted.assetRoot)
      for (const file of [...sheet.sheets, sheet.index])
        await atomicWrite(
          workDir,
          file,
          await readFile(path.join(extracted.assetRoot, file)),
        );
    await atomicWrite(workDir, "raw/extraction.json", jsonBytes(extracted.raw));
    const bytes = jsonBytes(evidence),
      evidenceSha256 = sha256(bytes);
    const evidenceIndex = indexEvidence(evidence);
    for (const chunk of evidence.chunks)
      await atomicWrite(
        workDir,
        `chunks/${chunk.id}.json`,
        jsonBytes(chunkDocument(evidence, chunk, evidenceIndex)),
      );
    await atomicWrite(
      workDir,
      "analysis-ledger.json",
      jsonBytes({
        schemaVersion: 1,
        evidenceId: evidence.id,
        reviewedChunkIds: [],
        inspectedFrameIds: [],
        status: "partial",
        limitations: ["Host has not reviewed the evidence yet."],
      }),
    );
    const mediaPath = extracted.mediaPath
      ? path.resolve(extracted.mediaPath)
      : null;
    const manifest = {
      schemaVersion: 1,
      cacheKey: key,
      evidenceSha256,
      evidenceId: evidence.id,
      sourceId: evidence.source.id,
      sourceInput: request.source,
      transcriptFile: request.transcriptFile,
      mediaPath,
      mediaSha256: mediaPath ? await fileHash(mediaPath) : null,
      locator: evidence.source.playback.locator,
      createdAt: new Date().toISOString(),
    };
    await atomicWrite(workDir, "manifest.json", jsonBytes(manifest));
    // Evidence is the commit marker; interrupted earlier writes are never a cache hit.
    await atomicWrite(workDir, "evidence.json", bytes);
    const artifacts = [
      await artifact(workDir, "evidence.json", "evidence"),
      await artifact(workDir, "analysis-ledger.json", "analysis"),
      await artifact(workDir, "manifest.json", "manifest"),
    ];
    // Review aids for key-scene selection are listed so the host sees them in the envelope.
    if (sheet && extracted.assetRoot)
      artifacts.push(
        ...(await Promise.all(
          sheet.sheets.map((file) => artifact(workDir, file, "contact-sheet")),
        )),
        await artifact(workDir, sheet.index, "contact-sheet-index"),
      );
    return result(
      "prepare",
      artifacts,
      evidence.extraction.warnings,
      evidence.extraction.status === "partial" ? "needs-input" : "ok",
      evidence.extraction.status === "partial" ? "ask-user" : "continue",
    );
  });
}
if (isMain(import.meta.url))
  await runCli("prepare", () =>
    prepare(
      optionsFor(
        [
          "request",
          "work-dir",
          "browser-executable",
          "local-asr-executable",
          "local-asr-gpu-executable",
          "local-asr-model",
          "local-asr-code-switch",
          "youtube-capture",
          "tesseract-executable",
          "ocr-languages",
          "ocr-max-frames",
          "ocr-scene-threshold",
          "ocr-sample-seconds",
          "ocr-psm",
          "ocr-engine",
          "ocr-region",
          "ocr-executable",
          "yt-dlp-executable",
        ],
        ["check", "refresh"],
      ),
    ),
  );
