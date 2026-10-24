import assert from "node:assert/strict";
import { test } from "node:test";
import { hashKey } from "../src/auth/keys.ts";
import { keysFor, tempDrive } from "./helpers.ts";

test("keys are shown once and stored only as a hash", () => {
  const drive = tempDrive();
  const keys = keysFor(drive);
  const { key, record } = keys.create("laptop-agent", ["/team/docs", "team/docs/", "/finance"]);
  assert.match(key, /^td_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(record.folders, ["/finance", "/team/docs"]);
  const row = drive.db.prepare("SELECT * FROM keys").get() as Record<string, unknown>;
  assert.equal(row.hash, hashKey(key));
  assert.ok(!JSON.stringify(row).includes(key.slice(10)), "plain key must not be stored");
  assert.equal(keys.verify(key)?.name, "laptop-agent");
  assert.ok(keys.verify(key)?.last_used_at);
});

test("unknown, malformed and revoked keys are refused", () => {
  const drive = tempDrive();
  const keys = keysFor(drive);
  const { key } = keys.create("k1", ["/"]);
  assert.equal(keys.verify(undefined), undefined);
  assert.equal(keys.verify(""), undefined);
  assert.equal(keys.verify("td_nope"), undefined);
  assert.equal(keys.verify(key.toUpperCase()), undefined);
  assert.equal(keys.revoke("k1"), true);
  assert.equal(keys.verify(key), undefined);
  assert.equal(keys.revoke("k1"), false);
});

test("key folders are validated", () => {
  const keys = keysFor(tempDrive());
  assert.throws(() => keys.create("bad", []), /at least one folder/);
  assert.throws(() => keys.create("bad", ["/../x"]), /'\.\.' is not allowed/);
  assert.throws(() => keys.create("", ["/"]), /Key name/);
});
