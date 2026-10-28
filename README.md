# Video Summarizer Skill

Give the agent a video link or file, and it reads the evidence to create a **briefing / deep-dive**. The default outputs are **HTML and Markdown**; PDF is generated on request.

```text
Video link/file → Evidence extraction → Host agent analysis → Validation → Readable report
```

## Getting started

1. Use Node.js **24.15 or later in the 24.x line, or 26+**, and run `npm ci` in the repository. Node 25 is not supported.
2. Install with `node scripts/install.mjs --link ~/.claude/skills/video-summarizer,~/.codex/skills/video-summarizer`. For pi, link `~/.pi/agent/skills/video-summarizer`. For Windows commands, see the [Windows guide](references/windows.md).
3. Ask something like “Give me a briefing on this video” or “Analyze this file in depth.” Add “Make a PDF too” if needed.

No separate chat app or new summarization model/API key is needed. Your current host agent performs the analysis; the scripts acquire evidence, validate and export. If the host uses a cloud model, transcripts and images sent to it follow that host's data policy.

This is a multilingual skill, not an English/Korean-only tool. Reports follow the user's conversation language unless an explicit report-language preference overrides it; English is the fallback when the user's language is unknown. Source language is independent. Built-in interface labels remain English; UI translation is out of scope. ASR, OCR and font availability depend on the selected local tools and language data.

## Required tools

- Captions or supplied SRT/VTT/TXT files can be processed without a speech recognition model.
- Local video, audio and scene processing may require `ffmpeg`/`ffprobe`.
- When captions are unavailable, an approved, already installed Whisper executable and model can transcribe locally. A compatible GPU executable is checked before use; if unavailable, processing falls back to the CPU. Mixed Korean/English transcription can use a limited [language recheck](references/execution.md#automatic-ko-en-recheck) with the same Whisper model.
- An installed Chrome/Chromium path is needed only when PDF is requested. Tools, models and browsers are not installed automatically during processing.

The installed copy defaults to `~/.agents/skills/video-summarizer`, with links from host folders. Do not copy only `SKILL.md`; keep the scripts, references, templates and dependencies together. The installer does not replace existing ordinary directories.

During updates, the previous installation is retained in a `.previous-*` recovery directory, and its path is reported. A new copy rolled back after a failure may remain as `.failed-*`. These copies are not recursively deleted automatically, so extra disk space is needed. After checking the new installation and stopping related runs, inspect the ownership and contents of the retained paths and manually remove only copies you no longer need.

## Support and limitations

The dated [support matrix](references/support-matrix.md) is the single reference for current OS/host verification coverage. It distinguishes Windows 11, WSL and macOS/Linux experiments from unverified environments such as Windows 10.

Speech recognition and OCR can misread names, numbers and language switches. Successful extraction does not guarantee the accuracy of every utterance or screen. Check important quotations against the source. YouTube captions and playback depend on the source service's state.

Source media and private working files stay separate from public output. HTML includes the transcript by default; choose `publishTranscript: false` when sharing externally if needed. Local source video is not copied unless explicitly requested.

## Development checks

```bash
npm run check
npm test
TEST_BROWSER_EXECUTABLE='/absolute/path/to/chrome' npm run test:browser
```

Repository documentation is written in English, but language-specific processing rules and multilingual test data are allowed and necessary. Checks must not ban a script. Report-language selection follows the [skill instructions](SKILL.md); see the [support matrix](references/support-matrix.md) for capability limits.

The regular tests use real ffmpeg/ffprobe. Browser/PDF tests require Chrome/Chromium and Poppler's `pdftotext`/`pdfinfo`, and are skipped if no browser path is provided. macOS sandbox tests run only on that OS. CI follows the configuration and verification status in the [support matrix](references/support-matrix.md).

[Skill](SKILL.md) · [Execution reference](references/execution.md) · [Windows](references/windows.md) · [WSL](references/wsl.md) · [Troubleshooting](references/troubleshooting.md)
