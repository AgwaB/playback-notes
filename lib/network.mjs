import { lookup as dnsLookup } from "node:dns/promises";
import {
  assertNetworkTargetAllowed,
  createNetworkGuardedFetch,
  fetchWithDnsPinnedAddresses,
  getNetworkAddressFamily,
  isBlockedNetworkAddress,
  isBlockedNetworkHostname,
  markFetchAsDnsPinned,
  attachDnsPinnedAddresses,
  readDnsPinnedAddresses,
} from "@steipete/summarize-core";

import { fetchPinnedPost } from "./pinned-post.mjs";

const redirects = new Set([301, 302, 303, 307, 308]);
/** `detail` is a fixed cause key (see FAILURE_DETAILS in ingest.mjs), never free text from a source. */
export function networkError(code, message, detail) {
  return Object.assign(
    new Error(message),
    detail ? { code, detail } : { code },
  );
}

/** Syntax-only check; the actual transport also checks and pins every DNS answer. */
export function parseSourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw networkError("UNSAFE_URL", "Source URL is invalid.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port)) ||
    isBlockedNetworkHostname(host) ||
    (!host.includes(".") && !host.includes(":")) ||
    (getNetworkAddressFamily(host) && isBlockedNetworkAddress(host))
  ) {
    throw networkError(
      "UNSAFE_URL",
      "Only credential-free public HTTP(S) sources are allowed.",
    );
  }
  url.hash = "";
  return url;
}

/** Conservative publication policy: no query/fragment-bearing source URL is exposed. */
export function publicSourceUrl(value) {
  const url = parseSourceUrl(value);
  return url.search || String(value).includes("#") ? null : url.href;
}

