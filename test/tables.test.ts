import assert from "node:assert/strict";
import { test } from "node:test";
import { TableError, TableStore } from "../src/tables/store.ts";
import { checkValue, parseCidr, parseIp } from "../src/tables/types.ts";
import { tempDrive } from "./helpers.ts";

const drive = tempDrive();
drive.makeFolder("/inventory");
const store = new TableStore(drive);

test("cell validation by type", () => {
  const ok = (type: Parameters<typeof checkValue>[0]["type"], raw: unknown, options?: string[]) => {
    const r = checkValue({ type, options }, raw);
    assert.ok(r.ok, `${type} ${String(raw)}: ${r.ok ? "" : r.error}`);
    return r.value;
  };
  const bad = (type: Parameters<typeof checkValue>[0]["type"], raw: unknown) => assert.equal(checkValue({ type }, raw).ok, false, `${type} ${raw}`);
  assert.equal(ok("ip", "10.0.0.1"), "10.0.0.1");
  assert.equal(ok("ip", "2001:DB8:0:0::1"), "2001:db8::1");
  bad("ip", "10.0.0.256");
  bad("ip", "010.0.0.1");
  assert.equal(ok("cidr", "10.1.0.0/16"), "10.1.0.0/16");
  bad("cidr", "10.1.2.3/16");
  assert.match((checkValue({ type: "cidr" }, "10.1.2.3/16") as { error: string }).error, /10\.1\.0\.0\/16/);
  assert.equal(ok("mac", "00-1a-2B-3c-4d-5e"), "00:1A:2B:3C:4D:5E");
  bad("mac", "00:1a:2b");
  assert.equal(ok("cve", "cve-2024-3094"), "CVE-2024-3094");
  bad("cve", "CVE-24-1");
  assert.equal(ok("control", "ac-2(1)"), "AC-2(1)");
  assert.equal(ok("email", "Bob@Example.COM"), "Bob@example.com");
  bad("email", "bob@");
  assert.equal(ok("hostname", "Web01.Example.com."), "web01.example.com");
  bad("hostname", "bad_host!");
  assert.equal(ok("number", "1,234.5"), 1234.5);
  assert.equal(ok("checkbox", "yes"), true);
  assert.equal(ok("date", "2026-02-28"), "2026-02-28");
  bad("date", "2026-02-30");
  assert.equal(ok("select", "PRODUCTION", ["production", "staging"]), "production");
  assert.equal(checkValue({ type: "select", options: ["a"] }, "b").ok, false);
  bad("url", "javascript:alert(1)");
  assert.equal(parseIp("::ffff:10.0.0.1")?.version, 6);
  assert.ok(!("error" in parseCidr("2001:db8::/32")));
});

