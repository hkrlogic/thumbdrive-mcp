/**
 * User tables: typed rows stored in SQLite at a drive folder path.
 *
 *   draft      user_tables.columns + user_table_draft: what the admin edits.
 *              Cells hold canonical values, or the raw text when invalid.
 *   published  user_table_versions + user_table_rows: immutable versions.
 *              A row record is valid for versions [v_from, v_to); unchanged
 *              rows are not copied, so a version costs only what changed.
 *
 * Agents only ever read the latest published version. Row IDs come from a
 * per-table counter and are never reused; rollback restores old rows under
 * their old IDs. Column IDs ("c1", "c2", ...) work the same way, so renaming
 * a column never touches row data.
 */
import type { DatabaseSync } from "node:sqlite";
import { type Drive, NotFoundError } from "../storage/drive.ts";
import { nowIso, transaction } from "../storage/db.ts";
import { isWithin, joinDrivePath, normalizeDrivePath, parentOf, segmentsOf } from "../storage/paths.ts";
import { type TableTemplate, templateById } from "./templates.ts";
import {
  type Column,
  type ColumnType,
  checkValue,
  displayValue,
  isColumnType,
  KEY_TYPES,
  keyForm,
  MAX_SELECT_OPTIONS,
  sameValue,
  typeLabel,
  type Value,
} from "./types.ts";

export class TableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableError";
  }
}

