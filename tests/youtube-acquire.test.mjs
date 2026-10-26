import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import {
  fetchYoutubeCaptions,
  mintYoutubeToken,
  downloadYoutubeAudio,
  reconcileCaptionDuration,
  confinedNodeCommand,
  relayWorkerFetch,
} from "../lib/ingest-worker.mjs";
import {
  extractSource,
  ingestionFingerprint,
  isolatedEnvironment,
  FAILURE_DETAILS,
} from "../lib/ingest.mjs";
import { normalizeRequest } from "../lib/validation.mjs";

const exec = promisify(execFile);
const videoId = "dQw4w9WgXcQ";
const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
const player = () => ({
  playabilityStatus: { status: "OK" },
  videoDetails: { videoId, title: "Fixture", lengthSeconds: "20" },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`,
          languageCode: "en",
          kind: "asr",
        },
        {
          baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ko`,
          languageCode: "ko",
        },
      ],
    },
  },
});
const html = (p = player()) =>
  `<script>var ytInitialPlayerResponse = ${JSON.stringify(p)};</script>`;
const json3 = (events) => JSON.stringify({ events });
const tmp = (prefix) => mkdtemp(path.join(os.tmpdir(), prefix));

test("opt-in token: one caption request carrying pot/c=WEB with browser headers; plain path untouched otherwise", async () => {
  const calls = [];
  const network = {
    text: async (url) => {
      calls.push(["text", url]);
      return html();
    },
    buffered: async (url, init) => {
      calls.push(["buffered", url, init.headers]);
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          json3([
            { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "hello" }] },
          ]),
        ),
      };
    },
  };
  const minted = [];
  const result = await fetchYoutubeCaptions(videoId, network, ["en"], {
    mint: async (id) => {
      minted.push(id);
      return { poToken: "tok_abc" };
    },
  });
  assert.deepEqual(minted, [videoId], "token is content-bound to this video");
  assert.equal(
    calls.filter((c) => c[0] === "buffered").length,
    1,
    "exactly one caption request",
  );
  const [, url, headers] = calls.find((c) => c[0] === "buffered");
  const u = new URL(url);
  assert.equal(u.searchParams.get("pot"), "tok_abc");
  assert.equal(u.searchParams.get("c"), "WEB");
  assert.equal(u.searchParams.get("fmt"), "json3");
  assert.equal(
    u.searchParams.get("lang"),
    "en",
    "language priority picks en even though it is auto-generated",
  );
  assert.match(headers["user-agent"], /Chrome/);
  assert.equal(headers.origin, "https://www.youtube.com");
  assert.ok(!("cookie" in headers));
  assert.equal(result.tokenUsed, true);
  assert.equal(result.automatic, true);

  const plainCalls = [];
  const plain = {
    text: async (url) => {
      plainCalls.push(url);
      return plainCalls.length === 1
        ? html()
        : json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "hi" }] }]);
    },
  };
  const r2 = await fetchYoutubeCaptions(videoId, plain, []);
  assert.equal(r2.tokenUsed, false);
  assert.ok(!plainCalls[1].includes("pot="));
  assert.match(
    plainCalls[1],
    /lang=ko/,
    "manual track wins when no language preference is given",
  );
});

