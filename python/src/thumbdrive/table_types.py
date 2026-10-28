"""Column types for tables, and the one validator every cell goes through.

`check` returns (canonical value, None) or (the input as typed, error message).
Drafts keep invalid input as typed so nothing is lost; publishing refuses while any remain.
Canonical values are what agents see and compare, and `check` accepts them unchanged.
"""

import datetime
import ipaddress
import re
from urllib.parse import urlsplit

Value = str | int | float | bool | None

TYPES = {
    "text": "Text",
    "longtext": "Long text",
    "number": "Number",
    "date": "Date",
    "checkbox": "Checkbox",
    "select": "Single select",
    "url": "URL",
    "email": "Email",
    "hostname": "Hostname",
    "ip": "IP address",
    "cidr": "CIDR range",
    "mac": "MAC address",
}
KEY_TYPES = frozenset(TYPES) - {"longtext", "checkbox"}
MAX_TEXT, MAX_LONGTEXT, MAX_OPTIONS = 2000, 20000, 100

_LABEL = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
_EMAIL = re.compile(r'[^\s@<>()\[\]\\,;:"]+@[^\s@<>()\[\]\\,;:"]+\.[^\s@<>()\[\]\\,;:"]+')
_INT = re.compile(r"[+-]?\d+")
_NUMBER = re.compile(r"[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?", re.I)
_THOUSANDS = re.compile(r"[+-]?\d{1,3}(,\d{3})+(\.\d+)?")
_DATE = re.compile(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})")
_MAC_SEPARATORS = re.compile(r"[:\-.\s]")
_TRUE = {"true", "yes", "y", "1", "x", "✓", "checked", "on"}
_FALSE = {"false", "no", "n", "0", "unchecked", "off"}


def check(column: dict, raw: object) -> tuple[Value, str | None]:
    """Validate one cell. Empty input is always valid and becomes None."""
    if raw is None:
        return None, None
    kind = column["type"]
    if isinstance(raw, bool):
        return (raw, None) if kind == "checkbox" else check(column, "true" if raw else "false")
    if isinstance(raw, int | float):
        if kind == "number":
            return raw, None
        if kind == "checkbox" and raw in (0, 1):
            return raw == 1, None
        raw = str(raw)
    if not isinstance(raw, str):
        return None, "unsupported value"
    text = raw.replace("\r\n", "\n").replace("\r", "\n") if kind == "longtext" else raw.strip()
    if not text.strip():
        return None, None
    try:
        return _canonical(kind, column.get("options") or [], text), None
    except ValueError as e:
        return text, str(e)


def _canonical(kind: str, options: list[str], text: str) -> Value:  # noqa: C901 - one branch per type reads best
    if kind == "text":
        if len(text) > MAX_TEXT:
            raise ValueError(f"longer than {MAX_TEXT} characters; use a Long text column")
        return text
    if kind == "longtext":
        if len(text) > MAX_LONGTEXT:
            raise ValueError(f"longer than {MAX_LONGTEXT} characters")
        return text
    if kind == "number":
        s = text.replace(",", "") if _THOUSANDS.fullmatch(text) else text
        if _INT.fullmatch(s):
            return int(s)
        if not _NUMBER.fullmatch(s):
            raise ValueError("not a number")
        return float(s)
    if kind == "date":
        m = _DATE.fullmatch(text)
        if not m:
            raise ValueError("use YYYY-MM-DD")
        try:
            return datetime.date(int(m[1]), int(m[2]), int(m[3])).isoformat()
        except ValueError:
            raise ValueError("not a real calendar date") from None
    if kind == "checkbox":
        if text.lower() in _TRUE:
            return True
        if text.lower() in _FALSE:
            return False
        raise ValueError("use yes or no")
    if kind == "select":
        for option in options:
            if option.casefold() == text.casefold():
                return option
        raise ValueError(f"not one of: {', '.join(options)}" if options else "this column has no options yet")
    if kind == "url":
        parts = urlsplit(text)
        if parts.scheme not in ("http", "https") or not parts.netloc or any(c.isspace() for c in text):
            raise ValueError("not a URL; include http:// or https://")
        if len(text) > 2048:
            raise ValueError("longer than 2048 characters")
        return text
    if kind == "email":
        if len(text) > 254 or not _EMAIL.fullmatch(text):
            raise ValueError("not an email address")
        local, domain = text.rsplit("@", 1)
        return f"{local}@{domain.lower()}"
    if kind == "hostname":
        return hostname(text)
    if kind == "ip":
        return str(ip_address(text))
    if kind == "cidr":
        return str(network(text))
    if kind == "mac":
        digits = _MAC_SEPARATORS.sub("", text)
        if not re.fullmatch(r"[0-9A-Fa-f]{12}", digits):
            raise ValueError("not a MAC address (12 hex digits, e.g. 00:1A:2B:3C:4D:5E)")
        return ":".join(digits[i : i + 2] for i in range(0, 12, 2)).upper()
    raise ValueError(f"unknown column type {kind}")


