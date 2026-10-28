# Host execution reference

These are **host tool calls**, not commands the user must learn. Substitute absolute paths; resolve the scripts from the installed skill root. Scripts never prompt or invoke an LLM.

## Installation and capabilities

After installation has been authorized, run `npm ci` in the source checkout before `scripts/install.mjs`. The installer copies those dependencies into the installed skill; do not run `npm ci` in its read-only directory. Supported Node.js versions are **24.15 or later in the 24.x line, or 26+** (`^24.15.0 || >=26.0.0`); Node 25 is excluded. `npm ci` does not install Chromium, an ASR model or a speech engine. No API key is needed.

Updates retain the displaced read-only installation as `.previous-*` and report its recovery path (`PREVIOUS_INSTALL_RETAINED`); rollback can retain a failed new copy as `.failed-*`. These copies consume additional disk space. After verifying the new install and stopping dependent processes, inspect ownership/contents before manually removing an unneeded copy. The installer does not recursively delete these backups: pathname identity checks cannot provide a same-UID adversarial filesystem boundary.

Optional tools are not installed automatically:

- `ffmpeg` / `ffprobe`: local/direct media inspection and approved local transcription preparation. On macOS/Linux/WSL they must be in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` or `/bin`; shell-only PATH additions are not used. On Windows, use absolute directories in PATH. `prepare --check` probes with the same tool environment and working-directory layout as extraction.

- Chromium/Chrome: PDF only. Pass its existing executable explicitly; a package-manager symlink is accepted. No browser download occurs.
- Compatible `whisper.cpp` executable and an existing model: only for approved local ASR, subject to the support matrix.

Windows uses native `.exe` tools and directory junctions for installation. See the
[Windows setup guide](windows.md) for PowerShell commands, PATH requirements,
named-pipe ASR output and read-only attribute limits.

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
  report.pdf              # only when requested and successfully exported
  manifest.json
  assets/                 # referenced images only
  media/                  # only after copyLocalMedia approval
```

`--out-dir` is the revision directory itself (render/export write directly into it); the `<source-id>/<mode>/<revision>` nesting above is the layout to create, e.g. `OUT="$PUBLIC/$SOURCE_ID/briefing/r1"` with `SOURCE_ID` from `evidence.source.id`. A changed report, analysis, sharing policy or renderer needs the next revision directory (`r2`, …); an existing revision is never rewritten with different content.

Neither root may contain the other. The public root cannot contain request/evidence/analysis/source input files. Do not serve the private job. Work directories and files are owner-only where supported; public HTML contains the full transcript unless `publishTranscript` is false, and always contains the report's own quotes; share deliberately.

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
  "formats": ["html", "markdown"],
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
    "publishTranscript": true
  }
}
```

`transcriptLanguages` is a descending caption-language priority (`["ko", "en"]`): within a language a manually created track is preferred over an auto-generated one, then the next language; with an empty list the video's original language wins — the audio track the player marks as original, or, when none is marked, the default audio track (e.g. `en-US.4` → English; on a dubbed video with no original marker that default may be the dub) — because the first listed manual track is often a translation; then manual before auto-generated, then the player's order. `visual` is `off`, `frames` (key-scene candidates, no OCR) or `local-ocr` (sampled frames with OCR); both are explicit user decisions, see below. There is no token setting: a proof-of-origin token is minted wherever the confined runtime exists. A web track YouTube marks as token-gated (`exp=xpe`) is not requested without a token; when no token can be used, or it is refused, one player request as YouTube's Android app client (`ANDROID` 20.10.38, as youtube-transcript-api and summarize-core send it) lists caption URLs that are not gated, and the track with the same language and kind is fetched (`CAPTIONS_ANDROID_CLIENT`). Both requests pass the same URL policy, DNS pinning and byte budget; no further clients or retries. With a token, the YouTube caption request carries a content-bound proof-of-origin token minted in a confined child process (`lib/botguard-worker.mjs`: bgutils-js + jsdom run Google's attestation program under macOS `sandbox-exec` + Node's permission model, with no network of its own; its two attestation requests are relayed by the parent over the DNS-pinned transport to `https://www.youtube.com/api/jnn/v1/{Create,GenerateIT}` only, on their own ≤16 MiB allowance that is in addition to `maxDownloadBytes` (which covers the watch page, captions and any approved audio/video download together), transport deadline ≤60 s, child killed at ≤90 s; macOS only). Evidence then carries the `BOTGUARD_TOKEN` warning. Captions from auto-generated tracks sometimes end after the advertised length; the duration is then left unknown (`DURATION_UNVERIFIED`) rather than clipping.

