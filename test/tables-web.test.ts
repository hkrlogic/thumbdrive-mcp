/** Tables in the admin UI: grid assets under a strict CSP, JSON edits with CSRF, publish/rollback, paste, import, shares. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp } from "../src/http/app.ts";
import { ShareStore } from "../src/web/shares.ts";
import { Browser, signedIn } from "./browser.ts";
import { keysFor, tempDrive, testConfig } from "./helpers.ts";
import { xlsx } from "./xlsx.ts";

function setup() {
  const drive = tempDrive();
  const keys = keysFor(drive);
  const created = createApp({ drive, keys, config: testConfig(drive) });
  after(() => created.close());
  drive.makeFolder("/inventory");
  return { drive, keys, ...created, shares: new ShareStore(drive.db) };
}

const idFrom = (location: string | null) => Number(location?.match(/^\/tables\/(\d+)/)?.[1]);

async function json(b: Browser, path: string, body: unknown, csrf: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (csrf) headers["x-csrf-token"] = csrf;
  const res = await b.fetch(path, { method: "POST", body: JSON.stringify(body), headers });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

test("the grid page loads vendored Tabulator from /assets under a strict CSP", async () => {
  const { app } = setup();
  const b = await signedIn(app);
  const res = await b.post("/tables", { folder: "/inventory", template: "server-inventory", name: "servers", title: "Servers" }, { from: "/tables" });
  assert.equal(res.status, 303);
  const id = idFrom(res.headers.get("location"));
  const page = await b.page(`/tables/${id}`);
  assert.equal(page.status, 200);
  const csp = page.res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
  assert.match(page.html, /src="\/assets\/vendor\/tabulator-6\.7\.1\.min\.js"/);
  assert.match(page.html, /src="\/assets\/tables\.js"/);
  assert.doesNotMatch(page.html, /<script(?![^>]*\bsrc=)[^>]*>/, "no inline scripts");
  assert.doesNotMatch(page.html, /\sstyle=/, "no inline styles");
  for (const asset of ["/assets/vendor/tabulator-6.7.1.min.js", "/assets/vendor/tabulator-6.7.1.min.css", "/assets/tables.js", "/assets/tables.css"]) {
    const a = await b.fetch(asset);
    assert.equal(a.status, 200, asset);
    assert.match(a.headers.get("content-type") ?? "", asset.endsWith(".js") ? /javascript/ : /css/);
    assert.ok((await a.arrayBuffer()).byteLength > 500, asset);
  }
  assert.equal((await b.fetch("/assets/vendor/tabulator-6.7.1.min.js.map")).status, 404);
  // Template columns are there.
  const draft = (await (await b.fetch(`/tables/${id}/draft.json`)).json()) as { table: { columns: Array<{ name: string }>; keyColumn: string } };
  assert.deepEqual(
    draft.table.columns.map((c) => c.name),
    ["Hostname", "IP address", "Environment", "OS", "Owner name", "Owner email", "Team", "Location", "Criticality", "Notes"],
  );
});

test("grid edits need the CSRF header; invalid cells block publish until fixed; rollback", async () => {
  const { app, tables } = setup();
  const b = await signedIn(app);
  const res = await b.post("/tables", { folder: "/inventory", template: "server-inventory", name: "servers" }, { from: "/tables" });
  const id = idFrom(res.headers.get("location"));
  const { csrf } = await b.page(`/tables/${id}`);

  const edits = `/tables/${id}/edits`;
  assert.equal((await json(b, edits, { adds: [{ values: {} }] }, null)).status, 403, "no CSRF header");
  assert.equal((await json(b, edits, { adds: [{ values: {} }] }, "wrong")).status, 403);
  assert.equal(tables.draftRowCount(id), 0);

  const added = await json(b, edits, { adds: [{ values: { c1: "web01", c2: "10.0.0.300", c3: "production" } }] }, csrf);
  assert.equal(added.status, 200);
  const row = (added.body.added as Array<{ id: number; errors: Record<string, string> }>)[0];
  assert.ok(row.errors.c2, "bad IP flagged");
  assert.equal((added.body.summary as { issues: number }).issues, 1);
  assert.equal((await json(b, edits, { updates: [{ row: row.id, values: { c99: { x: 1 } } }] }, csrf)).status, 400);

  // Publish is refused while red cells remain.
  const pub = await b.page(`/tables/${id}/publish`);
  assert.match(pub.html, /Row 1, IP address: not a valid/);
  const blocked = await b.post(`/tables/${id}/publish`, { note: "try" }, { csrf: pub.csrf });
  assert.match(await (await b.page(blocked.headers.get("location") ?? "/")).html, /fix|invalid|problem/i);
  assert.equal(tables.get(id).publishedVersion, 0);

  await json(b, edits, { updates: [{ row: row.id, values: { c2: "10.0.0.30" } }] }, csrf);
  const ok = await b.post(`/tables/${id}/publish`, { note: "first" }, { from: `/tables/${id}/publish` });
  assert.equal(ok.headers.get("location"), `/tables/${id}`);
  assert.equal(tables.get(id).publishedVersion, 1);
  assert.equal(tables.published(id).rows[0].data.c1, "web01");

  // Publish needs a note.
  await json(b, edits, { updates: [{ row: row.id, values: { c4: "Debian 12" } }] }, csrf);
  await b.post(`/tables/${id}/publish`, { note: "" }, { from: `/tables/${id}/publish` });
  assert.equal(tables.get(id).publishedVersion, 1);
  await b.post(`/tables/${id}/publish`, { note: "os" }, { from: `/tables/${id}/publish` });
  assert.equal(tables.get(id).publishedVersion, 2);

  // Versions list and one-click rollback.
  const page = await b.page(`/tables/${id}`);
  assert.match(page.html, /first/);
  assert.match(page.html, /Roll back/);
  await b.post(`/tables/${id}/rollback`, { version: "1" }, { csrf: page.csrf });
  assert.equal(tables.get(id).publishedVersion, 3);
  assert.equal(tables.published(id).rows[0].data.c4, undefined);

  // Row history.
  const hist = await b.page(`/tables/${id}/rows/${row.id}`);
  assert.equal(hist.status, 200);
  assert.match(hist.html, /Debian 12/);
});

test("paste rows, columns, CSV export with formula guard, folder delete guard", async () => {
  const { app, tables } = setup();
  const b = await signedIn(app);
  const res = await b.post("/tables", { folder: "/inventory", template: "", name: "people", title: "People" }, { from: "/tables" });
  const id = idFrom(res.headers.get("location"));
  await b.post(`/tables/${id}/columns`, { name: "Name", type: "text" }, { from: `/tables/${id}` });
  await b.post(`/tables/${id}/columns`, { name: "Email", type: "email" }, { from: `/tables/${id}` });
  await b.post(`/tables/${id}/columns`, { name: "Tier", type: "select", options: "gold\nsilver" }, { from: `/tables/${id}` });
  const cols = tables.get(id).columns;
  assert.deepEqual(
    cols.map((c) => [c.name, c.type]),
    [
      ["Name", "text"],
      ["Email", "email"],
      ["Tier", "select"],
    ],
  );
  assert.deepEqual(cols[2].options, ["gold", "silver"]);
  await b.post(`/tables/${id}/key`, { column: cols[1].id }, { from: `/tables/${id}` });

  // Excel-style paste with a header row in a different order.
  await b.post(`/tables/${id}/paste`, { text: "Email\tName\nann@example.com\tAnn\n=cmd@example.com\t=HYPERLINK(1)\nbad\tBob\n" }, { from: `/tables/${id}` });
  const rows = tables.draftRows(id);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].data[cols[0].id], "Ann");
  assert.ok(rows[2].errors[cols[1].id], "invalid email flagged");
  // JSON paste re-keys by email: updates instead of duplicating.
  const { csrf } = await b.page(`/tables/${id}`);
  const again = await json(b, `/tables/${id}/paste`, { text: "Name,Email,Tier\nAnnie,ANN@example.com,gold\n" }, csrf);
  assert.equal(again.status, 200);
  assert.equal(again.body.updated, 1);
  assert.equal(again.body.added, 0);

  // Reorder and rename.
  await b.post(`/tables/${id}/columns/${cols[2].id}/move`, { dir: "up" }, { from: `/tables/${id}` });
  assert.equal(tables.get(id).columns[1].name, "Tier");
  await b.post(`/tables/${id}/columns/${cols[0].id}`, { name: "Full name", type: "text" }, { from: `/tables/${id}` });
  assert.equal(tables.get(id).columns[0].name, "Full name");

  // Fix the bad email, publish, export.
  const bad = tables.draftRows(id)[2];
  await json(b, `/tables/${id}/edits`, { updates: [{ row: bad.id, values: { [cols[1].id]: "bob@example.com" } }] }, csrf);
  await b.post(`/tables/${id}/publish`, { note: "people" }, { from: `/tables/${id}/publish` });
  const csv = await b.fetch(`/tables/${id}/export.csv`);
  assert.match(csv.headers.get("content-disposition") ?? "", /people-v1\.csv/);
  const body = await csv.text();
  assert.match(body, /^Full name,Tier,Email\r\n/);
  assert.match(body, /'=HYPERLINK\(1\)/);

  // A folder holding a table cannot be deleted.
  const del = await b.post("/files/delete", { path: "/inventory" }, { from: "/files?path=/inventory" });
  assert.match(await (await b.page(del.headers.get("location") ?? "/")).html, /contains 1 table/);
  assert.ok(tables.find("/inventory/people"));
  // The folder page lists it.
  assert.match((await b.page("/files?path=/inventory")).html, /\/tables\/\d+/);
});

test("import an xlsx into a new table: preview, suggested types, key, invalid rows reported", async () => {
  const { app, tables } = setup();
  const b = await signedIn(app);
  const book = xlsx({
    Hosts: [
      ["Hostname", "IP", "Environment", "MAC", "Notes"],
      ["web01.example.com", "10.0.0.10", "production", "00:1a:2b:3c:4d:5e", "front"],
      ["web02.example.com", "10.0.0.11", "production", "00-1A-2B-3C-4D-5F", null],
      ["db01.example.com", "10.0.0.999", "staging", "001a.2b3c.4d60", "bad ip"],
    ],
  });
  const { csrf } = await b.page("/tables");
  const res = await b.post("/tables/import", { target: "new" }, { csrf, files: [["file", new Blob([book as Uint8Array<ArrayBuffer>]), "hosts.xlsx"]] });
  assert.equal(res.status, 200);
  const html = await res.text();
  const stage = html.match(/action="\/tables\/import\/([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(stage, "preview page");
  assert.match(html, /<option value="hostname" selected/);
  assert.match(html, /<option value="ip" selected/);
  assert.match(html, /<option value="mac" selected/);
  const apply = await b.post(
    `/tables/import/${stage}`,
    {
      action: "import",
      sheet: "0",
      folder: "/inventory",
      name: "hosts",
      map_0: "new",
      type_0: "hostname",
      map_1: "new",
      type_1: "ip",
      map_2: "new",
      type_2: "select",
      map_3: "new",
      type_3: "mac",
      map_4: "skip",
      type_4: "text",
      key: "0",
    },
    { csrf },
  );
  assert.equal(apply.status, 303);
  const id = idFrom(apply.headers.get("location"));
  const t = tables.get(id);
  assert.equal(t.path, "/inventory/hosts");
  assert.deepEqual(
    t.columns.map((c) => c.type),
    ["hostname", "ip", "select", "mac"],
  );
  assert.deepEqual(t.columns[2].options?.sort(), ["production", "staging"]);
  assert.equal(t.keyColumn, t.columns[0].id);
  assert.equal(t.publishedVersion, 0, "imports land as a draft");
  const rows = tables.draftRows(id);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].data[t.columns[3].id], "00:1A:2B:3C:4D:5F");
  assert.ok(rows[2].errors[t.columns[1].id]);
  assert.match(await (await b.page(apply.headers.get("location") ?? "/")).html, /invalid/);
  // The stage is single use.
  const replay = await b.post(`/tables/import/${stage}`, { action: "import", name: "x", folder: "/inventory" }, { csrf });
  assert.match(await (await b.page(replay.headers.get("location") ?? "/")).html, /expired/);
  // Bad files are refused.
  const junk = await b.post("/tables/import", { target: "new" }, { csrf, files: [["file", new Blob([new Uint8Array([0, 1, 2, 3, 0, 0])]), "x.xls"]] });
  assert.equal(junk.status, 303);
});

test("share links show published tables read-only; drafts stay private", async () => {
  const { app, tables, drive } = setup();
  const b = await signedIn(app);
  const t = tables.create({ folder: "/inventory", name: "servers", template: "server-inventory" });
  tables.edit(t.id, { adds: [{ values: { c1: "web01", c2: "10.0.0.1" } }] });
  tables.publish(t.id, "v1");
  tables.edit(t.id, { adds: [{ values: { c1: "secret-draft" } }] });
  const res = await b.post("/shares", { folder: "/inventory", hours: "24", label: "x" }, { from: "/shares" });
  const token = (await res.text()).match(/\/s\/(tds_[A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token);
  const anon = new Browser(app);
  const listing = await anon.page(`/s/${token}`);
  assert.match(listing.html, /servers/);
  const view = await anon.page(`/s/${token}/table?path=/servers`);
  assert.equal(view.status, 200);
  assert.match(view.html, /web01/);
  assert.doesNotMatch(view.html, /secret-draft/);
  assert.doesNotMatch(view.html, /<form/);
  const csv = await (await anon.fetch(`/s/${token}/table.csv?path=/servers`)).text();
  assert.match(csv, /web01/);
  assert.equal((await anon.fetch(`/s/${token}/table?path=/../other`)).status, 404);
  assert.ok(drive.queryActivity({ action: "table.download" }).length >= 1);
  // Mutations stay behind sign-in.
  const denied = await anon.post(`/tables/${t.id}/publish`, { note: "x" }, { csrf: listing.csrf });
  assert.ok(denied.status === 403 || (denied.status === 303 && /\/login/.test(denied.headers.get("location") ?? "")), String(denied.status));
  assert.equal(tables.get(t.id).publishedVersion, 1);
});
