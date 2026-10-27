import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, rm, symlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { get } from "node:http";
import { createHash } from "node:crypto";
import { fixture } from "./helpers.mjs";
import { render } from "../scripts/render.mjs";
import { startServer } from "../lib/server.mjs";
import { fileHash, jsonBytes } from "../lib/io.mjs";

test("loopback server denies cross-origin, unsafe paths, unsupported methods and symlink escapes", async (t) => {
  const f = await fixture();
  await render(f.args);
  await mkdir(path.join(f.out, "assets"));
  await symlink(process.platform === "win32" ? f.work : f.args.evidence,
    path.join(f.out, "assets", "escape.png"), process.platform === "win32" ? "junction" : "file");
  const running = await startServer({ root: f.out });
  t.after(async () => {
    await running.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const base = running.url.replace("index.html", "");
  const good = await fetch(running.url);
  assert.equal(good.status, 200);
  const html = await good.text();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const browserHash = createHash("sha256").update(script.replace(/\r\n?/g, "\n")).digest("base64");
  assert.ok(good.headers.get("content-security-policy").includes(`'sha256-${browserHash}'`),
    "CSP must hash browser-normalized newlines, including a CRLF checkout");
  assert.equal(good.headers.get("access-control-allow-origin"), null);
  assert.ok(
    good.headers
      .get("content-security-policy")
      .includes("frame-ancestors 'none'"),
  );
  for (const suffix of [
    "assets/escape.png",
    "evidence.json",
    "raw/extraction.json",
    ".write.lock",
    "%252e%252e/evidence.json",
    "assets%5Cescape.png",
  ]) {
    const response = await fetch(`${base}${suffix}`);
    await response.text();
    assert.equal(response.status, 404, suffix);
  }
  for (const headers of [
    { Origin: "https://evil.example" },
    { Host: "evil.example" },
    { "Sec-Fetch-Site": "cross-site" },
  ]) {
    const status = await new Promise((resolve, reject) => {
      get(running.url, { headers }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      }).on("error", reject);
    });
    assert.equal(status, 403, JSON.stringify(headers));
  }
  const post = await fetch(running.url, { method: "POST" });
  await post.text();
  assert.equal(post.status, 405);
  const noToken = await fetch(new URL("/", running.url));
  await noToken.text();
  assert.equal(noToken.status, 404);
});
test("only exact approved media is mapped, with Range and HEAD support", async (t) => {
  const f = await fixture();
  await render(f.args);
  const media = path.join(f.root, "test.mp4");
  await writeFile(media, "0123456789abcdef");
  const jobManifest = path.join(f.work, "manifest.json");
  await writeFile(
    jobManifest,
    jsonBytes({
      evidenceSha256: f.data.evidenceSha256,
      sourceId: f.data.evidence.source.id,
      mediaPath: media,
      mediaSha256: await fileHash(media),
    }),
  );
  const running = await startServer({ root: f.out, jobManifest });
  t.after(async () => {
    await running.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const url = running.url.replace(
    "index.html",
    `media/${f.data.evidence.source.id}`,
  );
  const range = await fetch(url, { headers: { Range: "bytes=2-5" } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "2345");
  const suffix = await fetch(url, { headers: { Range: "bytes=-3" } });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), "def");
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const invalid = await fetch(url, { headers: { Range: "bytes=100-200" } });
  await invalid.text();
  assert.equal(invalid.status, 416);
  const other = await fetch(url.replace("src-fixture", "other"));
  await other.text();
  assert.equal(other.status, 404);
});
test("a private manifest cannot be mistaken for a public report root", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(
    path.join(f.work, "manifest.json"),
    jsonBytes({
      schemaVersion: 1,
      sourceId: "src-fixture",
      mediaPath: "/private/source.mp4",
    }),
  );
  await assert.rejects(startServer({ root: f.work }), {
    code: "INVALID_CONTRACT",
  });
});

test("U8: an artifact edited out-of-band after startup is refused (409), not served under the old manifest", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await render(f.args);
  const running = await startServer({ root: f.out });
  t.after(() => running.close());
  assert.equal((await fetch(running.url)).status, 200);
  const file = path.join(f.out, "index.html");
  const original = await readFile(file);
  await writeFile(file, "<html>edited outside the writer</html>");
  const edited = await fetch(running.url);
  await edited.text();
  assert.equal(edited.status, 409);
  await writeFile(file, original);
  assert.equal((await fetch(running.url)).status, 200);
});

test("browser-blocked explicit ports are rejected before opening a listener", async () => {
  for (const port of [1, 22, 5060, 6000, 6667, 10080]) {
    await assert.rejects(startServer({ root: "unused-root", port }), {
      code: "INVALID_CONTRACT",
      message: /browser.*block/i,
    });
  }
});

test("port zero retries a browser-blocked OS allocation and releases the rejected listener", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await render(f.args);
  const { Server, createServer } = await import("node:http");
  const probe = createServer();
  let blockedPort;
  for (const port of [6667, 6000, 10080, 5060, 6666, 6668]) {
    try {
      await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", () => {
          probe.removeListener("error", reject);
          resolve();
        });
      });
      blockedPort = port;
      await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE" && error.code !== "EACCES") throw error;
    }
  }
  assert.ok(blockedPort, "a browser-blocked port must be available for the regression");
  const originalListen = Server.prototype.listen;
  const allocated = [];
  const listeningHosts = [];
  const listener = t.mock.method(Server.prototype, "listen", function (port, host, ...rest) {
    listeningHosts.push(host);
    this.once("listening", () => allocated.push(this.address().port));
    return originalListen.call(this, port === 0 && allocated.length === 0 ? blockedPort : port, host, ...rest);
  });
  const running = await startServer({ root: f.out });
  t.after(() => running.close());
  listener.mock.restore();
  assert.equal(allocated[0], blockedPort, "the first real listener uses the forbidden OS allocation");
  assert.notEqual(running.port, blockedPort, "the returned report URL must use a browser-readable port");
  assert.ok(allocated.length >= 2, "port zero must retry after an unsafe allocation");
  assert.ok(listeningHosts.every((host) => host === "127.0.0.1"));
  assert.equal(running.host, "127.0.0.1");
  assert.equal(running.server.listenerCount("error"), 0, "startup error handlers must not accumulate after retries");
  const response = await fetch(running.url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /근거 중심 영상 리포트/);
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(blockedPort, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
});

test("repeated browser-blocked allocations fail without leaving a listening server", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await render(f.args);
  const { Server } = await import("node:http");
  const originalAddress = Server.prototype.address;
  const servers = new Set();
  t.after(async () => {
    for (const server of servers)
      if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  const allocation = t.mock.method(Server.prototype, "address", function () {
    servers.add(this);
    return { ...originalAddress.call(this), port: 6667 };
  });
  await assert.rejects(startServer({ root: f.out }), {
    code: "HTTP_PORT_UNAVAILABLE",
  });
  allocation.mock.restore();
  assert.equal(allocation.mock.callCount(), 32, "retrying must be bounded");
  assert.equal(servers.size, 1);
  for (const server of servers) {
    assert.equal(server.listening, false, "the final rejected listener must be closed");
    assert.equal(server.listenerCount("error"), 0);
  }
});