test("token refusal and failed minting surface as access denials with fixed causes", async () => {
  const network = {
    text: async () => html(),
    buffered: async () => ({ status: 403, headers: {}, body: Buffer.alloc(0) }),
  };
  await assert.rejects(
    () =>
      fetchYoutubeCaptions(videoId, network, [], {
        mint: async () => ({ poToken: "t" }),
      }),
    (e) =>
      e.code === "SOURCE_ACCESS_DENIED" && e.detail === "transcript-refused",
  );
  const root = await tmp("mint-");
  try {
    // The child refuses an invalid binding before any network use.
    await assert.rejects(
      () => mintYoutubeToken("bad id!", { workDir: root, timeoutMs: 20000 }),
      (e) => e.code === "INVALID_CONTRACT",
    );
    // Real confined worker, offline: its challenge request arrives through the parent relay
    // (host-checked, POST) and a refusal there ends the mint as an access denial.
    const seen = [];
    const refusing = {
      buffered: async (url, init) => {
        seen.push({ url, method: init.method });
        return { status: 403, headers: {}, body: Buffer.from("denied") };
      },
      receivedBytes: 0,
    };
    await assert.rejects(
      () =>
        mintYoutubeToken(videoId, {
          workDir: root,
          timeoutMs: 30000,
          network: refusing,
        }),
      (e) => e.code === "SOURCE_ACCESS_DENIED",
    );
    assert.equal(seen.length, 1);
    assert.equal(new URL(seen[0].url).hostname, "www.youtube.com");
    assert.equal(seen[0].method, "POST");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  for (const key of [
    "botguard-challenge",
    "botguard-integrity",
    "botguard-mint",
    "botguard-failed",
    "download-failed",
  ])
    assert.ok(FAILURE_DETAILS[key]);
});

test("platform order is preserved: [ko, en] manual tracks with no preference select ko, and a preference still wins", async () => {
  const two = () => {
    const p = player();
    p.captions.playerCaptionsTracklistRenderer.captionTracks = [
      {
        baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ko`,
        languageCode: "ko",
        name: { simpleText: "Korean" },
      },
      {
        baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`,
        languageCode: "en",
        name: { runs: [{ text: "English" }] },
      },
    ];
    return p;
  };
  const requested = [];
  const network = {
    text: async (url) => {
      if (url.includes("/watch")) return html(two());
      requested.push(url);
      return '<transcript><text start="0" dur="1">x</text></transcript>';
    },
  };
  const a = await fetchYoutubeCaptions(videoId, network, []);
  assert.equal(a.language, "ko");
  const b = await fetchYoutubeCaptions(videoId, network, ["en"]);
  assert.equal(b.language, "en");
  assert.ok(
    requested[0].includes("lang=ko") && requested[1].includes("lang=en"),
  );
});

test("captions ending after the advertised length leave the duration unknown instead of clipping or failing", () => {
  const over = reconcileCaptionDuration(20000, [
    { startMs: 18000, endMs: 22000, text: "runs past" },
  ]);
  assert.equal(over.durationMs, null);
  assert.equal(over.warning.code, "DURATION_UNVERIFIED");
  const fine = reconcileCaptionDuration(20000, [
    { startMs: 18000, endMs: 20000, text: "ends on time" },
  ]);
  assert.deepEqual(fine, { durationMs: 20000, warning: null });
  assert.deepEqual(
    reconcileCaptionDuration(null, [{ startMs: 5, endMs: 9, text: "x" }]),
    { durationMs: null, warning: null },
  );
});

test("policy youtubeTokens is validated, participates in cache identity, and YouTube ASR needs an explicit yt-dlp", async () => {
  const base = {
    schemaVersion: 1,
    source: { kind: "url", value: watchUrl },
    mode: "briefing",
    outputLanguage: "ko",
  };
  assert.throws(
    () => normalizeRequest({ ...base, policy: { youtubeTokens: "cookies" } }),
    (e) => e.code === "INVALID_CONTRACT",
  );
  const off = await ingestionFingerprint(
    normalizeRequest({ ...base, policy: { youtubeTokens: "off" } }),
  );
  const on = await ingestionFingerprint(
    normalizeRequest({ ...base, policy: { youtubeTokens: "botguard" } }),
  );
  assert.notEqual(off, on);
  const root = await tmp("ytdlp-missing-");
  try {
    await assert.rejects(
      () =>
        extractSource(normalizeRequest({ ...base, policy: { asr: "local" } }), {
          workDir: root,
          localAsrExecutable: process.execPath,
          localAsrModel: process.execPath,
        }),
      (e) =>
        [
          "CAPABILITY_MISSING",
          "SOURCE_ACCESS_DENIED",
          "SOURCE_UNAVAILABLE",
          "TIMEOUT",
        ].includes(e.code),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("yt-dlp download streams to stdout with bounded, cookie-free arguments; bytes are metered while they arrive and the file is what this process wrote", async () => {
  const root = await tmp("ytdlp-e2e-");
  try {
    const wav = path.join(root, "fixture.wav");
    await exec(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2", "-y", wav],
      { env: isolatedEnvironment(root), timeout: 15000 },
    );
    const argLog = path.join(root, "ytdlp-args.json");
    const fakeYtDlp = path.join(root, "yt-dlp");
    await writeFile(
      fakeYtDlp,
      `#!${process.execPath}\nimport { writeFileSync, readFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nwriteFileSync(${JSON.stringify(argLog)}, JSON.stringify(args));\nif (args[args.indexOf("-o") + 1] !== "-") process.exit(7);\nprocess.stdout.write(readFileSync(${JSON.stringify(wav)}));\n`,
      { mode: 0o700 },
    );
    const policy = normalizeRequest({
      schemaVersion: 1,
      source: { kind: "url", value: watchUrl },
      mode: "briefing",
      outputLanguage: "ko",
      policy: { asr: "local", maxDownloadBytes: 50 * 1024 * 1024 },
    }).policy;
    const tool = { workDir: root, timeoutMs: 60000, signal: AbortSignal.timeout(60000) };
    const mediaPath = await downloadYoutubeAudio(videoId, { workDir: root, ytDlpExecutable: fakeYtDlp }, policy, tool);
    assert.equal(path.basename(mediaPath), "media.bin");
    assert.equal((await readFile(mediaPath)).equals(await readFile(wav)), true, "the saved bytes are exactly the stream");
    const args = JSON.parse(await readFile(argLog, "utf8"));
    for (const flag of ["--ignore-config", "--no-plugin-dirs", "--no-playlist", "--no-cache-dir", "--no-update", "--no-remote-components", "--max-filesize", "-f", "bestaudio[protocol=https]", "-o", "-", "--"])
      assert.ok(args.includes(flag), flag);
    assert.ok(!args.includes("bestaudio/best") && !args.includes("bestaudio"), "no fallback to muxed video or fragmented formats");

    assert.ok(!args.some((a) => a.includes("%(")), "no output template at all: nothing for yt-dlp to expand");
    assert.equal(args[args.indexOf("--max-filesize") + 1], String(50 * 1024 * 1024));
    assert.ok(args.some((a) => a.startsWith("node:")), "JS runtime is this Node binary");
    assert.ok(!args.some((a) => /cookie|po_token|proxy|impersonate/.test(a)), "no cookies, proxies, impersonation or hand-passed tokens");
    assert.equal(args.at(-1), watchUrl);
    await rm(mediaPath);
    // A tool that exits non-zero (no acceptable format, refused) is a download failure with its fixed cause.
    const failing = path.join(root, "yt-dlp-fail");
    await writeFile(failing, `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
    await assert.rejects(
      () => downloadYoutubeAudio(videoId, { workDir: root, ytDlpExecutable: failing }, policy, tool),
      (e) => e.code === "SOURCE_ACCESS_DENIED" && e.detail === "download-failed",
    );
    assert.ok(!(await readdir(root)).includes("media.bin"), "nothing left behind after a failed tool");
    // A leftover file from an earlier attempt is refused, never overwritten.
    await writeFile(mediaPath, "stale");
    await assert.rejects(
      () => downloadYoutubeAudio(videoId, { workDir: root, ytDlpExecutable: fakeYtDlp }, policy, tool),
      (e) => e.code === "INVALID_CONTRACT",
    );
    assert.equal(await readFile(mediaPath, "utf8"), "stale");
    await rm(mediaPath);
    // A fake that streams nothing is a download failure with a fixed cause; nothing is left behind.
    const empty = path.join(root, "yt-dlp-empty");
    await writeFile(empty, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
    await assert.rejects(
      () => downloadYoutubeAudio(videoId, { workDir: root, ytDlpExecutable: empty }, policy, tool),
      (e) => e.code === "SOURCE_ACCESS_DENIED" && e.detail === "download-failed",
    );
    assert.ok(!(await readdir(root)).includes("media.bin"));
    // The byte budget is enforced while bytes arrive: an 8 KiB stream under a 1 KiB cap is
    // cut off (the tool is killed) and the partial file removed — not checked afterwards.
    const oversized = path.join(root, "yt-dlp-big");
    await writeFile(oversized, `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(8192), () => setTimeout(() => process.exit(0), 2000));\n`, { mode: 0o700 });
    await assert.rejects(
      () => downloadYoutubeAudio(videoId, { workDir: root, ytDlpExecutable: oversized }, { ...policy, maxDownloadBytes: 1024 }, tool),
      (e) => e.code === "RESOURCE_LIMIT",
    );
    assert.ok(!(await readdir(root)).includes("media.bin"), "partial output is removed");
    // Files a fake tool writes on its own are not the download: only the metered stream counts.
    const rogue = path.join(root, "yt-dlp-rogue");
    await writeFile(rogue, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(path.join(root, "media.m4a"))}, Buffer.alloc(16));\nprocess.exit(0);\n`, { mode: 0o700 });
    await assert.rejects(
      () => downloadYoutubeAudio(videoId, { workDir: root, ytDlpExecutable: rogue }, policy, tool),
      (e) => e.code === "SOURCE_ACCESS_DENIED" && e.detail === "download-failed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relay validation: only the two attestation endpoints on https://www.youtube.com, POST, allowlisted headers, string bodies ≤ 1 MiB, ≤ 8 requests", async () => {
  const calls = [];
  const network = {
    buffered: async (url, init) => {
      calls.push({ url, ...init });
      return { status: 200, headers: {}, body: Buffer.from("ok") };
    },
  };
  const good = { url: "https://www.youtube.com/api/jnn/v1/Create", method: "POST", headers: { "content-type": "application/json+protobuf", "x-goog-api-key": "k", "x-user-agent": "grpc-web-javascript/0.1", "user-agent": "ua" }, body: "[1]" };
  assert.deepEqual(await relayWorkerFetch(good, network, {}), { status: 200, text: "ok" });
  assert.equal(calls[0].headers["content-type"], "application/json+protobuf");
  assert.equal(calls[0].method, "POST");
  for (const [bad, code] of [
    [{ ...good, url: "https://evil.example/x" }, "UNSAFE_URL"],
    [{ ...good, url: "http://www.youtube.com/api/jnn/v1/Create" }, "UNSAFE_URL"],
    [{ ...good, url: "https://www.youtube.com:80/api/jnn/v1/Create" }, "UNSAFE_URL"],
    [{ ...good, url: "https://www.youtube.com.evil.example/api/jnn/v1/Create" }, "UNSAFE_URL"],
    [{ ...good, url: "https://www.youtube.com/watch?v=x" }, "UNSAFE_URL"],
    [{ ...good, url: "https://www.youtube.com/api/jnn/v1/Create?x=1" }, "UNSAFE_URL"],
    [{ ...good, url: 123 }, "UNSAFE_URL"],
    [{ ...good, method: "GET" }, "INVALID_CONTRACT"],
    [{ ...good, headers: { ...good.headers, cookie: "a=b" } }, "INVALID_CONTRACT"],
    [{ ...good, headers: { ...good.headers, host: "evil.example" } }, "INVALID_CONTRACT"],
    [{ ...good, headers: { ...good.headers, "content-length": "0" } }, "INVALID_CONTRACT"],
    [{ ...good, headers: { ...good.headers, "transfer-encoding": "chunked" } }, "INVALID_CONTRACT"],
    [{ ...good, headers: { "content-type": "a\r\nInjected: 1" } }, "INVALID_CONTRACT"],
    [{ ...good, headers: { "Content-Type": "a", "content-type": "b" } }, "INVALID_CONTRACT"],
    [{ ...good, headers: ["x"] }, "INVALID_CONTRACT"],
    [{ ...good, body: "x".repeat(1024 * 1024 + 1) }, "RESOURCE_LIMIT"],
    [{ ...good, body: "😀".repeat(300000) }, "RESOURCE_LIMIT"],
    [{ ...good, body: { a: 1 } }, "RESOURCE_LIMIT"],
    [{ ...good, body: null }, "RESOURCE_LIMIT"],
  ])
    await assert.rejects(() => relayWorkerFetch(bad, network, {}), (e) => e.code === code, JSON.stringify(bad).slice(0, 80));
  const state = {};
  for (let i = 0; i < 8; i++) await relayWorkerFetch(good, network, state);
  await assert.rejects(() => relayWorkerFetch(good, network, state), (e) => e.code === "RESOURCE_LIMIT");
});

test("hostile worker output never crashes the parent: garbage, giant lines, control frames, bad ids, premature/duplicate results and non-zero exits are clean rejections; a cooperative child succeeds", async () => {
  const root = await tmp("hostile-");
  try {
    const ok = { buffered: async () => ({ status: 200, headers: {}, body: Buffer.from("{}") }), receivedBytes: 0 };
    const result = (token) => JSON.stringify({ type: "result", ok: true, value: { poToken: token } });
    const fetchMsg = (id) => JSON.stringify({ type: "fetch", id, url: "https://www.youtube.com/api/jnn/v1/Create", method: "POST", headers: { "content-type": "application/json+protobuf" }, body: "[]" });
    const cases = {
      garbage: [`process.stdout.write("not json\\n", () => process.exit(0))`, "SOURCE_ACCESS_DENIED"],
      giant: [`process.stdout.write("x".repeat(3 * 1024 * 1024))`, "RESOURCE_LIMIT"],
      control: [`process.stdout.write(JSON.stringify({ cmd: "NODE_HANDLE_ACK" }) + "\\n")`, "SOURCE_ACCESS_DENIED"],
      bigId: [`process.stdout.write(${JSON.stringify(fetchMsg(1e300))} + "\\n")`, "SOURCE_ACCESS_DENIED"],
      resultWhilePending: [`process.stdout.write(${JSON.stringify(fetchMsg(1))} + "\\n" + ${JSON.stringify(result("A".repeat(32)))} + "\\n"); setTimeout(() => process.exit(0), 300)`, "SOURCE_ACCESS_DENIED"],
      resultThenFail: [`process.stdout.write(${JSON.stringify(result("A".repeat(32)))} + "\\n", () => process.exit(3))`, "SOURCE_ACCESS_DENIED"],
      twoResults: [`process.stdout.write(${JSON.stringify(result("A".repeat(32)))} + "\\n" + ${JSON.stringify(result("B".repeat(32)))} + "\\n", () => process.exit(0))`, "SOURCE_ACCESS_DENIED"],
      badToken: [`process.stdout.write(${JSON.stringify(result("short"))} + "\\n", () => process.exit(0))`, "SOURCE_ACCESS_DENIED"],
      silentExit: [`process.exit(0)`, "SOURCE_ACCESS_DENIED"],
      // Round-3: valid JSON whose fields throw on string conversion must not escape the handler.
      coercingCode: [`process.stdout.write(JSON.stringify({ type: "result", ok: false, code: { toString: null } }) + "\\n", () => process.exit(1))`, "SOURCE_ACCESS_DENIED"],
      coercingHash: [`process.stdout.write(JSON.stringify({ type: "result", ok: true, value: { poToken: "A".repeat(32), interpreterHash: { toString: null } } }) + "\\n", () => process.exit(0))`, "SOURCE_ACCESS_DENIED"],
      arrayMessage: [`process.stdout.write("[1,2]\\n", () => process.exit(0))`, "SOURCE_ACCESS_DENIED"],
      invalidUtf8: [`process.stdout.write(Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]), () => process.exit(0))`, "SOURCE_ACCESS_DENIED"],
      duplicateId: [`process.stdout.write(${JSON.stringify(fetchMsg(1))} + "\\n" + ${JSON.stringify(fetchMsg(1))} + "\\n")`, "SOURCE_ACCESS_DENIED"],
      trailingGarbage: [`process.stdout.write(${JSON.stringify(result("A".repeat(32)))} + "\\nNOT JSON", () => process.exit(0))`, "SOURCE_ACCESS_DENIED"],
      wideLine: [`process.stdout.write(JSON.stringify({ type: "result", ok: true, value: { poToken: "A".repeat(32) }, pad: "界".repeat(1000000) }) + "\\n", () => process.exit(0))`, "RESOURCE_LIMIT"],
      trailingSpace: [`process.stdout.write(${JSON.stringify(result("A".repeat(32)))} + "\\n ", () => process.exit(0))`, "SOURCE_ACCESS_DENIED"],
      hang: [`setInterval(() => {}, 1000)`, "TIMEOUT"],
    };
    for (const [name, [code, expected]] of Object.entries(cases)) {
      const probe = path.join(root, `${name}.mjs`);
      await writeFile(probe, code);
      await assert.rejects(
        () => mintYoutubeToken(videoId, { workDir: root, timeoutMs: name === "hang" ? 1500 : 20000, network: ok, workerPath: probe }),
        (e) => e.code === expected,
        name,
      );
    }
    // Positive control: a cooperative child that relays one fetch and returns a token.
    const good = path.join(root, "good.mjs");
    await writeFile(good, `
      import { createInterface } from "node:readline";
      const lines = createInterface({ input: process.stdin });
      let step = 0;
      lines.on("line", (line) => {
        const m = JSON.parse(line);
        if (step++ === 0) { process.stdout.write(${JSON.stringify(fetchMsg(1))} + "\\n"); return; }
        if (m.type === "fetch-result" && m.id === 1 && m.status === 200 && m.text === "{}") {
          const line = Buffer.from(JSON.stringify({ type: "result", ok: true, value: { poToken: "C".repeat(40), interpreterHash: null }, note: "界" }) + "\\n");
          // Split inside the multi-byte character: byte framing must reassemble it.
          const cut = line.indexOf(Buffer.from("界")) + 1;
          process.stdout.write(line.subarray(0, cut), () => process.stdout.write(line.subarray(cut), () => process.exit(0)));
        }
        else process.exit(9);
      });
    `);
    const minted = await mintYoutubeToken(videoId, { workDir: root, timeoutMs: 20000, network: ok, workerPath: good });
    assert.equal(minted.poToken, "C".repeat(40));
    // U1: a record just under the per-record limit followed by a short record in the SAME
    // write is two valid records, not an oversized accumulator.
    const joined = path.join(root, "joined.mjs");
    await writeFile(joined, `
      const big = JSON.stringify({ type: "fetch", id: 1, url: "https://www.youtube.com/api/jnn/v1/Create", method: "POST", headers: { "content-type": "x" }, body: "b".repeat(1024 * 1024 - 100), pad: "p".repeat(900 * 1024) });
      const small = ${JSON.stringify(fetchMsg(2))};
      process.stdout.write(big + "\\n" + small + "\\n");
      let got = 0;
      process.stdin.on("data", (d) => { got += String(d).split("\\n").filter((l) => l.includes("fetch-result")).length; if (got === 2) process.stdout.write(${JSON.stringify(result("D".repeat(40)))} + "\\n", () => process.exit(0)); });
    `);
    const joinedMint = await mintYoutubeToken(videoId, { workDir: root, timeoutMs: 20000, network: ok, workerPath: joined });
    assert.equal(joinedMint.poToken, "D".repeat(40));
    // Pre-aborted callers never launch anything.
    const aborted = AbortSignal.abort();
    await assert.rejects(() => mintYoutubeToken(videoId, { workDir: root, timeoutMs: 20000, network: ok, workerPath: good, signal: aborted }), (e) => e.code === "CANCELLED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("confined worker command: no network, no writes, no reads outside its code, no child processes or workers", {
  skip: process.platform !== "darwin" && "macOS sandbox-exec only",
}, async () => {
  const root = await tmp("confined-");
  const http = await import("node:http");
  const server = http
    .createServer((_, res) => res.end("leak"))
    .listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    await writeFile(path.join(root, "secret.txt"), "secret");
    const probe = path.join(root, "probe.mjs");
    await writeFile(
      probe,
      `
      const fs = process.getBuiltinModule("node:fs"); const r = { pid: process.pid };
      try { fs.writeFileSync(${JSON.stringify(path.join(root, "x.txt"))}, "y"); r.write = "ALLOWED"; } catch (e) { r.write = e.code; }
      try { fs.readFileSync(${JSON.stringify(path.join(root, "secret.txt"))}); r.read = "ALLOWED"; } catch (e) { r.read = e.code; }
      try { process.getBuiltinModule("node:child_process").execSync("id"); r.spawn = "ALLOWED"; } catch (e) { r.spawn = e.code; }
      try { new (process.getBuiltinModule("node:worker_threads").Worker)("1", { eval: true }); r.worker = "ALLOWED"; } catch (e) { r.worker = e.code; }
      try { await fetch("http://127.0.0.1:${server.address().port}/"); r.local = "ALLOWED"; } catch (e) { r.local = e.cause?.code ?? e.name; }
      try { await fetch("https://www.youtube.com/", { signal: AbortSignal.timeout(5000) }); r.net = "ALLOWED"; } catch (e) { r.net = e.cause?.code ?? e.name; }
      process.send(r, () => process.exit(0));
    `,
    );
    const command = confinedNodeCommand(probe);
    const child = spawn(command.file, command.args, {
      cwd: root,
      env: isolatedEnvironment(root),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    const report = await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("close", (code) =>
        reject(new Error(`exited ${code} before reporting`)),
      );
    });
    assert.equal(
      report.pid,
      child.pid,
      "sandbox-exec execs node in place, so SIGKILL reaches it",
    );
    assert.equal(report.write, "ERR_ACCESS_DENIED");
    assert.equal(report.read, "ERR_ACCESS_DENIED");
    assert.equal(report.spawn, "ERR_ACCESS_DENIED");
    assert.equal(report.worker, "ERR_ACCESS_DENIED");
    assert.notEqual(report.local, "ALLOWED", `loopback fetch: ${report.local}`);
    assert.notEqual(report.net, "ALLOWED", `internet fetch: ${report.net}`);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
