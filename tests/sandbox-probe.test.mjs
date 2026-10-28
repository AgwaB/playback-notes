import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";

const cases = [
  {
    name: "success",
    code: 0,
    text: "",
    expected: { available: true, reason: null },
  },
  {
    name: "permission-refusal",
    code: 71,
    text: "sandbox-exec: sandbox_apply: Operation not permitted\n",
    reason: "nested-sandbox",
  },
  {
    name: "unrelated-exit",
    code: 1,
    text: "unrelated failure",
    reason: "probe-failed",
  },
  { name: "signal", code: null, text: "", reason: "probe-failed" },
  {
    name: "spawn-error",
    code: null,
    error: true,
    text: "",
    reason: "probe-failed",
  },
];
for (const c of cases)
  test(`sandbox probe distinguishes ${c.name} without exposing diagnostics`, {
    skip: process.platform !== "darwin",
  }, async (t) => {
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    t.mock.method(childProcess, "spawn", (file, args, options) => {
      assert.equal(file, "/usr/bin/sandbox-exec");
      assert.deepEqual(options.env, { PATH: "/usr/bin:/bin" });
      assert.equal(options.cwd, "/");
      const child = new EventEmitter();
      child.stderr = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stderr.end(c.text);
        if (c.error)
          child.emit("error", new Error("EAGAIN private diagnostic"));
        child.emit("close", c.code, c.code === null ? "SIGTERM" : null);
      });
      return child;
    });
    syncBuiltinESMExports();
    const { confinedRuntimeStatus } = await import(
      `../lib/ingest-worker.mjs?probe-${c.name}`
    );
    assert.deepEqual(
      await confinedRuntimeStatus(),
      c.expected ?? { available: false, reason: c.reason },
    );
  });
