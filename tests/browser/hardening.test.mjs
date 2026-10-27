import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fixture } from "../helpers.mjs";
import { exportReport } from "../../scripts/export.mjs";
import { render } from "../../scripts/render.mjs";
import { startServer } from "../../lib/server.mjs";
import { fileHash, jsonBytes, readJson } from "../../lib/io.mjs";
import { statements } from "../../lib/validation.mjs";

const execute = promisify(execFile);
const executablePath = process.env.TEST_BROWSER_EXECUTABLE;
const browserTest = { skip: !executablePath, timeout: 90000 };

async function nativeFixture(t, { codec = false, absent = false } = {}) {
  const f = await fixture({
    mutate(d) {
      d.request.outputLanguage = d.report.outputLanguage = "en";
      d.evidence.source.kind = "direct-media";
      d.evidence.source.canonicalUrl = "https://example.com/fixture.mp4";
      d.evidence.source.platformId = null;
      d.evidence.source.playback = { kind: "native", locator: "media:fixture" };
      d.request.source.value = d.evidence.source.canonicalUrl;
      d.request.policy.copyLocalMedia = !absent;
      const originals = d.evidence.segments;
      d.evidence.segments = Array.from({ length: 60 }, (_, i) => ({
        id: `seg-${String(i + 1).padStart(6, "0")}`,
        startMs: i * 100,
        endMs: (i + 1) * 100,
        speaker: null,
        text:
          i % 20 === 0
            ? originals[i / 20].text
            : `Transcript ${i}: ${"bounded readable source text ".repeat(10)}`,
      }));
      d.evidence.chunks[0].segmentIds = d.evidence.segments.map((s) => s.id);
      for (const statement of statements(d.report))
        for (const citation of statement.citations) {
          if (citation.id === "seg-000002") citation.id = "seg-000021";
          else if (citation.id === "seg-000003") citation.id = "seg-000041";
        }
    },
  });
  let running, browser;
  t.after(async () => {
    // Close the browser's media connections before waiting for the HTTP server.
    // Otherwise an active request can hide a failed assertion behind teardown's timeout.
    try { await browser?.close(); }
    finally {
      try { await running?.close(); }
      finally { await rm(f.root, { recursive: true, force: true }); }
    }
  });
  if (!absent) {
    const media = path.join(f.root, codec ? "unsupported.mkv" : "colors.mp4");
    const inputs = codec
      ? ["-f", "lavfi", "-i", "color=red:s=160x90:r=10:d=6", "-c:v", "ffv1"]
      : [
          "-f",
          "lavfi",
          "-i",
          "color=red:s=160x90:r=10:d=2",
          "-f",
          "lavfi",
          "-i",
          "color=green:s=160x90:r=10:d=2",
          "-f",
          "lavfi",
          "-i",
          "color=blue:s=160x90:r=10:d=2",
          "-filter_complex",
          "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
          "-map",
          "[v]",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-g",
          "10",
          "-movflags",
          "+faststart",
        ];
    await execute(
      "ffmpeg",
      ["-nostdin", "-hide_banner", "-loglevel", "error", ...inputs, media],
      { timeout: 30000 },
    );
    await writeFile(
      path.join(f.work, "manifest.json"),
      jsonBytes({
        sourceId: f.data.evidence.source.id,
        evidenceSha256: f.data.evidenceSha256,
        mediaPath: media,
        mediaSha256: await fileHash(media),
      }),
    );
    const { stdout: probe } = await execute(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name",
        "-of",
        "json",
        media,
      ],
      { timeout: 10000 },
    );
    t.diagnostic(
      JSON.stringify({
        mediaBytes: (await stat(media)).size,
        codec: JSON.parse(probe).streams[0].codec_name,
        durationSeconds: 6,
      }),
    );
  }
  await render(f.args);
  running = await startServer({ root: f.out });
  browser = await chromium.launch({
    executablePath,
    headless: true,
    chromiumSandbox: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.setDefaultTimeout(10000);
  const errors = [],
    external = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== new URL(running.url).origin) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  t.after(() => {
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  });
  return { ...f, running, page };
}

