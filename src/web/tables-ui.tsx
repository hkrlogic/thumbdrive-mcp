/**
 * Admin routes for user tables (grid editor, publish, rollback, import) and
 * the read-only share view. Mounted by registerUi, behind the same session,
 * CSRF and CSP middleware as every other admin page.
 */
import type { Context, Hono } from "hono";
import type { JSX } from "hono/jsx/jsx-runtime";
import { randomBytes } from "node:crypto";
import { parseCsv } from "../extract/text.ts";
import type { Drive } from "../storage/drive.ts";
import { joinDrivePath, normalizeDrivePath } from "../storage/paths.ts";
import { applyImport, type Mapping, parseUpload, preview, type Sheet, sniffDelimiter } from "../tables/importer.ts";
import { type PublishedTable, type RowEdits, type TableStore, TableError } from "../tables/store.ts";
import { TEMPLATES } from "../tables/templates.ts";
import { type Column, COLUMN_TYPES, displayValue, isColumnType } from "../tables/types.ts";
import type { Flash, PageCtx } from "./views.tsx";
import { ImportPreviewPage, PublishPage, RowHistoryPage, TablePage, TablesPage, tableUrl } from "./tables-views.tsx";

type FormValue = string | File | Array<string | File>;
type Form = Record<string, FormValue>;

export interface TablesUiKit {
  drive: Drive;
  tables: TableStore;
  ctx: (c: Context) => PageCtx;
  render: (c: Context, node: JSX.Element, status?: 200 | 400 | 404) => Response | Promise<Response>;
  done: (c: Context, to: string, kind: Flash["kind"], msg: string) => Response;
  form: (c: Context) => Promise<Form>;
  wantsJson: (c: Context) => boolean;
  userMessage: (error: unknown) => string;
}

const str = (form: Form, name: string): string => {
  const v = form[name];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" ? first : "";
};
const lines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

// ---------- CSV export ----------

/** RFC 4180 CSV with a guard against spreadsheet formula injection on text cells. */
export function tableCsv(published: PublishedTable): string {
  const cols = published.version.columns;
  const cell = (v: unknown) => {
    let s = displayValue(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [cols.map((c) => cell(c.name)).join(",")];
  for (const r of published.rows) out.push(cols.map((c) => cell(r.data[c.id])).join(","));
  return out.join("\r\n") + "\r\n";
}

export function csvResponse(name: string, csv: string): Response {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "private, no-store",
    },
  });
}

// ---------- paste ----------

/** Pasted TSV/CSV to column-id records. A first row naming at least half the columns is a header. */
export function pastedRecords(text: string, columns: Column[]): Array<Record<string, unknown>> {
  const rows = parseCsv(text.replace(/\s+$/, ""), sniffDelimiter(text)).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length === 0) throw new TableError("Nothing to paste");
  if (columns.length === 0) throw new TableError("Add a column first");
  let mapping: Array<Column | undefined> = columns;
  const byName = rows[0].map((h) => columns.find((c) => c.name.toLowerCase() === h.trim().toLowerCase()));
  const hits = byName.filter(Boolean).length;
  if (hits >= Math.max(1, Math.ceil(Math.min(rows[0].length, columns.length) / 2))) {
    mapping = byName;
    rows.shift();
  }
  if (rows.length > 10_000) throw new TableError("Paste at most 10,000 rows at a time; use Import for more");
  return rows.map((r) => {
    const rec: Record<string, unknown> = {};
    r.forEach((v, i) => {
      const col = mapping[i];
      if (col && v.trim() !== "") rec[col.id] = v;
    });
    return rec;
  });
}

// ---------- JSON edits ----------

const scalar = (v: unknown) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

function parseValues(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new TableError("values must be an object");
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!/^c\d+$/.test(k) || !scalar(x)) throw new TableError("Bad cell value");
    out[k] = x;
  }
  return out;
}

/** Validate the JSON body of POST /tables/:id/edits; anything unexpected is refused. */
export function parseEdits(body: unknown): RowEdits {
  if (!body || typeof body !== "object") throw new TableError("Expected a JSON object");
  const b = body as Record<string, unknown>;
  const arr = (v: unknown, name: string) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > 10_000) throw new TableError(`${name} must be a list of at most 10,000`);
    return v;
  };
  const rowId = (v: unknown) => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new TableError("Bad row id");
    return v;
  };
  return {
    updates: arr(b.updates, "updates").map((u) => ({ row: rowId((u as { row?: unknown })?.row), values: parseValues((u as { values?: unknown })?.values) })),
    adds: arr(b.adds, "adds").map((a) => ({ values: parseValues((a as { values?: unknown })?.values ?? {}) })),
    deletes: arr(b.deletes, "deletes").map(rowId),
  };
}

