/**
 * Drive paths. A drive path is "/" or "/a/b/c": forward slashes, no empty,
 * "." or ".." segments, no control characters or backslashes. Everything the
 * tools and the CLI accept goes through normalizeDrivePath first.
 */
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export class InvalidPathError extends Error {
  constructor(input: string, reason: string) {
    super(`Invalid path "${input}": ${reason}`);
    this.name = "InvalidPathError";
  }
}

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_BYTES = 255;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const FORBIDDEN = /[\u0000-\u001f\u007f\\]/;

export function normalizeDrivePath(input: string): string {
  if (typeof input !== "string") throw new InvalidPathError(String(input), "not a string");
  if (input.length > MAX_PATH_LENGTH) throw new InvalidPathError(input.slice(0, 40) + "…", "too long");
  if (FORBIDDEN.test(input)) throw new InvalidPathError(input, "control characters or backslashes are not allowed");
  const segments: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new InvalidPathError(input, "'..' is not allowed");
    if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) throw new InvalidPathError(input, "a segment is too long");
    segments.push(segment);
  }
  return "/" + segments.join("/");
}

export function segmentsOf(drivePath: string): string[] {
  return drivePath === "/" ? [] : drivePath.slice(1).split("/");
}

export function parentOf(drivePath: string): string {
  const segs = segmentsOf(drivePath);
  segs.pop();
  return "/" + segs.join("/");
}

export function joinDrivePath(dir: string, name: string): string {
  return dir === "/" ? "/" + name : dir + "/" + name;
}

/** True when `p` is `folder` itself or lies inside it. */
export function isWithin(p: string, folder: string): boolean {
  return folder === "/" || p === folder || p.startsWith(folder + "/");
}

/**
 * Map a normalized drive path to a location under `root`, refusing symlinks
 * anywhere along the way. Returns null when the path (or a parent) is a
 * symlink, or when it would resolve outside root. A missing path is returned
 * as-is so callers can create it or report not found.
 */
export function resolveUnderRoot(root: string, drivePath: string): string | null {
  const rootReal = realpathSync(root);
  let current = rootReal;
  for (const segment of segmentsOf(drivePath)) {
    current = path.join(current, segment);
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(current);
    } catch {
      // Missing from here on: nothing below can be a symlink yet.
      stat = undefined;
    }
    if (stat?.isSymbolicLink()) return null;
    if (!stat) break;
  }
  const full = path.join(rootReal, ...segmentsOf(drivePath));
  if (full !== rootReal && !full.startsWith(rootReal + path.sep)) return null;
  return full;
}
