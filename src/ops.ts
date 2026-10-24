/** Admin operations shared by the CLI and the web UI. */
import type { KeyStore } from "./auth/keys.ts";
import type { Drive } from "./storage/drive.ts";
import { ShareStore } from "./web/shares.ts";

/** Move or rename a file or folder; keys and share links for a moved folder follow it. */
export function moveEntry(drive: Drive, keys: KeyStore, from: string, to: string, actor = "admin"): string {
  const wasFolder = drive.kind(from) === "folder";
  const target = drive.move(from, to, actor);
  if (wasFolder) {
    keys.retargetFolder(from, target);
    new ShareStore(drive.db).retargetFolder(from, target);
  }
  return target;
}
