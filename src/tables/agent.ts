/**
 * The agent side of tables: read-only tools over the latest published
 * version of every table the key can see. A table is visible when its path
 * (folder/name) is inside one of the key's folders; dataset grants do not add
 * tables, but they do enrich lookups (MAC vendor via oui, control titles via
 * nist80053/csf2). Drafts are never visible. Every call is logged.
 *
 * Queries are built from a fixed operator list with bound parameters; column
 * references resolve to server-generated column ids, never to agent text.
 */
import { UsageError } from "../agent/reader.ts";
import type { FolderScope } from "../auth/scope.ts";
import type { DatasetReader } from "../cyberdrive/agent.ts";
import { NotFoundError } from "../storage/drive.ts";
import { isWithin, normalizeDrivePath } from "../storage/paths.ts";
import { findColumn, type PublishedTable, type RowData, type TableRecord, type TableStore } from "./store.ts";
import { type Column, checkValue, cidrContains, keyForm, parseCidr, parseIp, type Value } from "./types.ts";

export const LOOKUP_MAX_BATCH = 50;
export const QUERY_MAX_LIMIT = 200;
export const QUERY_OPS = ["eq", "neq", "contains", "starts_with", "gt", "lt", "in", "is_empty"] as const;
export type QueryOp = (typeof QUERY_OPS)[number];

export interface QueryFilter {
  column: string;
  op: QueryOp;
  value?: unknown;
}

const clip = (s: string, n = 900) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const TEXTUAL = new Set(["text", "longtext", "select", "url", "email", "hostname", "ip", "cidr", "mac", "cve", "control", "date"]);

export const tableCitation = (path: string, version: number, row?: number) =>
  `cyberdrive:${path}@v${version}${row === undefined ? "" : `#r${row}`}`;

