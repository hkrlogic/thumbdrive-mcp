/**
 * CyberDrive datasets: reference data (e.g. the OUI registry) imported into
 * Thumbdrive's own SQLite and served to agents through read-only lookup tools.
 *
 * Each dataset kind parses and validates a source file, then replaces its
 * tables in one transaction. Every import gets the next version number and a
 * row in dataset_imports (source, SHA-256, rows, who, when); the highest
 * version is current, older rows are kept as history. Datasets are never
 * committed to the repo: the admin imports them from a file or the source URL.
 */
import { createHash, randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso, transaction } from "../storage/db.ts";
import type { Drive } from "../storage/drive.ts";

/** Every dataset a key can be granted. */
export const DATASET_NAMES = ["oui", "winevent", "nist80053", "csf2", "csf2map"] as const;
export type DatasetName = (typeof DATASET_NAMES)[number];

export function isDatasetName(name: string): name is DatasetName {
  return (DATASET_NAMES as readonly string[]).includes(name);
}

/** A problem with an import or a lookup that is safe to show to the admin or agent. */
export class DatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetError";
  }
}

/** The result of parsing a source file: counts, and a writer that replaces the dataset's tables. */
export interface ParsedDataset {
  rows: number;
  skipped: number;
  /** Called inside the import transaction. */
  write: (db: DatabaseSync) => void;
}

export interface DatasetKind {
  name: DatasetName;
  title: string;
  /** What `rows` counts, for messages ("rows", "events"). */
  unit: string;
  /** Where "Refresh from source" downloads from. */
  defaultUrl: string;
  /** What the admin uploads, for the UI and errors. */
  fileHint: string;
  /** Optional provenance or license note shown on the dataset page. */
  about?: string;
  /** Validate and parse a source file saved at `file` (bytes are the same content). Throws DatasetError. */
  parse: (file: string, bytes: Uint8Array) => ParsedDataset | Promise<ParsedDataset>;
}

