/**
 * The drive: plain current files under <data>/files, every stored version as a
 * blob named by its SHA-256 under <data>/versions, and version rows in SQLite.
 *
 * Only admin code (the CLI and the web UI) calls the write methods. Agents get
 * the read methods, always through a FolderScope.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { nowIso, openDatabase, transaction } from "./db.ts";
import { isWithin, joinDrivePath, normalizeDrivePath, parentOf, resolveUnderRoot, segmentsOf } from "./paths.ts";

export class NotFoundError extends Error {
  constructor(drivePath: string) {
    super(`Not found: ${drivePath}`);
    this.name = "NotFoundError";
  }
}

export class DriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveError";
  }
}

export interface Entry {
  name: string;
  path: string;
  type: "file" | "folder";
  size?: number;
  sha256?: string;
  modified: string;
}

export interface VersionRow {
  version: number;
  action: "put" | "delete";
  sha256: string | null;
  size: number | null;
  actor: string;
  created_at: string;
}

export interface FileBytes {
  path: string;
  bytes: Buffer;
  sha256: string;
  /** Version number, or null for a file copied in by hand that has no history yet. */
  version: number | null;
  modified: string;
}

export interface ActivityRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  path: string | null;
  detail: string | null;
}

export interface ActivityQuery {
  /** Exact actor, e.g. "key:laptop" or "admin". */
  actor?: string;
  /** Exact action, e.g. "read". */
  action?: string;
  /** Case-insensitive substring of the path. */
  path?: string;
  /** Only agent tool calls (actors "key:..."). */
  agentsOnly?: boolean;
  limit?: number;
}

export interface DriveStats {
  files: number;
  folders: number;
  bytes: number;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface DriveOptions {
  maxFileBytes?: number;
}

export class Drive {
  readonly dataDir: string;
  readonly filesDir: string;
  readonly versionsDir: string;
  readonly tmpDir: string;
  readonly db: DatabaseSync;
  readonly maxFileBytes: number;
  /** sha256 cache for current files, keyed by path, invalidated by size/mtime/inode. */
  private hashCache = new Map<string, { key: string; sha256: string }>();

  constructor(dataDir: string, options: DriveOptions = {}) {
    this.dataDir = path.resolve(dataDir);
    this.filesDir = path.join(this.dataDir, "files");
    this.versionsDir = path.join(this.dataDir, "versions");
    this.tmpDir = path.join(this.dataDir, "tmp");
    for (const dir of [this.dataDir, this.filesDir, this.versionsDir, this.tmpDir]) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = openDatabase(path.join(this.dataDir, "thumbdrive.db"));
    this.maxFileBytes = options.maxFileBytes ?? 50 * 1024 * 1024;
  }

  close(): void {
    this.db.close();
  }

  // ---------- reading ----------

  private locate(drivePath: string): string {
    const full = resolveUnderRoot(this.filesDir, drivePath);
    if (full === null) throw new NotFoundError(drivePath);
    return full;
  }

  /** "file", "folder" or null (missing, or hidden because it is a symlink or special file). */
  kind(drivePath: string): "file" | "folder" | null {
    const p = normalizeDrivePath(drivePath);
    const full = resolveUnderRoot(this.filesDir, p);
    if (full === null) return null;
    try {
      const st = lstatSync(full);
      if (st.isDirectory()) return "folder";
      if (st.isFile()) return "file";
      return null;
    } catch {
      return null;
    }
  }

