import os from "node:os";
import path from "node:path";
import { isMain, optionsFor, required, result, runCli } from "../lib/cli.mjs";
import { issue } from "../lib/io.mjs";
import { reviewAsr } from "../lib/asr-review.mjs";
import { preferredGpu } from "./prepare.mjs";

export async function review(options, { asrPreferencePath = path.join(os.homedir(), ".agents", "video-summarizer-asr.json") } = {}) {
  required(options, ["source", "work-dir", "start-ms", "end-ms", "local-asr-executable", "local-asr-model"]);
  options = await preferredGpu(options, { policy: { asr: "local" } }, asrPreferencePath);
  const { review: data, artifact } = await reviewAsr(options);
  return result("asr-review", [artifact], [issue("ASR_REVIEW_UNVERIFIED",
    "These overlapping local ASR alternatives can omit, repeat, translate or invent words; compare the original audio before using them. The primary evidence was not modified.", "warning")],
  data.status === "complete" ? "ok" : "partial", data.status === "complete" ? "continue" : "ask-user");
}

if (isMain(import.meta.url)) await runCli("asr-review", () => review(optionsFor([
  "source", "work-dir", "start-ms", "end-ms", "local-asr-executable", "local-asr-model", "local-asr-gpu-executable",
])));
