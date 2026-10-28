/**
 * The agent side of CyberDrive: dataset lookups for one key. A key sees a
 * dataset's tools only when the admin granted it that dataset (keys.datasets);
 * folder grants, even "/", do not include datasets. Every call is written to
 * the activity log like a file read.
 */
import { NotFoundError } from "../storage/drive.ts";
import type { DatasetName, DatasetStore } from "./datasets.ts";
import { OuiLookup } from "./oui.ts";

const clip = (s: string, n = 900) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export class DatasetReader {
  private readonly granted: Set<string>;
  private readonly oui: OuiLookup;

  constructor(
    private readonly store: DatasetStore,
    datasets: string[],
    private readonly actor: string,
  ) {
    this.granted = new Set(datasets);
    this.oui = new OuiLookup(store);
  }

  has(name: DatasetName): boolean {
    return this.granted.has(name) && this.store.kinds.has(name);
  }

  /** Same answer as a folder the key cannot see. */
  private require(name: DatasetName): void {
    if (!this.has(name)) throw new NotFoundError(`cyberdrive:${name}`);
  }

  private log(action: string, name: DatasetName, detail: string): void {
    this.store.drive.logActivity(this.actor, action, `cyberdrive:${name}`, clip(detail));
  }

  /** Run a lookup and log it, including a failed one (e.g. the dataset is not imported yet). */
  private logged<T>(action: string, name: DatasetName, fn: () => T, describe: (out: T) => string, input: string): T {
    this.require(name);
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
}
