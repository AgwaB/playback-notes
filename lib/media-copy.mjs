import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { AppError, assertRelativePath, exists, regularFile, safeDirectory, within } from "./io.mjs";

export async function copyMedia(source, root, relative, maximum, expectedHash) {
  assertRelativePath(relative);
  await regularFile(source, maximum);
  const base = await safeDirectory(root),
    target = path.resolve(base, relative);
  if (!within(base, target) || target === base)
    throw new AppError("UNSAFE_PATH", "Invalid media output path.");
  await safeDirectory(path.dirname(target));
  if (await exists(target)) await regularFile(target, maximum);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let size = 0;
  const hash = createHash("sha256");
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maximum) {
        callback(
          new AppError(
            "RESOURCE_LIMIT",
            "Media copy exceeds the approved size limit.",
          ),
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(source),
      guard,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    if (expectedHash && hash.digest("hex") !== expectedHash)
      throw new AppError("EVIDENCE_MISMATCH", "Media changed during copy.");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
