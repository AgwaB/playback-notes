import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readdir,
  copyFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fakeTool } from "./fake-tool.mjs";
import { extractSource, FAILURE_DETAILS } from "../lib/ingest.mjs";
import { makeEvidence } from "../lib/evidence.mjs";
import {
  validateEvidence,
  validateData,
  normalizeRequest,
} from "../lib/validation.mjs";
import { assertPlayability, jpegSize } from "../lib/ingest-worker.mjs";
import { rankCaptionTracks } from "../lib/caption-tracks.mjs";
import { parseYoutubeCapture } from "../lib/youtube-capture.mjs";
import { isolatedEnvironment } from "../lib/ingest.mjs";

const exec = promisify(execFile);
let root, jobs, media, srt, tesseract;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ocr-test-"));
  jobs = path.join(root, "jobs");
  await mkdir(jobs);
  media = path.join(root, "slides.mp4");
  srt = path.join(root, "slides.srt");
  // Three hard scene cuts (red → green → blue), 2 s each: scene detection yields frames at ~2 s and ~4 s.
  await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x180:d=2",
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=320x180:d=2",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:d=2",
      "-filter_complex",
      "[0:v][1:v][2:v]concat=n=3:v=1:a=0",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      media,
    ],
    { env: isolatedEnvironment(root), timeout: 30000, shell: false },
  );
  await writeFile(
    srt,
    "1\n00:00:00,500 --> 00:00:01,500\nThis describes the first slide.\n",
  );
  // Mock tesseract: emits deterministic text per frame; repeats the second frame's text to exercise dedupe.
  tesseract = await fakeTool(
    path.join(root, "tesseract"),
    `const f=process.argv[2];const n=Number(/frame-(\\d+)/.exec(f)?.[1]??0);const texts={1:"Storage temperature is at most 20 C <script>x</script>",2:"Storage temperature is at most 20 C <script>x</script>",3:"a"};process.stdout.write(texts[n]??("frame text number "+n));\n`,
  );
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const request = (policy = {}) =>
  normalizeRequest({
    schemaVersion: 1,
    source: { kind: "local", value: media },
    mode: "briefing",
    outputLanguage: "en",
    formats: ["html"],
    transcriptFile: srt,
    policy: { asr: "off", ...policy },
  });

test("local OCR samples scene changes with ffmpeg, OCRs via the explicit executable, dedupes and keeps only readable frames", async () => {
  const work = path.join(jobs, "ocr");
  const result = await extractSource(request({ visual: "local-ocr" }), {
    workDir: work,
    tesseractExecutable: tesseract,
    ocrLanguages: "kor+eng",
    ocrSampleSeconds: 2,
  });
  assert.ok(result.frames.length >= 1, "at least one readable frame");
  const first = result.frames[0];
  assert.match(first.assetPath, /^assets\/frame-\d{4}\.jpg$/);
  assert.equal(first.ocrText, "Storage temperature is at most 20 C <script>x</script>");
  assert.ok(first.width === 320 && first.height === 180);
  assert.ok(
    Number.isInteger(first.timestampMs) &&
      first.timestampMs >= 0 &&
      first.timestampMs <= 6000,
  );
  assert.equal(
    result.frames.filter((f) => f.ocrText.includes("20 C")).length,
    1,
    "duplicate frame text suppressed",
  );
  assert.ok(
    !result.frames.some((f) => f.ocrText === "a"),
    "sub-threshold text dropped",
  );
  assert.ok(
    result.extraction.warnings.some((w) => w.code === "VISUAL_OCR_UNVERIFIED"),
  );
  assert.equal(result.raw.visualOcr.languages, "kor+eng");
  const files = await readdir(path.join(result.assetRoot, "assets"));
  assert.deepEqual(
    files.sort(),
    result.frames.map((f) => path.basename(f.assetPath)).sort(),
    "only kept frames remain on disk",
  );
  const evidence = makeEvidence(result);
  assert.equal(evidence.frames.length, result.frames.length);
  assert.doesNotThrow(() => validateEvidence(evidence));
  assert.ok(
    evidence.segments.length === 1,
    "transcript still present alongside frames",
  );
});

test("visual-only evidence (no transcript, ASR off) is accepted when frames carry OCR text; host must inspect to cite", async () => {
  const work = path.join(jobs, "ocr-only");
  const req = normalizeRequest({
    schemaVersion: 1,
    source: { kind: "local", value: media },
    mode: "briefing",
    outputLanguage: "en",
    formats: ["html"],
    policy: { asr: "off", visual: "local-ocr" },
  });
  const result = await extractSource(req, {
    workDir: work,
    tesseractExecutable: tesseract,
    ocrSampleSeconds: 2,
  });
  assert.equal(result.segments.length, 0);
  assert.equal(result.extraction.method, "none");
  assert.equal(result.extraction.provider, "video-summarizer/visual-ocr");
  const evidence = makeEvidence(result);
  assert.equal(evidence.chunks.length, 0);
  const frame = evidence.frames[0];
  const report = {
    schemaVersion: 1,
    evidenceRef: { id: evidence.id, sha256: "0".repeat(64) },
    mode: "briefing",
    outputLanguage: "en",
    title: "t",
    summary: [
      {
        text: "The on-screen text says the storage temperature is at most 20 C.",
        attribution: "source",
        citations: [{ kind: "frame", id: frame.id }],
      },
    ],
    sections: [
      {
        id: "s",
        heading: "h",
        blocks: [
          {
            type: "figure",
            frameId: frame.id,
            alt: "slide",
            caption: {
              text: "Slide",
              attribution: "source",
              citations: [{ kind: "frame", id: frame.id }],
            },
          },
        ],
      },
    ],
    caveats: [],
  };
  const analysis = {
    schemaVersion: 1,
    evidenceId: evidence.id,
    reviewedChunkIds: [],
    inspectedFrameIds: [frame.id],
    status: "complete",
    limitations: [],
  };
  assert.doesNotThrow(() =>
    validateData({
      request: req,
      evidence,
      analysis,
      report,
      evidenceSha256: "0".repeat(64),
    }),
  );
  await assert.rejects(
    async () =>
      validateData({
        request: req,
        evidence,
        analysis: { ...analysis, inspectedFrameIds: [] },
        report,
        evidenceSha256: "0".repeat(64),
      }),
    (e) => e.code === "UNCONFIRMED_FRAME",
  );
});

