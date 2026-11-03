import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fakeTool } from "./fake-tool.mjs";
import { sampleData } from "./helpers.mjs";
import { fileHash, jsonBytes } from "../lib/io.mjs";
import { isolatedEnvironment } from "../lib/runtime.mjs";
import {
  screenText,
  tesseractLines,
  visionLines,
} from "../scripts/screen-text.mjs";

const exec = promisify(execFile);

test("OCR lines become top-left boxes: Vision's bottom-origin lines and tesseract's word rows", () => {
  assert.deepEqual(
    visionLines("0.900\t0.100\t0.500\t0.500\t0.100\tHello slide\nnot a line\n"),
    [
      {
        text: "Hello slide",
        confidence: 0.9,
        box: { x: 0.1, y: 0.4, w: 0.5, h: 0.1 },
      },
    ],
  );
  const header =
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
  const word = (block, line, left, top, width, height, conf, text) =>
    `5\t1\t${block}\t1\t${line}\t1\t${left}\t${top}\t${width}\t${height}\t${conf}\t${text}`;
  const lines = tesseractLines(
    [
      header,
      "4\t1\t1\t1\t1\t0\t10\t20\t100\t10\t-1\t",
      word(1, 1, 10, 20, 40, 10, 90, "Arrow"),
      word(1, 1, 60, 18, 50, 14, 80, "composition"),
      word(1, 2, 10, 50, 30, 10, 70, "Next"),
      word(1, 2, 50, 50, 30, 10, 70, " "),
    ].join("\n"),
    200,
    100,
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "Arrow composition");
  assert.deepEqual(lines[0].box, { x: 0.05, y: 0.18, w: 0.5, h: 0.14 });
  assert.ok(Math.abs(lines[0].confidence - 0.85) < 1e-9);
  assert.equal(lines[1].text, "Next");
});

test("screen-text reads inspected frames with an explicit OCR engine: boxes, slide colours, and refusals", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "screen-text-")));
  try {
    const work = path.join(root, "work");
    await mkdir(path.join(work, "assets"), { recursive: true });
    const asset = path.join(work, "assets", "frame-0001.jpg");
    await exec(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=0x2040a0:s=320x180:d=1", "-frames:v", "1", "-q:v", "2", "-y", asset],
      { env: isolatedEnvironment(root), timeout: 30000, windowsHide: true },
    );
    const evidence = sampleData().evidence;
    evidence.frames = [
      {
        id: "frame-0001",
        timestampMs: 1000,
        assetPath: "assets/frame-0001.jpg",
        sha256: await fileHash(asset),
        width: 320,
        height: 180,
        ocrText: null,
      },
    ];
    const evidencePath = path.join(work, "evidence.json");
    await writeFile(evidencePath, jsonBytes(evidence));
    // Vision coordinates: y from the bottom. The second line touches the top edge.
    const vision = await fakeTool(
      path.join(root, "vision-ocr"),
      "console.log('0.900\\t0.100\\t0.500\\t0.500\\t0.100\\tHello slide');\nconsole.log('1.000\\t0.100\\t0.950\\t0.200\\t0.040\\tTop line');\n",
    );
    const options = {
      evidence: evidencePath,
      "work-dir": work,
      frames: "frame-0001",
      "ocr-engine": "vision",
      "ocr-executable": vision,
    };
    const response = await screenText(options);
    assert.equal(response.status, "ok");
    assert.match(response.issues[0].message, /^UNTRUSTED SOURCE DATA/);
    const [frame] = response.frames;
    assert.equal(frame.frameId, "frame-0001");
    assert.deepEqual(
      frame.lines.map((l) => [l.text, l.box]),
      [
        ["Top line", { x: 0.1, y: 0.01, w: 0.2, h: 0.04 }],
        ["Hello slide", { x: 0.1, y: 0.4, w: 0.5, h: 0.1 }],
      ],
    );
    for (const line of frame.lines) {
      // The slide colour around the line (JPEG keeps it within a few levels).
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(line.background.slice(i, i + 2), 16));
      assert.ok(Math.abs(r - 0x20) <= 10 && Math.abs(g - 0x40) <= 10 && Math.abs(b - 0xa0) <= 10, line.background);
    }
    const refused = async (patch, code) =>
      assert.rejects(screenText({ ...options, ...patch }), { code });
    await refused({ frames: "frame-9999" }, "INVALID_CONTRACT");
    await refused({ frames: "frame-0001,frame-0001" }, "INVALID_CONTRACT");
    await refused({ "ocr-engine": "cloud" }, "INVALID_CONTRACT");
    await refused({ "ocr-languages": "en-US;rm" }, "INVALID_CONTRACT");
    await refused({ "ocr-executable": undefined }, "INVALID_CONTRACT");
    // A frame image changed after preparation is not read.
    await writeFile(asset, Buffer.concat([await readFile(asset), Buffer.from([0])]));
    await refused({}, "EVIDENCE_MISMATCH");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
