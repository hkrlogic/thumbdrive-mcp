"""Settings, all read from environment variables once at start."""

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Config:
    host: str = "127.0.0.1"
    port: int = 8484
    data_dir: Path = Path("data")
    admin_password: str = ""
    public_url: str = ""  # e.g. https://drive.example.com, used in snippets and the host check
    allowed_hosts: list[str] = field(default_factory=list)
    max_file_mb: int = 50
    read_page_bytes: int = 65536

    @property
    def public_host(self) -> str:
        return (urlsplit(self.public_url).hostname or "") if self.public_url else ""

    @property
    def secure_cookies(self) -> bool:
        return self.public_url.startswith("https://")


def from_env(env: dict[str, str] | None = None) -> Config:
    e = dict(os.environ if env is None else env)
    hosts = [h.strip().lower() for h in e.get("ALLOWED_HOSTS", "").split(",") if h.strip()]
    return Config(
        host=e.get("THUMBDRIVE_HOST", "127.0.0.1"),
        port=int(e.get("THUMBDRIVE_PORT", "8484")),
        data_dir=Path(e.get("DATA_DIR", "data")),
        admin_password=e.get("THUMBDRIVE_ADMIN_PASSWORD", ""),
        public_url=e.get("THUMBDRIVE_PUBLIC_URL", "").rstrip("/"),
        allowed_hosts=hosts,
        max_file_mb=int(e.get("MAX_FILE_MB", "50")),
        read_page_bytes=int(e.get("READ_PAGE_BYTES", "65536")),
    )