// DNS and socket failures that mean "this process cannot reach the network" (no network in
// a host sandbox, offline machine, unresolvable host) rather than a refused or unsafe source.
const OFFLINE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EAI_NONAME",
  "EPERM",
  "EACCES",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
]);
function offlineCause(error) {
  for (let e = error, i = 0; e && i < 6; e = e.cause, i++)
    if (OFFLINE_CODES.has(e.code)) return e.code;
  return null;
}
function networkUnavailable(code) {
  return networkError(
    "NETWORK_UNAVAILABLE",
    `The source could not be reached from this process (${code}): the host name did not resolve or the network is not permitted here. If the URL is right, the command environment probably has no network access (for example a host agent's sandboxed shell).`,
    "network-unavailable",
  );
}
/** Internal dependency injection is for offline tests, never exposed by the CLI/worker IPC. */
export function createSourceNetwork({
  maxBytes = 2 ** 31,
  timeoutMs = 120000,
  signal,
  lookup = (host) => dnsLookup(host, { all: true, verbatim: true }),
  transport,
} = {}) {
  let receivedBytes = 0;
  const deadline = AbortSignal.timeout(Math.min(timeoutMs, 2147483647));
  const activeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const boundedLookup = (hostname) =>
    new Promise((resolve, reject) => {
      const abort = () =>
        reject(
          networkError(
            signal?.aborted ? "CANCELLED" : "TIMEOUT",
            "Source lookup was interrupted.",
          ),
        );
      activeSignal.addEventListener("abort", abort, { once: true });
      if (activeSignal.aborted) abort();
      Promise.resolve()
        .then(() => lookup(hostname))
        .then(resolve, reject)
        .finally(() => activeSignal.removeEventListener("abort", abort));
    });
  // Use core's direct HTTP transport even for IP literals: it explicitly disables env proxies.
  const directFetch = async (input, init) => {
    if (readDnsPinnedAddresses(init))
      return init.body == null
        ? fetchWithDnsPinnedAddresses(input, init)
        : fetchPinnedPost(input, init);
    const host = parseSourceUrl(String(input)).hostname.replace(/^\[|\]$/g, "");
    return fetchWithDnsPinnedAddresses(
      input,
      attachDnsPinnedAddresses({ ...init }, [
        { address: host, family: getNetworkAddressFamily(host) },
      ]),
    );
  };
  // The guard library swallows a lookup error behind its own refusal, so each operation
  // records its own DNS failure (never shared between requests) to report "no network"
  // instead of an unsafe destination.
  const recordingLookup = (record) => (hostname) =>
    boundedLookup(hostname).catch((error) => {
      if (OFFLINE_CODES.has(error?.code)) record.code ??= error.code;
      throw error;
    });
  const baseFetch = markFetchAsDnsPinned(transport ?? directFetch);
  const guardedWith = (record) =>
    createNetworkGuardedFetch(baseFetch, {
      targetLabel: "Source",
      lookup: recordingLookup(record),
      maxRedirects: 0,
    });
  function account(size) {
    receivedBytes += size;
    if (receivedBytes > maxBytes)
      throw networkError(
        "RESOURCE_LIMIT",
        "Source exceeds the download byte budget.",
      );
  }
  async function validate(value) {
    const url = parseSourceUrl(value);
    const record = {};
    try {
      await assertNetworkTargetAllowed(url.href, {
        targetLabel: "Source",
        lookup: recordingLookup(record),
      });
    } catch (error) {
      if (["TIMEOUT", "CANCELLED"].includes(error.code)) throw error;
      const offline = offlineCause(error) ?? record.code;
      if (offline) throw networkUnavailable(offline);
      throw networkError(
        "UNSAFE_URL",
        "Source destination is not an allowed public address.",
      );
    }
    return url;
  }
  async function response(value) {
    let url = parseSourceUrl(value);
    const record = {};
    const guarded = guardedWith(record);
    try {
      for (let hop = 0; hop <= 5; hop++) {
        activeSignal.throwIfAborted();
        const res = await guarded(url.href, {
          redirect: "manual",
          signal: activeSignal,
          headers: {
            "user-agent": "video-summarizer/1",
            "accept-encoding": "identity",
          },
        });
        if (redirects.has(res.status)) {
          const location = res.headers.get("location");
          await res.body?.cancel();
          if (!location || hop === 5)
            throw networkError(
              "SOURCE_ACCESS_DENIED",
              "Source redirect could not be followed safely.",
            );
          // Core checks DNS; this extra check rejects credentials on every redirect, too.
          url = parseSourceUrl(new URL(location, url).href);
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel();
          throw networkError(
            "SOURCE_ACCESS_DENIED",
            "Source access was denied or unavailable.",
          );
        }
        const length = Number(res.headers.get("content-length"));
        if (Number.isFinite(length) && length > maxBytes - receivedBytes) {
          await res.body?.cancel();
          throw networkError(
            "RESOURCE_LIMIT",
            "Source exceeds the download byte budget.",
          );
        }
        return res;
      }
    } catch (error) {
      if (
        error.code &&
        ["UNSAFE_URL", "RESOURCE_LIMIT", "SOURCE_ACCESS_DENIED"].includes(
          error.code,
        )
      )
        throw error;
      if (signal?.aborted)
        throw networkError("CANCELLED", "Extraction was cancelled.");
      if (deadline.aborted)
        throw networkError("TIMEOUT", "Source extraction timed out.");
      const offline = offlineCause(error) ?? record.code;
      if (offline) throw networkUnavailable(offline);
      // Upstream error strings can contain a private URL. Never forward them.
      throw networkError(
        "SOURCE_ACCESS_DENIED",
        "Source could not be fetched through the guarded transport.",
      );
    }
  }
  async function consume(value, onChunk, perResponseLimit = maxBytes) {
    const res = await response(value);
    let count = 0;
    try {
      for await (const chunk of res.body ?? []) {
        activeSignal.throwIfAborted();
        count += chunk.length;
        account(chunk.length);
        if (count > perResponseLimit)
          throw networkError(
            "RESOURCE_LIMIT",
            "Source response exceeds its byte budget.",
          );
        await onChunk(chunk);
      }
    } catch (error) {
      if (error.code === "RESOURCE_LIMIT") throw error;
      if (signal?.aborted)
        throw networkError("CANCELLED", "Extraction was cancelled.");
      if (deadline.aborted)
        throw networkError("TIMEOUT", "Source extraction timed out.");
      throw networkError(
        "SOURCE_ACCESS_DENIED",
        "Source response could not be read.",
      );
    }
    return { headers: res.headers, bytes: count };
  }
  // Single-hop browser relay: callers allowlist each URL/method before this call.
  // Redirects are returned to the browser and must pass the same route policy again.
  async function buffered(value, init = {}, limit = maxBytes) {
    const url = parseSourceUrl(value);
    const record = {};
    const guarded = guardedWith(record);
    const chunks = [];
    let count = 0;
    try {
      activeSignal.throwIfAborted();
      if (init.body != null) account(Buffer.byteLength(init.body));
      const res = await guarded(url.href, {
        method: init.method ?? "GET",
        headers: { ...init.headers, "accept-encoding": "identity" },
        body: init.body,
        redirect: "manual",
        signal: activeSignal,
      });
      const length = Number(res.headers.get("content-length"));
      if (
        Number.isFinite(length) &&
        (length > limit || length > maxBytes - receivedBytes)
      ) {
        await res.body?.cancel();
        throw networkError(
          "RESOURCE_LIMIT",
          "Browser response exceeds its byte budget.",
        );
      }
      for await (const chunk of res.body ?? []) {
        activeSignal.throwIfAborted();
        count += chunk.length;
        account(chunk.length);
        if (count > limit)
          throw networkError(
            "RESOURCE_LIMIT",
            "Browser response exceeds its byte budget.",
          );
        chunks.push(Buffer.from(chunk));
      }
      return {
        status: res.status,
        headers: Object.fromEntries(res.headers),
        body: Buffer.concat(chunks),
      };
    } catch (error) {
      if (error.code === "RESOURCE_LIMIT" || error.code === "UNSAFE_URL")
        throw error;
      if (signal?.aborted)
        throw networkError("CANCELLED", "Browser relay was cancelled.");
      if (deadline.aborted)
        throw networkError("TIMEOUT", "Browser relay timed out.");
      const offline = offlineCause(error) ?? record.code;
      if (offline) throw networkUnavailable(offline);
      throw networkError(
        "SOURCE_ACCESS_DENIED",
        "Browser relay could not fetch an allowed public source.",
      );
    }
  }
  return {
    validate,
    consume,
    buffered,
    get receivedBytes() {
      return receivedBytes;
    },
    async text(value, limit = 8 * 1024 * 1024) {
      const chunks = [];
      await consume(
        value,
        (chunk) => {
          chunks.push(Buffer.from(chunk));
        },
        limit,
      );
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}
