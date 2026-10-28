# Support and verification boundaries

Last reviewed: **2026-10-28**. This is the public reference for supported configurations and known limitations. Previously exercised environments are not guarantees for every device or host version; documentation changes do not constitute a new platform test.

## Current support summary

| Area | Supported configuration / exercised scope | Remaining boundary |
|---|---|---|
| Node.js | **24.15 or later within 24.x, or 26+** (`^24.15.0 || >=26.0.0`) | Node 24.0–24.14 and 25.x are excluded |
| Output formats | HTML, Markdown and/or PDF as the user chooses; the agent asks when unspecified | PDF needs an explicitly supplied compatible Chrome/Chromium; a failed requested export is incomplete |
| Languages | Reports follow an explicit language preference, otherwise the user's conversation language; English is the fallback when unknown | UI labels remain English. ASR/OCR languages and PDF glyphs depend on local models, language data and fonts; see [skill instructions](../SKILL.md) |
| Windows 11 x64 | Native Node, Unicode paths, junction installation, Chrome/PDF, captions, local OCR and Whisper CUDA/CPU paths have been exercised | Different drivers, accounts and codecs can behave differently; see [Windows setup](windows.md) |
| Windows 10 x64 | Support target; API/runtime compatibility inspected | No Windows 10 PC/VM validation. ARM64 and UNC are outside the exercised scope |
| WSL 2 Ubuntu 26.04 x64 | Report flows, OCR, Whisper GPU/CPU paths and long CPU transcription have been exercised | Separate Linux runtimes and GPU permissions; long sources may require a larger explicit budget. See [WSL setup](wsl.md) |
| macOS | Report/PDF, source controls, local ASR, Apple Vision OCR and confined caption-token acquisition have been exercised | No general Metal acceleration or real-speech accuracy guarantee |
| Linux outside WSL | Debian arm64 and emulated amd64 core/browser/PDF paths, plus arm64 local ASR, have been exercised | General native desktops and GPU combinations are not certified. Keep Chromium's sandbox enabled |
| Installation | Self-contained dependency copies, host links and update recovery are supported | Existing ordinary directories are not replaced. Retained `.previous-*` / `.failed-*` copies require deliberate manual cleanup; see [README](../README.md) |
| Hosts | Codex/Claude flows on macOS and Windows, and pi/Codex flows on Windows/WSL, have been exercised | Host versions, discovery, permissions and resume behavior differ. This is a host-agent skill, not a standalone service |
| CI | [Cross-platform workflow](https://github.com/AgwaB/playback-notes/blob/main/.github/workflows/windows.yml) configures Windows, Linux and macOS checks | Check the exact commit's [Actions results](https://github.com/AgwaB/playback-notes/actions/workflows/windows.yml); local tests or workflow configuration alone do not establish a hosted pass |

## Capabilities and limits

- **Sources:** Local media and direct public media URLs can use supplied SRT/VTT/TXT or approved local ASR. YouTube caption acquisition uses confined HTTP/token handling or the Android caption-list fallback where available. Other platform pages are not general-purpose extraction targets. Service access, caption availability and playback can change.
- **Browser capture:** Explicit, current-video-bound host capture is supported under the [capture contract](youtube-browser-capture.md). DOM captures remain partial with unknown end times and require approval. There is no managed-browser fallback, cookie import, login bypass or user-facing token setup.
- **Caption-token confinement:** Google's BotGuard program runs only where the macOS confinement policy is available. It has no direct network or write access; the parent relays allowlisted requests. The OS read policy is a deny list, not full filesystem isolation: symlinks to other readable paths and host metadata remain limitations. Node permissions add restrictions. The memory setting limits the JS heap, not total process memory. The generated token is sent to YouTube by design.
- **Local ASR:** Requires an explicitly approved, already installed executable and model. Names, numbers, conditions, quiet speech, omissions and hallucinated text remain fallible. Out-of-duration ASR cues are preserved as untimed; successful acquisition is not faithful transcription. The optional [Korean/English recheck](execution.md#automatic-ko-en-recheck) is bounded, not a general language detector or accuracy guarantee. Review suggestions are not automatically merged into evidence.
- **Downloads:** Approved YouTube ASR downloads audio only; visual extraction requires a separate video download approval. Both use explicit yt-dlp, bounded plain-HTTPS streams, no ambient configuration/plugins and no playlist fallback. Keep the tool current. There is no silent media download or remote ASR/vision fallback.
- **Frames and OCR:** Local media and approved YouTube video streams can provide frames or local OCR. Tesseract works best on clean, high-contrast text; noisy subtitles and small slide text can fail. Apple Vision is macOS-only. The platform video size cap can reduce text quality; prefer a local full-resolution file when needed. Inspect cited frames rather than choosing by timestamp alone.
- **HTML, Markdown and PDF:** Use the fixed escaped renderer and structured report schema. HTML has responsive source/transcript controls; diagrams and long tables can scroll locally. Markdown is deterministic. PDF uses an installed Chromium with network requests blocked during print. Verify unfamiliar fonts, RTL layout and new language combinations rather than assuming glyph coverage.
- **Playback and serving:** Directly opened HTML remains readable; embedded playback may require the loopback server and can be rejected by the source service. The server exposes only the public root and an explicitly mapped local media file, not the private work directory.
- **Host sandboxes:** Network access must be allowed for remote acquisition. Nested macOS sandboxes can prevent caption-token confinement or Chromium startup. Report capability failures and use approved alternatives; never disable the Chromium sandbox to make an export work.

See [execution](execution.md), [report authoring](report-authoring.md), [long sources](long-sources.md) and [troubleshooting](troubleshooting.md) for operational details.

## Process cleanup limits

Local native executables are explicitly supplied, trusted tools; process cleanup is not hostile-executable containment. POSIX process groups cover the tested ordinary launcher/descendant cases, but spawn-before-registration, group-identifier reuse and termination-confirmation races remain unresolved. Windows uses best-effort `taskkill /T`, not a Job Object; exited launchers and caller death can defeat tree cleanup. A timeout alone is not proof that every descendant has stopped.

## Important interpretations

- Extraction `complete` means the selected transcript response/file was acquired. It does not prove every spoken word or visual was captured, nor that supplied text corresponds to the media.
- Script validation proves structure and bindings, not factual correctness or actual human/model attention. The host owns editorial reasoning and evidence review.
- Source content is untrusted data, not permission to change settings, run tools or publish files.
- The host's own model/data policy still applies to content it receives. No new API key does not imply fully local host reasoning.
- Public HTML includes the transcript unless `publishTranscript` is false; report quotations remain public. Share deliberately. Local source media is copied only with explicit approval.
