# Video Summarizer Skill

에이전트가 영상 근거를 읽고, **브리핑 / 딥다이브**를 **HTML · Markdown · PDF**로 만드는 재사용 가능한 스킬입니다.

```text
영상 링크/파일 → 근거 추출 → 호스트 에이전트의 분석 → 검증 → 고정 렌더러 → HTML / MD / PDF
```

별도 채팅 앱, 내부 요약 에이전트, 신규 LLM API 키가 없습니다. 대화와 분석은 사용 중인 호스트가 담당하며 스크립트는 비대화형 도구입니다. 호스트가 클라우드 LLM이면 전달한 전사·이미지는 해당 호스트의 데이터 정책을 따릅니다. 별도 키 불필요가 완전 로컬 처리를 뜻하지는 않습니다.

## 시작

1. Node.js **24+**를 준비하고 이 디렉터리에서 `npm ci`를 실행합니다.
2. 호스트의 스킬 디렉터리에 이 패키지를 설치하거나 [SKILL.md](SKILL.md)를 호스트에게 로드하게 합니다. `SKILL.md`만 따로 복사하지 말고 `references/`, `scripts/`, `lib/`, `schemas/`, `templates/`와 의존성을 함께 유지합니다.
3. “이 영상 브리핑해줘”, “이 로컬 파일을 딥다이브로 정리해줘”처럼 요청합니다. 빠진 소스/모드만 물어봅니다.
4. PDF에는 설치된 Chrome/Chromium 실행 파일이 필요합니다. 로컬 미디어 처리에는 ffmpeg/ffprobe가 필요할 수 있습니다. 도구·모델·브라우저는 자동 설치하지 않습니다.

호스트가 실행하는 정확한 명령, 요청 계약과 종료 코드는 [실행 참조](references/execution.md)에 있습니다. Codex/Claude Code에서의 실제 설치·호출 수용 테스트는 아직 수행하지 않았으며, 지원 인증을 주장하지 않습니다.

## 구현된 핵심

- SRT/VTT/TXT, 로컬 MP4/오디오, YouTube 자막(HTTP + 기본으로 로컬 생성하는 proof-of-origin 토큰 — 모든 YouTube 클라이언트가 하는 방식, 격리 프로세스; 요청 언어·수동 자막 우선) 증거 획득
- 원본 바이트 해시, 인용 ID, 검토 범위, 부분 승인, 이미지 근거 검증
- 본문 우선 HTML, 타임스탬프, 전사 패널, 네이티브 플레이어/공식 YouTube API, 실패 시 대체 접근
- 동일 `report.json`에서 생성하는 Markdown/PDF; 내보내기 단계의 모델 호출 없음
- 원본/비공개 작업 폴더와 공개 출력 폴더 분리, loopback-only 서버, Range/HEAD
- 명시적 설치 실행 파일을 쓰는 선택적 로컬 ASR(whisper.cpp; 자막 없는 YouTube는 승인 시 yt-dlp 오디오 → 로컬 ASR). **원격 ASR·원격 비전 없음**
- 선택적 로컬 OCR: 장면 전환/고정 간격 프레임 샘플링, tesseract 또는 macOS Apple Vision 헬퍼, 자막 영역 필터, 유사도 중복 제거; 프레임 인용·그림 블록·구조 다이어그램
- 긴 소스용 2단계 작성(청크별 검증 노트 → 다이제스트 → 리포트), 카나리아 상태 점검
- 캐시/출력 revision 검증, 실패한 내보내기 링크 비활성화, 미완료 상태의 명시적 전달

## 숨기지 않는 제약

- YouTube 토큰·yt-dlp 경로는 업스트림 변경에 민감합니다. 깨지면 `scripts/canary.mjs`로 분류하고 `bgutils-js`/`jsdom`/yt-dlp를 갱신하세요. 로그인 전용 자막은 호스트 캡처 가져오기로만 처리합니다.
- 로컬 ASR은 한국어 고정 픽스처로만 평가했습니다. 소형 모델(<1 GiB)은 숫자·조건·부정을 손상시킬 수 있어 `ASR_MODEL_COMPACT`를 표시하며, `ggml-large-v3-turbo`를 권장합니다. 청취 기반 인증은 없습니다.
- tesseract는 합성 텍스트 카드에서만 쓸 만했고 테스트한 뉴스 클립에서는 실패했습니다. Apple Vision 엔진은 macOS 전용이며, 실사 평가는 그 클립 한 편뿐입니다. YouTube 토큰 발급도 macOS 샌드박스가 필요해 다른 OS에서는 거부됩니다. OCR 텍스트는 힌트이며 호스트가 프레임 이미지를 직접 확인해야 합니다.
- Linux PDF(Chromium 샌드박스), Windows, 실제 Codex/Claude Code 호스트 수용 테스트는 미검증입니다. 외부 리서치/화자 카드는 의도적으로 범위 밖입니다.
- 전사에 시간 정보가 없으면 만들지 않습니다. 검증 성공이 발언의 사실성이나 인용의 의미적 적합성을 보증하지는 않습니다.

자세한 상태는 [지원 매트릭스](references/support-matrix.md), [추출기 spike](docs/spikes/extractor.md), [검증 기록](docs/verification.md)을 확인하세요.

## 개발 검증

```bash
npm run check
npm test
TEST_BROWSER_EXECUTABLE='/absolute/path/to/chrome' npm run test:browser
npm audit --omit=dev
```

일반 테스트에는 실제 ffmpeg/ffprobe를 사용하는 합성 로컬 미디어 테스트가 있습니다. 브라우저 테스트는 명시된 Chrome/Chromium, ffmpeg, `pdftotext`, `pdfinfo`를 사용합니다. `TEST_BROWSER_EXECUTABLE`이 없으면 브라우저 테스트는 **skip**이며 통과 증거가 아닙니다. 테스트는 외부 LLM·원격 ASR을 호출하지 않습니다.

## 문서와 구성

- [스킬](SKILL.md), [리포트 작성](references/report-authoring.md), [근거 규칙](references/evidence-rules.md), [품질 체크리스트](references/quality-checklist.md), [문제 해결](references/troubleshooting.md)
- [요구사항](docs/requirements.md), [아키텍처](docs/design/architecture.md), [계약](docs/design/contracts.md), [구현 계획](docs/design/implementation-plan.md)
- [재사용 평가](docs/research/reuse-assessment.md)

`docs/`는 설계/검증 기록이고 `.pi/`는 로컬 개발 작업물입니다. 공개 산출물만 공유하더라도 HTML에 전사 텍스트가 포함됨을 유의하세요. 로컬 원본 영상은 기본적으로 복사하지 않습니다.
