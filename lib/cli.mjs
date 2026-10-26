import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { AppError, issue } from "./io.mjs";

export function optionsFor(names, booleans = []) {
  const options = Object.fromEntries([
    ...names.map((name) => [name, { type: "string" }]),
    ...booleans.map((name) => [name, { type: "boolean", default: false }]),
  ]);
  try {
    return parseArgs({ options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    // Say what kind of argument was wrong and list the accepted flags, without echoing raw
    // values (a misplaced signed URL or path must not land in host-visible output).
    const message = String(error?.message ?? "");
    const token = /Unknown option '([^']*)'/.exec(message)?.[1];
    const flag = /^(--?[A-Za-z][\w-]{0,40})(?:=|$)/.exec(token ?? "")?.[1];
    const detail = token && /\s/.test(token)
      ? "several flags passed as one quoted argument"
      : flag
        ? `unknown option ${flag}`
        : /positional|Unexpected argument/i.test(message)
        ? "an unexpected positional argument (a value without its flag, or a quoted string holding several arguments)"
          : /argument missing|requires a value|expects a value/i.test(message)
            ? "an option without its value"
            : "";
    throw new AppError(
      "INVALID_CONTRACT",
      `Invalid command arguments${detail ? ` (${detail})` : ""}. Accepted flags: ${[...names, ...booleans].map((n) => `--${n}`).join(", ")}. Pass each flag and value as separate arguments.`,
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
/** True when this module is the entry script, also when invoked through a symlinked install. */
export function isMain(url) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return pathToFileURL(process.argv[1]).href === url;
  }
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
