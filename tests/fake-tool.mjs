import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
let launcherBytes;

async function compileLauncher(directory) {
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const candidates = ["Framework64", "Framework"].map((architecture) =>
    path.join(windows, "Microsoft.NET", architecture, "v4.0.30319", "csc.exe"),
  );
  let compiler;
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) {
      compiler = candidate;
      break;
    }
  }
  if (!compiler)
    throw new Error("Windows test fixtures require the .NET Framework C# compiler (csc.exe)");

  const work = await mkdtemp(path.join(directory, ".fake-tool-"));
  try {
    const source = path.join(work, "Launcher.cs");
    const executable = path.join(work, "Launcher.exe");
    await writeFile(source, String.raw`
using System;
using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;

class Launcher {
  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      if (character == '"') {
        result.Append('\\', slashes * 2 + 1).Append('"');
      } else {
        result.Append('\\', slashes).Append(character);
      }
      slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }

  static int Main(string[] args) {
    string arguments = Quote(Assembly.GetExecutingAssembly().Location + ".mjs");
    foreach (string argument in args) arguments += " " + Quote(argument);
    var start = new ProcessStartInfo {
      FileName = ${JSON.stringify(process.execPath)},
      Arguments = arguments,
      UseShellExecute = false,
      CreateNoWindow = true,
      RedirectStandardInput = true,
      RedirectStandardOutput = true,
      RedirectStandardError = true
    };
    using (var child = Process.Start(start)) {
      var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
      var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
      Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream)
        .ContinueWith(completed => child.StandardInput.Close());
      child.WaitForExit();
      Task.WaitAll(output, error);
      return child.ExitCode;
    }
  }
}
`, "utf8");
    await exec(compiler, ["/nologo", "/codepage:65001", "/target:exe", `/out:${executable}`, source], {
      windowsHide: true,
      timeout: 30000,
    });
    return await readFile(executable);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// Exercise the same shell:false process boundary as a real tool on every OS.
export async function fakeTool(file, source) {
  if (process.platform !== "win32") {
    await writeFile(file, `#!${process.execPath}\n${source}`, { mode: 0o700 });
    return file;
  }
  launcherBytes ??= compileLauncher(path.dirname(file));
  const executable = `${file}.exe`;
  await writeFile(`${executable}.mjs`, source);
  // Preserve executable content identity for ingestion fingerprint tests.
  const digest = createHash("sha256").update(source).digest();
  await writeFile(executable, Buffer.concat([await launcherBytes, digest]));
  return executable;
}
