import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { chromium } from "playwright-core";
import { fixture } from "../helpers.mjs";
import { htmlDocument } from "../../lib/rendering.mjs";
import { markdownDocument } from "../../lib/markdown.mjs";

const executablePath = process.env.TEST_BROWSER_EXECUTABLE;
const browserTest = { skip: !executablePath, timeout: 60000 };
const node = (id, label, sublabel = null) => ({
  id,
  label,
  sublabel,
  focal: false,
});
const caption = {
  text: "Every node and connector label must remain readable.",
  attribution: "interpretation",
  citations: [{ kind: "segment", id: "seg-000001" }],
};
const diagrams = [
  {
    type: "diagram",
    id: "parallel",
    kind: "flow",
    title: "Parallel flow",
    alt: "Input splits into two processing steps that merge into one result.",
    nodes: [
      node("a", "Input", "Source data"),
      node("b", "Left branch"),
      node("c", "Right branch"),
      node("d", "Result", "Full content"),
    ],
    edges: [
      { from: "a", to: "b", label: "Split" },
      { from: "a", to: "c", label: null },
      { from: "b", to: "d", label: null },
      { from: "c", to: "d", label: null },
    ],
    caption,
  },
  {
    type: "diagram",
    id: "skip",
    kind: "flow",
    title: "Flow with a shortcut",
    alt: "Three steps with a shortcut from the first to the last.",
    nodes: [
      node("a", "First step", "Input"),
      node("b", "Middle step"),
      node("c", "Last step", "Output"),
    ],
    edges: [
      { from: "a", to: "b", label: null },
      { from: "b", to: "c", label: null },
      { from: "a", to: "c", label: "Optional" },
    ],
    caption,
  },
  {
    type: "diagram",
    id: "stack",
    kind: "stack",
    title: "Layered structure",
    alt: "Top, middle, and bottom layers in order.",
    nodes: [
      node("a", "Top layer", "First detail"),
      node("b", "Middle layer"),
      node("c", "Bottom layer", "Last detail"),
    ],
    edges: [],
    caption,
  },
];

