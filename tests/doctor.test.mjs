import test from "node:test";
import assert from "node:assert/strict";
import { diagnose, doctorResult, installCommands } from "../scripts/doctor.mjs";

const NOW = Date.UTC(2026, 10, 3);
const PACKAGE = JSON.stringify({
  dependencies: { ajv: "1", "@steipete/summarize-core": "1" },
});

// A fake computer: the files that exist and what each tool prints.
function machine({
  platform,
  files = [],
  outputs = {},
  env = {},
  text = {},
  nodeVersion = "24.16.0",
}) {
  const set = new Set(files);
  return diagnose({
    platform,
    env,
    home: platform === "win32" ? "C:\\Users\\me" : "/home/me",
    now: NOW,
    nodeVersion,
    skillDir: platform === "win32" ? "C:\\skill" : "/skill",
    exists: (file) => set.has(file),
    probe: (file) =>
      file in outputs
        ? { ok: true, out: outputs[file] }
        : { ok: false, out: "" },
    readText: (file) => {
      if (file in text) return text[file];
      throw new Error("ENOENT");
    },
  });
}
const tool = (report, name) => report.tools.find((t) => t.name === name);

test("install commands merge per package manager, once each, in a stable order", () => {
  assert.deepEqual(
    installCommands([
      { brew: ["ffmpeg"] },
      { brew: ["ffmpeg"] },
      { brew: ["yt-dlp"], run: ["write prefs"] },
      { cask: ["google-chrome"] },
      null,
    ]),
    [
      "brew install ffmpeg yt-dlp",
      "brew install --cask google-chrome",
      "write prefs",
    ],
  );
  assert.deepEqual(
    installCommands([
      { winget: ["Gyan.FFmpeg"] },
      { winget: ["yt-dlp.yt-dlp"] },
    ]),
    [
      "winget install --id Gyan.FFmpeg -e",
      "winget install --id yt-dlp.yt-dlp -e",
    ],
  );
  assert.deepEqual(
    installCommands([
      { apt: ["ffmpeg"] },
      { apt: ["chromium"] },
      { pipx: ["yt-dlp"] },
    ]),
    ["sudo apt install ffmpeg chromium", "pipx install yt-dlp"],
  );
});

test("Windows: each choice says what it lacks and one install for it; found tools come with ready-made options", () => {
  const report = machine({
    platform: "win32",
    env: {
      Path: "C:\\tools;C:\\Windows\\System32",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    },
    files: [
      "C:\\skill\\node_modules\\ajv\\package.json",
      "C:\\skill\\node_modules\\@steipete\\summarize-core\\package.json",
      "C:\\tools\\yt-dlp.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Windows\\System32\\winget.exe",
    ],
    outputs: { "C:\\tools\\yt-dlp.exe": "2026.10.26\n" },
    text: { "C:\\skill\\package.json": PACKAGE },
  });
  assert.equal(tool(report, "packages").status, "ok");
  assert.equal(
    tool(report, "ffmpeg").install,
    "winget install --id Gyan.FFmpeg -e",
  );
  const { features, flags } = report;
  // ffmpeg and ffprobe come from one package: one command.
  assert.deepEqual(features["local-media"], {
    for: "a local file or a direct media link",
    ready: false,
    missing: ["ffmpeg", "ffprobe"],
    install: ["winget install --id Gyan.FFmpeg -e"],
  });
  assert.deepEqual(features["youtube-captures"].install, [
    "winget install --id Gyan.FFmpeg -e",
  ]);
  assert.equal(features.pdf.ready, true, "Edge serves PDF");
  assert.deepEqual(features["slide-translation"].install, [
    "winget install --id UB-Mannheim.TesseractOCR -e",
  ]);
  assert.equal(
    flags.browser,
    '--browser-executable "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"',
  );
  assert.equal(flags["yt-dlp"], '--yt-dlp-executable "C:\\tools\\yt-dlp.exe"');
  assert.equal(flags.asr, undefined);
  assert.equal(tool(report, "vision"), undefined, "Apple Vision is macOS-only");
  const warning = doctorResult(report).issues.find(
    (i) => i.code === "FEATURES_NEED_INSTALL",
  );
  assert.match(
    warning.message,
    /local-media \(a local file or a direct media link\) needs ffmpeg, ffprobe; install: winget install --id Gyan\.FFmpeg -e/,
  );
  assert.match(warning.message, /choosing that option approves it/);
  assert.match(
    warning.message,
    /open a new terminal so PATH picks the tools up/,
  );
  assert.doesNotMatch(warning.message, /pdf/);
});

