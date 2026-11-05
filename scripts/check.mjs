import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const excluded = new Set([
  "node_modules",
  ".git",
  ".pi",
  // Private job and report folders (the name before and after the rename).
  ".playback-notes",
  ".video-summarizer",
  "artifacts",
  "internal",
  "coverage",
  ".ruff_cache",
]);
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(name)));
    else result.push(name);
  }
  return result;
}
const errors = [],
  counts = {
    javascript: 0,
    json: 0,
    markdown: 0,
    localLinks: 0,
    readmeTranslations: 0,
  };
for (const file of await files(root)) {
  if (/\.(mjs|js)$/.test(file)) {
    counts.javascript++;
    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (result.status !== 0)
      errors.push(`${path.relative(root, file)}: syntax check failed`);
  } else if (file.endsWith(".json")) {
    counts.json++;
    try {
      JSON.parse(await readFile(file, "utf8"));
    } catch {
      errors.push(`${path.relative(root, file)}: invalid JSON`);
    }
  } else if (file.endsWith(".md")) {
    counts.markdown++;
    const body = await readFile(file, "utf8");
    for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      counts.localLinks++;
      try {
        const resolved = path.resolve(
          path.dirname(file),
          decodeURIComponent(target),
        );
        if (
          path.relative(root, resolved).split(path.sep)[0].toLowerCase() ===
          "internal"
        ) {
          errors.push(
            `${path.relative(root, file)}: link to internal document ${target}`,
          );
          continue;
        }
        await access(resolved);
      } catch {
        errors.push(`${path.relative(root, file)}: broken link ${target}`);
      }
    }
    for (const match of body.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
      try {
        JSON.parse(match[1]);
      } catch {
        errors.push(`${path.relative(root, file)}: invalid JSON example`);
      }
    }
  }
}
// GitHub's heading anchor: lower case, without punctuation, spaces as hyphens; a repeated
// heading gets -1, -2.
function headingAnchors(markdown) {
  const anchors = new Set();
  const seen = new Map();
  const prose = markdown.replace(/^```[\s\S]*?^```/gm, "");
  for (const [, text] of prose.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
    const base = text
      .replace(/<[^>]+>/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  return anchors;
}
// README translations name, by checksum, the README.md they were translated from, so an
// English change cannot leave them silently behind. Every README's in-page links must reach
// one of its headings (each language has its own), and its HTML links an existing file.
// A copy without README.md (a test tree) has nothing to compare.
const readmeSource = await readFile(path.join(root, "README.md")).catch(() => null);
const readmeText = readmeSource?.toString("utf8") ?? "";
// Over LF line endings: a Windows checkout may convert them to CRLF.
const readmeSum =
  readmeSource &&
  createHash("sha256").update(readmeText.replace(/\r\n/g, "\n")).digest("hex");
for (const name of (readmeSource ? await readdir(root) : [])
  .filter((entry) => /^README(\.[A-Za-z]{2}(-[A-Za-z]{2,4})?)?\.md$/.test(entry))
  .sort()) {
  const body = await readFile(path.join(root, name), "utf8");
  if (name !== "README.md") {
    counts.readmeTranslations++;
    const recorded =
      /<!-- README translation source: README\.md sha256=([0-9a-f]{64}) -->/.exec(body)?.[1];
    if (!recorded)
      errors.push(`${name}: missing the README.md checksum it was translated from`);
    else if (recorded !== readmeSum)
      errors.push(
        `${name}: translated from an older README.md; bring it up to date, then set its sha256=${readmeSum}`,
      );
    if (!readmeText.includes(`href="${name}"`))
      errors.push(`README.md: no language link to ${name}`);
  }
  const anchors = headingAnchors(body);
  for (const [, anchor] of body.matchAll(/(?:\]\(|href=")#([^)"\s]+)/g))
    if (!anchors.has(decodeURIComponent(anchor).toLowerCase()))
      errors.push(`${name}: link to a missing heading #${anchor}`);
  for (const [, target] of body.matchAll(/href="([^"#]+)/g)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    counts.localLinks++;
    try {
      await access(path.resolve(root, decodeURIComponent(target)));
    } catch {
      errors.push(`${name}: broken link ${target}`);
    }
  }
}
for (const required of [
  "SKILL.md",
  "scripts/prepare.mjs",
  "scripts/validate.mjs",
  "scripts/render.mjs",
  "scripts/export.mjs",
  "scripts/serve.mjs",
  "schemas/evidence.schema.json",
  "schemas/report.schema.json",
]) {
  try {
    await access(path.join(root, required));
  } catch {
    errors.push(`Missing ${required}`);
  }
}
process.stdout.write(
  `${JSON.stringify({ status: errors.length ? "failed" : "passed", counts, errors }, null, 2)}\n`,
);
process.exitCode = errors.length ? 1 : 0;
