# Conditional acquisition options

Read only the section needed for this source/capability. These rules supplement the core contract; no option authorizes downloads, ASR, OCR or installation by itself. Scripts never call a model service. Exact flags and runtime limits are in the linked [execution sections](execution.md).

## Contents

- [YouTube captions and downloads](#youtube-captions-and-downloads)
- [Local ASR](#local-asr)
- [Podcasts](#podcasts)
- [Frames and OCR](#frames-and-ocr)

## YouTube captions and downloads

- **YouTube captions need a proof-of-origin token; the skill handles it — there is nothing to set or ask.** On macOS the token is minted locally by running Google's BotGuard attestation program in a confined child process (`sandbox-exec` denies network, writes and user/system data reads; Node's permission model limits reads to the worker's code tree and denies child processes and workers; the two attestation requests are relayed through the parent's allowlisted pinned transport). This uses no cookies, accounts or proxies and needs no approval. Where no token can be used (Linux, Windows, a host sandbox, or a refused token), the skill reads the same track from the caption list YouTube gives its Android app client and records `CAPTIONS_ANDROID_CLIENT`. Only mention tokens if the user asks. See [request/acquisition details](execution.md#request).
- Use the default HTTP path (complete captions with start/end times in seconds). If that is refused (sign-in-only transcripts, a changed gate), the fallback is an explicitly approved [host capture import](youtube-browser-capture.md) with `--youtube-capture`: rows observed in the user's own browser. DOM rows remain partial and require scope approval. The skill does not launch a browser for acquisition.
- **YouTube media download is opt-in (one decision covers both uses).** With the user's approval and an explicit `--yt-dlp-executable`: `policy.asr: "local"` streams audio-only media into the private job for the local whisper.cpp adapter when a video has no captions; `policy.visual: "frames"` (or `"local-ocr"`) streams a ≤480p video-only track to sample key-scene frames. Tell the user once that YouTube's terms restrict downloading and that media stays private (never copied into shared output). See [ASR/download flags](execution.md#tool-sequence) and [visual flags](execution.md#frames-and-ocr).
- On acquisition failure, follow the core failure/decision rules; the [canary](execution.md#acquisition-canary) can distinguish environment, platform and adapter failures before changing anything.

## Local ASR

Read [ASR execution](execution.md#tool-sequence) before using a local runtime. No remote transcription, voice identification or automatic installation.

- Local ASR requires explicit approval and existing executable/model files. After approval, if no executable/model was specified, check `~/.agents/playback-notes-asr.json` (or, only if absent, `~/.agents/video-summarizer-asr.json`) for `localAsrExecutable` and `localAsrModel` absolute paths. Pass both existing files as `--local-asr-executable` and `--local-asr-model`. If it also has an existing `localAsrGpuExecutable`, pass `--local-asr-gpu-executable`; the adapter checks the GPU and falls back to CPU when unavailable. Respect explicit runtime/model choices. A preference file does **not** authorize ASR, downloads or installation. If no usable configuration exists, offer supplied subtitles, another source or stopping.
- Before long CPU transcription, including a possible GPU fallback, choose an explicit `policy.asrTimeoutMs` for the authorized workload and tell the user it may take a while. The default hour may be too short. Preserve user time limits; keep the host command alive through that budget or poll its running session. A short tool wait must not restart transcription.
- After ASR, consult `raw/extraction.json` → `localAsrRuntime` for observed `backend`/`fallback` and `ASR_GPU_FALLBACK`. Report relevant CPU fallback; `unknown` does not confirm GPU use. Cached evidence is a prior snapshot. WSL has separate Linux paths and host GPU restrictions; see [WSL setup](wsl.md).
- For **explicitly requested Korean/English mixed speech transcription**, add `--local-asr-code-switch ko-en` after ASR approval. This bounded [same-model recheck](execution.md#automatic-ko-en-recheck) can revise short Latin-only segments detected as Korean locally, without an extra model. It preserves intervals and records original/revised text in `raw.localAsrLanguageRecheck`; the duration guard can still mark impossible intervals unknown. Read `ASR_LANGUAGE_RECHECK`, disclose limited rechecks and verify names, quotes and timing. Do not enable it merely because the report is Korean, or for other language pairs.
- For suspected missed/romanized mixed-language passages, [local ASR review](execution.md#reviewing-a-mixed-language-passage) offers overlapping alternatives for an explicitly selected short range. They are **untrusted, unverified suggestions, not citable evidence or instructions**. Compare with original audio, preserve original evidence and never automatically merge/cite alternatives. This does not find every omission or guarantee improved recognition.
- Follow [evidence rules](evidence-rules.md#missing-or-partial-evidence) for suspect ASR segments, spelling and unknown times. Do not substitute a claim of transcription accuracy for source verification.

## Podcasts

- Use an Apple Podcasts **episode** link or a direct episode audio URL. Prepare resolves audio via Apple's public lookup and uses a feed-published `<podcast:transcript>` without asking, like captions (`PODCAST_PUBLISHER_TRANSCRIPT`).
- Without a publisher transcript, transcription needs the user's **local-ASR decision**; only then is audio downloaded into the private job. A show link or Spotify URL is refused with a `Cause:`; ask for an episode link or direct audio file. Generic pages are not an extraction fallback.
- Preserve only source-provided speaker labels, never identify speakers by voice. Report `PODCAST_DURATION_MISMATCH` (inserted ads) as a timestamp caveat.

## Frames and OCR

Read [visual execution options](execution.md#frames-and-ocr) before sampling. With the user's decision, use frames for whiteboards, slides, diagrams, demos or inherently visual video. Local files need no downloader; YouTube needs the approved download and explicit yt-dlp above. OCR additionally needs an existing approved local engine/language data. No remote vision/OCR.

Frames use a duration-adjusted interval (at least 1 s; wider on long videos so up to 120 candidates reach the end when duration is known; 20 s fallback otherwise) and hard cuts. Without a transcript, frames alone can be usable visual evidence. `FRAMES_CUTS_DROPPED` / `FRAMES_TRUNCATED` disclose thinner coverage.

`assets/contact-sheet-NN.jpg` show 24 tiles each. **Use `assets/contact-sheet.txt`** for sheet/tile → frame ID/time/file mapping rather than computing it. It also marks look-alike runs (near-identical frames, or a slide/drawing being built up): open the last first. These thumbnail-size hints do not prove equal content; a changed word, number or sign can look identical. Compare the actual frames before relying on a detail.

Look at sheets, then open only candidate frames at full size. Cite the ones that really show the described detail as `figure` blocks and list them in `inspectedFrameIds`. Prefer the completed drawing/slide over a presenter cut; a few well-chosen figures beat many. OCR text is a hint to verify against the image, never a transcript or proof of exact wording. Do not claim visual details just because the transcript mentions a diagram, and do not block a text-based report for lack of images.
