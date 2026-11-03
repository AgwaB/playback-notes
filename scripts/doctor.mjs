// Which local tools this computer has, what each one enables, and the install command for
// this operating system. Run before asking the user anything, so the questions offer only
// what can work and a missing essential tool is raised up front. Read-only: it never
// installs, downloads or changes anything. Uses only Node's built-in modules, so it also
// runs before `npm ci`.
import nodePath from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMain, optionsFor, result, runCli } from "../lib/cli.mjs";
import { issue, jsonText } from "../lib/io.mjs";
import { SAFE_PATH } from "../lib/runtime.mjs";

const SKILL_DIR = fileURLToPath(new URL("..", import.meta.url));
// yt-dlp older than this usually fails on YouTube (HTTP 403); updates ship every few weeks.
const YT_DLP_MAX_AGE_DAYS = 90;

const NEEDED_FOR = {
  node: "everything",
  packages: "everything",
  ffmpeg:
    "local files, direct media links, video posts on X, podcasts without a published transcript, any local transcription and slide captures",
  "yt-dlp":
    "slide captures from YouTube and transcribing a YouTube video's audio",
  whisper:
    "recordings without captions: every video post on X, some YouTube videos and podcasts, and your own files",
  browser: "PDF output",
  tesseract: "on-screen text (OCR) and translated slide images, on any system",
  vision:
    "on-screen text (OCR) and translated slide images on macOS (reads slides better than tesseract)",
};
// What installs each tool, by package manager, so the tools one choice needs install in
// as few commands as possible. `run` entries are steps the agent runs as written.
const PACKAGES = {
  darwin: {
    node: { brew: ["node@24"] },
    ffmpeg: { brew: ["ffmpeg"] },
    "yt-dlp": { brew: ["yt-dlp"] },
    "yt-dlp-update": { run: ["brew upgrade yt-dlp"] },
    whisper: { brew: ["whisper.cpp"] },
    browser: { cask: ["google-chrome"] },
    tesseract: { brew: ["tesseract", "tesseract-lang"] },
    vision: { run: ["xcode-select --install"] },
    manager: { run: ["Homebrew from https://brew.sh"] },
  },
  win32: {
    node: { winget: ["OpenJS.NodeJS.LTS"] },
    ffmpeg: { winget: ["Gyan.FFmpeg"] },
    "yt-dlp": { winget: ["yt-dlp.yt-dlp"] },
    "yt-dlp-update": { run: ["winget upgrade --id yt-dlp.yt-dlp -e --source winget"] },
    whisper: { run: ['the commands in references/windows.md, "Local transcription" (they also write the preference file)'] },
    // winget's catalogue lists Chrome's stable channel only as the EXE installer.
    browser: { winget: ["Google.Chrome.EXE"] },
    tesseract: { winget: ["UB-Mannheim.TesseractOCR"] },
    manager: { run: ["winget (App Installer from the Microsoft Store)"] },
  },
  linux: {
    node: { run: ["Node.js 24.15+ from https://nodejs.org or your distribution"] },
    ffmpeg: { apt: ["ffmpeg"] },
    "yt-dlp": { pipx: ["yt-dlp"] },
    "yt-dlp-update": { run: ["pipx upgrade yt-dlp"] },
    whisper: { run: ['build whisper.cpp and download the model as the README\'s "Optional: local transcription" describes'] },
    browser: { apt: ["chromium"] },
    tesseract: { apt: ["tesseract-ocr", "tesseract-ocr-kor"] },
    manager: { run: ["apt (Debian/Ubuntu; use your distribution's package manager otherwise)"] },
  },
};
/** Commands for a set of install specs, one per package manager, in a stable order. */
export function installCommands(specs) {
  const merged = { brew: [], cask: [], winget: [], apt: [], pipx: [], run: [] };
  for (const spec of specs)
    for (const [kind, items] of Object.entries(spec ?? {}))
      for (const item of items) if (!merged[kind].includes(item)) merged[kind].push(item);
  return [
    merged.brew.length && `brew install ${merged.brew.join(" ")}`,
    merged.cask.length && `brew install --cask ${merged.cask.join(" ")}`,
    // --source winget: the IDs are the winget catalogue's, and the Microsoft Store source
    // would first ask an agent's terminal to accept its terms.
    ...merged.winget.map((id) => `winget install --id ${id} -e --source winget`),
    merged.apt.length && `sudo apt install ${merged.apt.join(" ")}`,
    merged.pipx.length && `pipx install ${merged.pipx.join(" ")}`,
    ...merged.run,
  ].filter(Boolean);
}
// What each choice the user can make needs. `anyOf` is satisfied by one of its tools.
const FEATURES = {
  "local-media": { needs: ["ffmpeg", "ffprobe"], for: "a local file or a direct media link" },
  transcription: {
    needs: ["ffmpeg", "ffprobe", "whisper"],
    for: "transcribing a recording without captions (every video post on X, podcasts without a transcript, your own files)",
  },
  "youtube-transcription": {
    needs: ["ffmpeg", "ffprobe", "whisper", "yt-dlp"],
    for: "transcribing a YouTube video's audio (no captions, or only automatic ones)",
  },
  captures: { needs: ["ffmpeg", "ffprobe"], for: "slide captures from a local file or an X post" },
  "youtube-captures": { needs: ["ffmpeg", "ffprobe", "yt-dlp"], for: "slide captures from YouTube" },
  pdf: { needs: ["browser"], for: "PDF output" },
  "slide-translation": { anyOf: ["vision", "tesseract"], for: "translated slide images" },
};