async function decoded(page, seconds, channel) {
  await page.waitForFunction(
    ({ seconds, channel }) => {
      const video = document.querySelector("video");
      if (
        !video ||
        video.readyState < 2 ||
        video.seeking ||
        Math.abs(video.currentTime - seconds) > 0.12
      )
        return false;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, 1, 1);
      const pixel = ctx.getImageData(0, 0, 1, 1).data;
      return (
        pixel[channel] > 80 &&
        pixel[channel] > pixel[(channel + 1) % 3] * 2 &&
        pixel[channel] > pixel[(channel + 2) % 3] * 2
      );
    },
    { seconds, channel },
  );
  const observation = await page
    .locator("video")
    .evaluate((video) => ({
      currentTime: video.currentTime,
      readyState: video.readyState,
      seeking: video.seeking,
      paused: video.paused,
      decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames,
    }));
  assert.equal(observation.paused, true);
  assert.ok(observation.decodedFrames > 0);
  return observation;
}

test(
  "native pre-ready and rapid ready seeks are last-click-wins with actual decoded color frames",
  browserTest,
  async (t) => {
    const f = await nativeFixture(t);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await f.page.route("**/media/**", async (route) => {
      await gate;
      await route.continue();
    });
    t.after(() => release());
    await f.page.goto(f.running.url);
    await f.page.evaluate(() => {
      for (const ms of [2000, 0, 4000])
        document.querySelector(`a.ts[data-ms="${ms}"]`).click();
    });
    assert.equal(
      await f.page.locator("video").evaluate((v) => v.readyState),
      0,
    );
    release();
    t.diagnostic(
      JSON.stringify({ preReadyLastSeek: await decoded(f.page, 4, 2) }),
    );
    await f.page.evaluate(() => {
      for (const ms of [0, 4000, 2000])
        document.querySelector(`a.ts[data-ms="${ms}"]`).click();
    });
    t.diagnostic(
      JSON.stringify({ readyLastSeek: await decoded(f.page, 2, 1) }),
    );
    assert.equal(await f.page.locator("#player-status").textContent(), "");
  },
);

test(
  "keyboard activation, focus restoration, pin layout and manual-scroll/follow interactions",
  browserTest,
  async (t) => {
    const { page, running } = await nativeFixture(t);
    t.diagnostic("Keyboard fixture ready");
    await page.goto(running.url);
    const trigger = page.locator('a.ts[data-ms="2000"]').first();
    await trigger.focus();
    await page.keyboard.press("Enter");
    await decoded(page, 2, 1);
    t.diagnostic("Keyboard citation activation and native seek completed");
    assert.equal(
      await page
        .locator("#close-source")
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page
        .locator("#pin-source")
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await page.keyboard.press("Space");
    assert.equal(
      await page.locator("#pin-source").getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await page
        .locator("body")
        .evaluate((e) => e.classList.contains("pinned")),
      true,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .locator("#close-source")
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    t.diagnostic("Pin control and responsive layout verified");
    await page.locator("#follow-playback").check();
    await page.waitForFunction(
      () =>
        document.querySelector("#transcript .current")?.id === "tx-seg-000021",
    );
    await page.locator("#transcript").evaluate((e) => {
      e.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -500 }));
      e.scrollTop = 0;
    });
    assert.equal(await page.locator("#follow-playback").isChecked(), false);
    await page.waitForTimeout(650); // More than two follow timer intervals; no auto-scroll after manual interaction.
    assert.equal(
      await page.locator("#transcript").evaluate((e) => e.scrollTop),
      0,
    );
    await page.locator("#follow-playback").check();
    await page.waitForFunction(
      () => document.getElementById("transcript").scrollTop > 100,
    );
    t.diagnostic("Manual-scroll cancellation and follow resumption verified");
    await page.locator("#transcript").focus();
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.locator("#follow-playback").isChecked(), false);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#source-panel").isVisible(), false);
    assert.equal(
      await trigger.evaluate((e) => e === document.activeElement),
      true,
    );
    assert.equal(
      await page.locator("#pin-source").getAttribute("aria-pressed"),
      "false",
    );
    assert.equal(
      await page
        .locator("body")
        .evaluate((e) => e.classList.contains("pinned")),
      false,
    );
    await page.locator("#open-source").focus();
    await page.keyboard.press("Space");
    await page.locator('.transcript-time[data-ms="4000"]').click();
    await decoded(page, 4, 2);
    t.diagnostic("Reopened source and transcript seek completed");
    await page.keyboard.press("Escape");
    assert.equal(
      await page
        .locator("#open-source")
        .evaluate((e) => e === document.activeElement),
      true,
    );
  },
);

