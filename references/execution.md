# Host execution reference

These are **host tool calls**, not commands the user must learn. Substitute absolute paths; resolve the scripts from the installed skill root. Scripts never prompt or invoke an LLM.

## Installation and capabilities

Install the package's pinned dependencies with `npm ci` in the skill directory after installation has been authorized. Node.js **24+** is required. `npm ci` does not install Chromium, an ASR model or a speech engine. No API key is needed.

Optional tools are not installed automatically:

- `ffmpeg` / `ffprobe`: local/direct media inspection and approved local transcription preparation.
- Chromium/Chrome: PDF only. Pass its existing executable explicitly; no browser download occurs.
- Compatible `whisper.cpp` executable and an existing model: only for approved local ASR, subject to the support matrix.

## Private/public layout

```text
<private-parent>/work/<job-id>/
  request.json
  capabilities.json
  raw/extraction.json
  chunks/chunk-*.json
  evidence.json
  analysis-ledger.json
  report.json
  manifest.json
<public-parent>/<source-id>/<mode>/<revision>/
  index.html
  report.md
  report.pdf
  manifest.json
  assets/                 # referenced images only
  media/                  # only after copyLocalMedia approval
```

Neither root may contain the other. The public root cannot contain request/evidence/analysis/source input files. Do not serve the private job. Work directories and files are owner-only where supported; public exports still contain transcript text and must be shared deliberately.

## Request

Only the source, mode and language are mandatory beyond `schemaVersion`:

```json
{
  "schemaVersion": 1,
  "source": { "kind": "url", "value": "https://www.youtube.com/watch?v=jNQXAC9IVRw" },
  "mode": "briefing",
  "outputLanguage": "ko",
  "focus": null,
  "transcriptFile": null,
  "formats": ["html", "markdown", "pdf"],
  "policy": {
    "asr": "off",
    "partialEvidenceApproval": null,
    "partialAnalysisApproval": null,
    "copyLocalMedia": false,
    "maxDownloadBytes": 2147483648,
    "extractTimeoutMs": 1800000,
    "asrTimeoutMs": 3600000,
    "transcriptLanguages": [],
    "visual": "off",
    "youtubeTokens": "auto"
  }
}
```

`transcriptLanguages` is a descending caption-language priority (`["ko", "en"]`): within a language a manually created track is preferred over an auto-generated one, then the next language; with an empty list the first manually created track in the player's own order is used (auto-generated tracks only when no manual track exists). `visual` is `off` or `local-ocr` (explicit local OCR of sampled frames; see below). `youtubeTokens` is `auto` (default: mint where the confined runtime exists, otherwise request without a token and warn `BOTGUARD_UNAVAILABLE`), `botguard` (insist; refused without the runtime) or `off` (never). With a token, the YouTube caption request carries a content-bound proof-of-origin token minted in a confined child process (`lib/botguard-worker.mjs`: bgutils-js + jsdom run Google's attestation program under macOS `sandbox-exec` + Node's permission model, with no network of its own; its two attestation requests are relayed by the parent over the DNS-pinned transport to `https://www.youtube.com/api/jnn/v1/{Create,GenerateIT}` only, ≤16 MiB, transport deadline ≤60 s, child killed at ≤90 s; macOS only). Evidence then carries the `BOTGUARD_TOKEN` warning. Captions from auto-generated tracks sometimes end after the advertised length; the duration is then left unknown (`DURATION_UNVERIFIED`) rather than clipping.

For a local input use `source.kind: "local"` and an absolute file path. A user-supplied `transcriptFile` must be a readable SRT, VTT or TXT file. Untimed TXT remains untimed. `focus` guides the host's authoring, not extraction or an internal model. The example YouTube URL is syntax only, not a promise of accessible captions.

## Tool sequence

```bash
node "$SKILL/scripts/prepare.mjs" --request "$JOB/request.json" --work-dir "$JOB" --check --browser-executable "$BROWSER"
node "$SKILL/scripts/prepare.mjs" --request "$JOB/request.json" --work-dir "$JOB"
```

If local ASR was approved and supported for the source, set `policy.asr` to `local` and supply `--local-asr-executable /absolute/whisper-cli --local-asr-model /absolute/model.bin`. Do not pass these as an implicit approval when `asr` remains off. Model choice matters more than runtime: on the Korean fixtures `ggml-large-v3-turbo.bin` halves small's CER on clean speech (1.9–2.9 % vs 3.5–4.8 %), cuts noisy-speech CER by 2–4× per fixture (natural-noise 7 % vs 29 %) and retains 11 of 19 selected sensitive assertions with none omitted (small: 8/19, one omitted) at 1.1–6.5× small's run time; evidence carries `ASR_MODEL_COMPACT` when a sub-GiB model was used. Greedy decoding is used; `-bs 5` beam search gave no gain at twice the time. For a YouTube video **without captions**, also pass `--yt-dlp-executable /absolute/yt-dlp` (a current release; yt-dlp needs a JavaScript runtime and is given this Node binary via `--js-runtimes`): audio-only media is streamed by yt-dlp (`--ignore-config --no-plugin-dirs --no-playlist --no-cache-dir --no-remote-components -f "bestaudio[protocol=https]" -o -`) to stdout and saved by the skill itself with the byte budget enforced as bytes arrive (yt-dlp is killed past `maxDownloadBytes`). Only plain-HTTPS audio formats are accepted because yt-dlp stages fragmented DASH/HLS formats as fragment files on disk regardless of `-o -`; a video without such a format is refused (`download-failed`), and a result that does not probe as audio-only is refused; then transcribed locally; evidence carries `PLATFORM_MEDIA_DOWNLOADED`. Captions, when present, are always preferred over ASR.