test("OCR refuses missing executable, bad language lists and platform sources; nothing is installed", async () => {
  await assert.rejects(
    () =>
      extractSource(request({ visual: "local-ocr" }), {
        workDir: path.join(jobs, "no-exe"),
      }),
    (e) => e.code === "CAPABILITY_MISSING",
  );
  await assert.rejects(
    () =>
      extractSource(request({ visual: "local-ocr" }), {
        workDir: path.join(jobs, "bad-lang"),
        tesseractExecutable: tesseract,
        ocrLanguages: "kor;rm -rf",
      }),
    (e) => e.code === "INVALID_CONTRACT",
  );
  const yt = normalizeRequest({
    schemaVersion: 1,
    source: {
      kind: "url",
      value: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    },
    mode: "briefing",
    outputLanguage: "en",
    formats: ["html"],
    transcriptFile: srt,
    policy: { asr: "off", visual: "local-ocr" },
  });
  // YouTube frames/OCR need an explicit yt-dlp (low-res video stream); never implicit.
  await assert.rejects(
    () =>
      extractSource(yt, {
        workDir: path.join(jobs, "yt"),
        tesseractExecutable: tesseract,
      }),
    (e) => e.code === "CAPABILITY_MISSING",
  );
  assert.deepEqual(
    jpegSize(
      Buffer.from([
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xb4, 0x01, 0x40, 0x03,
      ]),
    ),
    { height: 180, width: 320 },
  );
  assert.equal(jpegSize(Buffer.from("not a jpeg")), null);
});

test("caption track ranking follows youtube-transcript-api order: language priority, then manual before auto", () => {
  const tracks = [
    { languageCode: "en", automatic: true, label: "English (auto-generated)" },
    { languageCode: "ko", automatic: false, label: "Korean" },
    { languageCode: "en", automatic: false, label: "English" },
    { languageCode: "ja", automatic: false, label: "Japanese" },
  ];
  assert.deepEqual(
    rankCaptionTracks(tracks, ["en", "ko"]).map((t) => t.label),
    ["English", "English (auto-generated)", "Korean", "Japanese"],
  );
  assert.deepEqual(
    rankCaptionTracks(tracks, ["ko"]).map((t) => t.label),
    ["Korean", "English", "Japanese", "English (auto-generated)"],
  );
  assert.deepEqual(
    rankCaptionTracks(tracks, []).map((t) => t.label),
    ["Korean", "English", "Japanese", "English (auto-generated)"],
  );
  assert.deepEqual(
    rankCaptionTracks(
      [
        { languageCode: "en-US", automatic: false },
        { languageCode: "en", automatic: true },
      ],
      ["en"],
    ).map((t) => t.languageCode),
    ["en-US", "en"],
  );
});

test("playability mapping distinguishes bot check, age restriction, unavailable and unplayable with fixed causes", () => {
  const code = (fn) => {
    try {
      fn();
    } catch (e) {
      return [e.code, e.detail];
    }
    return null;
  };
  assert.equal(
    code(() => assertPlayability({ status: "OK" })),
    null,
  );
  assert.equal(
    code(() => assertPlayability(null)),
    null,
  );
  assert.deepEqual(
    code(() =>
      assertPlayability({
        status: "LOGIN_REQUIRED",
        reason: "Sign in to confirm you’re not a bot",
      }),
    ),
    ["SOURCE_ACCESS_DENIED", "bot-check"],
  );
  assert.deepEqual(
    code(() =>
      assertPlayability({
        status: "LOGIN_REQUIRED",
        reason: "This video may be inappropriate for some users.",
      }),
    ),
    ["SOURCE_ACCESS_DENIED", "age-restricted"],
  );
  assert.deepEqual(
    code(() =>
      assertPlayability({
        status: "ERROR",
        reason: "This video is unavailable",
      }),
    ),
    ["SOURCE_UNAVAILABLE", "video-unavailable"],
  );
  assert.deepEqual(
    code(() =>
      assertPlayability({
        status: "UNPLAYABLE",
        reason:
          "The uploader has not made this video available in your country",
      }),
    ),
    ["SOURCE_UNAVAILABLE", "video-unplayable"],
  );
  for (const key of [
    "bot-check",
    "age-restricted",
    "video-unavailable",
    "video-unplayable",
    "no-transcript",
    "transcript-refused",
  ])
    assert.ok(FAILURE_DETAILS[key]);
});

