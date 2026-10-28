/**
 * Tiny look-alikes of NIST's OSCAL catalogs (SP 800-53 Rev 5, CSF 2.0) and
 * the CSF 2.0 Reference Tool export, shaped like the real files. The real ones
 * are imported by users (or "Refresh from source"); they are not in the repo.
 */
import { xlsx } from "../xlsx.ts";

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const label = (value: string) => ({ name: "label", value });

export function sp80053Catalog(version = "5.2.0"): Uint8Array {
  return enc({
    catalog: {
      uuid: "00000000-0000-4000-8000-000000000000",
      metadata: { title: `Electronic (OSCAL) Version of NIST SP 800-53 Rev ${version} Controls`, version, "oscal-version": "1.1.3" },
      groups: [
        {
          id: "ac",
          class: "family",
          title: "Access Control",
          props: [label("AC")],
          controls: [
            {
              id: "ac-2",
              class: "SP800-53",
              title: "Account Management",
              params: [
                { id: "ac-02_odp.01", label: "prerequisites and criteria", guidelines: [{ prose: "prerequisites and criteria for group and role membership are defined;" }] },
                { id: "ac-02_odp.02", label: "organization-defined personnel or roles" },
                { id: "ac-02_odp.03", select: { "how-many": "one-or-more", choice: ["daily", "{{ insert: param, ac-02_odp.04 }}"] } },
                { id: "ac-02_odp.04", label: "frequency" },
              ],
              props: [label("AC-2"), { name: "label", value: "AC-02", class: "zero-padded" }, { name: "sort-id", value: "ac-02" }],
              links: [
                { href: "#ac-3", rel: "related" },
                { href: "#ia-2", rel: "related" },
                { href: "#ref-1", rel: "reference" },
              ],
              parts: [
                {
                  id: "ac-2_smt",
                  name: "statement",
                  parts: [
                    { id: "ac-2_smt.a", name: "item", props: [label("a.")], prose: "Define the types of accounts allowed;" },
                    {
                      id: "ac-2_smt.b",
                      name: "item",
                      props: [label("b.")],
                      prose: "Require {{ insert: param, ac-02_odp.01 }} for group and role membership;",
                      parts: [{ id: "ac-2_smt.b.1", name: "item", props: [label("1.")], prose: "Notify {{ insert: param, ac-02_odp.02 }};" }],
                    },
                    { id: "ac-2_smt.c", name: "item", props: [label("c.")], prose: "Review accounts {{ insert: param, ac-02_odp.03 }}." },
                  ],
                },
                { id: "ac-2_gdn", name: "guidance", prose: "Examples of system account types include individual, shared and guest." },
                { id: "ac-2_obj", name: "assessment-objective", prose: "Not imported." },
              ],
              controls: [
                {
                  id: "ac-2.1",
                  class: "SP800-53-enhancement",
                  title: "Automated System Account Management",
                  params: [{ id: "ac-02.01_odp", label: "automated mechanisms" }],
                  props: [label("AC-2(1)"), { name: "label", value: "AC-02(01)", class: "zero-padded" }],
                  links: [{ href: "#ac-2", rel: "required" }],
                  parts: [
                    { id: "ac-2.1_smt", name: "statement", prose: "Support the management of system accounts using {{ insert: param, ac-02.01_odp }}." },
                    { id: "ac-2.1_gdn", name: "guidance", prose: "Automated system account management includes notifications." },
                  ],
                },
              ],
            },
            {
              id: "ac-3",
              class: "SP800-53",
              title: "Access Enforcement",
              props: [label("AC-3")],
              parts: [{ id: "ac-3_smt", name: "statement", prose: "Enforce approved authorizations for logical access." }],
            },
            {
              id: "ac-13",
              class: "SP800-53",
              title: "Supervision and Review — Access Control",
              props: [label("AC-13"), { name: "status", value: "withdrawn" }],
              links: [
                { href: "#ac-2", rel: "incorporated-into" },
                { href: "#au-6", rel: "incorporated-into" },
              ],
            },
          ],
        },
        {
          id: "ia",
          class: "family",
          title: "Identification and Authentication",
          props: [label("IA")],
          controls: [
            {
              id: "ia-2",
              class: "SP800-53",
              title: "Identification and Authentication (Organizational Users)",
              props: [label("IA-2")],
              links: [{ href: "#ac-2", rel: "related" }],
              parts: [
                { id: "ia-2_smt", name: "statement", prose: "Uniquely identify and authenticate organizational users." },
                { id: "ia-2_gdn", name: "guidance", prose: "Organizations can satisfy this with multi-factor authentication." },
              ],
              controls: [
                {
                  id: "ia-2.1",
                  class: "SP800-53-enhancement",
                  title: "Multi-factor Authentication to Privileged Accounts",
                  props: [label("IA-2(1)")],
                  parts: [{ id: "ia-2.1_smt", name: "statement", prose: "Implement multi-factor authentication for access to privileged accounts." }],
                },
              ],
            },
          ],
        },
        {
          id: "au",
          class: "family",
          title: "Audit and Accountability",
          props: [label("AU")],
          controls: [
            {
              id: "au-6",
              class: "SP800-53",
              title: "Audit Record Review, Analysis, and Reporting",
              props: [label("AU-6")],
              parts: [{ id: "au-6_smt", name: "statement", prose: "Review and analyze system audit records." }],
            },
          ],
        },
      ],
    },
  });
}

