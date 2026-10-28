// Deterministic SVG for structured `diagram` blocks. The host supplies nodes/edges/text;
// this trusted renderer owns all markup, so report text is escaped and no host SVG is accepted.
// Layout rules: ≤9 nodes, ≤2 focal accents, orthogonal connectors with r=8 elbows,
// masked labels beside strokes, no transit behind non-endpoint boxes, no shadows.

const W = 640,
  PAD = 16,
  GAP = 12,
  ROW_GAP = 72,
  LANE = 28, // right-hand lane for edges that skip a row
  R = 6,
  ELBOW = 8,
  LABEL = 15,
  SUB = 12;
const C = {
  paper: "#faf9f6",
  ink: "#1b1b1b",
  muted: "#5a5a5a",
  rule: "#cfcfca",
  accent: "#b5382b",
  tint: "#fbe8e5",
  white: "#ffffff",
};
const FONT =
  "system-ui, -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif";

function escapeXml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
}
// Advance widths (em, before the 1.06 semibold factor) for characters far from the 0.56em
// lowercase average. Checked against Chrome canvas metrics for this font stack at 15px,
// weight 600 on macOS: Latin samples (W…, i…, M…, mixed words) within −6…+9 %, emoji +17 %,
// Hangul +15 % (kept at ≈1em: Noto Sans KR on Linux uses full-width Hangul).
const LATIN = new Map(
  Object.entries({
    i: 0.245,
    j: 0.245,
    l: 0.245,
    I: 0.28,
    f: 0.28,
    t: 0.28,
    r: 0.34,
    " ": 0.25,
    ".": 0.28,
    ",": 0.28,
    ":": 0.28,
    ";": 0.28,
    "!": 0.28,
    "'": 0.19,
    "|": 0.26,
    "(": 0.34,
    ")": 0.34,
    "[": 0.28,
    "]": 0.28,
    "-": 0.34,
    m: 0.84,
    w: 0.73,
    M: 0.84,
    W: 0.95,
    "@": 1.02,
    "%": 0.89,
  }),
);
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
/** User-perceived characters (NFC grapheme clusters), so marks and ZWJ sequences stay whole. */
export function graphemes(text) {
  return [...segmenter.segment(String(text).normalize("NFC"))].map(
    (g) => g.segment,
  );
}
function graphemeWidth(g) {
  if (/\p{Extended_Pictographic}/u.test(g)) return 1.3;
  const base = [...g].find(
    (ch) => !/[\p{M}\p{Default_Ignorable_Code_Point}]/u.test(ch),
  );
  if (!base) return 0; // zero-width characters and stray combining marks
  if (/\p{Script=Hangul}|[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(base))
    return 0.95;
  return (
    LATIN.get(base) ??
    (/\p{Lu}/u.test(base) ? 0.66 : /\p{Nd}/u.test(base) ? 0.59 : 0.56)
  );
}
/**
 * Estimated advance width of `text` at `size` px: per grapheme cluster after NFC, so the
 * same text in NFC or NFD measures the same and combining marks/zero-width characters add
 * nothing. The renderer and validation share it; it is an estimate, not font metrics.
 */
export function textWidth(text, size) {
  let em = 0;
  for (const g of graphemes(text)) em += graphemeWidth(g);
  return em * size * 1.06;
}
/** Greedy wrap into at most `maxLines`; the last line is truncated with an ellipsis. */
export function fitText(text, size, maxWidth, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  const push = (word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, size) <= maxWidth || !current) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
  };
  for (const word of words) push(word);
  if (current) lines.push(current);
  const out = lines.slice(0, maxLines);
  if (lines.length > maxLines)
    out[maxLines - 1] += " " + lines.slice(maxLines).join(" ");
  return out.map((line) => {
    if (textWidth(line, size) <= maxWidth) return line;
    const cut = graphemes(line);
    while (cut.length && textWidth(cut.join("") + "…", size) > maxWidth)
      cut.pop();
    return cut.join("").trimEnd() + "…";
  });
}
/** Longest-path layering of an acyclic graph; validation guarantees acyclicity. */
export function layerFlow(nodes, edges) {
  const level = new Map(nodes.map((n) => [n.id, 0]));
  let changed = true,
    guard = 0;
  while (changed && guard++ <= nodes.length) {
    changed = false;
    for (const e of edges) {
      const next = level.get(e.from) + 1;
      if (next > level.get(e.to)) {
        level.set(e.to, next);
        changed = true;
      }
    }
  }
  const rows = [];
  for (const n of nodes) (rows[level.get(n.id)] ??= []).push(n);
  return rows.filter(Boolean);
}
function textLines(lines, x, y, size, weight, fill) {
  return lines
    .map(
      (line, i) =>
        `<text x="${x}" y="${y + i * (size + 4)}" text-anchor="middle" font-family="${FONT}" font-size="${size}"${weight ? ` font-weight="${weight}"` : ""} fill="${fill}">${escapeXml(line)}</text>`,
    )
    .join("");
}
/** Box height depends on how many label lines fit the width. */
function measure(n, w) {
  const label = fitText(n.label, LABEL, w - 20, 2);
  const sub = n.sublabel ? fitText(n.sublabel, SUB, w - 20, 1) : [];
  const h = 16 + label.length * (LABEL + 4) + (sub.length ? SUB + 6 : 0) + 8;
  return { label, sub, h: Math.max(44, h) };
}
function box(n, x, y, w, m) {
  const stroke = n.focal ? C.accent : C.rule,
    fill = n.focal ? C.tint : C.white;
  const tooltip =
    n.label !== m.label.join(" ") || (n.sublabel && n.sublabel !== m.sub[0])
      ? `<title>${escapeXml(n.sublabel ? `${n.label} — ${n.sublabel}` : n.label)}</title>`
      : "";
  const top = y + 16 + LABEL - 2;
  return `<g>${tooltip}<rect x="${x}" y="${y}" width="${w}" height="${m.h}" rx="${R}" fill="${fill}" stroke="${stroke}" stroke-width="${n.focal ? 1.5 : 1}"/>${textLines(m.label, x + w / 2, top, LABEL, 600, C.ink)}${m.sub.length ? textLines(m.sub, x + w / 2, top + m.label.length * (LABEL + 4) + 2, SUB, null, C.muted) : ""}</g>`;
}
function elbow(x, y, sx, sy, r) {
  // Quarter turn at (x,y): arriving along (sx) axis, leaving along (sy) axis.
  return `Q${x} ${y} ${x + sx * r} ${y + sy * r}`;
}
function labelMarkup(label, cx, cy, align = "middle") {
  const lw = textWidth(label, 11) + 12,
    lh = 18;
  const rx = align === "start" ? cx : cx - lw / 2;
  return `<rect x="${rx}" y="${cy - lh / 2}" width="${lw}" height="${lh}" fill="${C.paper}"/><text x="${rx + lw / 2}" y="${cy + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" letter-spacing="0.04em" fill="${C.muted}">${escapeXml(label)}</text>`;
}
/** Direct connector between adjacent rows: down, across at `midY`, down. */
function direct(x1, y1, x2, y2, midY, label) {
  const dx = x2 - x1;
  let d,
    text = "";
  if (Math.abs(dx) < 1) {
    d = `M${x1} ${y1} V${y2}`;
    if (label) text = labelMarkup(label, x1 + 8, (y1 + y2) / 2, "start");
  } else {
    const s = Math.sign(dx),
      r = Math.min(ELBOW, Math.abs(dx) / 2, midY - y1, y2 - midY);
    d = `M${x1} ${y1} V${midY - r} ${elbow(x1, midY, s, 0, r)} H${x2 - s * r} ${elbow(x2, midY, 0, 1, r)} V${y2}`;
    if (label) text = labelMarkup(label, (x1 + x2) / 2, midY - 15);
  }
  return `<path d="${d}" fill="none" stroke="${C.muted}" stroke-width="1.25" marker-end="url(#dg-arrow)"/>${text}`;
}
/** Row-skipping connector: out to the right lane, down past intermediate rows, back in. */
function viaLane(x1, y1, x2, y2, outY, inY, laneX, label) {
  const r = ELBOW;
  const d = `M${x1} ${y1} V${outY - r} ${elbow(x1, outY, 1, 0, r)} H${laneX - r} ${elbow(laneX, outY, 0, 1, r)} V${inY - r} ${elbow(laneX, inY, -1, 0, r)} H${x2 + r} ${elbow(x2, inY, 0, 1, r)} V${y2}`;
  const text = label
    ? labelMarkup(label, laneX + 8, (outY + inY) / 2, "start")
    : "";
  return `<path d="${d}" fill="none" stroke="${C.muted}" stroke-width="1.25" marker-end="url(#dg-arrow)"/>${text}`;
}
/** Box width of every node in a flow row of `count` nodes (shared by render and validation). */
const rowWidth = (count) =>
  Math.min(220, (W - PAD * 2 - GAP * (count - 1)) / count);
