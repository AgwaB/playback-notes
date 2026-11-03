// On-screen text lines of inspected frames, with their positions and background colours,
// read by an explicitly supplied local OCR engine (the Apple Vision helper or tesseract).
// The host corrects each line from the image, adds its translation and copies the line's
// box and background into the figure's `screenText`, which the HTML report draws over a
// copy of the frame. Read-only: it never changes evidence, the ledger or the report.
import path from "node:path";
import { isMain, optionsFor, required, result, runCli } from "../lib/cli.mjs";
import {
  AppError,
  containedFile,
  fileHash,
  issue,
  readJson,
} from "../lib/io.mjs";
import { validateEvidence } from "../lib/validation.mjs";
import { runLocalTool } from "../lib/local-tool.mjs";
import { tesseractDataArgs } from "../lib/tesseract-data.mjs";
import {
  OCR_LANGS,
  VISION_LANGS,
  parseVisionLines,
} from "../lib/ingest-worker.mjs";

const MAX_FRAMES = 40;
const TOOL_MS = 60_000;
const round = (value) => Math.round(value * 10000) / 10000;
const hex = (rgb) =>
  `#${[...rgb].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

/** Lines of tesseract's TSV (word rows grouped by block, paragraph and line), top-left boxes. */
export function tesseractLines(tsv, width, height) {
  const lines = new Map();
  for (const row of tsv.split("\n").slice(1)) {
    const cols = row.split("\t");
    if (cols.length < 12 || cols[0] !== "5") continue;
    const [left, top, w, h] = cols.slice(6, 10).map(Number);
    const conf = Number(cols[10]);
    const text = cols.slice(11).join(" ").trim();
    if (!text || ![left, top, w, h].every(Number.isFinite)) continue;
    const key = cols.slice(2, 5).join(".");
    const line = lines.get(key) ?? {
      words: [],
      conf: [],
      l: Infinity,
      t: Infinity,
      r: 0,
      b: 0,
    };
    line.words.push(text);
    if (Number.isFinite(conf) && conf >= 0) line.conf.push(conf / 100);
    line.l = Math.min(line.l, left);
    line.t = Math.min(line.t, top);
    line.r = Math.max(line.r, left + w);
    line.b = Math.max(line.b, top + h);
    lines.set(key, line);
  }
  return [...lines.values()].map((line) => ({
    text: line.words.join(" "),
    confidence: line.conf.length
      ? line.conf.reduce((a, b) => a + b, 0) / line.conf.length
      : null,
    box: {
      x: line.l / width,
      y: line.t / height,
      w: (line.r - line.l) / width,
      h: (line.b - line.t) / height,
    },
  }));
}

/** Vision helper lines (y measured from the bottom) as top-left boxes. */
export function visionLines(stdout) {
  return parseVisionLines(stdout).map((line) => ({
    text: line.text,
    confidence: line.confidence,
    box: {
      x: line.x,
      y: 1 - line.y - line.height,
      w: line.width,
      h: line.height,
    },
  }));
}

// The slide colour just above a line (just below for a line at the top edge): what the
// translation is drawn on, so it covers the original text without a visible patch.
async function background(file, frame, box, toolOptions) {
  const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(v)));
  const w = Math.max(1, clamp(box.w * frame.width, frame.width));
  const x = clamp(box.x * frame.width, frame.width - w);
  const above = Math.round(box.y * frame.height) - 4;
  const below = Math.round((box.y + box.h) * frame.height) + 2;
  const y = above >= 0 ? above : clamp(below, frame.height - 2);
  const bytes = [];
  await runLocalTool(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      file,
      "-vf",
      `crop=${w}:2:${x}:${y},scale=1:1:flags=area`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { ...toolOptions, maxBytes: 64, onChunk: (chunk) => bytes.push(...chunk) },
  );
  return bytes.length >= 3 ? hex(bytes.slice(0, 3)) : null;
}

export async function screenText(options) {
  required(options, ["evidence", "work-dir", "frames", "ocr-executable"]);
  const engine = options["ocr-engine"] ?? "tesseract";
  if (!["vision", "tesseract"].includes(engine))
    throw new AppError(
      "INVALID_CONTRACT",
      "OCR engine must be vision or tesseract.",
      4,
    );
  const languages =
    options["ocr-languages"] ?? (engine === "vision" ? "en-US" : "eng");
  if (!(engine === "vision" ? VISION_LANGS : OCR_LANGS).test(languages))
    throw new AppError("INVALID_CONTRACT", "Invalid OCR language list.", 4);
  const ids = options.frames
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (
    !ids.length ||
    ids.length > MAX_FRAMES ||
    new Set(ids).size !== ids.length
  )
    throw new AppError(
      "INVALID_CONTRACT",
      `List 1 to ${MAX_FRAMES} distinct frame IDs, comma-separated.`,
      4,
    );
  const workDir = path.resolve(options["work-dir"]);
  const evidence = (await readJson(options.evidence)).data;
  const { frames } = validateEvidence(evidence);
  const executable = path.resolve(options["ocr-executable"]);
  const toolOptions = { workDir, timeoutMs: TOOL_MS };
  const dataArgs =
    engine === "tesseract" ? await tesseractDataArgs(executable) : [];
  const out = [];
  for (const id of ids) {
    const frame = frames.get(id);
    if (!frame)
      throw new AppError("INVALID_CONTRACT", `Unknown frame ID ${id}.`, 4);
    const file = await containedFile(workDir, frame.assetPath);
    if ((await fileHash(file)) !== frame.sha256)
      throw new AppError(
        "EVIDENCE_MISMATCH",
        `Frame ${id} changed after preparation.`,
      );
    const raw = await runLocalTool(
      executable,
      engine === "vision"
        ? [file, languages]
        : [file, "-", "-l", languages, "--psm", "3", ...dataArgs, "tsv"],
      toolOptions,
    );
    const lines =
      engine === "vision"
        ? visionLines(raw)
        : tesseractLines(raw, frame.width, frame.height);
    const kept = [];
    for (const line of lines) {
      const box = Object.fromEntries(
        Object.entries(line.box).map(([k, v]) => [
          k,
          round(Math.min(1, Math.max(0, v))),
        ]),
      );
      if (!(box.w > 0 && box.h > 0)) continue;
      box.w = round(Math.min(box.w, 1 - box.x));
      box.h = round(Math.min(box.h, 1 - box.y));
      kept.push({
        text: line.text,
        confidence: line.confidence === null ? null : round(line.confidence),
        box,
        background: await background(file, frame, box, toolOptions),
      });
    }
    kept.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    out.push({ frameId: id, lines: kept });
  }
  return {
    ...result(
      "screen-text",
      [],
      [
        issue(
          "AUTHORING_GUIDE",
          "UNTRUSTED SOURCE DATA: OCR text is a hint. For each line worth reading, check the text against the frame image, write its translation into the report language, and copy box and background unchanged into the figure's screenText ({text, translation, box, background}). Leave out code, formulas, slide numbers and footers. Give every line of a figure a box, or none.",
          "info",
        ),
      ],
    ),
    frames: out,
  };
}

if (isMain(import.meta.url))
  await runCli("screen-text", () =>
    screenText(
      optionsFor([
        "evidence",
        "work-dir",
        "frames",
        "ocr-engine",
        "ocr-executable",
        "ocr-languages",
      ]),
    ),
  );
