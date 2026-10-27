import http from "node:http";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import serveStatic from "serve-static";
import {
  AppError,
  containedFile,
  exists,
  fileHash,
  readJson,
  within,
} from "./io.mjs";

// https://fetch.spec.whatwg.org/#port-blocking (0 requests OS allocation).
const browserBlockedPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

async function publicInventory(base, snapshot) {
  const manifest = snapshot.data;
  const fields = new Set([
    "schemaVersion",
    "sourceId",
    "mode",
    "revision",
    "reportSha256",
    "evidenceSha256",
    "analysisSha256",
    "contentStatus",
    "requestedFormats",
    "copyLocalMedia",
    "publishTranscript",
    "renderer",
    "assets",
    "media",
    "artifacts",
    "issues",
    "overallStatus",
  ]);
  if (
    manifest.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(manifest.reportSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(manifest.evidenceSha256 ?? "") ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(manifest.sourceId ?? "") ||
    !Array.isArray(manifest.artifacts) ||
    !Array.isArray(manifest.assets) ||
    Object.keys(manifest).some((key) => !fields.has(key))
  )
    throw new AppError(
      "INVALID_CONTRACT",
      "Only a public report revision may be served; private job manifests are forbidden.",
    );
  // path → manifest hash; every artifact is re-hashed before each response (see below).
  const allow = new Map([["manifest.json", null]]);
  const names = {
    html: "index.html",
    markdown: "report.md",
    pdf: "report.pdf",
  };
  const register = async (entry) => {
    const file = await containedFile(base, entry.path, Number.MAX_SAFE_INTEGER);
    if ((await fileHash(file)) !== entry.sha256)
      throw new AppError(
        "EVIDENCE_MISMATCH",
        "Public artifact no longer matches the manifest.",
      );
    allow.set(entry.path, entry.sha256);
  };
  for (const entry of manifest.artifacts)
    if (["created", "reused"].includes(entry.status)) {
      if (entry.path !== names[entry.format])
        throw new AppError(
          "INVALID_CONTRACT",
          "Invalid public artifact inventory.",
        );
      await register(entry);
    }
  for (const entry of manifest.assets) {
    if (!/^assets\/[A-Za-z0-9_-]+\.(png|jpg|jpeg)$/.test(entry.path ?? ""))
      throw new AppError("INVALID_CONTRACT", "Invalid public image inventory.");
    await register(entry);
  }
  if (manifest.media !== null) {
    if (
      manifest.copyLocalMedia !== true ||
      manifest.media?.path !== `media/${manifest.sourceId}`
    )
      throw new AppError(
        "INVALID_CONTRACT",
        "Media copy is not authorized in this revision.",
      );
    await register(manifest.media);
  }
  if (!allow.has("index.html"))
    throw new AppError(
      "INVALID_CONTRACT",
      "No successful HTML report is available to serve.",
    );
  return { manifest, allow, sha256: snapshot.sha256 };
}

export async function startServer({ root, jobManifest = null, port = 0 }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new AppError("INVALID_CONTRACT", "Invalid HTTP port.", 4);
  if (browserBlockedPorts.has(port))
    throw new AppError("INVALID_CONTRACT", `Web browsers block HTTP port ${port}.`, 4);
  const base = await realpath(root);
  let inventory = await publicInventory(
    base,
    await readJson(await containedFile(base, "manifest.json")),
  );
  const manifest = inventory.manifest;
  let media = null;
  if (jobManifest) {
    const privateData = (await readJson(jobManifest)).data;
    if (
      privateData.evidenceSha256 !== manifest.evidenceSha256 ||
      privateData.sourceId !== manifest.sourceId
    )
      throw new AppError(
        "EVIDENCE_MISMATCH",
        "Server media mapping does not match this report.",
      );
    if (privateData.mediaPath) {
      const file = await realpath(privateData.mediaPath);
      if ((await fileHash(privateData.mediaPath)) !== privateData.mediaSha256)
        throw new AppError(
          "EVIDENCE_MISMATCH",
          "Original media changed since extraction.",
        );
      const snapshot = await stat(file);
      media = {
        file,
        size: snapshot.size,
        mtimeMs: snapshot.mtimeMs,
        route: `media/${manifest.sourceId}`,
      };
    }
  }
  const staticOptions = {
    dotfiles: "deny",
    fallthrough: false,
    index: false,
    redirect: false,
    acceptRanges: true,
    cacheControl: false,
  };
  const staticFiles = serveStatic(base, staticOptions);
  const mediaFiles = media
    ? serveStatic(path.dirname(media.file), staticOptions)
    : null;
  const token = randomBytes(24).toString("hex");
  const player = await readFile(
    new URL("../templates/player.js", import.meta.url),
  );
  // HTML parsing normalizes CRLF/CR to LF before the browser checks an inline hash.
  const scriptHash = createHash("sha256")
    .update(player.toString("utf8").replace(/\r\n?/g, "\n"))
    .digest("base64");
  let origin;
  const server = http.createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    });
  });
  async function route(req, res) {
    const deny = (code) => {
      res.writeHead(code);
      res.end();
    };
    if (!["GET", "HEAD"].includes(req.method)) {
      deny(405);
      return;
    }
    if (
      req.headers.host !== origin.slice("http://".length) ||
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      deny(403);
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent((req.url ?? "").split("?")[0]);
    } catch {
      deny(400);
      return;
    }
    const prefix = `/${token}/`;
    if (!pathname.startsWith(prefix)) {
      deny(404);
      return;
    }
    const relative = pathname.slice(prefix.length) || "index.html";
    if (
      relative.includes("\\") ||
      relative.includes("%") ||
      relative.includes("\0") ||
      relative.split("/").some((part) => !part || part.startsWith("."))
    ) {
      deny(404);
      return;
    }
    if (await exists(path.join(base, ".write.lock"))) {
      deny(503);
      return;
    }
    const currentManifest = await readJson(path.join(base, "manifest.json"));
    if (currentManifest.sha256 !== inventory.sha256) {
      const updated = await publicInventory(base, currentManifest);
      if (
        [
          "sourceId",
          "reportSha256",
          "evidenceSha256",
          "analysisSha256",
          "copyLocalMedia",
          "publishTranscript",
        ].some((key) => updated.manifest[key] !== manifest[key]) ||
        updated.manifest.renderer?.sha256 !== manifest.renderer?.sha256
      ) {
        deny(409);
        return;
      }
      inventory = updated;
    }
    if (!inventory.allow.has(relative) && relative !== media?.route) {
      deny(404);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'sha256-${scriptHash}' https://www.youtube.com https://s.ytimg.com; style-src 'unsafe-inline'; img-src 'self'; media-src 'self' http: https:; frame-src https://www.youtube.com; connect-src https://www.youtube.com; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    const done = (error) => {
      if (!res.headersSent) res.writeHead(error?.status === 416 ? 416 : 404);
      res.end();
    };
    if (media && relative === media.route) {
      const current = await stat(media.file);
      if (
        current.size !== media.size ||
        current.mtimeMs !== media.mtimeMs ||
        (await realpath(media.file)) !== media.file
      ) {
        deny(409);
        return;
      }
      req.url = `/${encodeURIComponent(path.basename(media.file))}`;
      mediaFiles(req, res, done);
      return;
    }
    const file = await containedFile(base, relative, Number.MAX_SAFE_INTEGER);
    if (!within(base, file)) {
      deny(404);
      return;
    }
    // Serve only bytes that still match the committed inventory: an artifact edited
    // out-of-band after startup is refused rather than served under the old manifest.
    const expected = inventory.allow.get(relative);
    if (expected && (await fileHash(file)) !== expected) {
      deny(409);
      return;
    }
    req.url = `/${relative}`;
    staticFiles(req, res, done);
  }
  let address;
  for (let attempt = 0; attempt < 32; attempt++) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    address = server.address();
    if (!browserBlockedPorts.has(address.port)) break;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    address = null;
  }
  if (!address)
    throw new AppError(
      "HTTP_PORT_UNAVAILABLE",
      "Could not allocate a browser-compatible loopback HTTP port.",
    );
  origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    url: `${origin}/${token}/index.html`,
    host: "127.0.0.1",
    port: address.port,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