for (const mode of ["unavailable", "codec"]) {
  test(
    `native ${mode} failure retains usable transcript and source timestamp fallback`,
    browserTest,
    async (t) => {
      const { page, running } = await nativeFixture(t, {
        absent: mode === "unavailable",
        codec: mode === "codec",
      });
      await page.goto(running.url);
      await page.locator('a.ts[data-ms="4000"]').first().click();
      await page.waitForFunction(() =>
        document
          .getElementById("player-status")
          .textContent.includes("Playback unavailable"),
      );
      const mediaError = await page
        .locator("video")
        .evaluate((v) => /** @type {HTMLVideoElement} */ (v).error?.code);
      assert.ok([2, 3, 4].includes(mediaError));
      assert.equal(await page.locator("#transcript p").count(), 60);
      assert.equal(
        await page.locator("#source-fallback").getAttribute("href"),
        "https://example.com/fixture.mp4#t=4",
      );
      await page.locator('.transcript-time[data-ms="2000"]').click();
      assert.match(
        await page.locator("#player-status").textContent(),
        /Playback unavailable/,
      );
      assert.equal(
        await page.locator("#source-fallback").getAttribute("href"),
        "https://example.com/fixture.mp4#t=2",
      );
      t.diagnostic(
        JSON.stringify({ mode, actualBrowserMediaError: mediaError }),
      );
    },
  );
}

test(
  "blocked YouTube API keeps the transcript fallback aligned with its latest timestamp button",
  browserTest,
  async (t) => {
    const f = await fixture();
    t.after(() => rm(f.root, { recursive: true, force: true }));
    await render(f.args);
    const running = await startServer({ root: f.out });
    t.after(() => running.close());
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      chromiumSandbox: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const blocked = [],
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === new URL(running.url).origin)
        return route.continue();
      blocked.push(route.request().url());
      return route.abort(); // Intercepted locally; no external request is sent.
    });
    await page.goto(running.url);
    await page.locator('a.ts[data-ms="2000"]').first().click();
    await page.waitForFunction(() =>
      document
        .getElementById("player-status")
        .textContent.includes("재생할 수 없습니다"),
    );
    await page.locator('.transcript-time[data-ms="4000"]').click();
    assert.equal(
      await page.locator("#source-fallback").getAttribute("href"),
      "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=4s",
    );
    assert.equal(await page.locator("#transcript p").count(), 3);
    assert.deepEqual(blocked, ["https://www.youtube.com/iframe_api"]);
    assert.deepEqual(errors, []);
  },
);