test("captures may declare their track; asr tracks add the automatic-captions warning, bad kinds are rejected", () => {
  const req = {
    source: {
      kind: "url",
      value: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    },
  };
  const base = {
    schemaVersion: 1,
    videoId: "jNQXAC9IVRw",
    sourceUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    capturedAt: "2026-01-01T00:00:00.000Z",
    title: "t",
    durationMs: 20000,
    language: null,
    method: "transcript-dom",
    rows: [{ startLabel: "0:01", text: "hello" }],
  };
  const asr = parseYoutubeCapture(
    JSON.stringify({
      ...base,
      trackName: "English (auto-generated)",
      trackKind: "asr",
    }),
    req,
  );
  assert.ok(
    asr.extraction.warnings.some((w) => w.code === "AUTOMATIC_CAPTIONS"),
  );
  const manual = parseYoutubeCapture(
    JSON.stringify({ ...base, trackName: "English", trackKind: "manual" }),
    req,
  );
  assert.ok(
    !manual.extraction.warnings.some((w) => w.code === "AUTOMATIC_CAPTIONS"),
  );
  assert.ok(
    !parseYoutubeCapture(JSON.stringify(base), req).extraction.warnings.some(
      (w) => w.code === "AUTOMATIC_CAPTIONS",
    ),
    "older captures without track fields still import",
  );
  assert.throws(
    () =>
      parseYoutubeCapture(
        JSON.stringify({ ...base, trackKind: "generated" }),
        req,
      ),
    (e) => e.code === "INVALID_CONTRACT",
  );
});

test("scene mode always keeps the first frame, defaults to psm 6 through IPC (null options), and rejects a bad psm", async () => {
  const work = path.join(jobs, "scene");
  const result = await extractSource(request({ visual: "local-ocr" }), {
    workDir: work,
    tesseractExecutable: tesseract,
    ocrSceneThreshold: 0.05,
  });
  assert.equal(
    result.frames[0]?.timestampMs,
    0,
    "first frame is sampled even though scene detection never selects frame 0",
  );
  assert.equal(result.raw.visualOcr.psm, 6);
  assert.match(result.raw.visualOcr.selector, /eq\(n,0\)\+gt\(scene,0\.05\)/);
  await assert.rejects(
    () =>
      extractSource(request({ visual: "local-ocr" }), {
        workDir: path.join(jobs, "psm"),
        tesseractExecutable: tesseract,
        ocrPsm: 99,
      }),
    (e) => e.code === "INVALID_CONTRACT",
  );
});

test("visual-only outputs carry frame notices, inspected-frame scope and anchors for inline frame citations (no transcript boilerplate)", async () => {
  const { fixture } = await import("./helpers.mjs");
  const { htmlDocument } = await import("../lib/rendering.mjs");
  const { markdownDocument } = await import("../lib/markdown.mjs");
  const f = await fixture({
    mutate(d) {
      d.evidence.segments = [];
      d.evidence.chunks = [];
      d.evidence.extraction.timing = "none";
      d.evidence.extraction.method = "none";
      d.evidence.frames = [
        {
          id: "frame-0001",
          timestampMs: 1000,
          assetPath: "assets/frame-0001.jpg",
          sha256: "0".repeat(64),
          width: 320,
          height: 180,
          ocrText: "Rule 1: Store at or below 20 C",
        },
        {
          id: "frame-0002",
          timestampMs: 3000,
          assetPath: "assets/frame-0002.jpg",
          sha256: "0".repeat(64),
          width: 320,
          height: 180,
          ocrText: "Rule 2",
        },
      ];
      d.analysis.reviewedChunkIds = [];
      d.analysis.inspectedFrameIds = ["frame-0001", "frame-0002"];
      const cite = (id) => [{ kind: "frame", id }];
      d.report.summary = [
        {
          text: "The rule on card 1.",
          attribution: "source",
          citations: cite("frame-0001"),
        },
      ];
      d.report.sections = [
        {
          id: "s",
          heading: "Screen",
          blocks: [
            {
              type: "figure",
              frameId: "frame-0001",
              alt: "Card 1",
              caption: {
                text: "Card 1",
                attribution: "source",
                citations: cite("frame-0001"),
              },
            },
            {
              type: "paragraph",
              statement: {
                text: "Card 2 is also present.",
                attribution: "source",
                citations: cite("frame-0002"),
              },
            },
          ],
        },
      ];
      d.report.caveats = [];
    },
  });
  const html = htmlDocument(f.bundle);
  assert.ok(
    !html.includes("This document contains the source transcript."),
    "no transcript privacy notice",
  );
  assert.ok(html.includes("This document contains source frame images."));
  assert.ok(
    !html.includes("Some or all statements lack timestamps."),
    "no timing notice without a transcript",
  );
  assert.ok(html.includes("Inspected frames 2/2"));
  assert.equal(
    (html.match(/id="frame-frame-0002"/g) ?? []).length,
    1,
    "inline-cited frame gets exactly one anchor in the cited-frames section",
  );
  assert.equal(
    (html.match(/id="frame-frame-0001"/g) ?? []).length,
    1,
    "figure frame is not duplicated",
  );
  assert.ok(markdownDocument(f.bundle).includes("Inspected frames: 2/2"));
  await rm(f.root, { recursive: true, force: true });
});

