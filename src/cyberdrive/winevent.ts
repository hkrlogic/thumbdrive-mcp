/**
 * Windows Security Audit Events catalog (dataset "winevent").
 *
 * Source: Microsoft's WindowsSecurityAuditEvents.xlsx (2016). Sheet "Security
 * Audit Events" has one row per event and audit subcategory (an event can sit
 * under several subcategories, e.g. 4663 under SAM and Kernel); sheet
 * "Complete Event Messages" has one row per event version with the full
 * message template. Both are stored as-is, keyed by event ID.
 */
import readXlsxFile from "read-excel-file/node";
import type { DatabaseSync } from "node:sqlite";
import { type DatasetKind, DatasetError, type DatasetStore, type ParsedDataset } from "./datasets.ts";

export const WINEVENT_SOURCE_URL =
  "https://download.microsoft.com/download/8/e/1/8e11ad26-98a1-4ee3-9f7f-1db4eb18badf/WindowsSecurityAuditEvents.xlsx";
export const WINEVENT_MAX_BATCH = 50;

const EVENTS_SHEET = "Security Audit Events";
const MESSAGES_SHEET = "Complete Event Messages";
const EVENT_COLUMNS = {
  category: "category",
  subcategory: "subcategory",
  event_id: "event id",
  summary: "message summary",
  min_os: "minimum operating system requirement",
} as const;
const MESSAGE_COLUMNS = {
  event_id: "event id",
  version: "version",
  message: "detailed message",
  min_os: "minimum operating system requirement",
} as const;

const CATALOG_NOTE =
  "The catalog is Microsoft's 2016 list of Windows security audit events; it does not cover newer events (some Windows 10/11 additions) or other logs such as Sysmon.";

type Cell = string | number | boolean | Date | null | undefined;

const norm = (s: Cell) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const text = (s: Cell): string | null => {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/\r\n?/g, "\n").trimEnd().replace(/^\s+/, "");
  return t === "" ? null : t;
};
/**
 * Microsoft's messages indent every line after the first by the same run of
 * spaces (an artifact of the source document); strip that common indent.
 */
const dedent = (t: string): string => {
  const rest = t.split("\n").slice(1).filter((l) => l.trim() !== "");
  const indent = Math.min(...rest.map((l) => /^ */.exec(l)?.[0].length ?? 0));
  if (!rest.length || indent === 0) return t;
  return t
    .split("\n")
    .map((l, i) => (i === 0 ? l : l.slice(Math.min(indent, /^ */.exec(l)?.[0].length ?? 0))))
    .join("\n");
};
/** An event ID (cell number or numeric string) in Windows' 16-bit range, or null. */
const eventId = (s: Cell): number | null => {
  const t = typeof s === "number" ? String(s) : String(s ?? "").trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : null;
};

/** Map each wanted column to its index in the header row, or throw naming the missing ones. */
function columns<K extends string>(sheet: string, header: Cell[], wanted: Record<K, string>): Record<K, number> {
  const have = header.map(norm);
  const out = {} as Record<K, number>;
  const missing: string[] = [];
  for (const [key, title] of Object.entries(wanted) as Array<[K, string]>) {
    const i = have.indexOf(title);
    if (i < 0) missing.push(title);
    else out[key] = i;
  }
  if (missing.length) throw new DatasetError(`Sheet "${sheet}" is missing column(s): ${missing.join(", ")}`);
  return out;
}

interface EventRow {
  event_id: number;
  category: string;
  subcategory: string;
  summary: string;
  min_os: string | null;
  position: number;
}
interface MessageRow {
  event_id: number;
  version: number;
  message: string;
  min_os: string | null;
}

