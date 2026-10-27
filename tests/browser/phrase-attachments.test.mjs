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
const attachments = [
  ["“언제나 안전하다”는", "“언제나 안전하다”"],
  ["“30분 생각해도 된다”는", "“30분 생각해도 된다”"],
  ["“flying planes can be dangerous”는", "“flying planes can be dangerous”"],
  ["“값이 계산되었다”와", "“값이 계산되었다”"],
  ["“컴퓨터는 지시한 것만 한다”로", "“컴퓨터는 지시한 것만 한다”"],
  ["“숙련된 라벨러의 통계적 모사”라는", "“숙련된 라벨러의 통계적 모사”"],
  ["“RLHF는 RL이 아니다”라는", "“RLHF는 RL이 아니다”"],
  ["'short source'라는", "'short source'"],
  ["(g+x/g)/2로", "(g+x/g)"],
  ["JSON-RPC", "JSON-"],
  ["80~90%는", "80~90%"],
  ["0.1·0.8·0.3·0.4·0.5와", "0.1·0.8·0.3·0.4·0."],
];
const longQuote = "“지원되는 경우 장기 작업의 진행 상태를 전달한다”는";
const heading = "학교는 창의성을 죽이는가? — 켄 로빈슨의 교육 재설계 제안";
const limitation = "영상에서 다룬 JSON-RPC 2.0 버전 범위만 검토했다.";
const unsafe = '<img src=x onerror="globalThis.injected=true"> <script>globalThis.injected=true</script>';
const numericCaption = "모델 점수 0.1·0.8·0.3·0.4·0.5와 인간 순위를 보여 준다.";

test("phrase groups preserve complete attached tokens, numeric literals and escaped source text", () => {
  const overlong = `“${"a".repeat(48)}”라는`;
  const corpus = [...attachments.map(([text]) => text), longQuote, overlong,
    "0.1·0.8·0.3·0.4·0.5와 인간 순위", "3.14·2.71·1.62·0.58·9.81·7.23·6.54·8.76·5.43·4.32·2.10·1.23과",
    unsafe,
    '“<img src=x onerror=alert(1)>”는 <a href="javascript:alert(1)">JSON-RPC</a>',
  ];
  for (const text of corpus) {
    const paragraph = new JSDOM(`<p>${phraseHtml(text)}</p>`).window.document.querySelector("p");
    assert.equal(paragraph.textContent, text, text);
    assert.equal(paragraph.querySelectorAll("img,script,a").length, 0, text);
    assert.ok([...paragraph.querySelectorAll(".source-phrase")].every((span) => span.textContent.length <= 50));
  }
  for (const [text] of attachments) {
    const document = new JSDOM(phraseHtml(text)).window.document;
    assert.ok([...document.querySelectorAll(".source-phrase")].some((span) => span.textContent === text), `whole attached token: ${text}`);
  }
  const declined = new JSDOM(phraseHtml(overlong)).window.document;
  assert.equal(declined.querySelectorAll(".source-phrase").length, 0, "decline a whole overlong attached token");
  for (const token of [`JSON-${"RPC".repeat(20)}.2.0는`, `80~${"90".repeat(30)}%는`])
    assert.equal(new JSDOM(phraseHtml(token)).window.document.querySelectorAll(".source-phrase").length, 0, token);
  const decimalText = corpus[15];
  const decimals = new JSDOM(`<p>${phraseHtml(decimalText)}</p>`).window.document.querySelector("p");
  for (const span of decimals.querySelectorAll(".source-phrase")) {
    const before = span.previousSibling?.textContent?.at(-1) ?? "";
    const after = span.nextSibling?.textContent?.[0] ?? "";
    assert.ok(!(/[0-9]/u.test(before) && span.textContent.startsWith(".")));
    assert.ok(!(/[0-9]/u.test(after) && span.textContent.endsWith(".")), "a group cannot end inside a decimal");
  }
});