test("vision engine: TSV parsing, bottom-region filtering, similarity dedupe and logo suppression", async () => {
  const { parseVisionLines, inRegion, newLines } = await import(
    "../lib/ingest-worker.mjs"
  );
  const lines = parseVisionLines(
    "0.50\t0.18\t0.10\t0.64\t0.08\tBill proposes easing the '52-hour workweek'\n1.00\t0.90\t0.89\t0.05\t0.04\tKBS\nbad line\n\t0.1\t0.86\t0.2\t0.05\tblank confidence\n-0.5\t0.1\t0.86\t0.2\t0.05\tnegative\n1.5\t0.1\t0.86\t0.2\t0.05\tout of range\n0.5\t0.1\t0.86\t0.2\t0.05\tArchive footage\n",
  );
  assert.equal(
    lines.length,
    3,
    "blank, negative and out-of-range numeric fields are rejected",
  );
  assert.deepEqual(
    lines.filter((l) => inRegion(l, "bottom")).map((l) => l.text),
    ["Bill proposes easing the '52-hour workweek'"],
  );
  assert.deepEqual(
    lines.filter((l) => inRegion(l, "top")).map((l) => l.text),
    ["KBS", "Archive footage"],
  );
  const recent = [];
  const f1 = newLines(["KBS NEWS", "This is the first caption"], recent);
  recent.push(...f1);
  const f2 = newLines(["KBS NEWS", "This is the first caption"], recent); // same subtitle still on screen + logo
  const f3 = newLines(["KBS NEWS", "Second caption"], recent);
  assert.deepEqual(f1, ["KBS NEWS", "This is the first caption"]);
  assert.deepEqual(
    f2,
    [],
    "unchanged subtitle and persistent logo are not re-reported",
  );
  assert.deepEqual(f3, ["Second caption"], "only the new caption line surfaces");
  // End-to-end with a mock vision helper emitting boxes: bottom region keeps the caption, drops the logo.
  const work = path.join(jobs, "vision");
  const helper = await fakeTool(
    path.join(root, "vision-ocr"),
    `const n=Number(/frame-(\\d+)/.exec(process.argv[2])?.[1]??0);\nconst caption = n===1 ? "This is the first caption" : n===2 ? "This is the first caption" : "This is the second caption";\nprocess.stdout.write("1.000\\t0.90\\t0.89\\t0.05\\t0.04\\tKBS\\n0.500\\t0.20\\t0.08\\t0.60\\t0.07\\t"+caption+"\\n");\n`,
  );
  const result = await extractSource(request({ visual: "local-ocr" }), {
    workDir: work,
    ocrEngine: "vision",
    ocrExecutable: helper,
    ocrLanguages: "ko-KR,en-US",
    ocrRegion: "bottom",
    ocrSampleSeconds: 2,
  });
  assert.deepEqual(
    result.frames.map((f) => f.ocrText),
    ["This is the first caption", "This is the second caption"],
  );
  assert.equal(result.raw.visualOcr.engine, "vision");
  assert.equal(result.raw.visualOcr.region, "bottom");
  await assert.rejects(
    () =>
      extractSource(request({ visual: "local-ocr" }), {
        workDir: path.join(jobs, "vision-bad"),
        ocrEngine: "vision",
        ocrExecutable: helper,
        ocrLanguages: "kor+eng",
      }),
    (e) => e.code === "INVALID_CONTRACT",
    "tesseract-style language list is rejected for vision",
  );
  await assert.rejects(
    () =>
      extractSource(request({ visual: "local-ocr" }), {
        workDir: path.join(jobs, "engine-bad"),
        ocrEngine: "paddle",
        ocrExecutable: helper,
      }),
    (e) => e.code === "INVALID_CONTRACT",
  );
});

test("tesseract with --ocr-region crops the frame band through a valid ffmpeg filter", async () => {
  const result = await extractSource(request({ visual: "local-ocr" }), {
    workDir: path.join(jobs, "ocr-bottom"),
    tesseractExecutable: tesseract,
    ocrLanguages: "kor+eng",
    ocrRegion: "bottom",
    ocrSampleSeconds: 2,
  });
  assert.ok(result.frames.length >= 1);
  assert.equal(result.frames[0].width, 320);
  assert.equal(result.frames[0].height, 72, "bottom 40 % of a 180 px frame");
  assert.equal(result.raw.visualOcr.region, "bottom");
  await assert.rejects(
    () =>
      extractSource(request({ visual: "local-ocr" }), {
        workDir: path.join(jobs, "ocr-region-bad"),
        tesseractExecutable: tesseract,
        ocrRegion: "left",
      }),
    (e) => e.code === "INVALID_CONTRACT",
  );
});

test("dedupe is exact: any changed character inside a line is new evidence; only edge punctuation/whitespace jitter folds", async () => {
  const { sameCaption, newLines, captionKey } = await import(
    "../lib/ingest-worker.mjs"
  );
  // Round-1 and round-2 review counterexamples: none of these may be treated as repeats.
  for (const [a, b] of [
    [
      "Keep the storage temperature at or below 20 C.",
      "Keep the storage temperature at or below 80 C.",
    ],
    [
      "This product is safe for pregnant patients.",
      "This product is unsafe for pregnant patients.",
    ],
    ["Delete before approval", "Do not delete before approval"],
    [
      "The concentration must remain below 1.5 mg.",
      "The concentration must remain below 15 mg.",
    ],
    ["Maintain the temperature at -20 C.", "Maintain the temperature at 20 C."],
    ["The permitted pressure is 20 MPa.", "The permitted pressure is 20 mPa."],
    [
      "Set the administered dose to 20 mg.",
      "Set the administered dose to 20 g.",
    ],
    [
      "The dose is eight milligrams per day.",
      "The dose is eighty milligrams per day.",
    ],
    ["Discard this document after review.", "Retain this document after review."],
    ["Only managers approve this result.", "Also managers approve this result."],
    [
      "This is not ready; there is no alarm active.",
      "This is now ready; there is no alarm active.",
    ],
    [
      "Do not proceed when an error occurs.",
      "Do proceed when an error occurs.",
    ],
    ["Do not open the box", "Do now open the box"],
    ["abcdefghijklmnop", "abcdefghijklmnoq"],
    ["Archive footage credit: Example News", "Archive footage credit; Example News"],
    // Round-3 review: edge/quote normalisation also lost evidence.
    [".5 mg daily", "5 mg daily"],
    ["The span is 5'", "The span is 5"],
    ["Use 5·10 mL", "Use 5 10 mL"],
    ["don't proceed", "dont proceed"],
    ["This is the first caption", "This is the first caption."],
    ["KBS NEWS 9", "KBS NEWS 9 |"],
  ]) {
    assert.equal(sameCaption(a, b), false, `${a} vs ${b}`);
    assert.deepEqual(newLines([b], [a]), [b]);
  }
  // Only whitespace and Unicode normalisation form are cosmetic.
  assert.equal(
    sameCaption("  This is the first   caption ", "This is the first caption"),
    true,
  );
  assert.equal(captionKey("  a   b  "), "a b");
  assert.equal(captionKey("café".normalize("NFD")), "café", "NFC-normalised");
  assert.deepEqual(
    newLines(["NO", "20%", "x"], []),
    ["NO", "20%"],
    "two-character lines count; single characters are ignored",
  );
});

