import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import { chromium } from "playwright-core";
import { browserArgs } from "./launch-args.mjs";
import { fixture } from "../helpers.mjs";
import { phraseHtml } from "../../lib/phrases.mjs";
import { htmlDocument } from "../../lib/rendering.mjs";
import { markdownDocument } from "../../lib/markdown.mjs";

const executablePath = process.env.TEST_BROWSER_EXECUTABLE;
const attachments = [
  ["“Always safe”tag", "“Always safe”"],
  ["“Think for 30 minutes”note", "“Think for 30 minutes”"],
  ["“flying planes can be dangerous”tag", "“flying planes can be dangerous”"],
  ["“The value was calculated”label", "“The value was calculated”"],
  ["“Computers follow instructions”tag", "“Computers follow instructions”"],
  [
    "“A statistical imitation of skilled labelers”tag",
    "“A statistical imitation of skilled labelers”",
  ],
  ["“RLHF is not RL”claim", "“RLHF is not RL”"],
  ["'short source',", "'short source'"],
  ["(g+x/g)/2unit", "(g+x/g)"],
  ["JSON-RPC", "JSON-"],
  ["80~90%rate", "80~90%"],
  ["0.1·0.8·0.3·0.4·0.5value", "0.1·0.8·0.3·0.4·0."],
  ["“언제나 안전하다”는", "“언제나 안전하다”"],
  ["“RLHF is not RL”이라는", "“RLHF is not RL”"],
  ["(g+x/g)/2라는", "(g+x/g)"],
  ["80~90%가", "80~90%"],
  ["0.1·0.8·0.3·0.4·0.5라는", "0.1·0.8·0.3·0.4·0."],
];
const longQuote = "“Long tasks can report progress”note";
const heading = "Do schools kill creativity? — Ken Robinson's view";
const limitation = "Review scope: JSON-RPC 2.0.";
const unsafe =
  '<img src=x onerror="globalThis.injected=true"> <script>globalThis.injected=true</script>';
const numericCaption = "Scores: 0.1·0.8·0.3·0.4·0.5value; human rankings.";

test("phrase groups preserve complete attached tokens, numeric literals and escaped source text", () => {
  const overlong = `“${"a".repeat(48)}”tag`;
  const corpus = [
    ...attachments.map(([text]) => text),
    longQuote,
    overlong,
    "0.1·0.8·0.3·0.4·0.5value; human rankings",
    "3.14·2.71·1.62·0.58·9.81·7.23·6.54·8.76·5.43·4.32·2.10·1.23value",
    unsafe,
    '“<img src=x onerror=alert(1)>”tag <a href="javascript:alert(1)">JSON-RPC</a>',
  ];
  for (const text of corpus) {
    const paragraph = new JSDOM(
      `<p>${phraseHtml(text)}</p>`,
    ).window.document.querySelector("p");
    assert.equal(paragraph.textContent, text, text);
    assert.equal(paragraph.querySelectorAll("img,script,a").length, 0, text);
    assert.ok(
      [...paragraph.querySelectorAll(".source-phrase")].every(
        (span) => span.textContent.length <= 50,
      ),
    );
  }
  for (const [text] of attachments) {
    const document = new JSDOM(phraseHtml(text)).window.document;
    assert.ok(
      [...document.querySelectorAll(".source-phrase")].some(
        (span) => span.textContent === text,
      ),
      `whole attached token: ${text}`,
    );
  }
  const declined = new JSDOM(phraseHtml(overlong)).window.document;
  assert.equal(
    declined.querySelectorAll(".source-phrase").length,
    0,
    "decline a whole overlong attached token",
  );
  for (const token of [
    `JSON-${"RPC".repeat(20)}.2.0tag`,
    `80~${"90".repeat(30)}%rate`,
  ])
    assert.equal(
      new JSDOM(phraseHtml(token)).window.document.querySelectorAll(
        ".source-phrase",
      ).length,
      0,
      token,
    );
  const decimalText = corpus.find((text) => text.startsWith("3.14·"));
  const decimals = new JSDOM(
    `<p>${phraseHtml(decimalText)}</p>`,
  ).window.document.querySelector("p");
  for (const span of decimals.querySelectorAll(".source-phrase")) {
    const before = span.previousSibling?.textContent?.at(-1) ?? "";
    const after = span.nextSibling?.textContent?.[0] ?? "";
    assert.ok(!(/[0-9]/u.test(before) && span.textContent.startsWith(".")));
    assert.ok(
      !(/[0-9]/u.test(after) && span.textContent.endsWith(".")),
      "a group cannot end inside a decimal",
    );
  }
});

