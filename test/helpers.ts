import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";
import { Reader } from "../src/agent/reader.ts";
import { KeyStore } from "../src/auth/keys.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { Drive } from "../src/storage/drive.ts";

/** A fresh drive in a temp folder, cleaned up after the test file. */
export function tempDrive(options: { maxFileBytes?: number } = {}): Drive {
  const dir = mkdtempSync(path.join(tmpdir(), "thumbdrive-test-"));
  const drive = new Drive(dir, options);
  after(() => {
    drive.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return drive;
}

export function testConfig(drive: Drive, overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ DATA_DIR: drive.dataDir }), ...overrides };
}

export function readerFor(drive: Drive, folders: string[], opts: { pageBytes?: number; pageRows?: number } = {}): Reader {
  return new Reader(drive, folders, "test", { pageBytes: opts.pageBytes ?? 65536, pageRows: opts.pageRows ?? 200 });
}

export function keysFor(drive: Drive): KeyStore {
  return new KeyStore(drive.db);
}

export const text = (s: string) => Buffer.from(s, "utf8");