test("Chrome keeps source suffixes, numbers, heading attributions and limitations readable at line boundaries", {
  skip: !executablePath, timeout: 60000,
}, async (t) => {
  const f = await fixture({ mutate(data) {
    data.report.title = heading;
    data.analysis.limitations = [limitation, unsafe];
    data.report.sections[0].blocks = [...attachments.map(([text]) => text), longQuote].map((text) => ({
      type: "paragraph", statement: { text, attribution: "source", citations: [{ kind: "segment", id: "seg-000001" }] },
    }));
    data.report.sections[0].blocks.push({
      type: "diagram", id: "numeric-caption", kind: "stack", title: "수치 비교", alt: "두 수치의 비교",
      nodes: ["a", "b"].map((id) => ({ id, label: "점수", sublabel: null, focal: false })), edges: [],
      caption: { text: numericCaption, attribution: "source", citations: [{ kind: "segment", id: "seg-000001" }] },
    });
  } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const markdown = markdownDocument(f.bundle);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(htmlDocument(f.bundle));
  await page.evaluate(() => document.fonts.ready);
  const source = await page.locator("#limitations li").allTextContents();
  assert.ok(source.includes(limitation) && source.includes(unsafe));
  assert.equal(await page.locator("#limitations img, #limitations script").count(), 0);
  assert.equal(await page.evaluate(() => globalThis.injected), undefined);
  assert.ok(await page.locator("#limitations .source-phrase").allTextContents().then((texts) => texts.some((text) => text.includes("JSON-RPC 2.0"))));
  const evidenceDir = process.env.TEST_RESPONSIVE_EVIDENCE_DIR;
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  const measurements = [];
  const failures = [];
  for (const width of [375, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const observed = await page.evaluate(({ attachments, longQuote }) => {
      const measure = (element, target) => {
        const start = element.textContent.indexOf(target), nodes = [];
        if (start < 0) return { text: target, error: "missing text" };
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let offset = 0;
        while (walker.nextNode()) { nodes.push({ node: walker.currentNode, start: offset }); offset += walker.currentNode.length; }
        const rects = [];
        for (let i = start; i < start + target.length; i++) {
          if (/\s/u.test(element.textContent[i])) continue;
          const item = nodes.findLast((entry) => entry.start <= i), range = document.createRange();
          range.setStart(item.node, i - item.start); range.setEnd(item.node, i - item.start + 1);
          const rect = range.getBoundingClientRect(); rects.push({ top: Math.round(rect.top), left: rect.left, right: rect.right });
        }
        return { text: target, lines: [...new Set(rects.map((rect) => rect.top))], rects };
      };
      const paragraphs = [...document.querySelectorAll("#section-principles > p")];
      const observations = attachments.map(([target, base], index) => {
        const paragraph = paragraphs[index], spacer = document.createElement("span");
        paragraph.querySelector(".boundary-spacer")?.remove();
        const probe = document.createElement("span"); probe.textContent = base;
        probe.style.cssText = "position:absolute;white-space:nowrap"; paragraph.append(probe);
        const baseWidth = probe.getBoundingClientRect().width; probe.remove();
        spacer.className = "boundary-spacer"; spacer.setAttribute("aria-hidden", "true");
        spacer.style.cssText = `display:inline-block;width:${Math.max(0, paragraph.clientWidth - baseWidth - 1)}px`;
        paragraph.prepend(spacer);
        return measure(paragraph, target);
      });
      observations.push(measure(paragraphs.at(-1), "전달한다”는"));
      observations.push(measure(document.querySelector("h1"), "켄 로빈슨의"));
      const limit = [...document.querySelectorAll("#limitations li")].find((e) => e.textContent.includes("JSON-RPC"));
      observations.push(measure(limit, "JSON-RPC 2.0"));
      observations.push(measure(document.querySelector("#diagram-numeric-caption figcaption"), "0.5와"));
      return observations;
    }, { attachments, longQuote });
    for (const result of observed) if (result.error || result.lines.length !== 1)
      failures.push(`${width}px ${result.text}: ${result.error || `${result.lines.length} glyph lines`}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px overflow`);
    measurements.push({ width, observations: observed });
    if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, `attachments-${width}.png`), fullPage: true });
  }
  if (evidenceDir) await writeFile(path.join(evidenceDir, "attachments-geometry.json"), JSON.stringify(measurements, null, 2));
  assert.deepEqual(failures, [], failures.join("\n"));
  assert.equal(markdownDocument(f.bundle), markdown);
  for (const text of [limitation, ...attachments.map(([text]) => text)]) assert.ok(markdown.includes(text));
  assert.ok(!markdown.includes("source-phrase"));
});
