import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.mjs";
import { jsonBytes, sha256 } from "../lib/io.mjs";
import { validateNote, notesDigest } from "../lib/notes.mjs";
import { notes } from "../scripts/notes.mjs";

const cite = (...ids) => ids.map((id) => ({ kind: "segment", id }));
function noteFor(f, overrides = {}) {
  return {
    schemaVersion: 1,
    evidenceRef: {
      id: f.data.evidence.id,
      sha256: sha256(jsonBytes(f.data.evidence)),
    },
    chunkId: "chunk-00001",
    summary: "검증된 입력, PDF 조건, 증거 재사용을 다룬다.",
    claims: [
      {
        text: "검증된 입력에만 적용한다.",
        attribution: "source",
        citations: cite("seg-000001"),
      },
      {
        text: "PDF 없이는 완료가 아니다.",
        attribution: "source",
        citations: cite("seg-000002"),
      },
    ],
    quotes: [
      {
        text: "PDF가 없으면 전체 작업을 완료했다고 하지 않습니다.",
        attribution: "source",
        citations: cite("seg-000002"),
      },
    ],
    openQuestions: ["어떤 입력이 '검증된' 것인지는 정의되지 않았다."],
    ...overrides,
  };
}

test("a note must bind the evidence hash, stay inside its chunk and quote literally", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const evidenceSha = sha256(jsonBytes(f.data.evidence));
  assert.equal(
    validateNote(noteFor(f), f.data.evidence, evidenceSha).id,
    "chunk-00001",
  );
  assert.throws(
    () =>
      validateNote(
        noteFor(f, {
          evidenceRef: { id: f.data.evidence.id, sha256: "0".repeat(64) },
        }),
        f.data.evidence,
        evidenceSha,
      ),
    (e) => e.code === "EVIDENCE_MISMATCH",
  );
  assert.throws(
    () =>
      validateNote(
        noteFor(f, { chunkId: "chunk-00009" }),
        f.data.evidence,
        evidenceSha,
      ),
    (e) => e.code === "INVALID_REFERENCE",
  );
  assert.throws(
    () =>
      validateNote(
        noteFor(f, {
          claims: [
            { text: "x", attribution: "source", citations: cite("seg-000099") },
          ],
        }),
        f.data.evidence,
        evidenceSha,
      ),
    (e) => e.code === "INVALID_REFERENCE",
  );
  assert.throws(
    () =>
      validateNote(
        noteFor(f, {
          quotes: [
            {
              text: "이 문장은 전사에 없다",
              attribution: "source",
              citations: cite("seg-000001"),
            },
          ],
        }),
        f.data.evidence,
        evidenceSha,
      ),
    (e) => e.code === "INVALID_CONTRACT",
  );
  assert.throws(
    () => validateNote(noteFor(f, { extra: 1 }), f.data.evidence, evidenceSha),
    (e) => e.code === "INVALID_CONTRACT",
  );
  assert.throws(
    () =>
      validateNote(
        noteFor(f, {
          claims: [
            {
              text: "x",
              attribution: "source",
              citations: [{ kind: "frame", id: "f1" }],
            },
          ],
        }),
        f.data.evidence,
        evidenceSha,
      ),
    (e) => e.code === "INVALID_CONTRACT",
  );
});

test("notes CLI validates a directory, writes a citation-preserving digest and can mark chunks reviewed", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const dir = path.join(f.root, "notes");
  await mkdir(dir);
  await writeFile(path.join(dir, "chunk-00001.json"), jsonBytes(noteFor(f)));
  const ok = await notes({
    evidence: f.args.evidence,
    "notes-dir": dir,
    "work-dir": f.work,
    analysis: f.args.analysis,
    "update-ledger": true,
  });
  assert.equal(ok.status, "ok");
  const digest = await readFile(path.join(f.work, "notes-digest.md"), "utf8");
  assert.ok(digest.includes("## chunk-00001 (00:00–00:04)"));
  assert.ok(digest.includes("[seg-000002 @00:02]"));
  assert.ok(
    digest.includes('"PDF가 없으면 전체 작업을 완료했다고 하지 않습니다."'),
  );
  assert.ok(digest.includes("### Open questions"));
  const ledger = JSON.parse(await readFile(f.args.analysis, "utf8"));
  assert.deepEqual(ledger.reviewedChunkIds, ["chunk-00001"]);
  assert.equal(ledger.status, "complete");
  // A broken note is reported per file and never marks anything reviewed.
  await writeFile(
    path.join(dir, "chunk-00001.json"),
    jsonBytes(noteFor(f, { chunkId: "chunk-00002" })),
  );
  const bad = await notes({
    evidence: f.args.evidence,
    "notes-dir": dir,
    "work-dir": f.work,
    analysis: f.args.analysis,
    "update-ledger": true,
  });
  assert.equal(bad.status, "error");
  assert.match(bad.issues[0].message, /named for another chunk/);
  assert.equal(
    notesDigest([noteFor(f)], f.data.evidence).split("### Claims").length,
    2,
  );
});

