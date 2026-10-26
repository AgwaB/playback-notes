import test from "node:test";
import assert from "node:assert/strict";
import { readDnsPinnedAddresses } from "@steipete/summarize-core";
import { createSourceNetwork } from "../lib/network.mjs";
import { fetchPinnedPost } from "../lib/pinned-post.mjs";

const code = (value) => (error) => error.code === value;
const lookup = async () => [{ address: "8.8.8.8", family: 4 }];

test("single-hop relay preserves status/redirect without following, and pins POST DNS (used by caption/token requests)", async () => {
  const calls = [];
  const network = createSourceNetwork({
    lookup,
    maxBytes: 1024,
    transport: async (url, init) => {
      calls.push({ url, init });
      assert.deepEqual(readDnsPinnedAddresses(init), [
        { address: "8.8.8.8", family: 4 },
      ]);
      return new Response("denied", {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      });
    },
  });
  const response = await network.buffered(
    "https://www.youtube.com/youtubei/v1/get_panel",
    {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, "{}");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /^http:\/\/127\.0\.0\.1\//, "redirect target is returned to the caller, never followed");
  assert.equal(network.receivedBytes, 8); // two request bytes + six response bytes
});

test("browser relay refuses private/mixed DNS before transport", async () => {
  let called = false;
  const network = createSourceNetwork({
    lookup: async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    transport: async () => {
      called = true;
      return new Response("wrong");
    },
  });
  await assert.rejects(() =>
    network.buffered("https://www.youtube.com/watch?v=jNQXAC9IVRw"),
  );
  assert.equal(called, false);
});

test("browser relay enforces declared/streamed/per-response and upload budgets", async () => {
  const declared = createSourceNetwork({
    lookup,
    maxBytes: 32,
    transport: async () =>
      new Response("x", { headers: { "content-length": "100" } }),
  });
  await assert.rejects(
    () => declared.buffered("https://www.youtube.com/"),
    code("RESOURCE_LIMIT"),
  );
  const actual = createSourceNetwork({
    lookup,
    maxBytes: 32,
    transport: async () => new Response("123456789"),
  });
  await assert.rejects(
    () => actual.buffered("https://www.youtube.com/", {}, 8),
    code("RESOURCE_LIMIT"),
  );
  const upload = createSourceNetwork({
    lookup,
    maxBytes: 2,
    transport: async () => {
      throw new Error("must not run");
    },
  });
  await assert.rejects(
    () =>
      upload.buffered("https://www.youtube.com/", {
        method: "POST",
        body: "123",
      }),
    code("RESOURCE_LIMIT"),
  );
});

test("POST extension refuses unpinned requests before opening a connection", async () => {
  await assert.rejects(
    () =>
      fetchPinnedPost("https://www.youtube.com/youtubei/v1/next", {
        method: "POST",
        body: "{}",
      }),
    code("INVALID_CONTRACT"),
  );
});
