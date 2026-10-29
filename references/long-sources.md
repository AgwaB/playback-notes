# Long sources: two-stage authoring with chunk notes

Reading every chunk into one context makes cost grow with length (a 3.5-hour podcast cost ~8M tokens and 16 minutes for a five-page briefing). For sources with more than roughly six chunks, author in two stages. Grounding is unchanged: the final report still cites segments, and the validator still rejects anything outside reviewed chunks.

## Stage 1 — one note per chunk

For each chunk, write `notes/chunk-NNNNN.json` (private, next to the job). Read it with `scripts/read.mjs --evidence "$JOB/evidence.json" --chunk chunk-NNNNN --sha256 <evidence-hash>` rather than dumping raw JSON; follow all `NEXT offset=N` pages with `--offset N --sha256 <same-hash>` until `END`. Pin the parent-supplied evidence hash throughout; changed evidence requires a fresh review, not mixed snapshots. The writer reads **only that chunk** (plus its listed context segments), so chunks can be noted in parallel by delegated workers, each with a small context. The parent need not re-read raw chunks already covered by validated notes, except for source spot-checks. Raw `chunks/chunk-NNNNN.json` remain available for targeted inspection.

```json
{
  "schemaVersion": 1,
  "evidenceRef": { "id": "ev-…", "sha256": "ACTUAL_EVIDENCE_FILE_HASH" },
  "chunkId": "chunk-00001",
  "summary": "2–4 sentences: what this stretch is about.",
  "claims": [
    { "text": "A claim with its condition kept.", "attribution": "source", "citations": [{ "kind": "segment", "id": "seg-000012" }] },
    { "text": "Why the speaker's example matters.", "attribution": "interpretation", "citations": [{ "kind": "segment", "id": "seg-000015" }] }
  ],
  "quotes": [
    { "text": "exact words from the cited segments", "attribution": "source", "citations": [{ "kind": "segment", "id": "seg-000020" }] }
  ],
  "openQuestions": ["Anything ambiguous or unresolved in this chunk."]
}
```

Cite the **contiguous run** that supports a claim — every segment ID from the first to the last supporting segment (up to about twelve), not just one anchor. Each citation stays its own link (the HTML folds the extras behind a “more” disclosure), so the reader can open every supporting moment, and the synthesizer inherits honest anchors. Do not cite a marker-only segment.

Rules enforced by `scripts/notes.mjs`: the hash must match the real `evidence.json` bytes; every citation must belong to the note's chunk (or its context segments); every quote must occur literally in its cited segments; 1–80 claims, ≤40 quotes. Notes contain no frames and no HTML. A note is a reading record: write it only after actually reading the chunk.

## Stage 2 — digest, then report

```bash
node "$SKILL/scripts/notes.mjs" --evidence "$JOB/evidence.json" --notes-dir "$JOB/notes" --work-dir "$JOB" --analysis "$JOB/analysis-ledger.json" --update-ledger
```

This validates every note, writes `notes-digest.md` (chunk order, each claim/quote with its `[seg-id @time]` citations) and, when all notes validate, adds the noted chunks to `analysis-ledger.json`'s reviewed set, which is cumulative: chunks already recorded as reviewed (by the host or by an earlier notes run) stay reviewed, and the ledger is `complete` once every chunk is covered, otherwise `partial` with the still-unreviewed chunks named. Concurrent notes runs on one ledger are serialised. A single bad note stops the ledger update and is reported per file.

Author `report.json` from the digest: reuse the digest's segment citations for each statement, and prefer the digest's verbatim quotes for `verbatim: true` quote blocks. Then validate, render and export as usual. The report may cite only chunks recorded as reviewed in the ledger.

## Measured

Lex Fridman #333 (3 h 28 min, 5,502 caption segments, 18 chunks): single-host authoring took 16 min and ~7.9M tokens (mostly cache re-reads of a growing context) for a 5-page briefing. Two-stage: 18 note writers in parallel (6 at a time) finished in ~3 min wall-clock for ~1.2M tokens, all 18 notes validated first time (433 claims, 81 literal quotes); one synthesizer wrote and validated a 9-section, 6-page briefing from the 114 KB digest in 2.4 min for ~0.42M tokens. About 5× fewer tokens and 3× faster, with the same validator guarantees.

## Boundaries

- Preserve citations covering the actual supporting run, including material qualifications; a single anchor is not a substitute for the rest of the support. Keep synthesized statements close to the validated notes. If synthesis changes a claim, re-read the relevant evidence and adjust its supporting citations. Spot-check claims against the transcript.

- Delegated note writers get one chunk each, the evidence hash, and the rules above; they must not read other chunks or invent timing. The parent spot-checks a sample of claims against the transcript before synthesis.
- Partial coverage is still partial: if some chunks have no notes, keep `status: partial` and use the existing partial-analysis approval; do not synthesize over missing stretches.
- The digest is private (it contains transcript quotes). It is an authoring aid, not a deliverable.
