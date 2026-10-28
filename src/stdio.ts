/**
 * stdio transport for local clients that launch the server as a subprocess.
 * The key comes from THUMBDRIVE_KEY and is checked once at startup. All logs
 * go to stderr; stdout belongs to the protocol.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Reader } from "./agent/reader.ts";
import { KeyStore } from "./auth/keys.ts";
import type { Config } from "./config.ts";
import { DatasetReader } from "./cyberdrive/agent.ts";
import { createDatasetStore } from "./cyberdrive/index.ts";
import { createMcpServer } from "./mcp/server.ts";
import { Drive } from "./storage/drive.ts";

export function startStdio(config: Config, key = process.env.THUMBDRIVE_KEY): void {
  const drive = new Drive(config.dataDir, { maxFileBytes: config.maxFileBytes });
  const record = new KeyStore(drive.db).verify(key);
  if (!record) {
    console.error("[thumbdrive] THUMBDRIVE_KEY is missing, unknown or revoked. Create one with: npm run admin -- key create <name> --folder /");
    process.exit(1);
  }
  const access = [...record.folders, ...record.datasets.map((d) => `dataset ${d}`)].join(", ");
  console.error(`[thumbdrive] stdio ready for key "${record.name}" (${access})`);
  const datasets = createDatasetStore(drive, config);
  const actor = `key:${record.name}`;
  serveStdio(() =>
    createMcpServer(
      new Reader(drive, record.folders, actor, {
        pageBytes: config.readPageBytes,
        pageRows: config.readPageRows,
      }),
      new DatasetReader(datasets, record.datasets, actor),
    ),
  );
}
