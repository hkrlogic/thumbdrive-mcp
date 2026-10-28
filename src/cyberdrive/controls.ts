/**
 * NIST control frameworks (datasets "nist80053", "csf2" and "csf2map").
 *
 * - nist80053: NIST SP 800-53 Rev 5 controls and enhancements, from NIST's
 *   OSCAL catalog JSON (usnistgov/oscal-content).
 * - csf2: NIST Cybersecurity Framework 2.0 functions, categories and
 *   subcategories, from NIST's OSCAL catalog JSON.
 * - csf2map: NIST's CSF 2.0 to SP 800-53 informative references, from the CSF
 *   2.0 Reference Tool export (an .xlsx from csrc.nist.gov).
 *
 * Every catalog lands in one shared `controls` table keyed by (framework,
 * id), so another catalog (for example CIS Controls v8.1, which an admin
 * would have to supply under its own license) only needs a parser and an ID
 * pattern in CONTROL_FRAMEWORKS.
 */
import readXlsxFile from "read-excel-file/node";
import type { DatabaseSync } from "node:sqlite";
import { type DatasetKind, DatasetError, type DatasetName, type DatasetStore, type ParsedDataset } from "./datasets.ts";

export const NIST80053_SOURCE_URL =
  "https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json";
export const CSF2_SOURCE_URL =
  "https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/CSF/v2.0/json/NIST_CSF_v2.0_catalog.json";
export const CSF2MAP_SOURCE_URL = "https://csrc.nist.gov/extensions/nudp/services/json/csf/download?olirids=all";
export const CONTROLS_MAX_BATCH = 50;

/** A control catalog: the dataset it lives in and how to recognise its IDs. */
interface ControlFramework {
  dataset: Extract<DatasetName, "nist80053" | "csf2">;
  title: string;
  /** Canonical ID for `input`, or null if it is not this framework's ID. */
  parseId: (input: string) => string | null;
}

const SP80053_FAMILIES = new Set(
  "AC AT AU CA CM CP IA IR MA MP PE PL PM PS PT RA SA SC SI SR".split(" "),
);
const CSF_FUNCTIONS = new Set(["GV", "ID", "PR", "DE", "RS", "RC"]);

