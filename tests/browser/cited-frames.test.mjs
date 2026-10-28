import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { chromium } from "playwright-core";
import { fixture } from "../helpers.mjs";
import { htmlDocument } from "../../lib/rendering.mjs";

const executablePath = process.env.TEST_BROWSER_EXECUTABLE;
const cases = [
  { name: "Python 00:19", ms: 19987, videoId: "x7X9w_GIm1s" },
  { name: "Powers 05:02", ms: 302010, videoId: "0fKBhvDjuy0" },
  { name: "A2A 08:23", ms: 503536, videoId: "Tud9HLTk8hg" },
  { name: "zero timestamp", ms: 0, videoId: "jNQXAC9IVRw" },
  { name: "no original URL", ms: 0, videoId: null },
  { name: "untimed degraded view", ms: null, videoId: null },
];

test("gallery timestamps use the same source controls as body citations", {
  skip: !executablePath, timeout: 60000,
}, async (t) => {
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  for (const scenario of cases) await t.test(scenario.name, async (t) => {
    const f = await fixture({ mutate(data) {
      const url = scenario.videoId ? `https://www.youtube.com/watch?v=${scenario.videoId}` : null;
      data.evidence.source.canonicalUrl = url;
      data.evidence.source.platformId = scenario.videoId;
      data.evidence.source.kind = scenario.videoId ? "youtube" : "other";
      data.evidence.source.playback = scenario.videoId
        ? { kind: "youtube", locator: scenario.videoId }
        : { kind: "none", locator: null };
      data.evidence.source.durationMs = 600000;
      data.evidence.frames = [{ id: "frame-gallery", timestampMs: scenario.ms ?? 0,
        assetPath: "assets/gallery.png", sha256: "a".repeat(64), width: 40, height: 20 }];
      data.analysis.inspectedFrameIds = ["frame-gallery"];
      data.report.summary[0].citations.push({ kind: "frame", id: "frame-gallery" });
    } });
    t.after(() => rm(f.root, { recursive: true, force: true }));
    // Null frame times are outside the acquisition schema; exercise only the shared view's degraded-state handling.
    if (scenario.ms === null) f.bundle.maps.frames.get("frame-gallery").timestampMs = null;
    const page = await browser.newPage();
    t.after(() => page.close());
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://video-report.invalid") return route.abort();
      return route.fulfill(url.pathname === "/index.html"
        ? { contentType: "text/html; charset=utf-8", body: htmlDocument(f.bundle) }
        : { contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="gray"/></svg>' });
    });
    await page.goto("https://video-report.invalid/index.html");
    const link = page.locator(".cited-frames a.ts");
    assert.equal(await link.count(), 1, "gallery must expose a citation control even without a public original URL");
    const attributes = await link.evaluate((anchor) => ({ ms: anchor.getAttribute("data-ms"), original: anchor.getAttribute("data-original"), anchor: anchor.dataset.anchor, label: anchor.textContent }));
    await link.click();
    await page.waitForFunction(() => document.querySelector("#player-status").textContent.includes("Playback unavailable"));
    assert.equal(await page.locator("#source-panel").isVisible(), true);
    const fallback = await page.locator("#source-fallback").count()
      ? await page.locator("#source-fallback").getAttribute("href") : null;
    t.diagnostic(JSON.stringify({ ...scenario, attributes, fallback, panelOpen: true, provider: "blocked intentionally" }));
    const expected = scenario.videoId ? `https://www.youtube.com/watch?v=${scenario.videoId}&t=${Math.floor(scenario.ms / 1000)}s` : null;
    assert.equal(fallback, expected, "gallery activation must retain the selected source time in its fallback");
    assert.equal(attributes.ms, scenario.ms === null ? null : String(scenario.ms));
    assert.equal(attributes.anchor, "frame-frame-gallery");
    assert.equal(attributes.original, expected);
    assert.ok(attributes.label.trim());
    assert.ok((await page.locator(".cited-frames img").getAttribute("alt")).startsWith("Cited frames "));
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#source-panel").isVisible(), false);
    assert.equal(await link.evaluate((anchor) => document.activeElement === anchor), true);
    assert.deepEqual(errors, []);
  });
});
