/** Thumbdrive MCP entry point. Scaffold only: serves a health check. */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { APP_NAME, APP_VERSION } from "./version.ts";

export function createApp(): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true, name: APP_NAME, version: APP_VERSION }));
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8484);
  const hostname = process.env.BIND_HOST ?? "127.0.0.1";
  serve({ fetch: createApp().fetch, port, hostname }, (info) => {
    console.error(`${APP_NAME} ${APP_VERSION} listening on http://${hostname}:${info.port}`);
  });
}