async function parseWorkbook(bytes: Uint8Array): Promise<ParsedDataset> {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new DatasetError("Not an .xlsx file (expected a ZIP-based Excel workbook)");
  }
  let sheets: Array<{ sheet: string; data: Cell[][] }>;
  try {
    sheets = (await readXlsxFile(Buffer.from(bytes))) as unknown as Array<{ sheet: string; data: Cell[][] }>;
  } catch (error) {
    throw new DatasetError(`Cannot read the .xlsx file: ${error instanceof Error ? error.message : error}`);
  }
  const find = (title: string) => {
    const s = sheets.find((x) => norm(x.sheet) === norm(title));
    if (!s) {
      throw new DatasetError(`The workbook has no sheet "${title}" (sheets: ${sheets.map((x) => x.sheet).join(", ") || "none"})`);
    }
    return s.data;
  };
  const evData = find(EVENTS_SHEET);
  const msgData = find(MESSAGES_SHEET);
  const ec = columns(EVENTS_SHEET, evData[0] ?? [], EVENT_COLUMNS);
  const mc = columns(MESSAGES_SHEET, msgData[0] ?? [], MESSAGE_COLUMNS);

  let skipped = 0;
  const events = new Map<string, EventRow>();
  evData.slice(1).forEach((r, i) => {
    const id = eventId(r[ec.event_id]);
    const summary = text(r[ec.summary]);
    if (id === null || !summary) {
      if (r.some((c) => text(c))) skipped++;
      return;
    }
    const category = text(r[ec.category]) ?? "";
    const subcategory = text(r[ec.subcategory]) ?? "";
    const key = `${id}\0${category}\0${subcategory}`;
    if (events.has(key)) skipped++;
    else events.set(key, { event_id: id, category, subcategory, summary, min_os: text(r[ec.min_os]), position: i });
  });
  const messages = new Map<string, MessageRow>();
  for (const r of msgData.slice(1)) {
    const id = eventId(r[mc.event_id]);
    const v = r[mc.version];
    const version = v === null || v === undefined || v === "" ? 0 : Number(v);
    const raw = text(r[mc.message]);
    const message = raw && dedent(raw);
    if (id === null || !Number.isInteger(version) || version < 0 || !message) {
      if (r.some((c) => text(c))) skipped++;
      continue;
    }
    const key = `${id}\0${version}`;
    if (messages.has(key)) skipped++;
    messages.set(key, { event_id: id, version, message, min_os: text(r[mc.min_os]) });
  }
  const ids = new Set([...[...events.values()].map((e) => e.event_id), ...[...messages.values()].map((m) => m.event_id)]);
  return {
    rows: ids.size,
    skipped,
    write(db) {
      db.exec("DELETE FROM winevent_events; DELETE FROM winevent_messages;");
      const ins = db.prepare(
        "INSERT INTO winevent_events (event_id, category, subcategory, summary, min_os, position) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const e of events.values()) ins.run(e.event_id, e.category, e.subcategory, e.summary, e.min_os, e.position);
      const insM = db.prepare("INSERT INTO winevent_messages (event_id, version, message, min_os) VALUES (?, ?, ?, ?)");
      for (const m of messages.values()) insM.run(m.event_id, m.version, m.message, m.min_os);
    },
  };
}

export const wineventDataset: DatasetKind = {
  name: "winevent",
  title: "Windows security events",
  unit: "events",
  defaultUrl: WINEVENT_SOURCE_URL,
  fileHint: `WindowsSecurityAuditEvents.xlsx from Microsoft (sheets "${EVENTS_SHEET}" and "${MESSAGES_SHEET}")`,
  parse: (_file, bytes) => parseWorkbook(bytes),
};

export interface WinEventVersion {
  version: number;
  min_os: string | null;
  message: string;
}

export interface WinEventResult {
  input: string;
  event_id?: number;
  result: "match" | "No match" | "invalid";
  category?: string | null;
  subcategory?: string | null;
  summary?: string | null;
  min_os?: string | null;
  /** Other audit subcategories the catalog lists the same event under. */
  also_listed_under?: Array<{ category: string; subcategory: string }>;
  versions?: WinEventVersion[];
  citation?: string;
  note?: string;
  error?: string;
}

export interface WinEventHit {
  event_id: number;
  category: string | null;
  subcategory: string | null;
  summary: string | null;
  min_os: string | null;
  versions: number;
  citation: string;
}

type EvRow = { event_id: number; category: string; subcategory: string; summary: string; min_os: string | null };

export class WinEventLookup {
  constructor(private readonly store: DatasetStore) {}

  private get db(): DatabaseSync {
    return this.store.db;
  }

  version(): number {
    const cur = this.store.current("winevent");
    if (!cur) {
      throw new DatasetError(
        "The Windows security events catalog has not been imported yet. Ask the drive admin to import it (web UI: Windows security events, or the CLI: cyberdrive winevent import).",
      );
    }
    return cur.version;
  }

  private rows(id: number): EvRow[] {
    return this.db
      .prepare("SELECT event_id, category, subcategory, summary, min_os FROM winevent_events WHERE event_id = ? ORDER BY position")
      .all(id) as unknown as EvRow[];
  }

  private versions(id: number): WinEventVersion[] {
    return this.db
      .prepare("SELECT version, min_os, message FROM winevent_messages WHERE event_id = ? ORDER BY version")
      .all(id) as unknown as WinEventVersion[];
  }

