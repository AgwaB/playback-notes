import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { chromium } from "playwright-core";
import { fixture } from "./helpers.mjs";
import { loadBundle } from "../lib/validation.mjs";
import { pdfDocument, stopBrowserByProfile } from "../lib/pdf.mjs";
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
    if (scenario === "close") {
      // A failed close is followed by a forced stop of the browser's processes (none
      // exist for this mocked browser), so the export completes.
      const pdf = await pdfDocument(bundle, { browserExecutable: process.execPath });
      assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
      assert.equal(launches, 1);
      assert.equal(removalAttempted, true);
      return;
    }
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

test("a PDF browser that stops responding is stopped at the export deadline", async (t) => {
  const f = await fixture();
  const bundle = await loadBundle(f.args);
  let closeCalls = 0;
  t.after(async () => {
    t.mock.restoreAll();
    await fs.rm(f.root, { recursive: true, force: true });
  });
  const never = () => new Promise(() => {});
  t.mock.method(chromium, "launchPersistentContext", async () => ({
    route: async () => {},
    newPage: async () => ({
      setDefaultTimeout() {},
      goto: async () => {},
      evaluate: async () => {},
      pdf: never,
    }),
    close: () => {
      closeCalls++;
      return never();
    },
  }));
  const started = Date.now();
  await assert.rejects(
    pdfDocument(bundle, {
      browserExecutable: process.execPath,
      deadlineMs: 300,
      closeGraceMs: 100,
    }),
    (error) => {
      assert.equal(error.code, "EXPORT_TIMEOUT");
      assert.match(error.message, /did not finish within/);
      assert.match(error.message, /HTML and Markdown are unaffected/);
      return true;
    },
  );
  assert.equal(closeCalls, 1);
  assert.ok(Date.now() - started < 5000, "the deadline bounds the whole export");
});

test("a forced stop ends the browser process group named by its private profile", async (t) => {
  const { spawn } = await import("node:child_process");
  const os = await import("node:os");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vs-pdf-test-"));
  const profile = path.join(home, "profile");
  const pidFile = path.join(home, "child.pid");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  // A stand-in browser that starts a helper (without the marker) and then hangs.
  const script = `const { spawn } = require("node:child_process");
const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
setInterval(() => {}, 1000);`;
  const browser = spawn(
    process.execPath,
    ["-e", script, "--", `--user-data-dir=${profile}`],
    { detached: process.platform !== "win32", stdio: "ignore", windowsHide: true },
  );
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let helper;
  for (let i = 0; i < 100 && !helper; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    helper = Number(await fs.readFile(pidFile, "utf8").catch(() => "")) || undefined;
  }
  assert.ok(helper && alive(browser.pid) && alive(helper));
  assert.equal(await stopBrowserByProfile(profile), true);
  for (let i = 0; i < 100 && (alive(browser.pid) || alive(helper)); i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(browser.pid), false, "browser stopped");
  assert.equal(alive(helper), false, "its helper stopped too");
});
