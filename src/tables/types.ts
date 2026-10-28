/**
 * Column types for user tables, and the one validator every value goes
 * through (grid edits, paste, import, publish, agent lookups). A validator
 * returns the canonical value (what is published and compared) or a short
 * message the grid shows in red. Draft cells keep invalid input as typed, so
 * nothing the admin entered is lost; publish refuses while any remain.
 */
import { isIPv6 } from "node:net";
import { csf2Id, sp80053Id } from "../cyberdrive/controls.ts";
import { normalizeMac } from "../cyberdrive/oui.ts";

export const COLUMN_TYPES = [
  { id: "text", label: "Text" },
  { id: "longtext", label: "Long text" },
  { id: "number", label: "Number" },
  { id: "date", label: "Date" },
  { id: "checkbox", label: "Checkbox" },
  { id: "select", label: "Single select" },
  { id: "url", label: "URL" },
  { id: "email", label: "Email" },
  { id: "hostname", label: "Hostname" },
  { id: "ip", label: "IP address" },
  { id: "cidr", label: "CIDR range" },
  { id: "mac", label: "MAC address" },
  { id: "cve", label: "CVE ID" },
  { id: "control", label: "Control ID" },
] as const;

export type ColumnType = (typeof COLUMN_TYPES)[number]["id"];

const TYPE_IDS = new Set<string>(COLUMN_TYPES.map((t) => t.id));
export const isColumnType = (s: string): s is ColumnType => TYPE_IDS.has(s);
export const typeLabel = (t: ColumnType) => COLUMN_TYPES.find((x) => x.id === t)?.label ?? t;

/** Types that can be a table's key column (lookup_row matches on it). */
export const KEY_TYPES: ReadonlySet<ColumnType> = new Set<ColumnType>([
  "text",
  "number",
  "date",
  "select",
  "url",
  "email",
  "hostname",
  "ip",
  "cidr",
  "mac",
  "cve",
  "control",
]);

export interface Column {
  /** Stable id ("c1", "c2", ...), never reused within a table. Row data is keyed by it. */
  id: string;
  name: string;
  type: ColumnType;
  /** Choices for a single-select column. */
  options?: string[];
}

/** A published or draft cell value: canonical scalars only. */
export type Value = string | number | boolean | null;

export type Checked = { ok: true; value: Value } | { ok: false; error: string };

export const MAX_TEXT = 2000;
export const MAX_LONGTEXT = 20000;
export const MAX_SELECT_OPTIONS = 100;

const ok = (value: Value): Checked => ({ ok: true, value });
const bad = (error: string): Checked => ({ ok: false, error });

// ---------- IP addresses ----------

const V4_OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const V4 = new RegExp(`^${V4_OCTET}(\\.${V4_OCTET}){3}$`);

export interface Ip {
  version: 4 | 6;
  /** The address as an unsigned integer (32 or 128 bits). */
  n: bigint;
  canonical: string;
}

/** Strict IPv4 dotted quad (no leading zeros, no shorthand) or IPv6 (RFC 5952 form out, no zone IDs). */
export function parseIp(input: string): Ip | undefined {
  const s = input.trim();
  if (V4.test(s)) {
    const n = s.split(".").reduce((acc, o) => (acc << 8n) | BigInt(Number(o)), 0n);
    return { version: 4, n, canonical: s.split(".").map(Number).join(".") };
  }
  if (!s.includes(":") || s.includes("%") || !isIPv6(s)) return undefined;
  // URL parsing gives the RFC 5952 canonical (lowercase, longest zero run compressed).
  const canonical = new URL(`http://[${s}]/`).hostname.slice(1, -1);
  return { version: 6, n: ipv6ToBigInt(canonical), canonical };
}

/** For a canonical IPv6 string (URL-normalized, so no embedded dotted quad). */
function ipv6ToBigInt(s: string): bigint {
  let groups = s.split(":");
  if (s.includes("::")) {
    const [head, rest] = s.split("::");
    const h = head ? head.split(":") : [];
    const r = rest ? rest.split(":") : [];
    groups = [...h, ...Array(8 - h.length - r.length).fill("0"), ...r];
  }
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(Number.parseInt(g || "0", 16)), 0n);
}

function formatIp(version: 4 | 6, n: bigint): string {
  if (version === 4) return [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 255n)).join(".");
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  return new URL(`http://[${groups.join(":")}]/`).hostname.slice(1, -1);
}

export interface Cidr {
  version: 4 | 6;
  network: bigint;
  prefix: number;
  canonical: string;
}

export function parseCidr(input: string): Cidr | { error: string } {
  const s = input.trim();
  const slash = s.indexOf("/");
  if (slash < 0) return { error: "needs a prefix length, e.g. 10.0.0.0/24" };
  const ip = parseIp(s.slice(0, slash));
  if (!ip) return { error: "not a valid network address" };
  const lenText = s.slice(slash + 1);
  const bits = ip.version === 4 ? 32 : 128;
  if (!/^\d{1,3}$/.test(lenText) || Number(lenText) > bits) return { error: `prefix length must be 0-${bits}` };
  const prefix = Number(lenText);
  const mask = prefix === 0 ? 0n : ((1n << BigInt(bits)) - 1n) ^ ((1n << BigInt(bits - prefix)) - 1n);
  const network = ip.n & mask;
  const canonical = `${formatIp(ip.version, network)}/${prefix}`;
  if (network !== ip.n) return { error: `host bits are set; did you mean ${canonical}?` };
  return { version: ip.version, network, prefix, canonical };
}

/** The range contains the address (same IP version). */
export function cidrContains(range: Cidr, ip: { version: 4 | 6; n: bigint }): boolean {
  if (range.version !== ip.version) return false;
  const bits = range.version === 4 ? 32 : 128;
  const shift = BigInt(bits - range.prefix);
  return ip.n >> shift === range.network >> shift;
}

