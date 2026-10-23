/** Entry point. `tsx src/index.ts` serves HTTP; `tsx src/index.ts --stdio` speaks MCP over stdio. */
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { KeyStore } from "./auth/keys.ts";
import { loadConfig } from "./config.ts";
import { createApp } from "./http/app.ts";
import { startStdio } from "./stdio.ts";
import { Drive } from "./storage/drive.ts";
import { APP_NAME, APP_VERSION } from "./version.ts";

export { createApp } from "./http/app.ts";

function main(): void {
  const config = loadConfig();
  if (process.argv.includes("--stdio")) {
    startStdio(config);
    return;
  }
  const drive = new Drive(config.dataDir, { maxFileBytes: config.maxFileBytes });
  const keys = new KeyStore(drive.db);
  const { app, close } = createApp({ drive, keys, config });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.bindHost }, (info) => {
    console.log(`${APP_NAME} ${APP_VERSION} on http://${info.address}:${info.port}/mcp (data: ${config.dataDir})`);
    if (keys.list().every((k) => k.revoked_at)) {
      console.log("No active keys yet. Create one: npm run admin -- key create my-agent --folder /");
    }
  });
  const shutdown = () => {
    server.close();
    void close().finally(() => {
      drive.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
