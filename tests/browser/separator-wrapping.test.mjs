import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import { chromium } from "playwright-core";
import { fixture } from "../helpers.mjs";
import { phraseHtml } from "../../lib/phrases.mjs";
import { htmlDocument } from "../../lib/rendering.mjs";
import { markdownDocument } from "../../lib/markdown.mjs";

const executablePath = process.env.TEST_BROWSER_EXECUTABLE;
const title = "Python의 설계 감각: 가독성에서 문법·패러다임·라이브러리까지";
const overwideCompound = `가·${"나".repeat(35)}·다`;
const tokens = [["00:18에", "00:"], ["02:00까지의", "02:"], ["01:02:03부터", "01:02:"], ["3:2의", "3:"], ["여덟 살", "여덟"], ["한 살", "한"], ["세 살", "세"]];

test("middle-dot units and timestamp/age tokens preserve exact escaped source text and bounded groups", () => {
  for (const [text] of tokens) {
    const source = `${text} 시기의 변화를 설명한다.`;
    const document = new JSDOM(phraseHtml(source)).window.document;
    assert.equal(document.body.textContent, source);
    assert.ok([...document.querySelectorAll(".source-phrase")].some((span) => span.textContent === text), `complete token: ${text}`);
  }
  for (const text of [title, "0.1·0.8·0.3·0.4·0.5와", `가·${"나".repeat(35)}·다`, '<img src=x onerror=alert(1)> “00:18에”와 문법·패러다임·라이브러리까지']) {
    const document = new JSDOM(phraseHtml(text)).window.document;
    assert.equal(document.body.textContent, text);
    assert.equal(document.querySelectorAll("img,script").length, 0);
    assert.ok([...document.querySelectorAll(".source-phrase")].every((span) => span.textContent.length <= 50));
  }
  const compound = new JSDOM(phraseHtml("문법·패러다임·라이브러리까지")).window.document;
  assert.deepEqual([...compound.querySelector(".source-phrase").children].map((span) => span.textContent), ["문법·", "패러다임·", "라이브러리까지"]);
  const numeric = new JSDOM(phraseHtml("0.1·0.8·0.3·0.4·0.5와")).window.document;
  assert.equal(numeric.querySelectorAll(".source-phrase").length, 1, "decimal grouping remains intact");
  assert.equal(new JSDOM(phraseHtml(`00:${"1".repeat(49)}에`)).window.document.querySelectorAll(".source-phrase").length, 0);
});

test("Chrome avoids leading middle-dot separators and detached timestamp/age units", {
  skip: !executablePath, timeout: 60000,
}, async (t) => {
  const f = await fixture({ mutate(data) {
    data.report.title = title;
    data.report.sections[0].blocks = tokens.map(([text]) => ({ type: "paragraph", statement: { text: `${text} 시기의 변화를 설명한다.`, attribution: "source", citations: [{ kind: "segment", id: "seg-000001" }] } }));
    data.report.sections[0].blocks.push({ type: "paragraph", statement: { text: overwideCompound, attribution: "source", citations: [{ kind: "segment", id: "seg-000001" }] } });
  } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const markdown = markdownDocument(f.bundle);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewportSize({ width: 375, height: 900 });
  await page.setContent(htmlDocument(f.bundle));
  await page.evaluate(() => document.fonts.ready);
  assert.ok((await page.locator("#section-principles > p").last().textContent()).startsWith(overwideCompound));
  assert.ok(await page.locator("#section-principles > p").last().locator(".source-phrase > .source-phrase").nth(1).evaluate((span) => {
    const range = document.createRange(); range.selectNodeContents(span.firstChild);
    return range.getClientRects().length > 1;
  }), "an overwide compound retains internal wrapping and complete visible text");
  const evidenceDir = process.env.TEST_RESPONSIVE_EVIDENCE_DIR;
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  const observations = [], failures = [];
  for (const width of [375, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const observed = await page.evaluate((tokens) => {
      const lines = (element, target = element.textContent) => {
        const start = element.textContent.indexOf(target), walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), groups = new Map();
        let offset = 0;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          for (let i = 0; i < node.length; i++) if (offset + i >= start && offset + i < start + target.length) {
            const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
            const top = Math.round(range.getBoundingClientRect().top);
            groups.set(top, (groups.get(top) ?? "") + node.textContent[i]);
          }
          offset += node.length;
        }
        return [...groups.values()].map((line) => line.trim()).filter(Boolean);
      };
      const paragraphs = [...document.querySelectorAll("#section-principles > p")];
      const tokenLines = tokens.map(([text, base], index) => {
        const paragraph = paragraphs[index]; paragraph.querySelector(".boundary-spacer")?.remove();
        const probe = document.createElement("span"); probe.textContent = base;
        probe.style.cssText = "position:absolute;white-space:nowrap"; paragraph.append(probe);
        const baseWidth = probe.getBoundingClientRect().width; probe.remove();
        const spacer = document.createElement("span"); spacer.className = "boundary-spacer";
        spacer.style.cssText = `display:inline-block;width:${Math.max(0, paragraph.clientWidth - baseWidth - 1)}px`;
        paragraph.prepend(spacer);
        return { text, lines: lines(paragraph, text) };
      });
      return { heading: lines(document.querySelector("h1")), tokenLines, documentWidth: document.documentElement.scrollWidth };
    }, tokens);
    for (const line of observed.heading) if (/^[·ㆍ]/u.test(line)) failures.push(`${width}px leading separator: ${line}`);
    for (const { text, lines } of observed.tokenLines) if (lines.length !== 1) failures.push(`${width}px ${text}: ${lines.join(" / ")}`);
    assert.ok(observed.documentWidth <= width);
    observations.push({ width, ...observed });
    if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, `separators-${width}.png`), fullPage: true });
  }
  if (evidenceDir) await writeFile(path.join(evidenceDir, "separators-geometry.json"), JSON.stringify(observations, null, 2));
  assert.deepEqual(failures, [], failures.join("\n"));
  assert.equal(markdownDocument(f.bundle), markdown);
  assert.ok(markdown.includes(title) && !markdown.includes("source-phrase"));
});
