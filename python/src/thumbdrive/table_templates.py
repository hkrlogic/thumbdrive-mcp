"""Starting columns for new tables. Plain data: add a template by adding an entry."""

TEMPLATES: dict[str, dict] = {
    "servers": {
        "label": "Server inventory",
        "description": "One row per server: hostname, address, environment, owner.",
        "columns": [
            {"name": "Hostname", "type": "hostname", "key": True},
            {"name": "IP address", "type": "ip"},
            {"name": "Environment", "type": "select", "options": ["production", "staging", "development", "test"]},
            {"name": "OS", "type": "text"},
            {"name": "Owner name", "type": "text"},
            {"name": "Owner email", "type": "email"},
            {"name": "Team", "type": "text"},
            {"name": "Location", "type": "text"},
            {"name": "Criticality", "type": "select", "options": ["critical", "high", "medium", "low"]},
            {"name": "Notes", "type": "longtext"},
        ],
    },
    "ip-plan": {
        "label": "IP plan / VLANs",
        "description": "One row per network range: CIDR, VLAN, purpose, site.",
        "columns": [
            {"name": "CIDR", "type": "cidr", "key": True},
            {"name": "VLAN ID", "type": "number"},
            {"name": "Name", "type": "text"},
            {"name": "Purpose", "type": "text"},
            {"name": "Site", "type": "text"},
            {"name": "Owner", "type": "text"},
        ],
    },
}