For explicitly approved host-browser YouTube capture, pass `--youtube-capture /absolute/private/capture.json`; see the [capture contract and acquisition rules](youtube-browser-capture.md). It cannot be combined with `transcriptFile`. DOM imports create partial evidence and require the existing snapshot-bound approval. This import option does not launch a browser.

If the user approved local OCR of on-screen text (local media only), set `policy.visual` to `local-ocr` and pass `--tesseract-executable /absolute/tesseract` plus `--ocr-languages kor+eng` (tesseract language codes, `+`-joined). Frames are sampled at scene changes (`--ocr-scene-threshold`, default 0.1; use 0.05 for flat text cards, which score only ~0.05–0.12) or at a fixed interval (`--ocr-sample-seconds N`, the robust choice for long or live-action video), capped by `--ocr-max-frames` (default 60, max 600); the first frame is always included and every sampled frame keeps its real source timestamp (frames are selected, never resampled). `--ocr-psm` sets tesseract's page segmentation mode (default 6, one text block, which reads centred caption cards far better than the automatic layout mode 3).

In the measured cases tesseract read synthetic text cards and returned garbage on one real news clip (burned-in lower-thirds); other footage is uncharacterised. On macOS the Apple Vision engine read that clip's captions: compile the shipped helper once with `swiftc -O -o "$PRIVATE/vision-ocr" "$SKILL/scripts/vision-ocr.swift"` (Xcode Command Line Tools; no download) and pass `--ocr-engine vision --ocr-executable "$PRIVATE/vision-ocr" --ocr-languages ko-KR,en-US`. `--ocr-region bottom|top|full` keeps only the subtitle band (Vision boxes are filtered; tesseract gets a cropped frame). For burned-in subtitles sample at `--ocr-sample-seconds 2` (frame cap 600). De-duplication is exact, never fuzzy: a line is a repeat only if its key (NFC and whitespace collapsing — nothing else is normalised) is identical to a line seen within the last 10 s of sampled source time — so a caption that stays on screen, a logo or a fixed label is reported once per sampled appearance and again after a 10 s absence, while any other change (a digit, a sign, a decimal point, a quote, letter case, a word or particle) keeps the frame; single-character fragments are ignored. OCR jitter therefore costs extra retained frames (the news clip keeps 14 of 39 samples), never evidence. Timestamps are ffmpeg's media-relative presentation times (a stream whose first frame starts late keeps that offset; a container start offset is normalised by ffmpeg). Genuinely visible background text (tickers, posters) is still reported. A frame is discarded only when every line on it is a repeat or a single character; any new line of two or more characters keeps the frame. Measured on one news clip and synthetic text cards; other footage is uncharacterised. Each kept frame appears in `evidence.frames` with `ocrText`; the host must open the image and record it in `inspectedFrameIds` before citing it. With no transcript and `asr: off`, OCR frames alone yield visual-only evidence (`extraction.method: "none"`, zero chunks). Platform media is never downloaded for OCR.

`--browser-executable` only selects the PDF/preflight capability; acquisition never launches a browser.

When YouTube acquisition starts failing, run the canary before changing anything: it performs one bounded caption acquisition with the request's policy (and, with `--yt-dlp-executable`, a `--simulate` probe) and classifies the outcome — `CANARY_CAPTIONS_OK`, `_BLOCKED` (platform gate: a policy/approval question), `_BROKEN` (token minting or adapter failure: a code/update question), `_NO_CAPTIONS` / `_UNAVAILABLE` (pick another canary video), `CANARY_YTDLP_OK` / `_BROKEN` (usually an outdated yt-dlp). Nothing is written into the job.

```bash
node "$SKILL/scripts/canary.mjs" --request "$JOB/request.json" --work-dir "$JOB" --yt-dlp-executable /absolute/yt-dlp
```

For long sources, between prepare and authoring, validate per-chunk notes and build the digest (see [long sources](long-sources.md)):

```bash
node "$SKILL/scripts/notes.mjs" --evidence "$JOB/evidence.json" --notes-dir "$JOB/notes" --work-dir "$JOB" --analysis "$JOB/analysis-ledger.json" --update-ledger
```