  lookupOne(input: string | number, version: number): WinEventResult {
    const raw = String(input).trim();
    const id = eventId(raw.replace(/^(?:event\s*id|eventid|id)\s*[:#]?\s*/i, ""));
    if (id === null) return { input: raw, result: "invalid", error: "Not an event ID. Use a number such as 4624." };
    const rows = this.rows(id);
    const versions = this.versions(id);
    if (rows.length === 0 && versions.length === 0) {
      return {
        input: raw,
        event_id: id,
        result: "No match",
        note: `No match: event ${id} is not in this catalog. ${CATALOG_NOTE} It may also belong to another log (System, Application).`,
      };
    }
    const [first, ...rest] = rows;
    const out: WinEventResult = {
      input: raw,
      event_id: id,
      result: "match",
      category: first?.category || null,
      subcategory: first?.subcategory || null,
      summary: first?.summary ?? versions[0]?.message.split("\n")[0] ?? null,
      min_os: first?.min_os ?? versions[0]?.min_os ?? null,
      ...(rest.length ? { also_listed_under: rest.map((r) => ({ category: r.category, subcategory: r.subcategory })) } : {}),
      versions,
      citation: `cyberdrive:winevent@v${version}#${id}`,
    };
    if (!first) out.note = "Listed only in the detailed messages sheet: the catalog gives no category or subcategory for it.";
    else if (versions.length === 0) out.note = "The catalog has a summary but no detailed message for this event.";
    return out;
  }

  lookup(ids: Array<string | number>) {
    if (ids.length === 0) throw new DatasetError("Give at least one event ID");
    if (ids.length > WINEVENT_MAX_BATCH) throw new DatasetError(`At most ${WINEVENT_MAX_BATCH} event IDs per call`);
    const version = this.version();
    return { dataset: "winevent", version, results: ids.map((id) => this.lookupOne(id, version)), note: CATALOG_NOTE };
  }

  categories(): string[] {
    return (
      this.db.prepare("SELECT DISTINCT category FROM winevent_events WHERE category <> '' ORDER BY category").all() as Array<{
        category: string;
      }>
    ).map((r) => r.category);
  }

  /** Case-insensitive text search over summaries, subcategories and detailed messages, optionally within one category. */
  search(query: string | undefined, opts: { category?: string; limit?: number } = {}) {
    const q = (query ?? "").trim();
    const category = opts.category?.trim();
    if (!q && !category) throw new DatasetError("Give a search text or a category");
    if (q && q.length < 2) throw new DatasetError("Give at least 2 characters to search for");
    const version = this.version();
    let cat: string | undefined;
    if (category) {
      const all = this.categories();
      cat = all.find((c) => c.toLowerCase() === category.toLowerCase());
      if (!cat) throw new DatasetError(`Unknown category "${category}". Categories: ${all.join(", ")}`);
    }
    const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    const matchSql = q
      ? `(event_id IN (SELECT event_id FROM winevent_events WHERE summary LIKE ? ESCAPE '\\' OR subcategory LIKE ? ESCAPE '\\')
          OR event_id IN (SELECT event_id FROM winevent_messages WHERE message LIKE ? ESCAPE '\\')
          OR CAST(event_id AS TEXT) = ?)`
      : "1";
    const catSql = cat ? "event_id IN (SELECT event_id FROM winevent_events WHERE category = ?)" : "1";
    const params = [...(q ? [like, like, like, q] : []), ...(cat ? [cat] : [])];
    const idsSql = `SELECT event_id FROM (SELECT event_id FROM winevent_events UNION SELECT event_id FROM winevent_messages) WHERE ${matchSql} AND ${catSql}`;
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM (${idsSql})`).get(...params) as { n: number }).n);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const ids = (this.db.prepare(`${idsSql} ORDER BY event_id LIMIT ?`).all(...params, limit) as Array<{ event_id: number }>).map(
      (r) => r.event_id,
    );
    const results: WinEventHit[] = ids.map((id) => {
      const rows = this.rows(id);
      const r = (cat ? rows.find((x) => x.category === cat) : undefined) ?? rows[0];
      const versions = this.versions(id);
      return {
        event_id: id,
        category: r?.category || null,
        subcategory: r?.subcategory || null,
        summary: r?.summary ?? versions[0]?.message.split("\n")[0] ?? null,
        min_os: r?.min_os ?? versions[0]?.min_os ?? null,
        versions: versions.length,
        citation: `cyberdrive:winevent@v${version}#${id}`,
      };
    });
    return { dataset: "winevent", version, total, results, note: CATALOG_NOTE };
  }
}
