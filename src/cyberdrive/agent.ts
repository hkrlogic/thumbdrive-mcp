/**
 * The agent side of CyberDrive: dataset lookups for one key. A key sees a
 * dataset's tools only when the admin granted it that dataset (keys.datasets);
 * folder grants, even "/", do not include datasets. Every call is written to
 * the activity log like a file read.
 */
import { NotFoundError } from "../storage/drive.ts";
import { CONTROL_FRAMEWORKS, ControlLookup } from "./controls.ts";
import type { DatasetName, DatasetStore } from "./datasets.ts";
import { OuiLookup } from "./oui.ts";
import { WinEventLookup } from "./winevent.ts";

const clip = (s: string, n = 900) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export class DatasetReader {
  private readonly granted: Set<string>;
  private readonly oui: OuiLookup;
  private readonly winevent: WinEventLookup;
  private readonly controls: ControlLookup;

  constructor(
    private readonly store: DatasetStore,
    datasets: string[],
    private readonly actor: string,
  ) {
    this.granted = new Set(datasets);
    this.oui = new OuiLookup(store);
    this.winevent = new WinEventLookup(store);
    this.controls = new ControlLookup(
      store,
      new Set([...this.granted].filter((n) => store.kinds.has(n as DatasetName))),
    );
  }

  has(name: DatasetName): boolean {
    return this.granted.has(name) && this.store.kinds.has(name);
  }

  /** Same answer as a folder the key cannot see. */
  private require(name: DatasetName): void {
    if (!this.has(name)) throw new NotFoundError(`cyberdrive:${name}`);
  }

  /** `name` may join several datasets with "+" when one call reads more than one (control lookups). */
  private log(action: string, name: string, detail: string): void {
    this.store.drive.logActivity(this.actor, action, `cyberdrive:${name}`, clip(detail));
  }

  /** Run a lookup and log it, including a failed one (e.g. the dataset is not imported yet). */
  private logged<T>(action: string, name: DatasetName, fn: () => T, describe: (out: T) => string, input: string): T {
    this.require(name);
    return this.loggedAs(action, name, fn, describe, input);
  }

  private loggedAs<T>(action: string, name: string, fn: () => T, describe: (out: T) => string, input: string): T {
    let out: T;
    try {
      out = fn();
    } catch (error) {
      this.log(action, name, `${input}: failed: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
    this.log(action, name, describe(out));
    return out;
  }

  lookupMac(macs: string[]) {
    return this.logged(
      "lookup_mac",
      "oui",
      () => this.oui.lookup(macs),
      (out) =>
        `v${out.version} ${out.results.length} MAC(s): ` +
        out.results.map((r) => `${r.normalized ?? r.input}=${r.match ? r.match.matched_prefix : r.result}`).join(", "),
      `${macs.length} MAC(s)`,
    );
  }

  searchOuiVendor(query: string, limit?: number) {
    return this.logged(
      "search_oui_vendor",
      "oui",
      () => this.oui.searchVendor(query, limit),
      (out) => `v${out.version} "${query}": ${out.total} hit(s)`,
      `"${query}"`,
    );
  }

  lookupWindowsEvent(ids: Array<string | number>) {
    return this.logged(
      "lookup_windows_event",
      "winevent",
      () => this.winevent.lookup(ids),
      (out) =>
        `v${out.version} ${out.results.length} event(s): ` +
        out.results.map((r) => `${r.event_id ?? r.input}=${r.result === "match" ? (r.subcategory ?? "match") : r.result}`).join(", "),
      `${ids.length} event(s)`,
    );
  }

  searchWindowsEvents(query: string | undefined, category?: string, limit?: number) {
    const what = `"${query ?? ""}"${category ? ` in ${category}` : ""}`;
    return this.logged(
      "search_windows_events",
      "winevent",
      () => this.winevent.search(query, { category, limit }),
      (out) => `v${out.version} ${what}: ${out.total} hit(s)`,
      what,
    );
  }

  /** Control catalogs this key can read (nist80053, csf2). */
  controlFrameworks(): DatasetName[] {
    return CONTROL_FRAMEWORKS.map((f) => f.dataset).filter((n) => this.has(n));
  }

  /** Granted catalogs joined for the log path, e.g. "nist80053+csf2". */
  private controlPath(): string {
    const names = this.controlFrameworks();
    if (names.length === 0) throw new NotFoundError("cyberdrive:nist80053");
    return names.join("+");
  }

  lookupControls(ids: string[]) {
    return this.loggedAs(
      "lookup_control",
      this.controlPath(),
      () => this.controls.lookup(ids),
      (out) =>
        `${out.frameworks.map((f) => `${f.dataset}@v${f.version}`).join(" ")} ${out.results.length} ID(s): ` +
        out.results.map((r) => `${r.id ?? r.input}=${r.result === "match" ? (r.withdrawn ? "withdrawn" : "match") : r.result}`).join(", "),
      `${ids.length} ID(s)`,
    );
  }

  searchControls(query: string | undefined, opts: { framework?: string; family?: string; limit?: number; includeWithdrawn?: boolean } = {}) {
    const what = `"${query ?? ""}"${opts.framework ? ` framework ${opts.framework}` : ""}${opts.family ? ` in ${opts.family}` : ""}`;
    return this.loggedAs(
      "search_controls",
      this.controlPath(),
      () => this.controls.search(query, opts),
      (out) => `${out.frameworks.map((f) => `${f.dataset}@v${f.version}`).join(" ")} ${what}: ${out.total} hit(s)`,
      what,
    );
  }

  mapControls(ids: string[]) {
    return this.logged(
      "map_control",
      "csf2map",
      () => this.controls.map(ids),
      (out) =>
        `v${out.version} ${out.results.length} ID(s): ` +
        out.results.map((r) => `${r.id ?? r.input}=${r.maps_to ? `${r.maps_to.length} mapping(s)` : r.result}`).join(", "),
      `${ids.length} ID(s)`,
    );
  }
}