export function csf2Catalog(): Uint8Array {
  return enc({
    catalog: {
      uuid: "00000000-0000-4000-8000-000000000001",
      metadata: { title: "Electronic Version of NIST Cybersecurity Framework 2.0", version: "1.2.1", "oscal-version": "1.1.2" },
      groups: [
        {
          id: "GV",
          class: "function",
          title: "GOVERN",
          props: [label("GOVERN (GV)")],
          parts: [{ id: "GV_overview", name: "overview", prose: "The organization's cybersecurity risk management strategy is established" }],
          controls: [
            {
              id: "GV.OC",
              class: "category",
              title: "Organizational Context",
              props: [label("GV.OC")],
              parts: [{ id: "GV.OC_statement", name: "statement", prose: "The circumstances surrounding risk management decisions are understood" }],
              controls: [
                {
                  id: "GV.OC-01",
                  class: "subcategory",
                  title: "GV.OC-01",
                  props: [label("GV.OC-01")],
                  parts: [
                    { id: "GV.OC-01_statement", name: "statement", prose: "The organizational mission is understood and informs cybersecurity risk management" },
                    { id: "GV.OC-01.001", name: "guidance", class: "example", prose: "Share the organization's mission" },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: "ID",
          class: "function",
          title: "IDENTIFY",
          parts: [{ id: "ID_overview", name: "overview", prose: "Current cybersecurity risks are understood" }],
          controls: [
            {
              id: "ID.AM",
              class: "category",
              title: "Asset Management",
              parts: [{ id: "ID.AM_statement", name: "statement", prose: "Assets are identified and managed" }],
              controls: [
                {
                  id: "ID.AM-06",
                  class: "subcategory",
                  title: "ID.AM-06",
                  props: [{ name: "status", value: "withdrawn" }],
                  links: [
                    { href: "GV.RR-02", rel: "incorporated_into" },
                    { href: "GV.SC-02", rel: "incorporated_into" },
                  ],
                  parts: [{ id: "ID.AM-06_statement", name: "statement", prose: "Cybersecurity roles and responsibilities are established" }],
                },
              ],
            },
          ],
        },
        {
          id: "PR",
          class: "function",
          title: "PROTECT",
          parts: [{ id: "PR_overview", name: "overview", prose: "Safeguards to manage cybersecurity risks are used" }],
          controls: [
            {
              id: "PR.AA",
              class: "category",
              title: "Identity Management, Authentication, and Access Control",
              parts: [{ id: "PR.AA_statement", name: "statement", prose: "Access to assets is limited to authorized users" }],
              controls: [
                {
                  id: "PR.AA-01",
                  class: "subcategory",
                  title: "PR.AA-01",
                  props: [{ name: "marking", value: "1st", class: "risk-party", remarks: "1st Party Risk" }],
                  parts: [
                    { id: "PR.AA-01_statement", name: "statement", prose: "Identities and credentials for authorized users, services, and hardware are managed by the organization" },
                    { id: "PR.AA-01.1", name: "guidance", class: "example", prose: "Initiate requests for new access" },
                    { id: "PR.AA-01.2", name: "guidance", class: "example", prose: "Issue, manage, and revoke cryptographic certificates" },
                  ],
                },
                {
                  id: "PR.AA-03",
                  class: "subcategory",
                  title: "PR.AA-03",
                  parts: [{ id: "PR.AA-03_statement", name: "statement", prose: "Users, services, and hardware are authenticated" }],
                },
              ],
            },
          ],
        },
      ],
    },
  });
}

/** The CSF 2.0 Reference Tool export: a title row, a header row, then one row per function/category/subcategory. */
export function csf2MapWorkbook(): Uint8Array {
  return xlsx({
    Introduction: [[null, "NIST Cybersecurity Framework (CSF) 2.0 Reference Tool"]],
    "CSF 2.0": [
      ["CSF 2.0 Core"],
      ["Function", "Category", "Subcategory", "Implementation Examples", "Informative References"],
      ["GOVERN (GV): The organization's strategy is established", null, null, null, null],
      [null, "Organizational Context (GV.OC): The circumstances are understood", null, null, "SP 800-53 Rev 5.2.0: PM-11"],
      [null, null, "GV.OC-01: The organizational mission is understood", "Ex1: Share the mission", "SP 800-53 Rev 5.1.1: PM-11\nSP 800-53 Rev 5.2.0: PM-11\nCIS Controls v8.1: 14.1"],
      [null, null, "ID.AM-06: [Withdrawn: Incorporated into GV.RR-02, GV.SC-02]", null, null],
      [
        null,
        null,
        "PR.AA-01: Identities and credentials are managed",
        "Ex1: Initiate requests",
        "SP 800-53 Rev 5.1.1: AC-02\nSP 800-53 Rev 5.2.0: AC-02\nSP 800-53 Rev 5.2.0: IA-02\nSP 800-53 Rev 5.2.0: IA-05(01)\nISO/IEC 27001:2022: A.5.16",
      ],
      [null, null, "PR.AA-03: Users, services, and hardware are authenticated", null, "SP 800-53 Rev 5.2.0: IA-02(01)\nSP 800-53 Rev 5.2.0: IA"],
      [null, null, "not a csf row", null, "SP 800-53 Rev 5.2.0: AC-99"],
    ],
  });
}
