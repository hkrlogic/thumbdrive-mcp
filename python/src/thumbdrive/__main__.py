"""Command line: `thumbdrive` runs the server; `thumbdrive --dev` also seeds sample data."""

import argparse
import dataclasses
import os
from pathlib import Path

import uvicorn

from . import auth, keys
from .app import create_app
from .config import Config, from_env

DEV_PASSWORD = "thumbdrive-dev"
SAMPLES = {
    "/team/handbook.md": "# Team handbook\n\nWelcome! Deploys happen on Tuesdays.\nAsk in #ops for access.\n",
    "/team/contacts.csv": "name,role\nAda,engineering\nGrace,operations\n",
    "/research/notes.txt": "Thumbdrive notes\nSearch uses SQLite FTS5 with the trigram tokenizer.\n",
    "/private/secret.txt": "Not visible to the dev key.\n",
}


def seed(app_state: object, config: Config) -> None:
    """Sample files, an admin password and a key for /team and /research (dev only)."""
    drive, db = app_state.drive, app_state.db  # type: ignore[attr-defined]
    for path, text in SAMPLES.items():
        if drive.kind(path) is None:
            drive.put(path, text.encode())
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
