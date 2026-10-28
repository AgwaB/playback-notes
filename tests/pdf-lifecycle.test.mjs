import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { chromium } from "playwright-core";
import { fixture } from "./helpers.mjs";
import { loadBundle } from "../lib/validation.mjs";
import { pdfDocument } from "../lib/pdf.mjs";
import { AppError } from "../lib/io.mjs";

for (const scenario of [
  "close",
  "remove",
  "render-and-cleanup",
  "temp-creation",
])
  test(`PDF ${scenario} failure is explicit, private, and does not hide the primary error`, async (t) => {
    const f = await fixture();
    const bundle = await loadBundle(f.args);
    const realRm = fs.rm,
      realTemp = fs.mkdtemp;
    let home,
      removalAttempted = false,
      launches = 0;
    t.after(async () => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      if (home) await realRm(home, { recursive: true, force: true });
      await realRm(f.root, { recursive: true, force: true });
    });
    t.mock.method(fs, "mkdtemp", async (...args) => {
      if (scenario === "temp-creation")
        throw new Error("ENOSPC /private/secret-location");
      home = await realTemp(...args);
      return home;
    });
    t.mock.method(fs, "rm", async (file, options) => {
      if (file === home) {
        removalAttempted = true;
        if (["remove", "render-and-cleanup"].includes(scenario))
          throw new Error("EACCES /private/secret-location");
      }
      return realRm(file, options);
    });
    syncBuiltinESMExports();
    t.mock.method(
      chromium,
      "launchPersistentContext",
      async (profile, options) => {
        launches++;
        assert.equal(profile, path.join(home, "profile"));
        assert.equal(options.chromiumSandbox, true);
        assert.deepEqual(options.args, ["--disable-gpu"]);
        assert.equal(options.env.HOME, home);
        return {
          route: async () => {},
          newPage: async () => ({
            setDefaultTimeout() {},
            goto: async () => {},
            evaluate: async () => {},
            pdf: async () => {
              if (scenario === "render-and-cleanup")
                throw new AppError(
                  "EXPORT_FAILED",
                  "Original rendering failure.",
                );
              return Buffer.from("%PDF-" + "x".repeat(110));
            },
          }),
          close: async () => {
            if (["close", "render-and-cleanup"].includes(scenario))
              throw new Error("browser close secret");
          },
        };
      },
    );
    await assert.rejects(
      pdfDocument(bundle, { browserExecutable: process.execPath }),
      (error) => {
        assert.equal(
          error.code,
          ["temp-creation", "render-and-cleanup"].includes(scenario)
            ? "EXPORT_FAILED"
            : "PDF_CLEANUP_FAILED",
        );
        assert.doesNotMatch(
          error.message,
          /secret-location|browser close secret|ENOSPC|EACCES/,
        );
        if (home)
          assert.ok(
            !error.message.includes(home),
            "absolute temporary path stays private",
          );
        if (scenario === "render-and-cleanup")
          assert.match(error.message, /^Original rendering failure\./);
        if (["remove", "render-and-cleanup"].includes(scenario))
          assert.ok(error.message.includes(path.basename(home)));
        if (scenario === "temp-creation")
          assert.doesNotMatch(error.message, /host sandbox|probe was refused/);
        return true;
      },
    );
    assert.equal(launches, scenario === "temp-creation" ? 0 : 1);
    assert.equal(removalAttempted, scenario !== "temp-creation");
  });
