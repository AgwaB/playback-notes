import { mkdtemp, realpath, writeFile, mkdir, rm } from "node:fs/promises";
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
      sourceLanguage: "en",
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
        // Keep Unicode source and verbatim-quote coverage in the English fixture.
        text: "Apply this method only when the input is validated. 🙂",
        speaker: null,
      },
      {
        id: "seg-000002",
        startMs: 2000,
        endMs: 4000,
        text: "Do not call the entire task complete without a PDF.",
        speaker: null,
      },
      {
        id: "seg-000003",
        startMs: 4000,
        endMs: 6000,
        text: "Reuse existing evidence and export without additional model calls.",
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
    outputLanguage: "en",
    title: "Evidence-based video report — synthetic demo",
    summary: [
      statement("Use only validated input and verify the output files."),
    ],
    sections: [
      {
        id: "principles",
        heading: "Core principles",
        blocks: [
          {
            type: "paragraph",
            statement: statement("Apply only when the input is validated."),
          },
          {
            type: "list",
            ordered: true,
            items: [
              statement("A missing PDF means incomplete work.", "seg-000002"),
              statement("Reuse evidence.", "seg-000003"),
            ],
          },
          {
            type: "table",
            columns: ["Condition", "Action"],
            rows: [
              [statement("Validated input"), statement("Apply the method")],
            ],
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
        "Machine validation alone does not guarantee factual accuracy; this is an interpretation.",
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
    limitations: ["Synthetic test material, not a summary of a real video."],
  };
  const request = normalizeRequest({
    schemaVersion: 1,
    source: { kind: "url", value: evidence.source.canonicalUrl },
    mode: "briefing",
    outputLanguage: "en",
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
  try {
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
  } catch (error) {
    // Tests that expect an invalid fixture to be rejected never get the root to clean up.
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
