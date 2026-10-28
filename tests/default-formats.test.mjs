import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { normalizeRequest } from "../lib/validation.mjs";
import { jsonBytes, readJson } from "../lib/io.mjs";
import { render } from "../scripts/render.mjs";
import { exportReport } from "../scripts/export.mjs";
import { fixture } from "./helpers.mjs";

test("unspecified language and formats finish in English with HTML and Markdown without a PDF runtime", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const request = { ...f.data.request };
  delete request.formats;
  delete request.outputLanguage;
  await writeFile(f.args.request, jsonBytes(request));
  await render(f.args);
  const result = await exportReport(f.args);
  assert.equal(result.status, "ok");
  assert.equal(result.nextAction, "continue");
  assert.equal(result.issues.length, 0);
  const manifest = (await readJson(path.join(f.out, "manifest.json"))).data;
  assert.deepEqual(manifest.requestedFormats, ["html", "markdown"]);
  assert.equal(manifest.overallStatus, "completed");
  assert.ok(
    manifest.artifacts.some(
      (entry) => entry.format === "markdown" && entry.status === "created",
    ),
  );
  assert.ok(!manifest.artifacts.some((entry) => entry.format === "pdf"));
  const html = await readFile(path.join(f.out, "index.html"), "utf8");
  assert.match(html, /<html lang="en"/);
  assert.match(html, /href="report.md"/);
  assert.doesNotMatch(html, /href="report.pdf"/);
});

test("a user-chosen Markdown-only request produces only Markdown", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(
    f.args.request,
    jsonBytes({ ...f.data.request, formats: ["markdown"] }),
  );
  await render(f.args);
  const result = await exportReport(f.args);
  assert.equal(result.status, "ok");
  const manifest = (await readJson(path.join(f.out, "manifest.json"))).data;
  assert.deepEqual(manifest.requestedFormats, ["markdown"]);
  assert.equal(manifest.overallStatus, "completed");
  assert.deepEqual(
    manifest.artifacts.map((entry) => `${entry.format}:${entry.status}`),
    ["markdown:created"],
  );
  await assert.rejects(readFile(path.join(f.out, "index.html")), {
    code: "ENOENT",
  });
});

test("explicit export preferences still override the lightweight defaults", () => {
  const request = {
    schemaVersion: 1,
    source: { kind: "url", value: "https://example.com/video.mp4" },
    mode: "briefing",
    outputLanguage: "ko",
  };
  assert.deepEqual(normalizeRequest(request).formats, ["html", "markdown"]);
  assert.deepEqual(
    normalizeRequest({ ...request, formats: ["html", "pdf"] }).formats,
    ["html", "pdf"],
  );
  assert.deepEqual(
    normalizeRequest({ ...request, formats: ["html"] }).formats,
    ["html"],
  );
});