test("Windows: tools winget just installed are found, and ffmpeg outside this terminal's PATH says to reopen it", () => {
  const report = machine({
    platform: "win32",
    env: {
      Path: "C:\\Windows\\System32",
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
    },
    files: [
      "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe",
      "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\yt-dlp.exe",
      "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",
    ],
    outputs: {
      "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\yt-dlp.exe":
        "2026.10.26\n",
      "C:\\Program Files\\Tesseract-OCR\\tesseract.exe":
        "List of available languages (2):\neng\nkor\n",
    },
  });
  const ffmpeg = tool(report, "ffmpeg");
  assert.equal(ffmpeg.status, "not-visible");
  assert.match(
    ffmpeg.note,
    /this terminal's PATH does not include it yet; open a new terminal/,
  );
  assert.equal(ffmpeg.install, "open a new terminal so PATH includes ffmpeg");
  assert.equal(tool(report, "ffprobe").status, "missing");
  assert.equal(tool(report, "yt-dlp").status, "ok");
  assert.equal(
    tool(report, "tesseract").path,
    "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",
  );
  assert.match(tool(report, "tesseract").note, /eng yes, kor yes/);
  assert.equal(report.features["slide-translation"].ready, true);
  assert.equal(
    report.flags.tesseract,
    '--ocr-engine tesseract --ocr-executable "C:\\Program Files\\Tesseract-OCR\\tesseract.exe"',
  );
});

test("macOS: one approval sets transcription up (Homebrew, the model and the preference file); an old yt-dlp is updated", () => {
  const report = machine({
    platform: "darwin",
    env: { PATH: "/Users/me/bin:/usr/bin" },
    files: [
      "/skill/node_modules/ajv/package.json",
      "/skill/node_modules/@steipete/summarize-core/package.json",
      "/Users/me/bin/ffmpeg",
      "/opt/homebrew/bin/ffprobe",
      "/opt/homebrew/bin/yt-dlp",
      "/home/me/.agents/playback-notes-asr.json",
      "/opt/homebrew/bin/whisper-cli",
      "/usr/bin/swiftc",
      "/opt/homebrew/bin/brew",
    ],
    outputs: {
      "/opt/homebrew/bin/ffprobe": "ffprobe version 9.0.2\n",
      "/Users/me/bin/ffmpeg": "ffmpeg version 9.0.2\n",
      "/opt/homebrew/bin/yt-dlp": "2026.02.01\n",
      "/usr/bin/swiftc": "Apple Swift version 6.2\n",
    },
    text: {
      "/skill/package.json": PACKAGE,
      "/home/me/.agents/playback-notes-asr.json": JSON.stringify({
        localAsrExecutable: "/opt/homebrew/bin/whisper-cli",
        localAsrModel: "/home/me/.agents/models/missing.bin",
      }),
    },
  });
  const ffmpeg = tool(report, "ffmpeg");
  assert.equal(ffmpeg.status, "not-visible");
  assert.match(
    ffmpeg.note,
    /extraction only looks in \/opt\/homebrew\/bin, \/usr\/local\/bin, \/usr\/bin, \/bin/,
  );
  const ytDlp = tool(report, "yt-dlp");
  assert.equal(ytDlp.status, "outdated");
  assert.equal(ytDlp.install, "brew upgrade yt-dlp");
  assert.match(ytDlp.note, /About 275 days old/);
  assert.match(
    tool(report, "whisper").note,
    /names a model that does not exist/,
  );
  const model = "/home/me/.agents/models/ggml-large-v3-turbo.bin";
  // whisper-cli is already installed: only the model and the preference file are added.
  assert.deepEqual(report.features.transcription.install, [
    "brew install ffmpeg",
    `mkdir -p "/home/me/.agents/models" && curl -L -o "${model}" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin  # 1.6 GB`,
    `write /home/me/.agents/playback-notes-asr.json containing {"localAsrExecutable":"/opt/homebrew/bin/whisper-cli","localAsrModel":"${model}"}`,
  ]);
  assert.deepEqual(report.features["youtube-captures"].install, [
    "brew install ffmpeg",
    "brew upgrade yt-dlp",
  ]);
  assert.equal(
    report.features["slide-translation"].ready,
    true,
    "the Vision helper can be compiled",
  );
  assert.match(
    tool(report, "vision").note,
    /swiftc -O -o "\$PRIVATE\/vision-ocr" "\/skill\/scripts\/vision-ocr\.swift"/,
  );
  assert.equal(
    report.features.pdf.install[0],
    "brew install --cask google-chrome",
  );
  // An outdated yt-dlp still runs: its path is offered while it is updated.
  assert.equal(
    report.flags["yt-dlp"],
    '--yt-dlp-executable "/opt/homebrew/bin/yt-dlp"',
  );
  assert.match(report.flags.vision, /--ocr-engine vision/);
  assert.equal(report.packageManager.found, true);
});

