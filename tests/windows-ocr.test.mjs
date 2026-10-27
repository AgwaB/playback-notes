import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractSource, isolatedEnvironment } from "../lib/ingest.mjs";
import { normalizeRequest } from "../lib/validation.mjs";
import { fakeTool } from "./fake-tool.mjs";

const execute = promisify(execFile);

test("Windows OCR explicitly selects adjacent tessdata under a Korean executable path", {
  skip: process.platform !== "win32",
}, async (t) => {
  // Windows TEMP can use short names or different casing; the worker canonicalizes
  // the executable before selecting adjacent tessdata, so compare canonical paths.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "windows-ocr 한글 ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const toolDir = path.join(root, "OCR 도구");
  const dataDir = path.join(toolDir, "tessdata");
  const workDir = path.join(root, "작업 결과");
  await mkdir(dataDir, { recursive: true });
  const executable = await fakeTool(path.join(toolDir, "tesseract"), String.raw`
const args = process.argv.slice(2);
if (args[args.indexOf("--tessdata-dir") + 1] !== ${JSON.stringify(dataDir)}) {
  process.stderr.write("exception: filesystem error: Cannot convert character sequence: Illegal byte sequence");
  process.exit(1);
}
process.stdout.write("WINDOWS OCR TEST 12345\n윈도우 한글 지원 확인\n");
`);
  const media = path.join(root, "입력 영상.mp4");
  await execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "color=c=white:s=320x180:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", media,
  ], { env: isolatedEnvironment(root), timeout: 30000, windowsHide: true });
  const request = normalizeRequest({
    schemaVersion: 1,
    source: { kind: "local", value: media },
    mode: "briefing",
    outputLanguage: "ko",
    formats: ["html"],
    policy: { asr: "off", visual: "local-ocr" },
  });
  const result = await extractSource(request, {
    workDir,
    tesseractExecutable: executable,
    ocrLanguages: "kor+eng",
    ocrSampleSeconds: 1,
  });
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].timestampMs, 0);
  assert.equal(result.frames[0].ocrText, "WINDOWS OCR TEST 12345\n윈도우 한글 지원 확인");
  assert.equal(result.raw.visualOcr.sampled, 2);
  assert.equal(result.extraction.provider, "video-summarizer/visual-ocr");
});
