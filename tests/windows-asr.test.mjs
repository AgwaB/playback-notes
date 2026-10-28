import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fakeTool } from "./fake-tool.mjs";
import { extractSource } from "../lib/ingest.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("Windows ASR passes ASCII relative model and audio names to narrow-argv tools", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asr café model-"));
  try {
    const media = path.join(root, "speech café sample.wav");
    const model = path.join(root, "model café.bin");
    const workDir = path.join(root, "work résumé");
    await mkdir(workDir);
    await writeFile(model, "existing model bytes");
    await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=duration=0.2", media]);
    const executable = await fakeTool(path.join(root, "whisper"), `
import fs from 'node:fs';
import path from 'node:path';
if (process.argv.includes('--version')) { console.log('whisper.cpp version: 1.9.5'); process.exit(0); }
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
const audio = args.at(-1);
if (/[^\\x00-\\x7f]/.test(model + audio) || path.isAbsolute(model) || path.isAbsolute(audio)) process.exit(10);
if (fs.readFileSync(model, 'utf8') !== 'existing model bytes') process.exit(11);
if (fs.readFileSync(audio).subarray(0, 4).toString() !== 'RIFF') process.exit(12);
fs.writeFileSync(args[args.indexOf('--output-file') + 1] + '.srt', '1\\n00:00:00,000 --> 00:00:00,200\\nModel and audio paths verified. 🙂\\n');
`);
    const result = await extractSource({
      source: { kind: "local", value: media },
      transcriptFile: null,
      policy: { asr: "local", maxDownloadBytes: 1024 * 1024,
        extractTimeoutMs: 10000, asrTimeoutMs: 10000 },
    }, { workDir, localAsrExecutable: executable, localAsrModel: model });
    assert.equal(result.segments[0].text, "Model and audio paths verified. 🙂");
    assert.equal(await readFile(model, "utf8"), "existing model bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