The default formats are HTML and Markdown. Include `"pdf"` only when the user requests PDF; then select an existing Chrome/Chromium executable. Missing explicitly requested PDF remains an incomplete job, but an ordinary summary needs no PDF runtime. A later change to requested formats requires a new output revision.

For a local input use `source.kind: "local"` and an absolute file path. A user-supplied `transcriptFile` must be a readable SRT, VTT or TXT file. Untimed TXT remains untimed. `focus` guides the host's authoring, not extraction or an internal model. The example YouTube URL is syntax only, not a promise of accessible captions.

## Tool sequence

```bash
node "$SKILL/scripts/prepare.mjs" --request "$JOB/request.json" --work-dir "$JOB" --check
node "$SKILL/scripts/prepare.mjs" --request "$JOB/request.json" --work-dir "$JOB"
```

If local ASR was approved and supported for the source, set `policy.asr` to `local` and supply `--local-asr-executable /absolute/whisper-cli --local-asr-model /absolute/model.bin`. Do not pass these as an implicit approval when `asr` remains off. Model choice matters more than runtime: on the Korean fixtures `ggml-large-v3-turbo.bin` halves small's CER on clean speech (1.9–2.9 % vs 3.5–4.8 %), cuts noisy-speech CER by 2–4× per fixture (natural-noise 7 % vs 29 %) and retains 11 of 19 selected sensitive assertions with none omitted (small: 8/19, one omitted) at 1.1–6.5× small's run time; evidence carries `ASR_MODEL_COMPACT` for a sub-GiB model that is not recognized by its GGML architecture header as large-v3-turbo; file size alone does not establish model quality. The adapter keeps the runtime's decoding defaults; the tested whisper.cpp 1.9.5 executable reports 5 beams by default. Decoder comparisons must use the actual runtime flags, not assume that the default is greedy. For a YouTube video **without captions**, also pass `--yt-dlp-executable /absolute/yt-dlp` (a current release; yt-dlp needs a JavaScript runtime and is given this Node binary via `--js-runtimes`): audio-only media is streamed by yt-dlp (`--ignore-config --no-plugin-dirs --no-playlist --no-cache-dir --no-remote-components -f "bestaudio[protocol=https]" -o -`) to stdout and saved by the skill itself with the byte budget enforced as bytes arrive (yt-dlp is killed past `maxDownloadBytes`). Only plain-HTTPS audio formats are accepted because yt-dlp stages fragmented DASH/HLS formats as fragment files on disk regardless of `-o -`; a video without such a format is refused (`download-failed`), and a result that does not probe as audio-only is refused; then transcribed locally; evidence carries `PLATFORM_MEDIA_DOWNLOADED`. yt-dlp makes its own requests to YouTube (player and media servers); those do not go through the skill's DNS-pinned transport — only what it streams to stdout is metered and saved. Captions, when present, are always preferred over ASR.

When local ASR is approved, an optional `--local-asr-gpu-executable /absolute/whisper-cli` supplies an already-installed CUDA, Vulkan or Metal candidate alongside the required `--local-asr-executable` CPU-capable fallback. When the explicit CPU executable and model match `~/.agents/video-summarizer-asr.json`, `prepare` also uses that preference file’s `localAsrGpuExecutable` automatically; an explicit GPU option takes precedence. The adapter probes for a working backend and uses the CPU runtime if the GPU is unavailable or fails to initialize; other errors remain errors. If only one runtime is specified, its own default GPU selection applies. An ASR runtime must be built for the desired accelerator; hardware presence alone is not sufficient. No driver, runtime or model is downloaded or installed by `prepare`. The private `raw/extraction.json` records the observed backend and fallback reason; cached evidence is reused as a snapshot rather than rerunning acceleration detection.