export const MAX_ROWS = 50_000;
export const MAX_COLUMNS = 100;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface TableRecord {
  id: number;
  folder: string;
  name: string;
  /** Drive-style path, e.g. /inventory/servers. */
  path: string;
  title: string;
  description: string;
  /** Draft columns, in display order. */
  columns: Column[];
  /** Draft key column id. */
  keyColumn: string | null;
  publishedVersion: number;
  /** The draft has edits since the last publish, discard or rollback. */
  dirty: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TableSummary extends TableRecord {
  draftRows: number;
  publishedRows: number;
  publishedAt: string | null;
}

export type RowData = Record<string, Value>;

export interface DraftRow {
  id: number;
  data: RowData;
  /** Column id to message, for cells that do not validate. */
  errors: Record<string, string>;
}

export interface VersionRecord {
  version: number;
  columns: Column[];
  keyColumn: string | null;
  note: string;
  actor: string;
  createdAt: string;
  rowCount: number;
  added: number;
  changed: number;
  removed: number;
  columnChanges: string[];
  rollbackOf: number | null;
}

export interface PublishedTable {
  table: TableRecord;
  version: VersionRecord;
  rows: Array<{ id: number; data: RowData }>;
}

export interface DraftIssue {
  row: number;
  column: string;
  message: string;
}

export interface RowChange {
  row: number;
  key: string;
  columns?: string[];
}

export interface DraftDiff {
  columnChanges: string[];
  added: RowChange[];
  changed: RowChange[];
  removed: RowChange[];
  issues: DraftIssue[];
  /** There is something to publish. */
  pending: boolean;
}

export interface RowEdits {
  updates?: Array<{ row: number; values: Record<string, unknown> }>;
  adds?: Array<{ values: Record<string, unknown> }>;
  deletes?: number[];
}

interface TableDbRow {
  id: number;
  folder: string;
  name: string;
  title: string;
  description: string;
  columns: string;
  key_column: string | null;
  next_row_id: number;
  next_col_id: number;
  published_version: number;
  dirty: number;
  created_at: string;
  updated_at: string;
}

interface VersionDbRow {
  version: number;
  columns: string;
  key_column: string | null;
  note: string;
  actor: string;
  created_at: string;
  row_count: number;
  added: number;
  changed: number;
  removed: number;
  column_changes: string;
  rollback_of: number | null;
}

const toRecord = (r: TableDbRow): TableRecord => ({
  id: r.id,
  folder: r.folder,
  name: r.name,
  path: joinDrivePath(r.folder, r.name),
  title: r.title,
  description: r.description,
  columns: JSON.parse(r.columns) as Column[],
  keyColumn: r.key_column,
  publishedVersion: r.published_version,
  dirty: r.dirty === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toVersion = (r: VersionDbRow): VersionRecord => ({
  version: r.version,
  columns: JSON.parse(r.columns) as Column[],
  keyColumn: r.key_column,
  note: r.note,
  actor: r.actor,
  createdAt: r.created_at,
  rowCount: r.row_count,
  added: r.added,
  changed: r.changed,
  removed: r.removed,
  columnChanges: JSON.parse(r.column_changes) as string[],
  rollbackOf: r.rollback_of,
});

/** Validate one cell for storage: canonical when valid, else the input as text. */
function storeValue(column: Column, raw: unknown): Value {
  const checked = checkValue(column, raw);
  if (checked.ok) return checked.value;
  return raw instanceof Date ? raw.toISOString() : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
}

/** Row data restricted to `columns`, nulls dropped. */
function project(data: RowData, columns: Column[]): RowData {
  const out: RowData = {};
  for (const c of columns) {
    const v = data[c.id];
    if (v !== null && v !== undefined && v !== "" && v !== false) out[c.id] = v;
  }
  return out;
}

function sameProjected(a: RowData, b: RowData, columns: Column[]): boolean {
  return columns.every((c) => sameValue(a[c.id], b[c.id]));
}

/** What changed between two column lists, in words. */
function describeColumnChanges(before: Column[], beforeKey: string | null, after: Column[], afterKey: string | null): string[] {
  const out: string[] = [];
  const old = new Map(before.map((c) => [c.id, c]));
  const now = new Map(after.map((c) => [c.id, c]));
  for (const c of after) {
    const o = old.get(c.id);
    if (!o) {
      out.push(`added column ${c.name} (${typeLabel(c.type)})`);
      continue;
    }
    if (o.name !== c.name) out.push(`renamed column ${o.name} to ${c.name}`);
    if (o.type !== c.type) out.push(`changed ${c.name} from ${typeLabel(o.type)} to ${typeLabel(c.type)}`);
    else if (c.type === "select" && JSON.stringify(o.options ?? []) !== JSON.stringify(c.options ?? [])) out.push(`changed the options of ${c.name}`);
  }
  for (const o of before) if (!now.has(o.id)) out.push(`removed column ${o.name}`);
  const order = (cols: Column[], keep: Map<string, Column>) => cols.filter((c) => keep.has(c.id)).map((c) => c.id).join(",");
  if (order(before, now) !== order(after, old)) out.push("reordered columns");
  if (beforeKey !== afterKey) {
    const name = (id: string | null, cols: Map<string, Column>) => (id ? (cols.get(id)?.name ?? id) : "none");
    out.push(`key column ${name(beforeKey, old)} → ${name(afterKey, now)}`);
  }
  return out;
}

export class TableStore {
  readonly db: DatabaseSync;

  constructor(readonly drive: Drive) {
    this.db = drive.db;
  }

  // ---------- tables ----------

  private row(id: number): TableDbRow {
    const r = this.db.prepare("SELECT * FROM user_tables WHERE id = ?").get(id) as TableDbRow | undefined;
    if (!r) throw new NotFoundError(`table #${id}`);
    return r;
  }

  get(id: number): TableRecord {
    return toRecord(this.row(id));
  }

  find(path: string): TableRecord | undefined {
    const p = normalizeDrivePath(path);
    if (p === "/") return undefined;
    const r = this.db
      .prepare("SELECT * FROM user_tables WHERE folder = ? AND name = ?")
      .get(parentOf(p), segmentsOf(p).at(-1) ?? "") as TableDbRow | undefined;
    return r ? toRecord(r) : undefined;
  }

  list(): TableSummary[] {
    const rows = this.db
      .prepare(
        `SELECT t.*,
           (SELECT COUNT(*) FROM user_table_draft d WHERE d.table_id = t.id) AS draft_rows,
           v.row_count AS published_rows, v.created_at AS published_at
         FROM user_tables t
         LEFT JOIN user_table_versions v ON v.table_id = t.id AND v.version = t.published_version
         ORDER BY t.folder, t.name`,
      )
      .all() as unknown as Array<TableDbRow & { draft_rows: number; published_rows: number | null; published_at: string | null }>;
    return rows.map((r) => ({
      ...toRecord(r),
      draftRows: r.draft_rows,
      publishedRows: r.published_rows ?? 0,
      publishedAt: r.published_at,
    }));
  }

  /** Tables at `folder` or below it. */
  listUnder(folder: string): TableSummary[] {
    return this.list().filter((t) => isWithin(t.path, folder));
  }

  create(
    opts: { folder: string; name: string; title?: string; description?: string; template?: string | TableTemplate },
    actor = "admin",
  ): TableRecord {
    const folder = normalizeDrivePath(opts.folder || "/");
    const name = opts.name.trim().toLowerCase();
    if (!NAME.test(name)) throw new TableError("Table names use lowercase letters, digits, dots, dashes and underscores (up to 64), e.g. servers");
    if (this.drive.kind(folder) !== "folder") throw new NotFoundError(folder);
    const path = joinDrivePath(folder, name);
    if (this.drive.kind(path) !== null) throw new TableError(`${path} is already a file or folder; pick another name`);
    if (this.find(path)) throw new TableError(`A table already exists at ${path}`);
    const template = typeof opts.template === "string" ? templateById(opts.template) : opts.template;
    if (typeof opts.template === "string" && opts.template && !template) throw new TableError(`Unknown template ${opts.template}`);
    const columns: Column[] = (template?.columns ?? []).map((c, i) => ({
      id: `c${i + 1}`,
      name: c.name,
      type: c.type,
      ...(c.options ? { options: [...c.options] } : {}),
    }));
    const keyIndex = template?.columns.findIndex((c) => c.key) ?? -1;
    const now = nowIso();
    const title = (opts.title ?? "").trim().slice(0, 200) || template?.title || name;
    const result = this.db
      .prepare(
        `INSERT INTO user_tables (folder, name, title, description, columns, key_column, next_col_id, dirty, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        folder,
        name,
        title,
        (opts.description ?? template?.description ?? "").trim().slice(0, 2000),
        JSON.stringify(columns),
        keyIndex >= 0 ? `c${keyIndex + 1}` : null,
        columns.length + 1,
        now,
        now,
      );
    this.drive.logActivity(actor, "table.create", path, template ? `from template ${template.title}` : "blank");
    return this.get(Number(result.lastInsertRowid));
  }

  updateInfo(id: number, info: { title?: string; description?: string }, actor = "admin"): TableRecord {
    const t = this.get(id);
    const title = info.title === undefined ? t.title : info.title.trim().slice(0, 200) || t.name;
    const description = info.description === undefined ? t.description : info.description.trim().slice(0, 2000);
    this.db.prepare("UPDATE user_tables SET title = ?, description = ?, updated_at = ? WHERE id = ?").run(title, description, nowIso(), id);
    this.drive.logActivity(actor, "table.info", t.path, "title or description changed");
    return this.get(id);
  }

  /** Delete a table with all its versions. */
  remove(id: number, actor = "admin"): TableRecord {
    const t = this.get(id);
    transaction(this.db, () => {
      for (const sql of [
        "DELETE FROM user_table_rows WHERE table_id = ?",
        "DELETE FROM user_table_versions WHERE table_id = ?",
        "DELETE FROM user_table_draft WHERE table_id = ?",
        "DELETE FROM user_tables WHERE id = ?",
      ]) {
        this.db.prepare(sql).run(id);
      }
    });
    this.drive.logActivity(actor, "table.delete", t.path, `had ${t.publishedVersion} published version(s)`);
    return t;
  }

  /** A folder was moved: tables in or below it follow. */
  retargetFolder(from: string, to: string): void {
    for (const t of this.listUnder(from)) {
      const folder = to + t.folder.slice(from.length);
      this.db.prepare("UPDATE user_tables SET folder = ? WHERE id = ?").run(folder === "" ? "/" : folder, t.id);
    }
  }

  private touch(id: number): void {
    this.db.prepare("UPDATE user_tables SET dirty = 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
  }

  // ---------- columns (draft) ----------

  private saveColumns(id: number, columns: Column[], keyColumn: string | null): void {
    this.db.prepare("UPDATE user_tables SET columns = ?, key_column = ? WHERE id = ?").run(JSON.stringify(columns), keyColumn, id);
    this.touch(id);
  }

  private checkColumn(columns: Column[], col: { name: string; type: string; options?: string[] }, selfId?: string): Column {
    const name = col.name.trim().replace(/\s+/g, " ");
    if (!name || name.length > 64) throw new TableError("Column names are 1-64 characters");
    if (name.startsWith("_")) throw new TableError("Column names cannot start with _");
    if (columns.some((c) => c.id !== selfId && c.name.toLowerCase() === name.toLowerCase())) {
      throw new TableError(`There is already a column called ${name}`);
    }
    if (!isColumnType(col.type)) throw new TableError(`Unknown column type ${col.type}`);
    const out: Column = { id: selfId ?? "", name, type: col.type };
    if (col.type === "select") {
      const options = [...new Set((col.options ?? []).map((o) => o.trim()).filter(Boolean))];
      if (options.length > MAX_SELECT_OPTIONS) throw new TableError(`A select column has at most ${MAX_SELECT_OPTIONS} options`);
      if (options.some((o) => o.length > 100)) throw new TableError("Select options are at most 100 characters");
      out.options = options;
    }
    return out;
  }

  addColumn(id: number, col: { name: string; type: string; options?: string[] }, actor = "admin"): Column {
    const t = this.row(id);
    const columns = JSON.parse(t.columns) as Column[];
    if (columns.length >= MAX_COLUMNS) throw new TableError(`A table has at most ${MAX_COLUMNS} columns`);
    const column = { ...this.checkColumn(columns, col), id: `c${t.next_col_id}` };
    transaction(this.db, () => {
      this.db.prepare("UPDATE user_tables SET next_col_id = next_col_id + 1 WHERE id = ?").run(id);
      this.saveColumns(id, [...columns, column], t.key_column);
    });
    this.drive.logActivity(actor, "table.column", toRecord(t).path, `added ${column.name} (${column.type})`);
    return column;
  }

  /** Rename, retype or change a column's options. Existing cells are re-checked under the new type. */
  updateColumn(id: number, columnId: string, patch: { name?: string; type?: string; options?: string[] }, actor = "admin"): Column {
    const t = this.get(id);
    const current = t.columns.find((c) => c.id === columnId);
    if (!current) throw new TableError("No such column");
    const column = this.checkColumn(
      t.columns,
      { name: patch.name ?? current.name, type: patch.type ?? current.type, options: patch.options ?? current.options },
      columnId,
    );
    if (t.keyColumn === columnId && !KEY_TYPES.has(column.type)) throw new TableError(`A ${typeLabel(column.type)} column cannot be the key`);
    transaction(this.db, () => {
      this.saveColumns(
        id,
        t.columns.map((c) => (c.id === columnId ? column : c)),
        t.keyColumn,
      );
      if (column.type !== current.type || column.type === "select") this.recheckColumn(id, column);
    });
    this.drive.logActivity(actor, "table.column", t.path, `updated ${column.name}`);
    return column;
  }

  /** After a type change: store canonical values where the old text now validates. */
  private recheckColumn(id: number, column: Column): void {
    const update = this.db.prepare("UPDATE user_table_draft SET data = ? WHERE table_id = ? AND row_id = ?");
    for (const r of this.draftRaw(id)) {
      if (!(column.id in r.data)) continue;
      const before = r.data[column.id];
      const after = storeValue(column, before);
      if (after !== before) {
        r.data[column.id] = after;
        update.run(JSON.stringify(r.data), id, r.id);
      }
    }
  }

  moveColumn(id: number, columnId: string, to: number, actor = "admin"): void {
    const t = this.get(id);
    const from = t.columns.findIndex((c) => c.id === columnId);
    if (from < 0) throw new TableError("No such column");
    const columns = [...t.columns];
    const [col] = columns.splice(from, 1);
    columns.splice(Math.max(0, Math.min(columns.length, to)), 0, col);
    this.saveColumns(id, columns, t.keyColumn);
    this.drive.logActivity(actor, "table.column", t.path, `moved ${col.name}`);
  }

  deleteColumn(id: number, columnId: string, actor = "admin"): void {
    const t = this.get(id);
    const col = t.columns.find((c) => c.id === columnId);
    if (!col) throw new TableError("No such column");
    transaction(this.db, () => {
      this.saveColumns(
        id,
        t.columns.filter((c) => c.id !== columnId),
        t.keyColumn === columnId ? null : t.keyColumn,
      );
      this.db
        .prepare("UPDATE user_table_draft SET data = json_remove(data, '$.' || ?) WHERE table_id = ?")
        .run(columnId, id);
    });
    this.drive.logActivity(actor, "table.column", t.path, `deleted ${col.name}`);
  }

  setKey(id: number, columnId: string | null, actor = "admin"): void {
    const t = this.get(id);
    if (columnId !== null) {
      const col = t.columns.find((c) => c.id === columnId);
      if (!col) throw new TableError("No such column");
      if (!KEY_TYPES.has(col.type)) throw new TableError(`A ${typeLabel(col.type)} column cannot be the key`);
    }
    this.saveColumns(id, t.columns, columnId);
    this.drive.logActivity(actor, "table.column", t.path, `key column ${columnId ?? "none"}`);
  }

  // ---------- rows (draft) ----------

  private draftRaw(id: number): Array<{ id: number; data: RowData }> {
    return (
      this.db.prepare("SELECT row_id, data FROM user_table_draft WHERE table_id = ? ORDER BY row_id").all(id) as Array<{
        row_id: number;
        data: string;
      }>
    ).map((r) => ({ id: r.row_id, data: JSON.parse(r.data) as RowData }));
  }

  private withErrors(columns: Column[], row: { id: number; data: RowData }): DraftRow {
    const errors: Record<string, string> = {};
    for (const c of columns) {
      const v = row.data[c.id];
      if (v === undefined || v === null) continue;
      const checked = checkValue(c, v);
      if (!checked.ok) errors[c.id] = checked.error;
    }
    return { id: row.id, data: row.data, errors };
  }

  draftRows(id: number, onlyIds?: number[]): DraftRow[] {
    const t = this.get(id);
    const wanted = onlyIds ? new Set(onlyIds) : undefined;
    return this.draftRaw(id)
      .filter((r) => !wanted || wanted.has(r.id))
      .map((r) => this.withErrors(t.columns, r));
  }

  draftRowCount(id: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM user_table_draft WHERE table_id = ?").get(id) as { n: number }).n;
  }

  /** Apply grid edits. Unknown column ids are refused; values are validated but kept even when invalid. */
  edit(id: number, edits: RowEdits, actor = "admin"): { rows: DraftRow[]; added: number[]; deleted: number[] } {
    const t = this.get(id);
    const byId = new Map(t.columns.map((c) => [c.id, c]));
    const clean = (values: Record<string, unknown>): Array<[Column, unknown]> =>
      Object.entries(values).map(([k, v]) => {
        const col = byId.get(k);
        if (!col) throw new TableError(`Unknown column ${k}; reload the page`);
        return [col, v];
      });
    const updates = edits.updates ?? [];
    const adds = edits.adds ?? [];
    const deletes = edits.deletes ?? [];
    const touched = new Set<number>();
    const added: number[] = [];
    const deleted: number[] = [];
    transaction(this.db, () => {
      const now = nowIso();
      const get = this.db.prepare("SELECT data FROM user_table_draft WHERE table_id = ? AND row_id = ?");
      const put = this.db.prepare("UPDATE user_table_draft SET data = ?, updated_at = ? WHERE table_id = ? AND row_id = ?");
      for (const u of updates) {
        const cur = get.get(id, u.row) as { data: string } | undefined;
        if (!cur) throw new TableError(`Row ${u.row} no longer exists; reload the page`);
        const data = JSON.parse(cur.data) as RowData;
        for (const [col, raw] of clean(u.values)) {
          const v = storeValue(col, raw);
          if (v === null || v === false) delete data[col.id];
          else data[col.id] = v;
        }
        put.run(JSON.stringify(data), now, id, u.row);
        touched.add(u.row);
      }
      if (adds.length) {
        if (this.draftRowCount(id) + adds.length > MAX_ROWS) throw new TableError(`A table has at most ${MAX_ROWS.toLocaleString("en-US")} rows`);
        const next = (this.db.prepare("SELECT next_row_id AS n FROM user_tables WHERE id = ?").get(id) as { n: number }).n;
        const insert = this.db.prepare("INSERT INTO user_table_draft (table_id, row_id, data, updated_at) VALUES (?, ?, ?, ?)");
        adds.forEach((a, i) => {
          const data: RowData = {};
          for (const [col, raw] of clean(a.values)) {
            const v = storeValue(col, raw);
            if (v !== null && v !== false) data[col.id] = v;
          }
          insert.run(id, next + i, JSON.stringify(data), now);
          added.push(next + i);
          touched.add(next + i);
        });
        this.db.prepare("UPDATE user_tables SET next_row_id = ? WHERE id = ?").run(next + adds.length, id);
      }
      const del = this.db.prepare("DELETE FROM user_table_draft WHERE table_id = ? AND row_id = ?");
      for (const rowId of deletes) {
        if (Number(del.run(id, rowId).changes) > 0) deleted.push(rowId);
        touched.delete(rowId);
      }
      this.touch(id);
    });
    const parts = [added.length && `+${added.length}`, updates.length && `~${updates.length}`, deleted.length && `-${deleted.length}`].filter(Boolean);
    this.drive.logActivity(actor, "table.edit", t.path, `draft rows ${parts.join(" ") || "unchanged"}`);
    return { rows: this.draftRows(id, [...touched]), added, deleted };
  }

  /**
   * Add or update draft rows from imported records (column id to raw value).
   * With a key column mapped, a record whose key matches a draft row updates
   * that row (only the mapped cells); otherwise it is added.
   */
  upsert(id: number, records: Array<Record<string, unknown>>, actor = "admin"): { added: number; updated: number; invalidRows: number[] } {
    const t = this.get(id);
    const keyCol = t.columns.find((c) => c.id === t.keyColumn);
    const index = new Map<string, number>();
    if (keyCol) {
      for (const r of this.draftRaw(id)) {
        const k = keyForm(keyCol.type, storeValue(keyCol, r.data[keyCol.id] ?? null));
        if (k !== null && !index.has(k)) index.set(k, r.id);
      }
    }
    const updates: RowEdits["updates"] = [];
    const adds: RowEdits["adds"] = [];
    for (const rec of records) {
      const k = keyCol && keyCol.id in rec ? keyForm(keyCol.type, storeValue(keyCol, rec[keyCol.id] ?? null)) : null;
      const existing = k === null ? undefined : index.get(k);
      if (existing !== undefined) updates.push({ row: existing, values: rec });
      else adds.push({ values: rec });
    }
    const result = this.edit(id, { updates, adds }, actor);
    return {
      added: result.added.length,
      updated: updates.length,
      invalidRows: result.rows.filter((r) => Object.keys(r.errors).length > 0).map((r) => r.id),
    };
  }

  // ---------- diff, publish, rollback ----------

  /** Problems that block publishing: invalid cells, and an empty or duplicate key. */
  issues(id: number): DraftIssue[] {
    const t = this.get(id);
    const out: DraftIssue[] = [];
    const keyCol = t.columns.find((c) => c.id === t.keyColumn);
    const seen = new Map<string, number>();
    for (const r of this.draftRows(id)) {
      for (const [col, message] of Object.entries(r.errors)) out.push({ row: r.id, column: col, message });
      if (keyCol && !r.errors[keyCol.id]) {
        const k = keyForm(keyCol.type, r.data[keyCol.id] ?? null);
        if (k === null) out.push({ row: r.id, column: keyCol.id, message: `the key column ${keyCol.name} is empty` });
        else if (seen.has(k)) out.push({ row: r.id, column: keyCol.id, message: `duplicate key; row ${seen.get(k)} has the same ${keyCol.name}` });
        else seen.set(k, r.id);
      }
    }
    return out;
  }

  private keyText(columns: Column[], keyColumn: string | null, row: { id: number; data: RowData }): string {
    const col = columns.find((c) => c.id === keyColumn) ?? columns[0];
    const v = col ? displayValue(row.data[col.id]) : "";
    return v || `row ${row.id}`;
  }

  private currentRows(id: number): Map<number, { id: number; data: RowData; vFrom: number }> {
    const rows = this.db
      .prepare("SELECT row_id, data, v_from FROM user_table_rows WHERE table_id = ? AND v_to IS NULL ORDER BY row_id")
      .all(id) as Array<{ row_id: number; data: string; v_from: number }>;
    return new Map(rows.map((r) => [r.row_id, { id: r.row_id, data: JSON.parse(r.data) as RowData, vFrom: r.v_from }]));
  }

  /** Draft vs latest published: what Publish would do. */
  diff(id: number): DraftDiff {
    const t = this.get(id);
    const published = t.publishedVersion ? this.version(id, t.publishedVersion) : undefined;
    const columnChanges = published ? describeColumnChanges(published.columns, published.keyColumn, t.columns, t.keyColumn) : [];
    const current = this.currentRows(id);
    const draft = this.draftRows(id);
    const added: RowChange[] = [];
    const changed: RowChange[] = [];
    const draftIds = new Set<number>();
    for (const r of draft) {
      draftIds.add(r.id);
      const before = current.get(r.id);
      const key = this.keyText(t.columns, t.keyColumn, r);
      if (!before) {
        added.push({ row: r.id, key });
        continue;
      }
      const cols = t.columns.filter((c) => !sameValue(before.data[c.id], r.data[c.id] ?? null)).map((c) => c.name);
      if (cols.length) changed.push({ row: r.id, key, columns: cols });
    }
    const removed: RowChange[] = [];
    const pubCols = published?.columns ?? t.columns;
    for (const r of current.values()) {
      if (!draftIds.has(r.id)) removed.push({ row: r.id, key: this.keyText(pubCols, published?.keyColumn ?? null, r) });
    }
    const pending = !published || columnChanges.length > 0 || added.length + changed.length + removed.length > 0;
    return { columnChanges, added, changed, removed, issues: this.issues(id), pending };
  }

  /** Publish the draft as the next version. Refused while any cell is invalid. */
  publish(id: number, note: string, actor = "admin"): VersionRecord {
    const t = this.get(id);
    const text = note.trim().slice(0, 500);
    if (!text) throw new TableError("Add a short note describing this version");
    if (t.columns.length === 0) throw new TableError("Add at least one column before publishing");
    const d = this.diff(id);
    if (d.issues.length) {
      throw new TableError(`Fix ${d.issues.length} problem(s) before publishing (invalid cells are outlined in red)`);
    }
    if (!d.pending) throw new TableError("Nothing to publish: the draft matches the latest version");
    const version = t.publishedVersion + 1;
    const draft = this.draftRaw(id).map((r) => ({ id: r.id, data: project(r.data, t.columns) }));
    transaction(this.db, () => {
      this.writeVersion(t, version, t.columns, t.keyColumn, draft, {
        note: text,
        actor,
        added: d.added.length,
        changed: d.changed.length,
        removed: d.removed.length,
        columnChanges: d.columnChanges,
        rollbackOf: null,
      });
    });
    this.drive.logActivity(
      actor,
      "table.publish",
      t.path,
      `v${version}: +${d.added.length} ~${d.changed.length} -${d.removed.length}, ${draft.length} row(s): ${text}`,
    );
    return this.version(id, version);
  }

  /**
   * Store `rows` as version `version`: close records that changed or went
   * away, insert new contents, keep unchanged records. Also resets the draft
   * to exactly these rows and columns.
   */
  private writeVersion(
    t: TableRecord,
    version: number,
    columns: Column[],
    keyColumn: string | null,
    rows: Array<{ id: number; data: RowData }>,
    meta: Omit<VersionRecord, "version" | "columns" | "keyColumn" | "createdAt" | "rowCount">,
  ): void {
    const current = this.currentRows(t.id);
    const close = this.db.prepare("UPDATE user_table_rows SET v_to = ? WHERE table_id = ? AND row_id = ? AND v_to IS NULL");
    const insert = this.db.prepare("INSERT INTO user_table_rows (table_id, row_id, v_from, v_to, data) VALUES (?, ?, ?, NULL, ?)");
    const keep = new Set<number>();
    for (const r of rows) {
      keep.add(r.id);
      const before = current.get(r.id);
      if (before && sameProjected(before.data, r.data, columns)) continue;
      if (before) close.run(version, t.id, r.id);
      insert.run(t.id, r.id, version, JSON.stringify(r.data));
    }
    for (const r of current.values()) if (!keep.has(r.id)) close.run(version, t.id, r.id);
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO user_table_versions (table_id, version, columns, key_column, note, actor, created_at, row_count, added, changed, removed, column_changes, rollback_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        version,
        JSON.stringify(columns),
        keyColumn,
        meta.note,
        meta.actor,
        now,
        rows.length,
        meta.added,
        meta.changed,
        meta.removed,
        JSON.stringify(meta.columnChanges),
        meta.rollbackOf,
      );
    // The draft becomes exactly the published content (canonical values).
    this.db.prepare("DELETE FROM user_table_draft WHERE table_id = ?").run(t.id);
    const put = this.db.prepare("INSERT INTO user_table_draft (table_id, row_id, data, updated_at) VALUES (?, ?, ?, ?)");
    for (const r of rows) put.run(t.id, r.id, JSON.stringify(project(r.data, columns)), now);
    this.db
      .prepare("UPDATE user_tables SET published_version = ?, columns = ?, key_column = ?, dirty = 0, updated_at = ? WHERE id = ?")
      .run(version, JSON.stringify(columns), keyColumn, now, t.id);
  }

  /** Publish an old version's contents again as a new version (history is kept), and reset the draft to it. */
  rollback(id: number, to: number, actor = "admin"): VersionRecord {
    const t = this.get(id);
    if (!t.publishedVersion) throw new TableError("Nothing has been published yet");
    if (to === t.publishedVersion) throw new TableError(`v${to} is already the latest version`);
    const target = this.published(id, to);
    const current = this.published(id);
    const now = new Map(current.rows.map((r) => [r.id, r]));
    let added = 0;
    let changed = 0;
    for (const r of target.rows) {
      const before = now.get(r.id);
      if (!before) added++;
      else if (!sameProjected(before.data, r.data, target.version.columns)) changed++;
      now.delete(r.id);
    }
    const version = t.publishedVersion + 1;
    transaction(this.db, () => {
      this.writeVersion(t, version, target.version.columns, target.version.keyColumn, target.rows, {
        note: `Rollback to v${to}`,
        actor,
        added,
        changed,
        removed: now.size,
        columnChanges: describeColumnChanges(current.version.columns, current.version.keyColumn, target.version.columns, target.version.keyColumn),
        rollbackOf: to,
      });
    });
    this.drive.logActivity(actor, "table.rollback", t.path, `v${version} = v${to}: +${added} ~${changed} -${now.size}`);
    return this.version(id, version);
  }

  /** Throw the draft away: back to the latest published version. */
  discard(id: number, actor = "admin"): void {
    const t = this.get(id);
    if (!t.publishedVersion) throw new TableError("Nothing has been published yet; delete the table instead");
    const pub = this.published(id);
    transaction(this.db, () => {
      const now = nowIso();
      this.db.prepare("DELETE FROM user_table_draft WHERE table_id = ?").run(id);
      const put = this.db.prepare("INSERT INTO user_table_draft (table_id, row_id, data, updated_at) VALUES (?, ?, ?, ?)");
      for (const r of pub.rows) put.run(id, r.id, JSON.stringify(project(r.data, pub.version.columns)), now);
      this.db
        .prepare("UPDATE user_tables SET columns = ?, key_column = ?, dirty = 0, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(pub.version.columns), pub.version.keyColumn, now, id);
    });
    this.drive.logActivity(actor, "table.discard", t.path, `draft reset to v${t.publishedVersion}`);
  }

  // ---------- published reads ----------

  versions(id: number): VersionRecord[] {
    return (
      this.db.prepare("SELECT * FROM user_table_versions WHERE table_id = ? ORDER BY version DESC").all(id) as unknown as VersionDbRow[]
    ).map(toVersion);
  }

  version(id: number, version: number): VersionRecord {
    const r = this.db.prepare("SELECT * FROM user_table_versions WHERE table_id = ? AND version = ?").get(id, version) as
      | VersionDbRow
      | undefined;
    if (!r) throw new NotFoundError(`${this.get(id).path}@v${version}`);
    return toVersion(r);
  }

  /** A published version (default: the latest), rows projected onto that version's columns. */
  published(id: number, version?: number): PublishedTable {
    const table = this.get(id);
    const v = version ?? table.publishedVersion;
    if (!v) throw new NotFoundError(table.path);
    const meta = this.version(id, v);
    const rows = (
      this.db
        .prepare("SELECT row_id, data FROM user_table_rows WHERE table_id = ? AND v_from <= ? AND (v_to IS NULL OR v_to > ?) ORDER BY row_id")
        .all(id, v, v) as Array<{ row_id: number; data: string }>
    ).map((r) => ({ id: r.row_id, data: project(JSON.parse(r.data) as RowData, meta.columns) }));
    return { table, version: meta, rows };
  }

  /** Every published content of one row, oldest first, plus the draft. */
  rowHistory(id: number, rowId: number) {
    const t = this.get(id);
    const versions = new Map(this.versions(id).map((v) => [v.version, v]));
    const records = (
      this.db
        .prepare("SELECT v_from, v_to, data FROM user_table_rows WHERE table_id = ? AND row_id = ? ORDER BY v_from")
        .all(id, rowId) as Array<{ v_from: number; v_to: number | null; data: string }>
    ).map((r) => {
      const meta = versions.get(r.v_from);
      const columns = meta?.columns ?? t.columns;
      return {
        from: r.v_from,
        to: r.v_to,
        note: meta?.note ?? "",
        at: meta?.createdAt ?? "",
        actor: meta?.actor ?? "",
        columns,
        data: project(JSON.parse(r.data) as RowData, columns),
      };
    });
    const draft = this.draftRows(id, [rowId])[0];
    if (!draft && records.length === 0) throw new NotFoundError(`${t.path}#r${rowId}`);
    return { table: t, row: rowId, records, draft };
  }
}

/** The column a type-name string or column name refers to (case-insensitive name, or id). */
export function findColumn(columns: Column[], ref: string): Column | undefined {
  const s = ref.trim().toLowerCase();
  return columns.find((c) => c.name.toLowerCase() === s) ?? columns.find((c) => c.id === ref.trim());
}

export type { Column, ColumnType, Value };
