/**
 * CyberDrive: dataset import/versioning, the OUI lookup (normalization,
 * longest prefix, local/multicast flags), key scoping and the admin page.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DatasetReader } from "../src/cyberdrive/agent.ts";
import { DatasetError, DatasetStore } from "../src/cyberdrive/datasets.ts";
import { normalizeMac, OuiLookup, ouiDataset } from "../src/cyberdrive/oui.ts";
import { createApp } from "../src/http/app.ts";
import { keysFor, tempDrive, testConfig } from "./helpers.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "cyberdrive-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

type Row = [oui: string, manufacturer: string, registry: string, status?: string];
const COLUMNS = "oui, manufacturer, registry, short_name, device_type, registered_date, address, sources, status, deregistered_date";

/** A tiny master_oui.db look-alike. */
function fixtureDb(rows: Row[], opts: { table?: string; columns?: string } = {}): Uint8Array {
  const file = path.join(scratch, `fx-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE ${opts.table ?? "oui_registry"} (${(opts.columns ?? COLUMNS).split(", ").map((c) => `${c} TEXT`).join(", ")})`);
  if (!opts.columns) {
    const insert = db.prepare(`INSERT INTO oui_registry (${COLUMNS}) VALUES (?, ?, ?, ?, NULL, '2000-01-01', 'Somewhere', 'IEEE', ?, NULL)`);
    for (const [oui, m, reg, status] of rows) insert.run(oui, m, reg, m.split(" ")[0], status ?? "current");
  }
  db.close();
  return new Uint8Array(readFileSync(file));
}

const ROWS: Row[] = [
  ["00:00:0C", "Cisco", "MA-L"],
  ["8C:1F:64", "IEEE Registration Authority", "MA-L"],
  ["8C:1F:64:AF:A", "DATA ELECTRONIC DEVICES, INC", "MA-S"],
  ["8C:1F:64:A", "Mid Block Co", "MA-M"],
  ["00:00:5E", "ICANN, IANA Department", "MA-L"],
  ["52:54:00", "QEMU virtual NIC", "MA-L", "legacy"],
  ["00:11:22", "Gone Ltd", "MA-L", "deregistered"],
  ["bad", "Skipped Inc", "MA-L"],
];

function store() {
  const drive = tempDrive();
  return { drive, datasets: new DatasetStore(drive, [ouiDataset]) };
}

async function imported() {
  const s = store();
  await s.datasets.importBytes("oui", fixtureDb(ROWS), "test", "admin");
  return { ...s, oui: new OuiLookup(s.datasets) };
}

// ---------- normalization ----------

test("normalizeMac accepts the common MAC formats", () => {
  const full = "001A2B3C4D5E";
  for (const input of [
    "00:1A:2B:3C:4D:5E",
    "00-1a-2b-3c-4d-5e",
    "001a.2b3c.4d5e",
    "001A2B3C4D5E",
    "001a2b3c4d5e",
    "00 1a 2b 3c 4d 5e",
    "  00:1a:2b:3c:4d:5e  ",
    "0:1a:2b:3c:4d:5e",
  ]) {
    assert.equal(normalizeMac(input)?.hex, full, input);
    assert.equal(normalizeMac(input)?.display, "00:1A:2B:3C:4D:5E", input);
  }
  assert.deepEqual(normalizeMac("001A2B"), { hex: "001A2B", display: "00:1A:2B" });
  assert.deepEqual(normalizeMac("00:1a:2b"), { hex: "001A2B", display: "00:1A:2B" });
  assert.equal(normalizeMac("8C:1F:64:A")?.hex, "8C1F64A");
  assert.equal(normalizeMac("8c-1f-64-af-a")?.hex, "8C1F64AFA");
});

test("normalizeMac rejects invalid input", () => {
  for (const input of [
    "",
    "nonsense",
    "00:1A",
    "001A2",
    "00:1A:2B:3C:4D:5E:6F",
    "001A2B3C4D5E6F",
    "00:1A-2B:3C:4D:5E",
    "00:1G:2B:3C:4D:5E",
    "001:A2B:3C4",
    "0x001A2B",
  ]) {
    assert.equal(normalizeMac(input), undefined, input);
  }
});

// ---------- lookups ----------

test("lookup uses the longest prefix: 9, then 7, then 6 nibbles", async () => {
  const { oui } = await imported();
  const [masS, masM, maL, cisco] = oui.lookup(["8C:1F:64:AF:A0:00", "8C:1F:64:A1:00:00", "8C:1F:64:00:00:00", "00:00:0C:12:34:56"])
    .results;
  assert.equal(masS.match?.manufacturer, "DATA ELECTRONIC DEVICES, INC");
  assert.equal(masS.match?.registry, "MA-S");
  assert.equal(masS.match?.matched_prefix, "8C:1F:64:AF:A");
  assert.equal(masS.match?.citation, "cyberdrive:oui@v1#8C:1F:64:AF:A");
  assert.equal(masM.match?.manufacturer, "Mid Block Co");
  assert.equal(maL.match?.manufacturer, "IEEE Registration Authority");
  assert.match(maL.note ?? "", /subdivided|MA-M|MA-S/i);
  assert.equal(cisco.result, "match");
  assert.equal(cisco.match?.manufacturer, "Cisco");
  assert.equal(cisco.match?.citation, "cyberdrive:oui@v1#00:00:0C");
  for (const k of ["registry", "short_name", "device_type", "registered_date", "address", "status", "deregistered_date", "sources"]) {
    assert.ok(k in (cisco.match ?? {}), k);
  }
});

