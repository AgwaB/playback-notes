import path from "node:path";
import { stat } from "node:fs/promises";

/** Windows builds can fail to discover tessdata when the executable path is Unicode. */
export async function tesseractDataArgs(executable) {
  if (process.platform !== "win32") return [];
  const dataDir = path.join(path.dirname(executable), "tessdata");
  const directory = await stat(dataDir).then((entry) => entry.isDirectory(), () => false);
  return directory ? ["--tessdata-dir", dataDir] : [];
}
