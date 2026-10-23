/**
 * The four agent operations: list, read, search, history. All of them go
 * through a FolderScope, and anything outside it fails exactly like a missing
 * path. Every call is written to the activity log.
 */
import { createHash } from "node:crypto";
import { FolderScope } from "../auth/scope.ts";
import { type Drive, type Entry, NotFoundError, type VersionRow } from "../storage/drive.ts";
import { normalizeDrivePath } from "../storage/paths.ts";
import { delimiterFor, guessMime, looksLikeText, parseCsv, pendingExtractor, utf8PageBounds } from "../extract/text.ts";

export interface ReaderOptions {
  pageBytes: number;
  pageRows: number;
  searchLimit?: number;
  /** Files larger than this are matched by name only in search. */
  searchMaxFileBytes?: number;
}

export interface ReadRequest {
  path: string;
  /** "raw" returns the bytes (text or base64); "text" returns an extracted text view (CSV rows, plain text). */
  format?: "raw" | "text";
  /** 1-based page number. */
  page?: number;
  version?: number;
  /** Force base64 output even for text files. */
  base64?: boolean;
}

export interface ReadMeta {
  path: string;
  version: number | null;
  size: number;
  sha256: string;
  mime: string;
  format: "raw" | "text";
  encoding: "utf-8" | "base64" | "json";
  page: number;
  pages: number;
  has_more: boolean;
  /** Byte range of this page in the file (raw and plain-text pages). */
  offset?: number;
  length?: number;
  /** Row range of this page (CSV text view), 0-based, header row included in every page. */
  rows?: { first: number; last: number; total: number };
  page_sha256: string;
}

export interface ReadResult {
  meta: ReadMeta;
  content: string;
}

export interface SearchHit {
  path: string;
  type: "file" | "folder";
  match: "name" | "content";
  line?: number;
  snippet?: string;
}