async function reportPage(t) {
  const f = await fixture({
    mutate(d) {
      d.report.sections[0].blocks = structuredClone(diagrams);
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(htmlDocument(f.bundle));
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function geometry(page) {
  return page.locator(".diagram-wrap").evaluateAll((wraps) =>
    wraps.map((wrap) => {
      const svg = wrap.querySelector("svg"),
        matrix = svg.getScreenCTM();
      return {
        id: wrap.closest("figure").id,
        canvas: svg.viewBox.baseVal.width,
        rendered: svg.getBoundingClientRect().width,
        viewport: wrap.clientWidth,
        content: wrap.scrollWidth,
        labels: [...svg.querySelectorAll("text")].map((label) => ({
          text: label.textContent,
          nominal: Number(label.getAttribute("font-size")),
          displayed: Number(label.getAttribute("font-size")) * matrix.a,
          glyphHeight: label.getBBox().height * matrix.d,
          left: label.getBBox().x,
          right: label.getBBox().x + label.getBBox().width,
        })),
      };
    }),
  );
}

async function scrollToEdge(page, wrap, direction) {
  for (let step = 0; step < 30; step++) {
    const before = await wrap.evaluate((e) => ({
      left: e.scrollLeft,
      max: e.scrollWidth - e.clientWidth,
    }));
    const remaining = direction > 0 ? before.max - before.left : before.left;
    if (remaining <= 1) return;
    await page.keyboard.press(direction > 0 ? "ArrowRight" : "ArrowLeft");
    // Native key-scroll distance/animation varies by OS; require movement, not a
    // particular number of CSS pixels, and let that key's animation finish.
    await page.waitForFunction(
      ({ id, before, direction }) => {
        const e = document.querySelector(`#${id} .diagram-wrap`);
        return direction > 0
          ? e.scrollLeft > before.left + 0.5
          : e.scrollLeft < before.left - 0.5;
      },
      {
        id: await wrap.evaluate((e) => e.closest("figure").id),
        before,
        direction,
      },
    );
    await wrap.evaluate(
      (e) =>
        new Promise((resolve) => {
          let previous = e.scrollLeft,
            stable = 0;
          const sample = () => {
            const current = e.scrollLeft;
            stable = Math.abs(current - previous) < 0.1 ? stable + 1 : 0;
            previous = current;
            if (stable >= 4) resolve();
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }),
    );
  }
  assert.fail("native arrow keys did not reach the diagram edge");
}

// Native keyboard scrolling across multiple diagrams and viewport sizes can be
// substantially slower on a busy hosted macOS runner; keep every assertion.
test("mobile diagrams retain readable label size and their full canvas inside a keyboard scroll viewport", {
  ...browserTest,
  timeout: 120000,
}, async (t) => {
  const page = await reportPage(t);
  for (const width of [375, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const measurements = await geometry(page);
    for (const diagram of measurements) {
      assert.ok(
        Math.abs(diagram.rendered - diagram.canvas) < 1,
        `${diagram.id} at ${width}px shrinks its ${diagram.canvas}-unit canvas to ${diagram.rendered}px`,
      );
      for (const label of diagram.labels) {
        assert.ok(
          label.displayed >= label.nominal - 0.01,
          `${diagram.id} label ${label.text}: ${label.displayed}px displayed, ${label.nominal}px required`,
        );
        assert.ok(
          label.glyphHeight > 8,
          `${diagram.id} glyphs are visibly reduced`,
        );
        assert.ok(
          label.left >= 0 && label.right <= diagram.canvas,
          `${diagram.id} label ${label.text} extends outside the ${diagram.canvas}-unit canvas: ${label.left}–${label.right}`,
        );
      }
      const wrap = page.locator(`#${diagram.id} .diagram-wrap`);
      await wrap.scrollIntoViewIfNeeded();
      await wrap.focus();
      assert.equal(
        await wrap.evaluate((e) => e === document.activeElement),
        true,
      );
      assert.ok(
        await wrap.getAttribute("aria-labelledby"),
        "scroll viewport has an accessible name",
      );
      if (diagram.content > diagram.viewport) {
        await scrollToEdge(page, wrap, 1);
        assert.equal(
          await wrap.evaluate((e) => {
            const svg = e.querySelector("svg").getBoundingClientRect();
            return svg.right <= e.getBoundingClientRect().right + 1;
          }),
          true,
          "keyboard reaches the rightmost canvas content",
        );
        await scrollToEdge(page, wrap, -1);
        assert.ok(
          await wrap.evaluate((e) => e.scrollLeft <= 1),
          "keyboard returns to the first canvas content",
        );
      }
    }
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `diagram local scrolling must not overflow the ${width}px document`,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addStyleTag({
    content:
      ".diagram-wrap svg { width:100% !important; max-width:640px !important; }",
  });
  const regressed = await geometry(page);
  assert.ok(
    regressed.every((d) => d.labels.some((l) => l.displayed < 9)),
    "the old width rule reproduces unreadable labels",
  );
});

test(
  "source names and English phrases keep their glyphs together across headings, prose and captions",
  browserTest,
  async (t) => {
    const headings = [
      "2. Transformers: represent, learn and execute",
      "8. AGI: acts·mind·goals are different questions",
      "4. Practice: Software 2.0 and the data engine",
    ];
    const samples = [
      ["A2A's host at recording time: Linux Foundation.", "Linux Foundation"],
      [
        "The remote agent publishes a connection document: Agent Card.",
        "Agent Card",
      ],
      ["Data format: JSON-RPC 2.0. Transport: HTTPS.", "JSON-RPC 2.0"],
      [
        "Card discovery, identity checks, and authorization are separate: do not conflate them.",
        "do not conflate them.",
      ],
      ["Journey span: 40 orders of magnitude.", "40 orders of magnitude."],
      ["이 방식은 적용할 수 있습니다.", "적용할 수 있습니다."],
      ["계속 진행하면 안 됩니다.", "진행하면 안 됩니다."],
      ["예술가가 되자, 지금 당장.", "지금 당장."],
      [
        "안무가 질리언 린(Gillian Lynne)의 사례입니다.",
        "질리언 린(Gillian Lynne)의",
      ],
      [
        "These frames were sampled, not exhaustive: not every scene was verified.",
        "not every scene was verified.",
      ],
      [
        "Individuality means different talents and discovery paths. The example is a choreographer: Gillian Lynne.",
        "Gillian Lynne.",
      ],
    ];
    const captionText =
      "Between the two columns: authentication and authorization; Send Task; Request More Info; Return Additional Info; Send Final Response and Artifact. On the right: Process Task. The original frame shows: 100,000 light years.";
    const unsafe =
      '<img src=x onerror="globalThis.injected=true"> <script>globalThis.injected=true</script> Linux Foundation';
    const f = await fixture({
      mutate(d) {
        d.report.title =
          "Become an artist, right now — Young-ha Kim on creative play";
        d.report.sections = headings.map((heading, index) => ({
          id: `phrases-${index}`,
          heading,
          blocks: [
            {
              type: "paragraph",
              statement: {
                text: "Preserve the source text.",
                attribution: "source",
                citations: caption.citations,
              },
            },
          ],
        }));
        d.report.sections[0].blocks = samples.map(([text]) => ({
          type: "paragraph",
          statement: {
            text,
            attribution: "source",
            citations: caption.citations,
          },
        }));
        d.report.sections[0].blocks.push({
          ...structuredClone(diagrams[2]),
          caption: { ...caption, text: captionText },
        });
        d.report.sections[0].blocks.push({
          type: "paragraph",
          statement: {
            text: unsafe,
            attribution: "source",
            citations: caption.citations,
          },
        });
        d.report.sections[0].blocks.push({
          type: "paragraph",
          statement: {
            text: `“${"W".repeat(48)}”`,
            attribution: "source",
            citations: caption.citations,
          },
        });
      },
    });
    t.after(() => rm(f.root, { recursive: true, force: true }));
    const markdown = markdownDocument(f.bundle);
    const browser = await chromium.launch({ executablePath, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(htmlDocument(f.bundle));
    const checks = [
      ["h1", "right now"],
      ["#section-phrases-0 h2", "learn and execute"],
      ["#section-phrases-1 h2", "acts·mind·goals"],
      ["#section-phrases-2 h2", "Software 2.0"],
      ...samples.map(([, phrase], index) => [
        `#section-phrases-0 > p:nth-of-type(${index + 1})`,
        phrase,
      ]),
      ...[
        "Request More Info",
        "Send Final Response and Artifact",
        "Process Task",
        "100,000 light years",
      ].map((phrase) => ["#section-phrases-0 figcaption", phrase]),
    ];
    const failures = [];
    for (const width of [375, 390, 768]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [selector, phrase] of checks) {
        const lines = await page
          .locator(selector)
          .evaluate((element, phrase) => {
            const start = element.textContent.indexOf(phrase),
              nodes = [];
            const walker = document.createTreeWalker(
              element,
              NodeFilter.SHOW_TEXT,
            );
            let offset = 0;
            while (walker.nextNode()) {
              nodes.push({ node: walker.currentNode, start: offset });
              offset += walker.currentNode.length;
            }
            const tops = new Set();
            for (let index = start; index < start + phrase.length; index++) {
              const current = nodes.findLast((item) => item.start <= index);
              const range = document.createRange();
              range.setStart(current.node, index - current.start);
              range.setEnd(current.node, index - current.start + 1);
              tops.add(Math.round(range.getBoundingClientRect().top));
            }
            return [...tops];
          }, phrase);
        if (lines.length !== 1)
          failures.push(`${width}px ${phrase}: ${lines.length} glyph lines`);
      }
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    }
    assert.deepEqual(failures, [], failures.join("\n"));
    assert.equal(
      await page
        .locator("#section-phrases-0 img, #section-phrases-0 script")
        .count(),
      0,
    );
    assert.equal(await page.evaluate(() => globalThis.injected), undefined);
    for (const [index, [text]] of samples.entries())
      assert.ok(
        (
          await page
            .locator(`#section-phrases-0 > p:nth-of-type(${index + 1})`)
            .textContent()
        ).startsWith(text),
      );
    assert.ok(
      await page
        .locator("#section-phrases-0 > p")
        .last()
        .locator(".source-phrase")
        .evaluate((span) => {
          const range = document.createRange();
          range.selectNodeContents(span);
          return (
            range.getClientRects().length > 1 && span.textContent.length === 50
          );
        }),
      "overwide groups wrap internally with their complete text visible",
    );
    assert.equal(markdownDocument(f.bundle), markdown);
    assert.ok(
      markdown.includes("Linux Foundation") &&
        !markdown.includes("source-phrase"),
    );
  },
);

test(
  "narrow English and Korean headings balance their lines without stranding short endings",
  browserTest,
  async (t) => {
    const page = await reportPage(t);
    const headings = [
      "How document generators become assistants",
      "The meaning of a bright dot can change",
      "The stigma of mistakes reduces experimentation",
      "Do not mine children's imagination",
      "문서 생성기는 어떻게 조수가 되는가",
      "밝은 점 하나의 의미는 달라질 수 있습니다",
    ];
    await page.locator("main").evaluate((main, headings) => {
      main.replaceChildren(
        ...headings.map((heading) => {
          const h2 = document.createElement("h2");
          h2.textContent = heading;
          return h2;
        }),
      );
    }, headings);
    for (const width of [375, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const lines = await page.locator("main h2").evaluateAll((elements) =>
        elements.map((element) => {
          const text = element.firstChild,
            groups = new Map();
          for (let start = 0; start < text.length; start++) {
            const range = document.createRange();
            range.setStart(text, start);
            range.setEnd(text, start + 1);
            const top = range.getBoundingClientRect().top;
            groups.set(top, (groups.get(top) ?? "") + text.textContent[start]);
          }
          return [...groups.values()]
            .map((line) => line.trim())
            .filter(Boolean);
        }),
      );
      for (const [index, line] of lines.entries()) {
        assert.ok(
          line.length === 1 || line.at(-1).includes(" "),
          `${width}px heading strands its ending: ${headings[index]} -> ${line.join(" / ")}`,
        );
      }
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    }
  },
);