// ---------- import staging ----------

interface Staged {
  fileName: string;
  sheets: Sheet[];
  target: number | "new";
  at: number;
}
const STAGE_TTL = 30 * 60 * 1000;
const STAGE_MAX = 20;

export function registerTablesUi(app: Hono, kit: TablesUiKit): void {
  const { drive, tables, ctx, render, done, form, wantsJson, userMessage } = kit;
  const staged = new Map<string, Staged>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of staged) if (now - v.at > STAGE_TTL) staged.delete(k);
    while (staged.size >= STAGE_MAX) staged.delete(staged.keys().next().value as string);
  };

  const idParam = (c: Context): number => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id < 1) throw new TableError("Unknown table");
    return id;
  };
  /** Run a mutation, then redirect back with a flash. */
  const act = async (c: Context, fn: (id: number, body: Form) => string | Promise<string>, back?: (id: number) => string) => {
    let id = 0;
    try {
      id = idParam(c);
      const body = await form(c);
      const msg = await fn(id, body);
      return done(c, back ? back(id) : tableUrl(id), "ok", msg);
    } catch (error) {
      return done(c, id && tables.list().some((t) => t.id === id) ? tableUrl(id) : "/tables", "error", userMessage(error));
    }
  };
  const jsonError = (c: Context, error: unknown) => c.json({ error: userMessage(error) }, error instanceof TableError ? 400 : 404);
  const summary = (id: number) => {
    const d = tables.diff(id);
    return { added: d.added.length, changed: d.changed.length, removed: d.removed.length, columns: d.columnChanges.length, issues: d.issues.length };
  };

  app.get("/tables", (c) => {
    const folders = drive.listFolders();
    return render(
      c,
      <TablesPage ctx={ctx(c)} tables={tables.list()} folders={folders} folder={c.req.query("folder")} templates={TEMPLATES} />,
    );
  });

  app.post("/tables", async (c) => {
    const body = await form(c);
    try {
      const t = tables.create({
        folder: str(body, "folder") || "/",
        name: str(body, "name"),
        title: str(body, "title"),
        template: str(body, "template") || undefined,
      });
      return done(c, tableUrl(t.id), "ok", `Created ${t.path}. Add rows, then publish so agents can see it.`);
    } catch (error) {
      return done(c, "/tables#new-table", "error", userMessage(error));
    }
  });

  app.get("/tables/:id", (c) => {
    try {
      const id = idParam(c);
      const table = tables.get(id);
      return render(
        c,
        <TablePage ctx={ctx(c)} data={{ table, draftRows: tables.draftRowCount(id), diff: tables.diff(id), versions: tables.versions(id) }} />,
      );
    } catch (error) {
      return done(c, "/tables", "error", userMessage(error));
    }
  });

  app.get("/tables/:id/draft.json", (c) => {
    try {
      const id = idParam(c);
      const t = tables.get(id);
      return c.json({
        table: { id: t.id, path: t.path, title: t.title, columns: t.columns, keyColumn: t.keyColumn, publishedVersion: t.publishedVersion },
        types: COLUMN_TYPES,
        rows: tables.draftRows(id),
        summary: summary(id),
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/tables/:id/edits", async (c) => {
    try {
      const id = idParam(c);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new TableError("Expected a JSON body");
      }
      const res = tables.edit(id, parseEdits(body));
      const rows = res.rows;
      return c.json({ rows, added: rows.filter((r) => res.added.includes(r.id)), deleted: res.deleted, summary: summary(id) });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/tables/:id/paste", async (c) => {
    if (wantsJson(c)) {
      try {
        const id = idParam(c);
        const body = (await c.req.json()) as { text?: unknown };
        if (typeof body.text !== "string") throw new TableError("Expected text");
        const res = tables.upsert(id, pastedRecords(body.text, tables.get(id).columns));
        return c.json({ ...res, rows: tables.draftRows(id), summary: summary(id) });
      } catch (error) {
        return jsonError(c, error);
      }
    }
    return act(c, (id, body) => {
      const res = tables.upsert(id, pastedRecords(str(body, "text"), tables.get(id).columns));
      return `Added ${res.added} row(s), updated ${res.updated}${res.invalidRows.length ? `; ${res.invalidRows.length} row(s) have red cells to fix` : ""}.`;
    });
  });

  app.post("/tables/:id/columns", (c) =>
    act(c, (id, body) => {
      const col = tables.addColumn(id, { name: str(body, "name"), type: str(body, "type") || "text", options: lines(str(body, "options")) });
      return `Added the column ${col.name}.`;
    }, (id) => `${tableUrl(id)}#columns`),
  );

  app.post("/tables/:id/columns/:col", (c) =>
    act(c, (id, body) => {
      const type = str(body, "type");
      const col = tables.updateColumn(id, c.req.param("col"), {
        name: str(body, "name"),
        type: type || undefined,
        options: type === "select" ? lines(str(body, "options")) : undefined,
      });
      return `Saved the column ${col.name}.`;
    }, (id) => `${tableUrl(id)}#columns`),
  );

  app.post("/tables/:id/columns/:col/move", (c) =>
    act(c, (id, body) => {
      const t = tables.get(id);
      const i = t.columns.findIndex((x) => x.id === c.req.param("col"));
      if (i < 0) throw new TableError("That column no longer exists");
      tables.moveColumn(id, t.columns[i].id, str(body, "dir") === "up" ? i - 1 : i + 1);
      return `Moved ${t.columns[i].name}.`;
    }, (id) => `${tableUrl(id)}#columns`),
  );

  app.post("/tables/:id/columns/:col/delete", (c) =>
    act(c, (id) => {
      const col = tables.get(id).columns.find((x) => x.id === c.req.param("col"));
      if (!col) throw new TableError("That column no longer exists");
      tables.deleteColumn(id, col.id);
      return `Deleted the column ${col.name} from the draft.`;
    }, (id) => `${tableUrl(id)}#columns`),
  );

  app.post("/tables/:id/key", (c) =>
    act(c, (id, body) => {
      const colId = str(body, "column") || null;
      tables.setKey(id, colId);
      const col = tables.get(id).columns.find((x) => x.id === colId);
      return col ? `${col.name} is now the key column.` : "The table has no key column now.";
    }, (id) => `${tableUrl(id)}#columns`),
  );

  app.post("/tables/:id/info", (c) =>
    act(c, (id, body) => {
      tables.updateInfo(id, { title: str(body, "title"), description: str(body, "description") });
      return "Saved.";
    }),
  );

  app.get("/tables/:id/publish", (c) => {
    try {
      const id = idParam(c);
      return render(c, <PublishPage ctx={ctx(c)} table={tables.get(id)} diff={tables.diff(id)} />);
    } catch (error) {
      return done(c, "/tables", "error", userMessage(error));
    }
  });

  app.post("/tables/:id/publish", async (c) => {
    let id = 0;
    try {
      id = idParam(c);
      const body = await form(c);
      const v = tables.publish(id, str(body, "note"));
      return done(c, tableUrl(id), "ok", `Published v${v.version}: +${v.added} ~${v.changed} −${v.removed}. Agents see it now.`);
    } catch (error) {
      return done(c, id ? `/tables/${id}/publish` : "/tables", "error", userMessage(error));
    }
  });

  app.post("/tables/:id/rollback", (c) =>
    act(c, (id, body) => {
      const to = Number(str(body, "version"));
      const v = tables.rollback(id, to);
      return `Rolled back: v${v.version} has v${to}'s rows and columns. Agents see it now.`;
    }, (id) => `${tableUrl(id)}#versions`),
  );

  app.post("/tables/:id/discard", (c) =>
    act(c, (id) => {
      tables.discard(id);
      return "Draft discarded; it matches the published version again.";
    }),
  );

  app.post("/tables/:id/delete", async (c) => {
    try {
      const t = tables.remove(idParam(c));
      return done(c, "/tables", "ok", `Deleted the table ${t.path}.`);
    } catch (error) {
      return done(c, "/tables", "error", userMessage(error));
    }
  });

  app.get("/tables/:id/rows/:row", (c) => {
    try {
      const id = idParam(c);
      const row = Number(c.req.param("row"));
      if (!Number.isSafeInteger(row) || row < 1) throw new TableError("Unknown row");
      return render(c, <RowHistoryPage ctx={ctx(c)} history={tables.rowHistory(id, row)} />);
    } catch (error) {
      return done(c, "/tables", "error", userMessage(error));
    }
  });

  app.get("/tables/:id/export.csv", (c) => {
    try {
      const id = idParam(c);
      const p = tables.published(id);
      drive.logActivity("admin", "table.export", `${p.table.path}`, `v${p.version.version}, ${p.rows.length} rows`);
      return csvResponse(`${p.table.name}-v${p.version.version}.csv`, tableCsv(p));
    } catch (error) {
      return done(c, "/tables", "error", userMessage(error));
    }
  });

  // ---------- import ----------

  const previewPage = (c: Context, stage: string, s: Staged, sheet: number) => {
    const target = s.target === "new" ? undefined : tables.get(s.target);
    const sh = s.sheets[sheet];
    const base = s.fileName.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+/, "").slice(0, 64) || "imported";
    return render(
      c,
      <ImportPreviewPage
        ctx={ctx(c)}
        data={{
          stage,
          fileName: s.fileName,
          sheets: s.sheets.map((x) => x.name),
          sheet,
          rows: sh.rows.length,
          columns: preview(sh, target),
          table: target,
          folders: drive.listFolders(),
          suggestedName: base,
        }}
      />,
    );
  };

  app.post("/tables/import", async (c) => {
    try {
      const body = await form(c);
      const file = body.file;
      const f = Array.isArray(file) ? file[0] : file;
      if (!f || typeof f === "string" || !f.name) throw new TableError("Choose a .csv or .xlsx file");
      const targetRaw = str(body, "target") || "new";
      const target = targetRaw === "new" ? "new" : tables.get(Number(targetRaw)).id;
      const sheets = await parseUpload(f.name, new Uint8Array(await f.arrayBuffer()));
      sweep();
      const stage = randomBytes(12).toString("base64url");
      const s: Staged = { fileName: f.name.slice(0, 200), sheets, target, at: Date.now() };
      staged.set(stage, s);
      return previewPage(c, stage, s, 0);
    } catch (error) {
      return done(c, "/tables#import", "error", userMessage(error));
    }
  });

  app.post("/tables/import/:stage", async (c) => {
    const stage = c.req.param("stage");
    const s = staged.get(stage);
    if (!s || Date.now() - s.at > STAGE_TTL) return done(c, "/tables#import", "error", "That import expired; upload the file again.");
    const body = await form(c);
    const sheet = Math.min(Math.max(0, Number(str(body, "sheet")) || 0), s.sheets.length - 1);
    if (str(body, "action") === "sheet") return previewPage(c, stage, s, sheet);
    const sh = s.sheets[sheet];
    let createdId: number | undefined;
    try {
      const mappings: Mapping[] = sh.header.map((h, i) => {
        const m = str(body, `map_${i}`);
        if (m === "skip") return { action: "skip" };
        if (m.startsWith("col:")) return { action: "existing", column: m.slice(4) };
        const type = str(body, `type_${i}`) || "text";
        if (!isColumnType(type)) throw new TableError(`Unknown type ${type}`);
        const options = type === "select" ? lines(str(body, `options_${i}`)) : undefined;
        return { action: "new", name: h, type, options: options?.length ? options : undefined };
      });
      // A select column suggested without choices gets them from the data.
      for (const [i, m] of mappings.entries()) {
        if (m.action === "new" && m.type === "select" && !m.options) {
          m.options = [...new Set(sh.rows.map((r) => displayValue(r[i] instanceof Date ? null : r[i]).trim()).filter(Boolean))].slice(0, 100);
        }
      }
      const keyRaw = str(body, "key");
      const key = keyRaw === "" ? undefined : Number(keyRaw);
      let id: number;
      if (s.target === "new") {
        const t = tables.create({ folder: str(body, "folder") || "/", name: str(body, "name"), title: "", description: `Imported from ${s.fileName}` });
        id = createdId = t.id;
      } else id = s.target;
      const res = applyImport(tables, id, sh, mappings, key);
      staged.delete(stage);
      const parts = [`Imported into the draft: ${res.added} added, ${res.updated} updated`];
      if (res.newColumns.length) parts.push(`new columns: ${res.newColumns.join(", ")}`);
      if (res.problems.length) {
        const first = res.problems.slice(0, 3).map((p) => `line ${p.line} ${p.column}: ${p.message}`);
        parts.push(`${res.problems.length} row(s) have invalid cells (${first.join("; ")}${res.problems.length > 3 ? "; …" : ""}), shown in red`);
      }
      return done(c, tableUrl(id), res.problems.length ? "warn" : "ok", `${parts.join(". ")}. Review, then publish.`);
    } catch (error) {
      // A failed import into a brand-new table leaves nothing behind.
      if (createdId) tables.remove(createdId);
      return done(c, "/tables#import", "error", userMessage(error));
    }
  });
}

/** Published tables directly in `folder`, for the share page. */
export function sharedTables(tables: TableStore, folder: string, rel: (path: string) => string) {
  return tables
    .list()
    .filter((t) => t.folder === normalizeDrivePath(folder) && t.publishedVersion > 0)
    .map((t) => ({ rel: rel(joinDrivePath(t.folder, t.name)), name: t.name, title: t.title, version: t.publishedVersion, rows: t.publishedRows }));
}
