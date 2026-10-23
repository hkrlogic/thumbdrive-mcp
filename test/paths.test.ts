import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidPathError, isWithin, normalizeDrivePath } from "../src/storage/paths.ts";

test("paths normalize to /a/b form", () => {
  assert.equal(normalizeDrivePath(""), "/");
  assert.equal(normalizeDrivePath("/"), "/");
  assert.equal(normalizeDrivePath("a/b"), "/a/b");
  assert.equal(normalizeDrivePath("//a/./b/"), "/a/b");
  assert.equal(normalizeDrivePath("/Reports 2026/q3.csv"), "/Reports 2026/q3.csv");
});

test("traversal and odd characters are rejected", () => {
  for (const bad of ["..", "/../etc/passwd", "/a/../../b", "a/..", "/a\\..\\b", "/a\u0000b", "/a\nb", "x".repeat(2000)]) {
    assert.throws(() => normalizeDrivePath(bad), InvalidPathError, JSON.stringify(bad.slice(0, 20)));
  }
});

test("isWithin respects segment boundaries", () => {
  assert.equal(isWithin("/team/docs/a.txt", "/team/docs"), true);
  assert.equal(isWithin("/team/docs", "/team/docs"), true);
  assert.equal(isWithin("/team/docs-secret/a.txt", "/team/docs"), false);
  assert.equal(isWithin("/anything", "/"), true);
});
