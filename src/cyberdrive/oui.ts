/**
 * OUI (MAC vendor prefix) dataset and lookups.
 *
 * Source: Ringmast4r/OUI-Master-Database LISTS/master_oui.db, a SQLite file
 * with table oui_registry. Its `oui` column is uppercase, colon-separated, at
 * the block's real length: MA-L and CID "00:00:0C" (6 nibbles), MA-M
 * "8C:1F:64:A" (7), MA-S and IAB "8C:1F:64:AF:A" (9). We store the bare hex
 * prefix plus its length in nibbles, so a lookup is one indexed query for the
 * 9-, 7- and 6-nibble prefixes of the address, longest first.
 */
import type { DatabaseSync } from "node:sqlite";
import { type DatasetKind, DatasetError, type DatasetStore, type ParsedDataset, requireSqliteTable } from "./datasets.ts";

export const OUI_SOURCE_URL = "https://raw.githubusercontent.com/Ringmast4r/OUI-Master-Database/master/LISTS/master_oui.db";
export const OUI_MAX_BATCH = 50;

const SOURCE_COLUMNS = [
  "oui",
  "manufacturer",
  "registry",
  "short_name",
  "device_type",
  "registered_date",
  "address",
  "sources",
  "status",
  "deregistered_date",
] as const;
const FIELDS = SOURCE_COLUMNS.slice(1);

/** "00:00:0C", "8C:1F:64:A" or "8C:1F:64:AF:A". */
const SOURCE_OUI = /^[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}(?::[0-9A-F]|:[0-9A-F]{2}:[0-9A-F])?$/;
/** Prefix lengths we match, longest first: MA-S/IAB, MA-M, MA-L/CID. */
const PREFIX_NIBBLES = [9, 7, 6] as const;

