/** Agent table tools: scoping, published-only reads, type-aware lookup, query operators, citations, logging. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatasetReader } from "../src/cyberdrive/agent.ts";
import { NotFoundError } from "../src/storage/drive.ts";
import { parseTableRef, TableReader } from "../src/tables/agent.ts";
import { TableStore } from "../src/tables/store.ts";
import { readerFor, tempDrive } from "./helpers.ts";

const drive = tempDrive();
drive.makeFolder("/inventory");
drive.makeFolder("/network");
drive.makeFolder("/private");
const store = new TableStore(drive);

const servers = store.create({ folder: "/inventory", name: "servers", template: "server-inventory" });
store.edit(servers.id, {
  adds: [
    { values: { c1: "web01.example.com", c2: "10.0.0.10", c3: "production", c6: "ops@example.com", c9: "high" } },
    { values: { c1: "db01.example.com", c2: "10.0.0.20", c3: "staging", c9: "critical" } },
    { values: { c1: "db01.lab.example.com", c2: "10.9.0.20", c3: "test" } },
    { values: { c1: "build", c2: "2001:db8::5", c3: "development", c10: "CI runner" } },
  ],
});
store.publish(servers.id, "first load");
// A draft-only change agents must not see.
store.edit(servers.id, { adds: [{ values: { c1: "draft-only.example.com" } }] });

const plan = store.create({ folder: "/network", name: "vlans", template: "ip-plan" });
store.edit(plan.id, {
  adds: [
    { values: { c1: "10.0.0.0/8", c2: 1, c3: "corp" } },
    { values: { c1: "10.0.0.0/16", c2: 10, c3: "dc" } },
    { values: { c1: "10.0.0.0/24", c2: 100, c3: "servers" } },
    { values: { c1: "2001:db8::/32", c2: 600, c3: "v6" } },
  ],
});
store.publish(plan.id, "plan");

const devices = store.create({ folder: "/network", name: "devices" });
const mac = store.addColumn(devices.id, { name: "MAC", type: "mac" });
const ctl = store.addColumn(devices.id, { name: "Control", type: "control" });
store.setKey(devices.id, mac.id);
store.edit(devices.id, { adds: [{ values: { [mac.id]: "00-00-0c-12-34-56", [ctl.id]: "ac-2" } }] });
store.publish(devices.id, "devices");

const secret = store.create({ folder: "/private", name: "keys" });
store.addColumn(secret.id, { name: "Name", type: "text" });
store.publish(secret.id, "secret");

const unpublished = store.create({ folder: "/inventory", name: "later" });
void unpublished;

const fakeDatasets = {
  enrich(type: "mac" | "control", values: string[]) {
    const m = new Map<string, { dataset: string; label: string; citation: string }>();
    for (const v of values) {
      if (type === "mac" && v.startsWith("00:00:0C")) m.set(v, { dataset: "oui", label: "Cisco Systems, Inc", citation: "cyberdrive:oui@v1#00:00:0C" });
      if (type === "control" && v === "AC-2") m.set(v, { dataset: "nist-800-53", label: "Account Management", citation: "cyberdrive:nist-800-53@v1#AC-2" });
    }
    return m;
  },
} as unknown as DatasetReader;

const reader = (folders: string[], datasets?: DatasetReader) => new TableReader(store, readerFor(drive, folders).scope, "key:test", datasets);

test("table refs and citations", () => {
  assert.equal(parseTableRef("cyberdrive:/inventory/servers@v3#r12"), "/inventory/servers");
  assert.equal(parseTableRef("inventory/servers"), "/inventory/servers");
});

test("list_tables shows only published tables in the key's folders", () => {
  const all = reader(["/inventory", "/network"]).listTables();
  assert.deepEqual(all.tables.map((t) => t.table).sort(), ["/inventory/servers", "/network/devices", "/network/vlans"]);
  const s = all.tables.find((t) => t.table === "/inventory/servers");
  assert.equal(s?.rows, 4);
  assert.equal(s?.citation, "cyberdrive:/inventory/servers@v1");
  assert.equal(s?.key, "Hostname");
  const none = reader(["/private/other"]).listTables();
  assert.equal(none.result, "No match");
  assert.throws(() => reader(["/network"]).describeTable("/private/keys"), NotFoundError);
  assert.throws(() => reader(["/inventory"]).describeTable("/inventory/later"), NotFoundError);
});

test("describe_table gives columns, types, key, version", () => {
  const d = reader(["/"]).describeTable("/network/vlans");
  assert.equal(d.version, 1);
  assert.equal(d.row_count, 4);
  assert.deepEqual(d.columns[0], { name: "CIDR", type: "cidr", key: true });
  assert.ok(d.operators.includes("is_empty"));
});

test("lookup_row normalizes hostnames, IPs and MACs; explicit No match", () => {
  const r = reader(["/"]);
  const out = r.lookupRow("/inventory/servers", ["WEB01.Example.COM.", "web01", "db01", "draft-only.example.com", "nope.example.com"]);
  const [full, short, ambiguous, draft, none] = out.results as Array<Record<string, unknown> & { row?: { row: number; citation: string } }>;
  assert.equal(full.result, "match");
  assert.equal(full.row?.citation, "cyberdrive:/inventory/servers@v1#r1");
  assert.equal(short.matched_by, "short hostname");
  assert.equal(ambiguous.result, "ambiguous");
  assert.equal(draft.result, "No match", "drafts are invisible");
  assert.equal(none.result, "No match");
  const macs = r.lookupRow("/network/devices", ["0000.0c12.3456", "00:00:0c:12:34:56", "001122334455"]).results;
  assert.equal(macs[0].result, "match");
  assert.equal(macs[1].result, "match");
  assert.equal(macs[2].result, "No match");
});

test("lookup_row on a CIDR table returns the longest containing prefix", () => {
  const r = reader(["/network"]);
  const [a, b, c, d, e, f] = r.lookupRow("/network/vlans", ["10.0.0.55", "10.0.9.1", "10.200.0.1", "10.0.0.0/25", "192.168.1.1", "2001:db8::1"]).results as Array<
    Record<string, unknown> & { row?: { values: Record<string, unknown> } }
  >;
  assert.equal(a.row?.values.CIDR, "10.0.0.0/24");
  assert.equal(b.row?.values.CIDR, "10.0.0.0/16");
  assert.equal(c.row?.values.CIDR, "10.0.0.0/8");
  assert.equal(d.row?.values.CIDR, "10.0.0.0/24");
  assert.equal(e.result, "No match");
  assert.equal(f.row?.values.CIDR, "2001:db8::/32");
  assert.equal(r.lookupRow("/network/vlans", ["not-an-ip"]).results[0].result, "invalid");
});

test("lookup_row enriches MAC and control columns from granted datasets", () => {
  const out = reader(["/network"], fakeDatasets).lookupRow("/network/devices", ["00:00:0C:12:34:56"]);
  assert.deepEqual(out.enriched_with?.sort(), ["nist-800-53", "oui"]);
  const ctx = (out.results[0] as { context?: Record<string, { vendor?: string; title?: string }> }).context;
  assert.equal(ctx?.MAC.vendor, "Cisco Systems, Inc");
  assert.equal(ctx?.Control.title, "Account Management");
  assert.equal((reader(["/network"]).lookupRow("/network/devices", ["00:00:0C:12:34:56"]) as { enriched_with?: unknown }).enriched_with, undefined);
});

test("query_table operators, paging and errors", () => {
  const r = reader(["/inventory"]);
  const q = (filters: Array<{ column: string; op: "eq" | "neq" | "contains" | "starts_with" | "gt" | "lt" | "in" | "is_empty"; value?: unknown }>, extra = {}) =>
    r.queryTable("/inventory/servers", { filters, ...extra });
  assert.equal(q([{ column: "environment", op: "eq", value: "PRODUCTION" }]).total, 1);
  assert.equal(q([{ column: "Environment", op: "neq", value: "production" }]).total, 3);
  assert.equal(q([{ column: "Hostname", op: "contains", value: "DB01" }]).total, 2);
  assert.equal(q([{ column: "Hostname", op: "starts_with", value: "web" }]).total, 1);
  assert.equal(q([{ column: "Criticality", op: "in", value: ["high", "critical"] }]).total, 2);
  assert.equal(q([{ column: "Owner email", op: "is_empty" }]).total, 3);
  assert.equal(q([{ column: "Owner email", op: "is_empty", value: false }]).total, 1);
  assert.equal(q([{ column: "IP address", op: "eq", value: "2001:DB8:0::5" }]).total, 1);
  const none = q([{ column: "Hostname", op: "eq", value: "zzz" }]);
  assert.equal(none.result, "No match");
  const page = q([], { limit: 3, sort: { column: "Hostname", direction: "asc" } });
  assert.equal(page.rows.length, 3);
  assert.equal(page.next_offset, 3);
  assert.equal(page.rows[0].values.Hostname, "build");
  assert.equal(q([], { limit: 3, offset: 3 }).next_offset, null);
  // Injection attempts are just values.
  assert.equal(q([{ column: "Hostname", op: "contains", value: "') OR 1=1 --" }]).total, 0);
  assert.throws(() => q([{ column: "Hostname", op: "gt", value: 1 }]), /number and date/);
  assert.throws(() => q([{ column: "Nope", op: "eq", value: 1 }]), /No column Nope/);
  assert.throws(() => q([{ column: "IP address", op: "eq", value: "999.1.1.1" }]), /IP/);
  const nums = reader(["/network"]).queryTable("/network/vlans", { filters: [{ column: "VLAN ID", op: "gt", value: 50 }] });
  assert.equal(nums.total, 2);
});

test("after rollback agents see the rolled-back rows as a new version; every call is logged", () => {
  const t = store.create({ folder: "/inventory", name: "roll" });
  const c = store.addColumn(t.id, { name: "Host", type: "hostname" });
  store.setKey(t.id, c.id);
  store.edit(t.id, { adds: [{ values: { [c.id]: "a.example.com" } }] });
  store.publish(t.id, "v1");
  const rows = store.draftRows(t.id);
  store.edit(t.id, { updates: [{ row: rows[0].id, values: { [c.id]: "b.example.com" } }] });
  store.publish(t.id, "v2");
  const r = reader(["/inventory"]);
  assert.equal(r.lookupRow("/inventory/roll", ["a.example.com"]).results[0].result, "No match");
  store.rollback(t.id, 1);
  const after = r.lookupRow("/inventory/roll", ["a.example.com"]);
  assert.equal(after.version, 3);
  assert.equal((after.results[0] as { row?: { citation: string } }).row?.citation, `cyberdrive:/inventory/roll@v3#r${rows[0].id}`);
  const log = drive.queryActivity({ actor: "key:test", limit: 1000 });
  const actions = new Set(log.map((l) => l.action));
  for (const a of ["list_tables", "describe_table", "lookup_row", "query_table"]) assert.ok(actions.has(a), a);
  assert.ok(log.some((l) => l.action === "lookup_row" && l.path === "cyberdrive:/inventory/roll@v3"));
  assert.ok(log.some((l) => /failed/.test(l.detail ?? "")), "failures are logged too");
});
