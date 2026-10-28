# Windows 실행

Windows 10/11 x64를 대상으로 Windows 네이티브 Node.js 24.15 이상인 24.x 또는 26 이상을 사용합니다. Node 25는 지원하지 않습니다. Windows 10은 호환성 점검 대상이며 실기 검증은 아직 없습니다. WSL은 별도 Linux 환경입니다. 현재 검증 범위는 [지원 표](support-matrix.md)를 따릅니다.
PowerShell에서 저장소 디렉터리로 이동한 뒤 실행합니다.

```powershell
node --version
npm ci
node scripts/install.mjs --link "$HOME\.claude\skills\video-summarizer,$HOME\.codex\skills\video-summarizer"
```

설치 대상은 기본적으로 `$HOME\.agents\skills\video-summarizer`이며 `~/`와 `~\`를 모두 처리합니다.
호스트 연결에는 관리자 권한이나 Developer Mode가 필요 없는 디렉터리 junction을 사용합니다.
Windows는 junction 위로 이름을 바꿔 덮어쓸 수 없어, 재연결할 때 기존 junction을 잠시 `<link>.previous-<id>`로 옮긴 뒤 새 junction을 둡니다(POSIX의 원자적 교체와 다름). 그 사이에 중단되면 그 이름을 원래 이름으로 되돌리면 됩니다.
기존 일반 디렉터리는 교체하지 않습니다. 설치 파일은 읽기 전용이지만 디렉터리 ACL은 변경하지 않으므로,
같은 계정의 파일 추가·교체를 막는 보안 경계는 아닙니다.

- 로컬 미디어·장면 처리: PATH에 있는 `ffmpeg.exe`, `ffprobe.exe`.
- PDF를 요청한 경우: 설치된 Chrome/Chromium `.exe`를 `--browser-executable`로 전달합니다. 기본 HTML·Markdown 출력에는 브라우저가 필요하지 않습니다.
- 선택적 ASR·OCR·YouTube 미디어: 기존 whisper.cpp/모델, tesseract, yt-dlp `.exe`를 명시합니다.
- 승인된 로컬 ASR에서 GPU 빌드가 설치되어 있으면 `--local-asr-gpu-executable`로 지정합니다. GPU를 사용할 수 없으면 명시한 CPU 실행 파일로 처리합니다. GPU와 호환되는 실행 파일과 필요한 DLL은 미리 준비해야 하며, 처리 도중 자동 설치하지 않습니다.
- `.cmd`/`.bat` 래퍼는 실행하지 않습니다. 도구·모델은 자동 설치하지 않습니다.
- Windows ASR 출력은 바이트 제한이 있는 named pipe로 수집합니다. 한글 경로를 처리하도록 입력은 ASCII 상대 경로로 전달하며, 모델은 작업 폴더에 hardlink 또는 사본을 만듭니다. 다른 볼륨의 모델은 복사 공간이 필요할 수 있습니다.
- Tesseract 실행 파일 옆 `tessdata`에 필요한 `eng.traineddata`/`kor.traineddata`를 둡니다. Windows에서는 이 폴더를 명시해 한글 설치 경로의 자동 검색 오류를 피합니다. `--ocr-languages kor+eng`로 두 언어를 선택합니다.
- Apple Vision OCR 및 BotGuard sandbox는 macOS 전용입니다. Windows 자막 경로는 Android 앱 자막 목록을 사용합니다.

공백·한글을 포함하는 CLI 경로는 따옴표로 감쌉니다. JSON 경로는 `C:/Videos/sample.mp4` 또는
`C:\\Videos\\sample.mp4`처럼 씁니다. 작업·공개 출력 폴더는 분리합니다.

```powershell
ffmpeg -version
ffprobe -version
npm run check
npm test
$env:TEST_BROWSER_EXECUTABLE = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
npm run test:browser
```

Windows의 일반 `npm test`에는 기본 .NET Framework `csc.exe`가 필요합니다. 네이티브 가짜 실행 파일을 빌드하는 테스트 전용 도구입니다.
브라우저/PDF 테스트에는 Chrome과 Poppler `pdftotext`/`pdfinfo`가 추가로 필요합니다.
Git for Windows의 구형 Xpdf `pdftotext`는 `-bbox`를 지원하지 않으므로 `where.exe pdftotext`로 선택된 도구를 확인합니다.
제품 PDF 생성에는 Chrome만 필요합니다.

실행 계약은 [execution](execution.md), 플랫폼별 검증 범위와 한계는 [support matrix](support-matrix.md)를 참고하세요.
