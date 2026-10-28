import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { browserArgs } from "./launch-args.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  rm,
  mkdir,
  realpath,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fixture } from "../helpers.mjs";
import { browserDiagnostics } from "./diagnostics.mjs";
import { render } from "../../scripts/render.mjs";
import { exportReport } from "../../scripts/export.mjs";
import { startServer } from "../../lib/server.mjs";
import { fileHash, jsonBytes, readJson, sha256 } from "../../lib/io.mjs";

const execute = promisify(execFile);
const executablePath = process.env.TEST_BROWSER_EXECUTABLE;

test("an explicitly selected browser alias creates a complete PDF with text and source links", {
  skip: !executablePath,
  timeout: 60000,
}, async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const browserFile = await realpath(executablePath);
  let alias;
  if (process.platform === "win32") {
    const directory = path.join(f.root, "browser alias");
    await symlink(path.dirname(browserFile), directory, "junction");
    alias = path.join(directory, path.basename(browserFile));
  } else {
    alias = path.join(f.root, "browser alias");
    await symlink(browserFile, alias);
  }
  const result = await exportReport({ ...f.args, "browser-executable": alias });
  assert.equal(result.status, "ok", JSON.stringify(result.issues));
  const pdf = path.join(f.out, "report.pdf");
  const { stdout: text } = await execute("pdftotext", [pdf, "-"], {
    timeout: 10000,
  });
  assert.ok(
    text.replace(/\s/g, "").includes(f.data.report.title.replace(/\s/g, "")),
  );
  const { stdout: links } = await execute("pdfinfo", ["-url", pdf], {
    timeout: 10000,
  });
  assert.ok(links.includes("youtube.com/watch?v=jNQXAC9IVRw&t=2s"));
});