Runtime-version metadata is best effort and is collected only for a selected inference executable, before its inference. The two metadata flags share at most two seconds (at most a quarter of a short ASR budget) and a 64 KiB per-process stdout/stderr cap; slow, unavailable or oversized metadata leaves the version `unknown`. Unused CPU/GPU candidates are not launched just to obtain their version. This does not enlarge the overall ASR deadline.

An `ASR_GPU_FALLBACK` evidence warning reports CPU fallback and, on WSL when `/dev/dxg` is inaccessible, points to GPU support or host device-access policy as possible causes. It does not establish which cause applies. WSL has its own Linux tool paths and host settings; see [WSL setup](wsl.md). The normal `asrTimeoutMs` is one hour, which may be too short for long CPU jobs. Pick a larger explicit budget when appropriate, rather than treating a test harness timeout as proof that transcription cannot finish.

ASR segment times are estimates: check cited times against the source, especially after long pauses or language changes. If a fully parsed local-ASR cue starts or ends beyond the known media duration, its text and original SRT are preserved while both evidence timestamps become unknown (`null`). Inspect private `raw.localAsrTiming` and the `TIMING_UNAVAILABLE` warning; no time is clipped or invented, and this does not establish that the text was spoken. Supplied subtitles remain strict. For other recognized ASR validation failures, the error can name a private `raw/asr-failures/<attempt>/` directory containing `transcript.srt` and a request-bound `receipt.json`. This is diagnostic data, not validated evidence or a resumable cache; inspect the named attempt rather than an older failure.

Built-in whisper.cpp VAD is not enabled by this adapter. In a Windows 11 test, its default settings omitted detected English; splitting at a clear silence recovered it in that sample, but both energy-based silence detection and VAD missed recoverable quiet speech in other synthetic samples. Do not discard audio solely because it was classified as silence.

## Automatic ko-en recheck

For explicitly requested Korean/English mixed speech, add `--local-asr-code-switch ko-en` to an approved local-ASR `prepare` call. The same configured Whisper model and runtime re-detect the language of short Latin-only primary segments (1.5–10 seconds). A Korean detection probability of at least 0.90 permits a local retry. A retry is accepted only with at least four Hangul syllables, no Latin letters, preserved numeric notation and valid bounded timestamps. Ambiguous numeric changes are rejected; this does not verify every unit or semantic claim. This is a conservative heuristic, not proof of accuracy; English spoken with a Korean accent or overlapping speakers can still confuse it. Already mixed/Hangul segments are left alone. This option does not find speech wholly missing from the primary transcript.

Detection is batched to reuse the loaded model, capped at 120 eligible segments spread across the source. At most 24 retries and two additional minutes are allowed, within the existing overall ASR timeout. GPU/CPU selection follows the successful primary runtime. Only exact digital silence is skipped; quiet speech is not discarded. If optional recheck tooling fails, retained primary text and a limited-recheck warning remain; cancellation of the main job still cancels. No model, driver or service is installed.

`raw/extraction.json` retains the original SRT in `localAsr` and the mode, scan counts, decisions and changes in `localAsrLanguageRecheck`. Evidence uses the accepted text with the **original segment intervals**, which remain estimates; the separate source-duration guard can still mark an impossible interval unknown. `ASR_LANGUAGE_RECHECK` reports changes and incomplete rechecks. The mode is part of the evidence cache identity. Plain prepare calls and other language pairs keep the existing behavior; the option itself does not authorize ASR or downloads.