def hostname(text: str) -> str:
    s = text.strip().lower().removesuffix(".")
    if _is_ip(s):
        raise ValueError("that is an IP address, not a hostname")
    if not s or len(s) > 253 or not all(_LABEL.fullmatch(label) for label in s.split(".")):
        raise ValueError("use letters, digits and hyphens; labels of 1-63 characters separated by dots")
    return s


def ip_address(text: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    s = text.strip()
    if "/" in s:
        raise ValueError("that is a CIDR range; use a CIDR column")
    if "%" in s:
        raise ValueError("zone IDs are not supported")
    try:
        return ipaddress.ip_address(s)
    except ValueError:
        raise ValueError("not a valid IPv4 or IPv6 address") from None


def network(text: str) -> ipaddress.IPv4Network | ipaddress.IPv6Network:
    s = text.strip()
    if "/" not in s:
        raise ValueError("needs a prefix length, e.g. 10.0.0.0/24")
    address, _, length = s.partition("/")
    ip = ip_address(address)
    if not length.isdigit() or int(length) > ip.max_prefixlen:
        raise ValueError(f"prefix length must be 0-{ip.max_prefixlen}")
    try:
        return ipaddress.ip_network(f"{ip}/{int(length)}")
    except ValueError:
        fixed = ipaddress.ip_network(f"{ip}/{int(length)}", strict=False)
        raise ValueError(f"host bits are set; did you mean {fixed}?") from None


def _is_ip(text: str) -> bool:
    try:
        ipaddress.ip_address(text)
    except ValueError:
        return False
    return True


def key_of(value: Value) -> str | None:
    """How key column values are compared for uniqueness and lookups (case-insensitive)."""
    return None if value is None or value == "" else str(value).casefold()


def suggest(header: str, values: list[str]) -> str:
    """A column type for imported data: the header's hint if most values fit, else the strictest type all fit."""
    filled = [v for v in values if v.strip()]

    def share(kind: str) -> float:
        column = {"type": kind}
        return sum(check(column, v)[1] is None for v in filled) / len(filled) if filled else 0.0

    words_in_header = set(re.split(r"[^a-z0-9]+", header.casefold()))
    hints = [
        ("cidr", ("cidr", "subnet", "network", "prefix")),
        ("ip", ("ip",)),
        ("mac", ("mac",)),
        ("email", ("email", "mail")),
        ("url", ("url", "link", "website")),
        ("hostname", ("hostname", "host", "fqdn", "server")),
        ("date", ("date",)),
    ]
    for kind, words in hints:
        if words_in_header & set(words) and share(kind) >= 0.8:
            return kind
    for kind in ("number", "date", "ip", "cidr", "mac", "email", "url"):
        if filled and share(kind) == 1.0:
            return kind
    return "longtext" if any(len(v) > MAX_TEXT or "\n" in v for v in filled) else "text"