export const ouiDataset: DatasetKind = {
  name: "oui",
  title: "OUI database",
  defaultUrl: OUI_SOURCE_URL,
  fileHint: "master_oui.db (SQLite with table oui_registry) from Ringmast4r/OUI-Master-Database",
  parse(file, bytes): ParsedDataset {
    const src = requireSqliteTable(file, bytes, "oui_registry", [...SOURCE_COLUMNS]);
    const entries = new Map<string, Record<string, string | number | null>>();
    let skipped = 0;
    try {
      const rows = src.prepare(`SELECT ${SOURCE_COLUMNS.join(", ")} FROM oui_registry`).iterate() as Iterable<
        Record<string, unknown>
      >;
      for (const row of rows) {
        const oui = typeof row.oui === "string" ? row.oui.trim().toUpperCase() : "";
        const manufacturer = typeof row.manufacturer === "string" ? row.manufacturer.trim() : "";
        if (!SOURCE_OUI.test(oui) || !manufacturer) {
          skipped++;
          continue;
        }
        const prefix = oui.replaceAll(":", "");
        if (entries.has(prefix)) skipped++;
        const entry: Record<string, string | number | null> = { prefix, nibbles: prefix.length, oui, manufacturer };
        for (const f of FIELDS.slice(1)) {
          const v = row[f];
          entry[f] = v === null || v === undefined || v === "" ? null : String(v);
        }
        entries.set(prefix, entry);
      }
    } catch (error) {
      throw new DatasetError(`Cannot read oui_registry: ${error instanceof Error ? error.message : error}`);
    } finally {
      src.close();
    }
    return {
      rows: entries.size,
      skipped,
      write(db) {
        db.exec("DELETE FROM oui_entries");
        const cols = ["prefix", "nibbles", "oui", ...FIELDS];
        const insert = db.prepare(`INSERT INTO oui_entries (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
        for (const e of entries.values()) insert.run(...cols.map((c) => e[c] ?? null));
      },
    };
  },
};

// ---------- MAC normalization ----------

export interface NormalizedMac {
  /** Uppercase hex, 6 to 12 nibbles. */
  hex: string;
  /** Canonical colon form, e.g. "00:1A:2B:3C:4D:5E" or "00:1A:2B" for a prefix. */
  display: string;
}

const HEX = /^[0-9A-Fa-f]+$/;

/**
 * Accepts 00:1A:2B:3C:4D:5E, 00-1a-2b-3c-4d-5e, 001a.2b3c.4d5e, 001A2B3C4D5E,
 * 0:1a:2b:3c:4d:5e (single-digit octets, as macOS prints them), and prefixes
 * of 6 to 12 hex digits in the same styles (001A2B, 00:1A:2B, 8C:1F:64:A).
 * Returns undefined for anything else.
 */
export function normalizeMac(input: string): NormalizedMac | undefined {
  const s = input.trim();
  if (!s || s.length > 40) return undefined;
  const seps = new Set(s.match(/[:.\- ]/g) ?? []);
  if (seps.size > 1) return undefined;
  let hex: string;
  if (seps.size === 0) {
    hex = s;
  } else {
    const groups = s.split([...seps][0]);
    if (groups.some((g) => !g || !HEX.test(g))) return undefined;
    if (groups.every((g) => g.length <= 2) && groups.length >= 3) {
      // Octets; the last group of a prefix may be a single nibble ("8C:1F:64:A").
      hex = groups.map((g, i) => (g.length === 1 && i < groups.length - 1 ? "0" + g : g)).join("");
      if (groups.length === 6) hex = groups.map((g) => g.padStart(2, "0")).join("");
    } else if (groups.every((g) => g.length === 4) && groups.length === 3) {
      hex = groups.join(""); // Cisco 001a.2b3c.4d5e or 001a-2b3c-4d5e
    } else {
      return undefined;
    }
  }
  if (!HEX.test(hex) || hex.length < 6 || hex.length > 12) return undefined;
  hex = hex.toUpperCase();
  return { hex, display: hex.match(/.{1,2}/g)!.join(":") };
}

// ---------- lookups ----------

export interface OuiEntry {
  matched_prefix: string;
  prefix_nibbles: number;
  manufacturer: string;
  registry: string | null;
  short_name: string | null;
  device_type: string | null;
  registered_date: string | null;
  address: string | null;
  status: string | null;
  deregistered_date: string | null;
  sources: string | null;
  citation: string;
}

export interface MacResult {
  input: string;
  normalized?: string;
  /** "match", "No match", "locally administered", "broadcast" or "invalid". */
  result: "match" | "No match" | "locally administered" | "broadcast" | "invalid";
  match?: OuiEntry | null;
  locally_administered?: boolean;
  multicast?: boolean;
  /** For locally administered addresses: a registry entry for this prefix, if any (e.g. an IEEE CID or a VM vendor). */
  registered_block?: OuiEntry;
  note?: string;
  error?: string;
}

const WELL_KNOWN_GROUPS: Array<[string, string]> = [
  ["01005E", "IPv4 multicast (IANA, RFC 1112)."],
  ["3333", "IPv6 multicast (RFC 2464)."],
  ["0180C2", "IEEE 802.1 link-local group address (STP, LLDP, LACP, PAUSE...)."],
];

type Row = Omit<OuiEntry, "matched_prefix" | "prefix_nibbles" | "citation"> & { oui: string; nibbles: number };

export class OuiLookup {
  constructor(private readonly store: DatasetStore) {}

  private get db(): DatabaseSync {
    return this.store.db;
  }

  /** The current version, or a clear error when the admin has not imported the dataset yet. */
  version(): number {
    const cur = this.store.current("oui");
    if (!cur) {
      throw new DatasetError(
        "The OUI database has not been imported yet. Ask the drive admin to import it (web UI: OUI database, or the CLI: cyberdrive oui import).",
      );
    }
    return cur.version;
  }

  private entry(row: Row, version: number): OuiEntry {
    return {
      matched_prefix: row.oui,
      prefix_nibbles: row.nibbles,
      manufacturer: row.manufacturer,
      registry: row.registry,
      short_name: row.short_name,
      device_type: row.device_type,
      registered_date: row.registered_date,
      address: row.address,
      status: row.status,
      deregistered_date: row.deregistered_date,
      sources: row.sources,
      citation: `cyberdrive:oui@v${version}#${row.oui}`,
    };
  }

  /** Longest-prefix match (9, then 7, then 6 nibbles) of a normalized hex string. */
  longestMatch(hex: string, version: number): OuiEntry | null {
    const candidates = PREFIX_NIBBLES.filter((n) => hex.length >= n).map((n) => hex.slice(0, n));
    const row = this.db
      .prepare(
        `SELECT * FROM oui_entries WHERE prefix IN (${candidates.map(() => "?").join(", ")}) ORDER BY nibbles DESC LIMIT 1`,
      )
      .get(...candidates) as Row | undefined;
    return row ? this.entry(row, version) : null;
  }

  private subdivided(hex6: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM oui_entries WHERE nibbles > 6 AND substr(prefix, 1, 6) = ?")
      .get(hex6) as { n: number };
    return Number(row.n);
  }

  lookupOne(input: string, version: number): MacResult {
    const mac = normalizeMac(input);
    if (!mac) {
      return {
        input,
        result: "invalid",
        error: "Not a MAC address or prefix. Use 6-12 hex digits, e.g. 00:1A:2B:3C:4D:5E, 00-1a-2b-3c-4d-5e, 001a.2b3c.4d5e or 001A2B.",
      };
    }
    const first = Number.parseInt(mac.hex.slice(0, 2), 16);
    const multicast = (first & 0x01) !== 0;
    const local = (first & 0x02) !== 0;
    const base = { input, normalized: mac.display, locally_administered: local, multicast };
    const group = WELL_KNOWN_GROUPS.find(([p]) => mac.hex.startsWith(p))?.[1];

    if (mac.hex === "FFFFFFFFFFFF") {
      return { ...base, result: "broadcast", match: null, note: "Broadcast address (FF:FF:FF:FF:FF:FF): every station, not a device." };
    }
    if (local) {
      const block = this.longestMatch(mac.hex, version);
      return {
        ...base,
        result: "locally administered",
        match: null,
        ...(block ? { registered_block: block } : {}),
        note: [
          multicast
            ? `Locally administered group (multicast) address.${group ? ` ${group}` : ""}`
            : "Locally administered address (U/L bit set): usually a random/private MAC (phones, Windows, macOS), a VM or container NIC, or software-assigned. The prefix does not identify the hardware manufacturer.",
          block
            ? `A registry entry exists for ${block.matched_prefix} (${block.registry ?? "?"}: ${block.manufacturer}); treat it as a hint, not the device vendor.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      };
    }

    let match = this.longestMatch(mac.hex, version);
    const notes: string[] = [];
    if (multicast) {
      notes.push(`Group (multicast) address, not a single device.${group ? ` ${group}` : ""}`);
      if (!match) {
        // Group addresses under an OUI carry the owner's OUI with the I/G bit set.
        const unicast = (first & 0xfe).toString(16).padStart(2, "0").toUpperCase() + mac.hex.slice(2);
        match = this.longestMatch(unicast, version);
        if (match) notes.push(`Matched the OUI with the group bit cleared (${match.matched_prefix}).`);
      }
    }
    if (match && match.prefix_nibbles === 6) {
      const n = this.subdivided(match.matched_prefix.replaceAll(":", ""));
      if (n > 0 && mac.hex.length < 9) {
        notes.push(`This block is subdivided into ${n} MA-M/MA-S/IAB assignments; give the full MAC to find the specific owner.`);
      } else if (n > 0) {
        notes.push(`This block is subdivided into ${n} MA-M/MA-S/IAB assignments, but none in this dataset covers this address.`);
      }
    }
    if (match?.status && match.status !== "current") notes.push(`Registry status: ${match.status}.`);
    if (!match) notes.push("No match in the OUI database: the prefix is unassigned or not in this dataset version.");
    return { ...base, result: match ? "match" : "No match", match, ...(notes.length ? { note: notes.join(" ") } : {}) };
  }

  lookup(inputs: string[]): { dataset: string; version: number; results: MacResult[] } {
    if (inputs.length === 0) throw new DatasetError("Give at least one MAC address");
    if (inputs.length > OUI_MAX_BATCH) throw new DatasetError(`At most ${OUI_MAX_BATCH} MAC addresses per call`);
    const version = this.version();
    return { dataset: "oui", version, results: inputs.map((m) => this.lookupOne(m, version)) };
  }

  /** Vendor name (manufacturer or short name, case-insensitive substring) to prefixes. */
  searchVendor(query: string, limit = 25): { dataset: string; version: number; total: number; results: OuiEntry[] } {
    const q = query.trim();
    if (q.length < 2) throw new DatasetError("Give at least 2 characters of the vendor name");
    const version = this.version();
    const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    const where = "manufacturer LIKE ? ESCAPE '\\' OR short_name LIKE ? ESCAPE '\\'";
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM oui_entries WHERE ${where}`).get(like, like) as { n: number }).n);
    const rows = this.db
      .prepare(`SELECT * FROM oui_entries WHERE ${where} ORDER BY manufacturer, prefix LIMIT ?`)
      .all(like, like, Math.min(Math.max(limit, 1), 100)) as unknown as Row[];
    return { dataset: "oui", version, total, results: rows.map((r) => this.entry(r, version)) };
  }
}