test("lookup says No match explicitly and flags invalid input", async () => {
  const { oui } = await imported();
  const [none, bad] = oui.lookup(["AC:DE:48:00:11:22", "zz"]).results;
  assert.equal(none.result, "No match");
  assert.equal(none.match, null);
  assert.match(none.note ?? "", /No match/);
  assert.equal(bad.result, "invalid");
});

test("locally administered addresses get a note, not a vendor", async () => {
  const { oui } = await imported();
  const [local, qemu] = oui.lookup(["02:00:00:00:00:01", "52:54:00:12:34:56"]).results;
  assert.equal(local.locally_administered, true);
  assert.equal(local.result, "locally administered");
  assert.equal(local.match, null);
  assert.match(local.note ?? "", /Locally administered/);
  assert.equal(qemu.result, "locally administered");
  assert.equal(qemu.match, null);
  assert.equal(qemu.registered_block?.manufacturer, "QEMU virtual NIC");
});

test("multicast and broadcast are flagged", async () => {
  const { oui } = await imported();
  const [mcast, bcast, ipv6] = oui.lookup(["01:00:5E:00:00:FB", "FF:FF:FF:FF:FF:FF", "33:33:00:00:00:01"]).results;
  assert.equal(mcast.multicast, true);
  assert.equal(mcast.locally_administered, false);
  assert.match(mcast.note ?? "", /multicast/i);
  assert.equal(bcast.result, "broadcast");
  assert.equal(ipv6.multicast, true);
  assert.match(ipv6.note ?? "", /IPv6/);
});

test("non-current registry status is called out", async () => {
  const { oui } = await imported();
  const [gone] = oui.lookup(["00:11:22:33:44:55"]).results;
  assert.equal(gone.match?.status, "deregistered");
  assert.match(gone.note ?? "", /deregistered/);
});

test("batches are capped at 50 and vendor search works", async () => {
  const { oui } = await imported();
  assert.throws(() => oui.lookup(Array(51).fill("00:00:0C:00:00:00")), DatasetError);
  assert.equal(oui.lookup(Array(50).fill("00:00:0C:00:00:00")).results.length, 50);
  const found = oui.searchVendor("cisco");
  assert.equal(found.total, 1);
  assert.equal(found.results[0].citation, "cyberdrive:oui@v1#00:00:0C");
  assert.equal(oui.searchVendor("100%_").total, 0, "LIKE wildcards are escaped");
});

test("lookups before any import fail clearly", () => {
  const { datasets } = store();
  assert.throws(() => new OuiLookup(datasets).lookup(["00:00:0C:00:00:00"]), /not been imported yet/);
});

// ---------- import ----------

test("import validates the file", async () => {
  const { datasets } = store();
  await assert.rejects(() => datasets.importBytes("oui", new TextEncoder().encode("hello, not sqlite".repeat(10)), "t"), /Not a SQLite/);
  await assert.rejects(() => datasets.importBytes("oui", new Uint8Array(), "t"), /empty/);
  await assert.rejects(() => datasets.importBytes("oui", fixtureDb([], { table: "other", columns: COLUMNS }), "t"), /no table "oui_registry"/);
  await assert.rejects(
    () => datasets.importBytes("oui", fixtureDb([], { columns: "oui, manufacturer" }), "t"),
    /missing column\(s\): registry/,
  );
  await assert.rejects(() => datasets.importBytes("oui", fixtureDb([["nope", "X", "MA-L"]]), "t"), /No usable rows/);
  await assert.rejects(() => datasets.importBytes("nope", fixtureDb(ROWS), "t"), /Unknown dataset/);
  const small = new DatasetStore(tempDrive(), [ouiDataset], 1000);
  await assert.rejects(() => small.importBytes("oui", fixtureDb(ROWS), "t"), /DATASET_MAX_MB/);
  assert.equal(datasets.current("oui"), undefined, "failed imports leave nothing behind");
});

