/**
 * The MCP surface: four read-only file tools, plus CyberDrive lookup tools
 * (lookup_mac, search_oui_vendor, lookup_windows_event, search_windows_events,
 * lookup_control, search_controls, map_control) for keys granted the
 * matching dataset, and table tools (list_tables, describe_table, lookup_row,
 * query_table) over published tables inside the key's folders.
 * Agents can never change the drive; every tool is annotated readOnlyHint
 * and the server has no write path.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { type Reader, UsageError } from "../agent/reader.ts";
import type { DatasetReader } from "../cyberdrive/agent.ts";
import { CONTROLS_MAX_BATCH } from "../cyberdrive/controls.ts";
import { DatasetError } from "../cyberdrive/datasets.ts";
import { OUI_MAX_BATCH } from "../cyberdrive/oui.ts";
import { WINEVENT_MAX_BATCH } from "../cyberdrive/winevent.ts";
import { InvalidPathError } from "../storage/paths.ts";
import { DriveError, NotFoundError } from "../storage/drive.ts";
import { LOOKUP_MAX_BATCH, QUERY_MAX_LIMIT, QUERY_OPS, type TableReader } from "../tables/agent.ts";
import { TableError } from "../tables/store.ts";
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
    error instanceof DatasetError ||
    error instanceof TableError;
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

export function createMcpServer(reader: Reader, datasets?: DatasetReader, tables?: TableReader): McpServer {
  const hasTables = !!tables && reader.scope.folders.length > 0;
  const oui = datasets?.has("oui") ?? false;
  const winevent = datasets?.has("winevent") ?? false;
  const controls = datasets?.controlFrameworks() ?? [];
  const controlNames = controls.map((n) => (n === "nist80053" ? "NIST SP 800-53 Rev 5" : "NIST CSF 2.0")).join(" and ");
  const controlMap = datasets?.has("csf2map") ?? false;
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
        ...(winevent
          ? [
              "CyberDrive: lookup_windows_event explains Windows Security log event IDs from Microsoft's 2016 audit events catalog. Quote the citation;",
              "if a result says 'No match', say the catalog does not cover it (newer Windows 10/11 events and Sysmon are not in it) instead of guessing.",
            ]
          : []),
        ...(controls.length
          ? [
              `CyberDrive: lookup_control and search_controls read the official ${controlNames} text. Quote the control text and its citation rather than paraphrasing from memory;`,
              "if a result says 'No match' or withdrawn, say so (and name the replacement) instead of inventing a control.",
            ]
          : []),
        ...(controlMap
          ? ["CyberDrive: map_control gives NIST's CSF 2.0 to SP 800-53 informative references; these are supporting references, not equivalences."]
          : []),
        ...(hasTables
          ? [
              "Tables: list_tables shows the published tables you can see (inventories, IP plans...). Use lookup_row for a key value (hostname, IP, CIDR, MAC...) and query_table for filters.",
              "Quote the row citation (cyberdrive:/path@vN#rID). If a result says 'No match', say the table has no such row instead of guessing.",
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

  if (datasets && winevent) {
    server.registerTool(
      "lookup_windows_event",
      {
        title: "Explain Windows security event IDs",
        description: [
          `Look up 1-${WINEVENT_MAX_BATCH} Windows Security log event IDs (e.g. 4624, 4688) in the CyberDrive catalog of Microsoft's Windows Security Audit Events (2016).`,
          "Each result has result ('match', 'No match' or 'invalid'), audit category and subcategory (plus also_listed_under when the event sits under several),",
          "summary, minimum OS, every version's detailed message template (%1, %2... are insertion strings), and a citation like cyberdrive:winevent@v1#4624.",
          "The catalog predates some Windows 10/11 events and does not cover Sysmon or other logs.",
        ].join(" "),
        inputSchema: z.object({
          ids: z
            .array(z.union([z.number().int(), z.string().max(32)]))
            .min(1)
            .max(WINEVENT_MAX_BATCH)
            .describe("Event IDs, e.g. [4624, 4625] or ['4688']"),
        }),
        annotations: READ_ONLY,
      },
      async ({ ids }) => run(() => ok(json(datasets.lookupWindowsEvent(ids)))),
    );

    server.registerTool(
      "search_windows_events",
      {
        title: "Search Windows security events",
        description:
          "Search the CyberDrive Windows security events catalog: case-insensitive text in summaries, subcategories and detailed messages, optionally within one audit category (e.g. 'Logon/Logoff', 'Account Management'). Returns the total and up to `limit` events with citations; use lookup_windows_event for the full messages.",
        inputSchema: z.object({
          query: z.string().trim().max(100).optional().describe("Text to find, e.g. 'logon', 'Kerberos', 'audit log was cleared'"),
          category: z.string().trim().max(100).optional().describe("Audit category to search within, e.g. 'Logon/Logoff'"),
          limit: z.number().int().min(1).max(100).default(20).describe("Most events to return"),
        }),
        annotations: READ_ONLY,
      },
      async ({ query, category, limit }) => run(() => ok(json(datasets.searchWindowsEvents(query || undefined, category || undefined, limit)))),
    );
  }

  if (datasets && controls.length) {
    server.registerTool(
      "lookup_control",
      {
        title: "Look up security controls",
        description: [
          `Look up 1-${CONTROLS_MAX_BATCH} control IDs in the CyberDrive copy of ${controlNames} (NIST's official OSCAL catalogs).`,
          "IDs: SP 800-53 controls, enhancements and families (AC-2, ac-2(1), AC-2.1, AC-02(01), AC); CSF 2.0 subcategories, categories and functions (PR.AA-01, GV.OC, GV).",
          "Each result has result ('match', 'No match' or 'invalid'), framework, family/function, title, statement (parameters shown as [Assignment: ...] / [Selection: ...]),",
          "guidance (800-53 discussion) or implementation_examples (CSF), enhancements or children, related controls, withdrawn plus withdrawn_to, and a citation like cyberdrive:nist80053@v1#AC-2(1).",
        ].join(" "),
        inputSchema: z.object({
          ids: z.array(z.string().max(64)).min(1).max(CONTROLS_MAX_BATCH).describe("Control IDs, e.g. ['AC-2', 'IA-2(1)', 'PR.AA-01']"),
        }),
        annotations: READ_ONLY,
      },
      async ({ ids }) => run(() => ok(json(datasets.lookupControls(ids)))),
    );

    server.registerTool(
      "search_controls",
      {
        title: "Search security controls",
        description:
          `Search ${controlNames} in CyberDrive: case-insensitive text in IDs, titles, statements, guidance and CSF implementation examples, optionally within one framework (${controls.join(", ")}) and one family or function (e.g. 'AC', 'Access Control', 'PR'). Withdrawn items are left out unless include_withdrawn is true. Returns the total and up to \`limit\` hits with snippets and citations; use lookup_control for the full text.`,
        inputSchema: z.object({
          query: z.string().trim().max(100).optional().describe("Text to find, e.g. 'multi-factor', 'audit log', 'supply chain'"),
          framework: z.string().trim().max(32).optional().describe("Only this framework: 'nist80053' or 'csf2'"),
          family: z.string().trim().max(100).optional().describe("Only this 800-53 family or CSF function, e.g. 'IA' or 'PR'"),
          include_withdrawn: z.boolean().default(false).describe("Also return withdrawn controls"),
          limit: z.number().int().min(1).max(100).default(20).describe("Most hits to return"),
        }),
        annotations: READ_ONLY,
      },
      async ({ query, framework, family, include_withdrawn, limit }) =>
        run(() =>
          ok(
            json(
              datasets.searchControls(query || undefined, {
                framework: framework || undefined,
                family: family || undefined,
                includeWithdrawn: include_withdrawn,
                limit,
              }),
            ),
          ),
        ),
    );
  }

  if (datasets && controlMap) {
    server.registerTool(
      "map_control",
      {
        title: "Map CSF 2.0 and SP 800-53",
        description: [
          `Map 1-${CONTROLS_MAX_BATCH} IDs across frameworks using NIST's CSF 2.0 informative references to SP 800-53 Rev 5.`,
          "A CSF subcategory (PR.AA-01) returns its 800-53 controls; a category or function also includes its subcategories' (via).",
          "An 800-53 control (AC-2, AC-2(1)) returns the CSF outcomes that cite it, its base control (via 'base control AC-2') or its whole family (via 'whole family AC').",
          "These are supporting references, not equivalences. Each result has a citation like cyberdrive:csf2map@v1#PR.AA-01.",
        ].join(" "),
        inputSchema: z.object({
          ids: z.array(z.string().max(64)).min(1).max(CONTROLS_MAX_BATCH).describe("IDs, e.g. ['PR.AA-01'] or ['AC-2']"),
        }),
        annotations: READ_ONLY,
      },
      async ({ ids }) => run(() => ok(json(datasets.mapControls(ids)))),
    );
  }

  if (tables && hasTables) {
    const tableRef = z.string().trim().min(1).max(1100).describe("Table path, e.g. '/inventory/servers' (a citation like cyberdrive:/inventory/servers@v3 also works)");
    server.registerTool(
      "list_tables",
      {
        title: "List tables",
        description:
          "List the published tables you can see (optionally under a folder): path, title, description, latest version, row count, key column, columns and a citation. Drafts are never shown.",
        inputSchema: z.object({ path: z.string().max(1024).default("/").describe("Folder to list tables under (default: everything you can see)") }),
        annotations: READ_ONLY,
      },
      async ({ path }) => run(() => ok(json(tables.listTables(path)))),
    );

    server.registerTool(
      "describe_table",
      {
        title: "Describe table",
        description:
          "Columns (name, type, select options, which is the key), row count, latest version number, publish time and note of one table. Column types: text, longtext, number, date, checkbox, select, url, email, hostname, ip, cidr, mac, cve, control.",
        inputSchema: z.object({ table: tableRef }),
        annotations: READ_ONLY,
      },
      async ({ table }) => run(() => ok(json(tables.describeTable(table)))),
    );

    server.registerTool(
      "lookup_row",
      {
        title: "Look up rows by key",
        description: [
          `Look up 1-${LOOKUP_MAX_BATCH} values in a table's key column (latest published version).`,
          "Normalized by type: hostnames case-insensitive (a unique short name also matches its FQDN), MACs in any format, IPs canonical (IPv6 compressed), CVE and control IDs case-insensitive.",
          "In a table keyed by CIDR, an IP (or a smaller range) returns the containing range with the longest prefix.",
          "Each result has result ('match', 'No match', 'ambiguous' or 'invalid'), matched_by, and the row with its values and a citation like cyberdrive:/inventory/servers@v3#r12.",
          "MAC and control-ID cells get vendor / title context when you also hold the oui or NIST datasets.",
        ].join(" "),
        inputSchema: z.object({
          table: tableRef,
          values: z.array(z.string().max(300)).min(1).max(LOOKUP_MAX_BATCH).describe("Key values, e.g. ['web01.example.com'] or ['10.20.30.40']"),
        }),
        annotations: READ_ONLY,
      },
      async ({ table, values }) => run(() => ok(json(tables.lookupRow(table, values)))),
    );

    server.registerTool(
      "query_table",
      {
        title: "Query table",
        description: [
          "Filter a table's latest published version. Filters are ANDed; each is {column, op, value}.",
          `Operators: ${QUERY_OPS.join(", ")}. eq/neq/in are case-insensitive and normalize values by column type; contains/starts_with need text-like columns;`,
          "gt/lt need number or date (YYYY-MM-DD) columns; is_empty takes no value (value false means 'is not empty'); in takes a list.",
          `Returns total, rows (values plus citation), and next_offset for the next page (limit up to ${QUERY_MAX_LIMIT}). 'No match' when nothing matches.`,
        ].join(" "),
        inputSchema: z.object({
          table: tableRef,
          filters: z
            .array(
              z.object({
                column: z.string().max(100).describe("Column name"),
                op: z.enum(QUERY_OPS),
                value: z.union([z.string().max(300), z.number(), z.boolean(), z.array(z.union([z.string().max(300), z.number()])).max(100)]).optional(),
              }),
            )
            .max(20)
            .default([]),
          columns: z.array(z.string().max(100)).max(100).optional().describe("Only return these columns"),
          sort: z.object({ column: z.string().max(100), direction: z.enum(["asc", "desc"]).default("asc") }).optional(),
          limit: z.number().int().min(1).max(QUERY_MAX_LIMIT).default(50),
          offset: z.number().int().min(0).default(0),
        }),
        annotations: READ_ONLY,
      },
      async ({ table, ...opts }) => run(() => ok(json(tables.queryTable(table, opts)))),
    );
  }

  return server;
}
