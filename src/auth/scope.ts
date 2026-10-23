/**
 * What one key can see. Anything outside its folders is invisible: it is not
 * listed, not searchable, and reading it gives the same "Not found" error as a
 * file that does not exist.
 */
import { isWithin, joinDrivePath, normalizeDrivePath, segmentsOf } from "../storage/paths.ts";

export class FolderScope {
  readonly folders: string[];

  constructor(folders: string[]) {
    this.folders = folders.map(normalizeDrivePath);
  }

  /** The path is a granted folder or lies inside one. */
  canSee(drivePath: string): boolean {
    return this.folders.some((folder) => isWithin(drivePath, folder));
  }

  /**
   * The path is a parent of a granted folder (e.g. "/" when only "/team/docs"
   * is granted). Such folders can be listed, but only show the way down.
   */
  isAncestor(drivePath: string): boolean {
    return this.folders.some((folder) => folder !== drivePath && isWithin(folder, drivePath));
  }

  /** For an ancestor folder: the child names that lead toward granted folders. */
  childrenToward(drivePath: string): Set<string> {
    const depth = segmentsOf(drivePath).length;
    const names = new Set<string>();
    for (const folder of this.folders) {
      if (folder !== drivePath && isWithin(folder, drivePath)) {
        names.add(segmentsOf(folder)[depth]);
      }
    }
    return names;
  }

  /** The smallest set of roots to search when the caller asks for `drivePath`. */
  searchRoots(drivePath: string): string[] {
    if (this.canSee(drivePath)) return [drivePath];
    if (this.isAncestor(drivePath)) {
      return this.folders.filter((folder) => isWithin(folder, drivePath));
    }
    return [];
  }

  static child(dir: string, name: string): string {
    return joinDrivePath(dir, name);
  }
}
