"""Ready-to-paste MCP client configs for a new key."""

import json
from urllib.parse import urlsplit


def snippets(mcp_url: str, key: str, name: str = "thumbdrive") -> list[tuple[str, str, str]]:
    """(label, hint, code) for Cursor, Claude Desktop, Claude Code and any other client."""
    remote = ["-y", "mcp-remote", mcp_url, "--header", "Authorization:${AUTH_HEADER}"]
    if mcp_url.startswith("http://") and urlsplit(mcp_url).hostname not in ("localhost", "127.0.0.1", "::1"):
        remote.append("--allow-http")
    cursor = {"mcpServers": {name: {"url": mcp_url, "headers": {"Authorization": f"Bearer {key}"}}}}
    claude = {"mcpServers": {name: {"command": "npx", "args": remote, "env": {"AUTH_HEADER": f"Bearer {key}"}}}}
    return [
        ("Cursor", "Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).", json.dumps(cursor, indent=2)),
        ("Claude Desktop", "Settings → Developer → Edit Config. Needs Node.js for npx.", json.dumps(claude, indent=2)),
        (
            "Claude Code",
            "Run once in a terminal.",
            f'claude mcp add --transport http {name} {mcp_url} --header "Authorization: Bearer {key}"',
        ),
        (
            "Other clients",
            "Any client that speaks Streamable HTTP.",
            f"URL:    {mcp_url}\nHeader: Authorization: Bearer {key}",
        ),
    ]
