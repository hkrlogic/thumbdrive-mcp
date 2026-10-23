/**
 * Turning file bytes into something an agent can read: text detection, CSV
 * parsing, and MIME guessing. Excel, PDF and Word text views are stubs in M1.
 */
import { isUtf8 } from "node:buffer";
import path from "node:path";

const MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/jsonl",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".py": "text/x-python",
  ".sql": "application/sql",
  ".log": "text/plain",
  ".ini": "text/plain",
  ".toml": "application/toml",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
};

export function guessMime(drivePath: string): string {
  return MIME[path.extname(drivePath).toLowerCase()] ?? "application/octet-stream";
}

/** Formats whose text view needs a real extractor; not built yet. */
const PENDING_EXTRACTORS = new Set([".pdf", ".xlsx", ".xls", ".docx", ".pptx"]);

export function pendingExtractor(drivePath: string): boolean {
  return PENDING_EXTRACTORS.has(path.extname(drivePath).toLowerCase());
}

/** Valid UTF-8 with no NUL bytes counts as text. */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  return isUtf8(bytes);
}

export function delimiterFor(drivePath: string): "," | "\t" | null {
  const ext = path.extname(drivePath).toLowerCase();
  if (ext === ".csv") return ",";
  if (ext === ".tsv") return "\t";
  return null;
}

/** RFC 4180 CSV parser: quoted fields, doubled quotes, newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Split a buffer into pages of about `pageBytes`, never cutting a UTF-8
 * character in half. Returns [start, end) byte offsets.
 */
export function utf8PageBounds(bytes: Uint8Array, pageBytes: number): Array<[number, number]> {
  const pages: Array<[number, number]> = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + pageBytes, bytes.length);
    // Back up while `end` points at a continuation byte (10xxxxxx).
    while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
    if (end === start) end = Math.min(start + pageBytes, bytes.length); // pathological; fall back
    pages.push([start, end]);
    start = end;
  }
  if (pages.length === 0) pages.push([0, 0]);
  return pages;
}
