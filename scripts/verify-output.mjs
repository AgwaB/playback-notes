import path from "node:path";
import { isMain, optionsFor, required, result, runCli } from "../lib/cli.mjs";
import { containedFile, fileHash, issue, readJson } from "../lib/io.mjs";
import { rendererIdentity } from "../lib/output.mjs";

/**
 * Check a public revision against this installed skill: the manifest's renderer identity
 * must equal this skill's own (a revision rendered by a modified or copied renderer does
 * not), and every listed artifact, image and media file must still match its hash.
 */
export async function verifyOutput(options) {
  required(options, ["out-dir"]);
  const out = path.resolve(options["out-dir"]);
  const manifest = (await readJson(path.join(out, "manifest.json"))).data;
  const issues = [];
  const current = await rendererIdentity();
  if (!manifest.renderer?.sha256)
    issues.push(
      issue(
        "RENDERER_UNKNOWN",
        "The manifest records no renderer identity (made by an older version or by other code).",
      ),
    );
  else if (manifest.renderer.sha256 !== current.sha256)
    issues.push(
      issue(
        "RENDERER_MISMATCH",
        `This revision was not rendered by the installed skill (${current.name} ${current.version ?? ""}): its renderer identity differs. A modified or copied renderer, or a different skill version, produced it.`,
      ),
    );
  const entries = [
    ...(manifest.artifacts ?? []).filter((a) =>
      ["created", "reused"].includes(a.status),
    ),
    ...(manifest.assets ?? []),
    ...(manifest.media ? [manifest.media] : []),
  ];
  for (const entry of entries) {
    try {
      const file = await containedFile(
        out,
        entry.path,
        Number.MAX_SAFE_INTEGER,
      );
      if ((await fileHash(file)) !== entry.sha256)
        issues.push(
          issue(
            "ARTIFACT_MISMATCH",
            `${entry.path} no longer matches the manifest.`,
          ),
        );
    } catch {
      issues.push(
        issue("ARTIFACT_MISSING", `${entry.path} is missing or unsafe.`),
      );
    }
  }
  return result(
    "verify-output",
    [],
    issues,
    issues.length ? "error" : "ok",
    issues.length ? "stop" : "continue",
  );
}
if (isMain(import.meta.url))
  await runCli("verify-output", () => verifyOutput(optionsFor(["out-dir"])));