test("macOS without whisper.cpp: Homebrew installs it and the preference file points at Homebrew's binary", () => {
  const report = machine({
    platform: "darwin",
    env: { PATH: "/usr/bin" },
    files: [
      "/usr/local/bin/brew",
      "/usr/local/bin/ffmpeg",
      "/usr/local/bin/ffprobe",
    ],
    outputs: {
      "/usr/local/bin/ffmpeg": "ffmpeg 9\n",
      "/usr/local/bin/ffprobe": "ffprobe 9\n",
    },
    text: { "/skill/package.json": "{}" },
  });
  const install = report.features.transcription.install;
  assert.equal(install[0], "brew install whisper.cpp");
  assert.match(
    install.at(-1),
    /"localAsrExecutable":"\/usr\/local\/bin\/whisper-cli"/,
  );
  assert.equal(report.features["local-media"].ready, true);
});

test("Linux without packages or a supported Node: the skill is not ready; choices name apt, pipx or the build guide", () => {
  const report = machine({
    platform: "linux",
    nodeVersion: "25.1.0",
    env: { PATH: "/usr/bin:/bin" },
    files: ["/usr/bin/tesseract", "/usr/bin/whisper-cli"],
    outputs: {
      "/usr/bin/tesseract": "List of available languages (2):\neng\nosd\n",
    },
    text: { "/skill/package.json": PACKAGE },
  });
  assert.equal(tool(report, "node").status, "unsupported");
  assert.equal(tool(report, "packages").status, "missing");
  assert.equal(tool(report, "packages").install, "npm ci (in /skill)");
  assert.match(
    tool(report, "tesseract").note,
    /2 languages \(eng yes, kor no\)/,
  );
  assert.match(
    tool(report, "whisper").note,
    /whisper-cli is installed at \/usr\/bin\/whisper-cli, but no model/,
  );
  assert.deepEqual(report.features["youtube-transcription"].install, [
    "sudo apt install ffmpeg",
    "pipx install yt-dlp",
    'build whisper.cpp and download the model as the README\'s "Optional: local transcription" describes',
  ]);
  const out = doctorResult(report);
  assert.equal(out.issues[0].code, "SKILL_NOT_READY");
  assert.match(
    out.issues[0].message,
    /node \(unsupported\).*packages \(missing\): npm ci/,
  );
  assert.equal(out.issues[1].code, "FEATURES_NEED_INSTALL");
  assert.match(out.issues[1].message, /The install commands need apt/);
});

test("doctor runs on this computer without installing anything", () => {
  const out = doctorResult(diagnose());
  assert.equal(out.status, "ok");
  assert.ok(out.tools.length >= 8);
  for (const t of out.tools) assert.ok(t.neededFor, t.name);
  for (const f of Object.values(out.features))
    assert.equal(f.ready, f.missing.length === 0);
});
