import path from "node:path";
import { access, readFile } from "node:fs/promises";
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
import { makeEvidence, chunkDocument } from "../lib/evidence.mjs";
import { normalizeRequest } from "../lib/validation.mjs";
import { isMain, optionsFor, required, result, runCli } from "../lib/cli.mjs";

function tool(command) {
  const result = spawnSync(command, ["-version"], {
    timeout: 5000,
    maxBuffer: 4096,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    },
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
    return { status: "available", version: null };
  } catch {
    return { status: "unavailable", version: null };
  }
}
async function capabilities(options) {
  return {
    schemaVersion: 1,
    node: { status: "available", version: process.version },
    extractor: { status: "available", version: "0.25.3" },
    ffmpeg: tool("ffmpeg"),
    ffprobe: tool("ffprobe"),
    localAsrExecutable: await provided(options["local-asr-executable"], true),
    localAsrModel: await provided(options["local-asr-model"]),
    pdfBrowser: await provided(options["browser-executable"], true),
    ocr: await provided(
      options["ocr-executable"] ?? options["tesseract-executable"],
      true,
    ),
    ytDlp: await provided(options["yt-dlp-executable"], true),
    hostVision: { status: "unknown", version: null },
  };
}
export async function prepare(options) {
  required(options, ["request", "work-dir"]);
  const request = normalizeRequest((await readJson(options.request)).data);
  return withLock(options["work-dir"], async (workDir) => {
    const caps = await capabilities(options);
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
            }. Optional tools require a user decision before installation; host vision is not inferred. capabilities.json reflects the options passed to this call.`,
            "warning",
          ),
        ],
      );
    const extractionOptions = {
      workDir,
      localAsrExecutable: options["local-asr-executable"],
      localAsrModel: options["local-asr-model"],
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
    const { extractSource } = await import("../lib/ingest.mjs");
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
    // The contact sheet is a review index for the host (not evidence); it travels with the frames.
    const sheet = extracted.raw?.visualOcr?.contactSheet?.path;
    if (sheet && extracted.assetRoot)
      await atomicWrite(
        workDir,
        sheet,
        await readFile(path.join(extracted.assetRoot, sheet)),
      );
    await atomicWrite(workDir, "raw/extraction.json", jsonBytes(extracted.raw));
    const bytes = jsonBytes(evidence),
      evidenceSha256 = sha256(bytes);
    for (const chunk of evidence.chunks)
      await atomicWrite(
        workDir,
        `chunks/${chunk.id}.json`,
        jsonBytes(chunkDocument(evidence, chunk)),
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
          "local-asr-model",
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
