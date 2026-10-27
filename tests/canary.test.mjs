import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fakeTool } from "./fake-tool.mjs";
import { classifyCanary, canary } from "../scripts/canary.mjs";

const err = (code, detail) =>
  Object.assign(new Error(code), detail ? { code, detail } : { code });

test("canary classification separates platform gates from broken adapters and caption-less videos", () => {
  assert.deepEqual(classifyCanary(null), { state: "ok", cause: null });
  assert.equal(
    classifyCanary(err("SOURCE_ACCESS_DENIED", "transcript-refused")).state,
    "blocked",
  );
  assert.equal(
    classifyCanary(err("SOURCE_ACCESS_DENIED", "bot-check")).state,
    "blocked",
  );
  assert.equal(
    classifyCanary(err("SOURCE_ACCESS_DENIED", "botguard-integrity")).state,
    "broken",
  );
  assert.equal(
    classifyCanary(err("SOURCE_ACCESS_DENIED", "player-unparsable")).state,
    "broken",
  );
  assert.equal(classifyCanary(err("INVALID_CONTRACT")).state, "broken");
  assert.equal(classifyCanary(err("CAPABILITY_MISSING")).state, "broken");
  assert.equal(classifyCanary(err("ASR_REQUIRED")).state, "no-captions");
  assert.equal(
    classifyCanary(err("TRANSCRIPT_UNAVAILABLE", "no-transcript")).state,
    "no-captions",
  );
  assert.equal(
    classifyCanary(err("SOURCE_UNAVAILABLE", "video-unavailable")).state,
    "unavailable",
  );
  assert.equal(
    classifyCanary(err("SOURCE_ACCESS_DENIED", "age-restricted")).state,
    "unavailable",
  );
});

test("fake tool executables preserve exact arguments, binary stdio and exit status", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fake 한글 ' tool "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = await fakeTool(
    path.join(root, "가짜 ' executable"),
    'process.stdin.pipe(process.stdout); process.stdin.on("end", () => { process.stderr.write(JSON.stringify(process.argv.slice(2))); process.exitCode = 37; });',
  );
  const args = ["", "space value", "한글", 'a"b', "\\", "end\\", 'a\\"b', "&|<>^%!\t\n"];
  const input = Buffer.from([0, 1, 2, 10, 13, 255]);
  const child = spawn(executable, args, { shell: false, windowsHide: true });
  const stdout = [], stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(input);
  assert.equal(await finished, 37);
  assert.deepEqual(Buffer.concat(stdout), input);
  assert.deepEqual(JSON.parse(Buffer.concat(stderr).toString("utf8")), args);
});

test("canary refuses local sources and probes yt-dlp with --simulate and the same bounded flags", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "canary-"));
  try {
    const local = path.join(root, "local.json");
    await writeFile(
      local,
      JSON.stringify({
        schemaVersion: 1,
        source: { kind: "local", value: "/tmp/x.mp4" },
        mode: "briefing",
        outputLanguage: "ko",
      }),
    );
    await assert.rejects(
      () => canary({ request: local, "work-dir": root }),
      (e) => e.code === "INVALID_CONTRACT",
    );
    const log = path.join(root, "args.json");
    const fake = await fakeTool(
      path.join(root, "yt-dlp"),
      `import { writeFileSync } from "node:fs";\nconst a = process.argv.slice(2);\nif (a[0] === "--version") { process.stdout.write("2099.01.01\\n"); process.exit(0); }\nwriteFileSync(${JSON.stringify(log)}, JSON.stringify(a));\n`,
    );
    // Use an unroutable private source so the caption probe fails fast and deterministically.
    const req = path.join(root, "req.json");
    await writeFile(
      req,
      JSON.stringify({
        schemaVersion: 1,
        source: {
          kind: "url",
          value: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        },
        mode: "briefing",
        outputLanguage: "ko",
        policy: { extractTimeoutMs: 1000 },
      }),
    );
    const out = await canary({
      request: req,
      "work-dir": root,
      "yt-dlp-executable": fake,
    }).catch((e) => e);
    assert.ok(
      out.issues,
      "returns an envelope even when the caption probe times out or fails",
    );
    const yt = out.issues.find((i) => i.code.startsWith("CANARY_YTDLP"));
    assert.equal(yt.code, "CANARY_YTDLP_OK");
    assert.match(yt.message, /2099\.01\.01/);
    const args = JSON.parse(await readFile(log, "utf8"));
    for (const flag of [
      "--simulate",
      "--ignore-config",
      "--no-plugin-dirs",
      "--no-playlist",
      "--no-cache-dir",
      "--no-remote-components",
      "--no-update",
    ])
      assert.ok(args.includes(flag), flag);
    assert.ok(!args.some((a) => /cookie|proxy/.test(a)));
    assert.equal(args.at(-1), "https://www.youtube.com/watch?v=jNQXAC9IVRw");
    // Fail closed: a rejected or non-YouTube URL never reaches yt-dlp, and the canonical
    // watch URL (not the request string) is what yt-dlp receives.
    await rm(log, { force: true });
    for (const value of [
      "http://127.0.0.1/private",
      "https://user:pw@www.youtube.com/watch?v=jNQXAC9IVRw",
      "https://example.com/watch?v=jNQXAC9IVRw",
    ]) {
      const bad = path.join(root, "bad.json");
      await writeFile(bad, JSON.stringify({ schemaVersion: 1, source: { kind: "url", value }, mode: "briefing", outputLanguage: "ko" }));
      await assert.rejects(
        () => canary({ request: bad, "work-dir": root, "yt-dlp-executable": fake }),
        (e) => e.code === "INVALID_CONTRACT",
        value,
      );
    }
    assert.ok(!(await readFile(log, "utf8").catch(() => null)), "yt-dlp was never invoked for rejected URLs");
    const tracking = path.join(root, "tracking.json");
    await writeFile(tracking, JSON.stringify({ schemaVersion: 1, source: { kind: "url", value: "https://youtu.be/jNQXAC9IVRw?si=tracker&t=5" }, mode: "briefing", outputLanguage: "ko", policy: { extractTimeoutMs: 1000 } }));
    await canary({ request: tracking, "work-dir": root, "yt-dlp-executable": fake }).catch((e) => e);
    assert.equal(JSON.parse(await readFile(log, "utf8")).at(-1), "https://www.youtube.com/watch?v=jNQXAC9IVRw");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
