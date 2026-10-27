import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { chromium } from "playwright-core";
import { fixture } from "../helpers.mjs";
import { htmlDocument } from "../../lib/rendering.mjs";
import { markdownDocument } from "../../lib/markdown.mjs";

const executablePath = process.env.TEST_BROWSER_EXECUTABLE;
const browserTest = { skip: !executablePath, timeout: 60000 };
const node = (id, label, sublabel = null) => ({ id, label, sublabel, focal: false });
const caption = {
  text: "노드와 연결선의 전체 내용을 읽을 수 있어야 합니다.",
  attribution: "interpretation",
  citations: [{ kind: "segment", id: "seg-000001" }],
};
const diagrams = [
  {
    type: "diagram", id: "parallel", kind: "flow", title: "병렬 흐름",
    alt: "입력에서 두 처리 단계로 나뉜 후 결과로 합류합니다.",
    nodes: [node("a", "입력", "원본 자료"), node("b", "왼쪽 처리"), node("c", "오른쪽 처리"), node("d", "결과", "전체 내용")],
    edges: [{ from: "a", to: "b", label: "분기" }, { from: "a", to: "c", label: null }, { from: "b", to: "d", label: null }, { from: "c", to: "d", label: null }],
    caption,
  },
  {
    type: "diagram", id: "skip", kind: "flow", title: "단계 생략 흐름",
    alt: "세 단계의 흐름과 첫 단계에서 마지막 단계로 연결되는 우회선입니다.",
    nodes: [node("a", "첫 단계", "입력"), node("b", "가운데 단계"), node("c", "마지막 단계", "출력")],
    edges: [{ from: "a", to: "b", label: null }, { from: "b", to: "c", label: null }, { from: "a", to: "c", label: "선택" }],
    caption,
  },
  {
    type: "diagram", id: "stack", kind: "stack", title: "계층 구조",
    alt: "상위, 중간, 하위 계층 순서입니다.",
    nodes: [node("a", "상위 계층", "첫 번째 설명"), node("b", "중간 계층"), node("c", "하위 계층", "마지막 설명")],
    edges: [], caption,
  },
];

