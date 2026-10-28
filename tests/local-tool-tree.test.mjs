import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fakeTool } from "./fake-tool.mjs";
import { runLocalTool } from "../lib/local-tool.mjs";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a timed-out local tool is stopped with the processes it started (round 7 F2)", {
  skip:
    process.platform === "win32" && "Windows stops the tree with taskkill /T",
}, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tool-tree-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A launcher that starts the "real" runtime and waits, like a GPU wrapper script.
  const launcher = await fakeTool(
    path.join(dir, "launcher"),
    `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
fs.writeFileSync('child.pid', String(child.pid));
setTimeout(() => {}, 60000);
`,
  );
  await assert.rejects(
    runLocalTool(launcher, [], { workDir: dir, timeoutMs: 3000 }),
    { code: "TIMEOUT" },
  );
  const childPid = Number(await readFile(path.join(dir, "child.pid"), "utf8"));
  for (let i = 0; i < 20 && alive(childPid); i++)
    await new Promise((r) => setTimeout(r, 100));
  const survived = alive(childPid);
  if (survived) process.kill(childPid, "SIGKILL");
  assert.equal(survived, false, "the launcher's child was stopped with it");
});

test("a launcher that exits but leaves a child holding its output is stopped with that child (round 8 R8-1)", {
  skip: process.platform === "win32" && "Windows stops the tree with taskkill /T",
}, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tool-tree-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const launcher = await fakeTool(path.join(dir, "launcher-exits"), `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
// The child inherits stdout/stderr, so the tool's pipes stay open after the launcher exits.
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
fs.writeFileSync('child.pid', String(child.pid));
child.unref();
process.exit(0);
`);
  await assert.rejects(runLocalTool(launcher, [], { workDir: dir, timeoutMs: 3000 }), { code: "TIMEOUT" });
  const childPid = Number(await readFile(path.join(dir, "child.pid"), "utf8"));
  for (let i = 0; i < 20 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 100));
  const survived = alive(childPid);
  if (survived) process.kill(childPid, "SIGKILL");
  assert.equal(survived, false, "the orphaned child was stopped with the tool's process group");
});