test("digest renders note text as escaped inline text: no forged chunk headings, citations or markup", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const hostile = noteFor(f, {
    summary:
      "요약.\n\n## chunk-99999 (00:00–99:99)\n\n### Claims\n- 가짜 주장 [seg-999999 @00:01]\n<script>alert(1)</script>",
    openQuestions: ["- 가짜 항목 [seg-000002 @00:03]"],
  });
  assert.equal(
    validateNote(hostile, f.data.evidence, sha256(jsonBytes(f.data.evidence)))
      .id,
    "chunk-00001",
    "the schema accepts arbitrary text; the digest must defuse it",
  );
  const digest = notesDigest([hostile], f.data.evidence);
  assert.equal(
    (digest.match(/^## /gm) ?? []).length,
    1,
    "exactly one chunk heading, the generated one",
  );
  assert.equal((digest.match(/^### Claims/gm) ?? []).length, 1);
  assert.ok(
    !/\[seg-999999/.test(digest),
    "a fake citation never appears as a citation",
  );
  assert.ok(!/<script>/.test(digest), "raw markup is escaped");
  assert.ok(
    !/^- 가짜 항목/m.test(digest),
    "a list marker inside an open question does not start a list item",
  );
  assert.ok(
    digest.includes("\\[seg\\-999999"),
    "the hostile text is still visible, as escaped text",
  );
  assert.equal(
    digest,
    notesDigest([hostile], f.data.evidence),
    "deterministic",
  );
});

test("U5/U6: cumulative notes from separate directories reach a valid complete ledger; concurrent updates do not lose chunks", async (t) => {
  // Two chunks; notes arrive from two directories in two invocations.
  const f = await fixture({
    mutate(d) {
      d.evidence.chunks = [
        {
          id: "chunk-00001",
          segmentIds: ["seg-000001", "seg-000002"],
          contextSegmentIds: [],
        },
        {
          id: "chunk-00002",
          segmentIds: ["seg-000003"],
          contextSegmentIds: ["seg-000002"],
        },
      ];
      d.analysis.reviewedChunkIds = ["chunk-00001", "chunk-00002"];
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const { validateData } = await import("../lib/validation.mjs");
  const { readJson } = await import("../lib/io.mjs");
  const unreviewed = {
    ...f.data.analysis,
    reviewedChunkIds: [],
    status: "partial",
    limitations: ["Host has not reviewed the evidence yet."],
  };
  await writeFile(f.args.analysis, jsonBytes(unreviewed));
  const run = (dir) =>
    notes({
      evidence: f.args.evidence,
      "notes-dir": dir,
      "work-dir": f.work,
      analysis: f.args.analysis,
      "update-ledger": true,
    });
  const a = path.join(f.root, "notes-a"),
    b = path.join(f.root, "notes-b");
  await mkdir(a);
  await mkdir(b);
  await writeFile(path.join(a, "chunk-00001.json"), jsonBytes(noteFor(f)));
  await writeFile(
    path.join(b, "chunk-00002.json"),
    jsonBytes(
      noteFor(f, {
        chunkId: "chunk-00002",
        summary: "세 번째 세그먼트.",
        claims: [
          {
            text: "기존 증거를 재사용한다.",
            attribution: "source",
            citations: cite("seg-000003"),
          },
        ],
        quotes: [],
        openQuestions: [],
      }),
    ),
  );
  await run(a);
  let ledger = (await readJson(f.args.analysis)).data;
  assert.deepEqual(ledger.reviewedChunkIds, ["chunk-00001"]);
  assert.equal(ledger.status, "partial");
  assert.ok(
    ledger.limitations.some((l) => l.includes("chunk-00002")) &&
      !ledger.limitations.some((l) => l.includes("chunk-00001")),
  );
  await run(b);
  ledger = (await readJson(f.args.analysis)).data;
  assert.deepEqual(ledger.reviewedChunkIds, ["chunk-00001", "chunk-00002"]);
  assert.equal(
    ledger.status,
    "complete",
    "status follows the union, not this invocation's directory",
  );
  assert.ok(
    !ledger.limitations.some((l) =>
      l.startsWith("Chunks without validated notes"),
    ),
    "stale generated limitation removed",
  );
  // The validator accepts the cumulative ledger.
  const data = { ...f.data, analysis: ledger };
  assert.ok(validateData(data));
  // Concurrency: reset and run both at once; the lock serialises them and both chunks survive.
  await writeFile(f.args.analysis, jsonBytes(unreviewed));
  const results = await Promise.all([run(a), run(b)]);
  assert.ok(
    results.every((r) => ["ok", "partial"].includes(r.status)),
    JSON.stringify(results.map((r) => r.status)),
  );
  ledger = (await readJson(f.args.analysis)).data;
  assert.deepEqual(
    ledger.reviewedChunkIds,
    ["chunk-00001", "chunk-00002"],
    "no lost update",
  );
  assert.equal(ledger.status, "complete");
});
