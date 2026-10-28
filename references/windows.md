# Running on Windows

Use Windows-native Node.js 24.15 or later in the 24.x line, or 26+, on Windows 10/11 x64. Node 25 is not supported. Windows 10 has been checked for compatibility but has not been tested on a running system. WSL is a separate Linux environment. See the [support matrix](support-matrix.md) for current verification coverage.
In PowerShell, change to the repository directory and run:

```powershell
node --version
npm ci
node scripts/install.mjs --link "$HOME\.claude\skills\video-summarizer"
```

The default installation target is `$HOME\.agents\skills\video-summarizer`; both `~/` and `~\` are supported. Codex and pi read that directory directly, so `--link` is needed only for Claude Code.
Host links use directory junctions, which require neither administrator privileges nor Developer Mode.
Windows cannot rename a junction over an existing one. When relinking, the installer temporarily moves the existing junction to `<link>.previous-<id>` before creating the new junction (unlike atomic replacement on POSIX). If interrupted between those steps, rename the retained junction back to its original name.
Existing ordinary directories are not replaced. Installed files are read-only, but directory ACLs are not changed,
so this is not a security boundary against file additions or replacements by the same account.

- Local media and scene processing: `ffmpeg.exe` and `ffprobe.exe` on PATH.
- Requested PDF output: pass an installed Chrome/Chromium `.exe` with `--browser-executable`. Default HTML/Markdown output does not require a browser.
- Optional ASR, OCR and YouTube media: explicitly specify existing whisper.cpp/model, tesseract and yt-dlp `.exe` paths.
- For approved local ASR, specify an installed GPU build with `--local-asr-gpu-executable` if available. If the GPU cannot be used, processing uses the specified CPU executable. Prepare a GPU-compatible executable and required DLLs in advance; they are not installed automatically during processing.
- `.cmd`/`.bat` wrappers are not executed. Tools and models are not installed automatically.
- Windows ASR output is collected through a byte-limited named pipe. To support Korean paths, input is passed as an ASCII relative path, and the model is hardlinked or copied into the work directory. Models on another volume may require space for a copy.
- Place the required `eng.traineddata`/`kor.traineddata` in `tessdata` beside the Tesseract executable. On Windows, this directory is specified explicitly to avoid automatic-discovery errors with Korean installation paths. Select both languages with `--ocr-languages kor+eng`.
- Apple Vision OCR and the BotGuard sandbox are macOS-only. The Windows caption path uses the Android-app caption list.

Quote CLI paths that contain spaces or Korean characters. In JSON, write paths as `C:/Videos/sample.mp4` or
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
