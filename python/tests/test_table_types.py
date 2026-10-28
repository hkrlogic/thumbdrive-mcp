"""Per-type validation: canonical values out, readable reasons for bad input."""

import pytest

from thumbdrive.table_types import check, suggest


def ok(kind: str, raw: object, **column: object):
    value, error = check({"type": kind, **column}, raw)
    assert error is None, error
    assert check({"type": kind, **column}, value) == (value, None)  # canonical values stay valid
    return value


def bad(kind: str, raw: object, **column: object) -> str:
    value, error = check({"type": kind, **column}, raw)
    assert error, f"{raw!r} should be invalid for {kind}"
    assert value == raw.strip() if isinstance(raw, str) else True  # kept as typed
    return error


@pytest.mark.parametrize(
    ("kind", "raw", "expected"),
    [
        ("text", "  hello ", "hello"),
        ("longtext", "a\r\nb", "a\nb"),
        ("number", "1,234.5", 1234.5),
        ("number", "42", 42),
        ("date", "2026/3/7", "2026-03-07"),
        ("checkbox", "Yes", True),
        ("checkbox", "off", False),
        ("url", "https://example.com/x", "https://example.com/x"),
        ("email", "Ada@Example.COM", "Ada@example.com"),
        ("hostname", "Web-01.Example.com.", "web-01.example.com"),
        ("ip", "10.0.0.5", "10.0.0.5"),
        ("ip", "2001:DB8:0:0::1", "2001:db8::1"),
        ("cidr", "10.1.0.0/16", "10.1.0.0/16"),
        ("mac", "001a.2b3c.4d5e", "00:1A:2B:3C:4D:5E"),
        ("mac", "00-1a-2b-3c-4d-5e", "00:1A:2B:3C:4D:5E"),
    ],
)
def test_valid_values_become_canonical(kind: str, raw: str, expected: object) -> None:
    assert ok(kind, raw) == expected


def test_empty_is_always_valid() -> None:
    for kind in ("text", "number", "ip", "select"):
        assert check({"type": kind}, "  ") == (None, None)


def test_select_matches_case_insensitively() -> None:
    assert ok("select", "PRODUCTION", options=["production", "staging"]) == "production"
    assert bad("select", "prod", options=["production", "staging"]) == "not one of: production, staging"


@pytest.mark.parametrize(
    ("kind", "raw", "reason"),
    [
        ("number", "12abc", "not a number"),
        ("date", "2026-02-30", "not a real calendar date"),
        ("date", "07/03/2026", "use YYYY-MM-DD"),
        ("checkbox", "maybe", "use yes or no"),
        ("url", "ftp://example.com", "include http"),
        ("email", "not-an-email", "not an email"),
        ("hostname", "10.0.0.1", "IP address"),
        ("hostname", "bad_host", "letters, digits"),
        ("ip", "10.0.0.300", "not a valid"),
        ("ip", "10.0.0.0/24", "use a CIDR column"),
        ("cidr", "10.0.0.5/24", "did you mean 10.0.0.0/24?"),
        ("cidr", "10.0.0.0", "needs a prefix"),
        ("mac", "00:1A:2B", "not a MAC"),
        ("text", "x" * 2001, "longer than 2000"),
    ],
)
def test_invalid_values_explain_why(kind: str, raw: str, reason: str) -> None:
    assert reason in bad(kind, raw)


def test_import_type_suggestions() -> None:
    assert suggest("IP address", ["10.0.0.1", "10.0.0.2"]) == "ip"
    assert suggest("Subnet", ["10.0.0.0/24"]) == "cidr"
    assert suggest("Hostname", ["web-01", "db-01.example.com"]) == "hostname"
    assert suggest("Description", ["ip phones", "printers"]) == "text"
    assert suggest("VLAN", ["10", "20"]) == "number"
    assert suggest("Owner email", ["a@example.com"]) == "email"
