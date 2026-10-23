/**
 * The MCP surface: four read-only tools. Agents can never change the drive;
 * every tool is annotated readOnlyHint and the server has no write path.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { type Reader, UsageError } from "../agent/reader.ts";
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
    error instanceof DriveError;
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

export function createMcpServer(reader: Reader): McpServer {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    {
      instructions: [
        "Thumbdrive is a read-only shared drive. Folders you cannot see do not exist for you.",
        "Start with list (path '/'), then read files. Large files come back in pages: keep calling read with page+1 while has_more is true.",
        "Each read returns metadata JSON (including the file's sha256) followed by the content.",
        "You cannot change files; ask the person who runs the drive.",
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

  return server;
}
