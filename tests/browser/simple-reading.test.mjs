import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { chromium } from "playwright-core";
import { fixture } from "../helpers.mjs";
import { htmlDocument } from "../../lib/rendering.mjs";

const executablePath = process.env.TEST_BROWSER_EXECUTABLE;
const browserTest = { skip: !executablePath, timeout: 60000 };

async function readingFixture(t) {
  const f = await fixture({ mutate(d) {
    d.report.title = "긴 영상의 핵심을 빠르게 이해하기";
    d.evidence.source.title = "영상 인터뷰 · 합성 UI 검증 자료";
    d.report.summary[0].citations = d.evidence.segments.map((s) => ({ kind: "segment", id: s.id }));
    for (let i = 1; i <= 5; i++) d.report.sections.push({
      id: `topic-${i}`, heading: `${i + 1}. 핵심 내용을 원본과 함께 확인하기`,
      blocks: [{ type: "paragraph", statement: d.report.sections[0].blocks[0].statement }],
    });
    d.evidence.extraction.warnings = [
      { code: "ASR_UNVERIFIED", message: "Automatic transcript.", severity: "warning", path: null, retryable: false },
      { code: "ASR_GPU_FALLBACK", message: "CPU used; CUDA unavailable.", severity: "warning", path: null, retryable: false },
    ];
  } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  return f;
}

test("mobile reader starts with closed contents and compact, touch-sized citations that remain keyboard accessible", browserTest, async (t) => {
  const f = await readingFixture(t);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route("https://www.youtube.com/**", (route) => route.abort());
  await page.setContent(htmlDocument(f.bundle));
  assert.equal(await page.locator(".toc details").evaluate((d) => d.open), false);
  assert.equal(await page.locator("#source-panel").isVisible(), false);
  assert.equal(await page.locator("footer details").evaluate((d) => d.open), false);
  const citations = page.locator(".overview .citations").first();
  assert.equal(await citations.locator("a.ts").count(), 3, "all exact links exist");
  assert.equal(await citations.locator("a.ts:visible").count(), 1);
  const toggle = citations.locator(".citation-toggle");
  for (const target of [toggle, citations.locator("a.ts").first()]) {
    const box = await target.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.TEST_SCREENSHOT_DIR) {
    await mkdir(process.env.TEST_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEST_SCREENSHOT_DIR, "reader-mobile.png"), fullPage: true });
  }
  await toggle.focus();
  await page.keyboard.press("Enter");
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  assert.equal(await citations.locator("a.ts:visible").count(), 3);
  const exactLink = citations.locator('a.ts[data-ms="2000"]');
  await exactLink.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#player-status").textContent.includes("재생할 수 없습니다"));
  assert.ok((await page.locator("#source-fallback").getAttribute("href")).includes("t=2s"));
  await page.keyboard.press("Escape");
  assert.equal(await exactLink.evaluate((a) => document.activeElement === a), true);
  await toggle.click();
  assert.equal(await citations.locator("a.ts:visible").count(), 1);
  await page.emulateMedia({ media: "print" });
  assert.equal(await citations.locator("a.ts:visible").count(), 3, "printing a live page unfolds every exact citation");
  assert.equal(await toggle.isVisible(), false);
  await page.emulateMedia({ media: "screen" });
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await page.locator(".toc details").evaluate((d) => d.open), true);
  if (process.env.TEST_SCREENSHOT_DIR)
    await page.screenshot({ path: path.join(process.env.TEST_SCREENSHOT_DIR, "reader-desktop.png"), fullPage: true });
});

test("without JavaScript all exact citations and native document details remain usable", browserTest, async (t) => {
  const f = await readingFixture(t);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  await page.setContent(htmlDocument(f.bundle));
  const citations = page.locator(".overview .citations").first();
  assert.equal(await citations.locator("a.ts:visible").count(), 3);
  assert.ok((await citations.locator('a.ts[data-ms="2000"]').getAttribute("href")).includes("t=2s"), "without JS the exact citation still opens its original timestamp");
  assert.equal(await citations.locator(".citation-toggle").isVisible(), false);
  await page.locator("footer summary").click();
  assert.equal(await page.locator(".technical-diagnostics").isVisible(), true);
  assert.equal(await page.locator("#source-panel").isVisible(), false);
});
