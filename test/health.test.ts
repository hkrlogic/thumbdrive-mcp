import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/index.ts";

test("health check answers", async () => {
  const res = await createApp().request("/healthz");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});
