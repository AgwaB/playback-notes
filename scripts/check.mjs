import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const excluded = new Set([
  "node_modules",
  ".git",
  ".pi",
  ".video-summarizer",
  "artifacts",
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
  counts = { javascript: 0, json: 0, markdown: 0, localLinks: 0 };
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
        await access(
          path.resolve(path.dirname(file), decodeURIComponent(target)),
        );
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