On two actual mixed interviews this recovered selected Korean passages and a romanized word, while names and some words remained wrong. On 78 recorded mixed-language evaluation utterances it revised one mistranslated Korean segment and left the other outputs unchanged. These narrow tests do not establish a general accuracy rate. The separate review tool below remains useful for uncertain passages.

## Reviewing a mixed-language passage

When local ASR is already approved and a local media file is available, review a suspected short passage in a **new private work directory**. The command accepts source-relative millisecond offsets, 1–120 seconds per run, and uses both 6- and 8-second overlapping windows. Use the original file's timeline; if reviewing a previously cut clip, offsets are relative to that clip. It needs ffmpeg, ffprobe and the same existing CPU executable and model as prepare; a matching GPU preference is used automatically, with CPU fallback. Optionally pass `--local-asr-gpu-executable` explicitly. No media or runtime is downloaded. Each run is limited to 20 minutes; CPU review can take much longer than GPU review.

```bash
node "$SKILL/scripts/asr-review.mjs" --source /absolute/private/media --work-dir /absolute/private/review-job --start-ms 85000 --end-ms 103000 --local-asr-executable /absolute/whisper-cli --local-asr-model /absolute/model.bin
```

`review.json` contains the source SHA-256, range, window boundaries, per-window backend/fallback and candidate text/times. Those times are estimates. Overlaps can omit English, duplicate words, mistranslate or invent speech, including on silence. Some invalid outputs are withheld as unavailable; `partial` is not a successful complete review. Listen to the original passage and treat all alternatives as untrusted, unverified hints. They are not integrated into the immutable evidence or report and cannot be cited as such. A candidate that differs is not automatically more accurate. This targeted tool does not find every omission; it adds work and is not a replacement for transcription of the full source.

The review deadline includes final publication, artifact verification and writer-lock release. A timeout withdraws this invocation's review where the cooperative lock and file identity still permit it. If cleanup cannot be confirmed, the CLI explicitly warns that an unverified artifact may remain; do not use it as a completed review or delete another writer's lock. Filesystem calls are cooperatively bounded, not forcibly interruptible.

For explicitly approved host-browser YouTube capture, pass `--youtube-capture /absolute/private/capture.json`; see the [capture contract and acquisition rules](youtube-browser-capture.md). It cannot be combined with `transcriptFile`. DOM imports create partial evidence and require the existing snapshot-bound approval. This import option does not launch a browser.

`publishTranscript` (default `true`) puts the full transcript in the HTML source panel; with `false` the panel keeps only one timestamp per segment so citations still seek and highlight, and the privacy notice says the transcript is not included. It is part of the revision identity (changing it needs a new output directory). Markdown and PDF never contain the transcript.

