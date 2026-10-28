/**
 * CyberDrive NIST control frameworks: OSCAL parsing (SP 800-53 Rev 5, CSF
 * 2.0), parameter rendering, ID normalization, lookup/search/map, key
 * scoping, logging and MCP. Fixtures are tiny in-test catalogs; set
 * NIST80053_JSON, CSF2_JSON and CSF2MAP_XLSX to NIST's real files to also
 * check them.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { after, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DatasetReader } from "../src/cyberdrive/agent.ts";
import {
  ControlLookup,
  csf2Dataset,
  csf2Id,
  csf2mapDataset,
  nist80053Dataset,
  renderParams,
  sp80053Id,
} from "../src/cyberdrive/controls.ts";
import { DatasetStore } from "../src/cyberdrive/datasets.ts";
import { createApp } from "../src/http/app.ts";
import { csf2Catalog, csf2MapWorkbook, sp80053Catalog } from "./fixtures/controls.ts";
import { keysFor, tempDrive, testConfig } from "./helpers.ts";

const KINDS = [nist80053Dataset, csf2Dataset, csf2mapDataset];

async function imported() {
  const drive = tempDrive();
  const datasets = new DatasetStore(drive, KINDS);
  const rows = {
    nist80053: await datasets.importBytes("nist80053", sp80053Catalog(), "test", "admin"),
    csf2: await datasets.importBytes("csf2", csf2Catalog(), "test", "admin"),
    csf2map: await datasets.importBytes("csf2map", csf2MapWorkbook(), "test", "admin"),
  };
  return { drive, datasets, rows, controls: new ControlLookup(datasets) };
}

// ---------- IDs and parameters ----------

test("SP 800-53 IDs normalize: case, zero padding, dot and spaced enhancements, families", () => {
  for (const [input, want] of [
    ["AC-2", "AC-2"],
    ["ac-2", "AC-2"],
    ["AC-02", "AC-2"],
    ["ac-2(1)", "AC-2(1)"],
    ["AC-2 (1)", "AC-2(1)"],
    ["AC-2.1", "AC-2(1)"],
    ["AC-02(01)", "AC-2(1)"],
    ["SP 800-53 Rev 5.2.0: IA-05(01)", "IA-5(1)"],
    ["ac", "AC"],
  ] as const) {
    assert.equal(sp80053Id(input), want, input);
  }
  for (const bad of ["", "AC-", "XX-2", "AC-2(", "AC2", "PR.AA-01", "AC-2(1)(2)"]) assert.equal(sp80053Id(bad), null, bad);
});

test("CSF 2.0 IDs normalize: functions, categories and padded subcategories", () => {
  assert.equal(csf2Id("PR.AA-01"), "PR.AA-01");
  assert.equal(csf2Id("pr.aa-1"), "PR.AA-01");
  assert.equal(csf2Id("gv.oc"), "GV.OC");
  assert.equal(csf2Id("GV"), "GV");
  assert.equal(csf2Id("CSF 2.0: DE.CM-09"), "DE.CM-09");
  for (const bad of ["AC-2", "XX.AA-01", "PR.A-01", "PR.AA-"]) assert.equal(csf2Id(bad), null, bad);
});

test("parameters render as SP 800-53 prints them", () => {
  const params = new Map([
    ["a", { id: "a", label: "frequency" }],
    ["b", { id: "b", label: "organization-defined personnel or roles" }],
    ["c", { id: "c", select: { "how-many": "one-or-more", choice: ["local", "{{ insert: param, a }}"] } }],
    ["d", { id: "d", select: { choice: ["x", "y"] } }],
  ]);
  assert.equal(
    renderParams("Review {{ insert: param, a }} by {{ insert: param, b }}; {{ insert: param, c }}; {{ insert: param, d }}; {{ insert: param, zz }}", params),
    "Review [Assignment: organization-defined frequency] by [Assignment: organization-defined personnel or roles]; [Selection (one or more): local; [Assignment: organization-defined frequency]]; [Selection: x; y]; [Assignment: zz]",
  );
});

// ---------- import ----------

test("imports count controls, catalog items and mappings, and keep only the newest 800-53 revision", async () => {
  const { rows, datasets } = await imported();
  assert.equal(rows.nist80053.rows, 7, "AC-2 AC-2(1) AC-3 AC-13 IA-2 IA-2(1) AU-6; families are not counted");
  assert.equal(rows.csf2.rows, 10, "3 functions, 3 categories, 4 subcategories");
  assert.equal(rows.csf2map.rows, 7);
  assert.ok(rows.csf2map.skipped >= 1, "the row without a CSF ID");
  assert.equal(datasets.kind("nist80053").unit, "controls");
  assert.equal(datasets.kind("csf2map").unit, "mappings");
  const refs = datasets.db.prepare("SELECT DISTINCT reference FROM control_mappings").all() as Array<{ reference: string }>;
  assert.deepEqual(
    refs.map((r) => r.reference),
    ["SP 800-53 Rev 5.2.0"],
  );
});

test("imports reject files that are not the expected catalog, and keep the old version", async () => {
  const datasets = new DatasetStore(tempDrive(), KINDS);
  await assert.rejects(() => datasets.importBytes("nist80053", new TextEncoder().encode("nope"), "t"), /Not a JSON file/);
  await assert.rejects(() => datasets.importBytes("nist80053", new TextEncoder().encode('{"catalog":{}}'), "t"), /Not an OSCAL catalog/);
  await assert.rejects(() => datasets.importBytes("nist80053", csf2Catalog(), "t"), /Not an SP 800-53 catalog/);
  await assert.rejects(() => datasets.importBytes("csf2", sp80053Catalog(), "t"), /Not a CSF 2.0 catalog/);
  await assert.rejects(() => datasets.importBytes("csf2map", sp80053Catalog(), "t"), /Not an \.xlsx/);
  await datasets.importBytes("nist80053", sp80053Catalog(), "t");
  await assert.rejects(() => datasets.importBytes("nist80053", csf2Catalog(), "t"));
  assert.equal(datasets.current("nist80053")?.version, 1);
  assert.equal(new ControlLookup(datasets).lookup(["AC-2"]).results[0].result, "match");
});

test("re-importing one framework leaves the other in place", async () => {
  const { datasets, controls } = await imported();
  await datasets.importBytes("nist80053", sp80053Catalog("5.1.1"), "t");
  const out = controls.lookup(["AC-2", "PR.AA-01"]);
  assert.equal(out.results[0].citation, "cyberdrive:nist80053@v2#AC-2");
  assert.equal(out.results[0].framework_title, "NIST SP 800-53 Rev 5.1.1");
  assert.equal(out.results[1].citation, "cyberdrive:csf2@v1#PR.AA-01");
});

// ---------- lookup ----------

test("lookup AC-2: family, statement with rendered parameters, guidance, enhancements, related, citation", async () => {
  const { controls } = await imported();
  const out = controls.lookup(["AC-2"]);
  assert.deepEqual(out.frameworks, [
    { dataset: "nist80053", version: 1, title: "NIST SP 800-53 Rev 5.2.0" },
    { dataset: "csf2", version: 1, title: "NIST CSF 2.0" },
  ]);
  const [r] = out.results;
  assert.equal(r.result, "match");
  assert.equal(r.framework, "nist80053");
  assert.equal(r.kind, "control");
  assert.deepEqual(r.family, { id: "AC", title: "Access Control" });
  assert.equal(r.title, "Account Management");
  assert.equal(
    r.statement,
    [
      "a. Define the types of accounts allowed;",
      "b. Require [Assignment: organization-defined prerequisites and criteria] for group and role membership;",
      "  1. Notify [Assignment: organization-defined personnel or roles];",
      "c. Review accounts [Selection (one or more): daily; [Assignment: organization-defined frequency]].",
    ].join("\n"),
  );
  assert.equal(r.guidance, "Examples of system account types include individual, shared and guest.");
  assert.deepEqual(r.enhancements, [{ id: "AC-2(1)", title: "Automated System Account Management" }]);
  assert.deepEqual(r.related, ["AC-3", "IA-2"]);
  assert.equal(r.withdrawn, false);
  assert.equal(r.citation, "cyberdrive:nist80053@v1#AC-2");
});

test("batch lookup: enhancement spellings, CSF items, families, withdrawn, No match, invalid", async () => {
  const { controls } = await imported();
  const [a, b, c, d, e, f, g, h, i, j, k] = controls.lookup([
    "ac-2(1)",
    "AC-2.1",
    "IA-2(1)",
    "PR.AA-01",
    "GV.OC",
    "GV",
    "AC-13",
    "ID.AM-06",
    "AC-99",
    "hello",
    "AC",
  ]).results;
  assert.equal(a.id, "AC-2(1)");
  assert.equal(a.kind, "enhancement");
  assert.deepEqual(a.parent, { id: "AC-2", title: "Account Management" });
  assert.equal(a.statement, "Support the management of system accounts using [Assignment: organization-defined automated mechanisms].");
  assert.equal(a.citation, "cyberdrive:nist80053@v1#AC-2(1)");
  assert.equal(b.citation, a.citation);
  assert.equal(c.title, "Multi-factor Authentication to Privileged Accounts");
  assert.equal(d.framework, "csf2");
  assert.equal(d.kind, "subcategory");
  assert.deepEqual(d.family, { id: "PR", title: "PROTECT" });
  assert.deepEqual(d.parent, { id: "PR.AA", title: "Identity Management, Authentication, and Access Control" });
  assert.equal(d.title, "Identities and credentials for authorized users, services, and hardware are managed by the organization");
  assert.deepEqual(d.implementation_examples, ["Ex1: Initiate requests for new access", "Ex2: Issue, manage, and revoke cryptographic certificates"]);
  assert.equal(d.risk_party, "1st Party Risk");
  assert.equal(d.guidance, undefined);
  assert.equal(d.citation, "cyberdrive:csf2@v1#PR.AA-01");
  assert.equal(e.kind, "category");
  assert.equal(e.title, "Organizational Context");
  assert.deepEqual(
    e.children?.map((x) => x.id),
    ["GV.OC-01"],
  );
  assert.equal(f.kind, "function");
  assert.equal(f.statement, "The organization's cybersecurity risk management strategy is established");
  assert.equal(g.withdrawn, true);
  assert.deepEqual(g.withdrawn_to, [
    { rel: "incorporated into", id: "AC-2" },
    { rel: "incorporated into", id: "AU-6" },
  ]);
  assert.match(g.note ?? "", /Withdrawn: incorporated into AC-2, AU-6/);
  assert.equal(h.withdrawn, true);
  assert.deepEqual(
    h.withdrawn_to?.map((w) => w.id),
    ["GV.RR-02", "GV.SC-02"],
  );
  assert.equal(i.result, "No match");
  assert.match(i.note ?? "", /No match: AC-99 is not in NIST SP 800-53 Rev 5.2.0/);
  assert.equal(i.citation, undefined);
  assert.equal(j.result, "invalid");
  assert.equal(k.kind, "family");
  assert.deepEqual(
    k.children?.map((x) => [x.id, x.withdrawn ?? false]),
    [
      ["AC-2", false],
      ["AC-3", false],
      ["AC-13", true],
    ],
  );
  assert.throws(() => controls.lookup(Array(51).fill("AC-2")), /50/);
  assert.throws(() => controls.lookup([]), /at least one/i);
});

test("lookups before import explain how to import; a framework not imported is No match", async () => {
  const datasets = new DatasetStore(tempDrive(), KINDS);
  assert.throws(() => new ControlLookup(datasets).lookup(["AC-2"]), /No control framework has been imported yet/);
  assert.throws(() => new ControlLookup(datasets).map(["AC-2"]), /mapping has not been imported yet/);
  await datasets.importBytes("csf2", csf2Catalog(), "t");
  const [r] = new ControlLookup(datasets).lookup(["AC-2"]).results;
  assert.equal(r.result, "No match");
  assert.match(r.note ?? "", /not available to this key or has not been imported/);
});

// ---------- search ----------

test("search: text across frameworks, ranking, framework and family filters, withdrawn, limit", async () => {
  const { controls } = await imported();
  const mfa = controls.search("multi-factor");
  assert.deepEqual(
    mfa.results.map((r) => r.id),
    ["IA-2(1)", "IA-2"],
    "title hit before guidance hit",
  );
  assert.match(mfa.results[1].snippet ?? "", /multi-factor authentication/);
  assert.equal(mfa.results[0].citation, "cyberdrive:nist80053@v1#IA-2(1)");
  const both = controls.search("authenticat");
  assert.ok(both.results.some((r) => r.framework === "csf2") && both.results.some((r) => r.framework === "nist80053"));
  assert.deepEqual(
    controls.search("authenticat", { framework: "csf2" }).results.map((r) => r.id),
    ["PR.AA", "PR.AA-03"],
  );
  assert.deepEqual(
    controls.search("ac-2").results.map((r) => r.id)[0],
    "AC-2",
    "an ID query ranks the control first",
  );
  assert.deepEqual(
    controls.search(undefined, { family: "Identification and Authentication" }).results.map((r) => r.id),
    ["IA-2", "IA-2(1)"],
  );
  assert.deepEqual(
    controls.search(undefined, { family: "pr" }).results.map((r) => r.id),
    ["PR.AA", "PR.AA-01", "PR.AA-03"],
  );
  assert.ok(!controls.search("supervision").results.length);
  assert.deepEqual(
    controls.search("supervision", { includeWithdrawn: true }).results.map((r) => [r.id, r.withdrawn]),
    [["AC-13", true]],
  );
  assert.equal(controls.search("ac", { limit: 1 }).results.length, 1);
  assert.throws(() => controls.search("x"), /at least 2/);
  assert.throws(() => controls.search(undefined), /search text or a family/);
  assert.throws(() => controls.search("ac", { framework: "cis8" }), /Unknown framework "cis8"/);
  assert.equal(controls.search("100%_").total, 0, "LIKE wildcards are literal");
});

// ---------- map ----------

test("map: CSF to 800-53 with titles, categories roll up subcategories, 800-53 back through base control and family", async () => {
  const { controls } = await imported();
  const out = controls.map(["PR.AA-01", "GV.OC", "IA-2(1)", "IA-5(1)", "AC-3", "ID.AM-06", "nope"]);
  assert.equal(out.reference, "SP 800-53 Rev 5.2.0");
  assert.match(out.note, /not equivalences/);
  const [a, b, c, d, e, f, g] = out.results;
  assert.deepEqual(a.maps_to, [
    { framework: "nist80053", id: "AC-2", title: "Account Management" },
    { framework: "nist80053", id: "IA-2", title: "Identification and Authentication (Organizational Users)" },
    { framework: "nist80053", id: "IA-5(1)" },
  ]);
  assert.equal(a.citation, "cyberdrive:csf2map@v1#PR.AA-01");
  assert.equal(a.title, "Identities and credentials for authorized users, services, and hardware are managed by the organization");
  assert.deepEqual(b.maps_to, [{ framework: "nist80053", id: "PM-11" }], "category's own reference wins over the subcategory's");
  assert.deepEqual(c.maps_to, [
    { framework: "csf2", id: "PR.AA-03", title: "Users, services, and hardware are authenticated" },
    {
      framework: "csf2",
      id: "PR.AA-01",
      title: "Identities and credentials for authorized users, services, and hardware are managed by the organization",
      via: "base control IA-2",
    },
  ]);
  assert.deepEqual(d.maps_to?.map((m) => [m.id, m.via]), [
    ["PR.AA-01", undefined],
    ["PR.AA-03", "whole family IA"],
  ]);
  assert.equal(e.result, "No match");
  assert.match(e.note ?? "", /list no CSF 2.0 outcomes for AC-3/);
  assert.equal(f.result, "No match");
  assert.equal(g.result, "invalid");
});

// ---------- access ----------

test("DatasetReader scopes control tools to granted frameworks and logs each call", async () => {
  const { drive, datasets } = await imported();
  const none = new DatasetReader(datasets, ["oui"], "key:oui");
  assert.deepEqual(none.controlFrameworks(), []);
  assert.throws(() => none.lookupControls(["AC-2"]), /Not found/i);
  assert.throws(() => none.mapControls(["AC-2"]), /Not found/i);
  const csf = new DatasetReader(datasets, ["csf2"], "key:csf");
  const [x, y] = csf.lookupControls(["AC-2", "PR.AA-01"]).results;
  assert.equal(x.result, "No match", "800-53 is not granted");
  assert.equal(y.result, "match");
  assert.deepEqual(
    [...new Set(csf.searchControls("authenticat").results.map((r) => r.framework))],
    ["csf2"],
  );
  assert.throws(() => csf.searchControls("account", { framework: "nist80053" }), /not available to this key/);
  const mapper = new DatasetReader(datasets, ["csf2map"], "key:map");
  const m = mapper.mapControls(["PR.AA-01"]).results[0];
  assert.equal(m.title, undefined, "no titles from catalogs the key cannot read");
  assert.equal(m.maps_to?.[0].title, undefined);
  assert.equal(m.maps_to?.[0].id, "AC-2");
  const all = new DatasetReader(datasets, ["nist80053", "csf2", "csf2map"], "key:all");
  all.lookupControls(["AC-13", "AC-99"]);
  all.searchControls("multi-factor", { family: "IA" });
  all.mapControls(["PR.AA-01"]);
  const log = drive.recentActivity(10);
  const lookup = log.find((a) => a.action === "lookup_control" && a.actor === "key:all");
  assert.equal(lookup?.path, "cyberdrive:nist80053+csf2");
  assert.match(lookup?.detail ?? "", /AC-13=withdrawn, AC-99=No match/);
  const search = log.find((a) => a.action === "search_controls" && a.actor === "key:all");
  assert.match(search?.detail ?? "", /"multi-factor" in IA: 2 hit/);
  const map = log.find((a) => a.action === "map_control" && a.actor === "key:all");
  assert.equal(map?.path, "cyberdrive:csf2map");
  assert.match(map?.detail ?? "", /PR\.AA-01=3 mapping/);
  assert.ok(log.some((a) => a.action === "lookup_control" && a.actor === "key:csf" && a.path === "cyberdrive:csf2"));
});

test("MCP: control tools are listed only for keys granted a framework, map_control only with csf2map", async () => {
  const drive = tempDrive();
  const keys = keysFor(drive);
  const { app, datasets, close } = createApp({ drive, keys, config: testConfig(drive) });
  after(() => close());
  await datasets.importBytes("nist80053", sp80053Catalog(), "test");
  await datasets.importBytes("csf2", csf2Catalog(), "test");
  await datasets.importBytes("csf2map", csf2MapWorkbook(), "test");
  const ouiKey = keys.create("oui", [], ["oui"]).key;
  const nistKey = keys.create("nist", [], ["nist80053", "csf2", "csf2map"]).key;
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
  const o = await connect(ouiKey);
  const ouiTools = (await o.listTools()).tools.map((t) => t.name);
  assert.ok(!ouiTools.includes("lookup_control") && !ouiTools.includes("map_control"));
  const n = await connect(nistKey);
  const tools = (await n.listTools()).tools;
  const names = tools.map((t) => t.name);
  for (const t of ["lookup_control", "search_controls", "map_control"]) assert.ok(names.includes(t), t);
  assert.equal(tools.find((t) => t.name === "lookup_control")?.annotations?.readOnlyHint, true);
  assert.match(n.getInstructions() ?? "", /lookup_control/);
  const text = (res: unknown) => JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
  const res = text(await n.callTool({ name: "lookup_control", arguments: { ids: ["ac-2(1)", "PR.AA-01", "ZZ-9"] } }));
  assert.equal(res.results[0].citation, "cyberdrive:nist80053@v1#AC-2(1)");
  assert.equal(res.results[1].citation, "cyberdrive:csf2@v1#PR.AA-01");
  assert.equal(res.results[2].result, "invalid");
  const found = text(await n.callTool({ name: "search_controls", arguments: { query: "multi-factor", framework: "nist80053", limit: 1 } }));
  assert.equal(found.results.length, 1);
  assert.equal(found.total, 2);
  const mapped = text(await n.callTool({ name: "map_control", arguments: { ids: ["PR.AA-01"] } }));
  assert.equal(mapped.results[0].maps_to[0].id, "AC-2");
  const tooMany = await n.callTool({ name: "lookup_control", arguments: { ids: Array(51).fill("AC-2") } });
  assert.equal(tooMany.isError, true);
  const bad = await n.callTool({ name: "search_controls", arguments: { query: "x" } });
  assert.equal(bad.isError, true);
});

// ---------- the real NIST files (optional) ----------

const R80053 = process.env.NIST80053_JSON;
const RCSF = process.env.CSF2_JSON;
const RMAP = process.env.CSF2MAP_XLSX;
const haveReal = [R80053, RCSF, RMAP].every((f) => f && existsSync(f));
test(
  "real NIST files: AC-2, IA-2(1), PR.AA-01, withdrawn AC-13 and ID.AM-06, PR.AA-01 mapping",
  { skip: haveReal ? false : "set NIST80053_JSON, CSF2_JSON and CSF2MAP_XLSX" },
  async () => {
    const datasets = new DatasetStore(tempDrive(), KINDS);
    const a = await datasets.importBytes("nist80053", new Uint8Array(readFileSync(R80053 as string)), "real");
    const b = await datasets.importBytes("csf2", new Uint8Array(readFileSync(RCSF as string)), "real");
    const c = await datasets.importBytes("csf2map", new Uint8Array(readFileSync(RMAP as string)), "real");
    assert.ok(a.rows > 1000, `${a.rows} controls`);
    assert.ok(b.rows > 200, `${b.rows} CSF items`);
    assert.ok(c.rows > 500, `${c.rows} mappings`);
    const controls = new ControlLookup(datasets);
    const [ac2, ia21, praa01, ac13, idam06] = controls.lookup(["AC-2", "IA-2(1)", "PR.AA-01", "AC-13", "ID.AM-06"]).results;
    assert.equal(ac2.title, "Account Management");
    assert.match(ac2.statement ?? "", /\[Assignment: organization-defined prerequisites and criteria\]/);
    assert.ok((ac2.enhancements?.length ?? 0) >= 13);
    assert.ok(ac2.related?.includes("AC-3"));
    assert.equal(ia21.title, "Multi-factor Authentication to Privileged Accounts");
    assert.match(ia21.statement ?? "", /multi-factor authentication for access to privileged accounts/);
    assert.equal(praa01.framework, "csf2");
    assert.match(praa01.title ?? "", /Identities and credentials/);
    assert.ok((praa01.implementation_examples?.length ?? 0) >= 3);
    assert.equal(ac13.withdrawn, true);
    assert.deepEqual(
      ac13.withdrawn_to?.map((w) => w.id),
      ["AC-2", "AU-6"],
    );
    assert.equal(idam06.withdrawn, true);
    const [m] = controls.map(["PR.AA-01"]).results;
    assert.ok(m.maps_to?.some((t) => t.id === "AC-2" && t.title === "Account Management"));
    assert.ok(m.maps_to?.some((t) => t.id === "IA-2"));
  },
);