for (const mode of [
  "infinite-duration",
  "empty-seekable",
  "outside-seekable",
  "out-of-duration",
  "seek-throws",
  "metadata-timeout",
]) {
  test(
    `injected native ${mode} state exposes fallback instead of silently ignoring a requested seek`,
    browserTest,
    async (t) => {
      const { page, running } = await nativeFixture(t, { absent: true });
      await page.route("**/media/**", (route) =>
        route.fulfill({ status: 200, contentType: "video/mp4", body: "" }),
      );
      await page.goto(running.url);
      // Deliberately simulated HTMLMediaElement capability states, not codec/OS observations.
      await page.evaluate((mode) => {
        if (mode === "metadata-timeout") {
          const schedule = window.setTimeout.bind(window);
          window.setTimeout = (callback, delay, ...args) =>
            schedule(callback, delay === 15000 ? 50 : delay, ...args);
        }
        const create = document.createElement.bind(document);
        document.createElement = (name, ...args) => {
          const element = create(name, ...args);
          if (name === "video") {
            Object.defineProperty(element, "src", { set() {} });
            Object.defineProperty(element, "duration", {
              get: () =>
                mode === "infinite-duration"
                  ? Infinity
                  : mode === "out-of-duration"
                    ? 1
                    : 6,
            });
            Object.defineProperty(element, "readyState", {
              get: () => (mode === "metadata-timeout" ? 1 : 2),
            });
            Object.defineProperty(element, "seekable", {
              get: () => ({
                length: ["empty-seekable", "metadata-timeout"].includes(mode)
                  ? 0
                  : 1,
                start: () => (mode === "outside-seekable" ? 5 : 0),
                end: () => 6,
              }),
            });
            if (mode === "seek-throws")
              Object.defineProperty(element, "currentTime", {
                get: () => 0,
                set() {
                  throw new DOMException("fixture", "InvalidStateError");
                },
              });
            queueMicrotask(() => {
              element.dispatchEvent(new Event("loadedmetadata"));
              if (mode !== "metadata-timeout")
                element.dispatchEvent(new Event("canplay"));
            });
          }
          return element;
        };
      }, mode);
      await page.locator('a.ts[data-ms="2000"]').first().click();
      await page.waitForFunction(
        () =>
          document
            .getElementById("player-status")
            .textContent.includes("Playback unavailable"),
        null,
        { timeout: 1500 },
      );
      assert.equal(await page.locator("#transcript p").count(), 60);
      assert.equal(
        await page.locator("#source-fallback").getAttribute("href"),
        "https://example.com/fixture.mp4#t=2",
      );
    },
  );
}

test(
  "transient empty seekability retains the latest pending request until a range arrives (injected state)",
  browserTest,
  async (t) => {
    const { page, running } = await nativeFixture(t, { absent: true });
    await page.goto(running.url);
    await page.evaluate(() => {
      const create = document.createElement.bind(document);
      document.createElement = (name, ...args) => {
        const element = create(name, ...args);
        if (name === "video") {
          let available = false,
            position = 0;
          Object.defineProperty(element, "src", { set() {} });
          Object.defineProperty(element, "duration", { get: () => 6 });
          Object.defineProperty(element, "readyState", {
            get: () => (available ? 2 : 1),
          });
          Object.defineProperty(element, "seekable", {
            get: () => ({
              length: available ? 1 : 0,
              start: () => 0,
              end: () => 6,
            }),
          });
          Object.defineProperty(element, "currentTime", {
            get: () => position,
            set(value) {
              position = value;
            },
          });
          window.releaseFixtureRange = () => {
            available = true;
            element.dispatchEvent(new Event("progress"));
          };
          queueMicrotask(() =>
            element.dispatchEvent(new Event("loadedmetadata")),
          );
        }
        return element;
      };
    });
    await page.locator('a.ts[data-ms="2000"]').first().click();
    assert.match(
      await page.locator("#player-status").textContent(),
      /Preparing/,
    );
    await page
      .locator('a.ts[data-ms="4000"]')
      .first()
      .evaluate((e) => /** @type {HTMLElement} */ (e).click());
    assert.equal(await page.locator("video").evaluate((v) => v.currentTime), 0);
    await page.evaluate(() => window.releaseFixtureRange());
    assert.equal(await page.locator("video").evaluate((v) => v.currentTime), 4);
    assert.equal(await page.locator("#player-status").textContent(), "");
  },
);

