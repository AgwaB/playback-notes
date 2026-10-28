import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm, symlink, writeFile } from "node:fs/promises";
import { pdfDocument } from "../lib/pdf.mjs";
import { fixture } from "./helpers.mjs";

test("invalid explicit PDF runtimes report a missing capability before browser launch", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const invalid = [path.join(f.root, "missing-browser"), f.work];
  if (process.platform !== "win32") {
    const nonExecutable = path.join(f.root, "not-executable");
    await writeFile(nonExecutable, "#!/bin/sh\nexit 1\n", { mode: 0o600 });
    const broken = path.join(f.root, "broken-browser");
    await symlink("missing-browser", broken);
    const loop = path.join(f.root, "loop-browser");
    await symlink("loop-browser", loop);
    invalid.push(nonExecutable, broken, loop);
  }
  for (const browserExecutable of invalid)
    await assert.rejects(pdfDocument(f.bundle, { browserExecutable }), { code: "PDF_RUNTIME_MISSING" });
});
