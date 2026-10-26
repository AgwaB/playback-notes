import https from "node:https";
import { Readable } from "node:stream";
import { readDnsPinnedAddresses } from "@steipete/summarize-core";
import { networkError, parseSourceUrl } from "./network.mjs";

// Core's pinned transport intentionally supports no request body. This narrow
// extension is only for allowlisted, read-only YouTube browser POST endpoints.
const agent = new https.Agent({ proxyEnv: {} });
export async function fetchPinnedPost(value, init) {
  const addresses = readDnsPinnedAddresses(init);
  if (
    !addresses?.length ||
    init.method !== "POST" ||
    typeof init.body !== "string" ||
    Buffer.byteLength(init.body) > 1024 * 1024
  )
    throw networkError("INVALID_CONTRACT", "Invalid bounded browser POST.");
  const url = parseSourceUrl(value);
  if (url.protocol !== "https:")
    throw networkError("UNSAFE_URL", "Browser POST requires HTTPS.");
  const pinned = addresses.map(({ address, family }) => ({
    address,
    family: family ?? 4,
  }));
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        agent,
        method: "POST",
        signal: init.signal,
        headers: init.headers,
        lookup: (_hostname, options, callback) => {
          if (options?.all) callback(null, pinned);
          else callback(null, pinned[0].address, pinned[0].family);
        },
      },
      (res) => {
        try {
          const status = res.statusCode ?? 200;
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value))
              for (const item of value) headers.append(name, item);
            else if (typeof value === "string") headers.set(name, value);
          }
          const empty = [204, 205, 304].includes(status);
          const response = new Response(empty ? null : Readable.toWeb(res), {
            status,
            headers,
          });
          if (empty) {
            res.on("error", reject);
            // Never drain a malformed body outside the shared byte meter.
            res.destroy();
          }
          resolve(response);
        } catch (error) {
          res.destroy();
          reject(error);
        }
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}
