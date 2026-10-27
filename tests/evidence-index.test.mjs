import test from "node:test";
import assert from "node:assert/strict";
import { makeChunks, chunkDocument, indexEvidence } from "../lib/evidence.mjs";

test("shared chunk indexing preserves source order, exact context and Unicode budgets", () => {
  const segments = [
    { id: "a", text: "A".repeat(1000) },
    { id: "b", text: "B".repeat(1001) },
    { id: "c", text: "🌱".repeat(600) },
    { id: "d", text: "tail" },
  ];
  const evidence = { id: "example", segments, chunks: makeChunks(segments, 1100) };
  assert.deepEqual(evidence.chunks.map((chunk) => [chunk.segmentIds, chunk.contextSegmentIds]), [
    [["a"], []], [["b"], ["a"]], [["c", "d"], []],
  ]);
  const index = indexEvidence(evidence);
  const documents = evidence.chunks.map((chunk) => chunkDocument(evidence, chunk, index));
  assert.deepEqual(documents.flatMap((document) => document.segments), segments);
  assert.equal(documents[1].context[0], segments[0]);
  assert.equal(documents.at(-1).segments.at(-1).text, "tail");
  assert.match(documents[0].notice, /UNTRUSTED/);
});

test("a long source shares one index per operation without a stale global evidence cache", () => {
  let reads = 0;
  const segments = Array.from({ length: 10000 }, (_, i) => ({ id: `s${i}`, text: "x".repeat(300) }));
  const evidence = { id: "long", get segments() { reads++; return segments; }, chunks: makeChunks(segments) };
  const index = indexEvidence(evidence);
  const count = evidence.chunks.reduce((n, chunk) => n + chunkDocument(evidence, chunk, index).segments.length, 0);
  assert.equal(count, 10000);
  assert.equal(reads, 1, "chunk materialization must not rebuild the full segment index");
  const other = { ...evidence, id: "other" };
  assert.throws(() => chunkDocument(other, other.chunks[0], index), { code: "EVIDENCE_MISMATCH" });
  segments[0] = { id: "s0", text: "updated" };
  const next = indexEvidence(evidence);
  assert.equal(chunkDocument(evidence, evidence.chunks[0], next).segments[0].text, "updated");
  assert.notEqual(next, index);
});
