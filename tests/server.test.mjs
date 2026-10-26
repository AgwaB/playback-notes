import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, rm, symlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { get } from "node:http";
import { fixture } from "./helpers.mjs";
import { render } from "../scripts/render.mjs";
import { startServer } from "../lib/server.mjs";
import { fileHash, jsonBytes } from "../lib/io.mjs";

test("loopback server denies cross-origin, unsafe paths, unsupported methods and symlink escapes", async (t) => {
  const f = await fixture();
  await render(f.args);
  await mkdir(path.join(f.out, "assets"));
  await symlink(f.args.evidence, path.join(f.out, "assets", "escape.png"));
  const running = await startServer({ root: f.out });
  t.after(async () => {
    await running.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const base = running.url.replace("index.html", "");
  const good = await fetch(running.url);
  assert.equal(good.status, 200);
  await good.text();
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
