import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

async function bounded(promise, ms = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), ms);
    })]);
  } catch (error) {
    return { error: error.name ?? "Error" };
  } finally {
    clearTimeout(timer);
  }
}

// Opt-in diagnostics for synthetic browser fixtures only. No retries, force clicks,
// time-budget extensions or changed scheduling of the assertions being investigated.
export function browserDiagnostics(t, browser) {
  const root = process.env.TEST_BROWSER_ARTIFACTS;
  const pages = [];
  const versions = { browser: browser.version(), node: process.version, platform: process.platform };
  t.diagnostic(JSON.stringify(versions));
  return {
    async track(page) {
      if (!root) return;
      await page.context().tracing.start({ screenshots: true, snapshots: true, sources: false });
      pages.push(page);
    },
    async finish() {
      if (!root) return;
      const dir = path.join(root, `report-${randomUUID()}`);
      try {
        await mkdir(dir, { recursive: true });
        const observations = [];
        for (const [index, page] of pages.entries()) {
          const state = await bounded(page.evaluate(() => ({
            visibility: document.visibilityState,
            focus: document.hasFocus(),
            activeElement: document.activeElement?.id,
            viewport: { width: innerWidth, height: innerHeight },
            controls: ["open-source", "close-source", "source-panel"].map((id) => {
              const element = document.getElementById(id);
              if (!element) return { id, missing: true };
              const rect = element.getBoundingClientRect();
              const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return { id, rect: rect.toJSON(), hidden: element.hidden, hit: element.contains(hit), scrollTop: element.scrollTop };
            }),
            media: [...document.querySelectorAll("video")].map((video) => ({ readyState: video.readyState, seeking: video.seeking, time: video.currentTime })),
          })));
          const frames = await bounded(page.evaluate(() => new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve({ advancing: true })));
          })));
          observations.push({ index, state, frames });
          await bounded(page.context().tracing.stop({ path: path.join(dir, `page-${index}.zip`) }), 5000);
        }
        await writeFile(path.join(dir, "state.json"), JSON.stringify({ ...versions, observations }, null, 2));
      } catch (error) {
        t.diagnostic(`Browser diagnostics could not be saved (${error.name ?? "Error"}).`);
      }
    },
  };
}
