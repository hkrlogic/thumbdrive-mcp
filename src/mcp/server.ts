/**
 * The MCP surface: four read-only file tools, plus CyberDrive lookup tools
 * (lookup_mac, search_oui_vendor) for keys granted the matching dataset.
 * Agents can never change the drive; every tool is annotated readOnlyHint
 * and the server has no write path.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { type Reader, UsageError } from "../agent/reader.ts";
import type { DatasetReader } from "../cyberdrive/agent.ts";
import { DatasetError } from "../cyberdrive/datasets.ts";
import { OUI_MAX_BATCH } from "../cyberdrive/oui.ts";
import { InvalidPathError } from "../storage/paths.ts";
import { DriveError, NotFoundError } from "../storage/drive.ts";
import { APP_NAME, APP_VERSION } from "../version.ts";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(...texts: string[]): ToolResult {
  return { content: texts.map((text) => ({ type: "text" as const, text })) };
}

function fail(error: unknown): ToolResult {
  // Not-found, bad paths and unsupported formats are the caller's to fix; say so plainly.
  // Anything else is reported generically so internals do not leak.
  const known =
    error instanceof NotFoundError ||
    error instanceof InvalidPathError ||
    error instanceof UsageError ||
    error instanceof DriveError ||
    error instanceof DatasetError;
  const message = known && error instanceof Error ? error.message : "Internal error";
  if (!known) console.error("[thumbdrive] tool error:", error);
  return { content: [{ type: "text", text: message }], isError: true };
}

function run(fn: () => ToolResult): ToolResult {
  try {
    return fn();
  } catch (error) {
    return fail(error);
  }
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function createMcpServer(reader: Reader, datasets?: DatasetReader): McpServer {
  const oui = datasets?.has("oui") ?? false;
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    {
      instructions: [
        "Thumbdrive is a read-only shared drive. Folders you cannot see do not exist for you.",
        "Start with list (path '/'), then read files. Large files come back in pages: keep calling read with page+1 while has_more is true.",
        "Each read returns metadata JSON (including the file's sha256) followed by the content.",
        "You cannot change files; ask the person who runs the drive.",
        ...(oui
          ? [
              "CyberDrive: lookup_mac resolves MAC addresses to their IEEE registrant (OUI). Quote the returned citation;",
              "if a result says 'No match' or 'locally administered', say so instead of guessing a vendor.",
            ]
          : []),
      ].join(" "),
    },
  );

  server.registerTool(
    "list",
    {
      title: "List folder",
      description:
        "List the files and folders in a folder on the drive. Returns name, path, type, size, sha256 and modified time. Use path '/' to start.",
      inputSchema: z.object({
        path: z.string().max(1024).default("/").describe("Folder path, e.g. '/' or '/reports/2026'"),
      }),
      annotations: READ_ONLY,
    },
    async ({ path }) => run(() => ok(json(reader.list(path)))),
  );

  server.registerTool(
    "read",
    {
      title: "Read file",
      description: [
        "Read a file in pages.",
        "format 'raw' (default) returns the bytes: UTF-8 text for text files, base64 for binary files or when base64 is true.",
        "format 'text' returns an extracted text view: CSV/TSV as JSON rows (header repeated on every page), plain text as text.",
        "Returns two text blocks: metadata JSON (path, version, size, sha256, mime, page, pages, has_more, encoding), then the content.",
        "Pass version to read an earlier version from history.",
      ].join(" "),
      inputSchema: z.object({
        path: z.string().max(1024).describe("File path, e.g. '/reports/q3.csv'"),
        format: z.enum(["raw", "text"]).default("raw").describe("'raw' bytes or 'text' extracted view"),
        page: z.number().int().min(1).default(1).describe("1-based page number"),
        version: z.number().int().min(1).optional().describe("Read this version from history instead of the current file"),
        base64: z.boolean().default(false).describe("Return raw content as base64 even if it is text"),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(() => {
        const { meta, content } = reader.read(args);
        return ok(json(meta), content);
      }),
  );

  server.registerTool(
    "search",
    {
      title: "Search drive",
      description:
        "Find files and folders whose name or text content contains the query (case-insensitive). Returns up to 50 hits with the first matching line per file.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200).describe("Text to look for"),
        path: z.string().max(1024).default("/").describe("Folder to search in (default: everything you can see)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, path }) => run(() => ok(json(reader.search(query, path)))),
  );

  server.registerTool(
    "history",
    {
      title: "File history",
      description:
        "List the stored versions of a file, newest first: version, action (put or delete), sha256, size, who and when. Read an old version with read(path, version).",
      inputSchema: z.object({
        path: z.string().max(1024).describe("File path"),
      }),
      annotations: READ_ONLY,
    },
    async ({ path }) => run(() => ok(json(reader.history(path)))),
  );

  if (datasets && oui) {
    server.registerTool(
      "lookup_mac",
      {
        title: "Look up MAC vendor (OUI)",
        description: [
          `Look up 1-${OUI_MAX_BATCH} MAC addresses or prefixes in the CyberDrive OUI database (IEEE MA-L, MA-M, MA-S, IAB, CID plus Wireshark/Nmap names).`,
          "Accepts 00:1A:2B:3C:4D:5E, 00-1a-2b-3c-4d-5e, 001a.2b3c.4d5e, 001A2B3C4D5E or a 6+ digit prefix like 001A2B.",
          "Longest-prefix match (MA-S/IAB 36-bit, then MA-M 28-bit, then MA-L/CID 24-bit).",
          "Each result has result ('match', 'No match', 'locally administered', 'broadcast' or 'invalid'), the matched entry",
          "(manufacturer, registry, short_name, device_type, registered_date, address, status, deregistered_date, sources, matched_prefix),",
          "a citation like cyberdrive:oui@v3#00:00:0C, and locally_administered / multicast flags.",
          "Locally administered (random/private) MACs get a note instead of a vendor.",
        ].join(" "),
        inputSchema: z.object({
          macs: z
            .array(z.string().max(64))
            .min(1)
            .max(OUI_MAX_BATCH)
            .describe("MAC addresses or prefixes, e.g. ['00:00:0C:12:34:56', '8c1f.64af.a000']"),
        }),
        annotations: READ_ONLY,
      },
      async ({ macs }) => run(() => ok(json(datasets.lookupMac(macs)))),
    );

    server.registerTool(
      "search_oui_vendor",
      {
        title: "Find a vendor's MAC prefixes",
        description:
          "Search the CyberDrive OUI database by vendor name (case-insensitive substring of manufacturer or short name). Returns the total count and up to `limit` prefixes with citations.",
        inputSchema: z.object({
          query: z.string().trim().min(2).max(100).describe("Vendor name, e.g. 'Cisco' or 'Raspberry'"),
          limit: z.number().int().min(1).max(100).default(25).describe("Most prefixes to return"),
        }),
        annotations: READ_ONLY,
      },
      async ({ query, limit }) => run(() => ok(json(datasets.searchOuiVendor(query, limit)))),
    );
  }

  return server;
}
