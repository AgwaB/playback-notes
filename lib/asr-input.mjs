import { constants } from "node:fs";
import { copyFile, link, rm } from "node:fs/promises";
import path from "node:path";

/** Windows whisper builds can decode narrow argv paths using the wrong code page. */
export async function withAsrModel(model, workDir, produce) {
  if (process.platform !== "win32") return produce(model);
  const alias = path.join(workDir, "asr-model.bin");
  try {
    await link(model, alias);
  } catch {
    // Cross-volume models cannot be hardlinked; never replace an existing alias.
    await copyFile(model, alias, constants.COPYFILE_EXCL);
  }
  try {
    return await produce("asr-model.bin");
  } finally {
    await rm(alias, { force: true });
  }
}
