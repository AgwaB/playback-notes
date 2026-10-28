import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileHash } from "../lib/io.mjs";

test("fileHash honours a deadline signal (round 7 F3: review hashing could outlive its budget)", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "a.bin");
  await writeFile(file, Buffer.alloc(1024 * 1024));
  assert.match(await fileHash(file), /^[a-f0-9]{64}$/);
  await assert.rejects(fileHash(file, AbortSignal.abort()), { name: "AbortError" });
});
