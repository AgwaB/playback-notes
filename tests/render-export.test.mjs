import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.mjs";
import { htmlDocument } from "../lib/rendering.mjs";
import { markdownDocument } from "../lib/markdown.mjs";
import { render } from "../scripts/render.mjs";
import { exportReport } from "../scripts/export.mjs";
import { jsonBytes, readJson } from "../lib/io.mjs";

test("HTML is document-first, escaped, carries source timestamps and no external resources before interaction", async (t) => {
  const f = await fixture({
    mutate(d) {
      d.report.title = "<img src=x onerror=alert(1)>";
      d.evidence.segments[0].text += "</script><script>alert(2)</script>";
      d.report.sections[0].blocks[3].verbatim = false;
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const html = htmlDocument(f.bundle);
  assert.ok(html.includes("&lt;img src&#x3D;x onerror&#x3D;alert(1)&gt;"));
  assert.ok(!html.includes("<script>alert(2)</script>"));
  assert.ok(html.includes('data-ms="2000"'));
  assert.ok(html.includes('id="source-panel" hidden'));
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.ok(!html.includes("<iframe"));
  assert.ok(!html.includes("fonts.googleapis.com"));
  assert.ok(!html.includes("yt-overlay"));
});
test("Markdown serializer preserves tables, conditions, code and real timestamp links", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const md = markdownDocument(f.bundle);
  assert.ok(md.includes("검증된 입력"));
  assert.ok(md.includes("| 조건"));
  assert.ok(md.includes("```javascript"));
  assert.ok(md.includes("t=2s"));
  assert.ok(md.includes(f.data.evidenceSha256));
});
test("missing PDF runtime preserves HTML/MD and reports incomplete", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await render(f.args);
  const outcome = await exportReport(f.args);
  assert.equal(outcome.status, "partial");
  assert.ok(outcome.issues.some((i) => i.code === "PDF_RUNTIME_MISSING"));
  const manifest = (await readJson(path.join(f.out, "manifest.json"))).data;
  assert.equal(manifest.overallStatus, "incomplete");
  assert.equal(manifest.artifacts.find((a) => a.format === "pdf").path, null);
  assert.ok(
    (await readFile(path.join(f.out, "index.html"), "utf8")).includes(
      'href="report.md"',
    ),
  );
  assert.ok(
    !(await readFile(path.join(f.out, "index.html"), "utf8")).includes(
      'href="report.pdf"',
    ),
  );
});
test("an HTML-only request makes export a no-op success, so render → export → verify always works", async (t) => {
  const f = await fixture({
    mutate(d) {
      d.request.formats = ["html"];
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await render(f.args);
  const outcome = await exportReport(f.args);
  assert.equal(outcome.status, "ok");
  assert.deepEqual(outcome.issues.map((i) => i.code), ["NOTHING_TO_EXPORT"]);
  assert.equal(
    (await readJson(path.join(f.out, "manifest.json"))).data.overallStatus,
    "completed",
  );
  // An explicit format the request did not ask for is still a contract error.
  await assert.rejects(exportReport({ ...f.args, formats: "pdf" }), { code: "INVALID_CONTRACT" });
});
test("complete non-PDF requested formats are not treated as missing PDF", async (t) => {
  const f = await fixture({
    mutate(d) {
      d.request.formats = ["html", "markdown"];
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const outcome = await exportReport(f.args);
  assert.equal(outcome.status, "ok");
  assert.equal(
    (await readJson(path.join(f.out, "manifest.json"))).data.overallStatus,
    "completed",
  );
});
test("same revision rejects changed report and output files owned by somebody else", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await render(f.args);
  f.data.report.title = "new report";
  await writeFile(f.args.report, jsonBytes(f.data.report));
  await assert.rejects(render(f.args), { code: "EVIDENCE_MISMATCH" });
  const g = await fixture();
  t.after(() => rm(g.root, { recursive: true, force: true }));
  await writeFile(path.join(g.out, "index.html"), "User content");
  await assert.rejects(render(g.args), { code: "OUTPUT_EXISTS" });
});
test("output cannot serve the private work root or follow a symlink", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await assert.rejects(render({ ...f.args, "out-dir": f.work }), {
    code: "UNSAFE_PATH",
  });
  await symlink(f.work, path.join(f.out, "escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    render({ ...f.args, "out-dir": path.join(f.out, "escape") }),
    { code: "UNSAFE_PATH" },
  );
});
test("local-only media has human-readable source times, never a fabricated public link", async (t) => {
  const f = await fixture({
    mutate(d) {
      d.evidence.source.kind = "local-media";
      d.evidence.source.canonicalUrl = null;
      d.evidence.source.platformId = null;
      d.evidence.source.playback = { kind: "native", locator: "media:fixture" };
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const md = markdownDocument(f.bundle);
  assert.ok(!md.includes("https://"));
  assert.ok(md.includes("00:02"));
  assert.ok(!htmlDocument(f.bundle).includes("file:///"));
});

test("adjacent timed citations collapse into one start–end chip; gaps, untimed and frames stay separate", async (t) => {
  const f = await fixture({
    mutate(d) {
      d.evidence.source.durationMs = 9000;
      d.evidence.extraction.timing = "partial";
      d.evidence.segments.push(
        {
          id: "seg-000004",
          startMs: 6000,
          endMs: 7000,
          text: "네 번째 행",
          speaker: null,
        },
        {
          id: "seg-000005",
          startMs: 7000,
          endMs: 8000,
          text: "다섯 번째 행",
          speaker: null,
        },
        {
          id: "seg-000006",
          startMs: null,
          endMs: null,
          text: "시각 없는 행",
          speaker: null,
        },
      );
      d.evidence.chunks[0].segmentIds.push(
        "seg-000004",
        "seg-000005",
        "seg-000006",
      );
      d.report.summary[0].citations = [
        { kind: "segment", id: "seg-000001" },
        { kind: "segment", id: "seg-000002" },
        { kind: "segment", id: "seg-000003" },
        { kind: "segment", id: "seg-000006" },
        { kind: "segment", id: "seg-000005" },
      ];
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const html = htmlDocument(f.bundle);
  const chips = [
    ...html.matchAll(
      /<a class="ts"[^>]*data-anchor="tx-(seg-\d+)"(?:[^>]*data-ms="(\d+)")?[^>]*>([^<]+)<\/a>/g,
    ),
  ].map((m) => [m[1], m[2] ?? null, m[3]]);
  const summaryChips = chips.slice(0, 3);
  assert.deepEqual(summaryChips, [
    ["seg-000001", "0", "00:00–00:04"],
    ["seg-000006", null, "전사 seg-000006"],
    ["seg-000005", "7000", "00:07"],
  ]);
  const md = markdownDocument(f.bundle);
  assert.ok(md.includes("\\[00:00–00:04\\]"));
});

test("Korean reports localize known extraction warnings and keep unknown ones verbatim", async (t) => {
  const f = await fixture({
    mutate(d) {
      d.evidence.extraction.warnings = [
        {
          code: "AUTOMATIC_CAPTIONS",
          severity: "warning",
          message:
            "The source captions were automatically generated and may contain transcription errors.",
          path: null,
          retryable: false,
        },
        {
          code: "SOMETHING_NEW",
          severity: "warning",
          message: "An English message the renderer has never seen.",
          path: null,
          retryable: false,
        },
      ];
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const html = htmlDocument(f.bundle);
  assert.ok(html.includes("자동 생성된 것으로"));
  assert.ok(!html.includes("automatically generated"));
  assert.ok(html.includes("An English message the renderer has never seen."));
  assert.ok(markdownDocument(f.bundle).includes("자동 생성된 것으로"));
});

test("Korean reports localize known extraction warnings and keep unknown ones verbatim", async (t) => {
  const f = await fixture({
    mutate(d) {
      d.evidence.extraction.warnings = [
        {
          code: "AUTOMATIC_CAPTIONS",
          severity: "warning",
          message:
            "The source captions were automatically generated and may contain transcription errors.",
          path: null,
          retryable: false,
        },
        {
          code: "SOMETHING_NEW",
          severity: "warning",
          message: "An English message the renderer has never seen.",
          path: null,
          retryable: false,
        },
      ];
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const html = htmlDocument(f.bundle);
  assert.ok(html.includes("자동 생성된 것으로"));
  assert.ok(!html.includes("automatically generated"));
  assert.ok(html.includes("An English message the renderer has never seen."));
  assert.ok(markdownDocument(f.bundle).includes("자동 생성된 것으로"));
});