test("duplicate-PTS scene source (round-2 fixture): one image per metadata record, every image bound to its own source time", async () => {
  // 12 gray frames (values 0,255,32,200,80,160,8,240,100,180,0,255) at 2 fps with floor(N/3)
  // PTS: four PTS values, three distinct images each. Built by the round-2 reviewer.
  const fixture = path.join(root, "dup.mkv");
  await copyFile(
    new URL("./fixtures/scene-duplicates.mkv", import.meta.url),
    fixture,
  );
  // Mock OCR returns a distinct line per frame so nothing is deduplicated.
  const ocr = await fakeTool(
    path.join(root, "ocr-unique"),
    `const n=/frame-(\\d+)/.exec(process.argv[2])?.[1];process.stdout.write("frame text number "+n+"\\n");\n`,
  );
  const duplicateRequest = normalizeRequest({
    schemaVersion: 1,
    source: { kind: "local", value: fixture },
    mode: "briefing",
    outputLanguage: "en",
    formats: ["html"],
    transcriptFile: srt,
    policy: { asr: "off", visual: "local-ocr" },
  });
  const duplicateOptions = {
    tesseractExecutable: ocr,
    ocrLanguages: "eng",
    ocrSceneThreshold: 0.02,
  };
  const result = await extractSource(duplicateRequest, {
    ...duplicateOptions,
    workDir: path.join(jobs, "dup"),
  });
  assert.equal(
    result.raw.visualOcr.sampled,
    12,
    "every selected frame is emitted (passthrough), none dropped",
  );
  assert.deepEqual(
    result.frames.map((f) => f.timestampMs),
    [0, 0, 0, 500, 500, 500, 1000, 1000, 1000, 1500, 1500, 1500],
  );
  // Image identity: alternating black/white frames must alternate in the stored JPEGs.
  const { readFile: rf } = await import("node:fs/promises");
  const lum = [];
  for (const f of result.frames) {
    const bytes = await rf(path.join(result.assetRoot, f.assetPath));
    assert.equal(
      bytes.length > 0 && bytes[0] === 0xff && bytes[1] === 0xd8,
      true,
    );
    lum.push(bytes.length);
  }
  assert.ok(
    new Set(lum).size >= 2,
    "distinct images were stored, not one repeated frame",
  );
  // Small caps exercise FFmpeg filter read-ahead, including stopping inside repeated
  // timestamps: every retained image must keep its leading source timestamp.
  for (const cap of [1, 4]) {
    const capped = await extractSource(duplicateRequest, {
      ...duplicateOptions,
      workDir: path.join(jobs, `dup-cap-${cap}`),
      ocrMaxFrames: cap,
    });
    assert.equal(capped.raw.visualOcr.sampled, cap);
    assert.deepEqual(
      capped.frames.map((frame) => frame.timestampMs),
      result.frames.slice(0, cap).map((frame) => frame.timestampMs),
    );
    assert.equal(new Set(capped.frames.map((frame) => frame.sha256)).size, cap,
      "distinct source images are retained even when their timestamps are equal");
    assert.equal(capped.raw.visualOcr.coverage.complete, false);
  }
});

test("interval sampling keeps real source timestamps, survives quoted and Unicode work directories, and a caption returning after the window is reported again", async () => {
  const work = path.join(jobs, process.platform === "win32" ? "it's café odd" : "it's: café odd");
  // Mock vision: caption A on frames 1–2, nothing on 3–11, caption A again on frame 12.
  const helper = await fakeTool(
    path.join(root, "vision-window"),
    `const n=Number(/frame-(\\d+)/.exec(process.argv[2])?.[1]??0);\nconst show = n<=2 || n>=12;\nif (show) process.stdout.write("0.900\\t0.20\\t0.08\\t0.60\\t0.07\\tThis caption appears repeatedly\\n");\n`,
  );
  // 6-second clip at 1 s sampling yields frames at real PTS 0, 1, 2, ... (select, not fps resampling).
  const result = await extractSource(request({ visual: "local-ocr" }), {
    workDir: work,
    ocrEngine: "vision",
    ocrExecutable: helper,
    ocrLanguages: "ko-KR",
    ocrSampleSeconds: 1,
  });
  assert.equal(
    result.raw.visualOcr.selector.startsWith("select="),
    true,
    "interval sampling selects source frames",
  );
  assert.equal(result.raw.visualOcr.sampled, 6);
  assert.deepEqual(
    result.frames.map((f) => f.timestampMs),
    [0],
    "a caption still displayed is reported once",
  );
  // The window is 10 s of source time: last seen at 1 s, back at 12 s → reported again.
  const longMedia = path.join(root, "long.mp4");
  await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:s=320x180:d=14",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      longMedia,
    ],
    { env: isolatedEnvironment(root), timeout: 30000, shell: false },
  );
  const longResult = await extractSource(
    normalizeRequest({
      schemaVersion: 1,
      source: { kind: "local", value: longMedia },
      mode: "briefing",
      outputLanguage: "en",
      formats: ["html"],
      transcriptFile: srt,
      policy: { asr: "off", visual: "local-ocr" },
    }),
    {
      workDir: path.join(jobs, "window"),
      ocrEngine: "vision",
      ocrExecutable: helper,
      ocrLanguages: "ko-KR",
      ocrSampleSeconds: 1,
    },
  );
  assert.equal(longResult.raw.visualOcr.sampled, 14);
  assert.deepEqual(
    longResult.frames.map((f) => Math.round(f.timestampMs / 1000)),
    [0, 11],
    "first appearance and the return after the 8-frame window",
  );
});