/** AC, AC-2, ac-02, AC-2(1), AC-2 (1), AC-02(01), AC-2.1 -> AC, AC-2, AC-2(1). */
export function sp80053Id(input: string): string | null {
  const s = input
    .trim()
    .toUpperCase()
    .replace(/^(?:NIST\s*)?(?:SP\s*)?800-53(?:\s*REV\.?\s*[\d.]+)?\s*[:#]?\s*/, "");
  const m = /^([A-Z]{2})(?:\s*-\s*0*(\d{1,3})(?:\s*\(\s*0*(\d{1,3})\s*\)|\s*\.\s*0*(\d{1,3}))?)?$/.exec(s);
  if (!m || !SP80053_FAMILIES.has(m[1])) return null;
  if (!m[2]) return m[1];
  const enh = m[3] ?? m[4];
  return `${m[1]}-${Number(m[2])}${enh ? `(${Number(enh)})` : ""}`;
}

/** GV, gv.oc, PR.AA-1, PR.AA-01 -> GV, GV.OC, PR.AA-01. */
export function csf2Id(input: string): string | null {
  const s = input
    .trim()
    .toUpperCase()
    .replace(/^(?:NIST\s*)?CSF\s*(?:V?\s*2(?:\.0)?)?\s*[:#]?\s*/, "");
  const m = /^([A-Z]{2})(?:\s*\.\s*([A-Z]{2})(?:\s*-\s*0*(\d{1,3}))?)?$/.exec(s);
  if (!m || !CSF_FUNCTIONS.has(m[1])) return null;
  if (!m[2]) return m[1];
  return `${m[1]}.${m[2]}${m[3] ? `-${m[3].padStart(2, "0")}` : ""}`;
}

export const CONTROL_FRAMEWORKS: ControlFramework[] = [
  { dataset: "nist80053", title: "NIST SP 800-53 Rev 5", parseId: sp80053Id },
  { dataset: "csf2", title: "NIST CSF 2.0", parseId: csf2Id },
];

// ---------- OSCAL ----------

interface OscalProp {
  name: string;
  value: string;
  class?: string;
  remarks?: string;
}
interface OscalLink {
  href: string;
  rel?: string;
}
interface OscalPart {
  id?: string;
  name: string;
  class?: string;
  props?: OscalProp[];
  prose?: string;
  parts?: OscalPart[];
}
interface OscalParam {
  id: string;
  label?: string;
  guidelines?: Array<{ prose?: string }>;
  select?: { "how-many"?: string; choice?: string[] };
  values?: string[];
}
interface OscalControl {
  id: string;
  class?: string;
  title?: string;
  props?: OscalProp[];
  links?: OscalLink[];
  params?: OscalParam[];
  parts?: OscalPart[];
  controls?: OscalControl[];
}
interface OscalGroup extends OscalControl {
  groups?: OscalGroup[];
}
interface OscalCatalog {
  metadata?: { title?: string; version?: string; "oscal-version"?: string; "last-modified"?: string; published?: string };
  groups?: OscalGroup[];
  controls?: OscalControl[];
  params?: OscalParam[];
}

const INSERT = /\{\{\s*insert:\s*param,\s*([^\s}]+)\s*\}\}/g;

/** Replace OSCAL parameter inserts with SP 800-53's printed form: [Assignment: ...] and [Selection (one or more): a; b]. */
export function renderParams(prose: string, params: Map<string, OscalParam>, depth = 0): string {
  return prose.replace(INSERT, (_m, id: string) => {
    const p = params.get(id);
    if (!p || depth > 5) return `[Assignment: ${id}]`;
    if (p.values?.length) return p.values.join(", ");
    if (p.select) {
      const how = p.select["how-many"] === "one-or-more" ? " (one or more)" : "";
      const choices = (p.select.choice ?? []).map((c) => renderParams(c, params, depth + 1).trim());
      return `[Selection${how}: ${choices.join("; ")}]`;
    }
    const label = (p.label ?? p.guidelines?.[0]?.prose ?? id).trim();
    return `[Assignment: ${/^organization-defined\b/i.test(label) ? label : `organization-defined ${label}`}]`;
  });
}

const prop = (props: OscalProp[] | undefined, name: string, cls?: string | null) =>
  props?.find((p) => p.name === name && (cls === undefined || (cls === null ? !p.class : p.class === cls)))?.value;

/** Statement parts as indented lines: "a. Define ...", "  1. Authorized users ...". */
function renderStatement(part: OscalPart, params: Map<string, OscalParam>, depth = 0): string[] {
  const lines: string[] = [];
  const label = prop(part.props, "label");
  const prose = part.prose ? renderParams(part.prose, params).trim() : "";
  const indent = "  ".repeat(Math.max(depth - 1, 0));
  if (label || prose) lines.push(`${indent}${label ? `${label} ` : ""}${prose}`.trimEnd());
  for (const child of part.parts ?? []) {
    if (child.name === "item" || child.name === "statement") lines.push(...renderStatement(child, params, depth + 1));
  }
  return lines;
}

function proseOf(parts: OscalPart[] | undefined, name: string, params: Map<string, OscalParam>): string | null {
  const found = parts?.filter((p) => p.name === name) ?? [];
  const text = found
    .map((p) =>
      p.name === "statement"
        ? renderStatement(p, params).join("\n")
        : [p.prose ?? "", ...(p.parts ?? []).map((c) => c.prose ?? "")].filter(Boolean).map((t) => renderParams(t, params)).join("\n\n"),
    )
    .join("\n\n")
    .trim();
  return text || null;
}

export interface ControlRow {
  framework: string;
  id: string;
  kind: string;
  parent: string | null;
  family: string | null;
  family_title: string | null;
  title: string;
  statement: string | null;
  guidance: string | null;
  examples: string[];
  related: string[];
  withdrawn: boolean;
  withdrawn_to: Array<{ rel: string; id: string }>;
  extra: Record<string, string>;
}

export interface CatalogMeta {
  framework: string;
  title: string;
  version: string | null;
  oscal_version: string | null;
  last_modified: string | null;
}

function readCatalog(bytes: Uint8Array): OscalCatalog {
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new DatasetError("Not a JSON file (expected an OSCAL catalog)");
  }
  const catalog = (doc as { catalog?: OscalCatalog })?.catalog;
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.groups)) {
    throw new DatasetError('Not an OSCAL catalog: expected {"catalog": {"groups": [...]}}');
  }
  return catalog;
}

function collectParams(catalog: OscalCatalog): Map<string, OscalParam> {
  const params = new Map<string, OscalParam>();
  const walk = (cs: OscalControl[] | undefined) => {
    for (const c of cs ?? []) {
      for (const p of c.params ?? []) params.set(p.id, p);
      walk(c.controls);
      walk((c as OscalGroup).groups);
    }
  };
  for (const p of catalog.params ?? []) params.set(p.id, p);
  walk(catalog.groups);
  walk(catalog.controls);
  return params;
}

