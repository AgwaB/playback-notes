import path from "node:path";
import { isMain, optionsFor, required, result, runCli } from "../lib/cli.mjs";
import {
  AppError,
  artifact,
  atomicWrite,
  exists,
  issue,
  jsonBytes,
  readJson,
} from "../lib/io.mjs";
import { normalizeRequest, validateEvidence } from "../lib/validation.mjs";

/**
 * Write a report.json skeleton bound to the exact evidence bytes (id + SHA-256, mode,
 * output language) so the host only authors content, and return an authoring card: the
 * required fields, block shapes and the evidence IDs it may cite. The skeleton is
 * deliberately incomplete (empty title/summary/sections) and fails validation until filled.
 */
export async function scaffold(options) {
  required(options, ["request", "evidence", "work-dir"]);
  const request = normalizeRequest((await readJson(options.request)).data);
  const evidenceFile = await readJson(options.evidence);
  const evidence = evidenceFile.data;
  validateEvidence(evidence);
  const reportPath = path.join(options["work-dir"], "report.json");
  if ((await exists(reportPath)) && !options.force)
    throw new AppError(
      "OUTPUT_EXISTS",
      "report.json already exists; edit it, or pass --force to replace it with a new skeleton.",
      3,
    );
  const skeleton = {
    schemaVersion: 1,
    evidenceRef: { id: evidence.id, sha256: evidenceFile.sha256 },
    mode: request.mode,
    outputLanguage: request.outputLanguage,
    title: "",
    summary: [],
    sections: [],
    caveats: [],
  };
  await atomicWrite(options["work-dir"], "report.json", jsonBytes(skeleton));
  const segments = evidence.segments;
  const card = [
    `report.json skeleton written for ${evidence.id} (mode ${request.mode}, language ${request.outputLanguage}); evidenceRef is already correct — do not recompute it.`,
    "Required: title (string), summary (≥1 statement), sections [{id, heading, blocks ≥1}], caveats (statements, may be empty).",
    'Statement: {"text", "attribution": "source"|"interpretation", "citations": [{"kind": "segment"|"frame", "id"}]}.',
    "Blocks: paragraph{statement} · list{ordered, items[statement]} · table{columns[string], rows[[statement]]} · quote{statement, verbatim} · code{text, language|null, attribution, citations} · figure{frameId, alt, caption(statement citing that frame)} · diagram{kind stack|flow, id, title, alt, nodes, edges, caption} — see references/report-authoring.md.",
    segments.length
      ? `Segments: ${segments.length} (${segments[0].id} … ${segments.at(-1).id}); chunks: ${evidence.chunks.map((c) => c.id).join(", ")} — list the ones you read in analysis-ledger.json reviewedChunkIds.`
      : "No transcript segments: cite inspected frames only.",
    evidence.frames.length
      ? `Frames: ${evidence.frames.length}${evidence.frames.some((f) => f.ocrText) ? " (with OCR hints)" : ""}; review the contact sheets (assets/contact-sheet-NN.jpg) with assets/contact-sheet.txt when present, open candidates at full size, and list every cited frame in analysis-ledger.json inspectedFrameIds.`
      : "No frames.",
    "Then run validate.mjs; fix what it reports against the evidence.",
  ];
  return result(
    "scaffold",
    [await artifact(options["work-dir"], "report.json", "report")],
    card.map((text) => issue("AUTHORING_GUIDE", text, "info")),
  );
}
if (isMain(import.meta.url))
  await runCli("scaffold", () =>
    scaffold(optionsFor(["request", "evidence", "work-dir"], ["force"])),
  );
