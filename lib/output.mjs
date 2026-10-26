import path from "node:path";
import { readdir, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import {
  AppError,
  artifact,
  atomicWrite,
  checkOutputRoots,
  containedFile,
  exists,
  fileHash,
  jsonBytes,
  readJson,
  sha256,
} from "./io.mjs";
import { htmlDocument } from "./rendering.mjs";
import { statements } from "./validation.mjs";

export const filenames = Object.freeze({
  html: "index.html",
  markdown: "report.md",
  pdf: "report.pdf",
});
/**
 * A fresh revision starts in an empty directory (checked under the writer lock), so until
 * its manifest is committed everything in it belongs to the current attempt. On failure the
 * attempt removes all of it (the lock excepted) so a corrected retry can reuse the directory
 * and nothing partial can be inherited. Committed revisions are never touched here.
 */
export async function abandonFreshOutput(out) {
  for (const name of await readdir(out))
    if (name !== ".write.lock")
      await rm(path.join(out, name), { recursive: true, force: true });
}
export async function initializeOutput(bundle, options) {
  if (!options["out-dir"])
    throw new AppError("INVALID_CONTRACT", "Missing --out-dir.", 4);
  const inputs = [
    options.request,
    options.evidence,
    options.analysis,
    options.report,
    bundle.request.transcriptFile,
    bundle.request.source.kind === "local" ? bundle.request.source.value : null,
  ];
  const { out } = await checkOutputRoots(
    bundle.workDir,
    options["out-dir"],
    inputs,
  );
  const artifacts = [],
    assets = [];
  let media = null;
  const analysisSha256 = sha256(jsonBytes(bundle.analysis));
  const manifestPath = path.join(out, "manifest.json");
  if (await exists(manifestPath)) {
    const prior = (await readJson(manifestPath)).data;
    if (
      prior.reportSha256 !== bundle.reportSha256 ||
      prior.evidenceSha256 !== bundle.evidenceSha256
    )
      throw new AppError(
        "EVIDENCE_MISMATCH",
        "Different report/evidence requires a new output revision.",
      );
    if (
      prior.analysisSha256 !== analysisSha256 ||
      prior.copyLocalMedia !== bundle.request.policy.copyLocalMedia ||
      JSON.stringify(prior.requestedFormats) !==
        JSON.stringify(bundle.request.formats)
    )
      throw new AppError(
        "EVIDENCE_MISMATCH",
        "Changed analysis, sharing policy or formats requires a new output revision. Existing revisions are not modified.",
      );
    if (Array.isArray(prior.artifacts)) {
      for (const entry of prior.artifacts) {
        if (
          !filenames[entry.format] ||
          entry.path !== filenames[entry.format] ||
          !["created", "reused"].includes(entry.status)
        )
          continue;
        const actual = await artifact(out, entry.path, entry.format, "reused");
        if (actual.sha256 !== entry.sha256)
          throw new AppError(
            "EVIDENCE_MISMATCH",
            "Existing output has changed outside this job.",
          );
        artifacts.push(actual);
      }
    }
  } else if ((await readdir(out)).some((name) => name !== ".write.lock")) {
    // A fresh revision starts from an empty directory: anything else (a report, assets or
    // media from another or an interrupted attempt) is unowned and must not be joined.
    throw new AppError(
      "OUTPUT_EXISTS",
      "Unowned output files exist. Choose an empty output directory.",
    );
  }
  // Every frame the report cites (figure or inline citation) ships with the output.
  const citedFrames = new Set([
    ...bundle.report.sections
      .flatMap((s) => s.blocks)
      .filter((b) => b.type === "figure")
      .map((b) => b.frameId),
    ...statements(bundle.report).flatMap((s) =>
      s.citations.filter((c) => c.kind === "frame").map((c) => c.id),
    ),
  ]);
  const fresh = !(await exists(manifestPath));
  let imageBytes = 0;
  try {
    for (const frame of bundle.evidence.frames.filter((f) =>
      citedFrames.has(f.id),
    )) {
      const file = await containedFile(
        bundle.workDir,
        frame.assetPath,
        20 * 1024 * 1024,
      );
      const bytes = await readFile(file);
      if (sha256(bytes) !== frame.sha256)
        throw new AppError(
          "EVIDENCE_MISMATCH",
          "Frame changed during rendering.",
        );
      imageBytes += bytes.length;
      if (imageBytes > 128 * 1024 * 1024)
        throw new AppError(
          "RESOURCE_LIMIT",
          "Referenced images exceed the output asset budget.",
        );
      await atomicWrite(out, frame.assetPath, bytes);
      assets.push(await artifact(out, frame.assetPath, "image"));
    }
    if (
      bundle.request.policy.copyLocalMedia &&
      bundle.evidence.source.playback.locator?.startsWith("media:")
    ) {
      const privateManifest = (
        await readJson(path.join(bundle.workDir, "manifest.json"))
      ).data;
      if (
        privateManifest.evidenceSha256 !== bundle.evidenceSha256 ||
        !privateManifest.mediaPath ||
        (await fileHash(privateManifest.mediaPath)) !==
          privateManifest.mediaSha256
      )
        throw new AppError(
          "EVIDENCE_MISMATCH",
          "Local media no longer matches the acquired evidence.",
        );
      // Large media is streamed separately rather than loaded into the report renderer.
      const { copyMedia } = await import("./media-copy.mjs");
      await copyMedia(
        privateManifest.mediaPath,
        out,
        `media/${bundle.evidence.source.id}`,
        bundle.request.policy.maxDownloadBytes,
        privateManifest.mediaSha256,
      );
      media = await artifact(
        out,
        `media/${bundle.evidence.source.id}`,
        "media",
      );
    }
  } catch (error) {
    if (fresh) await abandonFreshOutput(out);
    throw error;
  }
  const manifest = {
    schemaVersion: 1,
    sourceId: bundle.evidence.source.id,
    mode: bundle.report.mode,
    revision: path.basename(out),
    reportSha256: bundle.reportSha256,
    evidenceSha256: bundle.evidenceSha256,
    analysisSha256,
    contentStatus:
      bundle.evidence.extraction.status === "partial" ||
      bundle.analysis.status === "partial"
        ? "partial"
        : "complete",
    requestedFormats: bundle.request.formats,
    copyLocalMedia: bundle.request.policy.copyLocalMedia,
    assets,
    media,
    artifacts,
    issues: [],
    overallStatus: "incomplete",
  };
  return { out, manifest, fresh };
}
/**
 * Run a render/export transaction: on any failure before the manifest commit, a fresh
 * revision is abandoned (directory emptied), an existing revision is left as it was.
 */
export async function outputTransaction(bundle, options, body) {
  const context = await initializeOutput(bundle, options);
  try {
    return await body(context);
  } catch (error) {
    if (context.fresh) await abandonFreshOutput(context.out);
    throw error;
  }
}
export function setArtifact(manifest, entry) {
  manifest.artifacts = manifest.artifacts.filter(
    (item) => item.format !== entry.format,
  );
  manifest.artifacts.push(entry);
}
export async function finalizeOutput(bundle, context, { html = true } = {}) {
  const { out, manifest } = context;
  for (const format of manifest.requestedFormats)
    if (!manifest.artifacts.some((a) => a.format === format))
      setArtifact(manifest, { format, path: null, status: "blocked" });
  if (html && bundle.request.formats.includes("html")) {
    await atomicWrite(
      out,
      "index.html",
      htmlDocument(bundle, manifest.artifacts, manifest.issues),
    );
    setArtifact(manifest, await artifact(out, "index.html", "html"));
  }
  manifest.overallStatus = manifest.requestedFormats.every((format) =>
    manifest.artifacts.some(
      (a) => a.format === format && ["created", "reused"].includes(a.status),
    ),
  )
    ? "completed"
    : "incomplete";
  await atomicWrite(out, "manifest.json", jsonBytes(manifest));
  return manifest;
}
