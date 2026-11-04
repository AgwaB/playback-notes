import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diagnose, doctorResult, installCommands } from "../scripts/doctor.mjs";
import { linuxSandboxCause } from "../lib/pdf.mjs";

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
  dirs = {},
  nodeVersion = "24.16.0",
  root = false,
  arch = "x64",
}) {
  const set = new Set(files);
  return diagnose({
    platform,
    env,
    home: platform === "win32" ? "C:\\Users\\me" : "/home/me",
    now: NOW,
    nodeVersion,
    root,
    arch,
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
    list: (dir) => dirs[dir] ?? [],
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
      "winget install --id Gyan.FFmpeg -e --source winget --accept-package-agreements --accept-source-agreements",
      "winget install --id yt-dlp.yt-dlp -e --source winget --accept-package-agreements --accept-source-agreements",
    ],
  );
  assert.deepEqual(
    installCommands([
      { apt: ["ffmpeg"] },
      { apt: ["chromium"] },
      { pipx: ["yt-dlp"] },
    ]),
    [
      "sudo apt-get update && sudo apt-get install -y ffmpeg chromium",
      "pipx install yt-dlp",
    ],
  );
  assert.equal(
    installCommands([{ apt: ["ffmpeg"] }], { root: true })[0],
    "apt-get update && apt-get install -y ffmpeg",
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
    "winget install --id Gyan.FFmpeg -e --source winget --accept-package-agreements --accept-source-agreements",
  );
  const { features, flags } = report;
  // ffmpeg and ffprobe come from one package: one command.
  assert.deepEqual(features["local-media"], {
    for: "a local file or a direct media link",
    ready: false,
    missing: ["ffmpeg", "ffprobe"],
    install: ["winget install --id Gyan.FFmpeg -e --source winget --accept-package-agreements --accept-source-agreements"],
  });
  assert.deepEqual(features["youtube-captures"].install, [
    "winget install --id Gyan.FFmpeg -e --source winget --accept-package-agreements --accept-source-agreements",
  ]);
  assert.equal(features.pdf.ready, true, "Edge serves PDF");
  assert.deepEqual(features["slide-translation"].install, [
    "winget install --id UB-Mannheim.TesseractOCR -e --source winget --accept-package-agreements --accept-source-agreements",
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
    /local-media \(a local file or a direct media link\) needs ffmpeg, ffprobe; install: winget install --id Gyan\.FFmpeg -e --source winget/,
  );
  assert.match(warning.message, /choosing that option approves it/);
  assert.match(
    warning.message,
    /ffmpeg reported not-visible needs the agent restarted/,
  );
  assert.doesNotMatch(warning.message, /pdf/);
});

