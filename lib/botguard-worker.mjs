// Mints a content-bound YouTube Proof-of-Origin token by running Google's BotGuard
// attestation program (bgutils-js + jsdom), the same mechanism yt-dlp's PO-token plugins,
// YouTube.js, NewPipe and Invidious use. The obfuscated interpreter script is executed
// ONLY inside this confined child process, which the parent (ingest-worker.mjs) launches as
//   sandbox-exec (deny network, no writes, user/system data unreadable by deny list) →
//   node --permission (Node-level reads limited to its code tree, no child processes,
//   no workers, no addons) --max-old-space-size=256.
// This process has NO network of its own: every request is written as one JSON line to
// stdout and answered on stdin by the parent, which allowlists the endpoint and performs it
// on its DNS-pinned, byte-budgeted transport. Plain pipes are used deliberately: Node's
// privileged IPC channel would let the untrusted program send handle/ack control frames or
// unbounded records straight into the parent's decoder.
//
// Explicitly opt-in (`policy.youtubeTokens: "botguard"`); never run otherwise.
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo"; // YouTube web player's public BotGuard request key.
const ALLOWED = new Set(["www.youtube.com"]);

class WorkerError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
const fail = (code, message, detail) => {
  throw new WorkerError(code, message, detail);
};

const send = (message, callback) =>
  process.stdout.write(`${JSON.stringify(message)}\n`, callback);
/** Relay transport: the parent validates and performs each request; this side only waits. */
function createRelay(lines) {
  const pending = new Map();
  let next = 1;
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message?.type !== "fetch-result") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error)
      waiter.reject(
        new WorkerError(
          message.error.code ?? "SOURCE_ACCESS_DENIED",
          "Relayed request failed.",
          message.error.detail ?? null,
        ),
      );
    else waiter.resolve(message);
  });
  return async (url, init = {}) => {
    const parsed = URL.parse(String(url));
    if (
      !parsed ||
      parsed.protocol !== "https:" ||
      !ALLOWED.has(parsed.hostname)
    )
      fail("UNSAFE_URL", "BotGuard request outside the allowed host.");
    const id = next++;
    const reply = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({
        type: "fetch",
        id,
        url: parsed.href,
        method: init.method ?? "GET",
        headers: init.headers ?? {},
        body: init.body == null ? null : String(init.body),
      });
    });
    const text = reply.text;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => text,
      json: async () => {
        try {
          return JSON.parse(text);
        } catch {
          fail(
            "SOURCE_ACCESS_DENIED",
            "Attestation server returned non-JSON.",
            "botguard-challenge",
          );
        }
      },
    };
  };
}

export async function mintPoToken({ videoId }, fetchFunction) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId ?? ""))
    fail(
      "INVALID_CONTRACT",
      "A video ID is required for a content-bound token.",
    );
  const { getChallenge, BotGuardClient } = await import("bgutils-js/botguard");
  const { WebPoMinter } = await import("bgutils-js/webpo");
  const { buildURL, getHeaders } = await import("bgutils-js/utils");

  // BotGuard expects a browser-like global scope; jsdom provides it without loading resources.
  const dom = new JSDOM(
    '<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>',
    {
      url: "https://www.youtube.com/",
      referrer: "https://www.youtube.com/",
      pretendToBeVisual: true,
    },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin,
  });
  if (!Reflect.has(globalThis, "navigator"))
    Object.defineProperty(globalThis, "navigator", {
      value: dom.window.navigator,
    });

  const challenge = await getChallenge({
    fetchFunction,
    requestKey: REQUEST_KEY,
    useYouTubeAPI: true,
  });
  const interpreter =
    challenge.interpreterJavascript
      ?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!interpreter || !challenge.program || !challenge.globalName)
    fail(
      "SOURCE_ACCESS_DENIED",
      "BotGuard challenge was incomplete.",
      "botguard-challenge",
    );
  if (interpreter.length > 4 * 1024 * 1024)
    fail("RESOURCE_LIMIT", "BotGuard interpreter exceeds the script budget.");
  // Executing Google's attestation interpreter IS the feature (same as bgutils-js examples).
  // It runs with this process's confinement only: no network, no writes, no spawning.
  // ast-grep-ignore: no-global-eval-js
  new Function(interpreter)();
  const client = await BotGuardClient.create({
    program: challenge.program,
    globalName: challenge.globalName,
    globalObject: globalThis,
  });
  const webPoSignalOutput = [];
  const botguardResponse = await client.snapshot({ webPoSignalOutput });
  const integrity = await fetchFunction(buildURL("GenerateIT", true), {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  if (!integrity.ok)
    fail(
      "SOURCE_ACCESS_DENIED",
      "Integrity token request was refused.",
      "botguard-integrity",
    );
  const [
    integrityToken,
    estimatedTtlSecs,
    mintRefreshThreshold,
    websafeFallbackToken,
  ] = await integrity.json();
  if (typeof integrityToken !== "string" || !integrityToken)
    fail(
      "SOURCE_ACCESS_DENIED",
      "No integrity token was issued.",
      "botguard-integrity",
    );
  const minter = await WebPoMinter.create(
    {
      integrityToken,
      estimatedTtlSecs,
      mintRefreshThreshold,
      websafeFallbackToken,
    },
    webPoSignalOutput,
  );
  const poToken = await minter.mintAsWebsafeString(videoId);
  if (
    typeof poToken !== "string" ||
    poToken.length < 16 ||
    poToken.length > 512
  )
    fail("SOURCE_ACCESS_DENIED", "Minted token is malformed.", "botguard-mint");
  return { poToken, interpreterHash: challenge.interpreterHash ?? null };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const fetchFunction = createRelay(lines);
  lines.once("line", async (first) => {
    let input;
    try {
      input = JSON.parse(first);
    } catch {
      input = {};
    }
    try {
      const value = await mintPoToken(input ?? {}, fetchFunction);
      send({ type: "result", ok: true, value }, () => process.exit(0));
    } catch (error) {
      send(
        {
          type: "result",
          ok: false,
          code: error?.code ?? "SOURCE_ACCESS_DENIED",
          detail: error?.detail ?? null,
        },
        () => process.exit(1),
      );
    }
  });
}
