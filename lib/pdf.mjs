import { chromium } from "playwright-core";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError, containedFile, regularFile } from "./io.mjs";
import { htmlDocument } from "./rendering.mjs";
import { isolatedEnvironment } from "./runtime.mjs";
import { statements } from "./validation.mjs";

// Standard Windows system locations Chrome reads at startup; none carries credentials.
const WINDOWS_SYSTEM = [
  "windir", "ComSpec", "PATHEXT", "SystemDrive", "ProgramData", "ProgramFiles",
  "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)",
  "CommonProgramW6432", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
];
/**
 * The browser gets the same fresh environment as every other local tool (no ambient
 * credentials, proxies or runtime options), with its home and temp in a private directory.
 * On Windows the standard system-location variables are kept and the per-user data
 * folders point into that directory too.
 */
function browserEnvironment(home) {
  const env = isolatedEnvironment(home);
  if (process.platform !== "win32") return env;
  const lookup = new Map(Object.keys(process.env).map((key) => [key.toLowerCase(), key]));
  for (const name of WINDOWS_SYSTEM) {
    const key = lookup.get(name.toLowerCase());
    if (key && process.env[key]) env[name] = process.env[key];
  }
  env.APPDATA = path.join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  return env;
}

export async function pdfDocument(bundle, { browserExecutable, fontDir } = {}) {
  if (!browserExecutable)
    throw new AppError(
      "PDF_RUNTIME_MISSING",
      "Provide --browser-executable for an installed Chromium browser. Nothing was downloaded.",
      3,
    );
  let executablePath;
  try {
    // Explicit host-selected tools may use normal package-manager aliases. Resolve
    // once and launch that file; report assets still obey their non-symlink rules.
    executablePath = await realpath(browserExecutable);
    await regularFile(executablePath, Number.MAX_SAFE_INTEGER);
    await access(executablePath, constants.X_OK);
  } catch {
    throw new AppError(
      "PDF_RUNTIME_MISSING",
      "The specified browser executable is unavailable.",
      3,
    );
  }
  const assets = new Map();
  let fontCss = "",
    bytes = 0;
  // Same rule as the HTML output: every cited frame (figure or inline citation) is printable.
  const referenced = new Set([
    ...bundle.report.sections
      .flatMap((s) => s.blocks)
      .filter((b) => b.type === "figure")
      .map((b) => b.frameId),
    ...statements(bundle.report).flatMap((s) =>
      s.citations.filter((c) => c.kind === "frame").map((c) => c.id),
    ),
  ]);
  for (const frame of bundle.evidence.frames.filter((f) =>
    referenced.has(f.id),
  )) {
    const file = await containedFile(
      bundle.workDir,
      frame.assetPath,
      20 * 1024 * 1024,
    );
    const body = await readFile(file);
    bytes += body.length;
    assets.set(`/${frame.assetPath}`, {
      body,
      contentType: frame.assetPath.endsWith(".png")
        ? "image/png"
        : "image/jpeg",
    });
  }
  if (fontDir) {
    const fonts = (await readdir(fontDir))
      .filter((name) => /\.(ttf|otf|woff2?)$/i.test(name))
      .sort();
    if (!fonts.length || fonts.length > 16)
      throw new AppError(
        "FONT_UNAVAILABLE",
        "The specified font directory needs 1–16 TTF, OTF or WOFF fonts.",
        3,
      );
    for (const [index, filename] of fonts.entries()) {
      const file = await containedFile(fontDir, filename, 32 * 1024 * 1024);
      const body = await readFile(file);
      bytes += body.length;
      const url = `/fonts/font-${index}${path.extname(filename).toLowerCase()}`;
      assets.set(url, { body, contentType: "application/octet-stream" });
      fontCss += `@font-face { font-family: ReportFont${index}; src: url('${url}'); font-display: block; }\n`;
    }
    fontCss += `body { font-family: ${fonts.map((_, index) => `ReportFont${index}`).join(",")}, sans-serif; }`;
  }
  if (bytes > 128 * 1024 * 1024)
    throw new AppError(
      "RESOURCE_LIMIT",
      "Print assets exceed the memory budget.",
    );
  let context, home, launching = false;
  try {
    // Like every other local tool, the browser gets a fresh environment (no ambient
    // credentials, proxies or runtime options); its home, temp, profile, downloads and
    // traces all live in one private directory that is removed afterwards.
    home = await mkdtemp(path.join(os.tmpdir(), "vs-pdf-"));
    if (process.platform === "win32")
      for (const dir of ["Roaming", "Local"])
        await mkdir(path.join(home, "AppData", dir), { recursive: true });
    launching = true;
    context = await chromium.launchPersistentContext(path.join(home, "profile"), {
      executablePath,
      headless: true,
      chromiumSandbox: true,
      timeout: 30000,
      env: browserEnvironment(home),
      downloadsPath: path.join(home, "downloads"),
      tracesDir: path.join(home, "traces"),
      javaScriptEnabled: false,
      serviceWorkers: "block",
    });
    launching = false;
    const html = htmlDocument(bundle, [], [], { print: true, fontCss });
    await context.route("**/*", async (route) => {
      let url;
      try {
        url = new URL(route.request().url());
      } catch {
        await route.abort();
        return;
      }
      if (url.origin !== "https://video-report.invalid") {
        await route.abort();
        return;
      }
      if (url.pathname === "/index.html") {
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: html,
        });
        return;
      }
      const asset = assets.get(url.pathname);
      if (asset) await route.fulfill(asset);
      else await route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    await page.goto("https://video-report.invalid/index.html", {
      waitUntil: "load",
      timeout: 30000,
    });
    await page.evaluate(async () => {
      await document.fonts.ready;
      for (const image of document.images) {
        image.loading = "eager";
        await image.decode();
      }
    });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      tagged: true,
      outline: true,
      timeout: 30000,
    });
    if (pdf.length < 100 || pdf.subarray(0, 5).toString() !== "%PDF-")
      throw new AppError("EXPORT_FAILED", "Browser did not produce a PDF.");
    return pdf;
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Chrome's own sandbox cannot start inside another macOS sandbox (e.g. Codex's
    // workspace-write shell): it aborts at launch. Say so only when the launch itself
    // failed and a nested sandbox is confirmed, not for unrelated failures.
    if (process.platform === "darwin" && launching) {
      const { confinedRuntimeStatus } = await import("./ingest-worker.mjs");
      if ((await confinedRuntimeStatus()).reason === "nested-sandbox")
        throw new AppError(
          "EXPORT_FAILED",
          "PDF rendering failed: the browser's own sandbox cannot start inside this host sandbox (for example Codex workspace-write). Run export outside the host sandbox; HTML and Markdown are unaffected.",
        );
    }
    throw new AppError(
      "EXPORT_FAILED",
      "PDF rendering failed. Check the explicitly selected browser, sandbox support, local fonts and images.",
    );
  } finally {
    // A failing close must neither replace the primary error nor skip removing the home.
    try {
      await context?.close();
    } catch {
      // The primary outcome is already decided.
    } finally {
      if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }
}
