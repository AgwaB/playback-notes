import path from "node:path";
import { AppError, exists, jsonBytes, readJson, sha256 } from "./io.mjs";
import { ingestionFingerprint } from "./ingest.mjs";

export async function cacheKey(request, options = {}) {
  return sha256(
    JSON.stringify({
      source: request.source,
      ingestion: await ingestionFingerprint(request, options),
      normalizer: 1,
    }),
  );
}
export async function existingEvidence(workDir, key, refresh) {
  const file = path.join(workDir, "evidence.json");
  if (!(await exists(file))) return null;
  if (refresh)
    throw new AppError(
      "INVALID_CONTRACT",
      "Refresh needs a new work directory. Existing evidence is immutable.",
      4,
    );
  const manifest = (await readJson(path.join(workDir, "manifest.json"))).data;
  if (manifest.cacheKey !== key)
    throw new AppError(
      "EVIDENCE_MISMATCH",
      "Source or extraction inputs changed. Use a new work directory.",
    );
  const snapshot = await readJson(file);
  if (snapshot.sha256 !== manifest.evidenceSha256)
    throw new AppError("EVIDENCE_MISMATCH", "Cached evidence changed on disk.");
  if (snapshot.data.extraction.status !== "complete")
    throw new AppError(
      "UNREVIEWED_EVIDENCE",
      "Use the existing partial snapshot only after scope-specific approval; it is not a complete cache hit.",
      3,
    );
  return snapshot;
}
export const requestRevision = (request) =>
  `requests/${sha256(jsonBytes(request)).slice(0, 24)}.json`;
