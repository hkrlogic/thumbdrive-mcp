/**
 * File-backed static assets: the vendored Tabulator grid (MIT, pinned; see
 * docs/third-party-licenses.md) and the tables page script and styles. They
 * live in src/web/static and are copied next to the compiled code by
 * `npm run build`, so the same relative URL works from src (tsx) and dist.
 */
import { readFileSync } from "node:fs";

const DIR = new URL("./static/", import.meta.url);

const FILES: Record<string, { file: string; type: string }> = {
  "/assets/vendor/tabulator-6.7.1.min.js": { file: "vendor/tabulator/tabulator-6.7.1.min.js", type: "text/javascript; charset=utf-8" },
  "/assets/vendor/tabulator-6.7.1.min.css": { file: "vendor/tabulator/tabulator-6.7.1.min.css", type: "text/css; charset=utf-8" },
  "/assets/tables.js": { file: "tables.js", type: "text/javascript; charset=utf-8" },
  "/assets/tables.css": { file: "tables.css", type: "text/css; charset=utf-8" },
};

export const STATIC_PATHS = Object.keys(FILES);

const cache = new Map<string, { body: Uint8Array; type: string }>();

/** The asset for a URL path, read once and kept in memory; undefined for anything not listed. */
export function staticAsset(urlPath: string): { body: Uint8Array; type: string } | undefined {
  const entry = FILES[urlPath];
  if (!entry) return undefined;
  let hit = cache.get(urlPath);
  if (!hit) {
    hit = { body: readFileSync(new URL(entry.file, DIR)), type: entry.type };
    cache.set(urlPath, hit);
  }
  return hit;
}
