/**
 * CyberDrive Windows security events: workbook validation, lookup (versions,
 * multiple subcategories, message-only events, No match), search, key
 * scoping, logging and MCP. Fixtures are synthetic workbooks built in-test;
 * set WINEVENT_XLSX to Microsoft's real file to also check it.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { after, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DatasetReader } from "../src/cyberdrive/agent.ts";
import { DatasetStore } from "../src/cyberdrive/datasets.ts";
import { WinEventLookup, wineventDataset } from "../src/cyberdrive/winevent.ts";
import { createApp } from "../src/http/app.ts";
import { keysFor, tempDrive, testConfig } from "./helpers.ts";
import { type SheetRows, xlsx } from "./xlsx.ts";

const EVENTS: SheetRows = [
  ["Category", "Subcategory", "Event ID", "Message Summary", "Minimum Operating System Requirement"],
  ["Logon/Logoff", "Logon", 4624, "An account was successfully logged on.", "Windows Vista, Windows Server 2008"],
  ["Logon/Logoff", "Logon", 4625, "An account failed to log on.", "Windows Vista, Windows Server 2008"],
  ["Object Access", "SAM", 4663, "An attempt was made to access an object.", "Windows Vista, Windows Server 2008"],
  ["Object Access", "Kernel", 4663, "An attempt was made to access an object.", "Windows Vista, Windows Server 2008"],
  ["Account Management", "User Account Management", 4720, "A user account was created.", "Windows Vista, Windows Server 2008"],
  ["System", "Other System Events", 5000, "Summary only event.", "Windows 10"],
  ["System", "Bogus", "not-an-id", "Skipped", "x"],
];
const MESSAGES: SheetRows = [
  ["Event ID", "Version", "Detailed Message", "Minimum Operating System Requirement"],
  [4624, 0, "An account was successfully logged on.\r\n\r\nSubject:\r\n\tSecurity ID:\t\t%1", "Windows Vista, Windows Server 2008"],
  [4624, 1, "An account was successfully logged on.\r\n\r\nSubject:\r\n\tSecurity ID:\t\t%1\r\nRestricted Admin Mode:\t%22", "Windows 8, Windows Server 2012"],
  [4624, 2, "An account was successfully logged on.\r\n\r\nElevated Token:\t\t%27", "Windows 10"],
  [4625, 0, "An account failed to log on.\r\n\r\nFailure Reason:\t\t%9", "Windows Vista, Windows Server 2008"],
  [4663, 0, "An attempt was made to access an object.", "Windows Vista, Windows Server 2008"],
  [4720, 0, "A user account was created.\r\n\r\n    New Account:\r\n        Kerberos stuff:\t%5", "Windows Vista, Windows Server 2008"],
  [8191, 0, "Highest System-Defined Audit Message Value.", "N/A"],
];
const workbook = (events = EVENTS, messages = MESSAGES) =>
  xlsx({ "Security Audit Events": events, "Complete Event Messages": messages, Notes: [["unrelated"]] });

async function imported() {
  const drive = tempDrive();
  const datasets = new DatasetStore(drive, [wineventDataset]);
  const row = await datasets.importBytes("winevent", workbook(), "test", "admin");
  return { drive, datasets, row, win: new WinEventLookup(datasets) };
}

// ---------- import ----------

test("import counts distinct event IDs and skips bad rows", async () => {
  const { row, datasets } = await imported();
  assert.equal(row.version, 1);
  assert.equal(row.rows, 6, "4624 4625 4663 4720 5000 8191");
  assert.ok(row.skipped >= 1);
  assert.equal(datasets.kind("winevent").unit, "events");
});

test("import rejects files that are not the catalog", async () => {
  const datasets = new DatasetStore(tempDrive(), [wineventDataset]);
  await assert.rejects(() => datasets.importBytes("winevent", new TextEncoder().encode("Event ID,Category\n4624,x"), "t"), /xlsx/i);
  await assert.rejects(
    () => datasets.importBytes("winevent", xlsx({ "Security Audit Events": EVENTS }), "t"),
    /Complete Event Messages/,
  );
  await assert.rejects(
    () => datasets.importBytes("winevent", workbook([["Category", "Event ID"], ["System", 4608]]), "t"),
    /missing column\(s\): subcategory, message summary/i,
  );
  await assert.rejects(() => datasets.importBytes("winevent", workbook(EVENTS.slice(0, 1), MESSAGES.slice(0, 1)), "t"), /No usable/);
  assert.equal(datasets.current("winevent"), undefined);
});

test("headers and sheet names match regardless of case and spacing", async () => {
  const datasets = new DatasetStore(tempDrive(), [wineventDataset]);
  const ev = [["  CATEGORY", "subcategory", "event  id", "Message Summary ", "minimum operating system requirement"], ...EVENTS.slice(1)];
  const row = await datasets.importBytes("winevent", xlsx({ "security audit events": ev, "COMPLETE EVENT MESSAGES": MESSAGES }), "t");
  assert.equal(row.rows, 6);
});

// ---------- lookup ----------

test("lookup returns category, summary, min OS, every version and a citation", async () => {
  const { win } = await imported();
  const out = win.lookup([4624]);
  assert.equal(out.dataset, "winevent");
  assert.match(out.note, /2016/);
  const [r] = out.results;
  assert.equal(r.result, "match");
  assert.equal(r.category, "Logon/Logoff");
  assert.equal(r.subcategory, "Logon");
  assert.equal(r.summary, "An account was successfully logged on.");
  assert.equal(r.min_os, "Windows Vista, Windows Server 2008");
  assert.equal(r.citation, "cyberdrive:winevent@v1#4624");
  assert.deepEqual(
    r.versions?.map((v) => [v.version, v.min_os]),
    [
      [0, "Windows Vista, Windows Server 2008"],
      [1, "Windows 8, Windows Server 2012"],
      [2, "Windows 10"],
    ],
  );
  assert.equal(r.versions?.[1].message, "An account was successfully logged on.\n\nSubject:\n\tSecurity ID:\t\t%1\nRestricted Admin Mode:\t%22");
});

test("batch lookup: strings, several subcategories, message-only, summary-only, No match, invalid", async () => {
  const { win } = await imported();
  const [a, b, c, d, e, f, g] = win.lookup(["4625", "EventID 4663", 8191, 5000, 1102, "abc", 70000]).results;
  assert.equal(a.event_id, 4625);
  assert.equal(a.result, "match");
  assert.equal(b.subcategory, "SAM");
  assert.deepEqual(b.also_listed_under, [{ category: "Object Access", subcategory: "Kernel" }]);
  assert.equal(c.result, "match");
  assert.equal(c.category, null);
  assert.equal(c.summary, "Highest System-Defined Audit Message Value.");
  assert.match(c.note ?? "", /only in the detailed messages/);
  assert.equal(d.result, "match");
  assert.deepEqual(d.versions, []);
  assert.match(d.note ?? "", /no detailed message/i);
  assert.equal(e.result, "No match");
  assert.match(e.note ?? "", /Sysmon/);
  assert.equal(e.citation, undefined);
  assert.equal(f.result, "invalid");
  assert.equal(g.result, "invalid");
  assert.throws(() => win.lookup(Array(51).fill(4624)), /50/);
  assert.throws(() => win.lookup([]), /at least one/i);
  const created = win.lookup([4720]).results[0].versions?.[0].message;
  assert.equal(created, "A user account was created.\n\nNew Account:\n    Kerberos stuff:\t%5", "common indent removed");
});

test("lookups before import explain how to import", () => {
  const win = new WinEventLookup(new DatasetStore(tempDrive(), [wineventDataset]));
  assert.throws(() => win.lookup([4624]), /has not been imported yet/);
});

// ---------- search ----------

test("search matches summary, subcategory, message text and IDs, with category filter and limit", async () => {
  const { win } = await imported();
  const logon = win.search("log on");
  assert.ok(logon.results.some((r) => r.event_id === 4625));
  assert.equal(win.search("kerberos").results[0]?.event_id, 4720, "detailed message text");
  assert.equal(win.search("user account management").results[0]?.event_id, 4720, "subcategory");
  assert.equal(win.search("4663").results[0]?.event_id, 4663);
  const inCat = win.search("account", { category: "logon/logoff" });
  assert.deepEqual(
    inCat.results.map((r) => r.event_id),
    [4624, 4625],
  );
  assert.equal(inCat.results[0].citation, "cyberdrive:winevent@v1#4624");
  const all = win.search(undefined, { category: "Object Access" });
  assert.deepEqual(
    all.results.map((r) => r.event_id),
    [4663],
  );
  const limited = win.search("an", { limit: 2 });
  assert.equal(limited.results.length, 2);
  assert.ok(limited.total > 2);
  assert.throws(() => win.search("xy", { category: "Nope" }), /Unknown category "Nope". Categories: .*Logon\/Logoff/);
  assert.deepEqual(win.categories(), ["Account Management", "Logon/Logoff", "Object Access", "System"]);
});

// ---------- access ----------

test("DatasetReader scopes winevent to granted keys and logs each call", async () => {
  const { drive, datasets } = await imported();
  const oui = new DatasetReader(datasets, ["oui"], "key:oui");
  assert.throws(() => oui.lookupWindowsEvent([4624]), /Not found/i);
  const reader = new DatasetReader(datasets, ["winevent"], "key:win");
  reader.lookupWindowsEvent([4624, 9999]);
  reader.searchWindowsEvents("logon", "Logon/Logoff");
  const log = drive.recentActivity(5);
  const lookup = log.find((a) => a.action === "lookup_windows_event");
  assert.equal(lookup?.actor, "key:win");
  assert.equal(lookup?.path, "cyberdrive:winevent");
  assert.match(lookup?.detail ?? "", /4624=Logon/);
  assert.match(lookup?.detail ?? "", /9999=No match/);
  const search = log.find((a) => a.action === "search_windows_events");
  assert.match(search?.detail ?? "", /"logon" in Logon\/Logoff/);
});

test("MCP: Windows event tools are listed only for keys granted winevent", async () => {
  const drive = tempDrive();
  const keys = keysFor(drive);
  const { app, datasets, close } = createApp({ drive, keys, config: testConfig(drive) });
  after(() => close());
  await datasets.importBytes("winevent", workbook(), "test");
  const ouiKey = keys.create("oui", [], ["oui"]).key;
  const winKey = keys.create("win", [], ["winevent"]).key;
  const { serve } = await import("@hono/node-server");
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  after(() => new Promise((r) => server.close(r)));
  const port = (server.address() as { port: number }).port;
  const connect = async (key: string) => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    after(() => client.close());
    return client;
  };
  const o = await connect(ouiKey);
  const ouiTools = (await o.listTools()).tools.map((t) => t.name);
  assert.ok(ouiTools.includes("lookup_mac"));
  assert.ok(!ouiTools.includes("lookup_windows_event"));
  const w = await connect(winKey);
  const tools = (await w.listTools()).tools;
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("lookup_windows_event") && names.includes("search_windows_events"));
  assert.ok(!names.includes("lookup_mac"));
  assert.equal(tools.find((t) => t.name === "lookup_windows_event")?.annotations?.readOnlyHint, true);
  const text = (res: unknown) => JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
  const res = text(await w.callTool({ name: "lookup_windows_event", arguments: { ids: [4624, "9999"] } }));
  assert.equal(res.results[0].subcategory, "Logon");
  assert.equal(res.results[0].versions.length, 3);
  assert.equal(res.results[1].result, "No match");
  const found = text(await w.callTool({ name: "search_windows_events", arguments: { query: "account", category: "Logon/Logoff", limit: 1 } }));
  assert.equal(found.results.length, 1);
  assert.equal(found.total, 2);
  const tooMany = await w.callTool({ name: "lookup_windows_event", arguments: { ids: Array(51).fill(4624) } });
  assert.equal(tooMany.isError, true);
});

// ---------- the real workbook (optional) ----------

const REAL = process.env.WINEVENT_XLSX;
test("real Microsoft catalog: 4624 is Logon/Logoff > Logon", { skip: !REAL || !existsSync(REAL) ? "set WINEVENT_XLSX" : false }, async () => {
  const datasets = new DatasetStore(tempDrive(), [wineventDataset]);
  const row = await datasets.importBytes("winevent", new Uint8Array(readFileSync(REAL as string)), "real");
  assert.ok(row.rows > 400);
  const [r] = new WinEventLookup(datasets).lookup([4624]).results;
  assert.equal(r.summary, "An account was successfully logged on.");
  assert.equal(r.category, "Logon/Logoff");
  assert.equal(r.subcategory, "Logon");
  assert.equal(r.versions?.length, 3);
});
