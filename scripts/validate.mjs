import {
  bundleOptions,
  isMain,
  optionsFor,
  required,
  result,
  runCli,
} from "../lib/cli.mjs";
import { loadBundle } from "../lib/validation.mjs";

export async function validate(options) {
  required(options, ["request", "evidence", "analysis", "report"]);
  await loadBundle(options);
  return result("validate");
}
if (isMain(import.meta.url))
  await runCli("validate", () => validate(optionsFor(bundleOptions)));
