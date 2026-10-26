import { isMain, optionsFor, required, result, runCli } from "../lib/cli.mjs";
import { startServer } from "../lib/server.mjs";

if (isMain(import.meta.url))
  await runCli("serve", async () => {
    const options = optionsFor(["root", "job-manifest", "port"]);
    required(options, ["root"]);
    const running = await startServer({
      root: options.root,
      jobManifest: options["job-manifest"],
      port: options.port === undefined ? 0 : Number(options.port),
    });
    const stop = () => {
      running.server.close();
      running.server.closeAllConnections();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return {
      ...result("serve"),
      server: { url: running.url, host: running.host, port: running.port },
    };
  });
