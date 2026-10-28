/**
 * CSV / TSV / XLSX import into a table's draft: parse, preview with suggested
 * column types, then apply a mapping. Nothing is published; the import lands
 * in the draft and the admin publishes it like any other edit.
 */
import readXlsxFile from "read-excel-file/node";
import { parseCsv } from "../extract/text.ts";
import { MAX_COLUMNS, MAX_ROWS, type TableStore, TableError } from "./store.ts";
import { type Column, type ColumnType, checkValue, displayValue, isColumnType, KEY_TYPES, MAX_SELECT_OPTIONS } from "./types.ts";

export type Cell = string | number | boolean | Date | null;

export interface Sheet {
  name: string;
  header: string[];
  rows: Cell[][];
}

const isXlsx = (bytes: Uint8Array) => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
const empty = (c: Cell | undefined) => c === null || c === undefined || (typeof c === "string" && c.trim() === "");

/** Comma, semicolon or tab: whichever splits the first lines most consistently. */
export function sniffDelimiter(text: string): string {
  const lines = text.replace(/^\ufeff/, "").split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  let best = ",";
  let bestScore = 0;
  for (const d of ["\t", ",", ";"]) {
    const counts = lines.map((l) => l.split(d).length - 1);
    if (!counts.length || counts[0] === 0) continue;
    const consistent = counts.filter((n) => n === counts[0]).length;
    const score = consistent * 100 + counts[0];
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** Rows to a sheet: the first non-empty row is the header; blank rows are dropped. */
export function toSheet(name: string, raw: Cell[][]): Sheet {
  const rows = raw.filter((r) => r.some((c) => !empty(c)));
  if (rows.length === 0) throw new TableError(`${name} is empty`);
  const width = Math.max(...rows.map((r) => r.length));
  if (width > MAX_COLUMNS) throw new TableError(`${name} has ${width} columns; the limit is ${MAX_COLUMNS}`);
  if (rows.length - 1 > MAX_ROWS) throw new TableError(`${name} has ${rows.length - 1} rows; the limit is ${MAX_ROWS}`);
  const seen = new Map<string, number>();
  const header = Array.from({ length: width }, (_, i) => {
    let h = displayCell(rows[0][i]).replace(/\s+/g, " ").trim().slice(0, 64) || `Column ${i + 1}`;
    if (h.startsWith("_")) h = h.replace(/^_+/, "") || `Column ${i + 1}`;
    const n = (seen.get(h.toLowerCase()) ?? 0) + 1;
    seen.set(h.toLowerCase(), n);
    return n > 1 ? `${h} ${n}` : h;
  });
  return { name, header, rows: rows.slice(1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null)) };
}

const displayCell = (c: Cell | undefined) => (c instanceof Date ? c.toISOString().slice(0, 10) : displayValue(c ?? null));

export async function parseUpload(fileName: string, bytes: Uint8Array): Promise<Sheet[]> {
  if (isXlsx(bytes)) {
    let sheets: Array<{ sheet: string; data: Cell[][] }>;
    try {
      sheets = (await readXlsxFile(Buffer.from(bytes))) as unknown as Array<{ sheet: string; data: Cell[][] }>;
    } catch (error) {
      throw new TableError(`Cannot read the .xlsx file: ${error instanceof Error ? error.message : error}`);
    }
    const out = sheets.filter((s) => s.data.some((r) => r.some((c) => !empty(c)))).map((s) => toSheet(s.sheet, s.data));
    if (out.length === 0) throw new TableError("The workbook has no data");
    return out;
  }
  if (/\.(xlsx|xlsm)$/i.test(fileName)) throw new TableError("Not a valid .xlsx file");
  if (/\.xls$/i.test(fileName)) throw new TableError("Old .xls workbooks are not supported; save as .xlsx or CSV");
  const text = new TextDecoder("utf-8").decode(bytes);
  if (text.includes("\u0000")) throw new TableError("That does not look like a CSV or text file");
  return [toSheet(fileName || "pasted rows", parseCsv(text, sniffDelimiter(text)))];
}

// ---------- type suggestions ----------

const HINTS: Array<[RegExp, ColumnType]> = [
  [/^(host ?name|hostname|fqdn|server( name)?|host|computer( name)?|device( name)?)$/i, "hostname"],
  [/^(ip|ip ?address|ipv4|ipv6|ipv4 address|ipv6 address|address)$/i, "ip"],
  [/(cidr|subnet|network|prefix|range)/i, "cidr"],
  [/\bmac\b|mac ?address/i, "mac"],
  [/\bcve\b/i, "cve"],
  [/control/i, "control"],
  [/e-?mail/i, "email"],
  [/\b(url|link|website|homepage)\b/i, "url"],
  [/(date|created|updated|expires?|expiry|due|_at$|\bon$)/i, "date"],
  [/^(notes?|description|comments?|details)$/i, "longtext"],
  [/(vlan|count|qty|quantity|port|number|^#|\bnum\b|size|cores|ram|cpu)/i, "number"],
];

const allValid = (type: ColumnType, values: Cell[], options?: string[]) => values.every((v) => checkValue({ type, options }, v).ok);
/** A header that names the type only needs most values to fit; the rest are reported as invalid cells. */
const mostlyValid = (type: ColumnType, values: Cell[]) => values.filter((v) => checkValue({ type }, v).ok).length * 2 > values.length;

export interface Suggestion {
  type: ColumnType;
  options?: string[];
}

export function suggestType(header: string, column: Cell[]): Suggestion {
  const values = column.filter((v) => !empty(v));
  if (values.length === 0) return { type: "text" };
  for (const [re, type] of HINTS) {
    if (re.test(header) && mostlyValid(type, values)) return { type };
  }
  const strings = values.map((v) => displayCell(v));
  if (allValid("cve", values)) return { type: "cve" };
  if (allValid("mac", values)) return { type: "mac" };
  if (strings.every((s) => s.includes("/")) && allValid("cidr", values)) return { type: "cidr" };
  if (allValid("ip", values)) return { type: "ip" };
  if (allValid("email", values)) return { type: "email" };
  if (allValid("url", values)) return { type: "url" };
  if (values.every((v) => v instanceof Date || typeof v === "string") && allValid("date", values)) return { type: "date" };
  if (allValid("number", values)) return { type: "number" };
  if (values.every((v) => typeof v === "boolean" || (typeof v === "string" && /^(yes|no|true|false|y|n|x)$/i.test(v.trim())))) {
    return { type: "checkbox" };
  }
  if (strings.every((s) => /[-.]/.test(s)) && allValid("control", values)) return { type: "control" };
  if (strings.every((s) => s.includes(".")) && allValid("hostname", values)) return { type: "hostname" };
  if (strings.some((s) => s.length > 200 || s.includes("\n"))) return { type: "longtext" };
  const distinct = [...new Map(strings.map((s) => [s.toLowerCase(), s.trim()])).values()];
  if (distinct.length >= 2 && distinct.length <= 12 && values.length >= distinct.length * 2 && distinct.every((s) => s.length <= 40)) {
    return { type: "select", options: distinct };
  }
  return { type: "text" };
}

// ---------- preview and apply ----------

export interface PreviewColumn {
  index: number;
  header: string;
  suggested: Suggestion;
  /** Existing column with the same name (case-insensitive), when importing into a table. */
  existing?: string;
  sample: string[];
}

export function preview(sheet: Sheet, table?: { columns: Column[] }): PreviewColumn[] {
  return sheet.header.map((header, index) => {
    const values = sheet.rows.map((r) => r[index]);
    return {
      index,
      header,
      suggested: suggestType(header, values),
      existing: table?.columns.find((c) => c.name.toLowerCase() === header.toLowerCase())?.id,
      sample: values
        .filter((v) => !empty(v))
        .slice(0, 3)
        .map((v) => displayCell(v).slice(0, 60)),
    };
  });
}

/** Per source column: skip it, add it as a new column, or fill an existing column. */
export type Mapping = { action: "skip" } | { action: "new"; name: string; type: ColumnType; options?: string[] } | { action: "existing"; column: string };

export interface ImportResult {
  added: number;
  updated: number;
  /** Row ids (in the draft) that have invalid cells. */
  invalidRows: number[];
  /** Spreadsheet line numbers (1 = header) of rows with invalid cells, with the first problem. */
  problems: Array<{ line: number; column: string; message: string }>;
  newColumns: string[];
}

/**
 * Apply `mappings` (one per source column) to the table's draft. `key` is the
 * source column index to use as the table's key (new tables), or undefined to
 * keep the table's key. Rows that match an existing key update that row.
 */
export function applyImport(store: TableStore, tableId: number, sheet: Sheet, mappings: Mapping[], key: number | undefined, actor = "admin"): ImportResult {
  if (mappings.length !== sheet.header.length) throw new TableError("The mapping does not match the file; start the import again");
  const table = store.get(tableId);
  if (mappings.every((m) => m.action === "skip")) throw new TableError("Map at least one column");
  const target: Array<string | null> = [];
  const newColumns: string[] = [];
  const used = new Set<string>();
  // Check everything before changing anything.
  for (const m of mappings) {
    if (m.action === "existing") {
      if (!table.columns.some((c) => c.id === m.column)) throw new TableError("A mapped column no longer exists; start the import again");
      if (used.has(m.column)) throw new TableError("Two file columns are mapped to the same table column");
      used.add(m.column);
    }
    if (m.action === "new" && !isColumnType(m.type)) throw new TableError(`Unknown column type ${m.type}`);
  }
  if (table.columns.length + mappings.filter((m) => m.action === "new").length > MAX_COLUMNS) {
    throw new TableError(`A table has at most ${MAX_COLUMNS} columns`);
  }
  for (const m of mappings) {
    if (m.action === "skip") target.push(null);
    else if (m.action === "existing") target.push(m.column);
    else {
      const options = m.type === "select" ? (m.options ?? []).slice(0, MAX_SELECT_OPTIONS) : undefined;
      const col = store.addColumn(tableId, { name: m.name, type: m.type, options }, actor);
      target.push(col.id);
      newColumns.push(col.name);
    }
  }
  if (key !== undefined) {
    const col = target[key];
    if (!col) throw new TableError("The key column must be imported");
    const c = store.get(tableId).columns.find((x) => x.id === col);
    if (c && !KEY_TYPES.has(c.type)) throw new TableError(`A ${c.type} column cannot be the key`);
    if (col !== store.get(tableId).keyColumn) store.setKey(tableId, col, actor);
  }
  const records = sheet.rows.map((r) => {
    const rec: Record<string, unknown> = {};
    r.forEach((cell, i) => {
      const col = target[i];
      if (col && !empty(cell)) rec[col] = cell;
    });
    return rec;
  });
  const columns = store.get(tableId).columns;
  const problems: ImportResult["problems"] = [];
  records.forEach((rec, i) => {
    for (const [colId, raw] of Object.entries(rec)) {
      const col = columns.find((c) => c.id === colId);
      const checked = col ? checkValue(col, raw) : { ok: true as const };
      if (col && !checked.ok) {
        problems.push({ line: i + 2, column: col.name, message: checked.error });
        break;
      }
    }
  });
  const res = store.upsert(tableId, records.filter((r) => Object.keys(r).length > 0), actor);
  return { ...res, problems, newColumns };
}
