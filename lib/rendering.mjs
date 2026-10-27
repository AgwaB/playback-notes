import Handlebars from "handlebars";
import { readFile } from "node:fs/promises";
import { buildView } from "./view.mjs";

const engine = Handlebars.create();
engine.registerHelper("eq", (left, right) => left === right);
engine.registerPartial(
  "citations",
  '<span class="citations">{{#each citations}}<a class="ts" href="#{{anchor}}" data-anchor="{{anchor}}"{{#if timed}} data-ms="{{ms}}"{{/if}}{{#if href}} data-original="{{href}}"{{/if}}>{{label}}</a>{{/each}}</span>',
);
engine.registerPartial(
  "statement",
  '{{#if interpretation}}<span class="badge">{{@root.ui.interpretation}}</span>{{/if}}{{{htmlText}}} {{> citations}}',
);
const template = engine.compile(
  await readFile(new URL("../templates/report.html", import.meta.url), "utf8"),
  { strict: false },
);
const css = await readFile(
  new URL("../templates/report.css", import.meta.url),
  "utf8",
);
const printCss = await readFile(
  new URL("../templates/print.css", import.meta.url),
  "utf8",
);
const player = await readFile(
  new URL("../templates/player.js", import.meta.url),
  "utf8",
);
export function htmlDocument(
  bundle,
  artifacts = [],
  issues = [],
  { print = false, fontCss = "" } = {},
) {
  const view = buildView(bundle, artifacts, issues);
  // Raw slots are exclusively trusted, shipped code; report values use escaped Handlebars interpolation.
  let html = template({ ...view, print }).replace(
    "<!-- STYLE -->",
    () => `<style>${css}\n${printCss}\n${fontCss}</style>`,
  );
  html = html.replace("<!-- PLAYER -->", () =>
    print ? "" : `<script>${player}</script>`,
  );
  if (print) {
    // Print citations must remain source links, not links into a hidden transcript panel.
    for (const reference of view.references) {
      const original = `href="#${reference.anchor}"`;
      const destination = reference.href
        ? `href="${engine.escapeExpression(reference.href)}"`
        : "";
      html = html.split(original).join(destination);
    }
  }
  return html;
}
