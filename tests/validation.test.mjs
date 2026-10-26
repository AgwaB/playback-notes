import test from "node:test";
import assert from "node:assert/strict";
import { sampleData } from "./helpers.mjs";
import {
  assertSchema,
  normalizeRequest,
  publicUrl,
  validateData,
  validateEvidence,
} from "../lib/validation.mjs";
import { sha256 } from "../lib/io.mjs";
import { makeChunks } from "../lib/evidence.mjs";

const rejected = (mutate, code) => {
  const data = sampleData();
  mutate(data);
  assert.throws(() => validateData(data), { code });
};
test("complete fixture supports both modes without a different schema", () => {
  for (const mode of ["briefing", "deep-dive"]) {
    const data = sampleData();
    data.report.mode = mode;
    data.request.mode = mode;
    assert.equal(validateData(data).segments.size, 3);
  }
});
test("strict contracts reject extra fields and third modes", () => {
  rejected((d) => {
    d.report.html = "<script>bad()</script>";
  }, "INVALID_CONTRACT");
  rejected((d) => {
    d.report.mode = "quiz";
  }, "INVALID_CONTRACT");
  assert.throws(
    () =>
      normalizeRequest({
        ...sampleData().request,
        outputLanguage: "not a locale",
      }),
    { code: "INVALID_CONTRACT" },
  );
});
test("report must bind actual evidence bytes and requested mode/language", () => {
  rejected((d) => {
    d.report.evidenceRef.sha256 = "f".repeat(64);
  }, "EVIDENCE_MISMATCH");
  rejected((d) => {
    d.report.outputLanguage = "en";
  }, "INVALID_CONTRACT");
  rejected((d) => {
    d.analysis.evidenceId = "ev-other";
  }, "EVIDENCE_MISMATCH");
});
test("unknown citations, duplicate IDs and malformed tables fail", () => {
  rejected((d) => {
    d.report.summary[0].citations[0].id = "seg-absent";
  }, "INVALID_REFERENCE");
  rejected((d) => {
    d.evidence.segments[1].id = d.evidence.segments[0].id;
  }, "INVALID_CONTRACT");
  rejected((d) => {
    d.report.sections[0].blocks[2].rows[0].pop();
  }, "INVALID_CONTRACT");
  rejected((d) => {
    d.report.summary[0].citations = [];
  }, "INVALID_CONTRACT");
});
test("missing timestamps remain missing, not inferred", () => {
  const data = sampleData();
  for (const segment of data.evidence.segments) {
    segment.startMs = null;
    segment.endMs = null;
  }
  data.evidence.extraction.timing = "none";
  assert.doesNotThrow(() => validateData(data));
  rejected((d) => {
    d.evidence.segments[0].endMs = -1;
  }, "INVALID_CONTRACT");
  rejected((d) => {
    d.evidence.segments[0].startMs = 1.5;
  }, "INVALID_CONTRACT");
  rejected((d) => {
    d.evidence.segments[0].endMs = 100000;
  }, "INVALID_CONTRACT");
});
test("chunks must cover all segments in their original order", () => {
  rejected((d) => {
    d.evidence.chunks[0].segmentIds.reverse();
  }, "INVALID_CONTRACT");
  const chunks = makeChunks(sampleData().evidence.segments, 30);
  assert.equal(chunks.flatMap((c) => c.segmentIds).length, 3);
  assert.ok(chunks.length > 1);
});
test("failed evidence and unapproved partial evidence cannot produce reports", () => {
  rejected((d) => {
    d.evidence.extraction.status = "failed";
  }, "NO_USABLE_EVIDENCE");
  rejected((d) => {
    d.evidence.extraction.status = "partial";
  }, "UNREVIEWED_EVIDENCE");
  const data = sampleData();
  data.evidence.extraction.status = "partial";
  data.request.policy.partialEvidenceApproval = {
    evidenceSha256: data.evidenceSha256,
  };
  assert.doesNotThrow(() => validateData(data));
  data.evidenceSha256 = "0".repeat(64);
  data.report.evidenceRef.sha256 = data.evidenceSha256;
  assert.throws(() => validateData(data), { code: "UNREVIEWED_EVIDENCE" });
});
test("partial analysis approval binds missing chunks and limitations", () => {
  const data = sampleData();
  data.evidence.chunks = [
    { id: "chunk-00001", segmentIds: ["seg-000001"], contextSegmentIds: [] },
    {
      id: "chunk-00002",
      segmentIds: ["seg-000002", "seg-000003"],
      contextSegmentIds: [],
    },
  ];
  data.analysis.reviewedChunkIds = ["chunk-00001"];
  data.analysis.status = "partial";
  data.report.sections[0].blocks = [data.report.sections[0].blocks[0]];
  assert.throws(() => validateData(data), { code: "UNREVIEWED_EVIDENCE" });
  data.request.policy.partialAnalysisApproval = {
    evidenceSha256: data.evidenceSha256,
    unreviewedChunkIds: ["chunk-00002"],
    limitationsSha256: sha256(JSON.stringify(data.analysis.limitations)),
  };
  assert.doesNotThrow(() => validateData(data));
  data.report.summary[0].citations[0].id = "seg-000002";
  assert.throws(() => validateData(data), { code: "UNREVIEWED_EVIDENCE" });
  data.report.summary[0].citations[0].id = "seg-000001";
  data.analysis.limitations.push("Another missing range");
  assert.throws(() => validateData(data), { code: "UNREVIEWED_EVIDENCE" });
});
test("verbatim quotes are literal and frames require actual inspection", () => {
  rejected((d) => {
    d.report.sections[0].blocks[3].statement.text = "Invented quotation";
  }, "INVALID_CONTRACT");
  const data = sampleData();
  data.evidence.frames.push({
    id: "frame-1",
    timestampMs: 1000,
    assetPath: "assets/frame-1.png",
    sha256: "a".repeat(64),
    width: 1,
    height: 1,
  });
  data.report.summary[0].citations = [{ kind: "frame", id: "frame-1" }];
  assert.throws(() => validateData(data), { code: "UNCONFIRMED_FRAME" });
  data.analysis.inspectedFrameIds = ["frame-1"];
  assert.doesNotThrow(() => validateData(data));
  data.evidence.frames[0].assetPath = "../secret.png";
  assert.throws(() => validateEvidence(data.evidence), {
    code: "INVALID_CONTRACT",
  });
});
test("safe public links reject credentials, signed queries and private addresses", () => {
  assert.ok(publicUrl("https://www.youtube.com/watch?v=jNQXAC9IVRw"));
  for (const value of [
    "javascript:alert(1)",
    "http://localhost/file",
    "http://127.1/a",
    "http://[::1]/a",
    "https://user:pass@example.com/a",
    "https://example.com/video?token=secret",
  ])
    assert.throws(() => publicUrl(value), { code: "UNSAFE_URL" });
});
test("schemas reject noninteger/nonfinite and overlong content", () => {
  const evidence = sampleData().evidence;
  evidence.segments[0].startMs = Infinity;
  assert.throws(() => assertSchema("evidence", evidence), {
    code: "INVALID_CONTRACT",
  });
});
