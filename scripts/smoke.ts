/**
 * Smoke test against a running server: connects with the MCP client and calls
 * every tool once.
 *
 *   THUMBDRIVE_KEY=td_... npm run smoke -- http://127.0.0.1:8484/mcp
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = process.argv[2] ?? "http://127.0.0.1:8484/mcp";
const key = process.env.THUMBDRIVE_KEY;
if (!key) {
  console.error("Set THUMBDRIVE_KEY");
  process.exit(2);
}

const client = new Client({ name: "thumbdrive-smoke", version: "0.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
);
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => `${t.name}${t.annotations?.readOnlyHint ? " (read-only)" : ""}`).join(", "));

type Block = { type: string; text?: string };
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const body = (result.content as Block[]).map((b) => b.text ?? "").join("\n---\n");
  console.log(`\n> ${name} ${JSON.stringify(args)}${result.isError ? "  [error]" : ""}\n${body.slice(0, 600)}`);
  return result;
}

const listing = await call("list", { path: "/" });
const first = JSON.parse((listing.content as Block[])[0].text ?? "{}").entries?.[0];
if (first) {
  const folder = first.type === "folder" ? first.path : "/";
  const inner = await call("list", { path: folder });
  const file = JSON.parse((inner.content as Block[])[0].text ?? "{}").entries?.find((e: { type: string }) => e.type === "file");
  if (file) {
    await call("read", { path: file.path });
    await call("history", { path: file.path });
    await call("search", { query: file.name.split(".")[0] });
  }
}
await client.close();
