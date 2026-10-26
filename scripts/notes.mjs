import path from "node:path";
import { readdir } from "node:fs/promises";
import { isMain, optionsFor, required, result, runCli } from "../lib/cli.mjs";
import {
  AppError,
  artifact,
  atomicWrite,
  issue,
  jsonBytes,
  readJson,
  withLock,
} from "../lib/io.mjs";
import { validateEvidence } from "../lib/validation.mjs";
import { notesDigest, validateNote } from "../lib/notes.mjs";

async function lockWithRetry(dir, body, attempts = 40) {
  for (let i = 0; ; i++) {
    try {
      return await withLock(dir, body);
    } catch (error) {
      if (error?.code !== "BUSY" || i >= attempts) throw error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
/**
 * Validate per-chunk notes under --notes-dir against --evidence, write notes-digest.md into
 * --work-dir and, with --update-ledger, record the noted chunks as reviewed in the ledger.
 */
export async function notes(options) {
  required(options, ["evidence", "notes-dir", "work-dir"]);
  const evidenceFile = await readJson(options.evidence);
  const evidence = evidenceFile.data;
  validateEvidence(evidence);
  const dir = path.resolve(options["notes-dir"]);
  const files = (await readdir(dir))
    .filter((f) => /^chunk-\d{5}\.json$/.test(f))
    .sort();
  const notes = [];
  const issues = [];
  for (const file of files) {
    try {
      const note = (await readJson(path.join(dir, file))).data;
      if (`${note.chunkId}.json` !== file)
        throw new AppError(
          "INVALID_CONTRACT",
          `Note file ${file} is named for another chunk.`,
        );
      validateNote(note, evidence, evidenceFile.sha256);
      notes.push(note);
    } catch (error) {
      issues.push(
        issue(
          error instanceof AppError ? error.code : "INVALID_CONTRACT",
          `${file}: ${error instanceof AppError ? error.message : "could not be read"}`,
          "error",
          file,
        ),
      );
    }
  }
  const noted = new Set(notes.map((n) => n.chunkId));
  const missing = evidence.chunks
    .map((c) => c.id)
    .filter((id) => !noted.has(id));
  const artifacts = [];
  const ledgerPath = path.resolve(
    options.analysis ?? path.join(options["work-dir"], "analysis-ledger.json"),
  );
  // Digest and ledger are written inside the work directory's writer lock (plus the
  // ledger directory's lock when it lives elsewhere; always in that order): atomic
  // replacement alone would let two concurrent invocations each merge from the same stale
  // read and lose the other's chunks. A busy lock is retried briefly, then reported.
  const ledgerDir = path.dirname(ledgerPath);
  const workDir = path.resolve(options["work-dir"]);
  const locked = (body) =>
    lockWithRetry(workDir, () =>
      ledgerDir === workDir ? body() : lockWithRetry(ledgerDir, body),
    );
  await locked(async () => {
    if (notes.length) {
      await atomicWrite(
        options["work-dir"],
        "notes-digest.md",
        Buffer.from(notesDigest(notes, evidence), "utf8"),
      );
      artifacts.push(
        await artifact(options["work-dir"], "notes-digest.md", "digest"),
      );
    }
    if (options["update-ledger"] && !issues.length) {
      await (async () => {
        const ledger = (await readJson(ledgerPath)).data;
        if (ledger.evidenceId !== evidence.id)
          throw new AppError(
            "EVIDENCE_MISMATCH",
            "Ledger belongs to different evidence.",
          );
        // Status and the missing-review limitation follow the UNION of what the ledger
        // already recorded and what this invocation validated — cumulative review from
        // several note directories (or host review plus notes) must not regress to partial.
        const reviewed = new Set([...ledger.reviewedChunkIds, ...noted]);
        const unreviewed = evidence.chunks
          .map((c) => c.id)
          .filter((id) => !reviewed.has(id));
        const generated = (l) =>
          l.startsWith("Chunks without validated notes") ||
          l === "Host has not reviewed the evidence yet.";
        const next = {
          ...ledger,
          reviewedChunkIds: evidence.chunks
            .map((c) => c.id)
            .filter((id) => reviewed.has(id)),
          status: unreviewed.length ? "partial" : "complete",
          limitations: [
            ...ledger.limitations.filter((l) => !generated(l)),
            ...(unreviewed.length
              ? [`Chunks without validated notes: ${unreviewed.join(", ")}.`]
              : []),
          ],
        };
        await atomicWrite(
          path.dirname(ledgerPath),
          path.basename(ledgerPath),
          jsonBytes(next),
        );
        artifacts.push(
          await artifact(
            path.dirname(ledgerPath),
            path.basename(ledgerPath),
            "analysis",
          ),
        );
      })();
    }
  });
  if (missing.length)
    issues.push(
      issue(
        "NOTES_INCOMPLETE",
        `Chunks without validated notes: ${missing.join(", ")}.`,
        "warning",
      ),
    );
  const failed = issues.some((i) => i.severity === "error");
  return result(
    "notes",
    artifacts,
    issues,
    failed ? "error" : missing.length ? "partial" : "ok",
    failed ? "stop" : missing.length ? "ask-user" : "continue",
  );
}
if (isMain(import.meta.url))
  await runCli("notes", () =>
    notes(
      optionsFor(
        ["evidence", "notes-dir", "work-dir", "analysis"],
        ["update-ledger"],
      ),
    ),
  );