export interface DatasetImport {
  dataset: string;
  version: number;
  rows: number;
  skipped: number;
  source: string;
  sha256: string;
  actor: string;
  imported_at: string;
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

/** Download `url` into memory, refusing anything over `maxBytes`. */
export async function download(url: string, maxBytes: number, timeoutMs = 120_000): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new DatasetError(`Download failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok || !res.body) throw new DatasetError(`Download failed: HTTP ${res.status} from ${url}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new DatasetError(`Download is ${declared} bytes; the limit is ${maxBytes} (DATASET_MAX_MB)`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw new DatasetError(`Download exceeds the ${maxBytes}-byte limit (DATASET_MAX_MB)`);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export class DatasetStore {
  readonly kinds: Map<DatasetName, DatasetKind>;

  constructor(
    readonly drive: Drive,
    kinds: DatasetKind[],
    readonly maxBytes = 100 * 1024 * 1024,
  ) {
    this.kinds = new Map(kinds.map((k) => [k.name, k]));
  }

  get db(): DatabaseSync {
    return this.drive.db;
  }

  kind(name: string): DatasetKind {
    const kind = isDatasetName(name) ? this.kinds.get(name) : undefined;
    if (!kind) throw new DatasetError(`Unknown dataset "${name}"`);
    return kind;
  }

  /** The current import, or undefined if the dataset was never imported. */
  current(name: string): DatasetImport | undefined {
    return this.db
      .prepare(
        "SELECT dataset, version, rows, skipped, source, sha256, actor, imported_at FROM dataset_imports WHERE dataset = ? ORDER BY version DESC LIMIT 1",
      )
      .get(name) as DatasetImport | undefined;
  }

  /** All imports, newest first. */
  history(name: string, limit = 50): DatasetImport[] {
    return this.db
      .prepare(
        "SELECT dataset, version, rows, skipped, source, sha256, actor, imported_at FROM dataset_imports WHERE dataset = ? ORDER BY version DESC LIMIT ?",
      )
      .all(name, limit) as unknown as DatasetImport[];
  }

  /** Validate and import `bytes` as the next version of `name`. The old data stays until the new data commits. */
  async importBytes(name: string, bytes: Uint8Array, source: string, actor = "admin"): Promise<DatasetImport> {
    const kind = this.kind(name);
    if (bytes.length === 0) throw new DatasetError("The file is empty");
    if (bytes.length > this.maxBytes) throw new DatasetError(`The file is larger than the ${this.maxBytes}-byte limit (DATASET_MAX_MB)`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const tmp = path.join(this.drive.tmpDir, `dataset-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
    writeFileSync(tmp, bytes);
    let parsed: ParsedDataset;
    try {
      parsed = await kind.parse(tmp, bytes);
    } finally {
      rmSync(tmp, { force: true });
    }
    if (parsed.rows === 0) throw new DatasetError(`No usable rows in the file; expected ${kind.fileHint}`);
    const record = transaction(this.db, () => {
      parsed.write(this.db);
      const prev = this.db.prepare("SELECT MAX(version) AS v FROM dataset_imports WHERE dataset = ?").get(name) as { v: number | null };
      const version = Number(prev.v ?? 0) + 1;
      const row: DatasetImport = {
        dataset: name,
        version,
        rows: parsed.rows,
        skipped: parsed.skipped,
        source,
        sha256,
        actor,
        imported_at: nowIso(),
      };
      this.db
        .prepare(
          "INSERT INTO dataset_imports (dataset, version, rows, skipped, source, sha256, actor, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(row.dataset, row.version, row.rows, row.skipped, row.source, row.sha256, row.actor, row.imported_at);
      return row;
    });
    this.drive.logActivity(
      actor,
      "dataset.import",
      null,
      `${name} v${record.version}: ${record.rows} rows${record.skipped ? `, ${record.skipped} skipped` : ""}, sha256 ${sha256}, from ${source}`,
    );
    return record;
  }

  /** Import from a local path or an http(s) URL; no argument means the dataset's default source URL. */
  async importFrom(name: string, pathOrUrl?: string, actor = "admin"): Promise<DatasetImport> {
    const source = pathOrUrl || this.kind(name).defaultUrl;
    const bytes = isUrl(source) ? await download(source, this.maxBytes) : new Uint8Array(await readFile(source));
    return this.importBytes(name, bytes, isUrl(source) ? source : `file:${path.basename(source)}`, actor);
  }

  /**
   * Opt-in monthly refresh (CYBERDRIVE_AUTO_REFRESH=1): every few hours, any
   * dataset whose current import is older than `maxAgeDays` is downloaded
   * again from its default URL. Datasets never imported are left alone, so
   * nothing is downloaded until the admin has imported once.
   */
  startAutoRefresh(maxAgeDays = 30, checkEveryMs = 6 * 60 * 60 * 1000): () => void {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        for (const name of this.kinds.keys()) {
          const cur = this.current(name);
          if (!cur || Date.now() - Date.parse(cur.imported_at) < maxAgeDays * 86_400_000) continue;
          try {
            const row = await this.importFrom(name, undefined, "auto-refresh");
            console.log(`[thumbdrive] cyberdrive: refreshed ${name} to v${row.version} (${row.rows} rows)`);
          } catch (error) {
            console.error(`[thumbdrive] cyberdrive: refreshing ${name} failed:`, error instanceof Error ? error.message : error);
            this.drive.logActivity("auto-refresh", "dataset.error", null, `${name}: ${error instanceof Error ? error.message : error}`);
          }
        }
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void tick(), checkEveryMs);
    timer.unref();
    void tick();
    return () => clearInterval(timer);
  }
}

/** Open a source file as SQLite read-only and check it has `table` with `columns`. Throws DatasetError. */
export function requireSqliteTable(
  file: string,
  bytes: Uint8Array,
  table: string,
  columns: string[],
): DatabaseSync {
  const magic = Buffer.from("SQLite format 3\0", "latin1");
  if (bytes.length < 100 || !Buffer.from(bytes.subarray(0, 16)).equals(magic)) {
    throw new DatasetError("Not a SQLite database file");
  }
  let src: DatabaseSync;
  try {
    src = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    throw new DatasetError(`Cannot open the SQLite file: ${error instanceof Error ? error.message : error}`);
  }
  try {
    const cols = src.prepare("SELECT name FROM pragma_table_info(?)").all(table) as unknown as Array<{ name: string }>;
    if (cols.length === 0) throw new DatasetError(`The SQLite file has no table "${table}"`);
    const have = new Set(cols.map((c) => c.name));
    const missing = columns.filter((c) => !have.has(c));
    if (missing.length) throw new DatasetError(`Table "${table}" is missing column(s): ${missing.join(", ")}`);
    return src;
  } catch (error) {
    src.close();
    if (error instanceof DatasetError) throw error;
    throw new DatasetError(`Cannot read the SQLite file: ${error instanceof Error ? error.message : error}`);
  }
}