test("visual: frames — key-scene sampling without OCR keeps every sampled frame and writes a contact sheet; YouTube needs yt-dlp and streams a video-only track", async () => {
  // Local 6 s clip (red/green/blue, 2 s each): hard cuts at 2 s and 4 s, no OCR executable needed.
  const result = await extractSource(request({ visual: "frames" }), {
    workDir: path.join(jobs, "frames-local"),
    ocrSampleSeconds: 2,
  });
  assert.equal(result.raw.visualOcr.engine, "none");
  assert.ok(
    result.raw.visualOcr.selector.includes("gte(t-prev_selected_t,2)"),
    result.raw.visualOcr.selector,
  );
  assert.deepEqual(
    result.frames.map((f) => f.timestampMs),
    [0, 2000, 4000],
  );
  assert.ok(
    result.frames.every((f) => f.ocrText === undefined),
    "no OCR text in frames mode",
  );
  assert.deepEqual(result.raw.visualOcr.contactSheet, {
    sheets: ["assets/contact-sheet-01.jpg"],
    index: "assets/contact-sheet.txt",
    tilesPerSheet: 24,
    lookAlikeRuns: [],
  });
  const index = await (await import("node:fs/promises")).readFile(
    path.join(result.assetRoot, "assets", "contact-sheet.txt"),
    "utf8",
  );
  assert.match(
    index,
    /^1\s+r1c1\s+frame-0001\s+00:00\s+assets\/frame-0001\.jpg$/m,
  );
  assert.match(
    index,
    /^1\s+r1c3\s+frame-0003\s+00:04\s+assets\/frame-0003\.jpg$/m,
  );
  const { readFile: rf } = await import("node:fs/promises");
  const sheet = await rf(
    path.join(result.assetRoot, "assets", "contact-sheet-01.jpg"),
  );
  const { jpegSize } = await import("../lib/ingest-worker.mjs");
  assert.deepEqual(
    jpegSize(sheet),
    { width: 966, height: 182 },
    "3 tiles of 322×182 (320 px + 1 px border)",
  );
  assert.equal(result.raw.visualOcr.coverage.complete, true);
  assert.ok(
    result.extraction.warnings.some((w) => w.code === "FRAMES_SAMPLED"),
  );
  // A short source uses its candidate budget for dense intervals plus hard cuts.
  const defaults = await extractSource(request({ visual: "frames" }), {
    workDir: path.join(jobs, "frames-default"),
  });
  assert.deepEqual(
    defaults.frames.map((f) => f.timestampMs),
    [0, 1000, 2000, 3000, 4000, 5000],
    "interval candidates retain each short colour scene even when its transition scores below the hard-cut threshold",
  );
  // YouTube: without yt-dlp it is a capability error; with a fake yt-dlp streaming the local clip it samples frames.
  const yt = normalizeRequest({
    schemaVersion: 1,
    source: {
      kind: "url",
      value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    },
    mode: "briefing",
    outputLanguage: "en",
    formats: ["html"],
    transcriptFile: srt,
    policy: { asr: "off", visual: "frames" },
  });
  await assert.rejects(
    () => extractSource(yt, { workDir: path.join(jobs, "frames-yt-missing") }),
    (e) => e.code === "CAPABILITY_MISSING",
  );
  const log = path.join(root, "yt-dlp-video-args.json");
  const fake = await fakeTool(
    path.join(root, "yt-dlp-video"),
    `import { writeFileSync, readFileSync } from "node:fs";\nconst a = process.argv.slice(2);\nwriteFileSync(${JSON.stringify(log)}, JSON.stringify(a));\nprocess.stdout.write(readFileSync(${JSON.stringify(media)}));\n`,
  );
  const ytResult = await extractSource(yt, {
    workDir: path.join(jobs, "frames-yt"),
    ytDlpExecutable: fake,
    ocrSampleSeconds: 2,
  });
  const args = JSON.parse(await rf(log, "utf8"));
  assert.equal(
    args[args.indexOf("-f") + 1].split("/")[0],
    "bestvideo[height<=480][protocol=https][vcodec^=avc1]",
  );
  assert.ok(
    args.includes("--ignore-config") &&
      args.includes("-o") &&
      args[args.indexOf("-o") + 1] === "-",
  );
  assert.deepEqual(
    ytResult.frames.map((f) => f.timestampMs),
    [0, 2000, 4000],
  );
  assert.ok(
    ytResult.extraction.warnings.some(
      (w) => w.code === "PLATFORM_VIDEO_DOWNLOADED",
    ),
  );
  assert.equal(
    ytResult.extraction.method,
    "user-transcript",
    "the transcript path is untouched by frame sampling",
  );
});

