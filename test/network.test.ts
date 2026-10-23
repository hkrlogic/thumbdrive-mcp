import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, hostnameOf, isAllowedHostname, isLocalAddress, plainHttpRejected } from "../src/http/app.ts";
import { keysFor, tempDrive, testConfig } from "./helpers.ts";

test("local and private addresses are recognised", () => {
  for (const a of ["127.0.0.1", "::1", "::ffff:192.168.1.9", "10.0.0.4", "172.17.0.1", "172.31.255.1", "192.168.0.2", "100.100.1.1", "fd12::1", "fe80::1"]) {
    assert.equal(isLocalAddress(a), true, a);
  }
  for (const a of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111", undefined]) {
    assert.equal(isLocalAddress(a), false, String(a));
  }
});

test("Host check accepts localhost, LAN IPs and ALLOWED_HOSTS only", () => {
  assert.equal(hostnameOf("192.168.1.20:8484"), "192.168.1.20");
  assert.equal(hostnameOf("[fd00::1]:8484"), "fd00::1");
  assert.equal(hostnameOf("Localhost"), "localhost");
  const allowed = ["nas.local"];
  for (const h of ["localhost", "127.0.0.1", "::1", "192.168.1.20", "10.1.2.3", "fd00::1", "nas.local"]) {
    assert.equal(isAllowedHostname(h, allowed), true, h);
  }
  for (const h of ["evil.example", "8.8.8.8", "192.168.1.20.evil.example", "nas.local.evil", "0.0.0.0", ""]) {
    assert.equal(isAllowedHostname(h, allowed), false, h);
  }
});

test("plain HTTP is allowed on LAN, refused from public peers even with a forged header", () => {
  assert.equal(plainHttpRejected("127.0.0.1", undefined), false);
  assert.equal(plainHttpRejected("192.168.1.50", undefined), false);
  assert.equal(plainHttpRejected("172.17.0.1", undefined), false); // Docker bridge
  assert.equal(plainHttpRejected("127.0.0.1", "https"), false); // local HTTPS proxy
  assert.equal(plainHttpRejected("127.0.0.1", "http"), true);
  assert.equal(plainHttpRejected("203.0.113.9", undefined), true);
  assert.equal(plainHttpRejected("203.0.113.9", "https"), true);
});

test("a LAN Host header reaches the key check", async () => {
  const drive = tempDrive();
  const { app, close } = createApp({ drive, keys: keysFor(drive), config: testConfig(drive) });
  const post = (host: string) =>
    app.fetch(new Request("http://x/mcp", { method: "POST", headers: { host, "content-type": "application/json" }, body: "{}" }));
  assert.equal((await post("192.168.1.20:8484")).status, 401);
  assert.equal((await post("evil.example:8484")).status, 403);
  await close();
});
