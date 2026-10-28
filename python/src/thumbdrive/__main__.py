"""Command line: `thumbdrive` runs the server; `thumbdrive --dev` also seeds sample data."""

import argparse
import dataclasses
import os
import sys
from pathlib import Path

import uvicorn

from . import auth, keys
from .app import create_app
from .config import Config, from_env
from .table_templates import TEMPLATES
from .tables import Tables

DEV_PASSWORD = "thumbdrive-dev"
SAMPLES = {
    "/team/handbook.md": "# Team handbook\n\nWelcome! Deploys happen on Tuesdays.\nAsk in #ops for access.\n",
    "/team/contacts.csv": "name,role\nAda,engineering\nGrace,operations\n",
    "/research/notes.txt": "Thumbdrive notes\nSearch uses SQLite FTS5 with the trigram tokenizer.\n",
    "/private/secret.txt": "Not visible to the dev key.\n",
}


SERVERS = [
    ("web-01.example.com", "10.0.1.10", "production", "Debian 12", "Front end"),
    ("web-02.example.com", "10.0.1.11", "production", "Debian 12", ""),
    ("db-01.example.com", "10.0.2.20", "production", "Ubuntu 24.04", "Primary database"),
    ("build-01.example.com", "10.0.3.300", "test", "Ubuntu 24.04", "Typo in the IP: fix it before publishing"),
]
IP_PLAN = [
    ("10.0.1.0/24", 10, "Web", "Public web servers"),
    ("10.0.2.0/24", 20, "Data", "Databases"),
    ("10.0.3.0/24", 30, "Build", "CI runners"),
]


def seed_tables(tables: Tables) -> None:
    """A servers table with a draft change and one invalid IP, and an IP plan with two versions."""
    if tables.by_path("/team/servers") is None:
        t = tables.create("/team/servers", TEMPLATES["servers"]["columns"], TEMPLATES["servers"]["description"])
        ids = [t.column_named(n)["id"] for n in ("Hostname", "IP address", "Environment", "OS", "Notes")]
        tables.edit(t, adds=[{"values": dict(zip(ids, row, strict=True))} for row in SERVERS[:3]])
        tables.publish(t, "Initial inventory")
        tables.edit(
            t,
            updates=[{"row": 2, "values": {ids[3]: "Debian 13"}}],
            adds=[{"values": dict(zip(ids, SERVERS[3], strict=True))}],
        )
    if tables.by_path("/team/ip-plan") is None:
        t = tables.create("/team/ip-plan", TEMPLATES["ip-plan"]["columns"], TEMPLATES["ip-plan"]["description"])
        ids = [t.column_named(n)["id"] for n in ("CIDR", "VLAN ID", "Name", "Purpose")]
        tables.edit(t, adds=[{"values": dict(zip(ids, row, strict=True))} for row in IP_PLAN[:2]])
        tables.publish(t, "Web and data VLANs")
        tables.edit(t, adds=[{"values": dict(zip(ids, IP_PLAN[2], strict=True))}])
        tables.publish(t, "Add the build VLAN")


def seed(app_state: object, config: Config) -> None:
    """Sample files, an admin password and a key for /team and /research (dev only)."""
    drive, db = app_state.drive, app_state.db  # type: ignore[attr-defined]
    for path, text in SAMPLES.items():
        if drive.kind(path) is None:
            drive.put(path, text.encode())
    seed_tables(app_state.tables)  # type: ignore[attr-defined]
    if not auth.has_password(db):
        auth.set_password(db, DEV_PASSWORD)
    key_file = config.data_dir / "dev-key.txt"
    if not key_file.exists():
        key_file.write_text(keys.create(db, "dev", ["/team", "/research"]) + "\n")
    print(f"[dev] admin password: {DEV_PASSWORD}   key for /team and /research: {key_file.read_text().strip()}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="thumbdrive", description="Read-only MCP drive for agents.")
    parser.add_argument("--dev", action="store_true", help="use ./dev-data and seed sample files and a key")
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[union-attr]  # docker logs and nohup pipe stdout
    config = from_env()
    if args.dev and "DATA_DIR" not in os.environ:
        config = dataclasses.replace(config, data_dir=Path("dev-data"))
    app = create_app(config)
    if args.dev:
        seed(app.state, config)
    elif not auth.has_password(app.state.db):
        print(f"[thumbdrive] No admin password yet: open http://{config.host}:{config.port}/setup to set one.")
    print(f"[thumbdrive] Web UI http://{config.host}:{config.port}/  MCP http://{config.host}:{config.port}/mcp")
    uvicorn.run(app, host=config.host, port=config.port, log_level="info", proxy_headers=False)


if __name__ == "__main__":
    main()