function realProbe(file, args) {
  const run = spawnSync(file, args, {
    timeout: 8000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: !run.error && run.status === 0,
    out: `${run.stdout ?? ""}${run.stderr ?? ""}`,
  };
}
function realExists(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Check the tools. Every probe is injectable so other platforms can be tested anywhere.
 * `probe(file, args)` runs a tool; `exists(file)` tests a regular file.
 */
export function diagnose({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  now = Date.now(),
  nodeVersion = process.versions.node,
  skillDir = SKILL_DIR,
  probe = realProbe,
  exists = realExists,
  // JSON saved by Windows PowerShell 5.1 has a byte-order mark or is UTF-16.
  readText = (file) => jsonText(readFileSync(file)),
  list = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
} = {}) {
  const win = platform === "win32";
  const p = win ? nodePath.win32 : nodePath.posix;
  const os_ = PACKAGES[platform] ? platform : "linux";
  const spec = (name) => PACKAGES[os_][name] ?? null;
  const install = (name) => installCommands([spec(name)]).join("; ") || null;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const userDirs = (env[pathKey] ?? "")
    .split(win ? ";" : ":")
    // Windows allows a PATH entry in double quotes (a folder with a ";" or as some installers
    // write it); programs are found in it, so it counts here too.
    .map((dir) => (win ? dir.replace(/^"(.*)"$/, "$1") : dir))
    .filter(Boolean);
  const workerDirs = win ? userDirs : SAFE_PATH.split(":");
  // Windows places what winget just installed, and Tesseract, outside the PATH of programs
  // that were already running (or outside any PATH, for Tesseract). winget links portable
  // packages in WinGet\Links only where symbolic links are allowed (Developer Mode or an
  // administrator); otherwise it adds the package folder under WinGet\Packages to PATH.
  const wingetPackages =
    env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
  const wingetDirs = (id) =>
    wingetPackages
      ? list(wingetPackages)
          .filter((name) => name.startsWith(`${id}_`))
          .flatMap((name) => {
            const dir = p.join(wingetPackages, name);
            return [
              dir,
              ...list(dir).flatMap((sub) => [p.join(dir, sub), p.join(dir, sub, "bin")]),
            ];
          })
      : [];
  const installedDirs = win
    ? [
        env.LOCALAPPDATA &&
          p.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
        ...wingetDirs("Gyan.FFmpeg"),
        ...wingetDirs("yt-dlp.yt-dlp"),
        env.ProgramFiles && p.join(env.ProgramFiles, "Tesseract-OCR"),
        env["ProgramFiles(x86)"] &&
          p.join(env["ProgramFiles(x86)"], "Tesseract-OCR"),
      ].filter(Boolean)
    : [];
  const exe = (name) => (win ? `${name}.exe` : name);
  const find = (name, dirs) =>
    dirs.map((dir) => p.join(dir, exe(name))).find((file) => exists(file)) ??
    null;
  const firstLine = (text) =>
    text.split(/\r?\n/).find(Boolean)?.slice(0, 160) ?? null;
  const tools = [];
  // How to fix each tool that is not ok, kept for merging per feature.
  const fixes = new Map();
  const add = (name, status, extra = {}) => {
    const { fix: given, ...rest } = extra;
    const fix =
      given !== undefined
        ? given
        : status === "ok"
          ? null
          : spec(name.replace(/^ffprobe$/, "ffmpeg"));
    fixes.set(name, fix);
    tools.push({
      name,
      status,
      path: null,
      version: null,
      neededFor: NEEDED_FOR[name.replace(/^ffprobe$/, "ffmpeg")],
      install: fix ? installCommands([fix]).join("; ") || null : null,
      note: null,
      ...rest,
    });
  };
  const manager = win ? "winget" : platform === "darwin" ? "brew" : "apt";
  const managerFound =
    find(manager, [...userDirs, ...workerDirs]) ??
    // winget is an App Execution Alias: a link into a folder this account cannot read, so it
    // is not seen as a file; running it is the check.
    (win && probe(exe(manager), ["--version"]).ok ? exe(manager) : null);

  // Node.js: 24.15+ in the 24 line, or 26+ (25 is not supported).
  const [major, minor] = nodeVersion.split(".").map(Number);
  add(
    "node",
    (major === 24 && minor >= 15) || major >= 26 ? "ok" : "unsupported",
    { version: nodeVersion },
  );

  // The skill's own packages (`npm ci` in the installation).
  let missingPackages = [];
  try {
    const manifest = JSON.parse(readText(p.join(skillDir, "package.json")));
    missingPackages = Object.keys(manifest.dependencies ?? {}).filter(
      (dep) =>
        !exists(
          p.join(skillDir, "node_modules", ...dep.split("/"), "package.json"),
        ),
    );
  } catch {
    missingPackages = ["package.json unreadable"];
  }
  add("packages", missingPackages.length ? "missing" : "ok", {
    fix: missingPackages.length ? { run: [`npm ci (in ${skillDir})`] } : null,
    note: missingPackages.length
      ? `Missing: ${missingPackages.join(", ")}`
      : null,
  });

  // ffmpeg and ffprobe, where the extraction worker looks for them.
  for (const name of ["ffmpeg", "ffprobe"]) {
    const file = find(name, workerDirs);
    const run = file ? probe(file, ["-version"]) : null;
    if (run?.ok) {
      add(name, "ok", { path: file, version: firstLine(run.out) });
      continue;
    }
    const elsewhere = find(name, win ? installedDirs : userDirs);
    add(name, elsewhere ? "not-visible" : "missing", {
      path: elsewhere ?? file,
      ...(elsewhere && win
        ? { fix: { run: [`restart the agent (close and reopen its terminal or app) so PATH includes ${name}`] } }
        : {}),
      note: elsewhere
        ? win
          ? `Installed at ${elsewhere}, but PATH here does not include it yet: programs started before the install, and what they start, keep the old PATH. Restart the agent (close and reopen its terminal or app).`
          : `Found at ${elsewhere}, but extraction only looks in ${workerDirs.join(", ")}; link it there or install it with the command shown.`
        : file
          ? "Found but it did not run."
          : null,
    });
  }

  // yt-dlp: any location (its path is passed explicitly); too old usually fails on YouTube.
  const ytDlp = find("yt-dlp", [...userDirs, ...workerDirs, ...installedDirs]);
  const ytRun = ytDlp ? probe(ytDlp, ["--version"]) : null;
  if (!ytRun?.ok) add("yt-dlp", "missing", { path: ytDlp });
  else {
    const version = firstLine(ytRun.out);
    const date = /^(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(version ?? "");
    const ageDays = date
      ? (now -
          Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]))) /
        86400000
      : null;
    const outdated = ageDays !== null && ageDays > YT_DLP_MAX_AGE_DAYS;
    // On Windows, update it the way it was installed: winget, pip, or the release build's
    // own updater.
    const update = !win
      ? spec("yt-dlp-update")
      : /\\WinGet\\/i.test(ytDlp)
        ? spec("yt-dlp-update")
        : /\\Scripts\\yt-dlp\.exe$/i.test(ytDlp)
          ? { run: ["python -m pip install -U yt-dlp"] }
          : { run: [`run "${ytDlp}" -U (the release build updates itself)`] };
    add("yt-dlp", outdated ? "outdated" : "ok", {
      path: ytDlp,
      version,
      fix: outdated ? update : null,
      note: outdated
        ? `About ${Math.round(ageDays)} days old; YouTube usually refuses old versions. Update it the way it was installed.`
        : null,
    });
  }

  // whisper.cpp: the saved preference (executable and model), else an unconfigured binary.
  const prefsPaths = [
    p.join(home, ".agents", "playback-notes-asr.json"),
    p.join(home, ".agents", "video-summarizer-asr.json"),
  ];
  const prefs = prefsPaths.find((file) => exists(file));
  // macOS: Homebrew's whisper.cpp, the turbo model (1.6 GB) and the preference file that
  // names them, so one approval sets transcription up. Other systems keep their guides.
  const modelPath = p.join(home, ".agents", "models", "ggml-large-v3-turbo.bin");
  function whisperFix(prefsFile, binary = null) {
    if (platform !== "darwin") return spec("whisper");
    const brewBin = managerFound ? p.dirname(managerFound) : "/opt/homebrew/bin";
    const executable = binary ?? p.join(brewBin, "whisper-cli");
    return {
      brew: binary ? [] : ["whisper.cpp"],
      run: [
        ...(exists(modelPath)
          ? []
          : [
              `mkdir -p "${p.dirname(modelPath)}" && curl -L -o "${modelPath}" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin  # 1.6 GB`,
            ]),
        `write ${prefsFile} containing ${JSON.stringify({ localAsrExecutable: executable, localAsrModel: modelPath })}`,
      ],
    };
  }
  if (prefs) {
    let pref = {};
    try {
      pref = JSON.parse(readText(prefs));
    } catch {
      // Reported below as not configured.
    }
    const runtime =
      typeof pref.localAsrExecutable === "string" &&
      exists(pref.localAsrExecutable);
    const model =
      typeof pref.localAsrModel === "string" && exists(pref.localAsrModel);
    add("whisper", runtime && model ? "ok" : "missing", {
      path: runtime ? pref.localAsrExecutable : null,
      model: model ? pref.localAsrModel : null,
      ...(runtime && model
        ? {}
        : { fix: whisperFix(prefs, runtime ? pref.localAsrExecutable : null) }),
      note:
        runtime && model
          ? `Model: ${pref.localAsrModel}`
          : `${prefs} names ${runtime ? "" : "an executable "}${!runtime && !model ? "and " : ""}${model ? "" : "a model "}that does not exist.`,
    });
  } else {
    const binary = find("whisper-cli", [...userDirs, ...workerDirs]);
    add("whisper", "missing", {
      path: binary,
      model: null,
      fix: whisperFix(prefsPaths[0], binary),
      note: binary
        ? `whisper-cli is installed at ${binary}, but no model and preference file are set up (README "Optional: local transcription").`
        : null,
    });
  }

  // A Chrome-family browser for PDF output.
  const programFiles = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA,
  ].filter(Boolean);
  const browsers = win
    ? programFiles.flatMap((root) => [
        p.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        p.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      ])
    : platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          p.join(
            home,
            "Applications",
            "Google Chrome.app",
            "Contents",
            "MacOS",
            "Google Chrome",
          ),
        ]
      : [
          "google-chrome",
          "google-chrome-stable",
          "chromium",
          "chromium-browser",
        ]
          .map((name) => find(name, userDirs))
          .filter(Boolean);
  const browser = browsers.find((file) => exists(file)) ?? null;
  add("browser", browser ? "ok" : "missing", {
    path: browser,
    note: browser ? "Pass it as --browser-executable for PDF." : null,
  });

  // OCR: tesseract anywhere; the Apple Vision helper on macOS (compiled with swiftc).
  const tesseract = find("tesseract", [
    ...userDirs,
    ...workerDirs,
    ...installedDirs,
  ]);
  const langs = tesseract ? probe(tesseract, ["--list-langs"]) : null;
  add("tesseract", langs?.ok ? "ok" : "missing", {
    path: tesseract,
    note: langs?.ok
      ? (() => {
          const list = langs.out
            .split(/\r?\n/)
            .slice(1)
            .map((l) => l.trim())
            .filter(Boolean);
          const has = (code) =>
            list.includes(code) ? `${code} yes` : `${code} no`;
          return `${list.length} languages (${has("eng")}, ${has("kor")}); pass codes such as eng+kor.`;
        })()
      : null,
  });
  if (platform === "darwin") {
    const swiftc = find("swiftc", ["/usr/bin", ...userDirs]);
    const run = swiftc ? probe(swiftc, ["--version"]) : null;
    add("vision", run?.ok ? "ok" : "missing", {
      path: run?.ok ? swiftc : null,
      note: run?.ok
        ? `Compile the helper once: swiftc -O -o "$PRIVATE/vision-ocr" "${p.join(skillDir, "scripts", "vision-ocr.swift")}"`
        : "Needs the Xcode Command Line Tools to compile the helper.",
    });
  }

  // Each choice: ready, or the tools it lacks and the fewest commands that add them.
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const usable = (name) => byName.get(name)?.status === "ok";
  const features = Object.fromEntries(
    Object.entries(FEATURES).map(([key, feature]) => {
      const names = feature.anyOf
        ? [
            feature.anyOf.find(usable) ??
              feature.anyOf.find((name) => byName.has(name)),
          ]
        : feature.needs;
      const missing = names.filter((name) => !usable(name));
      return [
        key,
        {
          for: feature.for,
          ready: !missing.length,
          missing,
          install: installCommands(missing.map((name) => fixes.get(name))),
        },
      ];
    }),
  );
  // Ready-made options for the tools that are there, so the agent never asks for paths.
  const at = (name) => `"${byName.get(name).path}"`;
  const flags = {};
  if (byName.get("yt-dlp").path && byName.get("yt-dlp").status !== "missing")
    flags["yt-dlp"] = `--yt-dlp-executable ${at("yt-dlp")}`;
  if (usable("whisper"))
    flags.asr = `--local-asr-executable ${at("whisper")} --local-asr-model "${byName.get("whisper").model}"`;
  if (usable("browser")) flags.browser = `--browser-executable ${at("browser")}`;
  if (usable("tesseract"))
    flags.tesseract = `--ocr-engine tesseract --ocr-executable ${at("tesseract")}`;
  if (usable("vision"))
    flags.vision = `--ocr-engine vision --ocr-executable "$PRIVATE/vision-ocr" (after compiling the helper as noted)`;
  return {
    platform,
    packageManager: {
      name: manager,
      found: Boolean(managerFound),
      install: managerFound ? null : install("manager"),
    },
    features,
    flags,
    tools,
  };
}

