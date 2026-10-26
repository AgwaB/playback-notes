import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { AppError, issue } from "./io.mjs";

export function optionsFor(names, booleans = []) {
  const options = Object.fromEntries([
    ...names.map((name) => [name, { type: "string" }]),
    ...booleans.map((name) => [name, { type: "boolean", default: false }]),
  ]);
  try {
    return parseArgs({ options, strict: true, allowPositionals: false }).values;
  } catch {
    throw new AppError(
      "INVALID_CONTRACT",
      "Invalid command arguments. See SKILL.md for supported flags.",
      4,
    );
  }
}
export function required(options, names) {
  for (const name of names)
    if (!options[name])
      throw new AppError("INVALID_CONTRACT", `Missing --${name}.`, 4);
}
export const bundleOptions = [
  "request",
  "evidence",
  "analysis",
  "report",
  "work-dir",
  "out-dir",
];
export const result = (
  stage,
  artifacts = [],
  issues = [],
  status = "ok",
  nextAction = "continue",
) => ({ schemaVersion: 1, stage, status, artifacts, issues, nextAction });
export function isMain(url) {
  return (
    Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === url
  );
}
export async function runCli(stage, action) {
  try {
    const response = await action();
    process.stdout.write(`${JSON.stringify(response)}\n`);
    process.exitCode =
      response.status === "partial"
        ? 2
        : response.status === "needs-input"
          ? 3
          : response.status === "error"
            ? 1
            : 0;
  } catch (error) {
    const known = error instanceof AppError;
    // Unexpected dependencies can include signed URLs/paths in their errors: don't echo them.
    const code = known
      ? error.code
      : /^[A-Z][A-Z_]+$/.test(error.code ?? "")
        ? error.code
        : "EXECUTION_FAILED";
    const message = known
      ? error.message
      : "Operation failed; no completed artifact was claimed. Check local capabilities and the input contract.";
    const issues =
      known && error.issues.length ? error.issues : [issue(code, message)];
    const needsInput = new Set([
      "ASR_REQUIRED",
      "CAPABILITY_MISSING",
      "SOURCE_UNSUPPORTED",
      "SOURCE_ACCESS_DENIED",
      "SOURCE_UNAVAILABLE",
      "TRANSCRIPT_UNAVAILABLE",
      "NO_USABLE_EVIDENCE",
    ]);
    const exitCode = known ? error.exitCode : needsInput.has(code) ? 3 : 1;
    const status = exitCode === 3 ? "needs-input" : "error";
    process.stdout.write(
      `${JSON.stringify(result(stage, [], issues, status, exitCode === 3 ? "ask-user" : "stop"))}\n`,
    );
    process.exitCode = exitCode;
  }
}
