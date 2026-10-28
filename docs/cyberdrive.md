# CyberDrive

CyberDrive is the security side of Thumbdrive: reference datasets that agents can query through read-only MCP tools, next to the files in the drive. Each answer carries a citation, so an agent can show where a fact came from instead of guessing.

The datasets are the **MAC address vendor (OUI) database**, the **Windows security audit events catalog**, and the **NIST control frameworks** (SP 800-53 Rev 5, CSF 2.0 and NIST's mapping between them).

| Dataset | Tools | Citation |
| --- | --- | --- |
| `oui`: IEEE MA-L, MA-M and MA-S assignments, merged with Wireshark and Nmap names | `lookup_mac`, `search_oui_vendor` | `cyberdrive:oui@v3#00:00:0C` |
| `winevent`: Microsoft's Windows Security Audit Events catalog (2016): category, subcategory, summary, minimum OS and every version of the detailed message | `lookup_windows_event`, `search_windows_events` | `cyberdrive:winevent@v1#4624` |
| `nist80053`: NIST SP 800-53 Rev 5 controls and enhancements (OSCAL) | `lookup_control`, `search_controls` | `cyberdrive:nist80053@v1#AC-2(1)` |
| `csf2`: NIST Cybersecurity Framework 2.0 functions, categories and subcategories (OSCAL) | `lookup_control`, `search_controls` | `cyberdrive:csf2@v1#PR.AA-01` |
| `csf2map`: NIST's CSF 2.0 informative references to SP 800-53 | `map_control` | |

Datasets are **not** shipped with Thumbdrive. You import them (see [License](#license)).

## Import the OUI database

The default source is `master_oui.db` from [Ringmast4r/OUI-Master-Database](https://github.com/Ringmast4r/OUI-Master-Database) (about 20 MB, about 59,000 rows):

```text
https://raw.githubusercontent.com/Ringmast4r/OUI-Master-Database/master/LISTS/master_oui.db
```

You can import it in three ways.

### Web UI

1. Sign in and open **OUI database** in the sidebar (`/datasets/oui`).
2. Do one of the following:
   - Under **Import a file**, choose a `master_oui.db` you downloaded, then select **Import**.
   - Select **Refresh from source** to have the server download the default URL.

The page shows the current version, row count, import time, source and SHA-256, the keys that can query the dataset, and every earlier import.

Dataset uploads have their own size limit, `DATASET_MAX_MB` (default `100`), separate from `MAX_FILE_MB`, because the OUI file is larger than many drive files. The upload form is CSRF-checked like every other form.

### Admin CLI

```sh
npm run admin -- cyberdrive oui import                    # download the default URL
npm run admin -- cyberdrive oui import ./master_oui.db    # a local file
npm run admin -- cyberdrive oui import https://example.com/master_oui.db
npm run admin -- cyberdrive oui status                    # version history
npm run admin -- cyberdrive oui lookup 00:00:0C:12:34:56 8c1f.64af.a000
npm run admin -- cyberdrive oui search cisco
```

In the container, use `docker exec thumbdrive node dist/admin.js cyberdrive oui import`.

### Monthly auto-refresh (off by default)

Set `CYBERDRIVE_AUTO_REFRESH=1`. The server then checks every 6 hours and downloads the default URL again when the current import is more than 30 days old. A dataset that was never imported is left alone, so the server downloads nothing until you have imported once. Failures are logged and shown in **Activity** as `dataset.error`; the current data stays in place.

### What an import does

- **Validation.** The file must be a SQLite database with an `oui_registry` table and the columns `oui`, `manufacturer`, `registry`, `short_name`, `device_type`, `registered_date`, `address`, `sources`, `status` and `deregistered_date`. Anything else is refused with a reason ("Not a SQLite database file", "missing column ...", "No usable rows ..."), and the current data is untouched.
- **Normalization.** Each prefix is stored as upper-case hex with its length in nibbles: 6 (MA-L), 7 (MA-M) or 9 (MA-S). Rows with an unusable prefix are counted as skipped.
- **Atomic replace.** The new rows replace the old ones in one SQLite transaction, so lookups see either the old version or the new one, never a mix.
- **Metadata and history.** Every import adds a row with the version (1, 2, 3 and so on), import time, source (URL, `file:<name>` or `upload:<name>`), SHA-256 of the file, row count, skipped count and who imported it. Only the current version's rows are kept; the history records what each earlier version was.

## Give agents access

Dataset access is a separate, explicit grant on an agent key, alongside its folders:

- On **Agent keys**, tick the datasets (**OUI database** `cyberdrive:oui`, **Windows security events** `cyberdrive:winevent`, **NIST SP 800-53** `cyberdrive:nist80053`, **NIST CSF 2.0** `cyberdrive:csf2`, **CSF 2.0 to SP 800-53 map** `cyberdrive:csf2map`) when you create a key, or change them later with **Save access**.
- In the CLI, add `--dataset <name>` (repeatable: `oui`, `winevent`, `nist80053`, `csf2`, `csf2map`) to `key create`, or use `key datasets <name> oui winevent nist80053 ...` (`key datasets <name>` with no dataset removes the grants, unless the key has no folders).

Each dataset is granted separately: a key with only `oui` does not see the Windows event tools, and the other way round.

Rules:

- A whole-drive key (`/`) does **not** get datasets automatically. Grant them on purpose.
- A key can be dataset-only, with no folders. It then sees only the dataset tools.
- A key without the grant does not see that dataset's tools in its tool list.
- Every lookup and search is written to **Activity** with the key name, the tool name, the path (such as `cyberdrive:oui` or `cyberdrive:winevent`) and the result for each input, such as `v3 2 MAC(s): 00:00:0C:12:34:56=00:00:0C, 02:00:00:00:00:01=locally administered` or `v1 2 event(s): 4624=Logon, 9999=No match`.

## OUI tools

Both tools are annotated `readOnlyHint: true`.

### `lookup_mac(macs)`

`macs` is a list of 1 to 50 MAC addresses or prefixes. Accepted formats include `00:1A:2B:3C:4D:5E`, `00-1a-2b-3c-4d-5e`, `001a.2b3c.4d5e`, `001A2B3C4D5E` and prefixes of 6 or more hex digits such as `00:1A:2B`.

For each input it:

1. Normalizes it to `XX:XX:XX:XX:XX:XX`.
2. Reports the two flag bits of the first octet: `locally_administered` (U/L bit, `0x02`) and `multicast` (I/G bit, `0x01`).
3. Finds the longest matching prefix: 9 nibbles (MA-S), then 7 (MA-M), then 6 (MA-L). For a multicast address, the group bit is cleared first, so `01:00:5E:...` resolves to the `00:00:5E` block (IANA).
4. Returns one of these results:

| `result` | Meaning |
| --- | --- |
| `match` | The full entry: `matched_prefix`, `prefix_nibbles`, `manufacturer`, `registry`, `short_name`, `device_type`, `registered_date`, `address`, `status`, `deregistered_date`, `sources`, and a `citation` |
| `No match` | Nothing in this dataset version covers the address. Said explicitly, with a note |
| `locally administered` | No vendor is given, because the prefix does not identify a manufacturer (random/private MACs, VMs, containers). A note explains why. If the prefix is a well-known software block, such as QEMU's `52:54:00`, it is shown as `registered_block` |
| `broadcast` | `FF:FF:FF:FF:FF:FF` |
| `invalid` | Not a MAC address or prefix; the error shows the accepted formats |

Notes also flag deregistered entries and MA-L blocks that IEEE subdivided into MA-M or MA-S blocks.

The citation is `cyberdrive:oui@v<version>#<matched prefix>`, for example `cyberdrive:oui@v1#00:00:0C` or `cyberdrive:oui@v1#8C:1F:64:AF:A`.

Example with `["00:00:0C:12:34:56", "02:00:00:00:00:01"]` (trimmed):

```json
{
  "dataset": "oui",
  "version": 1,
  "results": [
    {
      "input": "00:00:0C:12:34:56",
      "normalized": "00:00:0C:12:34:56",
      "locally_administered": false,
      "multicast": false,
      "result": "match",
      "match": {
        "matched_prefix": "00:00:0C",
        "prefix_nibbles": 6,
        "manufacturer": "Cisco",
        "registry": "MA-L",
        "device_type": "Access Point",
        "registered_date": "1998-04-22",
        "status": "current",
        "sources": "IEEE+Wireshark+Nmap",
        "citation": "cyberdrive:oui@v1#00:00:0C"
      }
    },
    {
      "input": "02:00:00:00:00:01",
      "normalized": "02:00:00:00:00:01",
      "locally_administered": true,
      "multicast": false,
      "result": "locally administered",
      "match": null,
      "note": "Locally administered address (U/L bit set): usually a random/private MAC ... The prefix does not identify the hardware manufacturer."
    }
  ]
}
```

If the database has not been imported, the tool answers with an error asking the admin to import it.

### `search_oui_vendor(query, limit)`

Case-insensitive search on manufacturer and short name. `query` is 2 to 100 characters; `limit` is 1 to 100 (default 25). Each hit has the prefix, registry, names, status and a citation.

## Windows security events

### Source and coverage

The catalog is Microsoft's **Windows Security Audit Events** spreadsheet (`WindowsSecurityAuditEvents.xlsx`, about 70 KB):

```
https://download.microsoft.com/download/8/e/1/8e11ad26-98a1-4ee3-9f7f-1db4eb18badf/WindowsSecurityAuditEvents.xlsx
```

It has two sheets: **Security Audit Events** (category, subcategory, event ID, message summary, minimum OS) and **Complete Event Messages** (event ID, version, detailed message, minimum OS). The current file gives 410 event IDs in 9 audit categories, with 443 message versions.

> **Coverage.** Microsoft published this catalog in **2016** and has not updated it. It does not cover newer events, such as some added in later Windows 10 and Windows 11 releases, and it covers only the Windows **Security** log: not Sysmon, PowerShell, System or Application events. A few common Security-log IDs are not in it either, such as 1102 ("The audit log was cleared"). For those, the tools answer `No match` instead of guessing.

### Import

- **Web UI.** Open **Windows events** in the sidebar (`/datasets/winevent`). Select **Refresh from source** to download the file above, or upload a copy under **Import a file**.
- **CLI.**

  ```sh
  npm run admin -- cyberdrive winevent import                  # download from Microsoft
  npm run admin -- cyberdrive winevent import ./WindowsSecurityAuditEvents.xlsx
  npm run admin -- cyberdrive winevent status
  npm run admin -- cyberdrive winevent lookup 4624 4688
  npm run admin -- cyberdrive winevent search "special logon" --category "Logon/Logoff"
  ```

`CYBERDRIVE_AUTO_REFRESH=1` also covers this dataset when it has been imported.

An import works the same way as for OUI: it validates the file, replaces the data in one transaction and adds a history row. Validation checks that:

- the file is an `.xlsx` workbook
- both sheets are present (sheet names and column headers are matched without regard to case or spacing)
- the columns above are present
- event IDs are whole numbers from 1 to 65535

Rows without a usable ID, summary or message are skipped and counted. Line endings are normalized, and the indentation Microsoft added to every message line is removed. The version's count is the number of distinct event IDs, shown as **events**.

The workbook is read with [`read-excel-file`](https://www.npmjs.com/package/read-excel-file), not the unmaintained `xlsx` 0.18 package from npm, which has known vulnerabilities.

### `lookup_windows_event(ids)`

`ids` is a list of 1 to 50 event IDs, as numbers or strings (`4624`, `"4624"`, `"EventID 4624"`). Each result has a `result` field set to one of these values:

| `result` | Meaning |
| --- | --- |
| `match` | `event_id`, `category`, `subcategory`, `summary`, `min_os`, `versions` (each with `version`, `min_os` and the full `message` template; `%1`, `%2`... are the event's insertion strings) and a `citation` |
| `No match` | The ID is not in this catalog. The note repeats the coverage limits above |
| `invalid` | Not an event ID |

Special cases:

- **Events under several subcategories.** Four events appear under more than one subcategory (4659, 4660, 4661 and 4663 are under both Object Access > SAM and Object Access > Kernel). The first listing is returned as `category` and `subcategory`, and the others are in `also_listed_under`.
- **Message-only events.** Three IDs, 4741, 4763 and 8191, appear only in the messages sheet. They have `category: null` and a note explaining this.

The citation is `cyberdrive:winevent@v<version>#<event id>`, such as `cyberdrive:winevent@v1#4624`.

Example with `[4624, 9999]` (messages trimmed):

```json
{
  "dataset": "winevent",
  "version": 1,
  "results": [
    {
      "input": "4624",
      "event_id": 4624,
      "result": "match",
      "category": "Logon/Logoff",
      "subcategory": "Logon",
      "summary": "An account was successfully logged on.",
      "min_os": "Windows Vista, Windows Server 2008",
      "versions": [
        { "version": 0, "min_os": "Windows Vista, Windows Server 2008", "message": "An account was successfully logged on.\n\nSubject:\n    Security ID:        %1\n..." },
        { "version": 1, "min_os": "Windows 8, Windows Server 2012", "message": "..." },
        { "version": 2, "min_os": "Windows 10", "message": "...\nLogon Information:\n    Logon Type:        %9\n    Restricted Admin Mode:    %22\n    Virtual Account:        %25\n    Elevated Token:        %27\n..." }
      ],
      "citation": "cyberdrive:winevent@v1#4624"
    },
    {
      "input": "9999",
      "event_id": 9999,
      "result": "No match",
      "note": "No match: event 9999 is not in this catalog. The catalog is Microsoft's 2016 list of Windows security audit events; it does not cover newer events (some Windows 10/11 additions) or other logs such as Sysmon. ..."
    }
  ],
  "note": "The catalog is Microsoft's 2016 list of Windows security audit events; ..."
}
```

### `search_windows_events(query, category, limit)`

This tool runs a case-insensitive text search over summaries, subcategories and detailed messages. A number that is a whole event ID matches that ID.

- `query` is optional, up to 100 characters. When given, it must be at least 2 characters.
- `category` is optional and limits the search to one audit category. It matches the category name exactly, ignoring case. The categories are Account Logon, Account Management, DS Access, Detailed Tracking, Logon/Logoff, Object Access, Policy Change, Privilege Use and System. An unknown category returns an error that lists the valid names.
- Give at least one of `query` and `category`.
- `limit` is 1 to 100 (default 20).

The tool returns `total` (all matches) and up to `limit` results. Each result has the ID, category, subcategory, summary, minimum OS, number of versions and citation. Use `lookup_windows_event` to get the full messages.

## NIST control frameworks

Three datasets hold NIST's security control frameworks:

| Dataset | Content | Default source |
| --- | --- | --- |
| `nist80053` | NIST SP 800-53 Rev 5 controls and enhancements (the current file is release 5.2.0: 20 families, 1,196 controls and enhancements, withdrawn ones included) | NIST's OSCAL catalog JSON in [usnistgov/oscal-content](https://github.com/usnistgov/oscal-content): `https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json` (about 10 MB) |
| `csf2` | NIST Cybersecurity Framework 2.0: 6 functions, 34 categories and 185 subcategories (225 items, withdrawn ones included; 324 controls and 872 enhancements on the 800-53 side), with the implementation examples | NIST's OSCAL catalog JSON: `https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/CSF/v2.0/json/NIST_CSF_v2.0_catalog.json` |
| `csf2map` | NIST's CSF 2.0 informative references to SP 800-53 (746 mappings in the current export) | The CSF 2.0 Reference Tool export, `https://csrc.nist.gov/extensions/nudp/services/json/csf/download?olirids=all` (an `.xlsx`, about 145 KB) |

All three are US government works, in the public domain in the US, so **Refresh from source** downloads them straight from NIST. They are still not committed to the repository or bundled in the image.

### Import

- **Web UI.** Open **NIST SP 800-53**, **NIST CSF 2.0** and **CSF ↔ 800-53 map** in the sidebar (`/datasets/nist80053`, `/datasets/csf2`, `/datasets/csf2map`). Select **Refresh from source**, or upload a copy under **Import a file**.
- **CLI.**

  ```sh
  npm run admin -- cyberdrive nist80053 import            # download from NIST
  npm run admin -- cyberdrive csf2 import
  npm run admin -- cyberdrive csf2map import
  npm run admin -- cyberdrive nist80053 import ./NIST_SP-800-53_rev5_catalog.json
  npm run admin -- cyberdrive nist80053 lookup AC-2 'ia-2(1)' AC-2.1
  npm run admin -- cyberdrive csf2 lookup PR.AA-01 GV.OC
  npm run admin -- cyberdrive nist80053 search "multi-factor" --family IA
  npm run admin -- cyberdrive csf2 search --family GV       # every GOVERN item
  npm run admin -- cyberdrive nist80053 search audit --withdrawn
  npm run admin -- cyberdrive csf2map map PR.AA-01 'AC-2(1)'
  npm run admin -- cyberdrive csf2map status
  ```

Each import validates the file and refuses anything else with a reason (for example `Not an SP 800-53 catalog: expected groups of class "family" holding controls of class "SP800-53"` or `Not a CSF 2.0 catalog`), then replaces that dataset in one transaction and adds a history row, like the other datasets. Importing a newer 800-53 release (for example 5.1.1 to 5.2.0) is a new version; the framework title, such as "NIST SP 800-53 Rev 5.2.0", comes from the catalog's metadata.

How the files are read:

- **SP 800-53.** Families, controls and enhancements come from the OSCAL groups and controls. Statements are rendered as indented items (`a.`, `  1.`), with OSCAL parameters written inline the way NIST prints them: `[Assignment: organization-defined personnel or roles]`, `[Selection (one or more): ...]`. Related controls come from `related` links, and withdrawn controls keep their `incorporated-into` and `moved-to` targets.
- **CSF 2.0.** The OSCAL catalog titles each subcategory with its own ID, so the outcome statement is used as the title. Implementation examples are numbered `Ex1`, `Ex2` and so on, and the first-party/third-party risk note on each subcategory is kept as `risk_party`.
- **CSF map.** The workbook's sheet with **Subcategory** and **Informative References** columns is read. Only `SP 800-53 Rev 5...` references are imported, and only the newest 800-53 revision in the file (the current export carries 5.2.0). References to other frameworks are ignored: they are third-party works with their own licenses. Category rows are kept too (for example GV.OC has its own references).

### Where the mapping comes from

NIST publishes the CSF 2.0 to SP 800-53 mapping in its [Online Informative References (OLIR)](https://csrc.nist.gov/projects/olir) program as entry *CSFv2.0-to-SP-800-53-Rev-5-2-0* (final, November 2025), and the same references appear in the CSF 2.0 Reference Tool. The importer uses the Reference Tool's `.xlsx` export because it is the machine-readable form NIST serves from a stable public URL; the OLIR catalog has no public download API, and the CPRT JSON export maps only to whole 800-53 families. Two things to know about this export:

- Its Introduction sheet calls it "a user generated version of the Core versus an official NIST publication". The rows are NIST's informative references, but the file is generated on request.
- It records the download time, so its SHA-256 changes on every download even when the content does not. Each **Refresh from source**, including `CYBERDRIVE_AUTO_REFRESH`, therefore makes a new version.

The mappings say which SP 800-53 controls *support* a CSF outcome. They are not equivalences, and the tool says so.

### `lookup_control(ids)`

`ids` is a list of 1 to 50 IDs from either framework, in any common spelling: `AC-2`, `ac-2`, `AC-02`, `AC-2(1)`, `ac-2(1)`, `AC-2.1`, `AC-2 (1)`, `NIST SP 800-53 Rev 5: AC-2`, a family such as `AC`, and `PR.AA-01`, `pr.aa-1`, `GV.OC` or `GV`. Each result's `result` is one of:

| `result` | Meaning |
| --- | --- |
| `match` | `framework`, `framework_title`, `id`, `kind` (`family`, `control`, `enhancement`, `function`, `category`, `subcategory`), `family` (800-53 family or CSF function, with title), `parent`, `title`, `statement`, `guidance` (800-53 discussion), `enhancements` or `children`, `related`, `implementation_examples` (CSF), `risk_party` (CSF), `withdrawn`, `withdrawn_to` and a `citation` |
| `No match` | A valid ID that is not in the imported catalog, or a framework that has not been imported or granted to this key (the note says which) |
| `invalid` | Not an SP 800-53 or CSF 2.0 ID |

The citation is `cyberdrive:<dataset>@v<version>#<id>`, such as `cyberdrive:nist80053@v1#AC-2(1)` or `cyberdrive:csf2@v1#PR.AA-01`.

Real output (trimmed), for `["IA-2(1)", "AC-13"]`:

```json
{
  "frameworks": [
    { "dataset": "nist80053", "version": 1, "title": "NIST SP 800-53 Rev 5.2.0" },
    { "dataset": "csf2", "version": 1, "title": "NIST CSF 2.0" }
  ],
  "results": [
    {
      "input": "IA-2(1)",
      "result": "match",
      "framework": "nist80053",
      "id": "IA-2(1)",
      "kind": "enhancement",
      "family": { "id": "IA", "title": "Identification and Authentication" },
      "parent": { "id": "IA-2", "title": "Identification and Authentication (Organizational Users)" },
      "title": "Multi-factor Authentication to Privileged Accounts",
      "statement": "Implement multi-factor authentication for access to privileged accounts.",
      "guidance": "Multi-factor authentication requires the use of two or more different factors to achieve authentication. ...",
      "related": ["AC-5", "AC-6"],
      "withdrawn": false,
      "citation": "cyberdrive:nist80053@v1#IA-2(1)"
    },
    {
      "input": "AC-13",
      "result": "match",
      "id": "AC-13",
      "title": "Supervision and Review — Access Control",
      "statement": null,
      "withdrawn": true,
      "withdrawn_to": [{ "rel": "incorporated into", "id": "AC-2" }, { "rel": "incorporated into", "id": "AU-6" }],
      "citation": "cyberdrive:nist80053@v1#AC-13",
      "note": "Withdrawn: incorporated into AC-2, AU-6. Use the replacement instead."
    }
  ]
}
```

AC-2's statement comes out like this:

```text
a. Define and document the types of accounts allowed and specifically prohibited for use within the system;
b. Assign account managers;
c. Require [Assignment: organization-defined prerequisites and criteria] for group and role membership;
d. Specify:
  1. Authorized users of the system;
  2. Group and role membership; and
  ...
```

### `search_controls(query, framework, family, include_withdrawn, limit)`

Case-insensitive text search over IDs, titles, statements, guidance and CSF implementation examples. Hits are ranked by ID match, then title, then text. `framework` limits the search to `nist80053` or `csf2`, and `family` to one 800-53 family or CSF function (`IA`, `Access Control`, `PR`). With only `family`, it lists that family. Families and functions themselves are not returned (use `lookup_control`), and withdrawn items are left out unless `include_withdrawn` is true. `limit` is 1 to 100 (default 20). Each hit has the ID, kind, family, title, a snippet and a citation, and the answer includes the `total`.

### `map_control(ids)`

Needs the `csf2map` grant. `ids` is 1 to 50 IDs from either side:

- **CSF to SP 800-53.** A subcategory gives its references. A category gives its own references plus every subcategory's, marked `"via": "subcategory PR.AA-01"`; a function rolls up the same way.
- **SP 800-53 to CSF.** A control gives the CSF items that cite it. An enhancement also gives the items that cite its base control (`"via": "base control AC-2"`), and any control gives the items that cite its whole family (`"via": "whole family IR"`). Direct matches come first.

Titles are filled in only from catalogs the key is granted and that have been imported. With real data, PR.AA-01 maps to 14 controls (AC-1, AC-2, AC-14, IA-1 to IA-11), and AC-2(1) maps through AC-2 to PR.AA-01, PR.AA-05, PR.DS-10, DE.CM-01 and DE.CM-03. A withdrawn CSF item such as ID.AM-06 has no references and answers `No match`.

### Grants and activity

The three datasets are granted separately, like the others: a key with `nist80053` alone gets `lookup_control` and `search_controls` for SP 800-53 only, and CSF IDs answer `No match` with a note that CSF 2.0 is not available to the key. `map_control` appears only with `csf2map`. Activity records each call with the path `cyberdrive:nist80053+csf2` (the frameworks the key can see) or `cyberdrive:csf2map`, and a result per ID.

### CIS Controls v8.1 (planned, user import only)

CIS Controls are licensed CC BY-NC-ND 4.0, which forbids redistributing modified copies, so Thumbdrive will never bundle or download them. The storage is ready for a user-supplied import: controls from every framework share one table keyed by framework and ID, and each framework is one entry in `CONTROL_FRAMEWORKS` (`src/cyberdrive/controls.ts`) with an ID parser. Adding CIS means a parser for CIS's spreadsheet, a `cis8` entry with IDs like `5.4`, and a dataset kind without a default URL, so the user uploads their own licensed copy. It is not built yet.

## Use it from an agent

Create a key with the dataset grants you want, then use the snippet shown on the **Agent keys** page. For Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "thumbdrive": {
      "url": "https://drive.example.com/mcp",
      "headers": { "Authorization": "Bearer td_..." }
    }
  }
}
```

For Claude Code:

```sh
claude mcp add --transport http thumbdrive https://drive.example.com/mcp --header "Authorization: Bearer td_..."
```

Then ask, for example: "Which vendors are behind these MACs from the DHCP log: 00:00:0c:12:34:56, 8c1f.64af.a000, 02:00:00:00:00:01? Cite each one." Or: "What do event IDs 4624, 4672 and 4688 mean, and which audit subcategory must be on to get them?" Or: "Quote AC-2(1) and IA-2(1), and which CSF 2.0 outcomes do they support?" The server's instructions tell the agent to quote the citation and to say "No match" or "locally administered" instead of guessing.

## License

Thumbdrive's code is under the Apache License 2.0. The OUI database is a separate work: the Ringmast4r OUI-Master-Database project is MIT-licensed, but it merges data from Wireshark's `manuf` file and Nmap's `nmap-mac-prefixes`, which are distributed under the GPLv2 (plus IEEE registry data). For that reason the dataset is **not committed to this repository or included in the image**. Each user downloads it into their own drive, and should check the source project's terms before redistributing it.

The Windows security events catalog is published by Microsoft on the Microsoft Download Center under Microsoft's terms. It is also **not committed or bundled**. Each user downloads it from Microsoft, through **Refresh from source** or the CLI. The test suite uses small synthetic workbooks that it builds in memory.

NIST SP 800-53, CSF 2.0 and the CSF 2.0 Reference Tool data are works of the US government, not subject to copyright in the US. They are still not committed or bundled; **Refresh from source** downloads them from NIST, and the tests use small look-alike fixtures. Only the SP 800-53 references are imported from the Reference Tool export, because its other references point to third-party frameworks under their own terms. CIS Controls (CC BY-NC-ND 4.0) will only ever be a user import.
