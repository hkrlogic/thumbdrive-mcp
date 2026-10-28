"""The four table tools through the SDK client: scoping, latest version only, citations, logging."""

from conftest import Server
from test_mcp import call, error, ok

from thumbdrive.table_templates import TEMPLATES
from thumbdrive.tables import Tables


def seed(server: Server) -> Tables:
    tables: Tables = server.app.state.tables
    t = tables.create("/infra/servers", TEMPLATES["servers"]["columns"], "Servers")
    host, ip, env = (t.column_named(n)["id"] for n in ("Hostname", "IP address", "Environment"))
    rows = [("web-01.example.com", "10.0.1.10", "production"), ("db-01.example.com", "10.0.2.20", "staging")]
    tables.edit(t, adds=[{"values": {host: h, ip: i, env: e}} for h, i, e in rows])
    tables.publish(t, "first")
    tables.edit(t, adds=[{"values": {host: "draft-only"}}])  # never visible to agents

    plan = tables.create("/infra/ip-plan", TEMPLATES["ip-plan"]["columns"])
    cidr, vlan, name = (plan.column_named(n)["id"] for n in ("CIDR", "VLAN ID", "Name"))
    nets = [("10.0.0.0/8", 1, "Corp"), ("10.0.1.0/24", 10, "Web"), ("2001:db8::/32", 2, "v6")]
    tables.edit(plan, adds=[{"values": {cidr: c, vlan: v, name: n}} for c, v, n in nets])
    tables.publish(plan, "plan")

    tables.create("/secret/payroll", [{"name": "Name", "type": "text", "key": True}])
    tables.publish(tables.by_path("/secret/payroll"), "empty")
    tables.create("/infra/unpublished", [{"name": "Name", "type": "text"}])
    return tables


def test_list_tables_is_scoped_and_hides_unpublished(server: Server) -> None:
    seed(server)
    key = server.key("/infra")
    listed = ok(call(server, key, "list_tables"))["tables"]
    assert [t["path"] for t in listed] == ["/infra/ip-plan", "/infra/servers"]
    assert listed[1]["citation"] == "thumbdrive:/infra/servers@v1" and listed[1]["rows"] == 2
    assert listed[1]["key_column"] == "Hostname"
    assert error(call(server, key, "describe_table", table="/secret/payroll")) == "Not found: /secret/payroll"
    assert error(call(server, key, "describe_table", table="/infra/unpublished")) == "Not found: /infra/unpublished"


def test_describe_table(server: Server) -> None:
    seed(server)
    out = ok(call(server, server.key("/"), "describe_table", table="thumbdrive:/infra/servers@v1#r2"))
    assert out["version"] == 1 and out["note"] == "first"
    env = next(c for c in out["columns"] if c["name"] == "Environment")
    assert env["options"] == ["production", "staging", "development", "test"]
    assert [r["values"]["Hostname"] for r in out["sample_rows"]] == ["web-01.example.com", "db-01.example.com"]


def test_lookup_row_normalizes_and_cites(server: Server) -> None:
    seed(server)
    key = server.key("/infra")
    results = ok(
        call(
            server,
            key,
            "lookup_row",
            table="/infra/servers",
            values=["WEB-01.example.com.", "db-01", "nope", "draft-only", "bad_host"],
        )
    )["results"]
    assert [r["result"] for r in results] == ["match", "match", "no_match", "no_match", "invalid"]
    assert results[0]["rows"][0]["citation"] == "thumbdrive:/infra/servers@v1#r1"
    assert results[1]["matched_by"] == "short hostname"
    by_ip = ok(call(server, key, "lookup_row", table="/infra/servers", values=["10.0.2.20"], column="ip address"))
    assert by_ip["results"][0]["rows"][0]["values"]["Hostname"] == "db-01.example.com"


def test_lookup_ip_in_cidr_table_finds_most_specific_range(server: Server) -> None:
    seed(server)
    key = server.key("/infra")
    results = ok(
        call(
            server,
            key,
            "lookup_row",
            table="/infra/ip-plan",
            values=["10.0.1.7", "10.9.9.9", "192.168.1.1", "2001:db8::5", "10.0.1.0/24"],
        )
    )["results"]
    assert [r.get("rows", [{}])[0].get("values", {}).get("Name") for r in results] == ["Web", "Corp", None, "v6", "Web"]
    assert results[0]["matched_by"] == "IP in CIDR" and results[2]["result"] == "no_match"


def test_query_table_operators_and_paging(server: Server) -> None:
    seed(server)
    key = server.key("/infra")

    def rows(**args: object) -> list:
        return [
            r["values"]["Name"] for r in ok(call(server, key, "query_table", table="/infra/ip-plan", **args))["rows"]
        ]

    assert rows(where=[{"column": "VLAN ID", "op": "gt", "value": 1}]) == ["Web", "v6"]
    assert rows(where=[{"column": "name", "op": "eq", "value": "WEB"}]) == ["Web"]
    assert rows(where=[{"column": "Name", "op": "neq", "value": "web"}]) == ["Corp", "v6"]
    assert rows(where=[{"column": "CIDR", "op": "starts_with", "value": "10."}]) == ["Corp", "Web"]
    assert rows(where=[{"column": "Name", "op": "contains", "value": "%"}]) == []
    assert rows(where=[{"column": "VLAN ID", "op": "in", "value": [1, 2]}]) == ["Corp", "v6"]
    assert rows(where=[{"column": "Purpose", "op": "is_empty"}]) == ["Corp", "Web", "v6"]
    assert rows(order_by="VLAN ID", descending=True) == ["Web", "v6", "Corp"]
    page = ok(call(server, key, "query_table", table="/infra/ip-plan", limit=2))
    assert (page["total"], page["next_offset"], len(page["rows"])) == (3, 2, 2)
    assert ok(call(server, key, "query_table", table="/infra/ip-plan", limit=2, offset=2))["next_offset"] is None
    assert "No column named 'Nope'" in error(
        call(server, key, "query_table", table="/infra/ip-plan", where=[{"column": "Nope", "op": "eq", "value": 1}])
    )
    assert "not valid for VLAN ID" in error(
        call(
            server,
            key,
            "query_table",
            table="/infra/ip-plan",
            where=[{"column": "VLAN ID", "op": "eq", "value": "ten"}],
        )
    )


def test_agents_see_only_latest_version_and_calls_are_logged(server: Server) -> None:
    tables = seed(server)
    t = tables.by_path("/infra/servers")
    tables.rollback(t, 1)  # v2 = v1 again, but the draft-only row is dropped by the rollback
    key = server.key("/infra", name="bot")
    assert ok(call(server, key, "describe_table", table="/infra/servers"))["version"] == 2
    call(server, key, "describe_table", table="/secret/payroll")
    log = [(r["actor"], r["action"], r["path"], r["detail"]) for r in server.app.state.drive.activity("agents")]
    assert ("bot", "describe_table", "/infra/servers", "v2") in log
    assert ("bot", "describe_table", "/secret/payroll", "not found") in log
