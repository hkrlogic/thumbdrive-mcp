/**
 * Admin CLI, next to the web UI. Run it as `npm run admin -- <command>` from a
 * checkout, or `node dist/admin.js <command>` inside the container. Writes go
 * through the same Drive code as the UI, so every change is versioned and checksummed.
 *
 *   npm run admin -- put <local-file> <drive-path>
 *   npm run admin -- import <local-folder> <drive-folder>
 *   npm run admin -- mkdir <drive-path>
 *   npm run admin -- rm <drive-path>
 *   npm run admin -- mv <drive-path> <new-drive-path>
 *   npm run admin -- ls [drive-path]
 *   npm run admin -- history <drive-path>
 *   npm run admin -- restore <drive-path> <version>
 *   npm run admin -- key create <name> [--folder <drive-folder> ...] [--dataset oui|winevent|nist80053|csf2|csf2map ...]
 *   npm run admin -- key datasets <name> [dataset ...]
 *   npm run admin -- key list
 *   npm run admin -- key revoke <name>
 *   npm run admin -- activity [count]
 *   npm run admin -- cyberdrive oui import [path-or-url]   (no argument: the default source URL)
 *   npm run admin -- cyberdrive oui status
 *   npm run admin -- cyberdrive oui lookup <mac> [mac ...]
 *   npm run admin -- cyberdrive oui search <vendor>
 *   npm run admin -- cyberdrive winevent import [path-or-url] | status
 *   npm run admin -- cyberdrive winevent lookup <event-id> [event-id ...]
 *   npm run admin -- cyberdrive winevent search <text> [--category <category>]
 *   npm run admin -- cyberdrive nist80053|csf2 import [path-or-url] | status
 *   npm run admin -- cyberdrive nist80053|csf2 lookup <control-id> [control-id ...]
 *   npm run admin -- cyberdrive nist80053|csf2 search [text] [--family <family>] [--withdrawn]
 *   npm run admin -- cyberdrive csf2map import [path-or-url] | status
 *   npm run admin -- cyberdrive csf2map map <control-id> [control-id ...]
 *   npm run admin -- set-password          (prompts; or pipe the password on stdin)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { KeyStore } from "./auth/keys.ts";
import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";
import { ControlLookup } from "./cyberdrive/controls.ts";
import { DATASET_NAMES, isDatasetName } from "./cyberdrive/datasets.ts";
import { createDatasetStore } from "./cyberdrive/index.ts";
import { OuiLookup } from "./cyberdrive/oui.ts";
import { WinEventLookup } from "./cyberdrive/winevent.ts";
import { moveEntry } from "./ops.ts";
import { Drive } from "./storage/drive.ts";
import { joinDrivePath, normalizeDrivePath } from "./storage/paths.ts";
import { AdminAuth } from "./web/auth.ts";

const USAGE = [
  "put <local-file> <drive-path>",
  "import <local-folder> <drive-folder>",
  "mkdir <drive-path>",
  "rm <drive-path>",
  "mv <drive-path> <new-drive-path>",
  "ls [drive-path]",
  "history <drive-path>",
  "restore <drive-path> <version>",
  "key create <name> [--folder <drive-folder> ...] [--dataset <dataset> ...]",
  "key datasets <name> [dataset ...]      (replace a key's datasets; none clears them)",
  "key list",
  "key revoke <name>",
  "activity [count]",
  `cyberdrive <${DATASET_NAMES.join("|")}> import [path-or-url]`,
  `cyberdrive <${DATASET_NAMES.join("|")}> status`,
  "cyberdrive oui lookup <mac> [mac ...]",
  "cyberdrive oui search <vendor>",
  "cyberdrive winevent lookup <event-id> [event-id ...]",
  "cyberdrive winevent search [text] [--category <category>]",
  "cyberdrive nist80053|csf2 lookup <control-id> [control-id ...]   (e.g. AC-2 IA-2(1) PR.AA-01)",
  "cyberdrive nist80053|csf2 search [text] [--family <family>] [--withdrawn]",
  "cyberdrive csf2map map <control-id> [control-id ...]",
  "set-password",
]
  .map((line) => `  admin ${line}`)
  .join("\n");

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(`Usage:\n${USAGE}`);
  process.exit(2);
}

function importFolder(drive: Drive, localDir: string, driveDir: string): number {
  let count = 0;
  drive.makeFolder(driveDir);
  for (const dirent of readdirSync(localDir, { withFileTypes: true })) {
    if (dirent.name.startsWith(".")) continue;
    const local = path.join(localDir, dirent.name);
    const target = joinDrivePath(normalizeDrivePath(driveDir), dirent.name);
    if (dirent.isDirectory()) count += importFolder(drive, local, target);
    else if (dirent.isFile()) {
      drive.putFile(target, readFileSync(local));
      count++;
    }
  }
  return count;
}

/** Read one line: hidden when typed at a terminal, otherwise the first line of stdin. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const muted = rl as unknown as { _writeToOutput: (s: string) => void };
  let prompted = false;
  muted._writeToOutput = (s: string) => {
    if (!prompted) {
      process.stdout.write(s);
      prompted = true;
    }
  };
  const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
  rl.close();
  process.stdout.write("\n");
  return answer;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") usage();
  const config = loadConfig();
  const drive = new Drive(config.dataDir, { maxFileBytes: config.maxFileBytes });
  const keys = new KeyStore(drive.db);
  try {
    switch (command) {
      case "put": {
        const [local, target] = rest;
        if (!local || !target) usage("put needs <local-file> <drive-path>");
        const row = drive.putFile(target, readFileSync(local));
        console.log(`${normalizeDrivePath(target)} v${row.version} ${row.size} bytes sha256 ${row.sha256}`);
        break;
      }
      case "import": {
        const [local, target] = rest;
        if (!local || !target || !statSync(local).isDirectory()) usage("import needs <local-folder> <drive-folder>");
        console.log(`Imported ${importFolder(drive, local, target)} file(s) into ${normalizeDrivePath(target)}`);
        break;
      }
      case "mkdir": {
        if (!rest[0]) usage("mkdir needs <drive-path>");
        console.log(`Created ${drive.makeFolder(rest[0])}`);
        break;
      }
      case "rm": {
        if (!rest[0]) usage("rm needs <drive-path>");
        const row = drive.deleteFile(rest[0]);
        console.log(`Deleted ${normalizeDrivePath(rest[0])} (recorded as v${row.version}; earlier versions kept)`);
        break;
      }
      case "mv": {
        const [from, to] = rest;
        if (!from || !to) usage("mv needs <drive-path> <new-drive-path>");
        const target = moveEntry(drive, keys, normalizeDrivePath(from), normalizeDrivePath(to));
        console.log(`Moved ${normalizeDrivePath(from)} to ${target}`);
        break;
      }
      case "set-password": {
        const auth = new AdminAuth(drive.db);
        const password = await readSecret("New admin password: ");
        if (process.stdin.isTTY && (await readSecret("Repeat it: ")) !== password) {
          throw new Error("The passwords do not match");
        }
        await auth.setPassword(password);
        drive.logActivity("admin", "password", null, "set with the CLI");
        console.log("Admin password saved. All web sessions were signed out.");
        break;
      }
      case "ls": {
        for (const e of drive.list(rest[0] ?? "/")) {
          console.log(e.type === "folder" ? `${e.name}/` : `${e.name}\t${e.size} bytes\t${e.sha256?.slice(0, 12)}`);
        }
        break;
      }
      case "history": {
        if (!rest[0]) usage("history needs <drive-path>");
        for (const v of drive.history(rest[0])) {
          console.log(`v${v.version}\t${v.action}\t${v.created_at}\t${v.actor}\t${v.size ?? "-"}\t${v.sha256 ?? "-"}`);
        }
        break;
      }
      case "restore": {
        const [target, version] = rest;
        if (!target || !version) usage("restore needs <drive-path> <version>");
        const row = drive.restoreVersion(target, Number(version));
        console.log(`Restored ${normalizeDrivePath(target)} from v${version} as v${row.version}`);
        break;
      }
      case "key": {
        const [sub, name, ...flags] = rest;
        if (sub === "create") {
          if (!name) usage("key create needs <name>");
          const folders: string[] = [];
          const datasets: string[] = [];
          for (let i = 0; i < flags.length; i++) {
            if (flags[i] === "--folder" && flags[i + 1]) folders.push(flags[++i]);
            else if (flags[i] === "--dataset" && flags[i + 1]) datasets.push(flags[++i]);
            else usage(`Unknown option ${flags[i]}`);
          }
          if (folders.length === 0 && datasets.length === 0) {
            usage("key create needs at least one --folder (use / for the whole drive) or --dataset");
          }
          const { key, record } = keys.create(name, folders, datasets);
          const access = [...record.folders, ...record.datasets.map((d) => `cyberdrive:${d}`)];
          drive.logActivity("admin", "key.create", null, `${record.name}: ${access.join(", ")}`);
          console.log(`Key "${record.name}" (read-only) for ${access.join(", ")}`);
          console.log(`\n  ${key}\n`);
          console.log("Copy it now; it is stored hashed and cannot be shown again.");
        } else if (sub === "list") {
          for (const k of keys.list()) {
            const state = k.revoked_at ? `revoked ${k.revoked_at}` : `last used ${k.last_used_at ?? "never"}`;
            const access = [...k.folders, ...k.datasets.map((d) => `cyberdrive:${d}`)].join(",");
            console.log(`${k.name}\t${k.prefix}…\t${access}\t${state}`);
          }
        } else if (sub === "datasets") {
          if (!name) usage("key datasets needs <name>");
          const record = keys.list().find((k) => k.name === name && !k.revoked_at);
          if (!record) throw new Error(`No active key named ${name}`);
          const updated = keys.setDatasets(record.id, flags);
          drive.logActivity("admin", "key.folders", null, `${updated.name}: datasets ${updated.datasets.join(", ") || "none"}`);
          console.log(`${updated.name} datasets: ${updated.datasets.join(", ") || "none"}`);
        } else if (sub === "revoke") {
          if (!name) usage("key revoke needs <name>");
          console.log(keys.revoke(name) ? `Revoked ${name}` : `No active key named ${name}`);
        } else usage(`Unknown key command ${sub ?? ""}`);
        break;
      }
      case "activity": {
        const rows = drive.recentActivity(Number(rest[0] ?? 50)).reverse();
        for (const a of rows) console.log(`${a.at}\t${a.actor}\t${a.action}\t${a.path ?? ""}\t${a.detail ?? ""}`);
        break;
      }
      case "cyberdrive": {
        const [name, sub, ...args] = rest;
        if (!name || !isDatasetName(name)) usage(`cyberdrive needs a dataset: ${DATASET_NAMES.join(", ")}`);
        const datasets = createDatasetStore(drive, config);
        if (sub === "import") {
          const row = await datasets.importFrom(name, args[0], "admin");
          console.log(
            `Imported ${name} v${row.version}: ${row.rows} ${datasets.kind(name).unit}${row.skipped ? ` (${row.skipped} skipped)` : ""} from ${row.source}\nsha256 ${row.sha256}`,
          );
        } else if (sub === "status") {
          const history = datasets.history(name, 10);
          if (history.length === 0) console.log(`${name}: not imported yet`);
          for (const h of history) console.log(`v${h.version}\t${h.imported_at}\t${h.rows} ${datasets.kind(name).unit}\t${h.actor}\t${h.source}\t${h.sha256}`);
        } else if (sub === "lookup" && name === "oui") {
          if (args.length === 0) usage("cyberdrive oui lookup needs <mac>");
          console.log(JSON.stringify(new OuiLookup(datasets).lookup(args), null, 2));
        } else if (sub === "search" && name === "oui") {
          if (!args[0]) usage("cyberdrive oui search needs <vendor>");
          console.log(JSON.stringify(new OuiLookup(datasets).searchVendor(args.join(" ")), null, 2));
        } else if (sub === "lookup" && name === "winevent") {
          if (args.length === 0) usage("cyberdrive winevent lookup needs <event-id>");
          console.log(JSON.stringify(new WinEventLookup(datasets).lookup(args), null, 2));
        } else if (sub === "search" && name === "winevent") {
          const at = args.indexOf("--category");
          const category = at >= 0 ? args[at + 1] : undefined;
          const words = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
          console.log(JSON.stringify(new WinEventLookup(datasets).search(words.join(" ") || undefined, { category }), null, 2));
        } else if (sub === "lookup" && (name === "nist80053" || name === "csf2")) {
          if (args.length === 0) usage(`cyberdrive ${name} lookup needs <control-id>`);
          console.log(JSON.stringify(new ControlLookup(datasets).lookup(args), null, 2));
        } else if (sub === "search" && (name === "nist80053" || name === "csf2")) {
          const at = args.indexOf("--family");
          const family = at >= 0 ? args[at + 1] : undefined;
          const words = (at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args).filter((a) => a !== "--withdrawn");
          const includeWithdrawn = args.includes("--withdrawn");
          console.log(
            JSON.stringify(new ControlLookup(datasets).search(words.join(" ") || undefined, { framework: name, family, includeWithdrawn }), null, 2),
          );
        } else if (sub === "map" && name === "csf2map") {
          if (args.length === 0) usage("cyberdrive csf2map map needs <control-id>");
          console.log(JSON.stringify(new ControlLookup(datasets).map(args), null, 2));
        } else usage(`Unknown cyberdrive command ${sub ?? ""}`);
        break;
      }
      default:
        usage(`Unknown command ${command}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    drive.close();
  }
}

void main(process.argv.slice(2));
