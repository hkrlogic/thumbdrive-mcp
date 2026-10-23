/**
 * End to end through the real transports: a Hono server on a random local
 * port with the MCP client over Streamable HTTP, and the stdio entry point
 * spawned as a subprocess.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createApp } from "../src/http/app.ts";
import { keysFor, tempDrive, testConfig, text } from "./helpers.ts";

const drive = tempDrive();
drive.putFile("/shared/hello.txt", text("hello from the drive\n"));
drive.putFile("/shared/hello.txt", text("hello again\n"));
drive.putFile("/shared/data.csv", text("a,b\n1,2\n"));
drive.putFile("/private/secret.txt", text("do not show"));
const keys = keysFor(drive);
const sharedKey = keys.create("shared-agent", ["/shared"]).key;
const rootKey = keys.create("root-agent", ["/"]).key;
const config = testConfig(drive, { rateLimitPerMinute: 40 });
const { app, close } = createApp({ drive, keys, config });
let base = "";
let server: ReturnType<typeof serve>;

before(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await close();
  await new Promise((resolve) => server.close(resolve));
});

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: "thumbdrive-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

type TextBlock = { type: "text"; text: string };
const texts = (result: { content?: unknown }) => (result.content as TextBlock[]).map((c) => c.text);

test("health check answers", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);
});

test("/mcp needs a valid key", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const none = await fetch(`${base}/mcp`, { method: "POST", headers, body });
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate") ?? "", /^Bearer/);
  const wrong = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...headers, authorization: "Bearer td_wrongwrongwrong" },
    body,
  });
  assert.equal(wrong.status, 401);
});

test("/mcp refuses foreign Host headers and plain HTTP behind a proxy", async () => {
  const req = (extra: Record<string, string>) => {
    const r = new Request(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${rootKey}`, "content-type": "application/json", ...extra },
      body: "{}",
    });
    return app.fetch(r);
  };
  assert.equal((await req({ host: "evil.example" })).status, 403);
  assert.equal((await req({ host: "localhost", "x-forwarded-proto": "http" })).status, 403);
  assert.equal((await req({ host: "localhost", origin: "https://evil.example" })).status, 403);
});

test("tools are the four read-only tools", async () => {
  const client = await connect(sharedKey);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["history", "list", "read", "search"]);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.equal(t.annotations?.destructiveHint, false, t.name);
  }
  await client.close();
});

test("list, read, search and history over HTTP, scoped to the key", async () => {
  const client = await connect(sharedKey);
  const root = JSON.parse(texts(await client.callTool({ name: "list", arguments: { path: "/" } }))[0]);
  assert.deepEqual(root.entries.map((e: { path: string }) => e.path), ["/shared"]);

  const [metaJson, content] = texts(await client.callTool({ name: "read", arguments: { path: "/shared/hello.txt" } }));
  assert.equal(content, "hello again\n");
  const meta = JSON.parse(metaJson);
  assert.equal(meta.version, 2);
  assert.match(meta.sha256, /^[0-9a-f]{64}$/);

  const csv = texts(await client.callTool({ name: "read", arguments: { path: "/shared/data.csv", format: "text" } }));
  assert.deepEqual(JSON.parse(csv[1]), { header: ["a", "b"], rows: [["1", "2"]] });

  const old = texts(await client.callTool({ name: "read", arguments: { path: "/shared/hello.txt", version: 1 } }));
  assert.equal(old[1], "hello from the drive\n");

  const hist = JSON.parse(texts(await client.callTool({ name: "history", arguments: { path: "/shared/hello.txt" } }))[0]);
  assert.deepEqual(hist.versions.map((v: { version: number }) => v.version), [2, 1]);

  const found = JSON.parse(texts(await client.callTool({ name: "search", arguments: { query: "hello" } }))[0]);
  assert.deepEqual(found.hits.map((h: { path: string }) => h.path), ["/shared/hello.txt"]);
  const hidden = JSON.parse(texts(await client.callTool({ name: "search", arguments: { query: "do not show" } }))[0]);
  assert.deepEqual(hidden.hits, []);

  const denied = await client.callTool({ name: "read", arguments: { path: "/private/secret.txt" } });
  assert.equal(denied.isError, true);
  assert.deepEqual(texts(denied), ["Not found: /private/secret.txt"]);
  const traversal = await client.callTool({ name: "read", arguments: { path: "/shared/../private/secret.txt" } });
  assert.equal(traversal.isError, true);
  assert.match(texts(traversal)[0], /'\.\.' is not allowed/);
  await client.close();

  const recent = drive.recentActivity(20).map((a) => `${a.actor} ${a.action} ${a.path}`);
  assert.ok(recent.includes("key:shared-agent read /shared/hello.txt"));
});

test("per-key rate limit answers 429", async () => {
  const limited = keys.create("busy-agent", ["/shared"]).key;
  const statuses: number[] = [];
  for (let i = 0; i < 45; i++) {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${limited}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" }),
    });
    statuses.push(res.status);
    await res.body?.cancel();
  }
  assert.ok(statuses.includes(429));
});

test("stdio transport serves the same tools with THUMBDRIVE_KEY", async () => {
  const client = new Client({ name: "thumbdrive-stdio-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts", "--stdio"],
    env: { ...process.env, DATA_DIR: drive.dataDir, THUMBDRIVE_KEY: sharedKey } as Record<string, string>,
    stderr: "ignore",
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 4);
  const [, content] = texts(await client.callTool({ name: "read", arguments: { path: "/shared/hello.txt" } }));
  assert.equal(content, "hello again\n");
  const denied = await client.callTool({ name: "list", arguments: { path: "/private" } });
  assert.equal(denied.isError, true);
  await client.close();
});
