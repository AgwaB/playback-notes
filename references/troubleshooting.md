# Safe recovery

| Result / symptom | Host action |
|---|---|
| `ASR_REQUIRED`, no captions | Ask for SRT/VTT/TXT or, where supported, explicit prepared local ASR. Do not use title/description as a spoken transcript. |
| `CAPABILITY_MISSING` | Explain the missing runtime/model. Obtain approval before installation or choose another source/transcript. No model download occurs automatically. |
| Any YouTube acquisition failure | Run `scripts/canary.mjs` first: `BLOCKED` means a policy/approval decision, `BROKEN` means update bgutils-js/jsdom/yt-dlp or fix the adapter, `NO_CAPTIONS`/`UNAVAILABLE` means the video, not the tooling. |
| `NETWORK_UNAVAILABLE` (`Cause: network-unavailable`) | This process could not resolve or reach the source (DNS or connection failure). The usual cause is a host agent running commands in a sandbox without network (Codex `workspace-write` blocks network by default). Ask the user to allow network for the skill's commands (or run the host with network access) and retry; it is not a refusal by YouTube, so do not switch to capture import or ASR for it. Otherwise check the URL and connectivity. |
| `CAPTIONS_ANDROID_CLIENT` warning | No proof-of-origin token could be used here (not macOS, a host sandbox, or the token was refused), so the track was read from YouTube's Android-app caption list: same language and kind as the web choice when listed. Nothing to fix; the transcript is the same platform track. |
| `SOURCE_ACCESS_DENIED` (`Cause: transcript-refused` / `transcript-refused-no-token`) | Both the web track and the Android-app caption list failed. YouTube may have extended its token gate to the Android client: run the canary, update the skill, or offer a transcript / host-browser capture. No cookies, proxies or further clients are tried. |
| `SOURCE_ACCESS_DENIED` (`Cause: bot-check`) | The watch page itself demands sign-in; tokens do not help. Offer a transcript or another source. |
| `ASR_REQUIRED` on YouTube | No captions. With approval, set `asr: local` and pass `--yt-dlp-executable` (current release) plus the whisper executable/model; note YouTube's download terms and that audio stays in the private job. |
| `SOURCE_ACCESS_DENIED` (`Cause: age-restricted` / `login-required`) | Signed-in viewing is required and not supported; ask for a transcript or another source. |
| `SOURCE_UNAVAILABLE` | The video is removed, private, region-blocked or the ID is wrong; confirm the link with the user. |
| `TRANSCRIPT_UNAVAILABLE` (`Cause: no-transcript`) | The video exposes no transcript (captions disabled or none uploaded). Ask for SRT/VTT/TXT; for local media, approved local ASR or local OCR may apply. |
| `AUTOMATIC_CAPTIONS` warning | The track is auto-generated: no punctuation and mangled technical terms are likely; prefer a manual track via `policy.transcriptLanguages` when one exists, and read quotations with care. |
| `ASR_MODEL_COMPACT` warning | The model file is under 1 GiB and its GGML header was not recognized as large-v3-turbo. A small file can also be a quantized larger model, so size alone does not establish quality. Check numbers, conditions and negations against the source; see the support matrix. |
| `ASR_SUSPECT_SEGMENTS` warning | The listed segments match phrases Whisper invents over music or silence (subtitle credits such as “한글자막 by …”, “thanks for watching”, subscribe requests). Check the source at those times; do not cite them as speech unless confirmed. Nothing was removed. |
| Linux PDF: Chromium aborts with `Failed to move to new namespace … Operation not permitted` | The browser sandbox cannot create its namespaces. In Docker, the default seccomp profile blocks them: run the container with `--security-opt seccomp=unconfined` (or a profile that allows user namespaces). On Ubuntu 23.10+, unprivileged user namespaces are restricted by AppArmor for unconfined programs: use a browser package that ships an AppArmor profile. Never disable the sandbox to make PDF work. |
| Linux: whisper.cpp build fails with `inlining failed … target specific option mismatch` | GCC on arm64 with native CPU detection; configure with `-DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16`. CPU-only turbo runs near real time on 4 threads: raise `asrTimeoutMs` (default 1 h) for long videos or use a smaller model with the `ASR_MODEL_COMPACT` caveats. |
| `VISUAL_OCR_UNVERIFIED` warning | Frame text is machine-read from sampled scenes; open each frame before citing, and expect unsampled scenes. |
| `SOURCE_UNSUPPORTED` | Explain the unsupported source/platform or ASR path. A user transcript may be sufficient. |
| `UNSAFE_URL` | Do not disable network checks. Credentials, private addresses and unsafe redirects are refused. Ask for a public source or authorized local file. |
| `RESOURCE_LIMIT` / `TIMEOUT` | Explain the configured budget. Only increase it with a reasoned user decision; use a new acquisition work directory. Never silently truncate evidence. |
| `UNREVIEWED_EVIDENCE` | Finish reviewing chunks or obtain exact partial-scope approval. Do not forge ledger entries or consent. |
| `EVIDENCE_MISMATCH` | Use the correct immutable snapshot. Changed source/transcript requires a new work directory; changed report/evidence requires a new output revision. |
| `UNCONFIRMED_FRAME` | Inspect the actual image or remove unsupported visual claims. Do not mark inspection just to pass. |
| `PDF_RUNTIME_MISSING` | Select an installed Chrome/Chromium executable or ask permission to install one. Retain successful HTML/MD and report the overall job incomplete. |
| Codex PDF fails before page creation | A tested workspace-write run aborted Chrome at launch (SIGABRT, cleanup EPERM). Diagnose the host's browser-launch permissions; do not assume a font/report defect or disable either sandbox. Keep PDF incomplete until an authorized runtime succeeds. |
| `EXPORT_FAILED` / PDF font issue | Check selected browser, sandbox support and local fonts. Retry PDF against the same report with `--font-dir`; visually inspect it. Do not disable the browser sandbox as a silent fallback. |
| `BUSY` | A writer owns `.write.lock`. Wait or determine the owning process has stopped. Never remove a live lock. After a crash, prefer a fresh job/revision rather than blindly deleting the lock. |
| `OUTPUT_EXISTS` | Choose an empty output revision; do not overwrite unrelated user files. |
| Player fails or `file://` source is unavailable | Keep reading the transcript; use original-source links or the loopback server for authorized local playback. Do not promise offline embedding. |

A nonzero script exit does not mean all earlier outputs are lost. Inspect the result envelope and public manifest, retain verified successful files, and retry only the missing stage where possible. Do not mark a failed PDF as successful because HTML can be manually printed later.
