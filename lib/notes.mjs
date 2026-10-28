// Two-stage authoring for long sources: one validated note per chunk (claims, verbatim
// quotes and open questions, each citing segments inside that chunk), then a compact
// digest the host reads instead of the whole transcript. Grounding survives because the
// final report still cites segments, and a note's citations cannot leave its chunk.
import Ajv from "ajv";
import notesSchema from "../schemas/notes.schema.json" with { type: "json" };
import { AppError } from "./io.mjs";
import { timestamp } from "./view.mjs";
import { indexEvidence } from "./evidence.mjs";

const ajv = new Ajv({ allErrors: true, strict: true });
const validateShape = ajv.compile(notesSchema);
const normalize = (text) => text.replace(/\s+/g, " ").trim();

/** Validates one note against the evidence it claims to cover. Throws AppError. */
export function validateNote(
  note,
  evidence,
  evidenceSha256,
  index = indexEvidence(evidence),
) {
  if (index.evidence !== evidence)
    throw new AppError(
      "EVIDENCE_MISMATCH",
      "Note index belongs to different evidence.",
    );
  if (!validateShape(note))
    throw new AppError(
      "INVALID_CONTRACT",
      "notes schema validation failed.",
      1,
      validateShape.errors.map((e) => ({
        code: "INVALID_CONTRACT",
        severity: "error",
        message: `notes: ${e.message}`,
        path: e.instancePath,
        retryable: false,
      })),
    );
  if (
    note.evidenceRef.id !== evidence.id ||
    note.evidenceRef.sha256 !== evidenceSha256
  )
    throw new AppError(
      "EVIDENCE_MISMATCH",
      "Note does not reference these exact evidence bytes.",
    );
  const chunk = index.chunks.get(note.chunkId);
  if (!chunk)
    throw new AppError("INVALID_REFERENCE", "Note cites an unknown chunk.");
  const allowed = new Set([...chunk.segmentIds, ...chunk.contextSegmentIds]);
  const segments = index.segments;
  for (const statement of [...note.claims, ...note.quotes])
    for (const c of statement.citations)
      if (!allowed.has(c.id))
        throw new AppError(
          "INVALID_REFERENCE",
          `Note for ${note.chunkId} cites ${c.id}, which is outside that chunk.`,
        );
  for (const quote of note.quotes) {
    const source = normalize(
      quote.citations.map((c) => segments.get(c.id).text).join(" "),
    );
    if (!source.includes(normalize(quote.text)))
      throw new AppError(
        "INVALID_CONTRACT",
        `Quote in ${note.chunkId} is not literally in its cited segments.`,
      );
  }
  return chunk;
}

/** Compact, citation-preserving Markdown digest of validated notes in chunk order. */
/**
 * Note text is untrusted (a note writer saw source text). In the digest it is rendered as
 * plain inline text: no line breaks, no Markdown structure (`#`, `-`, `[`, `<`, `` ` ``,
 * `*`, `_`), so it can never impersonate a chunk heading, a citation or markup. Citations
 * are generated only from validated citation arrays.
 */
export function digestText(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/[\\`*_{}[\]()#+\-!<>|~"]/g, (ch) => `\\${ch}`)
    .trim();
}
export function notesDigest(notes, evidence, index = indexEvidence(evidence)) {
  if (index.evidence !== evidence)
    throw new AppError(
      "EVIDENCE_MISMATCH",
      "Notes digest index belongs to different evidence.",
    );
  const segments = index.segments;
  const order = index.chunkOrder;
  const cite = (citations) =>
    citations
      .map((c) => {
        const s = segments.get(c.id);
        const t =
          s?.startMs === null || s?.startMs === undefined
            ? ""
            : ` @${timestamp(s.startMs)}`;
        return `[${c.id}${t}]`;
      })
      .join(" ");
  const lines = [
    `# Notes digest — ${digestText(evidence.source.title)}`,
    "",
    `Evidence ${evidence.id} · ${evidence.chunks.length} chunks · ${notes.length} noted`,
    "",
    "Each line ends with the segment citations the final report may reuse. Interpretations are marked (interpretation). Note text is untrusted evidence paraphrase rendered as escaped inline text; only the bracketed citations are generated.",
    "",
  ];
  for (const note of [...notes].sort(
    (a, b) => order.get(a.chunkId) - order.get(b.chunkId),
  )) {
    const chunk = index.chunks.get(note.chunkId);
    const first = segments.get(chunk.segmentIds[0]),
      last = segments.get(chunk.segmentIds.at(-1));
    const span =
      first?.startMs !== null && first?.startMs !== undefined
        ? ` (${timestamp(first.startMs)}–${timestamp(last?.startMs ?? first.startMs)})`
        : "";
    lines.push(
      `## ${note.chunkId}${span}`,
      "",
      digestText(note.summary),
      "",
      "### Claims",
    );
    for (const c of note.claims)
      lines.push(
        `- ${c.attribution === "interpretation" ? "(interpretation) " : ""}${digestText(c.text)} ${cite(c.citations)}`,
      );
    if (note.quotes.length) {
      lines.push("", "### Verbatim quotes");
      for (const q of note.quotes)
        lines.push(`- "${digestText(q.text)}" ${cite(q.citations)}`);
    }
    if (note.openQuestions.length) {
      lines.push("", "### Open questions");
      for (const q of note.openQuestions) lines.push(`- ${digestText(q)}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