`policy.visual` is `off`, `frames` or `local-ocr`. `frames` samples key-scene candidates without any OCR tool: by default every max(1 s, ceil(duration ÷ (cap − 1))) when the media duration is known (20 s otherwise) — so interval samples alone fit the cap and reach the end of a source of known duration, within the 64 MiB frame budget (high-detail video at large caps can exceed it and fails explicitly with `RESOURCE_LIMIT`) — plus hard cuts (ffmpeg scene score > 0.3); cap `--ocr-max-frames` (default 120 in this mode, 60 for OCR, max 600); `--ocr-sample-seconds`/`--ocr-scene-threshold` override. If cuts exhaust the cap before the end, the cuts are dropped and the interval-only pass is kept (`FRAMES_CUTS_DROPPED`); explicit settings that stop before the end, or a capped pass of a source whose duration is unknown, produce `FRAMES_TRUNCATED` with the covered time. Without a transcript, sampled frames alone are usable (visual-only) evidence: cite only frames you opened. Every sampled frame is kept (no text to de-duplicate on); `assets/contact-sheet-NN.jpg` (24 tiles per sheet, 4 per row) and `assets/contact-sheet.txt` (sheet, tile → frame → time → file, plus look-alike runs from 64×36 RGB thumbnail differences: near-identical when every frame is within 1 of its neighbour and of the run's first frame, build-up when neighbours are within 3 — thresholds measured on one slide talk; a 40×8-pixel change on a 720p frame moves the difference by only 0.09, so a run never proves equal content; nothing is dropped) are written beside them for review (not evidence) and listed in the prepare envelope; evidence carries `FRAMES_SAMPLED`. For a YouTube source either visual mode needs `--yt-dlp-executable`: a ≤480p video-only HTTPS track (H.264 preferred) is streamed through the same metered pipe as audio (`PLATFORM_VIDEO_DOWNLOADED`; audio for ASR is `PLATFORM_MEDIA_DOWNLOADED`), never a muxed or fragmented format.

If the user approved local OCR of on-screen text, set `policy.visual` to `local-ocr` and pass `--tesseract-executable /absolute/tesseract` plus `--ocr-languages kor+eng` (tesseract language codes, `+`-joined). Frames are sampled at scene changes (`--ocr-scene-threshold`, default 0.1; use 0.05 for flat text cards, which score only ~0.05–0.12) or at a fixed interval (`--ocr-sample-seconds N`, the robust choice for long or live-action video), capped by `--ocr-max-frames` (default 60, max 600); the first frame is always included and every sampled frame keeps its real source timestamp (frames are selected, never resampled). `--ocr-psm` sets tesseract's page segmentation mode (default 6, one text block, which reads centred caption cards far better than the automatic layout mode 3).

Measured (support matrix): tesseract reads synthetic text cards, makes errors on dense slides (5.6 % CER) and burned-in subtitles (~13 %), and returned garbage on a real news clip; the Apple Vision engine read all three at 0.2–0.7 % CER. Korean+English slides: Vision 9.7 % per-line CER from a 360p YouTube stream, 4.6 % at 720p; tesseract `kor+eng` 15–25 %. Small slide text suffers from the ≤480p YouTube cap; a full-resolution local file reads better. Gradual visual changes are uncharacterised. On macOS use Vision: compile the shipped helper once with `swiftc -O -o "$PRIVATE/vision-ocr" "$SKILL/scripts/vision-ocr.swift"` (Xcode Command Line Tools; no download) and pass `--ocr-engine vision --ocr-executable "$PRIVATE/vision-ocr" --ocr-languages ko-KR,en-US`. `--ocr-region bottom|top|full` keeps only the subtitle band (Vision boxes are filtered; tesseract gets a cropped frame). For burned-in subtitles sample at `--ocr-sample-seconds 2` (frame cap 600). De-duplication is exact, never fuzzy: a line is a repeat only if its key (NFC and whitespace collapsing — nothing else is normalised) is identical to a line seen within the last 10 s of sampled source time — so a caption that stays on screen, a logo or a fixed label is reported once per sampled appearance and again after a 10 s absence, while any other change (a digit, a sign, a decimal point, a quote, letter case, a word or particle) keeps the frame; single-character fragments are ignored. OCR jitter therefore costs extra retained frames (the news clip keeps 14 of 39 samples), never evidence. Timestamps are ffmpeg's media-relative presentation times (a stream whose first frame starts late keeps that offset; a container start offset is normalised by ffmpeg). Genuinely visible background text (tickers, posters) is still reported. A frame is discarded only when every line on it is a repeat or a single character; any new line of two or more characters keeps the frame. Each kept frame appears in `evidence.frames` with `ocrText`; the host must open the image and record it in `inspectedFrameIds` before citing it. With no transcript and `asr: off`, OCR frames alone yield visual-only evidence (`extraction.method: "none"`, zero chunks). For YouTube, frames/OCR use a ≤480p video-only stream only when the user approved the download and `--yt-dlp-executable` is passed; other platform media is never downloaded.

`--browser-executable` only selects the PDF/preflight capability; acquisition never launches a browser.

When YouTube acquisition starts failing, run the canary before changing anything: it performs one bounded caption acquisition with the request's policy (and, with `--yt-dlp-executable`, a `--simulate` probe) and classifies the outcome — `CANARY_CAPTIONS_OK`, `_BLOCKED` (platform gate: a policy/approval question), `_BROKEN` (token minting or adapter failure: a code/update question), `_NO_CAPTIONS` / `_UNAVAILABLE` (pick another canary video), `_ENVIRONMENT` (this process has no network or no confined token runtime, e.g. a sandboxed shell — run the canary elsewhere), `CANARY_YTDLP_OK` / `_BROKEN` (usually an outdated yt-dlp). Nothing is written into the job.

```bash
node "$SKILL/scripts/canary.mjs" --request "$JOB/request.json" --work-dir "$JOB" --yt-dlp-executable /absolute/yt-dlp
```

For long sources, between prepare and authoring, validate per-chunk notes and build the digest (see [long sources](long-sources.md)):

```bash
node "$SKILL/scripts/notes.mjs" --evidence "$JOB/evidence.json" --notes-dir "$JOB/notes" --work-dir "$JOB" --analysis "$JOB/analysis-ledger.json" --update-ledger
```

Before authoring, write the skeleton (bound to the exact evidence bytes; prints the block shapes and citable IDs; refuses to overwrite an existing report without `--force`):

```bash
node "$SKILL/scripts/scaffold.mjs" --request "$JOB/request.json" --evidence "$JOB/evidence.json" --work-dir "$JOB"
```

After the host reads chunks (or validated notes), writes the ledger and authors `report.json`:

```bash
node "$SKILL/scripts/validate.mjs" --request "$JOB/request.json" --evidence "$JOB/evidence.json" --analysis "$JOB/analysis-ledger.json" --report "$JOB/report.json" --work-dir "$JOB"
node "$SKILL/scripts/render.mjs" --request "$JOB/request.json" --evidence "$JOB/evidence.json" --analysis "$JOB/analysis-ledger.json" --report "$JOB/report.json" --work-dir "$JOB" --out-dir "$OUT"
node "$SKILL/scripts/export.mjs" --request "$JOB/request.json" --evidence "$JOB/evidence.json" --analysis "$JOB/analysis-ledger.json" --report "$JOB/report.json" --work-dir "$JOB" --out-dir "$OUT"
node "$SKILL/scripts/verify-output.mjs" --out-dir "$OUT"
```

`verify-output.mjs` checks that the manifest's renderer identity (SHA-256 over the skill's `lib`, `templates`, `schemas`, `scripts` and `package.json`) equals the installed skill's and that every listed file still matches its hash; `RENDERER_MISMATCH` means a modified or copied renderer (or another skill version) produced the revision. It is tamper-evident, not tamper-proof.

