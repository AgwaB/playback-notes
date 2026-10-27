import { mkdtemp, realpath, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { jsonBytes, sha256 } from "../lib/io.mjs";
import { normalizeRequest, validateData } from "../lib/validation.mjs";

export function sampleData() {
  const evidence = {
    schemaVersion: 1,
    id: "ev-fixture",
    source: {
      id: "src-fixture",
      kind: "youtube",
      mediaType: "video",
      title: "Synthetic source fixture",
      displayName: "Synthetic source fixture",
      canonicalUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      platformId: "jNQXAC9IVRw",
      sourceLanguage: "ko",
      durationMs: 6000,
      playback: { kind: "youtube", locator: "jNQXAC9IVRw" },
    },
    extraction: {
      status: "complete",
      method: "user-transcript",
      provider: "fixture",
      providerVersion: "1",
      retrievedAt: "2026-01-01T00:00:00.000Z",
      timing: "complete",
      processedRanges: [],
      gaps: [],
      warnings: [],
    },
    segments: [
      {
        id: "seg-000001",
        startMs: 0,
        endMs: 2000,
        text: "입력이 검증된 경우에만 이 방법을 적용합니다.",
        speaker: null,
      },
      {
        id: "seg-000002",
        startMs: 2000,
        endMs: 4000,
        text: "PDF가 없으면 전체 작업을 완료했다고 하지 않습니다.",
        speaker: null,
      },
      {
        id: "seg-000003",
        startMs: 4000,
        endMs: 6000,
        text: "기존 증거를 재사용하고 추가 모델 호출 없이 내보냅니다.",
        speaker: null,
      },
    ],
    frames: [],
    chunks: [
      {
        id: "chunk-00001",
        segmentIds: ["seg-000001", "seg-000002", "seg-000003"],
        contextSegmentIds: [],
      },
    ],
  };
  const evidenceSha256 = sha256(jsonBytes(evidence));
  const statement = (text, id = "seg-000001", attribution = "source") => ({
    text,
    attribution,
    citations: [{ kind: "segment", id }],
  });
  const report = {
    schemaVersion: 1,
    evidenceRef: { id: evidence.id, sha256: evidenceSha256 },
    mode: "briefing",
    outputLanguage: "ko",
    title: "근거 중심 영상 리포트 — 합성 데모",
    summary: [statement("검증된 입력만 사용하고 결과 파일을 확인합니다.")],
    sections: [
      {
        id: "principles",
        heading: "핵심 원칙",
        blocks: [
          {
            type: "paragraph",
            statement: statement("입력이 검증된 경우에만 적용합니다."),
          },
          {
            type: "list",
            ordered: true,
            items: [
              statement("PDF 누락은 미완료입니다.", "seg-000002"),
              statement("증거를 재사용합니다.", "seg-000003"),
            ],
          },
          {
            type: "table",
            columns: ["조건", "동작"],
            rows: [[statement("검증된 입력"), statement("방법 적용")]],
          },
          {
            type: "quote",
            verbatim: true,
            statement: statement(evidence.segments[0].text),
          },
          {
            type: "code",
            text: "if (validated) apply();",
            language: "javascript",
            attribution: "interpretation",
            citations: [{ kind: "segment", id: "seg-000001" }],
          },
        ],
      },
    ],
    caveats: [
      statement(
        "기계 검증만으로 발언의 사실 여부를 보장하지 않는다는 해석입니다.",
        "seg-000001",
        "interpretation",
      ),
    ],
  };
  const analysis = {
    schemaVersion: 1,
    evidenceId: evidence.id,
    reviewedChunkIds: ["chunk-00001"],
    inspectedFrameIds: [],
    status: "complete",
    limitations: ["합성 테스트 자료입니다. 실제 영상에 대한 요약이 아닙니다."],
  };
  const request = normalizeRequest({
    schemaVersion: 1,
    source: { kind: "url", value: evidence.source.canonicalUrl },
    mode: "briefing",
    outputLanguage: "ko",
    // Broad rendering fixtures explicitly exercise all exports; production defaults are lighter.
    formats: ["html", "markdown", "pdf"],
  });
  return {
    request,
    evidence,
    analysis,
    report,
    evidenceSha256,
    reportSha256: sha256(jsonBytes(report)),
  };
}
export async function fixture(options = {}) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "video-skill-")),
  );
  const work = path.join(root, "work"),
    out = path.join(root, "public");
  await mkdir(work);
  await mkdir(out);
  const data = sampleData();
  options.mutate?.(data);
  data.evidenceSha256 = sha256(jsonBytes(data.evidence));
  data.report.evidenceRef.sha256 = data.evidenceSha256;
  data.reportSha256 = sha256(jsonBytes(data.report));
  const args = { "work-dir": work, "out-dir": out };
  for (const name of ["request", "evidence", "analysis", "report"]) {
    args[name] = path.join(work, `${name}.json`);
    await writeFile(args[name], jsonBytes(data[name]));
  }
  return {
    root,
    work,
    out,
    args,
    data,
    bundle: { ...data, workDir: work, maps: validateData(data) },
  };
}