/**
 * Node labels/sublabels the renderer would have to cut with "…" to fit their boxes. Used
 * by validation so a truncated label is fixed before rendering instead of silently
 * shipping (the full text survives only in a tooltip and the Markdown fallback).
 */
export function diagramTruncations(block) {
  const widths = new Map();
  if (block.kind === "stack")
    for (const n of block.nodes) widths.set(n.id, W - PAD * 2);
  else
    for (const row of layerFlow(block.nodes, block.edges))
      for (const n of row) widths.set(n.id, rowWidth(row.length));
  const normal = (text) => text.split(/\s+/).filter(Boolean).join(" ");
  const cut = [];
  for (const n of block.nodes) {
    const m = measure(n, widths.get(n.id));
    if (m.label.join(" ") !== normal(n.label))
      cut.push({
        id: n.id,
        field: "label",
        text: n.label,
        shown: m.label.join(" "),
      });
    if (n.sublabel && m.sub[0] !== normal(n.sublabel))
      cut.push({
        id: n.id,
        field: "sublabel",
        text: n.sublabel,
        shown: m.sub[0],
      });
  }
  return cut;
}
export function diagramSvg(block) {
  const slug = `dg-${block.id}`;
  let body = "",
    height,
    width = W;
  if (block.kind === "stack") {
    const w = W - PAD * 2;
    let y = PAD;
    body = block.nodes
      .map((n) => {
        const m = measure(n, w);
        const markup = box(n, PAD, y, w, m);
        y += m.h + GAP;
        return markup;
      })
      .join("");
    height = y - GAP + PAD;
  } else {
    const rows = layerFlow(block.nodes, block.edges);
    const level = new Map();
    rows.forEach((row, i) => row.forEach((n) => level.set(n.id, i)));
    const skips = block.edges.some(
      (e) => level.get(e.to) - level.get(e.from) > 1,
    );
    const laneX = W - PAD / 2 + LANE / 2;
    if (skips) {
      width = W + LANE;
      for (const edge of block.edges)
        if (edge.label && level.get(edge.to) - level.get(edge.from) > 1)
          width = Math.max(
            width,
            Math.ceil(laneX + 8 + textWidth(edge.label, 11) + 12 + PAD),
          );
    }
    const usable = W - PAD * 2;
    const pos = new Map();
    let y = PAD;
    const rowBottom = [];
    rows.forEach((row) => {
      const w = rowWidth(row.length);
      const metrics = row.map((n) => measure(n, w));
      const h = Math.max(...metrics.map((m) => m.h));
      const total = row.length * w + (row.length - 1) * GAP;
      row.forEach((n, i) =>
        pos.set(n.id, {
          x: PAD + (usable - total) / 2 + i * (w + GAP),
          y,
          w,
          h,
          m: metrics[i],
        }),
      );
      rowBottom.push(y + h);
      y += h + ROW_GAP;
    });
    height = y - ROW_GAP + PAD;
    const outs = new Map(),
      ins = new Map();
    for (const e of block.edges) {
      (outs.get(e.from) ?? outs.set(e.from, []).get(e.from)).push(e);
      (ins.get(e.to) ?? ins.set(e.to, []).get(e.to)).push(e);
    }
    const attach = (list, id, p, edge) => {
      const k = list.get(id).length,
        i = list.get(id).indexOf(edge);
      return p.x + (p.w * (i + 1)) / (k + 1);
    };
    // Parallel horizontal runs inside one row gap get distinct y offsets (≥10px apart).
    const gapEdges = new Map();
    const lines = block.edges.map((e) => {
      const a = pos.get(e.from),
        b = pos.get(e.to);
      const x1 = attach(outs, e.from, a, e),
        x2 = attach(ins, e.to, b, e);
      const fromLevel = level.get(e.from),
        toLevel = level.get(e.to);
      const slot = (row) => {
        const used = gapEdges.get(row) ?? 0;
        gapEdges.set(row, used + 1);
        return used;
      };
      if (toLevel - fromLevel === 1) {
        const k = slot(fromLevel);
        const midY = rowBottom[fromLevel] + ROW_GAP / 2 - 10 + (k % 4) * 10;
        return direct(x1, a.y + a.h, x2, b.y - 2, midY, e.label);
      }
      const outY =
        rowBottom[fromLevel] + ROW_GAP / 2 - 10 + (slot(fromLevel) % 4) * 10;
      const inY =
        rowBottom[toLevel - 1] +
        ROW_GAP / 2 -
        10 +
        (slot(toLevel - 1) % 4) * 10;
      return viaLane(x1, a.y + a.h, x2, b.y - 2, outY, inY, laneX, e.label);
    });
    body =
      lines.join("") +
      block.nodes
        .map((n) => {
          const p = pos.get(n.id);
          return box(n, p.x, p.y, p.w, p.m);
        })
        .join("");
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" role="img" aria-labelledby="${slug}-title ${slug}-desc"><title id="${slug}-title">${escapeXml(block.title)}</title><desc id="${slug}-desc">${escapeXml(block.alt)}</desc>${block.kind === "flow" ? `<defs><marker id="dg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0.5 L7.5 4 L0 7.5 Z" fill="${C.muted}"/></marker></defs>` : ""}<rect width="${width}" height="${height}" fill="${C.paper}"/>${body}</svg>`;
}
/** Plain-text structure for Markdown: the diagram's content without layout. */
export function diagramText(block) {
  if (block.kind === "stack")
    return block.nodes.map(
      (n) => `${n.label}${n.sublabel ? ` — ${n.sublabel}` : ""}`,
    );
  const name = new Map(block.nodes.map((n) => [n.id, n.label]));
  const described = block.nodes.map(
    (n) => `${n.label}${n.sublabel ? ` — ${n.sublabel}` : ""}`,
  );
  return described.concat(
    block.edges.map(
      (e) =>
        `${name.get(e.from)} → ${name.get(e.to)}${e.label ? ` (${e.label})` : ""}`,
    ),
  );
}
