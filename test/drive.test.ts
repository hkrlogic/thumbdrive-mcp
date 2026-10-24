import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DriveError, NotFoundError } from "../src/storage/drive.ts";
import { InvalidPathError } from "../src/storage/paths.ts";
import { tempDrive, text } from "./helpers.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

test("current files are plain files on disk and checksums match SHA-256", () => {
  const drive = tempDrive();
  const body = text("hello, drive\n");
  const row = drive.putFile("/notes/hello.txt", body);
  assert.equal(row.sha256, sha(body));
  assert.equal(row.size, body.length);
  const onDisk = readFileSync(path.join(drive.filesDir, "notes", "hello.txt"));
  assert.deepEqual(onDisk, body);
  assert.equal(drive.currentSha256("/notes/hello.txt"), sha(body));
  const listed = drive.list("/notes")[0];
  assert.equal(listed.sha256, sha(body));
  // The version blob is stored by its checksum.
  assert.deepEqual(readFileSync(path.join(drive.versionsDir, String(row.sha256).slice(0, 2), String(row.sha256))), body);
});

test("checksum cache notices files changed outside the drive", () => {
  const drive = tempDrive();
  drive.putFile("/a.txt", text("one"));
  assert.equal(drive.currentSha256("/a.txt"), sha("one"));
  writeFileSync(path.join(drive.filesDir, "a.txt"), "two, longer");
  assert.equal(drive.currentSha256("/a.txt"), sha("two, longer"));
});

test("every admin edit adds a version; old versions stay readable", () => {
  const drive = tempDrive();
  drive.putFile("/doc.md", text("v1"));
  drive.putFile("/doc.md", text("v2"));
  drive.putFile("/doc.md", text("v3"));
  const history = drive.history("/doc.md");
  assert.deepEqual(history.map((v) => v.version), [3, 2, 1]);
  assert.deepEqual(history.map((v) => v.sha256), [sha("v3"), sha("v2"), sha("v1")]);
  assert.equal(drive.readFile("/doc.md").bytes.toString(), "v3");
  assert.equal(drive.readFile("/doc.md").version, 3);
  assert.equal(drive.readFile("/doc.md", 1).bytes.toString(), "v1");
  assert.throws(() => drive.readFile("/doc.md", 9), NotFoundError);
});

test("delete keeps history and restore brings a version back as a new version", () => {
  const drive = tempDrive();
  drive.putFile("/doc.md", text("first"));
  drive.putFile("/doc.md", text("second"));
  const del = drive.deleteFile("/doc.md");
  assert.equal(del.action, "delete");
  assert.equal(drive.kind("/doc.md"), null);
  assert.equal(drive.readFile("/doc.md", 1).bytes.toString(), "first");
  const restored = drive.restoreVersion("/doc.md", 1);
  assert.equal(restored.version, 4);
  assert.equal(drive.readFile("/doc.md").bytes.toString(), "first");
});

test("deleting a hand-copied file records it first so nothing is lost", () => {
  const drive = tempDrive();
  writeFileSync(path.join(drive.filesDir, "dropped.txt"), "copied in by hand");
  assert.equal(drive.readFile("/dropped.txt").version, null);
  drive.deleteFile("/dropped.txt");
  const history = drive.history("/dropped.txt");
  assert.deepEqual(history.map((v) => v.action), ["delete", "put"]);
  assert.equal(drive.readFile("/dropped.txt", 1).bytes.toString(), "copied in by hand");
});

test("a damaged version blob fails its checksum instead of returning bad bytes", () => {
  const drive = tempDrive();
  const row = drive.putFile("/x.txt", text("original"));
  drive.putFile("/x.txt", text("newer"));
  writeFileSync(path.join(drive.versionsDir, String(row.sha256).slice(0, 2), String(row.sha256)), "tampered");
  assert.throws(() => drive.readFile("/x.txt", 1), DriveError);
});

test("size limit and folder/file clashes are enforced", () => {
  const drive = tempDrive({ maxFileBytes: 10 });
  assert.throws(() => drive.putFile("/big.bin", Buffer.alloc(11)), DriveError);
  drive.putFile("/dir/a.txt", text("ok"));
  assert.throws(() => drive.putFile("/dir", text("x")), DriveError);
  assert.throws(() => drive.putFile("/dir/a.txt/b", text("x")), DriveError);
  assert.throws(() => drive.putFile("/", text("x")), DriveError);
});

test("traversal is blocked for reads and writes", () => {
  const drive = tempDrive();
  assert.throws(() => drive.putFile("/../escape.txt", text("x")), InvalidPathError);
  assert.throws(() => drive.readFile("/../thumbdrive.db"), InvalidPathError);
  assert.throws(() => drive.list("/.."), InvalidPathError);
});

test("symlinks are invisible and cannot be written through", () => {
  const drive = tempDrive();
  const outside = path.join(drive.dataDir, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  symlinkSync(outside, path.join(drive.filesDir, "linkdir"));
  symlinkSync(path.join(outside, "secret.txt"), path.join(drive.filesDir, "link.txt"));
  symlinkSync(path.join(drive.dataDir, "thumbdrive.db"), path.join(drive.filesDir, "db"));

  assert.deepEqual(drive.list("/").map((e) => e.name), []);
  assert.throws(() => drive.readFile("/link.txt"), NotFoundError);
  assert.throws(() => drive.readFile("/linkdir/secret.txt"), NotFoundError);
  assert.throws(() => drive.readFile("/db"), NotFoundError);
  assert.throws(() => drive.list("/linkdir"), NotFoundError);
  assert.throws(() => drive.putFile("/linkdir/new.txt", text("x")), DriveError);
  assert.throws(() => drive.putFile("/link.txt", text("x")), DriveError);
  assert.equal(readFileSync(path.join(outside, "secret.txt"), "utf8"), "secret");
});

test("files of a deleted folder stay listed for restore on the parent folder", () => {
  const drive = tempDrive();
  drive.putFile("/team/drafts/a.txt", text("a"));
  drive.putFile("/team/drafts/deep/b.txt", text("b"));
  drive.putFile("/team/keep/c.txt", text("c"));
  drive.putFile("/team/top.txt", text("t"));
  drive.deleteFile("/team/keep/c.txt");
  drive.deleteFile("/team/top.txt");
  drive.deleteFolder("/team/drafts");

  const names = drive.listDeleted("/team").map((d) => d.name).sort();
  // c.txt sits in a folder that still exists, so it is listed there, not here.
  assert.deepEqual(names, ["drafts/a.txt", "drafts/deep/b.txt", "top.txt"]);
  assert.deepEqual(drive.listDeleted("/team/keep").map((d) => d.name), ["c.txt"]);
  assert.deepEqual(drive.listDeleted("/").map((d) => d.name).sort(), []);

  // Restoring one brings its folder back, and it leaves the list.
  const v = drive.history("/team/drafts/deep/b.txt").find((r) => r.action === "put")?.version ?? 0;
  drive.restoreVersion("/team/drafts/deep/b.txt", v);
  assert.equal(drive.readFile("/team/drafts/deep/b.txt").bytes.toString(), "b");
  assert.deepEqual(drive.listDeleted("/team").map((d) => d.name).sort(), ["top.txt"]);
  assert.deepEqual(drive.listDeleted("/team/drafts").map((d) => d.name), ["a.txt"]);

  // Deleting a top-level folder lists its files on the root page.
  drive.deleteFolder("/team");
  assert.ok(drive.listDeleted("/").some((d) => d.name === "team/drafts/deep/b.txt"));
});
