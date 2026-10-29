import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fixture } from "./helpers.mjs";
import { htmlDocument } from "../lib/rendering.mjs";
import { markdownDocument } from "../lib/markdown.mjs";
import * as diagramModule from "../lib/diagram.mjs";
const { diagramSvg, diagramText, layerFlow } = diagramModule;

const cite = [{ kind: "segment", id: "seg-000001" }];
const caption = {
  text: "A diagram interpreting the speaker's causal explanation.",
  attribution: "interpretation",
  citations: cite,
};
const node = (id, label, extra = {}) => ({
  id,
  label,
  sublabel: null,
  focal: false,
  ...extra,
});
const flow = () => ({
  type: "diagram",
  kind: "flow",
  id: "cause",
  title: "Causal chain",
  alt: "A causal chain from industrialism to lost creativity",
  nodes: [
    node("a", "Industrial demand", { focal: true }),
    node("b", "Useful subjects first"),
    node("c", "University self-copy"),
    node("d", "Intelligence = academics"),
    node("e", "Talent stigma <script>"),
  ],
  edges: [
    { from: "a", to: "b", label: null },
    { from: "a", to: "c", label: "Design" },
    { from: "b", to: "d", label: null },
    { from: "c", to: "d", label: null },
    { from: "d", to: "e", label: null },
  ],
  caption,
});
const stack = () => ({
  type: "diagram",
  kind: "stack",
  id: "rank",
  title: "Subject hierarchy",
  alt: "Math and languages above the arts",
  nodes: [
    node("top", "Math · languages"),
    node("mid", "Humanities"),
    node("low", "Arts", { sublabel: "Art/music > drama/dance", focal: true }),
  ],
  edges: [],
  caption,
});
async function withBlock(block, t) {
  const f = await fixture({
    mutate(d) {
      d.report.sections[0].blocks.push(block);
    },
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  return f;
}

test("flow and stack diagrams render deterministic, escaped, orthogonal SVG with a11y title/desc", async (t) => {
  const f = await withBlock(flow(), t);
  const html = htmlDocument(f.bundle);
  assert.ok(html.includes('<figure class="diagram" id="diagram-cause">'));
  assert.ok(html.includes('aria-labelledby="dg-cause-title dg-cause-desc"'));
  assert.ok(
    html.includes("Talent stigma &lt;script&gt;") &&
      !html.includes("stigma <script>"),
  );
  const svg = diagramSvg(flow());
  const paths = [...svg.matchAll(/<path d="([^"]+)" fill="none"/g)].map(
    (m) => m[1],
  );
  assert.equal(paths.length, 5);
  for (const d of paths)
    assert.doesNotMatch(
      d,
      /L/,
      "connectors are V/H/Q only, no diagonal L segments",
    );
  assert.ok(
    svg.indexOf("<path d=") < svg.indexOf('<rect x="') ||
      svg.indexOf('fill="none"') < svg.indexOf("<text"),
    "edges are drawn before node boxes",
  );
  assert.equal(
    (svg.match(/stroke="#b5382b"/g) ?? []).length,
    1,
    "one focal node",
  );
  assert.equal(diagramSvg(flow()), svg, "deterministic");
  assert.deepEqual(
    layerFlow(flow().nodes, flow().edges).map((r) => r.map((n) => n.id)),
    [["a"], ["b", "c"], ["d"], ["e"]],
  );
  const stackSvg = diagramSvg(stack());
  assert.ok(
    stackSvg.includes("Art/music &gt; drama/dance") &&
      !stackSvg.includes("<path d="),
  );
});

test("Markdown exports the diagram as structured text, not an image or raw SVG", async (t) => {
  const f = await withBlock(flow(), t);
  const md = markdownDocument(f.bundle);
  assert.ok(md.includes("**Causal chain**"));
  assert.match(md, /- Industrial demand(?:\r?\n|$)/);
  assert.ok(md.includes("Industrial demand → University self-copy (Design)"));
  assert.ok(!md.includes("<svg"));
  assert.deepEqual(diagramText(stack()), [
    "Math · languages",
    "Humanities",
    "Arts — Art/music > drama/dance",
  ]);
  const stackFixture = await withBlock(stack(), t);
  const stackMarkdown = markdownDocument(stackFixture.bundle);
  assert.match(stackMarkdown, /1\. Math · languages/);
  assert.match(stackMarkdown, /2\. Humanities/);
  assert.match(stackMarkdown, /3\. Arts — Art\/music > drama\/dance/);
  assert.doesNotMatch(stackMarkdown, /\d\. \d\\?\./);
});

test("diagram contract rejects unknown refs, cycles, isolated nodes, >2 focal, stack edges and extras", async () => {
  const cases = [
    [
      "unknown node",
      (b) => {
        b.edges[0].to = "zzz";
      },
      "INVALID_REFERENCE",
    ],
    [
      "self loop",
      (b) => {
        b.edges[0].to = "a";
      },
      "INVALID_REFERENCE",
    ],
    [
      "cycle",
      (b) => {
        b.edges.push({ from: "e", to: "a", label: null });
      },
      "INVALID_CONTRACT",
    ],
    [
      "isolated node",
      (b) => {
        b.nodes.push(node("f", "Isolated"));
      },
      "INVALID_CONTRACT",
    ],
    [
      "three focal",
      (b) => {
        b.nodes[1].focal = true;
        b.nodes[2].focal = true;
      },
      "INVALID_CONTRACT",
    ],
    [
      "duplicate node id",
      (b) => {
        b.nodes[1].id = "a";
      },
      "INVALID_CONTRACT",
    ],
    [
      "duplicate edge",
      (b) => {
        b.edges.push({ ...b.edges[0] });
      },
      "INVALID_CONTRACT",
    ],
    [
      "stack with edges",
      (b) => {
        b.kind = "stack";
      },
      "INVALID_CONTRACT",
    ],
    [
      "flow without edges",
      (b) => {
        b.edges = [];
      },
      "INVALID_CONTRACT",
    ],
    [
      "extra field",
      (b) => {
        b.svg = "<svg/>";
      },
      "INVALID_CONTRACT",
    ],
    [
      "long edge label",
      (b) => {
        b.edges[1].label = "x".repeat(15);
      },
      "INVALID_CONTRACT",
    ],
    [
      "too many nodes",
      (b) => {
        for (let i = 0; i < 5; i++) {
          b.nodes.push(node(`n${i}`, `n${i}`));
          b.edges.push({ from: "e", to: `n${i}`, label: null });
        }
      },
      "INVALID_CONTRACT",
    ],
    [
      "uncited caption",
      (b) => {
        b.caption = {
          ...caption,
          citations: [{ kind: "segment", id: "seg-999999" }],
        };
      },
      "INVALID_REFERENCE",
    ],
  ];
  for (const [name, mutateBlock, code] of cases) {
    const block = flow();
    mutateBlock(block);
    await assert.rejects(
      () =>
        fixture({
          mutate(d) {
            d.report.sections[0].blocks.push(block);
          },
        }),
      (error) =>
        error.code === code ||
        (code === "INVALID_CONTRACT" &&
          /INVALID_CONTRACT|SCHEMA/.test(error.code)),
      name,
    );
  }
});

test("long labels wrap/ellipsize inside boxes, row-skipping edges use the side lane, parallel runs are offset", () => {
  const { fitText, textWidth } = diagramModule;
  // English glyphs are narrower, so keep enough text to overflow two lines.
  assert.deepEqual(
    fitText(
      "A very very long label with enough explanatory text to exceed two narrow lines",
      15,
      200,
      2,
    ).length,
    2,
  );
  const [, second] = fitText(
    "A very very long label with enough explanatory text to exceed two narrow lines",
    15,
    200,
    2,
  );
  assert.ok(second.endsWith("…") && textWidth(second, 15) <= 200);
  assert.deepEqual(fitText("short", 15, 200, 2), ["short"]);
  const block = flow();
  block.nodes.push(node("f", "F"), node("g", "G"));
  block.edges.push(
    { from: "e", to: "f", label: null },
    { from: "f", to: "g", label: null },
    { from: "e", to: "g", label: "SKIP" },
  );
  const svg = diagramSvg(block);
  const canvasWidth = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)[1]);
  const [, labelX, labelWidth] =
    /<rect x="([\d.]+)" y="[^"]+" width="([\d.]+)" height="18" fill="[^"]+"\/><text[^>]*>SKIP<\/text>/.exec(
      svg,
    );
  assert.ok(
    Number(labelX) + Number(labelWidth) < canvasWidth,
    "side-lane label background fits inside its canvas",
  );
  const unlabeled = structuredClone(block);
  unlabeled.edges.at(-1).label = null;
  assert.match(
    diagramSvg(unlabeled),
    /viewBox="0 0 668 \d+"/,
    "unlabeled lane keeps its existing width",
  );
  const paths = [...svg.matchAll(/<path d="([^"]+)" fill="none"/g)].map(
    (m) => m[1],
  );
  assert.equal(paths.length, 8);
  const lane = paths.find((d) => /H6(?:3\d|4\d)/.test(d));
  assert.ok(lane, "skip edge routes through the right lane");
  for (const d of paths) assert.doesNotMatch(d, /L/);
  assert.ok(
    svg.includes("<title>A very") === false,
    "no tooltip when label fits",
  );
  const a2b = paths[0],
    a2c = paths[1];
  const midOf = (d) => Number(/V([\d.]+) Q/.exec(d)?.[1]);
  assert.notEqual(
    midOf(a2b),
    midOf(a2c),
    "parallel horizontal runs from one row get distinct heights",
  );
});