/** "/inventory/servers", "inventory/servers" or "cyberdrive:/inventory/servers@v3#r12" to a path. */
export function parseTableRef(ref: string): string {
  let s = ref.trim();
  if (s.startsWith("cyberdrive:")) s = s.slice("cyberdrive:".length);
  s = s.replace(/#r\d+$/, "").replace(/@v\d+$/, "");
  return normalizeDrivePath(s.startsWith("/") ? s : `/${s}`);
}

export class TableReader {
  constructor(
    private readonly store: TableStore,
    private readonly scope: FolderScope,
    private readonly actor: string,
    private readonly datasets?: DatasetReader,
  ) {}

  private log(action: string, path: string, detail: string): void {
    this.store.drive.logActivity(this.actor, action, path, clip(detail));
  }

  private logged<T>(action: string, path: () => string, fn: () => T, describe: (out: T) => string, input: string): T {
    let out: T;
    try {
      out = fn();
    } catch (error) {
      this.log(action, path(), `${input}: failed: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
    this.log(action, path(), describe(out));
    return out;
  }

  private visible(): TableRecord[] {
    return this.store.list().filter((t) => t.publishedVersion > 0 && this.scope.canSee(t.path));
  }

  /** The table, or the same Not found as a folder the key cannot see. */
  private open(ref: string): PublishedTable {
    const path = parseTableRef(ref);
    const t = this.store.find(path);
    if (!t?.publishedVersion || !this.scope.canSee(t.path)) throw new NotFoundError(`table ${path}`);
    return this.store.published(t.id);
  }

  private shape(p: PublishedTable, row: { id: number; data: RowData }, only?: Column[]) {
    const values: Record<string, Value> = {};
    for (const c of only ?? p.version.columns) {
      values[c.name] = row.data[c.id] ?? (c.type === "checkbox" ? false : null);
    }
    return { row: row.id, citation: tableCitation(p.table.path, p.version.version, row.id), values };
  }

  private header(p: PublishedTable) {
    return {
      table: p.table.path,
      title: p.table.title,
      version: p.version.version,
      published_at: p.version.createdAt,
      citation: tableCitation(p.table.path, p.version.version),
    };
  }

  listTables(path = "/") {
    const root = normalizeDrivePath(path);
    return this.logged(
      "list_tables",
      () => `cyberdrive:${root}`,
      () => {
        const tables = this.visible()
          .filter((t) => isWithin(t.path, root))
          .map((t) => {
            const v = this.store.version(t.id, t.publishedVersion);
            return {
              table: t.path,
              title: t.title,
              description: t.description,
              version: v.version,
              rows: v.rowCount,
              key: v.columns.find((c) => c.id === v.keyColumn)?.name ?? null,
              columns: v.columns.map((c) => c.name),
              published_at: v.createdAt,
              citation: tableCitation(t.path, v.version),
            };
          });
        return { tables, ...(tables.length ? {} : { result: "No match", note: "No published tables you can see under this path." }) };
      },
      (out) => `${out.tables.length} table(s)`,
      root,
    );
  }

  describeTable(ref: string) {
    let path = parseTableRef(ref);
    return this.logged(
      "describe_table",
      () => `cyberdrive:${path}`,
      () => {
        const p = this.open(ref);
        path = `${p.table.path}@v${p.version.version}`;
        return {
          ...this.header(p),
          description: p.table.description,
          note: p.version.note,
          row_count: p.version.rowCount,
          key: p.version.columns.find((c) => c.id === p.version.keyColumn)?.name ?? null,
          columns: p.version.columns.map((c) => ({
            name: c.name,
            type: c.type,
            ...(c.options ? { options: c.options } : {}),
            ...(c.id === p.version.keyColumn ? { key: true } : {}),
          })),
          operators: QUERY_OPS,
        };
      },
      (out) => `v${out.version} ${out.row_count} row(s)`,
      ref,
    );
  }

  lookupRow(ref: string, inputs: string[]) {
    let path = parseTableRef(ref);
    return this.logged(
      "lookup_row",
      () => `cyberdrive:${path}`,
      () => {
        const p = this.open(ref);
        path = `${p.table.path}@v${p.version.version}`;
        const key = p.version.columns.find((c) => c.id === p.version.keyColumn);
        if (!key) throw new UsageError(`${p.table.path} has no key column; use query_table`);
        const rows = p.rows.filter((r) => r.data[key.id] !== undefined);
        const index = new Map<string, (typeof rows)[number]>();
        for (const r of rows) {
          const k = keyForm(key.type, r.data[key.id] ?? null);
          if (k !== null) index.set(k, r);
        }
        const results = inputs.map((input) => this.lookupOne(p, key, rows, index, input));
        const enrichment = this.enrich(p, results);
        return { ...this.header(p), key: key.name, results, ...(enrichment ? { enriched_with: enrichment } : {}) };
      },
      (out) =>
        `v${out.version} ${out.results.length} value(s): ` +
        out.results.map((r) => `${r.input}=${"row" in r && r.row ? `r${r.row.row}` : r.result}`).join(", ") +
        (out.enriched_with ? ` (+${out.enriched_with.join("+")})` : ""),
      `${inputs.length} value(s)`,
    );
  }

  private lookupOne(
    p: PublishedTable,
    key: Column,
    rows: Array<{ id: number; data: RowData }>,
    index: Map<string, { id: number; data: RowData }>,
    input: string,
  ) {
    const hit = (row: { id: number; data: RowData }, matchedBy: string) => ({
      input,
      result: "match" as const,
      matched_by: matchedBy,
      row: this.shape(p, row),
    });
    const none = { input, result: "No match" as const };
    if (key.type === "cidr") {
      const ip = parseIp(input.trim());
      const asCidr = ip ? undefined : parseCidr(input.trim());
      if (!ip && (!asCidr || "error" in asCidr)) {
        return { input, result: "invalid" as const, error: asCidr && "error" in asCidr ? asCidr.error : "not an IP address or CIDR range" };
      }
      if (asCidr && !("error" in asCidr)) {
        const exact = index.get(asCidr.canonical);
        if (exact) return hit(exact, "exact");
      }
      const target = ip ?? (asCidr && !("error" in asCidr) ? { version: asCidr.version, n: asCidr.network, prefix: asCidr.prefix } : undefined);
      if (!target) return none;
      const minPrefix = "prefix" in target ? target.prefix : -1;
      let best: { row: { id: number; data: RowData }; prefix: number } | undefined;
      for (const r of rows) {
        const range = parseCidr(String(r.data[key.id]));
        if ("error" in range || range.prefix < 0) continue;
        if (minPrefix >= 0 && range.prefix > minPrefix) continue;
        if (cidrContains(range, target) && (!best || range.prefix > best.prefix)) best = { row: r, prefix: range.prefix };
      }
      return best ? hit(best.row, "containing range (longest prefix)") : none;
    }
    const checked = checkValue(key, input);
    if (!checked.ok) return { input, result: "invalid" as const, error: checked.error };
    const k = keyForm(key.type, checked.value);
    const exact = k === null ? undefined : index.get(k);
    if (exact) return hit(exact, "exact");
    if (key.type === "hostname" && typeof checked.value === "string") {
      const short = checked.value.split(".")[0];
      const candidates = rows.filter((r) => {
        const h = String(r.data[key.id]).toLowerCase();
        return h === short || h.split(".")[0] === short;
      });
      if (candidates.length === 1) return hit(candidates[0], "short hostname");
      if (candidates.length > 1) {
        return {
          input,
          result: "ambiguous" as const,
          note: `${candidates.length} rows share the short name ${short}; ask with the full hostname`,
          candidates: candidates.slice(0, 10).map((r) => this.shape(p, r)),
        };
      }
    }
    return none;
  }

  /** Add OUI vendors / control titles to matched rows when the key holds those datasets. */
  private enrich(p: PublishedTable, results: Array<{ result: string; row?: ReturnType<TableReader["shape"]> } & Record<string, unknown>>) {
    if (!this.datasets) return undefined;
    const used = new Set<string>();
    for (const type of ["mac", "control"] as const) {
      const cols = p.version.columns.filter((c) => c.type === type);
      if (!cols.length) continue;
      const values = results.flatMap((r) => (r.row ? cols.map((c) => r.row?.values[c.name]).filter((v): v is string => typeof v === "string") : []));
      const found = this.datasets.enrich(type, values);
      if (!found.size) continue;
      for (const r of results) {
        if (!r.row) continue;
        const holder = r as Record<string, unknown>;
        const ctx = (holder.context as Record<string, unknown> | undefined) ?? {};
        for (const c of cols) {
          const v = r.row.values[c.name];
          const e = typeof v === "string" ? found.get(v) : undefined;
          if (e) {
            ctx[c.name] = { [type === "mac" ? "vendor" : "title"]: e.label, ...(e.citation ? { citation: e.citation } : {}) };
            used.add(e.dataset);
          }
        }
        if (Object.keys(ctx).length) holder.context = ctx;
      }
    }
    return used.size ? [...used] : undefined;
  }

  queryTable(
    ref: string,
    opts: { filters?: QueryFilter[]; columns?: string[]; sort?: { column: string; direction?: "asc" | "desc" }; limit?: number; offset?: number },
  ) {
    let path = parseTableRef(ref);
    const filters = opts.filters ?? [];
    return this.logged(
      "query_table",
      () => `cyberdrive:${path}`,
      () => {
        const p = this.open(ref);
        path = `${p.table.path}@v${p.version.version}`;
        const cols = p.version.columns;
        const col = (name: string) => {
          const c = findColumn(cols, name);
          if (!c) throw new UsageError(`No column ${name} in ${p.table.path}; columns: ${cols.map((x) => x.name).join(", ")}`);
          return c;
        };
        const where: string[] = ["table_id = ?", "v_to IS NULL"];
        const params: Array<string | number | null> = [p.table.id];
        for (const f of filters) {
          const c = col(f.column);
          const [sql, args] = condition(c, f);
          where.push(sql);
          params.push(...args);
        }
        let order = "row_id";
        const orderParams: string[] = [];
        if (opts.sort) {
          const c = col(opts.sort.column);
          order = `${TEXTUAL.has(c.type) ? "lower(json_extract(data, ?))" : "json_extract(data, ?)"} ${opts.sort.direction === "desc" ? "DESC" : "ASC"} NULLS LAST, row_id`;
          orderParams.push(`$.${c.id}`);
        }
        const limit = Math.min(Math.max(1, opts.limit ?? 50), QUERY_MAX_LIMIT);
        const offset = Math.max(0, opts.offset ?? 0);
        const db = this.store.db;
        const total = (db.prepare(`SELECT COUNT(*) AS n FROM user_table_rows WHERE ${where.join(" AND ")}`).get(...params) as { n: number }).n;
        const rows = (
          db
            .prepare(`SELECT row_id, data FROM user_table_rows WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`)
            .all(...params, ...orderParams, limit, offset) as Array<{ row_id: number; data: string }>
        ).map((r) => ({ id: r.row_id, data: JSON.parse(r.data) as RowData }));
        const only = opts.columns?.length ? opts.columns.map(col) : undefined;
        const nextOffset = offset + rows.length < total ? offset + rows.length : null;
        return {
          ...this.header(p),
          total,
          offset,
          next_offset: nextOffset,
          rows: rows.map((r) => this.shape(p, r, only)),
          ...(total === 0 ? { result: "No match" } : {}),
        };
      },
      (out) => `v${out.version} ${filters.map((f) => `${f.column} ${f.op}`).join(", ") || "all"}: ${out.total} row(s)`,
      `${filters.length} filter(s)`,
    );
  }
}

/** One filter as SQL over json_extract with bound values. */
function condition(c: Column, f: QueryFilter): [string, Array<string | number | null>] {
  const x = "json_extract(data, ?)";
  const p = `$.${c.id}`;
  const textual = TEXTUAL.has(c.type);
  const normalize = (raw: unknown): string | number => {
    if (c.type === "cidr" && typeof raw === "string") {
      const r = parseCidr(raw.trim());
      if (!("error" in r)) return r.canonical;
    }
    const checked = checkValue(c, raw);
    if (!checked.ok) throw new UsageError(`${f.op} on ${c.name}: ${checked.error}`);
    const v = checked.value;
    if (v === null) throw new UsageError(`${f.op} on ${c.name} needs a value (use is_empty for empty cells)`);
    if (typeof v === "boolean") return v ? 1 : 0;
    return typeof v === "string" ? v.toLowerCase() : v;
  };
  switch (f.op) {
    case "eq":
    case "neq": {
      const v = normalize(f.value);
      if (c.type === "checkbox") return [v === 1 ? `IFNULL(${x}, 0) ${f.op === "eq" ? "=" : "<>"} 1` : `IFNULL(${x}, 0) ${f.op === "eq" ? "=" : "<>"} 0`, [p]];
      const lhs = textual ? `lower(${x})` : x;
      return f.op === "eq" ? [`${lhs} = ?`, [p, v]] : [`(${x} IS NULL OR ${lhs} <> ?)`, [p, p, v]];
    }
    case "contains":
    case "starts_with": {
      if (!textual) throw new UsageError(`${f.op} works on text-like columns; ${c.name} is ${c.type}`);
      if (typeof f.value !== "string" || !f.value) throw new UsageError(`${f.op} on ${c.name} needs a text value`);
      const v = f.value.toLowerCase().slice(0, 200);
      if (f.op === "contains") return [`instr(lower(${x}), ?) > 0`, [p, v]];
      return [`substr(lower(${x}), 1, ?) = ?`, [p, v.length, v]];
    }
    case "gt":
    case "lt": {
      if (c.type !== "number" && c.type !== "date") throw new UsageError(`${f.op} works on number and date columns; ${c.name} is ${c.type}`);
      return [`${x} ${f.op === "gt" ? ">" : "<"} ?`, [p, normalize(f.value)]];
    }
    case "in": {
      if (!Array.isArray(f.value) || f.value.length === 0 || f.value.length > 100) throw new UsageError(`in on ${c.name} needs a list of 1-100 values`);
      const values = f.value.map(normalize);
      if (c.type === "checkbox") throw new UsageError("use eq for checkbox columns");
      const lhs = textual ? `lower(${x})` : x;
      return [`${lhs} IN (SELECT value FROM json_each(?))`, [p, JSON.stringify(values)]];
    }
    case "is_empty": {
      const empty = f.value === undefined || f.value === null || f.value === true || f.value === "true";
      const sql = c.type === "checkbox" ? `IFNULL(${x}, 0) = 0` : `(${x} IS NULL OR ${x} = '')`;
      return [empty ? sql : `NOT ${sql}`, c.type === "checkbox" ? [p] : [p, p]];
    }
    default:
      throw new UsageError(`Unknown operator ${String(f.op)}; use one of ${QUERY_OPS.join(", ")}`);
  }
}