  list(drivePath: string): Entry[] {
    const p = normalizeDrivePath(drivePath);
    if (this.kind(p) !== "folder") throw new NotFoundError(p);
    const full = this.locate(p);
    const entries: Entry[] = [];
    for (const dirent of readdirSync(full, { withFileTypes: true })) {
      const childPath = joinDrivePath(p, dirent.name);
      // Skip anything a drive path could never name, plus symlinks and special files.
      try {
        if (normalizeDrivePath(childPath) !== childPath) continue;
      } catch {
        continue;
      }
      const childFull = path.join(full, dirent.name);
      const st = lstatSync(childFull);
      if (st.isDirectory()) {
        entries.push({ name: dirent.name, path: childPath, type: "folder", modified: st.mtime.toISOString() });
      } else if (st.isFile()) {
        entries.push({
          name: dirent.name,
          path: childPath,
          type: "file",
          size: st.size,
          sha256: this.currentSha256(childPath),
          modified: st.mtime.toISOString(),
        });
      }
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1));
    return entries;
  }

  /** Every file path under a folder, depth first. */
  walk(drivePath: string): string[] {
    const out: string[] = [];
    const visit = (dir: string) => {
      for (const entry of this.list(dir)) {
        if (entry.type === "folder") visit(entry.path);
        else out.push(entry.path);
      }
    };
    visit(normalizeDrivePath(drivePath));
    return out;
  }

