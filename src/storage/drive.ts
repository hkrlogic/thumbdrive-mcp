/**
 * The drive: plain current files under <data>/files, every stored version as a
 * blob named by its SHA-256 under <data>/versions, and version rows in SQLite.
 *
 * Only admin code (CLI now, web UI later) calls the write methods. Agents get
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
  writeSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { nowIso, openDatabase, transaction } from "./db.ts";
import { joinDrivePath, normalizeDrivePath, parentOf, resolveUnderRoot, segmentsOf } from "./paths.ts";

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

  recentActivity(limit = 50): Array<{ at: string; actor: string; action: string; path: string | null; detail: string | null }> {
    return this.db
      .prepare("SELECT at, actor, action, path, detail FROM activity ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Array<{ at: string; actor: string; action: string; path: string | null; detail: string | null }>;
  }
}
