import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { fixture } from "../helpers.mjs";

const exec = promisify(execFile);
const executablePath = process.env.TEST_BROWSER_EXECUTABLE;

test("inside a host sandbox, a PDF export that cannot start the browser's own sandbox says so (Codex workspace-write)", {
  skip: (process.platform !== "darwin" || !executablePath) && "macOS with a test browser only",
  timeout: 120000,
}, async (t) => {
  const { confinedRuntimeStatus } = await import("../../lib/ingest-worker.mjs");
  if (!(await confinedRuntimeStatus()).available) return t.skip("already inside a sandbox");
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const tmp = realpathSync(os.tmpdir());
  const pdf = new URL("../../lib/pdf.mjs", import.meta.url).href;
  const script = `import(${JSON.stringify(pdf)}).then(async ({ pdfDocument }) => {
    const { loadBundle } = await import(${JSON.stringify(new URL("../../lib/validation.mjs", import.meta.url).href)});
    const bundle = await loadBundle(${JSON.stringify(f.args)});
    try { await pdfDocument(bundle, { browserExecutable: ${JSON.stringify(executablePath)} }); process.stdout.write("ok"); }
    catch (e) { process.stdout.write(e.code + ": " + e.message); }
  });`;
  // Deny-default outer profile like a host agent's sandboxed shell: temp writes allowed,
  // but a second (the browser's own) sandbox profile cannot be applied.
  const outer = `(version 1)(deny default)(allow file-read*)(allow file-write* (subpath "/dev") (subpath ${JSON.stringify(tmp)}) (subpath ${JSON.stringify(realpathSync(f.root))}))(allow process-exec)(allow process-fork)(allow sysctl-read)(allow mach-lookup)(allow signal (target self))(allow ipc-posix-shm)(allow iokit-open)`;
  const { stdout } = await exec("/usr/bin/sandbox-exec", ["-p", outer, process.execPath, "--input-type=module", "-e", script], { timeout: 100000 });
  assert.match(stdout, /^EXPORT_FAILED: .*cannot start inside this host sandbox/);
});
