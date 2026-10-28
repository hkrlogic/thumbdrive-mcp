# CyberDrive

CyberDrive is the security side of Thumbdrive: reference datasets that agents can query through read-only MCP tools, next to the files in the drive. Each answer carries a citation, so an agent can show where a fact came from instead of guessing.

The first dataset is the **MAC address vendor (OUI) database**.

| Dataset | Tools | Citation |
| --- | --- | --- |
| `oui`: IEEE MA-L, MA-M and MA-S assignments, merged with Wireshark and Nmap names | `lookup_mac`, `search_oui_vendor` | `cyberdrive:oui@v3#00:00:0C` |

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

- On **Agent keys**, tick **OUI database** (`cyberdrive:oui`) when you create a key, or change it later with **Save access**.
- In the CLI, add `--dataset oui` to `key create`, or use `key datasets <name> oui` (`key datasets <name>` with no dataset removes the grant, unless the key has no folders).

Rules:

- A whole-drive key (`/`) does **not** get datasets automatically. Grant them on purpose.
- A key can be dataset-only, with no folders. It then sees only the dataset tools.
- A key without the grant does not see `lookup_mac` or `search_oui_vendor` in its tool list.
- Every lookup and search is written to **Activity** with the key name, action (`lookup_mac` or `search_oui_vendor`), path `cyberdrive:oui` and the result for each input, such as `v3 2 MAC(s): 00:00:0C:12:34:56=00:00:0C, 02:00:00:00:00:01=locally administered`.

## Tools

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

## Use it from an agent

Create a key with the OUI grant, then use the snippet shown on the **Agent keys** page. For Cursor (`~/.cursor/mcp.json`):

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

Then ask, for example: "Which vendors are behind these MACs from the DHCP log: 00:00:0c:12:34:56, 8c1f.64af.a000, 02:00:00:00:00:01? Cite each one." The server's instructions tell the agent to quote the citation and to say "No match" or "locally administered" instead of guessing.

## License

Thumbdrive's code is under the Apache License 2.0. The OUI database is a separate work: the Ringmast4r OUI-Master-Database project is MIT-licensed, but it merges data from Wireshark's `manuf` file and Nmap's `nmap-mac-prefixes`, which are distributed under the GPLv2 (plus IEEE registry data). For that reason the dataset is **not committed to this repository or included in the image**. Each user downloads it into their own drive, and should check the source project's terms before redistributing it.
