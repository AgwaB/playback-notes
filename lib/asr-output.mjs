import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { networkError } from "./network.mjs";
import { runLocalTool } from "./local-tool.mjs";

const PIPE_CONNECT_GRACE_MS = 1000;

async function readBounded(stream, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximum)
      throw networkError("RESOURCE_LIMIT", "ASR output exceeds its byte budget.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** whisper.cpp appends .srt to its output base; both OS paths stream bounded bytes. */
export async function readAsrOutput(outputBase, options, produce) {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let readFailure;
  let socket;
  let server;
  let fifoKeeper;
  let rejectReading;
  let connectionDeadline;
  const windows = process.platform === "win32";
  const base = windows ? `\\\\.\\pipe\\playback-notes-${randomUUID()}` : outputBase;
  const outputPath = `${base}.srt`;
  let reading;
  const abort = () => {
    rejectReading?.(networkError("TIMEOUT", "Local ASR was interrupted."));
    socket?.destroy();
    server?.close();
  };
  try {
    if (windows) {
      reading = new Promise((resolve, reject) => {
        rejectReading = reject;
        server = createServer((connection) => {
          if (socket) { connection.destroy(); return; }
          socket = connection;
          clearTimeout(connectionDeadline);
          server.close();
          readBounded(connection, options.maxBytes).then(resolve, reject);
        });
      });
      server.on("error", rejectReading);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) throw networkError("TIMEOUT", "Local ASR was interrupted.");
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ path: outputPath, readableAll: false, writableAll: false }, resolve);
      });
    } else {
      await runLocalTool("/usr/bin/mkfifo", ["-m", "600", outputPath], options);
      // Keep a writer present so opening the FIFO reader never blocks when the
      // producer exits before it connects. Closing it after production permits EOF.
      fifoKeeper = await open(outputPath, constants.O_RDWR | constants.O_NONBLOCK);
      const fifoReader = await open(outputPath, constants.O_RDONLY);
      reading = readBounded(fifoReader.createReadStream({ signal }), options.maxBytes);
    }
    const guarded = reading.catch((error) => {
      readFailure = error;
      controller.abort();
      throw error;
    });
    const producing = Promise.resolve().then(() => produce(base, signal)).then(() => {
      if (windows && !socket && !signal.aborted) {
        // Process exit can be delivered before a pending pipe connection callback.
        // Allow that callback to arrive; never time out an already connected reader.
        connectionDeadline = setTimeout(() => {
          if (!socket && !signal.aborted)
            rejectReading(networkError("NO_USABLE_EVIDENCE", "The ASR process completed without opening its transcript output."));
        }, PIPE_CONNECT_GRACE_MS);
      }
    }).finally(async () => {
      await fifoKeeper?.close();
      fifoKeeper = undefined;
    });
    const [raw] = await Promise.all([guarded, producing]);
    return raw;
  } catch (error) {
    if (readFailure?.code === "RESOURCE_LIMIT") throw readFailure;
    throw error;
  } finally {
    clearTimeout(connectionDeadline);
    controller.abort();
    signal.removeEventListener("abort", abort);
    abort();
    await fifoKeeper?.close();
    // A producer can fail before connecting; still observe the cancelled reader.
    await reading?.catch(() => {});
    if (!windows) await rm(outputPath, { force: true });
  }
}