test("long videos: the default interval widens to fit the cap and reach the end; a cut storm falls back to interval-only; explicit settings that stop early are reported; sheets paginate at 24", async () => {
  const make = async (name, filter, seconds) => {
    const file = path.join(root, name);
    await exec(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=gray:s=64x36:r=1:d=${seconds}`,
        "-vf",
        filter,
        "-c:v",
        "libx264",
        "-g",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-y",
        file,
      ],
      { env: isolatedEnvironment(root), timeout: 120000, shell: false },
    );
    return file;
  };
  const req = (value) =>
    normalizeRequest({
      schemaVersion: 1,
      source: { kind: "local", value },
      mode: "briefing",
      outputLanguage: "en",
      formats: ["html"],
      transcriptFile: srt,
      policy: { asr: "off", visual: "frames" },
    });
  const { readFile: rf } = await import("node:fs/promises");
  // (a) One hour, no cuts: interval = ceil(3600 / 119) = 31 s, ~117 frames, last near the end.
  const hour = await make("hour.mp4", "null", 3600);
  const a = await extractSource(req(hour), {
    workDir: path.join(jobs, "long-a"),
  });
  assert.equal(a.raw.visualOcr.intervalSeconds, 31);
  assert.ok(
    a.frames.length <= 120 && a.frames.length >= 110,
    String(a.frames.length),
  );
  assert.ok(a.frames.at(-1).timestampMs >= 3600000 - 31000, "reaches the end");
  assert.equal(a.raw.visualOcr.coverage.complete, true);
  assert.ok(
    !a.extraction.warnings.some((w) =>
      /FRAMES_(TRUNCATED|CUTS_DROPPED)/.test(w.code),
    ),
  );
  assert.equal(
    a.raw.visualOcr.contactSheet.sheets.length,
    Math.ceil(a.frames.length / 24),
  );
  const idx = await rf(
    path.join(a.assetRoot, "assets", "contact-sheet.txt"),
    "utf8",
  );
  assert.match(idx, /^2\s+r1c1\s+frame-0025\s/m, "frame 25 opens sheet 2");
  // (b) Ten minutes with a hard cut every 2 s (steady frames between, so ffmpeg scores each
  //     change as a cut): cuts would exhaust the cap at ~4 min; the interval-only pass (20 s)
  //     covers the whole video and the drop is reported.
  const storm = await make(
    "storm.mp4",
    "geq=lum='if(mod(floor(N/2),2),16,235)':cb=128:cr=128",
    600,
  );
  const b = await extractSource(req(storm), {
    workDir: path.join(jobs, "long-b"),
  });
  assert.equal(b.raw.visualOcr.coverage.cutsDropped, true);
  assert.equal(b.raw.visualOcr.coverage.complete, true);
  assert.ok(
    b.frames.at(-1).timestampMs >= 580000,
    String(b.frames.at(-1).timestampMs),
  );
  assert.ok(
    b.extraction.warnings.some((w) => w.code === "FRAMES_CUTS_DROPPED"),
  );
  // (c) Explicit settings that cannot reach the end are reported, not silent.
  const c = await extractSource(req(storm), {
    workDir: path.join(jobs, "long-c"),
    ocrSampleSeconds: 1,
    ocrMaxFrames: 5,
  });
  assert.equal(c.raw.visualOcr.coverage.complete, false);
  assert.ok(
    c.extraction.warnings.some(
      (w) => w.code === "FRAMES_TRUNCATED" && /00:04 of 10:00/.test(w.message),
    ),
    JSON.stringify(c.extraction.warnings.map((w) => w.message)),
  );
});

test("round 5: coverage is honest (unknown duration + cap, short explicit pass), frames alone are usable evidence, and the video gate checks the actual streams", async () => {
  const req = (value, policy = {}) =>
    normalizeRequest({
      schemaVersion: 1,
      source: { kind: "local", value },
      mode: "briefing",
      outputLanguage: "en",
      formats: ["html"],
      transcriptFile: srt,
      policy: { asr: "off", visual: "frames", ...policy },
    });
  // (F2-A) A streamed Matroska has no duration: a capped pass must not claim full coverage.
  const streamed = path.join(root, "streamed.mkv");
  const { spawn } = await import("node:child_process");
  const { createWriteStream } = await import("node:fs");
  await new Promise((resolve, reject) => {
    const p = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=gray:s=64x36:r=1:d=200",
        "-c:v",
        "libx264",
        "-g",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "matroska",
        "-",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    p.stdout.pipe(createWriteStream(streamed));
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)),
    );
  });
  const a = await extractSource(req(streamed), {
    workDir: path.join(jobs, "r5-unknown"),
    ocrMaxFrames: 3,
  });
  assert.equal(a.raw.visualOcr.coverage.durationMs, null);
  assert.equal(a.raw.visualOcr.coverage.complete, false);
  assert.ok(
    a.extraction.warnings.some(
      (w) =>
        w.code === "FRAMES_TRUNCATED" && /duration is unknown/.test(w.message),
    ),
  );
  // (F2-B) A 9 s video, explicit 1 s interval, cap 3 → 0/1/2 s is not "complete".
  const nine = path.join(root, "nine.mp4");
  await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:s=64x36:r=1:d=9",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      nine,
    ],
    { env: isolatedEnvironment(root), timeout: 30000, shell: false },
  );
  const b = await extractSource(req(nine), {
    workDir: path.join(jobs, "r5-short"),
    ocrSampleSeconds: 1,
    ocrMaxFrames: 3,
  });
  assert.deepEqual(
    b.frames.map((f) => f.timestampMs),
    [0, 1000, 2000],
  );
  assert.ok(b.extraction.warnings.some((w) => w.code === "FRAMES_TRUNCATED"));
  // (F3) No transcript, ASR off: sampled frames alone make visual-only evidence.
  const { prepare } = await import("../scripts/prepare.mjs");
  const { realpath } = await import("node:fs/promises");
  const work = path.join(await realpath(jobs), "r5-visual-only");
  const reqFile = path.join(root, "visual-only.json");
  await writeFile(
    reqFile,
    JSON.stringify({
      schemaVersion: 1,
      source: { kind: "local", value: media },
      mode: "briefing",
      outputLanguage: "en",
      formats: ["html"],
      policy: { asr: "off", visual: "frames" },
    }),
  );
  const prepared = await prepare({
    request: reqFile,
    "work-dir": work,
    "ocr-sample-seconds": "2",
  });
  assert.equal(prepared.status, "ok", JSON.stringify(prepared.issues));
  const ev = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      path.join(work, "evidence.json"),
      "utf8",
    ),
  );
  assert.equal(ev.segments.length, 0);
  assert.ok(ev.frames.length >= 1);
});

test("round 5: a YouTube 'video' download that also carries audio, or is above 480p, is refused", async () => {
  const muxed = path.join(root, "muxed.mp4");
  await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=1280x720:d=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-pix_fmt",
      "yuv420p",
      "-shortest",
      "-y",
      muxed,
    ],
    { env: isolatedEnvironment(root), timeout: 30000, shell: false },
  );
  const fake = await fakeTool(
    path.join(root, "yt-dlp-muxed"),
    `import { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync(${JSON.stringify(muxed)}));\n`,
  );
  const yt = normalizeRequest({
    schemaVersion: 1,
    source: {
      kind: "url",
      value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    },
    mode: "briefing",
    outputLanguage: "en",
    formats: ["html"],
    transcriptFile: srt,
    policy: { asr: "off", visual: "frames" },
  });
  await assert.rejects(
    () =>
      extractSource(yt, {
        workDir: path.join(jobs, "r5-muxed"),
        ytDlpExecutable: fake,
      }),
    (e) =>
      e.code === "SOURCE_UNSUPPORTED" &&
      /download-failed|yt-dlp|video/i.test(e.message),
  );
});

test("look-alike runs: near-identical and build-up runs are marked in the index; every frame is kept", async () => {
  const clip = path.join(root, "buildup.mp4");
  // 0–2 s grey, a small box appears at 3 s (build-up), a black frame at 4 s (new scene).
  await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:s=320x180:r=1:d=5",
      "-vf",
      "drawbox=x=10:y=10:w=40:h=20:color=white:t=fill:enable='gte(t,3)',drawbox=x=0:y=0:w=320:h=180:color=black:t=fill:enable='gte(t,4)'",
      "-c:v",
      "libx264",
      "-g",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-y",
      clip,
    ],
    { env: isolatedEnvironment(root), timeout: 30000, shell: false },
  );
  const r = await extractSource(
    normalizeRequest({
      schemaVersion: 1,
      source: { kind: "local", value: clip },
      mode: "briefing",
      outputLanguage: "en",
      formats: ["html"],
      transcriptFile: srt,
      policy: { asr: "off", visual: "frames" },
    }),
    { workDir: path.join(jobs, "lookalike"), ocrSampleSeconds: 1 },
  );
  assert.equal(r.frames.length, 5, "nothing dropped");
  assert.deepEqual(r.raw.visualOcr.contactSheet.lookAlikeRuns, [
    { from: "frame-0001", to: "frame-0004", kind: "builds" },
  ]);
  const index = await (await import("node:fs/promises")).readFile(
    path.join(r.assetRoot, "assets", "contact-sheet.txt"),
    "utf8",
  );
  assert.match(index, /frame-0002 .* build-up run frame-0001–frame-0004$/m);
  assert.doesNotMatch(index, /frame-0005 .* run /);
  assert.match(index, /a changed word, number or\nsign can look identical/i);
  assert.match(
    index,
    /frame-0001–frame-0004 \(00:00–00:03\): the same layout with content changing/,
  );
});

test("look-alike run kinds: drift cannot chain near-identical frames, and a thumbnail failure only drops the hint", async () => {
  const { lookAlikeRunsForTest } = await import("../lib/ingest-worker.mjs");
  const frames = Array.from({ length: 6 }, (_, i) => ({ id: `f${i}` }));
  // Each neighbour 0.6 apart: near-identical step, but frame 2 is 1.2 from frame 0.
  const drift = (a, b) => Math.abs(a - b) * 0.6;
  assert.deepEqual(lookAlikeRunsForTest(frames.slice(0, 3), drift), [
    { from: 0, to: 2, kind: "builds" },
  ]);
  const flat = (a, b) => (a === b ? 0 : 0.5);
  assert.deepEqual(lookAlikeRunsForTest(frames.slice(0, 3), flat), [
    { from: 0, to: 2, kind: "near-identical" },
  ]);
  const cut = (a, b) => (Math.min(a, b) < 3 && Math.max(a, b) >= 3 ? 50 : 0.5);
  assert.deepEqual(lookAlikeRunsForTest(frames, cut), [
    { from: 0, to: 2, kind: "near-identical" },
    { from: 3, to: 5, kind: "near-identical" },
  ]);
  assert.deepEqual(lookAlikeRunsForTest(frames, null), []);
});

test("a capped scene-only pass is never reported as complete (no sampling step bounds the gap)", async () => {
  const clip = path.join(root, "cuts.mp4");
  // Nine seconds, a hard colour cut every two seconds.
  await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=160x90:r=5:d=2",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x90:r=5:d=2",
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=160x90:r=5:d=2",
      "-f",
      "lavfi",
      "-i",
      "color=c=yellow:s=160x90:r=5:d=2",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=160x90:r=5:d=1",
      "-filter_complex",
      "[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1:a=0",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      clip,
    ],
    { env: isolatedEnvironment(root), timeout: 30000, shell: false },
  );
  const r = await extractSource(
    normalizeRequest({
      schemaVersion: 1,
      source: { kind: "local", value: clip },
      mode: "briefing",
      outputLanguage: "en",
      formats: ["html"],
      transcriptFile: srt,
      policy: { asr: "off", visual: "frames" },
    }),
    {
      workDir: path.join(jobs, "scene-cap"),
      ocrSceneThreshold: 0.3,
      ocrMaxFrames: 3,
    },
  );
  assert.deepEqual(
    r.frames.map((f) => f.timestampMs),
    [0, 2000, 4000],
  );
  assert.equal(r.raw.visualOcr.coverage.complete, false);
  const truncated = r.extraction.warnings.find(
    (w) => w.code === "FRAMES_TRUNCATED",
  );
  assert.match(truncated?.message ?? "", /later scenes may not be represented/);
});