test("Windows: tools winget just installed are found, and ffmpeg outside this agent's PATH says to restart it", () => {
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
    /PATH here does not include it yet.*Restart the agent/,
  );
  assert.equal(
    ffmpeg.install,
    "restart the agent (close and reopen its terminal or app) so PATH includes ffmpeg",
  );
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

test("Windows: winget is found by running it, and its portable packages are found outside PATH", () => {
  const local = "C:\\Users\\me\\AppData\\Local";
  const packages = `${local}\\Microsoft\\WinGet\\Packages`;
  const ffmpegDir = `${packages}\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe`;
  const ytDir = `${packages}\\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe`;
  const report = machine({
    platform: "win32",
    // winget lives in WindowsApps as an App Execution Alias, which is not a readable file.
    env: { Path: `C:\\Windows\\System32;${local}\\Microsoft\\WindowsApps`, LOCALAPPDATA: local },
    dirs: {
      [packages]: [
        "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
        "yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe",
        "Other.Tool_Microsoft.Winget.Source_8wekyb3d8bbwe",
      ],
      [ffmpegDir]: ["ffmpeg-9.0.2-full_build"],
    },
    files: [
      `${ffmpegDir}\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe`,
      `${ffmpegDir}\\ffmpeg-9.0.2-full_build\\bin\\ffprobe.exe`,
      `${ytDir}\\yt-dlp.exe`,
    ],
    outputs: { "winget.exe": "v1.29.380\n", [`${ytDir}\\yt-dlp.exe`]: "2026.10.26\n" },
  });
  assert.equal(report.packageManager.found, true);
  assert.doesNotMatch(doctorResult(report).issues.at(-1).message, /App Installer/);
  assert.equal(tool(report, "ffmpeg").status, "not-visible");
  assert.equal(tool(report, "ffprobe").status, "not-visible");
  // A tool passed by path works at once, without a restart.
  assert.equal(tool(report, "yt-dlp").status, "ok");
  assert.equal(report.flags["yt-dlp"], `--yt-dlp-executable "${ytDir}\\yt-dlp.exe"`);
});

test("Windows: a PATH entry in double quotes is searched like the system searches it", () => {
  const report = machine({
    platform: "win32",
    env: { Path: 'C:\\Windows\\System32;"C:\\Program Files\\ffmpeg\\bin"' },
    files: ["C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe"],
    outputs: { "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe": "ffmpeg version 9.0.2\n" },
  });
  assert.equal(tool(report, "ffmpeg").status, "ok");
  assert.equal(tool(report, "ffmpeg").path, "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe");
});

test("Windows: an old yt-dlp is updated the way it was installed", () => {
  const update = (file) =>
    tool(
      machine({ platform: "win32", env: { Path: path.win32.dirname(file) }, files: [file], outputs: { [file]: "2026.02.01\n" } }),
      "yt-dlp",
    ).install;
  assert.equal(
    update("C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\yt-dlp.exe"),
    "winget upgrade --id yt-dlp.yt-dlp -e --source winget --accept-package-agreements --accept-source-agreements",
  );
  assert.equal(
    update("C:\\Python313\\Scripts\\yt-dlp.exe"),
    "python -m pip install -U yt-dlp",
  );
  assert.equal(
    update("C:\\tools\\yt-dlp.exe"),
    'run "C:\\tools\\yt-dlp.exe" -U (the release build updates itself)',
  );
});

test("a preference file saved by Windows PowerShell 5.1 (byte-order mark or UTF-16) is read", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "doctor 환경 "));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".agents"));
  const executable = path.join(home, "whisper-cli"), model = path.join(home, "모델.bin");
  await writeFile(executable, "");
  await writeFile(model, "");
  const json = JSON.stringify({ localAsrExecutable: executable, localAsrModel: model });
  for (const bytes of [
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, "utf16le")]),
  ]) {
    await writeFile(path.join(home, ".agents", "playback-notes-asr.json"), bytes);
    const report = diagnose({ home, probe: () => ({ ok: false, out: "" }) });
    assert.equal(tool(report, "whisper").status, "ok");
    assert.equal(tool(report, "whisper").model, model);
  }
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
    `printf '%s\\n' '{"localAsrExecutable":"/opt/homebrew/bin/whisper-cli","localAsrModel":"${model}"}' > "/home/me/.agents/playback-notes-asr.json"`,
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
  assert.equal(tool(report, "packages").install, 'npm ci --prefix "/skill"');
  assert.match(
    tool(report, "tesseract").note,
    /2 languages \(eng yes, kor no\)/,
  );
  assert.match(
    tool(report, "whisper").note,
    /whisper-cli is installed at \/usr\/bin\/whisper-cli, but no model/,
  );
  assert.deepEqual(report.features["youtube-transcription"].install, [
    // whisper-cli is already built: only curl, the model and the preference file are added.
    "sudo apt-get update && sudo apt-get install -y ffmpeg curl pipx",
    "pipx install yt-dlp",
    'mkdir -p "/home/me/.agents/models" && curl -L -o "/home/me/.agents/models/ggml-large-v3-turbo.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin  # 1.6 GB',
    `printf '%s\\n' '{"localAsrExecutable":"/usr/bin/whisper-cli","localAsrModel":"/home/me/.agents/models/ggml-large-v3-turbo.bin"}' > "/home/me/.agents/playback-notes-asr.json"`,
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

test("Linux as root (a container): a source build of whisper.cpp, pipx's yt-dlp, and PDF needs a regular user", () => {
  const report = machine({
    platform: "linux",
    root: true,
    arch: "arm64",
    env: { PATH: "/usr/bin:/bin" },
    files: ["/usr/bin/chromium", "/usr/bin/apt", "/home/me/.local/bin/yt-dlp"],
    outputs: { "/home/me/.local/bin/yt-dlp": "2026.10.26\n" },
    text: { "/skill/package.json": "{}" },
  });
  assert.equal(
    tool(report, "yt-dlp").path,
    "/home/me/.local/bin/yt-dlp",
    "pipx's directory is searched",
  );
  const browser = tool(report, "browser");
  assert.equal(browser.status, "not-usable");
  assert.match(browser.note, /regular \(non-root\) user/);
  assert.deepEqual(report.features.pdf.install, [
    "run the skill as a regular (non-root) user for PDF",
  ]);
  assert.equal(report.flags.browser, undefined);
  const src = "/home/me/.agents/whisper.cpp";
  assert.deepEqual(report.features.transcription.install.slice(0, 3), [
    "apt-get update && apt-get install -y ffmpeg git cmake build-essential curl",
    `[ -d "${src}" ] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp "${src}"`,
    `cmake -S "${src}" -B "${src}/build" -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF && cmake --build "${src}/build" -j --config Release --target whisper-cli`,
  ]);
  assert.match(
    report.features.transcription.install.at(-1),
    /"localAsrExecutable":"\/home\/me\/\.agents\/whisper\.cpp\/build\/bin\/whisper-cli"/,
  );
  // x64 keeps GCC's native CPU tuning; a missing browser installs with its sandbox helper.
  const x64 = machine({
    platform: "linux",
    env: { PATH: "/usr/bin" },
    text: { "/skill/package.json": "{}" },
  });
  assert.doesNotMatch(
    x64.features.transcription.install.join(" "),
    /GGML_NATIVE/,
  );
  assert.deepEqual(x64.features.pdf.install, [
    "sudo apt-get update && sudo apt-get install -y chromium chromium-sandbox",
  ]);
});

test("a Linux PDF launch failure names why Chromium's sandbox did not start, in fixed words", () => {
  assert.match(
    linuxSandboxCause(
      "[FATAL] Running as root without --no-sandbox is not supported",
    ),
    /does not run as root/,
  );
  assert.match(
    linuxSandboxCause(
      "No usable sandbox! If this is a Debian system, please install the chromium-sandbox package",
    ),
    /chromium-sandbox package/,
  );
  assert.match(
    linuxSandboxCause(
      "Failed to move to new namespace: ... errno = Operation not permitted",
    ),
    /Docker the default seccomp profile/,
  );
  assert.equal(
    linuxSandboxCause("Target page, context or browser has been closed"),
    null,
  );
  assert.doesNotMatch(
    linuxSandboxCause("No usable sandbox! /secret/path"),
    /secret/,
  );
});

test("doctor runs on this computer without installing anything", () => {
  const out = doctorResult(diagnose());
  assert.equal(out.status, "ok");
  assert.ok(out.tools.length >= 8);
  for (const t of out.tools) assert.ok(t.neededFor, t.name);
  for (const f of Object.values(out.features))
    assert.equal(f.ready, f.missing.length === 0);
});
