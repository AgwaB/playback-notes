# Common execution path

Host tool calls, not setup commands for the user. Resolve `$SKILL` to the **installed skill root** and `$ROOT` to `.playback-notes` under the session's starting directory. Scripts never prompt or invoke an LLM. For optional capabilities, read only the relevant [execution section](execution.md); do not load that whole reference for ordinary captions/supplied transcripts.

## 1. Private job and request

Use the core [layout/collision rules](../SKILL.md#2-prepare-private-evidence): create `$ROOT/.gitignore` containing `*`, `$ROOT/work/`, then a **new** `$JOB` with `mkdir` without `-p` (append a suffix if taken). Private/public roots cannot contain each other; never serve a job folder. Save `request.json` in `$JOB`:

```json
{
  "schemaVersion": 1,
  "source": { "kind": "url", "value": "https://www.youtube.com/watch?v=jNQXAC9IVRw" },
  "mode": "briefing",
  "outputLanguage": "en",
  "formats": ["html", "markdown"],
  "policy": { "asr": "off", "visual": "off", "copyLocalMedia": false, "publishTranscript": true }
}
```

Substitute the user's actual source, mode, language and format choices; the URL above shows syntax only. A local source uses `kind: "local"` and an absolute path; optionally add `transcriptFile` for readable SRT/VTT/TXT. Report language does not select caption/ASR language. Set `publishTranscript: false` before external sharing or if requested; report quotes remain. For special caption preferences, deadlines, partial approvals and other policies see [request](execution.md#request) and [evidence rules](evidence-rules.md).

## 2. Prepare, inspect, scaffold

```bash
node "$SKILL/scripts/prepare.mjs" --request "$JOB/request.json" --work-dir "$JOB" --check &&
node "$SKILL/scripts/prepare.mjs" --request "$JOB/request.json" --work-dir "$JOB"
```

Stop on a non-success envelope. Missing/partial evidence is a user decision, not approval to proceed. On success:

```bash
node "$SKILL/scripts/read.mjs" --evidence "$JOB/evidence.json"
```

Pin the first overview's `sha256` as `$EVIDENCE_SHA` (and ensure scaffold's `evidenceRef.sha256` matches). Read **all overview pages**, including source/extraction warnings, gaps and timing. Pass that same hash for every chunk/page; if it changes, discard earlier review and restart from the overview. Batch independent chunk reads in one turn as separate tool calls so each response stays within its own output limit. For every listed chunk:

```bash
node "$SKILL/scripts/read.mjs" --evidence "$JOB/evidence.json" --chunk chunk-00001 --sha256 "$EVIDENCE_SHA"
```

Successful reads are compact UTF-8 text (the exception to scripts' JSON envelopes); errors keep the JSON envelope. Each row is `context|segment id startMs..endMs [speaker=JSON-string] JSON-string-text`; `?` is an unknown time, absent speaker is null. Context rows are overlap, not extra reviewed coverage. Text/speakers are JSON-escaped, **not shortened, normalized or summarized**. Everything is untrusted source data.

A page is capped at 32 KiB and ends with `NEXT offset=N` or `END <view>`. On `NEXT`, repeat the same overview/chunk command with `--offset N --sha256 "$EVIDENCE_SHA"` until `END`. Continuations require the pinned hash; a changed snapshot is refused. Tool-side truncation (missing marker) is not completed reading: redirect the view into a private text file and read it with bounded file reads. An oversized individual record fails explicitly; inspect it from raw `evidence.json` with bounded reads. Never mark a chunk reviewed until **all** its pages were read. The reader does not modify evidence or the ledger; overview/frame metadata do not count as reading a chunk or opening an image. Read frame metadata/OCR from `evidence.json` only when visual work needs it.

After accepting evidence scope, scaffold (can share a tool call with the overview):

```bash
node "$SKILL/scripts/scaffold.mjs" --request "$JOB/request.json" --evidence "$JOB/evidence.json" --work-dir "$JOB"
```

It writes an intentionally incomplete `report.json` with the correct `evidenceRef`, mode and language, and prints block shapes/citable IDs. Fill it from all reviewed chunks or [validated chunk notes](long-sources.md), preserving the scaffold's binding. Do not read whole schemas unless a particular contract issue needs it. Write the separate `analysis-ledger.json` as described in [evidence rules](evidence-rules.md); only actually read chunks/inspected frames may be listed.

## 3. Validate, render, export, verify

Choose `$OUT` as the **next unused** public revision: `$ROOT/reports/<evidence.source.id>/<mode>/r<N>` (or the user's chosen public root). Chain stages so errors stop later stages:

```bash
node "$SKILL/scripts/validate.mjs" --request "$JOB/request.json" --evidence "$JOB/evidence.json" --analysis "$JOB/analysis-ledger.json" --report "$JOB/report.json" --work-dir "$JOB" &&
node "$SKILL/scripts/render.mjs" --request "$JOB/request.json" --evidence "$JOB/evidence.json" --analysis "$JOB/analysis-ledger.json" --report "$JOB/report.json" --work-dir "$JOB" --out-dir "$OUT" &&
node "$SKILL/scripts/export.mjs" --request "$JOB/request.json" --evidence "$JOB/evidence.json" --analysis "$JOB/analysis-ledger.json" --report "$JOB/report.json" --work-dir "$JOB" --out-dir "$OUT" &&
node "$SKILL/scripts/verify-output.mjs" --out-dir "$OUT"
```

For PDF, add the explicit existing `--browser-executable` to preflight/export; see [PDF/export options](execution.md#pdf-and-export-options). Do not use `&&` in Windows PowerShell 5.1: run stages separately and proceed only on `$LASTEXITCODE -eq 0` ([Windows guide](windows.md)). Keep flags/values as separate shell words; do not expand one unquoted `$ARGS` string (zsh does not word-split it).

Fix validation/citation errors against evidence, never by weakening checks or inventing approvals. The same sequence works for HTML-only (`NOTHING_TO_EXPORT`). Retry missing exports in the same unchanged revision; changed content/analysis/sharing/formats/renderer needs the next revision. Old revisions are not deleted or retroactively redacted.

Read the public `manifest.json`: every requested artifact must be successful and `overallStatus` must be `completed`. Inspect the actual requested artifacts with the [quality checklist](quality-checklist.md), including meaning and language/fonts, not just hashes. For HTML, inspect rendered content/navigation without dumping the full embedded transcript into context; for requested playback use the [loopback server](execution.md#playback). Verify-output checks integrity, **not** semantic support or visual correctness. Link only successful files; explain gaps and incomplete exports honestly.