test("Chrome keeps source suffixes, numbers, heading attributions and limitations readable at line boundaries", {
  skip: !executablePath,
  timeout: 60000,
}, async (t) => {
  const f = await fixture({
    mutate(data) {
      data.report.title = heading;
      data.analysis.limitations = [limitation, unsafe];
      data.report.sections[0].blocks = [
        ...attachments.map(([text]) => text),
        longQuote,
      ].map((text) => ({
        type: "paragraph",
        statement: {
          text,
          attribution: "source",
          citations: [{ kind: "segment", id: "seg-000001" }],
        },
      }));
      data.report.sections[0].blocks.push({
        type: "diagram",
        id: "numeric-caption",
        kind: "stack",
        title: "Score comparison",
        alt: "Comparison of two scores",
        nodes: ["a", "b"].map((id) => ({
          id,
          label: "Score",
          sublabel: null,
          focal: false,
        })),
        edges: [],
        caption: {
          text: numericCaption,
          attribution: "source",
          citations: [{ kind: "segment", id: "seg-000001" }],
        },
      });
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const markdown = markdownDocument(f.bundle);
  const browser = await chromium.launch({ executablePath, headless: true, args: browserArgs() });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(htmlDocument(f.bundle));
  await page.evaluate(() => document.fonts.ready);
  const source = await page.locator("#limitations li").allTextContents();
  assert.ok(source.includes(limitation) && source.includes(unsafe));
  assert.equal(
    await page.locator("#limitations img, #limitations script").count(),
    0,
  );
  assert.equal(await page.evaluate(() => globalThis.injected), undefined);
  assert.ok(
    await page
      .locator("#limitations .source-phrase")
      .allTextContents()
      .then((texts) => texts.some((text) => text.includes("JSON-RPC 2.0"))),
  );
  const evidenceDir = process.env.TEST_RESPONSIVE_EVIDENCE_DIR;
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  const measurements = [];
  const failures = [];
  for (const width of [375, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const observed = await page.evaluate(
      ({ attachments }) => {
        const measure = (element, target) => {
          const start = element.textContent.indexOf(target),
            nodes = [];
          if (start < 0) return { text: target, error: "missing text" };
          const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
          );
          let offset = 0;
          while (walker.nextNode()) {
            nodes.push({ node: walker.currentNode, start: offset });
            offset += walker.currentNode.length;
          }
          const rects = [];
          for (let i = start; i < start + target.length; i++) {
            if (/\s/u.test(element.textContent[i])) continue;
            const item = nodes.findLast((entry) => entry.start <= i),
              range = document.createRange();
            range.setStart(item.node, i - item.start);
            range.setEnd(item.node, i - item.start + 1);
            const rect = range.getBoundingClientRect();
            rects.push({
              top: Math.round(rect.top),
              left: rect.left,
              right: rect.right,
            });
          }
          return {
            text: target,
            lines: [...new Set(rects.map((rect) => rect.top))],
            rects,
          };
        };
        const paragraphs = [
          ...document.querySelectorAll("#section-principles > p"),
        ];
        const observations = attachments.map(([target, base], index) => {
          const paragraph = paragraphs[index],
            spacer = document.createElement("span");
          paragraph.querySelector(".boundary-spacer")?.remove();
          const width = (text) => {
            const probe = document.createElement("span");
            probe.textContent = text;
            probe.style.cssText = "position:absolute;white-space:nowrap";
            paragraph.append(probe);
            const measured = probe.getBoundingClientRect().width;
            probe.remove();
            return measured;
          };
          const baseWidth = width(base);
          spacer.className = "boundary-spacer";
          spacer.setAttribute("aria-hidden", "true");
          spacer.style.cssText = `display:inline-block;width:${Math.max(0, paragraph.clientWidth - baseWidth - 1)}px`;
          paragraph.prepend(spacer);
          // A token wider than the line must wrap inside itself; its attached
          // ending (last word plus suffix) must still stay together. Font
          // metrics decide this, so it differs between platforms.
          if (width(target) > paragraph.clientWidth)
            return { ...measure(paragraph, target.split(/\s/u).at(-1)), wrapped: target };
          return measure(paragraph, target);
        });
        observations.push(measure(paragraphs.at(-1), "progress”note"));
        observations.push(
          measure(document.querySelector("h1"), "Ken Robinson's"),
        );
        const limit = [...document.querySelectorAll("#limitations li")].find(
          (e) => e.textContent.includes("JSON-RPC"),
        );
        observations.push(measure(limit, "JSON-RPC 2.0"));
        observations.push(
          measure(
            document.querySelector("#diagram-numeric-caption figcaption"),
            "0.5value",
          ),
        );
        return observations;
      },
      { attachments },
    );
    for (const result of observed)
      if (result.error || result.lines.length !== 1)
        failures.push(
          `${width}px ${result.text}: ${result.error || `${result.lines.length} glyph lines`}`,
        );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `${width}px overflow`,
    );
    measurements.push({ width, observations: observed });
    if (evidenceDir)
      await page.screenshot({
        path: path.join(evidenceDir, `attachments-${width}.png`),
        fullPage: true,
      });
  }
  if (evidenceDir)
    await writeFile(
      path.join(evidenceDir, "attachments-geometry.json"),
      JSON.stringify(measurements, null, 2),
    );
  assert.deepEqual(failures, [], failures.join("\n"));
  assert.equal(markdownDocument(f.bundle), markdown);
  for (const text of [limitation, ...attachments.map(([text]) => text)])
    assert.ok(markdown.includes(text));
  assert.ok(!markdown.includes("source-phrase"));
});
