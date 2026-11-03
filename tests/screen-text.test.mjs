import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fixture } from "./helpers.mjs";
import { htmlDocument } from "../lib/rendering.mjs";
import { markdownDocument } from "../lib/markdown.mjs";

// A figure whose on-screen text is shown beside its translation.
function withFigure(screenText) {
  return {
    mutate(d) {
      d.evidence.frames = [
        {
          id: "frame-0001",
          timestampMs: 1000,
          assetPath: "assets/frame-0001.jpg",
          sha256: "0".repeat(64),
          width: 320,
          height: 180,
          ocrText: null,
        },
      ];
      d.analysis.inspectedFrameIds = ["frame-0001"];
      d.request.outputLanguage = "ko";
      d.report.outputLanguage = "ko";
      d.report.sections[0].blocks.push({
        type: "figure",
        frameId: "frame-0001",
        alt: "Slide titled What's a derivative?",
        caption: {
          text: "슬라이드는 도함수를 고차 함수로 정의한다.",
          attribution: "source",
          citations: [{ kind: "frame", id: "frame-0001" }],
        },
        ...(screenText === undefined ? {} : { screenText }),
      });
    },
  };
}
const LINES = [
  { text: "What's a derivative?", translation: "도함수란 무엇인가?" },
  { text: "a | b <script>x</script>", translation: "a | b *강조* 아님" },
];

test("on-screen text renders beside its translation under the figure, escaped, in HTML and Markdown", async () => {
  const f = await fixture(withFigure(LINES));
  try {
    const html = htmlDocument(f.bundle);
    const table = html.match(
      /<table class="screen-text">[\s\S]*?<\/table>/,
    )?.[0];
    assert.ok(table, "the table follows the figure");
    assert.ok(
      html.indexOf(table) > html.indexOf('id="frame-frame-0001"'),
      "inside the figure it was read from",
    );
    assert.match(
      table,
      /<th scope="col">On-screen text<\/th><th scope="col">Translation<\/th>/,
    );
    assert.match(
      table,
      /<td>What&#x27;s a derivative\?<\/td><td>도함수란 무엇인가\?<\/td>/,
    );
    assert.ok(!table.includes("<script>"), "screen text is escaped");
    assert.match(table, /&lt;script&gt;x&lt;\/script&gt;/);
    const markdown = markdownDocument(f.bundle);
    assert.match(markdown, /\| On-screen text +\| Translation +\|/);
    assert.match(
      markdown,
      /\| What's a derivative\? +\| 도함수란 무엇인가\? +\|/,
    );
    // A pipe inside a cell stays inside it, and Markdown emphasis is literal text.
    assert.match(markdown, /a \\\| b/);
    assert.match(markdown, /\\\*강조\\\*/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a figure without on-screen text has no table", async () => {
  const f = await fixture(withFigure(undefined));
  try {
    assert.ok(!htmlDocument(f.bundle).includes('class="screen-text"'));
    assert.ok(!markdownDocument(f.bundle).includes("On-screen text"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("on-screen text lines need both sides, no extra fields and at most 40 lines", async () => {
  for (const bad of [
    [],
    [{ text: "Only original" }],
    [{ text: "", translation: "빈 원문" }],
    [{ text: "Original", translation: "" }],
    [{ text: "Original", translation: "번역", note: "extra" }],
    Array.from({ length: 41 }, (_, i) => ({
      text: `Line ${i}`,
      translation: `줄 ${i}`,
    })),
  ])
    await assert.rejects(
      fixture(withFigure(bad)),
      { code: "INVALID_CONTRACT" },
      JSON.stringify(bad).slice(0, 80),
    );
});

// Positioned lines: drawn over a copy of the frame beside the original.
const BOXED = [
  {
    text: "Efficiency of composition",
    translation: "합성의 효율",
    box: { x: 0.15, y: 0.05, w: 0.32, h: 0.06 },
    background: "#eaeaea",
  },
  {
    text: "• Arrow composition is associative.",
    translation: "• 화살표 <b>합성</b>은 결합법칙을 만족한다.",
    box: { x: 0.166, y: 0.228, w: 0.359, h: 0.044 },
    background: "#eaeaea",
  },
  {
    text: "• RAD is much better for gradient-based optimization.",
    translation: "• 경사 기반 최적화에는 RAD가 훨씬 낫다.",
    box: { x: 0.166, y: 0.8, w: 0.553, h: 0.044 },
    background: "#101820",
  },
];

test("positioned on-screen text draws the translation over a copy of the frame beside the original", async () => {
  const f = await fixture(withFigure(BOXED));
  try {
    const html = htmlDocument(f.bundle);
    const figure = html.match(
      /<figure class="screen-figure"[\s\S]*?<\/figure>/,
    )?.[0];
    assert.ok(figure, "a side-by-side figure");
    assert.equal(
      (figure.match(/<img /g) ?? []).length,
      2,
      "original and translated copy",
    );
    assert.match(
      figure,
      /<img src="assets\/frame-0001.jpg" alt="Slide titled What&#x27;s a derivative\?"/,
    );
    assert.match(figure, /<img src="assets\/frame-0001.jpg" alt=""/);
    assert.match(figure, />Original</);
    assert.match(figure, />Translated</);
    const spans = [
      ...figure.matchAll(
        /<span style="([^"]*)">([^<]*(?:&lt;[^<]*)*)<\/span>/g,
      ),
    ];
    assert.equal(spans.length, 3);
    assert.match(
      spans[0][1],
      /^left:13\.80%;top:4\.20%;min-width:34\.40%;max-width:\d+\.\d+%;height:7\.60%;font-size:\d+\.\d+cqw;background:#eaeaea;color:#1f2430$/,
    );
    assert.match(
      spans[2][1],
      /background:#101820;color:#f5f5f2$/,
      "light text on a dark slide",
    );
    assert.ok(!figure.includes("<b>"), "translations are escaped");
    assert.match(figure, /&lt;b&gt;합성&lt;\/b&gt;/);
    // Bullets of one height share a size; the taller title keeps its own.
    const size = (span) => Number(/font-size:([\d.]+)cqw/.exec(span[1])[1]);
    assert.equal(size(spans[1]), size(spans[2]));
    assert.ok(size(spans[0]) > size(spans[1]));
    assert.match(
      figure,
      /<details class="screen-text-list"><summary>On-screen text<\/summary><table class="screen-text">/,
    );
    // Markdown cannot draw over an image: the same lines stay a table.
    assert.match(
      markdownDocument(f.bundle),
      /\| Efficiency of composition +\| 합성의 효율 +\|/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("positioned lines are all-or-none, stay inside the frame and use a lowercase hex background", async () => {
  const [boxed, plain] = [BOXED[0], LINES[0]];
  for (const bad of [
    [boxed, plain],
    [{ ...plain, background: "#ffffff" }],
    [{ ...boxed, box: { ...boxed.box, x: 0.9, w: 0.2 } }],
    [{ ...boxed, box: { ...boxed.box, h: 0 } }],
    [{ ...boxed, background: "#FFF" }],
    [{ ...boxed, background: "red" }],
    [{ ...boxed, box: { ...boxed.box, z: 1 } }],
  ])
    await assert.rejects(
      fixture(withFigure(bad)),
      { code: "INVALID_CONTRACT" },
      JSON.stringify(bad).slice(0, 120),
    );
  // Without a background the copy is drawn on white.
  const f = await fixture(withFigure([{ ...boxed, background: undefined }]));
  try {
    assert.match(htmlDocument(f.bundle), /background:#ffffff;color:#1f2430/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
