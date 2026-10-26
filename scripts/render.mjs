import {
    bundleOptions,
    isMain,
    optionsFor,
    required,
    result,
    runCli,
} from "../lib/cli.mjs";
import { loadBundle } from "../lib/validation.mjs";
import { finalizeOutput, outputTransaction } from "../lib/output.mjs";
import { withLock } from "../lib/io.mjs";

export async function render(options) {
    required(options, ["request", "evidence", "analysis", "report", "out-dir"]);
    const bundle = await loadBundle(options);
    return withLock(options["out-dir"], () =>
        outputTransaction(bundle, options, async (context) => {
            const manifest = await finalizeOutput(bundle, context);
            return result(
                "render",
                manifest.artifacts.filter((a) => a.format === "html"),
                manifest.issues,
            );
        }),
    );
}
if (isMain(import.meta.url))
    await runCli("render", () => render(optionsFor(bundleOptions)));
