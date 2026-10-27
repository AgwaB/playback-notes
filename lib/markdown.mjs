import { toMarkdown } from "mdast-util-to-markdown";
import { gfmTableToMarkdown } from "mdast-util-gfm-table";
import { buildView } from "./view.mjs";
import { diagramText } from "./diagram.mjs";

const text = (value) => ({ type: "text", value });
const paragraph = (children) => ({ type: "paragraph", children });
const heading = (depth, value) => ({
  type: "heading",
  depth,
  children: [text(value)],
});
const link = (url, value) => ({ type: "link", url, children: [text(value)] });
function statementNodes(statement, ui) {
  const nodes = [
    text(
      `${statement.interpretation ? `[${ui.interpretation}] ` : ""}${statement.text}`,
    ),
  ];
  for (const citation of statement.citations) {
    nodes.push(text(" "));
    nodes.push(
      citation.href
        ? link(citation.href, `[${citation.label}]`)
        : text(`[${citation.label}]`),
    );
  }
  return nodes;
}
function list(items, ordered, ui) {
  return {
    type: "list",
    ordered,
    spread: false,
    children: items.map((item) => ({
      type: "listItem",
      spread: false,
      children: [paragraph(statementNodes(item, ui))],
    })),
  };
}
export function markdownDocument(bundle) {
  const view = buildView(bundle),
    ui = view.ui;
  const children = [
    heading(1, view.title),
    paragraph([
      text(`${view.modeLabel} · ${view.sourceLabel}${view.durationLabel ? ` · ${view.durationLabel}` : ""}`),
    ]),
    heading(2, ui.overview),
    list(view.summary, false, ui),
  ];
  for (const section of view.sections) {
    children.push(heading(2, section.heading));
    for (const block of section.blocks) {
      if (block.type === "paragraph")
        children.push(paragraph(statementNodes(block.statement, ui)));
      if (block.type === "list")
        children.push(list(block.items, block.ordered, ui));
      if (block.type === "table")
        children.push({
          type: "table",
          align: block.columns.map(() => null),
          children: [
            {
              type: "tableRow",
              children: block.columns.map((value) => ({
                type: "tableCell",
                children: [text(value)],
              })),
            },
            ...block.rows.map((row) => ({
              type: "tableRow",
              children: row.map((cell) => ({
                type: "tableCell",
                children: statementNodes(cell, ui),
              })),
            })),
          ],
        });
      if (block.type === "quote")
        children.push({
          type: "blockquote",
          children: [
            paragraph([
              ...(block.verbatim ? [] : [text(`[${ui.paraphrase}] `)]),
              ...statementNodes(block.statement, ui),
            ]),
          ],
        });
      if (block.type === "code") {
        if (block.interpretation)
          children.push(paragraph([text(`[${ui.reconstructed}]`)]));
        children.push({
          type: "code",
          lang: /^[A-Za-z0-9_+-]{1,30}$/.test(block.language ?? "")
            ? block.language
            : null,
          value: block.text,
        });
        children.push(
          paragraph(
            statementNodes(
              { text: "", interpretation: false, citations: block.citations },
              ui,
            ),
          ),
        );
      }
      if (block.type === "diagram") {
        children.push(
          paragraph([{ type: "strong", children: [text(block.title)] }]),
          {
            type: "list",
            ordered: block.kind === "stack",
            children: diagramText(block).map((line) => ({
              type: "listItem",
              children: [paragraph([text(line)])],
            })),
          },
          paragraph(statementNodes(block.caption, ui)),
        );
      }
      if (block.type === "figure") {
        children.push(
          paragraph([{ type: "image", url: block.asset, alt: block.alt }]),
        );
        children.push(paragraph(statementNodes(block.caption, ui)));
      }
    }
  }
  if (view.caveats.length)
    children.push(heading(2, ui.caveats), list(view.caveats, false, ui));
  children.push(heading(2, ui.limitations));
  for (const limitation of view.limitations)
    children.push(paragraph([text(limitation)]));
  children.push(
    heading(2, ui.refs),
    paragraph([text(view.sourceLabel)]),
  );
  if (view.sourceHref)
    children.push(paragraph([link(view.sourceHref, ui.original)]));
  children.push({ type: "html", value: `<details>\n<summary>${ui.details}</summary>\n` });
  children.push(paragraph([text(`${view.scopeLabel}: ${view.scope}`)]));
  for (const detail of view.technicalDetails)
    children.push(paragraph([text(`${detail.code}: ${detail.message}`)]));
  children.push(
    paragraph([text(`report SHA-256: ${view.reportSha256}`)]),
    paragraph([text(`evidence SHA-256: ${view.evidenceSha256}`)]),
  );
  children.push({ type: "html", value: "</details>" });
  return toMarkdown(
    { type: "root", children },
    { extensions: [gfmTableToMarkdown()], bullet: "-", fences: true },
  );
}
