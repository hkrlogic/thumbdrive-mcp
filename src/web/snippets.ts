/** Ready-to-paste client configs for a new key, using the URL the admin reached the server on. */

export interface Snippet {
  id: string;
  label: string;
  hint: string;
  code: string;
}

function isLoopbackUrl(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function connectionSnippets(mcpUrl: string, key: string, serverName = "thumbdrive"): Snippet[] {
  const url = new URL(mcpUrl);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: mcp-remote expands ${AUTH_HEADER} from env itself
  const remoteArgs = ["-y", "mcp-remote", mcpUrl, "--header", "Authorization:${AUTH_HEADER}"];
  if (url.protocol === "http:" && !isLoopbackUrl(url)) remoteArgs.push("--allow-http");
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  return [
    {
      id: "cursor",
      label: "Cursor",
      hint: "Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).",
      code: json({ mcpServers: { [serverName]: { url: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } }),
    },
    {
      id: "claude",
      label: "Claude Desktop",
      hint: "Settings → Developer → Edit Config (claude_desktop_config.json). Needs Node.js for npx.",
      code: json({
        mcpServers: {
          [serverName]: { command: "npx", args: remoteArgs, env: { AUTH_HEADER: `Bearer ${key}` } },
        },
      }),
    },
    {
      id: "claude-code",
      label: "Claude Code",
      hint: "Run once in a terminal.",
      code: `claude mcp add --transport http ${serverName} ${mcpUrl} --header "Authorization: Bearer ${key}"`,
    },
    {
      id: "generic",
      label: "Other clients",
      hint: "Any client that speaks Streamable HTTP.",
      code: `URL:    ${mcpUrl}\nHeader: Authorization: Bearer ${key}`,
    },
  ];
}
