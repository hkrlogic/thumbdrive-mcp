import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { UnsupportedFormatError } from "../src/agent/reader.ts";
import { NotFoundError } from "../src/storage/drive.ts";
import { readerFor, tempDrive, text } from "./helpers.ts";

function seeded() {
  const drive = tempDrive();
  drive.putFile("/team/docs/plan.md", text("# Plan\nship the drive\n"));
  drive.putFile("/team/docs/old.md", text("v1 secret-ish"));
  drive.putFile("/team/docs/old.md", text("v2"));
  drive.putFile("/team/docs-private/payroll.csv", text("name,salary\nann,1\n"));
  drive.putFile("/finance/budget.csv", text("item,amount\nrent,100\n"));
  drive.putFile("/readme.txt", text("top level, mentions drive"));
  return drive;
}

test("a scoped key sees only its folder; everything else looks missing", () => {
  const drive = seeded();
  const reader = readerFor(drive, ["/team/docs"]);

  // Root and /team only show the way down to the granted folder.
  assert.deepEqual(reader.list("/").entries.map((e) => e.path), ["/team"]);
  assert.deepEqual(reader.list("/team").entries.map((e) => e.path), ["/team/docs"]);
  assert.deepEqual(reader.list("/team/docs").entries.map((e) => e.name), ["old.md", "plan.md"]);

  // Hidden things give the same error as things that do not exist.
  const missing = (fn: () => unknown, p: string) =>
    assert.throws(fn, (e: unknown) => e instanceof NotFoundError && e.message === `Not found: ${p}`);
  missing(() => reader.list("/finance"), "/finance");
  missing(() => reader.list("/does-not-exist"), "/does-not-exist");
  missing(() => reader.list("/team/docs-private"), "/team/docs-private");
  missing(() => reader.read({ path: "/finance/budget.csv" }), "/finance/budget.csv");
  missing(() => reader.read({ path: "/finance/nope.csv" }), "/finance/nope.csv");
  missing(() => reader.read({ path: "/team/docs-private/payroll.csv" }), "/team/docs-private/payroll.csv");
  missing(() => reader.read({ path: "/readme.txt" }), "/readme.txt");
  missing(() => reader.history("/finance/budget.csv"), "/finance/budget.csv");
  missing(() => reader.search("budget", "/finance"), "/finance");

  // Search from the root only covers granted folders.
  const hits = reader.search("drive", "/").hits.map((h) => h.path);
  assert.deepEqual(hits, ["/team/docs/plan.md"]);
  assert.deepEqual(reader.search("salary").hits, []);
  assert.deepEqual(reader.search("budget").hits, []);
});

test("a key for / sees the whole drive", () => {
  const drive = seeded();
  const reader = readerFor(drive, ["/"]);
  assert.deepEqual(reader.list("/").entries.map((e) => e.name), ["finance", "team", "readme.txt"]);
  assert.equal(reader.search("drive").hits.length, 2);
});

test("reads return metadata with the whole-file checksum", () => {
  const drive = seeded();
  const reader = readerFor(drive, ["/"]);
  const { meta, content } = reader.read({ path: "/team/docs/plan.md" });
  assert.equal(content, "# Plan\nship the drive\n");
  assert.equal(meta.sha256, createHash("sha256").update(content).digest("hex"));
  assert.equal(meta.encoding, "utf-8");
  assert.equal(meta.mime, "text/markdown");
  assert.equal(meta.version, 1);
  assert.equal(meta.has_more, false);
});

test("history and old versions are readable within scope", () => {
  const drive = seeded();
  const reader = readerFor(drive, ["/team/docs"]);
  assert.deepEqual(reader.history("/team/docs/old.md").versions.map((v) => v.version), [2, 1]);
  assert.equal(reader.read({ path: "/team/docs/old.md", version: 1 }).content, "v1 secret-ish");
});

test("raw text pages never split a UTF-8 character and join back to the file", () => {
  const drive = tempDrive();
  const body = "héllo wörld — ünïcode ✓ ".repeat(40);
  drive.putFile("/u.txt", text(body));
  const reader = readerFor(drive, ["/"], { pageBytes: 17 });
  let page = 1;
  let joined = "";
  for (;;) {
    const { meta, content } = reader.read({ path: "/u.txt", page });
    assert.ok(!content.includes("\uFFFD"), `page ${page} has a broken character`);
    joined += content;
    if (!meta.has_more) {
      assert.equal(meta.pages, page);
      break;
    }
    page++;
  }
  assert.equal(joined, body);
  assert.throws(() => reader.read({ path: "/u.txt", page: page + 1 }), /past the end/);
});

test("binary files come back as base64 pages; base64 flag works for text too", () => {
  const drive = tempDrive();
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254, 0, 7]);
  drive.putFile("/img.png", bin);
  const reader = readerFor(drive, ["/"], { pageBytes: 5 });
  const parts: Buffer[] = [];
  for (let page = 1; page <= 3; page++) {
    const { meta, content } = reader.read({ path: "/img.png", page });
    assert.equal(meta.encoding, "base64");
    assert.equal(meta.pages, 3);
    parts.push(Buffer.from(content, "base64"));
  }
  assert.deepEqual(Buffer.concat(parts), bin);

  drive.putFile("/t.txt", text("abc"));
  const forced = reader.read({ path: "/t.txt", base64: true });
  assert.equal(forced.meta.encoding, "base64");
  assert.equal(Buffer.from(forced.content, "base64").toString(), "abc");
});

test("CSV text view parses quoted fields and pages by rows", () => {
  const drive = tempDrive();
  const rows = ['id,name,note', '1,"Smith, Ann","said ""hi"""', '2,Bob,"two\nlines"'];
  for (let i = 3; i <= 7; i++) rows.push(`${i},n${i},x`);
  drive.putFile("/people.csv", text(`${rows.join("\r\n")}\r\n`));
  const reader = readerFor(drive, ["/"], { pageRows: 3 });
  const first = reader.read({ path: "/people.csv", format: "text" });
  assert.equal(first.meta.encoding, "json");
  assert.equal(first.meta.pages, 3);
  assert.deepEqual(first.meta.rows, { first: 1, last: 3, total: 7 });
  const parsed = JSON.parse(first.content);
  assert.deepEqual(parsed.header, ["id", "name", "note"]);
  assert.deepEqual(parsed.rows[0], ["1", "Smith, Ann", 'said "hi"']);
  assert.deepEqual(parsed.rows[1], ["2", "Bob", "two\nlines"]);
  const last = JSON.parse(reader.read({ path: "/people.csv", format: "text", page: 3 }).content);
  assert.deepEqual(last.rows, [["7", "n7", "x"]]);
});

test("Excel and PDF text views are clear stubs; raw still works", () => {
  const drive = tempDrive();
  drive.putFile("/sheet.xlsx", Buffer.from([0x50, 0x4b, 3, 4, 0]));
  const reader = readerFor(drive, ["/"]);
  assert.throws(() => reader.read({ path: "/sheet.xlsx", format: "text" }), UnsupportedFormatError);
  assert.equal(reader.read({ path: "/sheet.xlsx" }).meta.encoding, "base64");
});

test("agent reads are written to the activity log", () => {
  const drive = seeded();
  const reader = readerFor(drive, ["/team/docs"]);
  reader.read({ path: "/team/docs/plan.md" });
  const last = drive.recentActivity(1)[0];
  assert.equal(last.action, "read");
  assert.equal(last.path, "/team/docs/plan.md");
  assert.equal(last.actor, "test");
});
