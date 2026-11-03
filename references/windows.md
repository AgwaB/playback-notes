# Running on Windows

Use Windows-native Node.js 24.15 or later in the 24.x line, or 26+, on Windows 10/11 x64. Node 25 is not supported. Windows 10 has been checked for compatibility but has not been tested on a running system. WSL is a separate Linux environment. See the [support matrix](support-matrix.md) for current verification coverage.
To install with the `skills` CLI, run these in PowerShell. Windows PowerShell 5.1 rejects the `&&` in the README's bash command, so the dependencies are installed with `--prefix`:

```powershell
node --version
npx skills add AgwaB/playback-notes -g
npm ci --prefix "$HOME\.agents\skills\playback-notes"
```

Run the `npm ci` line again after `npx skills update playback-notes -g`, which removes the dependencies. The `skills` CLI links Claude Code with a directory junction. If you installed the skill as `video-summarizer` before the rename, remove it with `npx skills remove video-summarizer -g`.

For the manual read-only install, change to the repository directory and run:

```powershell
node --version
npm ci
node scripts/install.mjs --link "$HOME\.claude\skills\playback-notes"
```

The default installation target is `$HOME\.agents\skills\playback-notes`; both `~/` and `~\` are supported. Codex and pi read that directory directly, so `--link` is needed only for Claude Code.
Host links use directory junctions, which require neither administrator privileges nor Developer Mode.
Windows cannot rename a junction over an existing one. When relinking, the installer temporarily moves the existing junction to `<link>.previous-<id>` before creating the new junction (unlike atomic replacement on POSIX). If interrupted between those steps, rename the retained junction back to its original name.
Existing ordinary directories are not replaced. Installed files are read-only, but directory ACLs are not changed,
so this is not a security boundary against file additions or replacements by the same account.

- `node scripts\doctor.mjs` lists which tools are found and the winget command for each missing one (`winget install --id Gyan.FFmpeg -e --source winget` for ffmpeg and ffprobe, `yt-dlp.yt-dlp`, `UB-Mannheim.TesseractOCR`, `Google.Chrome.EXE`; the preinstalled Edge also works for PDF). It finds what winget just installed and passes yt-dlp, Tesseract and the browser by path, so they work at once. ffmpeg is looked up on PATH, which programs started before the install (the agent, and every terminal it opens) keep unchanged: restart the agent after installing ffmpeg.
- Local media and scene processing: `ffmpeg.exe` and `ffprobe.exe` on PATH.
- Requested PDF output: pass an installed Chrome/Chromium `.exe` with `--browser-executable`. Default HTML/Markdown output does not require a browser.
- Optional ASR, OCR and YouTube media: explicitly specify existing whisper.cpp/model, tesseract and yt-dlp `.exe` paths ([local transcription setup](#local-transcription)).
- For approved local ASR, specify an installed GPU build with `--local-asr-gpu-executable` if available. If the GPU cannot be used, processing uses the specified CPU executable. Prepare a GPU-compatible executable and required DLLs in advance; they are not installed automatically during processing.
- `.cmd`/`.bat` wrappers are not executed. Tools and models are not installed automatically.
- Windows ASR output is collected through a byte-limited named pipe. To support Korean paths, input is passed as an ASCII relative path, and the model is hardlinked or copied into the work directory. Models on another volume may require space for a copy.
- Place the required `eng.traineddata`/`kor.traineddata` in `tessdata` beside the Tesseract executable. On Windows, this directory is specified explicitly to avoid automatic-discovery errors with Korean installation paths. Select both languages with `--ocr-languages kor+eng`.
- Apple Vision OCR and the BotGuard sandbox are macOS-only. The Windows caption path uses the Android-app caption list.

Supplied SRT/VTT/TXT transcripts can be UTF-8, Notepad's "Unicode" (UTF-16) or a legacy code page such as EUC-KR/CP949, which is detected from the file's bytes and reported with `TRANSCRIPT_ENCODING_DETECTED`; a file too short to detect must be re-saved as UTF-8.
The skill writes UTF-8 without a byte-order mark. Windows PowerShell 5.1 reads such files in the ANSI code page by default, so read evidence, chunks and reports with `Get-Content -Raw -Encoding UTF8` (PowerShell 7 already defaults to UTF-8). Start a command that pipes a script's output (for example `scripts/read.mjs … | Select-Object`), captures it in a variable or redirects it to a file (`>`) with `[Console]::OutputEncoding = [Text.Encoding]::UTF8;`, or non-English text is silently garbled; output that is neither piped nor captured is passed through unchanged. JSON the agent saves with `Set-Content -Encoding UTF8`, `>` or `Out-File` (UTF-8 with a byte-order mark, or UTF-16) is accepted.
Quote CLI paths that contain spaces or Korean characters. Keep the job folder path at most 200 characters (`PATH_TOO_LONG` otherwise): unless long paths are enabled system-wide, Windows and its media tools stop at about 250 characters, and transcription works about 50 characters below the job folder. Output folders and source files can be longer. In JSON, write paths as `C:/Videos/sample.mp4` or
`C:\\Videos\\sample.mp4`. Keep work and public output directories separate.

```powershell
ffmpeg -version
ffprobe -version
npm run check
npm test
$env:TEST_BROWSER_EXECUTABLE = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
npm run test:browser
```

Regular `npm test` on Windows requires the built-in .NET Framework `csc.exe`. It is a test-only tool for building native fake executables.
Browser/PDF tests additionally require Chrome and Poppler's `pdftotext`/`pdfinfo`.
The older Xpdf `pdftotext` bundled with Git for Windows does not support `-bbox`; use `where.exe pdftotext` to check which tool is selected.
Product PDF generation requires only Chrome.

See [execution](execution.md) for the execution contract and the [support matrix](support-matrix.md) for platform-specific verification coverage and limitations.

## Local transcription

Video posts on X, YouTube videos without captions, podcasts without a published transcript and your own recordings need speech-to-text on this computer. The agent asks before transcribing and never installs anything on its own. whisper.cpp attaches Windows builds to its `b…` releases (not to `v…` releases); these commands use b5454. Write `curl.exe`: in Windows PowerShell 5.1, `curl` is `Invoke-WebRequest`.

```powershell
$asr = "$HOME\.agents\whisper"
New-Item -ItemType Directory -Force $asr | Out-Null
curl.exe -L -o "$asr\cpu.zip" https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip
Expand-Archive -Force "$asr\cpu.zip" "$asr\cpu"
curl.exe -L -o "$asr\ggml-large-v3-turbo.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin  # 1.6 GB
# Only with an NVIDIA GPU (685 MB, CUDA runtime included; unpacking takes a few minutes):
curl.exe -L -o "$asr\cuda.zip" https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip
Expand-Archive -Force "$asr\cuda.zip" "$asr\cuda"
```

Then save their locations in `$HOME\.agents\playback-notes-asr.json`:

```powershell
$prefs = [ordered]@{
  localAsrExecutable = "$asr\cpu\Release\whisper-cli.exe"
  localAsrModel = "$asr\ggml-large-v3-turbo.bin"
}
if (Test-Path "$asr\cuda\Release\whisper-cli.exe") { $prefs.localAsrGpuExecutable = "$asr\cuda\Release\whisper-cli.exe" }
$prefs | ConvertTo-Json | Set-Content -Encoding UTF8 "$HOME\.agents\playback-notes-asr.json"
```

The GPU build needs a current NVIDIA driver; when the GPU cannot be used, the CPU build transcribes. Transcribing a YouTube video's audio instead of its automatic captions, and key-scene frames from YouTube, also need `yt-dlp.exe`; give the agent its full path. YouTube refuses an outdated yt-dlp (HTTP 403, `Cause: download-failed`): update it with `yt-dlp.exe -U` (release build) or `python -m pip install -U yt-dlp` (pip).
