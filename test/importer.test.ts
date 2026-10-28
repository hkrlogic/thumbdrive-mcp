import assert from "node:assert/strict";
import { test } from "node:test";
import { applyImport, parseUpload, preview, sniffDelimiter, suggestType, toSheet } from "../src/tables/importer.ts";
import { TableError, TableStore } from "../src/tables/store.ts";
import { tempDrive } from "./helpers.ts";
import { xlsx } from "./xlsx.ts";

const enc = (s: string) => new TextEncoder().encode(s);

test("sniffDelimiter picks the consistent separator", () => {
  assert.equal(sniffDelimiter("a,b,c\n1,2,3\n"), ",");
  assert.equal(sniffDelimiter("a;b;c\n1;2,5;3\n"), ";");
  assert.equal(sniffDelimiter("a\tb\n1,2\t3\n"), "\t");
  assert.equal(sniffDelimiter("single\nvalue\n"), ",");
});

test("toSheet drops blank rows, names and de-duplicates headers, enforces limits", () => {
  const s = toSheet("x", [[null, null], ["Name", "name", "_id", ""], ["a", "b"], [null, ""], ["c"]]);
  assert.deepEqual(s.header, ["Name", "name 2", "id", "Column 4"]);
  assert.deepEqual(s.rows, [
    ["a", "b", null, null],
    ["c", null, null, null],
  ]);
  assert.throws(() => toSheet("e", [[null]]), TableError);
  assert.throws(() => toSheet("w", [Array.from({ length: 101 }, (_, i) => `c${i}`)]), /limit is 100/);
});

test("parseUpload reads CSV (BOM, quotes, semicolons) and every non-empty xlsx sheet", async () => {
  const [csv] = await parseUpload("a.csv", enc('\ufeffHost;Note\nweb01;"a; b"\n'));
  assert.deepEqual(csv.header, ["Host", "Note"]);
  assert.deepEqual(csv.rows, [["web01", "a; b"]]);
  const book = await parseUpload("b.xlsx", xlsx({ One: [["A"], [1]], Empty: [], Two: [["B", "C"], ["x", 2]] }));
  assert.deepEqual(
    book.map((s) => [s.name, s.header]),
    [
      ["One", ["A"]],
      ["Two", ["B", "C"]],
    ],
  );
  assert.deepEqual(book[1].rows, [["x", 2]]);
  await assert.rejects(parseUpload("old.xls", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])), /\.xls workbooks are not supported/);
  await assert.rejects(parseUpload("fake.xlsx", enc("hello")), /Not a valid \.xlsx/);
  await assert.rejects(parseUpload("bin.csv", new Uint8Array([1, 0, 2])), /CSV/);
});

test("suggestType uses header hints and values", () => {
  assert.equal(suggestType("Hostname", ["web01", "db01"]).type, "hostname");
  assert.equal(suggestType("IP", ["10.0.0.1", "10.0.0.2", "bad"]).type, "ip", "header hint tolerates a minority of bad values");
  assert.equal(suggestType("IP", ["x", "y", "10.0.0.1"]).type, "text");
  assert.equal(suggestType("Range", ["10.0.0.0/24", "2001:db8::/32"]).type, "cidr");
  assert.equal(suggestType("x", ["10.0.0.0/24"]).type, "cidr");
  assert.equal(suggestType("x", ["CVE-2024-3094", "cve-2021-44228"]).type, "cve");
  assert.equal(suggestType("x", ["00:11:22:33:44:55"]).type, "mac");
  assert.equal(suggestType("x", ["a@example.com"]).type, "email");
  assert.equal(suggestType("x", ["https://example.com"]).type, "url");
  assert.equal(suggestType("x", [new Date("2026-01-02"), "2026-03-04"]).type, "date");
  assert.equal(suggestType("x", [1, "2.5"]).type, "number");
  assert.equal(suggestType("VLAN", [10, 20]).type, "number");
  assert.equal(suggestType("x", [true, "no"]).type, "checkbox");
  assert.equal(suggestType("Control", ["AC-2", "PR.AA-01"]).type, "control");
  assert.deepEqual(suggestType("Env", ["prod", "dev", "prod", "dev"]), { type: "select", options: ["prod", "dev"] });
  assert.equal(suggestType("Notes", ["anything"]).type, "longtext");
  assert.equal(suggestType("x", [null, " "]).type, "text");
});

test("preview matches existing columns by name; applyImport maps, keys, updates and reports problems", () => {
  const drive = tempDrive();
  drive.makeFolder("/inv");
  const store = new TableStore(drive);
  const t = store.create({ folder: "/inv", name: "servers", template: "server-inventory" });
  store.edit(t.id, { adds: [{ values: { c1: "web01", c4: "old" } }] });
  const sheet = toSheet("s", [
    ["hostname", "OS", "Rack", "Junk"],
    ["WEB01", "Debian", "R1", "x"],
    ["web02", "Ubuntu", "R2", "y"],
    ["bad host!", "", "R3", "z"],
  ]);
  const cols = preview(sheet, store.get(t.id));
  assert.equal(cols[0].existing, "c1");
  assert.equal(cols[1].existing, "c4");
  assert.equal(cols[2].existing, undefined);
  const res = applyImport(
    store,
    t.id,
    sheet,
    [
      { action: "existing", column: "c1" },
      { action: "existing", column: "c4" },
      { action: "new", name: "Rack", type: "text" },
      { action: "skip" },
    ],
    undefined,
  );
  assert.equal(res.updated, 1, "WEB01 matches web01 case-insensitively");
  assert.equal(res.added, 2);
  assert.deepEqual(res.newColumns, ["Rack"]);
  assert.equal(res.problems.length, 1);
  assert.equal(res.problems[0].line, 4);
  assert.equal(res.problems[0].column, "Hostname");
  const rows = store.draftRows(t.id);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].data.c4, "Debian");
  assert.ok(!Object.values(rows[0].data).includes("x"), "skipped column not imported");
  // Validation happens before any change.
  const before = store.get(t.id).columns.length;
  assert.throws(
    () =>
      applyImport(
        store,
        t.id,
        sheet,
        [{ action: "new", name: "A", type: "text" }, { action: "existing", column: "c4" }, { action: "existing", column: "c4" }, { action: "skip" }],
        undefined,
      ),
    /same table column/,
  );
  assert.throws(() => applyImport(store, t.id, sheet, [{ action: "skip" }], undefined), /does not match/);
  assert.throws(() => applyImport(store, t.id, sheet, Array(4).fill({ action: "skip" }), undefined), /at least one/);
  assert.equal(store.get(t.id).columns.length, before);
  // A checkbox cannot be the key.
  const t2 = store.create({ folder: "/inv", name: "flags" });
  const s2 = toSheet("f", [["On"], [true]]);
  assert.throws(() => applyImport(store, t2.id, s2, [{ action: "new", name: "On", type: "checkbox" }], 0), /cannot be the key/);
});