test("a node label or sublabel the renderer would cut with an ellipsis fails validation (real host case: 6-node row)", async () => {
  const { diagramTruncations } = await import("../lib/diagram.mjs");
  // Shape of a diagram written for Karpathy's "Intro to LLMs": one kernel node fanning out
  // to six nodes in one row; three sublabels were silently cut in the PDF.
  const block = {
    type: "diagram",
    kind: "flow",
    id: "llm-os-map",
    title: "LLM OS",
    alt: "LLM OS",
    nodes: [
      { id: "llm", label: "LLM (kernel / CPU)", sublabel: null, focal: true },
      {
        id: "ctx",
        label: "Context window",
        sublabel: "RAM and working memory",
        focal: false,
      },
      {
        id: "fs",
        label: "File system",
        sublabel: "Disk + embeddings (RAG)",
        focal: false,
      },
      { id: "web", label: "Browser", sublabel: "Internet", focal: false },
      {
        id: "tools",
        label: "Existing software tools",
        sublabel: "Calculator/Python/terminal",
        focal: false,
      },
      { id: "other", label: "Other LLM", sublabel: null, focal: false },
      {
        id: "io",
        label: "Video/audio",
        sublabel: "Peripheral I/O",
        focal: false,
      },
    ],
    edges: ["ctx", "fs", "web", "tools", "other", "io"].map((to) => ({
      from: "llm",
      to,
      label: null,
    })),
    caption: {
      text: "x",
      attribution: "interpretation",
      citations: [{ kind: "segment", id: "seg-000001" }],
    },
  };
  const cut = diagramTruncations(block);
  assert.ok(
    cut.some(
      (c) => c.id === "ctx" && c.field === "sublabel" && c.shown.endsWith("…"),
    ),
    JSON.stringify(cut),
  );
  const f = await fixture();
  try {
    const { validateData } = await import("../lib/validation.mjs");
    f.data.report.sections[0].blocks.push(block);
    assert.throws(
      () => validateData(f.data),
      (e) =>
        e.code === "INVALID_CONTRACT" &&
        /llm-os-map: node ctx sublabel would be cut/.test(e.message),
    );
    // The translated tools and media labels must shrink too; once everything fits,
    // validation passes.
    for (const n of block.nodes) {
      n.label = n.label.slice(0, 4);
      if (n.sublabel) n.sublabel = n.sublabel.slice(0, 3);
    }
    assert.deepEqual(diagramTruncations(block), []);
    assert.ok(validateData(f.data));
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(f.root, { recursive: true, force: true });
  }
});

