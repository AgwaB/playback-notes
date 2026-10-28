import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { artifact, atomicWrite, fileHash } from "../lib/io.mjs";

test("fileHash honours a deadline signal (round 7 F3: review hashing could outlive its budget)", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "a.bin");
  await writeFile(file, Buffer.alloc(1024 * 1024));
  assert.match(await fileHash(file), /^[a-f0-9]{64}$/);
  await assert.rejects(fileHash(file, AbortSignal.abort()), {
    name: "AbortError",
  });
});

for (const phase of ["before-write", "during-write", "after-sync"])
  test(`atomicWrite preserves the old output when cancelled ${phase}`, async (t) => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "atomic-deadline-")));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const target = path.join(dir, "review.json");
    await writeFile(target, "keep");
    const controller = new AbortController();
    let content = "replacement";
    if (phase === "before-write") controller.abort();
    if (phase === "during-write") content = (async function* () {
      yield "replacement";
      controller.abort();
    })();
    if (phase === "after-sync") {
      const handle = await open(target, "r");
      const prototype = Object.getPrototypeOf(handle);
      const sync = prototype.sync;
      await handle.close();
      t.mock.method(prototype, "sync", async function (...args) {
        await sync.apply(this, args);
        controller.abort();
      });
    }
    await assert.rejects(atomicWrite(dir, "review.json", content, controller.signal), { name: "AbortError" });
    assert.equal(await readFile(target, "utf8"), "keep");
    assert.deepEqual(await readdir(dir), ["review.json"], "no staged output remains");
  });

test("artifact verification passes its deadline to the final hash", async (t) => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "artifact-deadline-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "review.json"), "{}");
  const controller = new AbortController();
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  let checks = 0;
  t.mock.method(controller.signal, "throwIfAborted", () => {
    // First check is artifact entry; the next belongs to fileHash after path checks.
    if (++checks === 2) controller.abort();
    check();
  });
  await assert.rejects(artifact(dir, "review.json", "asr-review", "created", controller.signal), { name: "AbortError" });
  assert.equal(checks, 2);
});
