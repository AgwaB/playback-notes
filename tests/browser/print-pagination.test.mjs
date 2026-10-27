import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixture } from "../helpers.mjs";
import { htmlDocument } from "../../lib/rendering.mjs";
import { markdownDocument } from "../../lib/markdown.mjs";

const execute = promisify(execFile);
const executablePath = process.env.TEST_BROWSER_EXECUTABLE;
const pdfText = process.env.TEST_PDFTOTEXT_EXECUTABLE || "pdftotext";

function pdfPages(boxes) {
  return [...boxes.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/g)].map((match) =>
    [...match[1].matchAll(/<word\b[^>]*>(.*?)<\/word>/g)].map((word) => word[1]),
  );
}

test("short source phrases stay grouped without turning report text into markup", async (t) => {
  const text = 'Use “Python Package Index”, \'Gillian Lynne\' and (imperative knowledge). <img src=x onerror=alert(1)> "<script>alert(1)</script>". This unquoted source phrase stays ordinary. “This quotation contains considerably more than forty eight characters and stays normal prose.”';
  const f = await fixture({ mutate(data) {
    data.report.sections[0].blocks[0].statement.text = text;
  } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const document = new JSDOM(htmlDocument(f.bundle)).window.document;
  const paragraph = document.querySelector("#section-principles > p");
  for (const phrase of ["Python Package Index", "Gillian Lynne", "imperative knowledge"])
    assert.ok([...paragraph.querySelectorAll(".source-phrase")].some((span) => span.textContent.includes(phrase)));
  assert.equal(paragraph.querySelectorAll("img,script").length, 0);
  assert.ok(paragraph.textContent.startsWith(text));
  assert.ok(markdownDocument(f.bundle).includes("Python Package Index"));
  assert.ok(!markdownDocument(f.bundle).includes("source-phrase"));
  const boundary = `"${"a".repeat(48)}" "${"b".repeat(49)}" Don't alter 'short source' or 'third phrase' and '한글 이름'.`;
  f.bundle.report.sections[0].blocks[0].statement.text = boundary;
  const edge = new JSDOM(htmlDocument(f.bundle)).window.document.querySelector("#section-principles > p");
  const grouped = [...edge.querySelectorAll(".source-phrase")].map((span) => span.textContent);
  for (const phrase of [`"${"a".repeat(48)}"`, "'short source'", "'third phrase'"])
    assert.ok(grouped.includes(phrase));
  assert.ok(!grouped.some((phrase) => phrase.includes("b".repeat(49))), "overlong quoted text stays ordinary prose");
  assert.ok(edge.textContent.startsWith(boundary));
});

test("print notice reflects the hidden full transcript while HTML retains its publishing policy", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const html = new JSDOM(htmlDocument(f.bundle)).window.document;
  const print = new JSDOM(htmlDocument(f.bundle, [], [], { print: true })).window.document;
  assert.ok(html.querySelector("#limitations").textContent.includes("원본 전사가 포함됩니다"));
  assert.ok(print.querySelector("#limitations").textContent.includes("전체 자막은 이 문서에 포함하지 않았습니다"));
  assert.equal(html.querySelector("#transcript p").textContent.includes(f.data.evidence.segments[0].text), true);
});

test("printed frame heading follows its first frame and provenance follows Sources across page boundaries", {
  skip: !executablePath, timeout: 120000,
}, async (t) => {
  const f = await fixture({ mutate(data) {
    data.report.sections[0].blocks = [data.report.sections[0].blocks[0]];
    data.report.caveats = [];
    data.analysis.limitations = [];
    data.evidence.source.durationMs = 10000;
    data.evidence.frames = Array.from({ length: 8 }, (_, index) => ({
      id: `frame-${index}`, timestampMs: index * 1000,
      assetPath: `assets/frame-${index}.png`, sha256: "a".repeat(64), width: 400, height: 225,
    }));
    data.analysis.inspectedFrameIds = data.evidence.frames.map((frame) => frame.id);
    data.report.summary[0].citations.push(...data.evidence.frames.map((frame) => ({ kind: "frame", id: frame.id })));
  } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const scratch = await mkdtemp(path.join(os.tmpdir(), "video-print-pagination-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const html = htmlDocument(f.bundle, [], [], { print: true });
  await page.route("**/*", (route) => route.fulfill(new URL(route.request().url()).pathname === "/index.html"
    ? { contentType: "text/html; charset=utf-8", body: html }
    : { contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="225"><rect width="400" height="225" fill="#d2d2ca"/></svg>' }));
  await page.goto("https://video-report.invalid/index.html");
  await page.emulateMedia({ media: "print" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (const image of document.images) { image.loading = "eager"; await image.decode(); }
  });
  const observations = [];
  for (const height of [60, 90, 120, 150, 180]) {
    const style = await page.addStyleTag({ content: `#section-principles{min-height:${height}mm}` });
    const pdf = path.join(scratch, `height-${height}.pdf`);
    await page.pdf({ path: pdf, format: "A4", preferCSSPageSize: true, printBackground: true });
    const { stdout: boxes } = await execute(pdfText, ["-enc", "UTF-8", "-bbox-layout", pdf, "-"], { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const pages = pdfPages(boxes);
    const headingPage = pages.findIndex((words) => words.join(" ").includes("인용한 화면"));
    const headingWords = pages[headingPage];
    const headingIndex = headingWords.indexOf("인용한");
    assert.ok(headingWords.slice(headingIndex + 2).includes("00:00"), `frame heading stranded at ${height}mm: page ${headingPage + 1}`);
    const provenance = pages.findIndex((words) => words.includes("Provenance"));
    assert.ok(pages[provenance].includes("출처"), `provenance-only page at ${height}mm: page ${provenance + 1}`);
    for (let index = 0; index < 8; index++)
      assert.equal(pages.flat().filter((word) => word === `00:0${index}`).length, index === 0 ? 4 : 2, `lost frame ${index} or its citation`);
    const joined = pages.flat().join("");
    assert.ok(joined.includes(f.data.reportSha256));
    assert.ok(joined.includes(f.data.evidenceSha256));
    assert.ok(pages.length > 1, "fixture must exercise a multi-page frame appendix");
    observations.push({ height, pages: pages.length, headingPage: headingPage + 1, provenancePage: provenance + 1 });
    await style.evaluate((element) => element.remove());
  }
  t.diagnostic(JSON.stringify(observations));
});

test("a paragraph shorter than a page does not strand its ending beside citation-only lines", {
  skip: !executablePath, timeout: 60000,
}, async (t) => {
  const f = await fixture({ mutate(data) {
    data.report.sections[0].blocks = [{ type: "paragraph", statement: {
      text: `PARAGRAPH_START ${"A source statement carries its conditions and explanation together for the reader. ".repeat(17)} PARAGRAPH_END`,
      attribution: "source", citations: [{kind:"segment",id:"seg-000001"}],
    } }];
  } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(htmlDocument(f.bundle, [], [], { print: true }));
  await page.emulateMedia({ media: "print" });
  assert.ok(await page.locator("#section-principles > p").evaluate((p) => p.getBoundingClientRect().height < 700));
  const observations = [];
  for (const height of [60, 90, 120, 150]) {
    const style = await page.addStyleTag({ content: `#overview{min-height:${height}mm}` });
    const pdf = path.join(f.root, `paragraph-${height}.pdf`);
    await page.pdf({ path: pdf, format: "A4", preferCSSPageSize: true });
    const { stdout } = await execute(pdfText, ["-enc", "UTF-8", "-bbox-layout", pdf, "-"], { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const pages = pdfPages(stdout);
    const first = pages.findIndex((words) => words.includes("PARAGRAPH_START"));
    const last = pages.findIndex((words) => words.includes("PARAGRAPH_END"));
    assert.equal(first, last, `sub-page paragraph split at ${height}mm: starts page ${first+1}, ends page ${last+1}`);
    observations.push({ height, first: first + 1, last: last + 1 });
    await style.evaluate((element) => element.remove());
  }
  t.diagnostic(JSON.stringify(observations));
});

test("the final two analysis limitations stay together with source notes", {
  skip: !executablePath, timeout: 60000,
}, async (t) => {
  const f = await fixture({ mutate(data) {
    data.report.sections[0].blocks = [data.report.sections[0].blocks[0]];
    data.report.caveats = [];
    data.analysis.limitations = [
      "SAMPLING_CONTEXT Samples between inspected frames may be absent.",
      "COVERAGE_CONTEXT Full source coverage is not asserted.",
    ];
  } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(htmlDocument(f.bundle, [], [], { print: true }));
  await page.emulateMedia({ media: "print" });
  const observations = [];
  for (const height of [100, 110, 120, 130, 140, 150, 160, 170]) {
    const style = await page.addStyleTag({ content: `#section-principles{min-height:${height}mm}` });
    const pdf = path.join(f.root, `limitations-${height}.pdf`);
    await page.pdf({ path: pdf, format: "A4", preferCSSPageSize: true });
    const { stdout } = await execute(pdfText, ["-enc", "UTF-8", "-bbox-layout", pdf, "-"], { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const pages = pdfPages(stdout);
    const sampling = pages.findIndex((words) => words.includes("SAMPLING_CONTEXT"));
    const coverage = pages.findIndex((words) => words.includes("COVERAGE_CONTEXT"));
    const provenance = pages.findIndex((words) => words.includes("Provenance"));
    assert.equal(sampling, coverage, `one-item limitation tail at ${height}mm: sampling page ${sampling+1}, coverage page ${coverage+1}`);
    assert.equal(coverage, provenance, "tail context must stay with its source notes");
    observations.push({ height, pages: pages.length, tailPage: coverage + 1 });
    await style.evaluate((element) => element.remove());
  }
  t.diagnostic(JSON.stringify(observations));
});