export function doctorResult(report) {
  const blocking = report.tools.filter(
    (t) => ["node", "packages"].includes(t.name) && t.status !== "ok",
  );
  const unready = Object.entries(report.features).filter(([, f]) => !f.ready);
  const issues = [];
  if (blocking.length)
    issues.push(
      issue(
        "SKILL_NOT_READY",
        `The skill cannot run until this is fixed: ${blocking
          .map((t) => `${t.name} (${t.status})${t.install ? `: ${t.install}` : ""}${t.note ? `. ${t.note}` : ""}`)
          .join(" | ")}`,
        "error",
      ),
    );
  if (unready.length)
    issues.push(
      issue(
        "FEATURES_NEED_INSTALL",
        `Not ready here: ${unready
          .map(([key, f]) => `${key} (${f.for}) needs ${f.missing.join(", ")}; install: ${f.install.join("; ")}`)
          .join(" | ")}. Name the install in the option that needs it; choosing that option approves it. Run all its commands at once, then run doctor again${report.platform === "win32" ? "; ffmpeg reported not-visible needs the agent restarted (close and reopen its terminal or app) before it can be used, while tools passed by path work at once" : ""}.${report.packageManager.found ? "" : ` The install commands need ${report.packageManager.install}.`}`,
        "warning",
      ),
    );
  if (!issues.length)
    issues.push(issue("TOOLS_OK", "Every feature is ready.", "info"));
  return { ...result("doctor", [], issues), ...report };
}

if (isMain(import.meta.url))
  await runCli("doctor", () => {
    optionsFor([]);
    return doctorResult(diagnose());
  });
