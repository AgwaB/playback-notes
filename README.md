# Video Summarizer Skill

영상 링크나 파일을 주면 에이전트가 근거를 읽고 **브리핑 / 딥다이브**를 만듭니다. 기본 결과는 **HTML과 Markdown**이며, PDF는 요청할 때 생성합니다.

```text
영상 링크/파일 → 근거 추출 → 호스트 에이전트의 분석 → 검증 → 읽기 쉬운 리포트
```

## 시작

1. Node.js **24.15 이상인 24.x 또는 26 이상**을 준비하고 저장소에서 `npm ci`를 실행합니다. Node 25는 지원 범위에 포함하지 않습니다.
2. `node scripts/install.mjs --link ~/.claude/skills/video-summarizer,~/.codex/skills/video-summarizer`로 설치합니다. pi는 `~/.pi/agent/skills/video-summarizer`를 연결합니다. Windows 명령은 [Windows 실행 안내](references/windows.md)를 참고하세요.
3. “이 영상 브리핑해줘”, “이 파일 자세히 정리해줘”처럼 요청합니다. PDF가 필요하면 “PDF도 만들어줘”를 덧붙입니다.

별도 채팅 앱이나 새 요약 모델/API 키는 필요하지 않습니다. 현재 사용하는 호스트 에이전트가 분석하고 스크립트는 근거 확보·검증·내보내기를 맡습니다. 호스트가 클라우드 모델이면 전달한 전사·이미지는 해당 호스트의 데이터 정책을 따릅니다.

## 필요한 도구

- 자막이나 제공한 SRT/VTT/TXT가 있으면 음성 인식 모델 없이 처리합니다.
- 로컬 영상·음성·장면 처리에는 `ffmpeg`/`ffprobe`가 필요할 수 있습니다.
- 자막이 없을 때는 승인된 기존 Whisper 실행 파일과 모델로 로컬 전사를 할 수 있습니다. 호환 GPU 실행 파일이 있으면 확인 후 사용하고, 사용할 수 없으면 CPU로 전환합니다. 한영 혼합 전사는 같은 Whisper로 제한적인 [언어 재검사](references/execution.md#automatic-ko-en-recheck)를 할 수 있습니다.
- PDF를 요청한 경우에만 설치된 Chrome/Chromium 경로가 필요합니다. 도구·모델·브라우저는 처리 도중 자동 설치하지 않습니다.

설치 사본은 기본적으로 `~/.agents/skills/video-summarizer`에 두며 호스트 폴더를 링크로 연결합니다. `SKILL.md`만 따로 복사하지 말고 스크립트·참조·템플릿·의존성을 함께 유지하세요. 기존 일반 디렉터리는 설치기가 교체하지 않습니다.

## 지원과 한계

현재 OS·호스트별 검증 범위는 날짜가 있는 [지원 표](references/support-matrix.md) 한 곳에서 확인하세요. Windows 11, WSL, macOS/Linux의 실험 결과와 Windows 10 등 미검증 범위를 구분합니다.

음성 인식과 OCR은 이름·숫자·언어 전환을 틀릴 수 있고, 추출 성공이 모든 발화나 화면의 정확성을 보증하지는 않습니다. 중요한 인용은 원본과 대조합니다. YouTube 자막·재생은 원본 서비스 상태에 따라 달라질 수 있습니다.

원본 미디어와 비공개 작업물은 공개 출력에서 분리합니다. HTML에는 기본적으로 전사가 포함되므로 외부 공유 시 `publishTranscript: false`를 선택할 수 있습니다. 로컬 원본 영상은 명시적으로 요청하지 않으면 복사하지 않습니다.

## 개발 검증

```bash
npm run check
npm test
TEST_BROWSER_EXECUTABLE='/absolute/path/to/chrome' npm run test:browser
```

일반 테스트는 실제 ffmpeg/ffprobe를 사용합니다. 브라우저/PDF 테스트는 Chrome/Chromium과 Poppler의 `pdftotext`/`pdfinfo`가 필요하며 브라우저 경로가 없으면 건너뜁니다. macOS sandbox 전용 시험은 해당 OS에서만 실행됩니다. CI는 [지원 표](references/support-matrix.md)의 구성·검증 상태를 따릅니다.

[스킬](SKILL.md) · [실행 참조](references/execution.md) · [Windows](references/windows.md) · [WSL](references/wsl.md) · [문제 해결](references/troubleshooting.md)