test("round 6: label width is per grapheme after NFC — wide letters and emoji count wide, narrow letters narrow, NFC/NFD alike, zero-width nothing; truncation never splits a grapheme", () => {
  const { textWidth, fitText } = diagramModule;
  const nfc = "é".repeat(18);
  assert.equal(textWidth(nfc, 15), textWidth(nfc.normalize("NFD"), 15));
  assert.equal(textWidth("ab\u200b\u200dc", 15), textWidth("abc", 15));
  // Chrome measures 20×W at 294 px and 10 emoji at 190 px (15 px, weight 600, macOS).
  assert.ok(
    textWidth("W".repeat(23), 15) > 200,
    "23 × W overflows a 200 px line",
  );
  assert.ok(textWidth("😀".repeat(23), 15) > 200, "23 emoji overflow");
  assert.ok(textWidth("i".repeat(24), 15) < 200, "24 × i fits");
  // Cutting keeps whole clusters: no orphaned combining mark or half a ZWJ family.
  for (const text of ["e\u0301".repeat(60), "👩‍👩‍👧".repeat(30)]) {
    const [line] = fitText(text, 15, 200, 1);
    assert.ok(line.endsWith("…"));
    assert.ok(
      text.normalize("NFC").startsWith(line.slice(0, -1)),
      "a prefix of whole clusters",
    );
    assert.ok(textWidth(line, 15) <= 200);
  }
});