// ---------- the other types ----------

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeHostname(input: string): string | { error: string } {
  const s = input.trim().toLowerCase().replace(/\.$/, "");
  if (!s) return { error: "empty" };
  if (V4.test(s) || s.includes(":")) return { error: "that is an IP address, not a hostname" };
  if (s.length > 253) return { error: "longer than 253 characters" };
  const labels = s.split(".");
  if (!labels.every((l) => LABEL.test(l))) return { error: "use letters, digits and hyphens; labels of 1-63 characters separated by dots" };
  return s;
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const CVE = /^CVE-(\d{4})-(\d{4,7})$/i;
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;
const THOUSANDS = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;
const TRUE = new Set(["true", "yes", "y", "1", "x", "✓", "✔", "checked", "on"]);
const FALSE = new Set(["false", "no", "n", "0", "unchecked", "off"]);

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function validDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** The control ID in canonical form if it is an SP 800-53 or CSF 2.0 ID. */
export function normalizeControlId(input: string): string | null {
  return sp80053Id(input) ?? csf2Id(input);
}

/**
 * Validate and canonicalize one cell. Empty input (null, undefined, "") is
 * always valid and becomes null; the key column's "must not be empty" rule is
 * checked at publish time.
 */
export function checkValue(column: Pick<Column, "type" | "options">, raw: unknown): Checked {
  if (raw === null || raw === undefined) return ok(null);
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return bad("not a valid date");
    if (column.type === "date") return ok(isoDate(raw));
    return checkValue(column, raw.toISOString());
  }
  if (typeof raw === "boolean") {
    if (column.type === "checkbox") return ok(raw);
    return checkValue(column, raw ? "true" : "false");
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return bad("not a finite number");
    if (column.type === "number") return ok(raw);
    if (column.type === "checkbox") return raw === 1 ? ok(true) : raw === 0 ? ok(false) : bad("use 1 or 0, yes or no");
    return checkValue(column, String(raw));
  }
  if (typeof raw !== "string") return bad("unsupported value");
  const text = column.type === "longtext" ? raw.replace(/\r\n?/g, "\n") : raw.trim();
  if (text.trim() === "") return ok(null);
  switch (column.type) {
    case "text":
      if (text.length > MAX_TEXT) return bad(`longer than ${MAX_TEXT} characters; use a Long text column`);
      return ok(text);
    case "longtext":
      if (text.length > MAX_LONGTEXT) return bad(`longer than ${MAX_LONGTEXT} characters`);
      return ok(text);
    case "number": {
      const s = THOUSANDS.test(text) ? text.replace(/,/g, "") : text;
      if (!NUMBER.test(s)) return bad("not a number");
      const n = Number(s);
      return Number.isFinite(n) ? ok(n) : bad("not a finite number");
    }
    case "date": {
      const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
      if (!m) return bad("use YYYY-MM-DD");
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (!validDate(y, mo, d)) return bad("not a real calendar date");
      return ok(`${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
    case "checkbox": {
      const s = text.toLowerCase();
      if (TRUE.has(s)) return ok(true);
      if (FALSE.has(s)) return ok(false);
      return bad("use yes or no");
    }
    case "select": {
      const options = column.options ?? [];
      const hit = options.find((o) => o.toLowerCase() === text.toLowerCase());
      if (hit !== undefined) return ok(hit);
      return bad(options.length ? `not one of: ${options.join(", ")}` : "this select column has no options yet");
    }
    case "url": {
      if (text.length > 2048) return bad("longer than 2048 characters");
      let u: URL;
      try {
        u = new URL(text);
      } catch {
        return bad("not a URL; include https://");
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") return bad("only http and https URLs");
      return ok(text);
    }
    case "email": {
      if (text.length > 254 || !EMAIL.test(text)) return bad("not an email address");
      const at = text.lastIndexOf("@");
      return ok(text.slice(0, at) + "@" + text.slice(at + 1).toLowerCase());
    }
    case "hostname": {
      const h = normalizeHostname(text);
      return typeof h === "string" ? ok(h) : bad(h.error);
    }
    case "ip": {
      const ip = parseIp(text);
      if (ip) return ok(ip.canonical);
      if (text.includes("/")) return bad("that is a CIDR range; use a CIDR column");
      return bad("not a valid IPv4 or IPv6 address");
    }
    case "cidr": {
      const c = parseCidr(text);
      return "error" in c ? bad(c.error) : ok(c.canonical);
    }
    case "mac": {
      const m = normalizeMac(text);
      if (!m || m.hex.length !== 12) return bad("not a MAC address (12 hex digits, e.g. 00:1A:2B:3C:4D:5E)");
      return ok(m.display);
    }
    case "cve": {
      const m = CVE.exec(text.replace(/\s+/g, ""));
      if (!m || Number(m[1]) < 1999) return bad("not a CVE ID (CVE-YYYY-NNNN)");
      return ok(`CVE-${m[1]}-${m[2]}`);
    }
    case "control": {
      const id = normalizeControlId(text);
      return id ? ok(id) : bad("not an SP 800-53 or CSF 2.0 ID (e.g. AC-2(1), PR.AA-01)");
    }
  }
}

/** The text a value shows as in the grid, CSV and the share view. */
export function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

/** Values compare equal for diffs (canonical forms; case-insensitive text is NOT folded). */
export const sameValue = (a: Value | undefined, b: Value | undefined) => (a ?? null) === (b ?? null);

/** Key comparison form: case-insensitive for text-like keys. */
export function keyForm(type: ColumnType, v: Value): string | null {
  if (v === null || v === "") return null;
  const s = String(v);
  return type === "number" ? String(Number(v)) : s.toLowerCase();
}