test("re-import replaces the data, bumps the version and keeps history", async () => {
  const { drive, datasets } = store();
  const v1 = await datasets.importBytes("oui", fixtureDb(ROWS), "first", "admin");
  assert.equal(v1.version, 1);
  assert.equal(v1.rows, 7);
  assert.equal(v1.skipped, 1);
  assert.match(v1.sha256, /^[0-9a-f]{64}$/);
  const file = path.join(scratch, "v2.db");
  writeFileSync(file, fixtureDb([["00:AB:CD", "Only Vendor", "MA-L"]]));
  const v2 = await datasets.importFrom("oui", file, "cli");
  assert.equal(v2.version, 2);
  assert.equal(v2.source, "file:v2.db");
  assert.deepEqual(
    datasets.history("oui").map((h) => h.version),
    [2, 1],
  );
  assert.equal(datasets.current("oui")?.version, 2);
  const oui = new OuiLookup(datasets);
  const [cisco, only] = oui.lookup(["00:00:0C:00:00:01", "00:AB:CD:00:00:01"]).results;
  assert.equal(cisco.result, "No match", "old rows are gone");
  assert.equal(only.match?.citation, "cyberdrive:oui@v2#00:AB:CD");
  // A bad file does not touch the current version.
  await assert.rejects(() => datasets.importBytes("oui", new Uint8Array(200), "bad"));
  assert.equal(datasets.current("oui")?.version, 2);
  assert.equal(oui.lookup(["00:AB:CD:00:00:01"]).results[0].result, "match");
  assert.ok(drive.recentActivity(10).some((a) => a.action === "dataset.import" && /oui v2/.test(a.detail ?? "")));
});

// ---------- access ----------

test("keys get datasets only when granted; whole-drive keys do not", () => {
  const drive = tempDrive();
  const keys = keysFor(drive);
  const root = keys.create("root", ["/"]).record;
  assert.deepEqual(root.datasets, []);
  const cyber = keys.create("cyber", [], ["oui"]).record;
  assert.deepEqual(cyber.folders, []);
  assert.deepEqual(cyber.datasets, ["oui"]);
  assert.throws(() => keys.create("none", []), /at least one folder/);
  assert.throws(() => keys.create("typo", ["/"], ["ouii"]), /Unknown dataset/);
  assert.deepEqual(keys.setDatasets(root.id, ["oui"]).datasets, ["oui"]);
  assert.deepEqual(keys.setFolders(root.id, ["/"]).datasets, ["oui"], "folders-only edit keeps datasets");
  assert.deepEqual(keys.setFolders(root.id, ["/"], []).datasets, []);
  assert.throws(() => keys.setFolders(cyber.id, [], []), /at least one folder/);
});

test("DatasetReader hides ungranted datasets and logs every lookup", async () => {
  const { drive, datasets } = await imported();
  const denied = new DatasetReader(datasets, [], "key:root");
  assert.equal(denied.has("oui"), false);
  assert.throws(() => denied.lookupMac(["00:00:0C:00:00:00"]), /Not found/i);
  const reader = new DatasetReader(datasets, ["oui"], "key:cyber");
  reader.lookupMac(["00:00:0C:12:34:56", "02:00:00:00:00:01"]);
  reader.searchOuiVendor("cisco");
  const log = drive.recentActivity(5);
  const lookup = log.find((a) => a.action === "lookup_mac");
  assert.equal(lookup?.actor, "key:cyber");
  assert.equal(lookup?.path, "cyberdrive:oui");
  assert.match(lookup?.detail ?? "", /00:00:0C:12:34:56=00:00:0C/);
  assert.match(lookup?.detail ?? "", /locally administered/);
  assert.ok(log.some((a) => a.action === "search_oui_vendor" && a.actor === "key:cyber"));
});

test("MCP: lookup_mac is listed only for keys granted oui", async () => {
  const drive = tempDrive();
  const keys = keysFor(drive);
  const config = testConfig(drive);
  const { app, datasets, close } = createApp({ drive, keys, config });
  after(() => close());
  await datasets.importBytes("oui", fixtureDb(ROWS), "test");
  const plain = keys.create("plain", ["/"]).key;
  const cyber = keys.create("cyber", [], ["oui"]).key;
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
  const p = await connect(plain);
  const plainTools = (await p.listTools()).tools.map((t) => t.name);
  assert.ok(!plainTools.includes("lookup_mac"));
  const c = await connect(cyber);
  const tools = (await c.listTools()).tools;
  const lookup = tools.find((t) => t.name === "lookup_mac");
  assert.ok(lookup);
  assert.equal(lookup.annotations?.readOnlyHint, true);
  assert.ok(tools.some((t) => t.name === "search_oui_vendor"));
  const res = await c.callTool({ name: "lookup_mac", arguments: { macs: ["00:00:0c:12:34:56"] } });
  const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
  assert.equal(body.results[0].match.manufacturer, "Cisco");
  assert.equal(body.results[0].match.citation, "cyberdrive:oui@v1#00:00:0C");
  const tooMany = await c.callTool({ name: "lookup_mac", arguments: { macs: Array(51).fill("00:00:0C") } });
  assert.equal(tooMany.isError, true);
  // A dataset-only key sees no files.
  const files = await c.callTool({ name: "list", arguments: { path: "/" } });
  assert.equal(files.isError, true);
});