async function reportPage(t) {
  const f = await fixture({ mutate(d) { d.report.sections[0].blocks = structuredClone(diagrams); } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(htmlDocument(f.bundle));
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function geometry(page) {
  return page.locator(".diagram-wrap").evaluateAll((wraps) => wraps.map((wrap) => {
    const svg = wrap.querySelector("svg"), matrix = svg.getScreenCTM();
    return {
      id: wrap.closest("figure").id, canvas: svg.viewBox.baseVal.width,
      rendered: svg.getBoundingClientRect().width,
      viewport: wrap.clientWidth, content: wrap.scrollWidth,
      labels: [...svg.querySelectorAll("text")].map((label) => ({
        text: label.textContent, nominal: Number(label.getAttribute("font-size")),
        displayed: Number(label.getAttribute("font-size")) * matrix.a,
        glyphHeight: label.getBBox().height * matrix.d,
        left: label.getBBox().x, right: label.getBBox().x + label.getBBox().width,
      })),
    };
  }));
}

async function scrollToEdge(page, wrap, direction) {
  for (let step = 0; step < 30; step++) {
    const before = await wrap.evaluate((e) => ({ left: e.scrollLeft, max: e.scrollWidth - e.clientWidth }));
    const remaining = direction > 0 ? before.max - before.left : before.left;
    if (remaining <= 1) return;
    await page.keyboard.press(direction > 0 ? "ArrowRight" : "ArrowLeft");
    await page.waitForFunction(({ id, before, direction }) => {
      const e = document.querySelector(`#${id} .diagram-wrap`);
      return direction > 0
        ? e.scrollLeft >= Math.min(before.left + 30, before.max) - 1
        : e.scrollLeft <= Math.max(before.left - 30, 0) + 1;
    }, { id: await wrap.evaluate((e) => e.closest("figure").id), before, direction });
  }
  assert.fail("native arrow keys did not reach the diagram edge");
}

test("mobile diagrams retain readable label size and their full canvas inside a keyboard scroll viewport", browserTest, async (t) => {
  const page = await reportPage(t);
  for (const width of [375, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const measurements = await geometry(page);
    for (const diagram of measurements) {
      assert.ok(Math.abs(diagram.rendered - diagram.canvas) < 1,
        `${diagram.id} at ${width}px shrinks its ${diagram.canvas}-unit canvas to ${diagram.rendered}px`);
      for (const label of diagram.labels) {
        assert.ok(label.displayed >= label.nominal - 0.01,
          `${diagram.id} label ${label.text}: ${label.displayed}px displayed, ${label.nominal}px required`);
        assert.ok(label.glyphHeight > 8, `${diagram.id} glyphs are visibly reduced`);
        assert.ok(label.left >= 0 && label.right <= diagram.canvas,
          `${diagram.id} label ${label.text} extends outside the ${diagram.canvas}-unit canvas: ${label.left}–${label.right}`);
      }
      const wrap = page.locator(`#${diagram.id} .diagram-wrap`);
      await wrap.focus();
      assert.equal(await wrap.evaluate((e) => e === document.activeElement), true);
      assert.ok(await wrap.getAttribute("aria-labelledby"), "scroll viewport has an accessible name");
      if (diagram.content > diagram.viewport) {
        await scrollToEdge(page, wrap, 1);
        assert.equal(await wrap.evaluate((e) => {
          const svg = e.querySelector("svg").getBoundingClientRect();
          return svg.right <= e.getBoundingClientRect().right + 1;
        }), true, "keyboard reaches the rightmost canvas content");
        await scrollToEdge(page, wrap, -1);
        assert.ok(await wrap.evaluate((e) => e.scrollLeft <= 1), "keyboard returns to the first canvas content");
      }
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      `diagram local scrolling must not overflow the ${width}px document`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addStyleTag({ content: ".diagram-wrap svg { width:100% !important; max-width:640px !important; }" });
  const regressed = await geometry(page);
  assert.ok(regressed.every((d) => d.labels.some((l) => l.displayed < 9)), "the old width rule reproduces unreadable labels");
});

test("source names and Korean dependent phrases keep their glyphs together across headings, prose and captions", browserTest, async (t) => {
  const headings = [
    "2. 트랜스포머: 표현할 수 있고, 배울 수 있고, 실행할 수 있어야 한다",
    "8. AGI의 가능성과 위험: 행동·의식·목표는 다른 질문이다",
    "4. 실무의 핵심: Software 2.0과 데이터 엔진",
  ];
  const samples = [
    ["A2A는 영상 시점에는 Linux Foundation에 속한 오픈소스다.", "Linux Foundation"],
    ["클라이언트가 접속 조건을 확인하기 위해 원격 에이전트는 Agent Card를 게시한다.", "Agent Card"],
    ["영상은 데이터 교환 형식으로 JSON-RPC 2.0을, 전송 경로로 HTTPS를 제시한다.", "JSON-RPC 2.0"],
    ["따라서 카드 발견, 신원 확인, 권한 부여를 하나의 사건으로 뭉뚱그려 읽어서는 안 된다.", "읽어서는 안 된다."],
    ["여행 전체가 10의 거듭제곱 40단계를 가로질렀다는 것이다.", "가로질렀다는 것이다."],
    ["그림은 승인된 저해상도 영상에서 뽑은 표본이므로 표본 사이의 모든 장면을 검증한 것은 아니다.", "검증한 것은 아니다."],
    ["개별성: 재능의 모습과 그것을 발견하는 경로는 사람마다 다르다. 그는 이를 설명하기 위해 안무가 질리언 린(Gillian Lynne)의 이야기를 든다.", "질리언 린(Gillian Lynne)의"],
  ];
  const captionText = "두 세로 상자 사이에 인증과 인가, Send Task, Request More Info, Return Additional Info, Send Final Response and Artifact가 표시되어 있다. 원격 오른쪽에는 Process Task 구간이 그려져 있다. 원본 장면에는 100,000 light years가 표시돼 있다.";
  const unsafe = '<img src=x onerror="globalThis.injected=true"> <script>globalThis.injected=true</script> Linux Foundation';
  const f = await fixture({ mutate(d) {
    d.report.title = "예술가가 되자, 지금 당장 — 김영하의 창작 놀이 회복론";
    d.report.sections = headings.map((heading, index) => ({ id: `phrases-${index}`, heading, blocks: [{ type: "paragraph", statement: { text: "원문을 보존합니다.", attribution: "source", citations: caption.citations } }] }));
    d.report.sections[0].blocks = samples.map(([text]) => ({ type: "paragraph", statement: { text, attribution: "source", citations: caption.citations } }));
    d.report.sections[0].blocks.push({ ...structuredClone(diagrams[2]), caption: { ...caption, text: captionText } });
    d.report.sections[0].blocks.push({ type: "paragraph", statement: { text: unsafe, attribution: "source", citations: caption.citations } });
    d.report.sections[0].blocks.push({ type: "paragraph", statement: { text: `“${"W".repeat(48)}”`, attribution: "source", citations: caption.citations } });
  } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const markdown = markdownDocument(f.bundle);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(htmlDocument(f.bundle));
  const checks = [
    ["h1", "지금 당장"], ["#section-phrases-0 h2", "배울 수 있고"],
    ["#section-phrases-1 h2", "행동·의식·목표는"], ["#section-phrases-2 h2", "Software 2.0과"],
    ...samples.map(([, phrase], index) => [`#section-phrases-0 > p:nth-of-type(${index + 1})`, phrase]),
    ...["Request More Info", "Send Final Response and Artifact", "Process Task", "100,000 light years"].map((phrase) => ["#section-phrases-0 figcaption", phrase]),
  ];
  const failures = [];
  for (const width of [375, 390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [selector, phrase] of checks) {
      const lines = await page.locator(selector).evaluate((element, phrase) => {
        const start = element.textContent.indexOf(phrase), nodes = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let offset = 0;
        while (walker.nextNode()) { nodes.push({ node: walker.currentNode, start: offset }); offset += walker.currentNode.length; }
        const tops = new Set();
        for (let index = start; index < start + phrase.length; index++) {
          const current = nodes.findLast((item) => item.start <= index);
          const range = document.createRange();
          range.setStart(current.node, index - current.start); range.setEnd(current.node, index - current.start + 1);
          tops.add(Math.round(range.getBoundingClientRect().top));
        }
        return [...tops];
      }, phrase);
      if (lines.length !== 1) failures.push(`${width}px ${phrase}: ${lines.length} glyph lines`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
  assert.equal(await page.locator("#section-phrases-0 img, #section-phrases-0 script").count(), 0);
  assert.equal(await page.evaluate(() => globalThis.injected), undefined);
  for (const [index, [text]] of samples.entries())
    assert.ok((await page.locator(`#section-phrases-0 > p:nth-of-type(${index + 1})`).textContent()).startsWith(text));
  assert.ok(await page.locator("#section-phrases-0 > p").last().locator(".source-phrase").evaluate((span) => {
    const range = document.createRange(); range.selectNodeContents(span);
    return range.getClientRects().length > 1 && span.textContent.length === 50;
  }), "overwide groups wrap internally with their complete text visible");
  assert.equal(markdownDocument(f.bundle), markdown);
  assert.ok(markdown.includes("Linux Foundation") && !markdown.includes("source-phrase"));
});

test("narrow Korean headings balance their lines without stranding short semantic endings", browserTest, async (t) => {
  const page = await reportPage(t);
  const headings = [
    "문서 생성기를 조력자로 바꾸는 기제",
    "빛나는 점의 의미도 달라진다",
    "실수의 낙인이 시도를 줄인다",
    "아이들의 상상력을 채굴하지 말 것",
  ];
  await page.locator("main").evaluate((main, headings) => {
    main.replaceChildren(...headings.map((heading) => {
      const h2 = document.createElement("h2"); h2.textContent = heading; return h2;
    }));
  }, headings);
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const lines = await page.locator("main h2").evaluateAll((elements) => elements.map((element) => {
      const text = element.firstChild, groups = new Map();
      for (let start = 0; start < text.length; start++) {
        const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + 1);
        const top = range.getBoundingClientRect().top;
        groups.set(top, (groups.get(top) ?? "") + text.textContent[start]);
      }
      return [...groups.values()].map((line) => line.trim()).filter(Boolean);
    }));
    for (const [index, line] of lines.entries()) {
      assert.ok(line.length === 1 || line.at(-1).includes(" "),
        `${width}px heading strands its ending: ${headings[index]} -> ${line.join(" / ")}`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
});