test("real native seek, untimed transcript, English PDF, Markdown, images, retry links and offline document", {
  skip: !executablePath,
  timeout: 120000,
}, async (t) => {
  const f = await fixture({
    mutate(d) {
      d.evidence.source.kind = "local-media";
      d.evidence.source.canonicalUrl = null;
      d.evidence.source.platformId = null;
      d.evidence.source.playback = { kind: "native", locator: "media:fixture" };
      d.evidence.extraction.timing = "partial";
      d.evidence.extraction.warnings.push({
        code: "TIMING_UNAVAILABLE",
        severity: "warning",
        message:
          "Some transcript timestamps are unavailable; no times were invented.",
        path: null,
        retryable: false,
      });
      d.evidence.segments.push({
        id: "seg-000004",
        startMs: null,
        endMs: null,
        text: "The preserved sentence has no timestamp.",
        speaker: null,
      });
      d.evidence.chunks[0].segmentIds.push("seg-000004");
      d.report.summary[0].citations.push({ kind: "segment", id: "seg-000004" });
      d.report.title += " <script>window.injected=true</script>";
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const media = path.join(f.root, "synthetic.mp4");
  await execute(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      // Same small encoding as the hardening fixtures (1 s keyframes). Hosted macOS
      // runners intermittently stop responding in Chrome during browser tests; that
      // is not specific to this file, and this encoding does not prevent it.
      "color=c=0x21454a:s=160x90:r=10:d=6",
      "-c:v",
      "libx264",
      "-g",
      "10",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      media,
    ],
    { timeout: 30000 },
  );
  await mkdir(path.join(f.work, "assets"));
  const image = path.join(f.work, "assets", "frame-1.png");
  await execute(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      "1",
      "-i",
      media,
      "-frames:v",
      "1",
      image,
    ],
    { timeout: 30000 },
  );
  f.data.evidence.frames = [
    {
      id: "frame-1",
      timestampMs: 1000,
      assetPath: "assets/frame-1.png",
      sha256: await fileHash(image),
      width: 160,
      height: 90,
    },
  ];
  f.data.analysis.inspectedFrameIds = ["frame-1"];
  f.data.report.sections[0].blocks.push({
    type: "figure",
    frameId: "frame-1",
    alt: "Synthetic teal frame",
    caption: {
      text: "Synthetic frame for testing",
      attribution: "source",
      citations: [{ kind: "frame", id: "frame-1" }],
    },
  });
  f.data.request.source = { kind: "local", value: media };
  f.data.evidenceSha256 = sha256(jsonBytes(f.data.evidence));
  f.data.report.evidenceRef.sha256 = f.data.evidenceSha256;
  for (const name of ["request", "evidence", "analysis", "report"])
    await writeFile(f.args[name], jsonBytes(f.data[name]));
  const jobManifest = path.join(f.work, "manifest.json");
  await writeFile(
    jobManifest,
    jsonBytes({
      sourceId: f.data.evidence.source.id,
      evidenceSha256: f.data.evidenceSha256,
      mediaPath: media,
      mediaSha256: await fileHash(media),
    }),
  );
  const missing = await exportReport(f.args);
  assert.equal(missing.status, "partial");
  const success = await exportReport({
    ...f.args,
    "browser-executable": executablePath,
  });
  assert.equal(success.status, "ok");
  const manifest = (await readJson(path.join(f.out, "manifest.json"))).data;
  assert.equal(manifest.overallStatus, "completed");
  const pdf = await readFile(path.join(f.out, "report.pdf"));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 10000);
  const { stdout: text } = await execute(
    "pdftotext",
    [path.join(f.out, "report.pdf"), "-"],
    { timeout: 10000 },
  );
  assert.ok(text.includes("Core principles"));
  assert.ok(text.includes("Synthetic frame for testing"));
  assert.ok(text.includes("PDF"));
  assert.ok(text.includes(f.data.evidenceSha256));
  assert.ok(text.includes((await readJson(f.args.report)).sha256));
  const { stdout: info } = await execute(
    "pdfinfo",
    [path.join(f.out, "report.pdf")],
    { timeout: 10000 },
  );
  assert.match(info, /Pages:\s+[1-9]/);
  const browser = await chromium.launch({
    args: browserArgs(),
    executablePath,
    headless: true,
    chromiumSandbox: true,
  });
  const diagnostics = browserDiagnostics(t, browser);
  t.after(async () => {
    try {
      await diagnostics.finish();
    } finally {
      await browser.close();
    }
  });
  const running = await startServer({ root: f.out, jobManifest });
  t.after(() => running.close());
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1000 },
  });
  await diagnostics.track(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const external = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(new URL(running.url).origin))
      external.push(request.url());
  });
  await page.goto(running.url);
  assert.equal(await page.locator("h1").textContent(), f.data.report.title);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.locator("iframe").count(), 0);
  assert.equal(await page.locator('a[href="report.pdf"]').count(), 1);
  await page.locator('a.ts[data-ms="2000"]').first().click();
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return (
      video &&
      video.readyState >= 2 &&
      !video.seeking &&
      video.currentTime >= 1.9 &&
      video.currentTime <= 2.1
    );
  });
  assert.equal(
    await page.locator("video").evaluate((video) => video.paused),
    true,
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(await page.locator("#source-panel").isVisible(), false);
  await page.locator('a.ts[data-ms="4000"]').first().click();
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return (
      video &&
      video.readyState >= 2 &&
      !video.seeking &&
      video.currentTime >= 3.9
    );
  });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#source-panel").isVisible(), false);
  const untimed = page.locator('a.ts[data-anchor="tx-seg-000004"]').first();
  assert.equal(await untimed.getAttribute("data-ms"), null);
  assert.equal((await untimed.textContent()).trim(), "Transcript 4");
  await page.locator(".citation-toggle").first().click();
  await untimed.click();
  assert.equal(
    await page.locator("#tx-seg-000004 .transcript-time").count(),
    0,
  );
  assert.ok(
    (await page.locator("#tx-seg-000004").textContent()).includes(
      "No timestamp",
    ),
  );
  assert.ok(
    (await page.locator("#tx-seg-000004").textContent()).includes(
      "The preserved sentence has no timestamp.",
    ),
  );
  const unchangedTime = await page
    .locator("video")
    .evaluate((video) => video.currentTime);
  assert.ok(
    unchangedTime >= 3.9 && unchangedTime <= 4.1,
    "an untimed citation must not invent a seek position",
  );
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const offline = await browser.newPage();
  await diagnostics.track(offline);
  await offline.goto(pathToFileURL(path.join(f.out, "index.html")).href);
  assert.equal(await offline.locator("h1").textContent(), f.data.report.title);
  await offline.getByRole("button", { name: "Open source", exact: true }).click();
  assert.equal(await offline.locator("#source-panel").isVisible(), true);
  assert.equal(
    await offline
      .locator("#close-source")
      .evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(await offline.locator("#transcript p").count(), 4);
  await offline.keyboard.press("Escape");
  assert.equal(await offline.locator("#source-panel").isVisible(), false);
  assert.equal(
    await offline
      .locator("#open-source")
      .evaluate((element) => element === document.activeElement),
    true,
  );
});

test("YouTube failure preserves transcript and external timestamp fallback", {
  skip: !executablePath,
  timeout: 60000,
}, async (t) => {
  const f = await fixture();
  await render(f.args);
  await exportReport({ ...f.args, "browser-executable": executablePath });
  const { stdout: links } = await execute(
    "pdfinfo",
    ["-url", path.join(f.out, "report.pdf")],
    { timeout: 10000 },
  );
  assert.ok(links.includes("youtube.com/watch?v=jNQXAC9IVRw&t=2s"));
  const browser = await chromium.launch({
    args: browserArgs(),
    executablePath,
    headless: true,
    chromiumSandbox: true,
  });
  const running = await startServer({ root: f.out });
  t.after(async () => {
    await browser.close();
    await running.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  await page.route("https://www.youtube.com/**", (route) => route.abort());
  await page.goto(running.url);
  await page.locator('a.ts[data-ms="2000"]').first().click();
  await page.waitForFunction(() =>
    document
      .getElementById("player-status")
      .textContent.includes("Playback unavailable"),
  );
  assert.ok(
    (await page.locator("#source-fallback").getAttribute("href")).includes(
      "t=2s",
    ),
  );
  assert.equal(await page.locator("#transcript p").count(), 3);
});