Pass every flag and value as separate shell words. Do not collect them in one variable and expand it unquoted: zsh does not word-split `$ARGS` (use a shell array, `"${args[@]}"`, or repeat the flags), and the CLI then reports the whole string as one unknown option.

For a request containing `pdf`, add `--browser-executable /absolute/path/to/chromium` to the preflight and export commands. Use an existing browser; default HTML/Markdown output does not need it.

`export.mjs` defaults to the requested non-HTML formats (an HTML-only request returns `ok` with `NOTHING_TO_EXPORT`, so the same render → export → verify sequence works for every request). `--formats markdown` or `--formats pdf` retries a subset, but overall completion still reflects **all** requested formats. `--font-dir /absolute/fonts` loads 1–16 existing TTF/OTF/WOFF fonts into the isolated PDF renderer; it does not upload or copy them into the public HTML. Verify their licensing before distribution.

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

Do not edit cached evidence in place. Changed inputs or `--refresh` require a new work directory. Changed report/evidence, analysis ledger, media-copy policy, `publishTranscript`, requested formats or the skill's renderer (a skill update) requires a new public revision. Earlier revisions are not deleted or retroactively redacted; a previously approved media copy remains in its old folder. Render/export always revalidate input; there is no render/PDF cache that bypasses evidence or approval checks. Missing exports can be retried against the same valid revision without losing successful formats.