/** Shared writer: replace one framework's rows in `controls` and its catalog metadata. */
function controlsWriter(framework: string, meta: CatalogMeta, rows: ControlRow[]) {
  return (db: DatabaseSync) => {
    db.prepare("DELETE FROM controls WHERE framework = ?").run(framework);
    db.prepare("DELETE FROM control_catalogs WHERE framework = ?").run(framework);
    db.prepare("INSERT INTO control_catalogs (framework, title, version, oscal_version, last_modified) VALUES (?, ?, ?, ?, ?)").run(
      meta.framework,
      meta.title,
      meta.version,
      meta.oscal_version,
      meta.last_modified,
    );
    const ins = db.prepare(
      `INSERT INTO controls (framework, id, kind, parent, family, family_title, title, statement, guidance, examples, related,
        withdrawn, withdrawn_to, extra, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [i, r] of rows.entries()) {
      ins.run(
        r.framework,
        r.id,
        r.kind,
        r.parent,
        r.family,
        r.family_title,
        r.title,
        r.statement,
        r.guidance,
        JSON.stringify(r.examples),
        JSON.stringify(r.related),
        r.withdrawn ? 1 : 0,
        JSON.stringify(r.withdrawn_to),
        JSON.stringify(r.extra),
        i,
      );
    }
  };
}

/** SP 800-53 OSCAL catalog: groups are families; controls nest enhancements. */
export function parseSp80053(bytes: Uint8Array): ParsedDataset {
  const catalog = readCatalog(bytes);
  const params = collectParams(catalog);
  const groups = catalog.groups ?? [];
  if (!groups.some((g) => g.class === "family" && (g.controls ?? []).some((c) => c.class === "SP800-53"))) {
    throw new DatasetError('Not an SP 800-53 catalog: expected groups of class "family" holding controls of class "SP800-53"');
  }
  const ids = new Map<string, string>();
  const label = (c: OscalControl) => {
    const raw = prop(c.props, "label", null) ?? prop(c.props, "label") ?? c.id;
    return sp80053Id(raw) ?? sp80053Id(c.id.replace(/\./, "(") + (c.id.includes(".") ? ")" : "")) ?? raw.toUpperCase();
  };
  const index = (cs: OscalControl[] | undefined) => {
    for (const c of cs ?? []) {
      ids.set(c.id, label(c));
      index(c.controls);
    }
  };
  for (const g of groups) {
    ids.set(g.id, (prop(g.props, "label") ?? g.id).toUpperCase());
    index(g.controls);
  }
  const ref = (href: string) => ids.get(href.replace(/^#/, "")) ?? null;
  const rows: ControlRow[] = [];
  let skipped = 0;
  const add = (c: OscalControl, family: { id: string; title: string }, parent: string | null) => {
    const id = ids.get(c.id) ?? c.id;
    if (!c.title) {
      skipped++;
      return;
    }
    const withdrawn = prop(c.props, "status") === "withdrawn";
    rows.push({
      framework: "nist80053",
      id,
      kind: parent ? "enhancement" : "control",
      parent,
      family: family.id,
      family_title: family.title,
      title: c.title,
      statement: proseOf(c.parts, "statement", params),
      guidance: proseOf(c.parts, "guidance", params),
      examples: [],
      related: (c.links ?? [])
        .filter((l) => l.rel === "related")
        .map((l) => ref(l.href))
        .filter((x): x is string => !!x),
      withdrawn,
      withdrawn_to: (c.links ?? [])
        .filter((l) => l.rel === "incorporated-into" || l.rel === "moved-to")
        .map((l) => ({ rel: l.rel === "moved-to" ? "moved to" : "incorporated into", id: ref(l.href) ?? l.href.replace(/^#/, "") })),
      extra: {},
    });
    for (const e of c.controls ?? []) add(e, family, id);
  };
  for (const g of groups) {
    const family = { id: ids.get(g.id) ?? g.id.toUpperCase(), title: g.title ?? g.id };
    rows.push({
      framework: "nist80053",
      id: family.id,
      kind: "family",
      parent: null,
      family: family.id,
      family_title: family.title,
      title: family.title,
      statement: null,
      guidance: null,
      examples: [],
      related: [],
      withdrawn: false,
      withdrawn_to: [],
      extra: {},
    });
    for (const c of g.controls ?? []) add(c, family, null);
  }
  const meta: CatalogMeta = {
    framework: "nist80053",
    title: catalog.metadata?.title ?? "NIST SP 800-53 Rev 5",
    version: catalog.metadata?.version ?? null,
    oscal_version: catalog.metadata?.["oscal-version"] ?? null,
    last_modified: catalog.metadata?.["last-modified"] ?? null,
  };
  const count = rows.filter((r) => r.kind !== "family").length;
  return { rows: count, skipped, write: controlsWriter("nist80053", meta, rows) };
}

/** CSF 2.0 OSCAL catalog: groups are functions, controls are categories, nested controls are subcategories. */
export function parseCsf2(bytes: Uint8Array): ParsedDataset {
  const catalog = readCatalog(bytes);
  const params = collectParams(catalog);
  const groups = catalog.groups ?? [];
  if (!groups.some((g) => g.class === "function" && csf2Id(g.id) === g.id.toUpperCase())) {
    throw new DatasetError('Not a CSF 2.0 catalog: expected groups of class "function" (GV, ID, PR, DE, RS, RC)');
  }
  const rows: ControlRow[] = [];
  let skipped = 0;
  const examples = (c: OscalControl) =>
    (c.parts ?? [])
      .filter((p) => p.name === "guidance" || p.name === "example")
      .map((p) => (p.prose ? renderParams(p.prose, params).trim() : ""))
      .filter(Boolean)
      .map((t, i) => `Ex${i + 1}: ${t}`);
  const add = (c: OscalControl, fn: { id: string; title: string }, parent: string | null) => {
    const id = csf2Id(c.id);
    if (!id) {
      skipped++;
      return;
    }
    const withdrawn = prop(c.props, "status") === "withdrawn";
    const party = c.props?.find((p) => p.class === "risk-party");
    const kind = c.class === "category" || c.class === "subcategory" ? c.class : id.includes("-") ? "subcategory" : "category";
    rows.push({
      framework: "csf2",
      id,
      kind,
      parent,
      family: fn.id,
      family_title: fn.title,
      // Subcategories are titled with their own ID in the catalog; their outcome statement is the title.
      title: c.title && c.title.toUpperCase() !== id ? c.title : (proseOf(c.parts, "statement", params) ?? id),
      statement: proseOf(c.parts, "statement", params),
      guidance: null,
      examples: examples(c),
      related: [],
      withdrawn,
      withdrawn_to: (c.links ?? [])
        .filter((l) => /^(incorporated[_-]into|moved[_-]to)$/.test(l.rel ?? ""))
        .map((l) => ({
          rel: /^moved/.test(l.rel ?? "") ? "moved to" : "incorporated into",
          id: csf2Id(l.href.replace(/^#/, "")) ?? l.href,
        })),
      extra: party ? { risk_party: party.remarks ?? party.value } : {},
    });
    for (const s of c.controls ?? []) add(s, fn, id);
  };
  for (const g of groups) {
    const fnId = csf2Id(g.id);
    if (!fnId) {
      skipped++;
      continue;
    }
    const fn = { id: fnId, title: g.title ?? fnId };
    rows.push({
      framework: "csf2",
      id: fnId,
      kind: "function",
      parent: null,
      family: fnId,
      family_title: fn.title,
      title: fn.title,
      statement: proseOf(g.parts, "overview", params) ?? proseOf(g.parts, "statement", params),
      guidance: null,
      examples: [],
      related: [],
      withdrawn: false,
      withdrawn_to: [],
      extra: {},
    });
    for (const c of g.controls ?? []) add(c, fn, fnId);
  }
  const meta: CatalogMeta = {
    framework: "csf2",
    title: catalog.metadata?.title ?? "NIST Cybersecurity Framework 2.0",
    version: catalog.metadata?.version ?? null,
    oscal_version: catalog.metadata?.["oscal-version"] ?? null,
    last_modified: catalog.metadata?.["last-modified"] ?? null,
  };
  return { rows: rows.length, skipped, write: controlsWriter("csf2", meta, rows) };
}

// ---------- CSF 2.0 -> SP 800-53 mapping (CSF 2.0 Reference Tool export) ----------

type Cell = string | number | boolean | Date | null | undefined;
const SP80053_REF = /^SP 800-53 Rev\.? ?(\d+(?:\.\d+)*)\s*:\s*(.+)$/i;
const CSF_HEAD = /\(((?:GV|ID|PR|DE|RS|RC)(?:\.[A-Z]{2})?)\)\s*:|^((?:GV|ID|PR|DE|RS|RC)\.[A-Z]{2}-\d{2})\s*:/i;

export interface ControlMapping {
  source_id: string;
  target_id: string;
  reference: string;
}

/** Parse the CSF 2.0 Reference Tool .xlsx: one row per function/category/subcategory, informative references one per line. */
export async function parseCsf2Map(bytes: Uint8Array): Promise<ParsedDataset> {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new DatasetError("Not an .xlsx file (expected the CSF 2.0 Reference Tool export)");
  }
  let sheets: Array<{ sheet: string; data: Cell[][] }>;
  try {
    sheets = (await readXlsxFile(Buffer.from(bytes))) as unknown as Array<{ sheet: string; data: Cell[][] }>;
  } catch (error) {
    throw new DatasetError(`Cannot read the .xlsx file: ${error instanceof Error ? error.message : error}`);
  }
  const norm = (c: Cell) => String(c ?? "").trim().toLowerCase();
  let found: { data: Cell[][]; header: number; refs: number; idCols: number[] } | undefined;
  for (const s of sheets) {
    const header = s.data.findIndex((r) => r.some((c) => norm(c) === "informative references") && r.some((c) => norm(c) === "subcategory"));
    if (header < 0) continue;
    const h = s.data[header].map(norm);
    found = {
      data: s.data,
      header,
      refs: h.indexOf("informative references"),
      idCols: ["function", "category", "subcategory"].map((t) => h.indexOf(t)).filter((i) => i >= 0),
    };
    break;
  }
  if (!found) throw new DatasetError('No sheet with "Subcategory" and "Informative References" columns (expected the CSF 2.0 Reference Tool export)');
  // Collect every SP 800-53 reference, then keep the newest revision the file has (it lists 5.1.1 and 5.2.0 side by side).
  const all: Array<{ source: string; rev: string; target: string }> = [];
  let skipped = 0;
  for (const r of found.data.slice(found.header + 1)) {
    let source: string | null = null;
    for (const i of found.idCols) {
      const m = CSF_HEAD.exec(String(r[i] ?? "").trim());
      if (m) source = csf2Id(m[1] ?? m[2]);
    }
    const lines = String(r[found.refs] ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!source) {
      if (lines.length) skipped++;
      continue;
    }
    for (const line of lines) {
      const m = SP80053_REF.exec(line);
      if (!m) continue;
      const target = sp80053Id(m[2]);
      if (target) all.push({ source, rev: m[1], target });
      else skipped++;
    }
  }
  const revs = [...new Set(all.map((a) => a.rev))].sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  const rev = revs[0];
  const seen = new Set<string>();
  const mappings: ControlMapping[] = [];
  for (const a of all) {
    if (a.rev !== rev) continue;
    const key = `${a.source}\0${a.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mappings.push({ source_id: a.source, target_id: a.target, reference: `SP 800-53 Rev ${rev}` });
  }
  return {
    rows: mappings.length,
    skipped,
    write(db) {
      db.exec("DELETE FROM control_mappings");
      const ins = db.prepare(
        "INSERT INTO control_mappings (source_framework, source_id, target_framework, target_id, reference) VALUES ('csf2', ?, 'nist80053', ?, ?)",
      );
      for (const m of mappings) ins.run(m.source_id, m.target_id, m.reference);
    },
  };
}

export const nist80053Dataset: DatasetKind = {
  name: "nist80053",
  title: "NIST SP 800-53",
  unit: "controls",
  defaultUrl: NIST80053_SOURCE_URL,
  fileHint: "NIST_SP-800-53_rev5_catalog.json (NIST's OSCAL catalog, JSON)",
  about:
    "NIST SP 800-53 Rev 5 controls and enhancements from NIST's OSCAL catalog (usnistgov/oscal-content). A US government work, not subject to copyright in the US. Agents use lookup_control and search_controls.",
  parse: (_file, bytes) => parseSp80053(bytes),
};

export const csf2Dataset: DatasetKind = {
  name: "csf2",
  title: "NIST CSF 2.0",
  unit: "items",
  defaultUrl: CSF2_SOURCE_URL,
  fileHint: "NIST_CSF_v2.0_catalog.json (NIST's OSCAL catalog, JSON)",
  about:
    "NIST Cybersecurity Framework 2.0 functions, categories and subcategories (with implementation examples) from NIST's OSCAL catalog. A US government work. Agents use lookup_control and search_controls.",
  parse: (_file, bytes) => parseCsf2(bytes),
};

export const csf2mapDataset: DatasetKind = {
  name: "csf2map",
  title: "CSF 2.0 to SP 800-53 map",
  unit: "mappings",
  defaultUrl: CSF2MAP_SOURCE_URL,
  fileHint: "the CSF 2.0 Reference Tool export (.xlsx with an Informative References column)",
  about:
    "NIST's CSF 2.0 informative references to SP 800-53 Rev 5 (newest revision in the file), from the CSF 2.0 Reference Tool export. Only the SP 800-53 lines are imported; other references in the file (CIS, ISO, PCI...) are ignored. Agents use map_control.",
  parse: (_file, bytes) => parseCsf2Map(bytes),
};

// ---------- lookups ----------

interface DbRow {
  framework: string;
  id: string;
  kind: string;
  parent: string | null;
  family: string | null;
  family_title: string | null;
  title: string;
  statement: string | null;
  guidance: string | null;
  examples: string;
  related: string;
  withdrawn: number;
  withdrawn_to: string;
  extra: string;
}

export interface ControlSummary {
  id: string;
  title: string;
  withdrawn?: true;
}

export interface ControlResult {
  input: string;
  result: "match" | "No match" | "invalid";
  framework?: string;
  framework_title?: string;
  id?: string;
  kind?: string;
  family?: { id: string; title: string | null };
  parent?: ControlSummary;
  title?: string;
  statement?: string | null;
  guidance?: string | null;
  implementation_examples?: string[];
  enhancements?: ControlSummary[];
  children?: ControlSummary[];
  related?: string[];
  withdrawn?: boolean;
  withdrawn_to?: Array<{ rel: string; id: string }>;
  risk_party?: string;
  citation?: string;
  note?: string;
  error?: string;
}

export interface ControlHit {
  framework: string;
  id: string;
  kind: string;
  family: string | null;
  title: string;
  withdrawn: boolean;
  snippet: string | null;
  citation: string;
}

export interface MappingTarget {
  framework: string;
  id: string;
  title?: string;
  /** How the mapping reaches the asked ID: directly, through its base control, or through its whole family. */
  via?: string;
}

export interface MappingResult {
  input: string;
  result: "match" | "No match" | "invalid";
  framework?: string;
  id?: string;
  title?: string;
  maps_to?: MappingTarget[];
  citation?: string;
  note?: string;
  error?: string;
}

const MAP_NOTE =
  "Mappings are NIST's CSF 2.0 informative references to SP 800-53 (from the CSF 2.0 Reference Tool export): a CSF outcome is supported by the listed controls; they are not equivalences. Some references name a whole 800-53 family.";

/** "NIST SP 800-53 Rev 5.2.0" from the catalog's long title, else the framework's own name. */
function shortTitle(fw: ControlFramework, catalog: CatalogMeta | undefined): string {
  const rev = /\bRev\.?\s*(\d+(?:\.\d+)+)/i.exec(catalog?.title ?? "");
  return fw.dataset === "nist80053" && rev ? `NIST SP 800-53 Rev ${rev[1]}` : fw.title;
}

/** Which framework an ID belongs to, among `allowed` datasets. */
function identify(input: string): { fw: ControlFramework; id: string } | null {
  for (const fw of CONTROL_FRAMEWORKS) {
    const id = fw.parseId(input);
    if (id) return { fw, id };
  }
  return null;
}

/**
 * Lookups over the shared controls table, limited to the `allowed` datasets
 * (the key's grants). A framework the key cannot see answers "No match" like
 * an ID that does not exist.
 */
export class ControlLookup {
  constructor(
    private readonly store: DatasetStore,
    private readonly allowed: ReadonlySet<string> = new Set(["nist80053", "csf2", "csf2map"]),
  ) {}

  private get db(): DatabaseSync {
    return this.store.db;
  }

  /** Granted frameworks that have been imported, with their dataset version. */
  frameworks(): Array<{ fw: ControlFramework; version: number; catalog: CatalogMeta | undefined }> {
    return CONTROL_FRAMEWORKS.filter((fw) => this.allowed.has(fw.dataset)).flatMap((fw) => {
      const cur = this.store.current(fw.dataset);
      if (!cur) return [];
      const catalog = this.db.prepare("SELECT * FROM control_catalogs WHERE framework = ?").get(fw.dataset) as CatalogMeta | undefined;
      return [{ fw, version: cur.version, catalog }];
    });
  }

  private requireAny() {
    const fws = this.frameworks();
    if (fws.length === 0) {
      throw new DatasetError(
        "No control framework has been imported yet. Ask the drive admin to import NIST SP 800-53 or CSF 2.0 (web UI: NIST SP 800-53 / NIST CSF 2.0, or the CLI: cyberdrive nist80053 import).",
      );
    }
    return fws;
  }

  private row(framework: string, id: string): DbRow | undefined {
    return this.db.prepare("SELECT * FROM controls WHERE framework = ? AND id = ?").get(framework, id) as DbRow | undefined;
  }

  private children(framework: string, id: string): ControlSummary[] {
    return (
      this.db.prepare("SELECT id, title, withdrawn FROM controls WHERE framework = ? AND parent = ? ORDER BY position").all(framework, id) as Array<{
        id: string;
        title: string;
        withdrawn: number;
      }>
    ).map((r) => ({ id: r.id, title: r.title, ...(r.withdrawn ? { withdrawn: true as const } : {}) }));
  }

  private familyControls(id: string): ControlSummary[] {
    return (
      this.db
        .prepare("SELECT id, title, withdrawn FROM controls WHERE framework = 'nist80053' AND kind = 'control' AND family = ? ORDER BY position")
        .all(id) as Array<{ id: string; title: string; withdrawn: number }>
    ).map((r) => ({ id: r.id, title: r.title, ...(r.withdrawn ? { withdrawn: true as const } : {}) }));
  }

  lookupOne(input: string, versions: Map<string, { version: number; title: string }>): ControlResult {
    const raw = String(input).trim();
    const hit = identify(raw);
    if (!hit) {
      return {
        input: raw,
        result: "invalid",
        error: "Not a control ID. Use an SP 800-53 ID like AC-2, AC-2(1) or AC-2.1, or a CSF 2.0 ID like PR.AA-01, GV.OC or GV.",
      };
    }
    const { fw, id } = hit;
    const v = versions.get(fw.dataset);
    if (!v) {
      return {
        input: raw,
        result: "No match",
        framework: fw.dataset,
        id,
        note: `No match: ${fw.title} (cyberdrive:${fw.dataset}) is not available to this key or has not been imported.`,
      };
    }
    const r = this.row(fw.dataset, id);
    if (!r) {
      return {
        input: raw,
        result: "No match",
        framework: fw.dataset,
        framework_title: v.title,
        id,
        note: `No match: ${id} is not in ${v.title}.`,
      };
    }
    const withdrawnTo = JSON.parse(r.withdrawn_to) as Array<{ rel: string; id: string }>;
    const extra = JSON.parse(r.extra) as Record<string, string>;
    const examples = JSON.parse(r.examples) as string[];
    const parent = r.parent && r.kind !== "control" ? this.row(fw.dataset, r.parent) : undefined;
    const kids = r.kind === "family" ? this.familyControls(r.id) : this.children(fw.dataset, r.id);
    const out: ControlResult = {
      input: raw,
      result: "match",
      framework: fw.dataset,
      framework_title: v.title,
      id: r.id,
      kind: r.kind,
      family: { id: r.family ?? "", title: r.family_title },
      ...(parent ? { parent: { id: parent.id, title: parent.title } } : {}),
      title: r.title,
      statement: r.statement,
      ...(fw.dataset === "nist80053" && r.kind !== "family" ? { guidance: r.guidance } : {}),
      ...(examples.length ? { implementation_examples: examples } : {}),
      ...(r.kind === "control" ? { enhancements: kids } : kids.length ? { children: kids } : {}),
      ...(fw.dataset === "nist80053" && r.kind !== "family" ? { related: JSON.parse(r.related) as string[] } : {}),
      withdrawn: !!r.withdrawn,
      ...(r.withdrawn ? { withdrawn_to: withdrawnTo } : {}),
      ...(extra.risk_party ? { risk_party: extra.risk_party } : {}),
      citation: `cyberdrive:${fw.dataset}@v${v.version}#${r.id}`,
    };
    if (r.withdrawn) {
      const groups = new Map<string, string[]>();
      for (const w of withdrawnTo) groups.set(w.rel, [...(groups.get(w.rel) ?? []), w.id]);
      const where = [...groups].map(([rel, ids]) => `${rel} ${ids.join(", ")}`).join("; ");
      out.note = `Withdrawn${where ? `: ${where}` : ""}. Use the replacement instead.`;
    }
    return out;
  }

  private versions() {
    const versions = new Map<string, { version: number; title: string }>();
    for (const f of this.requireAny()) versions.set(f.fw.dataset, { version: f.version, title: shortTitle(f.fw, f.catalog) });
    return versions;
  }

  lookup(ids: string[]) {
    if (ids.length === 0) throw new DatasetError("Give at least one control ID");
    if (ids.length > CONTROLS_MAX_BATCH) throw new DatasetError(`At most ${CONTROLS_MAX_BATCH} control IDs per call`);
    const versions = this.versions();
    return {
      frameworks: [...versions].map(([dataset, v]) => ({ dataset, version: v.version, title: v.title })),
      results: ids.map((id) => this.lookupOne(id, versions)),
    };
  }

  /** Case-insensitive search over IDs, titles, statements, guidance and examples. */
  search(query: string | undefined, opts: { framework?: string; family?: string; limit?: number; includeWithdrawn?: boolean } = {}) {
    const q = (query ?? "").trim();
    const family = opts.family?.trim();
    if (!q && !family) throw new DatasetError("Give a search text or a family/function");
    if (q && q.length < 2) throw new DatasetError("Give at least 2 characters to search for");
    let versions = this.versions();
    if (opts.framework) {
      const want = opts.framework.trim().toLowerCase();
      const fw = CONTROL_FRAMEWORKS.find(
        (f) => f.dataset === want || f.title.toLowerCase() === want || (want === "800-53" && f.dataset === "nist80053") || (want === "csf" && f.dataset === "csf2"),
      );
      if (!fw) throw new DatasetError(`Unknown framework "${opts.framework}". Frameworks: ${CONTROL_FRAMEWORKS.map((f) => f.dataset).join(", ")}`);
      const v = versions.get(fw.dataset);
      if (!v) throw new DatasetError(`${fw.title} (cyberdrive:${fw.dataset}) is not available to this key or has not been imported`);
      versions = new Map([[fw.dataset, v]]);
    }
    const fwList = [...versions.keys()];
    const where: string[] = [`framework IN (${fwList.map(() => "?").join(", ")})`, "kind NOT IN ('family', 'function')"];
    const params: Array<string | number> = [...fwList];
    if (!opts.includeWithdrawn) where.push("withdrawn = 0");
    if (family) {
      const fam = family.toUpperCase();
      where.push("(UPPER(family) = ? OR UPPER(family_title) = ?)");
      params.push(fam, fam);
    }
    let rank = "";
    const rankParams: string[] = [];
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const idQ = identify(q)?.id ?? q.toUpperCase();
      where.push(
        "(id = ? OR title LIKE ? ESCAPE '\\' OR statement LIKE ? ESCAPE '\\' OR guidance LIKE ? ESCAPE '\\' OR examples LIKE ? ESCAPE '\\')",
      );
      params.push(idQ, like, like, like, like);
      rank = "CASE WHEN id = ? THEN 0 WHEN title LIKE ? ESCAPE '\\' THEN 1 WHEN statement LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END, ";
      rankParams.push(idQ, like, like);
    }
    const sql = `FROM controls WHERE ${where.join(" AND ")}`;
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...params) as { n: number }).n);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const rows = this.db
      .prepare(`SELECT framework, id, kind, family, title, statement, guidance, withdrawn ${sql} ORDER BY ${rank}framework, position LIMIT ?`)
      .all(...params, ...rankParams, limit) as Array<{
      framework: string;
      id: string;
      kind: string;
      family: string | null;
      title: string;
      statement: string | null;
      guidance: string | null;
      withdrawn: number;
    }>;
    const snippet = (r: { statement: string | null; guidance: string | null }) => {
      const text = [r.statement, r.guidance].find((t) => t && (!q || t.toLowerCase().includes(q.toLowerCase()))) ?? r.statement;
      if (!text) return null;
      const flat = text.replace(/\s+/g, " ");
      const at = q ? Math.max(flat.toLowerCase().indexOf(q.toLowerCase()) - 60, 0) : 0;
      const cut = flat.slice(at, at + 200);
      return `${at > 0 ? "…" : ""}${cut}${at + 200 < flat.length ? "…" : ""}`;
    };
    const results: ControlHit[] = rows.map((r) => ({
      framework: r.framework,
      id: r.id,
      kind: r.kind,
      family: r.family,
      title: r.title,
      withdrawn: !!r.withdrawn,
      snippet: snippet(r),
      citation: `cyberdrive:${r.framework}@v${versions.get(r.framework)?.version}#${r.id}`,
    }));
    return {
      frameworks: [...versions].map(([dataset, v]) => ({ dataset, version: v.version, title: v.title })),
      total,
      results,
    };
  }

  /** CSF 2.0 <-> SP 800-53 through NIST's informative references (dataset csf2map). */
  map(ids: string[]) {
    if (ids.length === 0) throw new DatasetError("Give at least one control ID");
    if (ids.length > CONTROLS_MAX_BATCH) throw new DatasetError(`At most ${CONTROLS_MAX_BATCH} control IDs per call`);
    const cur = this.allowed.has("csf2map") ? this.store.current("csf2map") : undefined;
    if (!cur) {
      throw new DatasetError(
        "The CSF 2.0 to SP 800-53 mapping has not been imported yet. Ask the drive admin to import it (web UI: CSF 2.0 to SP 800-53 map, or the CLI: cyberdrive csf2map import).",
      );
    }
    const titles = (framework: string, id: string) =>
      this.allowed.has(framework) && this.store.current(framework) ? this.row(framework, id)?.title : undefined;
    const reference = (this.db.prepare("SELECT reference FROM control_mappings LIMIT 1").get() as { reference: string } | undefined)?.reference;
    const results: MappingResult[] = ids.map((input) => {
      const raw = String(input).trim();
      const hit = identify(raw);
      if (!hit) {
        return { input: raw, result: "invalid", error: "Not a control ID. Use a CSF 2.0 ID like PR.AA-01 or an SP 800-53 ID like AC-2." };
      }
      const { fw, id } = hit;
      const citation = `cyberdrive:csf2map@v${cur.version}#${id}`;
      let maps: MappingTarget[];
      if (fw.dataset === "csf2") {
        // A category or function maps through its own references plus its subcategories'.
        const rows = this.db
          .prepare(
            `SELECT source_id, target_id FROM control_mappings
             WHERE source_id = ? OR (? NOT LIKE '%-%' AND substr(source_id, 1, ?) = ?) ORDER BY rowid`,
          )
          .all(id, id, id.length + 1, `${id}${id.includes(".") ? "-" : "."}`) as Array<{ source_id: string; target_id: string }>;
        const seen = new Map<string, MappingTarget>();
        for (const r of rows) {
          const prev = seen.get(r.target_id);
          if (prev && (!prev.via || r.source_id !== id)) continue;
          const title = titles("nist80053", r.target_id);
          const via = r.source_id === id ? undefined : `subcategory ${r.source_id}`;
          seen.set(r.target_id, { framework: "nist80053", id: r.target_id, ...(title ? { title } : {}), ...(via ? { via } : {}) });
        }
        maps = [...seen.values()];
      } else {
        const base = id.replace(/\(\d+\)$/, "");
        const fam = id.slice(0, 2);
        const rows = this.db
          .prepare("SELECT source_id, target_id FROM control_mappings WHERE target_id IN (?, ?, ?) ORDER BY rowid")
          .all(id, base, fam) as Array<{ source_id: string; target_id: string }>;
        const seen = new Map<string, MappingTarget>();
        for (const r of rows) {
          const via = r.target_id === id ? undefined : r.target_id === base ? `base control ${base}` : `whole family ${fam}`;
          const prev = seen.get(r.source_id);
          if (prev && !prev.via) continue;
          if (prev && via && prev.via?.startsWith("base")) continue;
          const title = titles("csf2", r.source_id);
          seen.set(r.source_id, { framework: "csf2", id: r.source_id, ...(title ? { title } : {}), ...(via ? { via } : {}) });
        }
        maps = [...seen.values()];
      }
      maps.sort((a, b) => Number(!!a.via) - Number(!!b.via));
      const title = titles(fw.dataset, id);
      if (maps.length === 0) {
        return {
          input: raw,
          result: "No match",
          framework: fw.dataset,
          id,
          ...(title ? { title } : {}),
          citation,
          note: `No match: NIST's informative references list no ${fw.dataset === "csf2" ? "SP 800-53 controls for" : "CSF 2.0 outcomes for"} ${id}.`,
        };
      }
      return { input: raw, result: "match", framework: fw.dataset, id, ...(title ? { title } : {}), maps_to: maps, citation };
    });
    return { dataset: "csf2map", version: cur.version, reference: reference ?? null, results, note: MAP_NOTE };
  }
}