test("create from template, edit, validate, publish, rollback", () => {
  const t = store.create({ folder: "/inventory", name: "servers", template: "server-inventory" });
  assert.equal(t.path, "/inventory/servers");
  assert.equal(t.columns[0].name, "Hostname");
  assert.equal(t.keyColumn, "c1");
  assert.throws(() => store.create({ folder: "/inventory", name: "servers" }), TableError);
  assert.throws(() => store.create({ folder: "/nope", name: "x" }), /Not found/);
  assert.throws(() => store.create({ folder: "/inventory", name: "Bad Name" }), TableError);

  const r = store.edit(t.id, {
    adds: [
      { values: { c1: "WEB01", c2: "10.0.0.10", c3: "production", c6: "ops@example.com" } },
      { values: { c1: "db01", c2: "10.0.0.999" } },
    ],
  });
  assert.deepEqual(r.added, [1, 2]);
  assert.equal(r.rows[0].data.c1, "web01");
  assert.ok(r.rows[1].errors.c2, "invalid IP flagged");
  assert.equal(r.rows[1].data.c2, "10.0.0.999", "invalid input kept for fixing");
  assert.throws(() => store.publish(t.id, "first"), /Fix 1 problem/);
  store.edit(t.id, { updates: [{ row: 2, values: { c2: "10.0.0.20" } }] });
  assert.throws(() => store.publish(t.id, "  "), /note/);
  const v1 = store.publish(t.id, "initial import");
  assert.equal(v1.version, 1);
  assert.equal(v1.added, 2);
  assert.throws(() => store.publish(t.id, "again"), /Nothing to publish/);

  // Duplicate key blocks publish (case-insensitive hostnames).
  store.edit(t.id, { adds: [{ values: { c1: "Web01" } }] });
  assert.match(store.issues(t.id)[0].message, /duplicate key/);
  store.edit(t.id, { deletes: [3], updates: [{ row: 1, values: { c4: "Ubuntu 24.04" } }], adds: [{ values: { c1: "app01" } }] });
  const d = store.diff(t.id);
  assert.deepEqual(
    d.changed.map((c) => [c.key, c.columns]),
    [["web01", ["OS"]]],
  );
  assert.deepEqual(
    d.added.map((a) => a.row),
    [4],
    "row ids are never reused (3 was deleted)",
  );
  store.edit(t.id, { deletes: [2] });
  const v2 = store.publish(t.id, "add app01, drop db01");
  assert.deepEqual([v2.added, v2.changed, v2.removed, v2.rowCount], [1, 1, 1, 2]);
  assert.deepEqual(
    store.published(t.id).rows.map((x) => x.id),
    [1, 4],
  );
  assert.deepEqual(
    store.published(t.id, 1).rows.map((x) => x.id),
    [1, 2],
  );

  // Draft edits are invisible to published reads.
  store.edit(t.id, { updates: [{ row: 1, values: { c4: "Debian" } }] });
  assert.equal(store.published(t.id).rows[0].data.c4, "Ubuntu 24.04");
  store.discard(t.id);
  assert.equal(store.draftRows(t.id)[0].data.c4, "Ubuntu 24.04");
  assert.equal(store.get(t.id).dirty, false);

  const v3 = store.rollback(t.id, 1);
  assert.equal(v3.version, 3);
  assert.equal(v3.rollbackOf, 1);
  assert.deepEqual(
    store.published(t.id).rows.map((x) => x.id),
    [1, 2],
  );
  assert.equal(store.published(t.id).rows[0].data.c4, undefined);
  assert.deepEqual(
    store.draftRows(t.id).map((x) => x.id),
    [1, 2],
  );
  const next = store.edit(t.id, { adds: [{ values: { c1: "new01" } }] });
  assert.deepEqual(next.added, [5], "rollback does not rewind the row counter");

  const h = store.rowHistory(t.id, 1);
  assert.deepEqual(
    h.records.map((x) => [x.from, x.to]),
    [
      [1, 2],
      [2, 3],
      [3, null],
    ],
  );
});

test("column changes are versioned and described", () => {
  const t = store.create({ folder: "/inventory", name: "nets", template: "ip-plan" });
  store.edit(t.id, { adds: [{ values: { c1: "10.0.0.0/24", c2: "10" } }] });
  store.publish(t.id, "v1");
  store.updateColumn(t.id, "c3", { name: "Label" });
  const site = store.addColumn(t.id, { name: "Notes", type: "longtext" });
  assert.equal(site.id, "c7");
  store.deleteColumn(t.id, "c6");
  assert.throws(() => store.addColumn(t.id, { name: "label", type: "text" }), /already a column/);
  assert.throws(() => store.setKey(t.id, "c7"), /cannot be the key/);
  const d = store.diff(t.id);
  assert.deepEqual(d.columnChanges, ["renamed column Name to Label", "added column Notes (Long text)", "removed column Owner"]);
  const v2 = store.publish(t.id, "columns");
  assert.equal(v2.columns.length, 6);
  assert.equal(store.published(t.id, 1).version.columns[2].name, "Name");
  // Retyping re-checks cells.
  store.edit(t.id, { updates: [{ row: 1, values: { c4: "10.0.0.5" } }] });
  store.updateColumn(t.id, "c4", { type: "ip" });
  assert.deepEqual(store.issues(t.id), []);
  store.updateColumn(t.id, "c4", { type: "mac" });
  assert.equal(store.issues(t.id).length, 1);
});

test("upsert by key and folder moves", () => {
  const t = store.create({ folder: "/inventory", name: "hosts", template: "server-inventory" });
  store.upsert(t.id, [{ c1: "a.example.com", c4: "Linux" }, { c1: "b.example.com" }]);
  const res = store.upsert(t.id, [{ c1: "A.example.com", c7: "red" }, { c1: "c.example.com", c2: "bad-ip" }]);
  assert.deepEqual([res.added, res.updated, res.invalidRows], [1, 1, [3]]);
  const a = store.draftRows(t.id)[0];
  assert.deepEqual([a.data.c4, a.data.c7], ["Linux", "red"]);
  store.retargetFolder("/inventory", "/assets/inventory");
  assert.equal(store.get(t.id).path, "/assets/inventory/hosts");
  store.retargetFolder("/assets/inventory", "/inventory");
  assert.equal(store.find("/inventory/hosts")?.id, t.id);
  store.remove(t.id);
  assert.equal(store.find("/inventory/hosts"), undefined);
});