  private readCurrentBytes(p: string): { bytes: Buffer; modified: string } {
    if (this.kind(p) !== "file") throw new NotFoundError(p);
    const full = this.locate(p);
    // O_NOFOLLOW closes the gap between the symlink check and the open.
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new NotFoundError(p);
      return { bytes: readFileSync(fd), modified: st.mtime.toISOString() };
    } finally {
      closeSync(fd);
    }
  }

  currentSha256(drivePath: string): string {
    const p = normalizeDrivePath(drivePath);
    const full = this.locate(p);
    const st = lstatSync(full);
    const key = `${st.size}:${st.mtimeMs}:${st.ino}`;
    const cached = this.hashCache.get(p);
    if (cached && cached.key === key) return cached.sha256;
    const sha256 = sha256Hex(this.readCurrentBytes(p).bytes);
    this.hashCache.set(p, { key, sha256 });
    return sha256;
  }

  latestVersion(drivePath: string): VersionRow | undefined {
    return this.db
      .prepare(
        "SELECT version, action, sha256, size, actor, created_at FROM versions WHERE path = ? ORDER BY version DESC LIMIT 1",
      )
      .get(drivePath) as VersionRow | undefined;
  }

  /** Read a file's bytes: the current file, or a stored version. */
  readFile(drivePath: string, version?: number): FileBytes {
    const p = normalizeDrivePath(drivePath);
    if (version === undefined) {
      const { bytes, modified } = this.readCurrentBytes(p);
      const sha256 = sha256Hex(bytes);
      const latest = this.latestVersion(p);
      return {
        path: p,
        bytes,
        sha256,
        version: latest && latest.action === "put" && latest.sha256 === sha256 ? latest.version : null,
        modified,
      };
    }
    const row = this.db
      .prepare(
        "SELECT version, action, sha256, size, actor, created_at FROM versions WHERE path = ? AND version = ?",
      )
      .get(p, version) as VersionRow | undefined;
    if (row?.action !== "put" || !row.sha256) throw new NotFoundError(`${p} (version ${version})`);
    const bytes = readFileSync(this.blobPath(row.sha256));
    const sha256 = sha256Hex(bytes);
    if (sha256 !== row.sha256) {
      throw new DriveError(`Stored version ${version} of ${p} failed its checksum; the blob is damaged.`);
    }
    return { path: p, bytes, sha256, version: row.version, modified: row.created_at };
  }

  history(drivePath: string): VersionRow[] {
    const p = normalizeDrivePath(drivePath);
    return this.db
      .prepare(
        "SELECT version, action, sha256, size, actor, created_at FROM versions WHERE path = ? ORDER BY version DESC",
      )
      .all(p) as unknown as VersionRow[];
  }

  // ---------- admin writes ----------

  private blobPath(sha256: string): string {
    return path.join(this.versionsDir, sha256.slice(0, 2), sha256);
  }

  /** Write bytes to a temp file, fsync it, then rename it to `dest`. */
  private atomicWrite(dest: string, bytes: Uint8Array): void {
    const tmp = path.join(this.tmpDir, `${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
    const fd = openSync(tmp, "wx", 0o644);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, dest);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    const dirFd = openSync(path.dirname(dest), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  /** Create a folder (and its parents). */
  makeFolder(drivePath: string, actor = "admin"): string {
    const p = normalizeDrivePath(drivePath);
    let current = "/";
    for (const segment of segmentsOf(p)) {
      current = joinDrivePath(current, segment);
      const kind = this.kind(current);
      if (kind === "file") throw new DriveError(`${current} is a file, not a folder`);
      if (kind === null) {
        const full = resolveUnderRoot(this.filesDir, current);
        if (full === null) throw new DriveError(`Refusing to create ${current}: a symlink is in the way`);
        mkdirSync(full);
      }
    }
    this.logActivity(actor, "mkdir", p);
    return p;
  }

  /** Store a file. Every call records a new version; nothing is overwritten without history. */
  putFile(drivePath: string, bytes: Uint8Array, actor = "admin"): VersionRow {
    const p = normalizeDrivePath(drivePath);
    if (p === "/") throw new DriveError("Cannot write to the drive root itself");
    if (bytes.length > this.maxFileBytes) {
      throw new DriveError(`File is ${bytes.length} bytes; the limit is ${this.maxFileBytes} bytes`);
    }
    if (this.kind(p) === "folder") throw new DriveError(`${p} is a folder`);
    this.makeFolder(parentOf(p), actor);
    const dest = resolveUnderRoot(this.filesDir, p);
    if (dest === null) throw new DriveError(`Refusing to write ${p}: a symlink is in the way`);

    const sha256 = sha256Hex(bytes);
    const blob = this.blobPath(sha256);
    if (!existsSync(blob)) {
      mkdirSync(path.dirname(blob), { recursive: true });
      this.atomicWrite(blob, bytes);
    }
    this.atomicWrite(dest, bytes);
    this.hashCache.delete(p);

    const row = transaction(this.db, () => {
      const next = (this.latestVersion(p)?.version ?? 0) + 1;
      const createdAt = nowIso();
      this.db
        .prepare(
          "INSERT INTO versions (path, version, action, sha256, size, actor, created_at) VALUES (?, ?, 'put', ?, ?, ?, ?)",
        )
        .run(p, next, sha256, bytes.length, actor, createdAt);
      return { version: next, action: "put", sha256, size: bytes.length, actor, created_at: createdAt } as VersionRow;
    });
    this.logActivity(actor, "put", p, `version ${row.version}, ${bytes.length} bytes, sha256 ${sha256}`);
    return row;
  }

  /** Remove the current file. Its versions stay, so it can be brought back. */
  deleteFile(drivePath: string, actor = "admin"): VersionRow {
    const p = normalizeDrivePath(drivePath);
    if (this.kind(p) !== "file") throw new NotFoundError(p);
    const full = this.locate(p);
    // Keep the current bytes as a version first, in case the file was copied in by hand.
    const { bytes } = this.readCurrentBytes(p);
    const sha256 = sha256Hex(bytes);
    const blob = this.blobPath(sha256);
    if (!existsSync(blob)) {
      mkdirSync(path.dirname(blob), { recursive: true });
      this.atomicWrite(blob, bytes);
    }
    rmSync(full);
    this.hashCache.delete(p);
    const row = transaction(this.db, () => {
      let latest = this.latestVersion(p);
      if (!latest || latest.sha256 !== sha256) {
        const v = (latest?.version ?? 0) + 1;
        this.db
          .prepare(
            "INSERT INTO versions (path, version, action, sha256, size, actor, created_at) VALUES (?, ?, 'put', ?, ?, ?, ?)",
          )
          .run(p, v, sha256, bytes.length, actor, nowIso());
        latest = this.latestVersion(p);
      }
      const next = (latest?.version ?? 0) + 1;
      const createdAt = nowIso();
      this.db
        .prepare(
          "INSERT INTO versions (path, version, action, sha256, size, actor, created_at) VALUES (?, ?, 'delete', NULL, NULL, ?, ?)",
        )
        .run(p, next, actor, createdAt);
      return { version: next, action: "delete", sha256: null, size: null, actor, created_at: createdAt } as VersionRow;
    });
    this.logActivity(actor, "delete", p, `version ${row.version}`);
    return row;
  }

  /** True when something (file, folder, symlink, special file) already sits at the path, or a symlink is in the way. */
  private occupied(p: string): boolean {
    const full = resolveUnderRoot(this.filesDir, p);
    if (full === null) return true;
    try {
      lstatSync(full);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Rename or move a file or folder. Each file is stored as a new version at
   * the target and deleted (history kept) at the source, so both paths keep a
   * complete record. Refuses to overwrite anything at the target.
   */
  move(fromPath: string, toPath: string, actor = "admin"): string {
    const from = normalizeDrivePath(fromPath);
    const to = normalizeDrivePath(toPath);
    if (from === "/" || to === "/") throw new DriveError("The drive root cannot be moved or replaced");
    if (from === to) return to;
    const kind = this.kind(from);
    if (kind === null) throw new NotFoundError(from);
    if (this.occupied(to)) throw new DriveError(`${to} already exists`);
    if (kind === "folder" && isWithin(to, from)) throw new DriveError("A folder cannot be moved into itself");
    if (this.kind(parentOf(to)) === "file") throw new DriveError(`${parentOf(to)} is a file, not a folder`);
    if (kind === "file") {
      this.putFile(to, this.readCurrentBytes(from).bytes, actor);
      this.deleteFile(from, actor);
    } else {
      const copyTree = (src: string, dest: string) => {
        this.makeFolder(dest, actor);
        for (const entry of this.list(src)) {
          const target = joinDrivePath(dest, entry.name);
          if (entry.type === "folder") copyTree(entry.path, target);
          else {
            this.putFile(target, this.readCurrentBytes(entry.path).bytes, actor);
            this.deleteFile(entry.path, actor);
          }
        }
      };
      copyTree(from, to);
      this.removeEmptyFolders(from);
    }
    this.logActivity(actor, "move", from, `to ${to}`);
    return to;
  }

  /** Delete a folder and everything in it. Every file keeps its history and can be restored. */
  deleteFolder(drivePath: string, actor = "admin"): number {
    const p = normalizeDrivePath(drivePath);
    if (p === "/") throw new DriveError("The drive root cannot be deleted");
    if (this.kind(p) !== "folder") throw new NotFoundError(p);
    const files = this.walk(p);
    for (const file of files) this.deleteFile(file, actor);
    this.removeEmptyFolders(p);
    this.logActivity(actor, "rmdir", p, `${files.length} file(s)`);
    return files.length;
  }

  /** Remove a folder tree that holds no files. Anything the drive does not manage (symlinks...) is left alone. */
  private removeEmptyFolders(p: string): void {
    const full = this.locate(p);
    for (const dirent of readdirSync(full, { withFileTypes: true })) {
      if (dirent.isDirectory()) this.removeEmptyFolders(joinDrivePath(p, dirent.name));
    }
    try {
      rmdirSync(full);
    } catch {
      throw new DriveError(`${p} still holds items Thumbdrive does not manage (such as symlinks); they were left in place`);
    }
  }

  /** Files directly inside a folder whose latest version is a delete, newest first. They can be restored. */
  listDeleted(drivePath: string): Array<{ path: string; name: string; deleted_at: string; version: number }> {
    const dir = normalizeDrivePath(drivePath);
    const prefix = dir === "/" ? "/" : dir + "/";
    const rows = this.db
      .prepare(
        `SELECT v.path, v.version, v.created_at FROM versions v
         WHERE v.action = 'delete' AND substr(v.path, 1, length(?)) = ? AND instr(substr(v.path, length(?) + 1), '/') = 0
           AND v.version = (SELECT MAX(version) FROM versions WHERE path = v.path)
         ORDER BY v.created_at DESC LIMIT 200`,
      )
      .all(prefix, prefix, prefix) as unknown as Array<{ path: string; version: number; created_at: string }>;
    return rows
      .filter((r) => this.kind(r.path) === null)
      .map((r) => ({ path: r.path, name: r.path.slice(prefix.length), deleted_at: r.created_at, version: r.version }));
  }

  /** Every folder on the drive, "/" first. Stops after `limit` folders. */
  listFolders(limit = 5000): string[] {
    const out = ["/"];
    const visit = (dir: string) => {
      for (const entry of this.list(dir)) {
        if (out.length >= limit) return;
        if (entry.type === "folder") {
          out.push(entry.path);
          visit(entry.path);
        }
      }
    };
    visit("/");
    return out;
  }

  /** File and folder counts and total bytes of current files, without hashing anything. */
  stats(): DriveStats {
    const stats: DriveStats = { files: 0, folders: 0, bytes: 0 };
    const visit = (full: string) => {
      for (const dirent of readdirSync(full, { withFileTypes: true })) {
        const child = path.join(full, dirent.name);
        const st = lstatSync(child);
        if (st.isDirectory()) {
          stats.folders++;
          visit(child);
        } else if (st.isFile()) {
          stats.files++;
          stats.bytes += st.size;
        }
      }
    };
    visit(this.filesDir);
    return stats;
  }

  /** Bring back an earlier version as a new version (history is never rewritten). */
  restoreVersion(drivePath: string, version: number, actor = "admin"): VersionRow {
    const { bytes } = this.readFile(drivePath, version);
    return this.putFile(drivePath, bytes, actor);
  }

  // ---------- activity ----------

  logActivity(actor: string, action: string, drivePath: string | null, detail?: string): void {
    this.db
      .prepare("INSERT INTO activity (at, actor, action, path, detail) VALUES (?, ?, ?, ?, ?)")
      .run(nowIso(), actor, action, drivePath, detail ?? null);
  }

  queryActivity(query: ActivityQuery = {}): ActivityRow[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (query.agentsOnly) where.push("actor LIKE 'key:%'");
    if (query.actor) {
      where.push("actor = ?");
      args.push(query.actor);
    }
    if (query.action) {
      where.push("action = ?");
      args.push(query.action);
    }
    if (query.path) {
      where.push("instr(lower(path), lower(?)) > 0");
      args.push(query.path);
    }
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
    const sql = `SELECT id, at, actor, action, path, detail FROM activity ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit) as unknown as ActivityRow[];
  }

  /** Distinct actors and actions seen in the log, for filter menus. */
  activityFacets(): { actors: string[]; actions: string[] } {
    const actors = this.db.prepare("SELECT DISTINCT actor FROM activity ORDER BY actor").all() as unknown as Array<{ actor: string }>;
    const actions = this.db.prepare("SELECT DISTINCT action FROM activity ORDER BY action").all() as unknown as Array<{ action: string }>;
    return { actors: actors.map((r) => r.actor), actions: actions.map((r) => r.action) };
  }

  /** Agent tool calls since an ISO time. */
  agentCallsSince(iso: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE actor LIKE 'key:%' AND at >= ?").get(iso) as { n: number };
    return Number(row.n);
  }

  recentActivity(limit = 50): Array<{ at: string; actor: string; action: string; path: string | null; detail: string | null }> {
    return this.db
      .prepare("SELECT at, actor, action, path, detail FROM activity ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Array<{ at: string; actor: string; action: string; path: string | null; detail: string | null }>;
  }
}