/** A problem with the caller's request (bad page, empty query); safe to show to the agent. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export class UnsupportedFormatError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFormatError";
  }
}

function sha(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export class Reader {
  readonly scope: FolderScope;

  constructor(
    private readonly drive: Drive,
    folders: string[],
    private readonly actor: string,
    private readonly options: ReaderOptions,
  ) {
    this.scope = new FolderScope(folders);
  }

  /** Throws the standard not-found error for anything the key cannot see. */
  private requireVisibleFile(p: string): void {
    if (!this.scope.canSee(p) || this.drive.kind(p) !== "file") throw new NotFoundError(p);
  }

  list(drivePath = "/"): { path: string; entries: Entry[] } {
    const p = normalizeDrivePath(drivePath);
    let entries: Entry[];
    if (this.scope.canSee(p)) {
      entries = this.drive.list(p);
    } else if (this.scope.isAncestor(p) && this.drive.kind(p) === "folder") {
      const toward = this.scope.childrenToward(p);
      entries = this.drive
        .list(p)
        .filter((e) => e.type === "folder" && toward.has(e.name))
        .map((e) => ({ name: e.name, path: e.path, type: "folder" as const, modified: e.modified }));
    } else {
      throw new NotFoundError(p);
    }
    this.drive.logActivity(this.actor, "list", p);
    return { path: p, entries };
  }

  read(request: ReadRequest): ReadResult {
    const p = normalizeDrivePath(request.path);
    const format = request.format ?? "raw";
    const page = request.page ?? 1;
    if (!Number.isInteger(page) || page < 1) throw new UsageError("page must be a whole number, 1 or more");
    if (!this.scope.canSee(p)) throw new NotFoundError(p);
    if (request.version === undefined) this.requireVisibleFile(p);

    const file = this.drive.readFile(p, request.version);
    const bytes = file.bytes;
    const isText = looksLikeText(bytes);
    const base = {
      path: p,
      version: file.version,
      size: bytes.length,
      sha256: file.sha256,
      mime: guessMime(p),
    };

    let result: ReadResult;
    if (format === "text") {
      if (pendingExtractor(p)) {
        throw new UnsupportedFormatError(
          `Text extraction for ${base.mime} is not available yet. Use format "raw" to get the file as base64.`,
        );
      }
      if (!isText) {
        throw new UnsupportedFormatError(`${p} is not a text file. Use format "raw" to get it as base64.`);
      }
      const delimiter = delimiterFor(p);
      result = delimiter
        ? this.csvPage(base, bytes.toString("utf8"), delimiter, page)
        : this.bytePage(base, bytes, page, "text", false);
    } else {
      result = this.bytePage(base, bytes, page, "raw", request.base64 === true || !isText);
    }
    this.drive.logActivity(
      this.actor,
      "read",
      p,
      `format ${format}, page ${result.meta.page}/${result.meta.pages}${request.version ? `, version ${request.version}` : ""}`,
    );
    return result;
  }

  private bytePage(
    base: Pick<ReadMeta, "path" | "version" | "size" | "sha256" | "mime">,
    bytes: Buffer,
    page: number,
    format: "raw" | "text",
    asBase64: boolean,
  ): ReadResult {
    const pageBytes = this.options.pageBytes;
    let bounds: Array<[number, number]>;
    if (asBase64) {
      bounds = [];
      for (let start = 0; start < bytes.length; start += pageBytes) {
        bounds.push([start, Math.min(start + pageBytes, bytes.length)]);
      }
      if (bounds.length === 0) bounds.push([0, 0]);
    } else {
      bounds = utf8PageBounds(bytes, pageBytes);
    }
    if (page > bounds.length) throw new UsageError(`page ${page} is past the end; this file has ${bounds.length} page(s)`);
    const [start, end] = bounds[page - 1];
    const slice = bytes.subarray(start, end);
    return {
      meta: {
        ...base,
        format,
        encoding: asBase64 ? "base64" : "utf-8",
        page,
        pages: bounds.length,
        has_more: page < bounds.length,
        offset: start,
        length: end - start,
        page_sha256: sha(slice),
      },
      content: asBase64 ? slice.toString("base64") : slice.toString("utf8"),
    };
  }

  private csvPage(
    base: Pick<ReadMeta, "path" | "version" | "size" | "sha256" | "mime">,
    text: string,
    delimiter: string,
    page: number,
  ): ReadResult {
    const rows = parseCsv(text, delimiter);
    const header = rows[0] ?? [];
    const body = rows.slice(1);
    const perPage = this.options.pageRows;
    const pages = Math.max(1, Math.ceil(body.length / perPage));
    if (page > pages) throw new UsageError(`page ${page} is past the end; this file has ${pages} page(s)`);
    const first = (page - 1) * perPage;
    const pageRows = body.slice(first, first + perPage);
    const content = JSON.stringify({ header, rows: pageRows });
    return {
      meta: {
        ...base,
        format: "text",
        encoding: "json",
        page,
        pages,
        has_more: page < pages,
        rows: { first: first + 1, last: first + pageRows.length, total: body.length },
        page_sha256: sha(content),
      },
      content,
    };
  }

  search(query: string, drivePath = "/"): { query: string; path: string; hits: SearchHit[]; truncated: boolean } {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) throw new UsageError("query must not be empty");
    if (needle.length > 200) throw new UsageError("query is too long (200 characters max)");
    const p = normalizeDrivePath(drivePath);
    const roots = this.scope.searchRoots(p);
    if (roots.length === 0 || roots.every((r) => this.drive.kind(r) === null)) throw new NotFoundError(p);

    const limit = this.options.searchLimit ?? 50;
    const maxBytes = this.options.searchMaxFileBytes ?? 5 * 1024 * 1024;
    const hits: SearchHit[] = [];
    let truncated = false;
    const add = (hit: SearchHit): boolean => {
      if (hits.length >= limit) {
        truncated = true;
        return false;
      }
      hits.push(hit);
      return true;
    };

    const visit = (dir: string): boolean => {
      for (const entry of this.drive.list(dir)) {
        const nameMatch = entry.name.toLowerCase().includes(needle);
        if (nameMatch) {
          if (!add({ path: entry.path, type: entry.type, match: "name" })) return false;
        }
        if (entry.type === "folder") {
          if (!visit(entry.path)) return false;
          continue;
        }
        // One hit per file: a name match already covers it.
        if (nameMatch || (entry.size ?? 0) > maxBytes || pendingExtractor(entry.path)) continue;
        const { bytes } = this.drive.readFile(entry.path);
        if (!looksLikeText(bytes)) continue;
        const lines = bytes.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            const snippet = lines[i].length > 200 ? `${lines[i].slice(0, 200)}…` : lines[i];
            if (!add({ path: entry.path, type: "file", match: "content", line: i + 1, snippet })) return false;
            break; // one content hit per file keeps results readable
          }
        }
      }
      return true;
    };

    for (const root of roots) {
      const kind = this.drive.kind(root);
      if (kind === "folder") {
        if (!visit(root)) break;
      } else if (kind === "file") {
        const name = root.split("/").pop() ?? "";
        if (name.toLowerCase().includes(needle)) add({ path: root, type: "file", match: "name" });
      }
    }
    this.drive.logActivity(this.actor, "search", p, `query ${JSON.stringify(query)}, ${hits.length} hit(s)`);
    return { query, path: p, hits, truncated };
  }

  history(drivePath: string): { path: string; versions: VersionRow[] } {
    const p = normalizeDrivePath(drivePath);
    if (!this.scope.canSee(p)) throw new NotFoundError(p);
    const versions = this.drive.history(p);
    if (versions.length === 0 && this.drive.kind(p) !== "file") throw new NotFoundError(p);
    this.drive.logActivity(this.actor, "history", p);
    return { path: p, versions };
  }
}
