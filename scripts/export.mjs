import {
  bundleOptions,
  isMain,
  optionsFor,
  required,
  result,
  runCli,
} from "../lib/cli.mjs";
import { loadBundle } from "../lib/validation.mjs";
import {
  finalizeOutput,
  outputTransaction,
  setArtifact,
  filenames,
} from "../lib/output.mjs";
import {
  AppError,
  artifact,
  atomicWrite,
  issue,
  withLock,
} from "../lib/io.mjs";
import { markdownDocument } from "../lib/markdown.mjs";
import { pdfDocument } from "../lib/pdf.mjs";

export async function exportReport(options) {
  required(options, ["request", "evidence", "analysis", "report", "out-dir"]);
  const bundle = await loadBundle(options);
  const formats = options.formats
    ? options.formats.split(",")
    : bundle.request.formats.filter((format) => format !== "html");
  // An HTML-only request has nothing to export: say so instead of failing, so the same
  // render → export → verify sequence works for every request.
  if (!options.formats && !formats.length)
    return result("export", [], [
      issue(
        "NOTHING_TO_EXPORT",
        "The request asks only for HTML, which render.mjs already wrote; no Markdown or PDF to export.",
        "info",
      ),
    ]);
  if (
    !formats.length ||
    formats.some(
      (format) =>
        !["markdown", "pdf"].includes(format) ||
        !bundle.request.formats.includes(format),
    ) ||
    new Set(formats).size !== formats.length
  )
    throw new AppError(
      "INVALID_CONTRACT",
      "Export formats must be requested, unique markdown/pdf values.",
      4,
    );
  return withLock(options["out-dir"], () =>
    outputTransaction(bundle, options, async (context) => {
      for (const format of formats) {
        try {
          const content =
            format === "markdown"
              ? markdownDocument(bundle)
              : await pdfDocument(bundle, {
                  browserExecutable: options["browser-executable"],
                  fontDir: options["font-dir"],
                });
          await atomicWrite(context.out, filenames[format], content);
          setArtifact(
            context.manifest,
            await artifact(context.out, filenames[format], format),
          );
        } catch (error) {
          const code = error instanceof AppError ? error.code : "EXPORT_FAILED";
          const message =
            error instanceof AppError
              ? error.message
              : "Could not create the requested export.";
          // A verified export from this same revision stays in the inventory: the failed
          // attempt is reported, the still-valid file is not demoted.
          const retained = context.manifest.artifacts.find(
            (a) => a.format === format && a.status === "reused",
          );
          context.manifest.issues.push(
            issue(
              code,
              retained
                ? `${message} The existing ${format} export of this revision was kept.`
                : message,
            ),
          );
          if (!retained)
            setArtifact(context.manifest, {
              format,
              path: null,
              status: error.exitCode === 3 ? "blocked" : "failed",
            });
        }
      }
      const manifest = await finalizeOutput(bundle, context);
      return result(
        "export",
        manifest.artifacts,
        manifest.issues,
        manifest.overallStatus === "completed" ? "ok" : "partial",
        manifest.overallStatus === "completed" ? "continue" : "ask-user",
      );
    }),
  );
}
if (isMain(import.meta.url))
  await runCli("export", () =>
    exportReport(
      optionsFor([
        ...bundleOptions,
        "formats",
        "browser-executable",
        "font-dir",
      ]),
    ),
  );