test(
  "long PDF tables and code paginate without losing any row, code line or final sentinel",
  browserTest,
  async (t) => {
    const started = performance.now();
    const rows = 180,
      lines = 350;
    const f = await fixture({
      mutate(d) {
        d.request.outputLanguage = d.report.outputLanguage = "en";
        const s = (text) => ({
          text,
          attribution: "interpretation",
          citations: [{ kind: "segment", id: "seg-000001" }],
        });
        d.report.sections = [
          {
            id: "long-table",
            heading: "Long table acceptance",
            blocks: [
              {
                type: "table",
                columns: ["ROW_ID_HEADER", "Condition", "Result"],
                rows: Array.from({ length: rows }, (_, i) => [
                  s(`ROW${String(i).padStart(4, "0")}`),
                  s(
                    "A bounded condition that must wrap and remain visible across printed page boundaries.",
                  ),
                  s(i === rows - 1 ? "TABLE_FINAL_SENTINEL" : `Result ${i}`),
                ]),
              },
            ],
          },
          {
            id: "long-code",
            heading: "Long code acceptance",
            blocks: [
              {
                type: "code",
                language: "javascript",
                attribution: "interpretation",
                citations: [{ kind: "segment", id: "seg-000001" }],
                text:
                  Array.from(
                    { length: lines },
                    (_, i) => `const CODE${String(i).padStart(4, "0")} = ${i};`,
                  ).join("\n") + "\n// CODE_FINAL_SENTINEL",
              },
              { type: "paragraph", statement: s("DOCUMENT_FINAL_SENTINEL") },
            ],
          },
        ];
      },
    });
    t.after(() => rm(f.root, { recursive: true, force: true }));
    const result = await exportReport({
      ...f.args,
      "browser-executable": executablePath,
    });
    assert.equal(result.status, "ok");
    const pdf = path.join(f.out, "report.pdf");
    const { stdout: info } = await execute("pdfinfo", [pdf], {
      timeout: 10000,
    });
    const pages = Number(info.match(/Pages:\s+(\d+)/)[1]);
    assert.ok(pages >= 10 && pages < 100);
    const { stdout: text } = await execute("pdftotext", ["-layout", pdf, "-"], {
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    });
    for (let i = 0; i < rows; i++)
      assert.ok(
        text.includes(`ROW${String(i).padStart(4, "0")}`),
        `missing row ${i}`,
      );
    for (let i = 0; i < lines; i++)
      assert.ok(
        text.includes(`CODE${String(i).padStart(4, "0")}`),
        `missing code line ${i}`,
      );
    for (const sentinel of [
      "TABLE_FINAL_SENTINEL",
      "CODE_FINAL_SENTINEL",
      "DOCUMENT_FINAL_SENTINEL",
    ])
      assert.ok(text.includes(sentinel), sentinel);
    const textPages = text.split("\f").filter((s) => s.trim());
    assert.equal(textPages.length, pages);
    assert.ok(
      textPages.slice(-2).join("\n").includes("DOCUMENT_FINAL_SENTINEL"),
    );
    assert.ok(
      (text.match(/ROW_ID_HEADER/g) ?? []).length > 1,
      "table header must repeat on printed pages",
    );
    const { stdout: boxes } = await execute("pdftotext", ["-bbox", pdf, "-"], {
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    });
    let words = 0;
    for (const match of boxes.matchAll(
      /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g,
    )) {
      for (const word of match[3].matchAll(
        /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">/g,
      )) {
        words++;
        assert.ok(
          Number(word[1]) >= 0 &&
            Number(word[2]) >= 0 &&
            Number(word[3]) <= Number(match[1]) &&
            Number(word[4]) <= Number(match[2]),
          "text bounding box outside printed page",
        );
      }
    }
    assert.ok(
      words > 3000,
      "must actually inspect extracted word bounding boxes",
    );
    const manifest = (await readJson(path.join(f.out, "manifest.json"))).data;
    assert.equal(manifest.overallStatus, "completed");
    assert.equal(
      await fileHash(pdf),
      manifest.artifacts.find((a) => a.format === "pdf").sha256,
    );
    assert.ok(
      (await readFile(path.join(f.out, "index.html"), "utf8")).includes(
        'href="report.pdf"',
      ),
    );
    t.diagnostic(
      JSON.stringify({
        rows,
        codeLines: lines + 1,
        pages,
        pdfBytes: (await stat(pdf)).size,
        extractedTextBytes: Buffer.byteLength(text),
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  },
);
