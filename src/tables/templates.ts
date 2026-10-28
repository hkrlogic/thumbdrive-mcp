/**
 * Table templates: plain definitions. To add one, append an entry; the
 * "New table" form lists them in this order. `key: true` marks the key column.
 */
import type { ColumnType } from "./types.ts";

export interface TemplateColumn {
  name: string;
  type: ColumnType;
  options?: string[];
  key?: boolean;
}

export interface TableTemplate {
  id: string;
  title: string;
  description: string;
  /** Suggested table name (the last path segment). */
  name: string;
  columns: TemplateColumn[];
}

export const TEMPLATES: TableTemplate[] = [
  {
    id: "server-inventory",
    title: "Server inventory",
    description: "One row per server: where it runs, who owns it and how critical it is.",
    name: "servers",
    columns: [
      { name: "Hostname", type: "hostname", key: true },
      { name: "IP address", type: "ip" },
      { name: "Environment", type: "select", options: ["production", "staging", "development", "test"] },
      { name: "OS", type: "text" },
      { name: "Owner name", type: "text" },
      { name: "Owner email", type: "email" },
      { name: "Team", type: "text" },
      { name: "Location", type: "text" },
      { name: "Criticality", type: "select", options: ["critical", "high", "medium", "low"] },
      { name: "Notes", type: "longtext" },
    ],
  },
  {
    id: "ip-plan",
    title: "IP plan / VLANs",
    description: "One row per network range: VLAN, purpose, site and owner. lookup_row with an IP finds its range.",
    name: "ip-plan",
    columns: [
      { name: "CIDR", type: "cidr", key: true },
      { name: "VLAN ID", type: "number" },
      { name: "Name", type: "text" },
      { name: "Purpose", type: "text" },
      { name: "Site", type: "text" },
      { name: "Owner", type: "text" },
    ],
  },
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);