After the host reads chunks (or validated notes), writes the ledger and authors `report.json`:

```bash
node "$SKILL/scripts/validate.mjs" --request "$JOB/request.json" --evidence "$JOB/evidence.json" --analysis "$JOB/analysis-ledger.json" --report "$JOB/report.json" --work-dir "$JOB"
node "$SKILL/scripts/render.mjs" --request "$JOB/request.json" --evidence "$JOB/evidence.json" --analysis "$JOB/analysis-ledger.json" --report "$JOB/report.json" --work-dir "$JOB" --out-dir "$OUT"
node "$SKILL/scripts/export.mjs" --request "$JOB/request.json" --evidence "$JOB/evidence.json" --analysis "$JOB/analysis-ledger.json" --report "$JOB/report.json" --work-dir "$JOB" --out-dir "$OUT" --browser-executable "$BROWSER"
```

`export.mjs` defaults to the requested non-HTML formats. `--formats markdown` or `--formats pdf` retries a subset, but overall completion still reflects **all** requested formats. `--font-dir /absolute/fonts` loads 1–16 existing TTF/OTF/WOFF fonts into the isolated PDF renderer; it does not upload or copy them into the public HTML. Verify their licensing before distribution.

For playback:

```bash
node "$SKILL/scripts/serve.mjs" --root "$OUT" --job-manifest "$JOB/manifest.json"
```

The result includes a random-token `http://127.0.0.1:<port>/.../index.html` URL. Keep that process alive while viewing, then stop it. The private manifest is optional for public sources or explicitly copied media. `--port` is optional; the default is an available ephemeral port. Only GET/HEAD, the selected report assets and one verified media mapping are served. Host/origin checks and Range support are built in; this is not a public hosting server.

## Result envelope and exit codes

Each script writes one JSON line to stdout. There are no raw dependency logs or credential-bearing URLs in normal result envelopes.

```json
{
  "schemaVersion": 1,
  "stage": "export",
  "status": "partial",
  "artifacts": [{ "format": "pdf", "path": null, "status": "blocked" }],
  "issues": [{ "code": "PDF_RUNTIME_MISSING", "severity": "error", "message": "Provide an installed Chromium executable.", "path": null, "retryable": false }],
  "nextAction": "ask-user"
}
```

| Exit | Meaning |
|---|---|
| 0 | This stage succeeded; inspect the public manifest for overall completion |
| 1 | Execution/validation error |
| 2 | Some requested outputs failed or remain blocked |
| 3 | User input/capability/approval required (`ASR_REQUIRED`, `CAPABILITY_MISSING`, `SOURCE_UNSUPPORTED`, `SOURCE_ACCESS_DENIED`, `SOURCE_UNAVAILABLE`, `TRANSCRIPT_UNAVAILABLE`, `NO_USABLE_EVIDENCE`) |
| 4 | Invalid request or command arguments |

Acquisition failures name their cause after `Cause:` using a fixed vocabulary (modelled on youtube-transcript-api's exception set): `bot-check`, `age-restricted`, `login-required`, `video-unavailable`, `video-unplayable`, `player-unparsable`, `no-transcript`, `transcript-refused`, `transcript-empty`, plus `botguard-challenge`/`botguard-integrity`/`botguard-mint`/`botguard-failed` and `download-failed`. The cause tells the host which alternative to offer; it is never free text from the source. The current HTTP path reports a captionless video as `ASR_REQUIRED` rather than `no-transcript`; `no-transcript`/`transcript-empty` remain in the vocabulary for the canary classifier and capture import.

Artifacts marked `created`/`reused` carry an actual relative path, SHA-256 and byte count. A failed/blocked format has no usable link. Do not turn a PDF error into a claim that all exports succeeded.

## Cache and revision rules

The public manifest records three hashes: `reportSha256` and `evidenceSha256` are SHA-256 of the actual `report.json` / `evidence.json` file bytes; `analysisSha256` is SHA-256 of the ledger re-serialized as `JSON.stringify(analysis, null, 2) + "\n"` (the same canonical form the scripts write), so hand-formatting the ledger file does not change it. Compute it with `node -e 'const {createHash}=require("node:crypto");console.log(createHash("sha256").update(JSON.stringify(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")),null,2)+"\n").digest("hex"))' "$JOB/analysis-ledger.json"`.

Evidence cache identity includes source identity, supplied-transcript bytes, extractor/parser identity, local-ASR executable/model fingerprints and acquisition policy. Mode/language are report concerns and do not require another extraction. A URL cache is a stored snapshot, not a claim that the remote source is unchanged.

Do not edit cached evidence in place. Changed inputs or `--refresh` require a new work directory. Changed report/evidence, analysis ledger, media-copy policy or requested formats requires a new public revision. Earlier revisions are not deleted or retroactively redacted; a previously approved media copy remains in its old folder. Render/export always revalidate input; there is no render/PDF cache that bypasses evidence or approval checks. Missing exports can be retried against the same valid revision without losing successful formats.
