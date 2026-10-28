/** Pages for user-editable tables: list, grid editor, publish review, row history, import, and the share view. */
import type { FC } from "hono/jsx";
import type { PreviewColumn } from "../tables/importer.ts";
import type { DraftDiff, PublishedTable, TableRecord, TableSummary, VersionRecord } from "../tables/store.ts";
import type { TableTemplate } from "../tables/templates.ts";
import { type Column, COLUMN_TYPES, displayValue, KEY_TYPES, typeLabel } from "../tables/types.ts";
import type { ShareRecord } from "./shares.ts";
import { Crumbs, Csrf, Icon, Layout, PageHead, type PageAssets, type PageCtx, q, ShareShell, Time, filesUrl } from "./views.tsx";

export const TABULATOR_VERSION = "6.7.1";

const GRID_ASSETS: PageAssets = {
  css: [`/assets/vendor/tabulator-${TABULATOR_VERSION}.min.css`, "/assets/tables.css"],
  js: [`/assets/vendor/tabulator-${TABULATOR_VERSION}.min.js`, "/assets/tables.js"],
};
const TABLE_CSS: PageAssets = { css: ["/assets/tables.css"] };

export const tableUrl = (id: number) => `/tables/${id}`;
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

const Status: FC<{ t: Pick<TableRecord, "publishedVersion" | "dirty"> }> = ({ t }) => (
  <span class="row-inline">
    {t.publishedVersion ? <span class="badge ok">Published v{t.publishedVersion}</span> : <span class="badge">Not published</span>}
    {t.dirty ? <span class="badge warn">Draft changes</span> : null}
  </span>
);

const TypeSelect: FC<{ id: string; name?: string; selected?: string }> = ({ id, name, selected }) => (
  <select id={id} name={name ?? "type"} data-type-select>
    {COLUMN_TYPES.map((t) => (
      <option value={t.id} selected={t.id === selected}>
        {t.label}
      </option>
    ))}
  </select>
);

// ---------- list ----------

export const TablesPage: FC<{
  ctx: PageCtx;
  tables: TableSummary[];
  folders: string[];
  folder?: string;
  templates: TableTemplate[];
}> = ({ ctx, tables, folders, folder, templates }) => (
  <Layout ctx={ctx} title="Tables" active="tables" assets={TABLE_CSS}>
    <PageHead
      title="Tables"
      sub="Typed tables (server inventory, IP plans...) that agents can look up. Edits stay in a draft until you publish; agents only see the latest published version."
    >
      <a class="btn primary" href="#new-table">
        <Icon.plus /> New table
      </a>
      <a class="btn" href="#import">
        <Icon.upload /> Import CSV or Excel
      </a>
    </PageHead>
    <div class="stack">
      <section class="card flush" aria-labelledby="tables-h">
        <div class="card-head">
          <h2 id="tables-h">Your tables</h2>
        </div>
        {tables.length === 0 ? (
          <p class="empty">No tables yet. Start from a template below, or import a spreadsheet.</p>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Table</th>
                  <th scope="col" class="hide-sm">
                    Title
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col" class="num">
                    Rows (published)
                  </th>
                  <th scope="col" class="hide-sm">
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody>
                {tables.map((t) => (
                  <tr>
                    <td class="name">
                      <a href={tableUrl(t.id)}>
                        <Icon.table /> <span class="mono">{t.path}</span>
                      </a>
                    </td>
                    <td class="hide-sm">{t.title}</td>
                    <td>
                      <Status t={t} />
                    </td>
                    <td class="num">
                      {t.publishedVersion ? t.publishedRows.toLocaleString("en-US") : "–"}
                      {t.draftRows !== t.publishedRows ? <span class="muted small"> (draft {t.draftRows.toLocaleString("en-US")})</span> : null}
                    </td>
                    <td class="hide-sm">
                      <Time iso={t.updatedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section class="card" id="new-table" aria-labelledby="new-table-h">
        <h2 id="new-table-h">New table</h2>
        <p class="muted small">
          A table lives in a folder, like a file: agent keys and share links for that folder include it. The name becomes its path,
          e.g. <code>/inventory/servers</code>.
        </p>
        <form method="post" action="/tables" class="inline-form">
          <Csrf ctx={ctx} />
          <div class="field">
            <label for="nt-folder">Folder</label>
            <select id="nt-folder" name="folder" required>
              {folders.map((f) => (
                <option value={f} selected={f === folder}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="nt-template">Start from</label>
            <select id="nt-template" name="template">
              <option value="">Blank table</option>
              {templates.map((t) => (
                <option value={t.id}>Template: {t.title}</option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="nt-name">
              Name <span class="hint">lowercase, e.g. servers</span>
            </label>
            <input id="nt-name" name="name" type="text" required maxlength={64} pattern="[a-z0-9][a-z0-9._\-]*" placeholder="servers" />
          </div>
          <div class="field">
            <label for="nt-title">Title (optional)</label>
            <input id="nt-title" name="title" type="text" maxlength={200} placeholder="Server inventory" />
          </div>
          <button class="btn primary" type="submit">
            <Icon.plus /> Create table
          </button>
        </form>
        <details class="section">
          <summary>What the templates contain</summary>
          <ul class="small">
            {templates.map((t) => (
              <li>
                <strong>{t.title}</strong> ({t.description}):{" "}
                {t.columns.map((c, i) => (
                  <span>
                    {i ? ", " : ""}
                    {c.name}
                    {c.key ? " [key]" : ""} <span class="muted">({typeLabel(c.type)})</span>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section class="card" id="import" aria-labelledby="import-h">
        <h2 id="import-h">Import CSV or Excel</h2>
        <p class="muted small">
          Upload a .csv, .tsv or .xlsx file. You will see a preview with suggested column types before anything changes. Imported
          rows land in the draft; nothing reaches agents until you publish.
        </p>
        <form method="post" action="/tables/import" enctype="multipart/form-data" class="inline-form">
          <Csrf ctx={ctx} />
          <div class="field">
            <label for="im-file">File</label>
            <input id="im-file" type="file" name="file" required accept=".csv,.tsv,.txt,.xlsx,text/csv" />
          </div>
          <div class="field">
            <label for="im-target">Into</label>
            <select id="im-target" name="target">
              <option value="new">A new table</option>
              {tables.map((t) => (
                <option value={String(t.id)}>{t.path}</option>
              ))}
            </select>
          </div>
          <button class="btn primary" type="submit">
            <Icon.upload /> Preview import
          </button>
        </form>
      </section>
    </div>
  </Layout>
);

// ---------- grid editor ----------

export interface TablePageData {
  table: TableRecord;
  draftRows: number;
  diff: DraftDiff;
  versions: VersionRecord[];
}

const IssueList: FC<{ table: TableRecord; diff: DraftDiff; max?: number }> = ({ table, diff, max = 20 }) => {
  if (diff.issues.length === 0) return null;
  const name = (id: string) => table.columns.find((c) => c.id === id)?.name ?? id;
  return (
    <div class="issues" role="alert">
      <p>
        <strong>{plural(diff.issues.length, "problem")} must be fixed before publishing:</strong>
      </p>
      <ul>
        {diff.issues.slice(0, max).map((i) => (
          <li>
            Row {i.row}, {name(i.column)}: {i.message}
          </li>
        ))}
        {diff.issues.length > max ? <li>…and {diff.issues.length - max} more (red cells in the grid)</li> : null}
      </ul>
    </div>
  );
};

const DiffCounts: FC<{ diff: DraftDiff }> = ({ diff }) => (
  <p class="diff-counts" data-diff-counts>
    <span class="badge ok">+{diff.added.length} added</span> <span class="badge accent">~{diff.changed.length} changed</span>{" "}
    <span class="badge danger">−{diff.removed.length} removed</span>{" "}
    {diff.columnChanges.length ? <span class="badge">{plural(diff.columnChanges.length, "column change")}</span> : null}
  </p>
);

const ColumnRow: FC<{ ctx: PageCtx; table: TableRecord; col: Column; index: number }> = ({ ctx, table, col, index }) => {
  const base = `/tables/${table.id}/columns/${col.id}`;
  const isKey = table.keyColumn === col.id;
  return (
    <tr>
      <td>
        <strong>{col.name}</strong> {isKey ? <span class="badge accent">key</span> : null}
      </td>
      <td>{typeLabel(col.type)}</td>
      <td class="hide-sm small muted">{col.options?.join(", ") ?? ""}</td>
      <td class="actions">
        <form method="post" action={`${base}/move`} class="plain inline">
          <Csrf ctx={ctx} />
          <input type="hidden" name="dir" value="up" />
          <button class="btn ghost sm" type="submit" disabled={index === 0} aria-label={`Move ${col.name} left`} title="Move left">
            ←
          </button>
        </form>
        <form method="post" action={`${base}/move`} class="plain inline">
          <Csrf ctx={ctx} />
          <input type="hidden" name="dir" value="down" />
          <button
            class="btn ghost sm"
            type="submit"
            disabled={index === table.columns.length - 1}
            aria-label={`Move ${col.name} right`}
            title="Move right"
          >
            →
          </button>
        </form>
        <details class="menu">
          <summary class="btn ghost sm" aria-label={`Edit column ${col.name}`}>
            <Icon.dots />
          </summary>
          <div class="pop">
            <form method="post" action={base} class="stack">
              <Csrf ctx={ctx} />
              <div class="field">
                <label for={`cn-${col.id}`}>Name</label>
                <input id={`cn-${col.id}`} name="name" type="text" required maxlength={64} value={col.name} />
              </div>
              <div class="field">
                <label for={`ct-${col.id}`}>Type</label>
                <TypeSelect id={`ct-${col.id}`} selected={col.type} />
              </div>
              <div class="field" data-options-field>
                <label for={`co-${col.id}`}>
                  Choices <span class="hint">single select: one per line</span>
                </label>
                <textarea id={`co-${col.id}`} name="options" rows={4}>
                  {(col.options ?? []).join("\n")}
                </textarea>
              </div>
              <button class="btn primary sm" type="submit">
                Save column
              </button>
            </form>
            <hr />
            {!isKey && KEY_TYPES.has(col.type) ? (
              <form method="post" action={`/tables/${table.id}/key`} class="plain">
                <Csrf ctx={ctx} />
                <input type="hidden" name="column" value={col.id} />
                <button class="btn sm" type="submit">
                  Make this the key column
                </button>
              </form>
            ) : null}
            <form
              method="post"
              action={`${base}/delete`}
              class="plain"
              data-confirm={`Delete the column ${col.name}? Its values are removed from the draft; published versions keep them until you publish.`}
            >
              <Csrf ctx={ctx} />
              <button class="btn danger sm" type="submit">
                Delete column
              </button>
            </form>
          </div>
        </details>
      </td>
    </tr>
  );
};

export const TablePage: FC<{ ctx: PageCtx; data: TablePageData }> = ({ ctx, data }) => {
  const { table, diff, versions } = data;
  const keyCol = table.columns.find((c) => c.id === table.keyColumn);
  return (
    <Layout ctx={ctx} title={table.title} active="tables" assets={GRID_ASSETS} wide>
      <div class="page-head">
        <div>
          <Crumbs path={table.path} currentIsFile />
          <h1>{table.title}</h1>
          <p class="muted small">
            <span class="mono">cyberdrive:{table.path}</span> · <Status t={table} /> · {plural(data.draftRows, "draft row")}
            {keyCol ? (
              <span>
                {" "}
                · key: <strong>{keyCol.name}</strong>
              </span>
            ) : (
              <span> · no key column (lookup_row needs one)</span>
            )}
          </p>
        </div>
        <div class="row">
          <a class="btn primary" href={`/tables/${table.id}/publish`} data-publish-link>
            Review and publish
          </a>
          <a class="btn" href="#versions">
            <Icon.history /> Versions
          </a>
          {table.publishedVersion ? (
            <a class="btn" href={`/tables/${table.id}/export.csv`}>
              <Icon.download /> CSV
            </a>
          ) : null}
        </div>
      </div>
      <div class="stack">
        <section class="card grid-card" aria-labelledby="grid-h">
          <div class="row grid-toolbar">
            <h2 id="grid-h" class="sr-only">
              Draft rows
            </h2>
            <button class="btn sm" type="button" data-grid-add disabled={table.columns.length === 0}>
              <Icon.plus /> Add row
            </button>
            <button class="btn sm danger" type="button" data-grid-delete disabled>
              Delete selected rows
            </button>
            <button class="btn sm ghost" type="button" data-grid-clear-filters>
              Clear filters
            </button>
            <span class="spacer" />
            <span class="muted small" data-grid-status role="status" aria-live="polite">
              Loading…
            </span>
          </div>
          {table.columns.length === 0 ? (
            <p class="empty">This table has no columns yet. Add one below.</p>
          ) : null}
          <section
            id="grid"
            class="grid-host"
            data-table={String(table.id)}
            data-src={`/tables/${table.id}/draft.json`}
            data-edits={`/tables/${table.id}/edits`}
            data-paste={`/tables/${table.id}/paste`}
            aria-label={`${table.title} draft grid. Arrow keys move, Enter edits, Escape cancels, Delete clears, Ctrl+V pastes rows.`}
          ></section>
          <p class="muted small grid-help">
            Arrow keys move between cells; <kbd>Enter</kbd> or double-click edits; <kbd>Esc</kbd> cancels; <kbd>Delete</kbd> clears
            the selected cells; <kbd>Ctrl</kbd>+<kbd>V</kbd> pastes rows copied from Excel (into the selected cell, or as new rows
            when nothing is selected). Red cells do not match their column type and block publishing. Edits save to the draft as you
            go.
          </p>
          <noscript>
            <p class="flash warn">The grid needs JavaScript. You can still paste or import rows below and publish.</p>
          </noscript>
        </section>

        <div class="grid two">
          <section class="card" aria-labelledby="publish-h" id="publish">
            <h2 id="publish-h">Draft vs published</h2>
            <DiffCounts diff={diff} />
            <IssueList table={table} diff={diff} />
            <div class="row">
              <a class="btn primary" href={`/tables/${table.id}/publish`}>
                Review and publish
              </a>
              {table.dirty && table.publishedVersion ? (
                <form
                  method="post"
                  action={`/tables/${table.id}/discard`}
                  class="plain"
                  data-confirm={`Discard all draft changes and go back to v${table.publishedVersion}?`}
                >
                  <Csrf ctx={ctx} />
                  <button class="btn danger" type="submit">
                    Discard draft
                  </button>
                </form>
              ) : null}
            </div>
          </section>

          <section class="card" aria-labelledby="paste-h">
            <h2 id="paste-h">Paste rows</h2>
            <form method="post" action={`/tables/${table.id}/paste`} class="stack">
              <Csrf ctx={ctx} />
              <div class="field">
                <label for="paste-text">
                  Rows copied from Excel, Sheets or a CSV{" "}
                  <span class="hint">a first row with column names maps by name; otherwise columns are filled in order</span>
                </label>
                <textarea id="paste-text" name="text" rows={4} required placeholder={"web01\t10.0.0.5\tproduction"}></textarea>
              </div>
              <div class="row">
                <button class="btn" type="submit">
                  Add to draft
                </button>
                <span class="muted small">Rows whose key matches an existing row update it.</span>
              </div>
            </form>
          </section>
        </div>

        <section class="card flush" aria-labelledby="columns-h" id="columns">
          <div class="card-head">
            <h2 id="columns-h">Columns</h2>
          </div>
          {table.columns.length ? (
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col" class="hide-sm">
                      Choices
                    </th>
                    <th scope="col">
                      <span class="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {table.columns.map((col, i) => (
                    <ColumnRow ctx={ctx} table={table} col={col} index={i} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <form method="post" action={`/tables/${table.id}/columns`} class="inline-form pad">
            <Csrf ctx={ctx} />
            <div class="field">
              <label for="nc-name">New column</label>
              <input id="nc-name" name="name" type="text" required maxlength={64} placeholder="e.g. Asset tag" />
            </div>
            <div class="field">
              <label for="nc-type">Type</label>
              <TypeSelect id="nc-type" />
            </div>
            <div class="field" data-options-field>
              <label for="nc-options">
                Choices <span class="hint">single select: one per line</span>
              </label>
              <textarea id="nc-options" name="options" rows={1}></textarea>
            </div>
            <button class="btn" type="submit">
              <Icon.plus /> Add column
            </button>
          </form>
        </section>

        <section class="card flush" aria-labelledby="versions-h" id="versions">
          <div class="card-head">
            <h2 id="versions-h">Versions</h2>
          </div>
          <VersionTable ctx={ctx} table={table} versions={versions} />
        </section>

        <section class="card" aria-labelledby="settings-h">
          <h2 id="settings-h">Table settings</h2>
          <form method="post" action={`/tables/${table.id}/info`} class="inline-form">
            <Csrf ctx={ctx} />
            <div class="field">
              <label for="ti-title">Title</label>
              <input id="ti-title" name="title" type="text" maxlength={200} value={table.title} required />
            </div>
            <div class="field">
              <label for="ti-desc">Description (agents see it)</label>
              <input id="ti-desc" name="description" type="text" maxlength={2000} value={table.description} />
            </div>
            <button class="btn" type="submit">
              Save
            </button>
          </form>
          <p class="muted small">
            Lives in <a href={filesUrl(table.folder)}>{table.folder}</a>. Moving or renaming that folder moves the table with it.
          </p>
          <form
            method="post"
            action={`/tables/${table.id}/delete`}
            class="plain"
            data-confirm={`Delete the table ${table.path} with all its versions? Agents lose it immediately. This cannot be undone.`}
          >
            <Csrf ctx={ctx} />
            <button class="btn danger sm" type="submit">
              Delete table
            </button>
          </form>
        </section>
      </div>
    </Layout>
  );
};

const VersionTable: FC<{ ctx: PageCtx; table: TableRecord; versions: VersionRecord[] }> = ({ ctx, table, versions }) =>
  versions.length === 0 ? (
    <p class="empty">Not published yet. Agents cannot see this table until you publish it.</p>
  ) : (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Published</th>
            <th scope="col">Note</th>
            <th scope="col" class="num">
              Rows
            </th>
            <th scope="col" class="hide-sm">
              Changes
            </th>
            <th scope="col">
              <span class="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {[...versions].reverse().map((v) => (
            <tr>
              <td>
                <strong>v{v.version}</strong> {v.version === table.publishedVersion ? <span class="badge ok">live</span> : null}
              </td>
              <td>
                <Time iso={v.createdAt} /> <span class="muted small">by {v.actor}</span>
              </td>
              <td>{v.note}</td>
              <td class="num">{v.rowCount.toLocaleString("en-US")}</td>
              <td class="hide-sm small">
                +{v.added} ~{v.changed} −{v.removed}
                {v.columnChanges.length ? <span class="muted"> · {v.columnChanges.join("; ")}</span> : null}
              </td>
              <td class="actions">
                {v.version !== table.publishedVersion ? (
                  <form
                    method="post"
                    action={`/tables/${table.id}/rollback`}
                    class="plain"
                    data-confirm={`Roll back to v${v.version}? Agents see v${v.version}'s rows right away, as a new version; ${table.dirty ? "your unpublished draft changes are replaced. " : ""}nothing is deleted.`}
                  >
                    <Csrf ctx={ctx} />
                    <input type="hidden" name="version" value={String(v.version)} />
                    <button class="btn sm" type="submit">
                      <Icon.history /> Roll back to v{v.version}
                    </button>
                  </form>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

// ---------- publish review ----------

export const PublishPage: FC<{ ctx: PageCtx; table: TableRecord; diff: DraftDiff }> = ({ ctx, table, diff }) => {
  const max = 200;
  const section = (title: string, items: DraftDiff["added"], cls: string, sign: string) =>
    items.length ? (
      <div>
        <h3>
          {title} ({items.length})
        </h3>
        <ul class={`diff-list ${cls}`}>
          {items.slice(0, max).map((r) => (
            <li>
              <span aria-hidden="true">{sign}</span> <a href={`/tables/${table.id}/rows/${r.row}`}>{r.key}</a>
              {r.columns?.length ? <span class="muted small"> ({r.columns.join(", ")})</span> : null}
            </li>
          ))}
          {items.length > max ? <li class="muted">…and {items.length - max} more</li> : null}
        </ul>
      </div>
    ) : null;
  const blocked = diff.issues.length > 0 || !diff.pending || table.columns.length === 0;
  return (
    <Layout ctx={ctx} title={`Publish ${table.title}`} active="tables" assets={TABLE_CSS}>
      <PageHead
        title={`Publish ${table.title}`}
        sub={`This becomes v${table.publishedVersion + 1} of ${table.path}. Agents switch to it immediately; earlier versions stay for rollback.`}
      >
        <a class="btn" href={tableUrl(table.id)}>
          Back to the grid
        </a>
      </PageHead>
      <div class="stack">
        <section class="card" aria-labelledby="diff-h">
          <h2 id="diff-h">Changes since {table.publishedVersion ? `v${table.publishedVersion}` : "the start"}</h2>
          <DiffCounts diff={diff} />
          {diff.columnChanges.length ? (
            <div>
              <h3>Columns</h3>
              <ul>
                {diff.columnChanges.map((c) => (
                  <li>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {section("Added rows", diff.added, "added", "+")}
          {section("Changed rows", diff.changed, "changed", "~")}
          {section("Removed rows", diff.removed, "removed", "−")}
          {!diff.pending ? <p class="muted">Nothing to publish: the draft matches the published version.</p> : null}
        </section>
        <IssueList table={table} diff={diff} max={100} />
        <section class="card" aria-labelledby="note-h">
          <h2 id="note-h">Publish</h2>
          <form method="post" action={`/tables/${table.id}/publish`} class="stack">
            <Csrf ctx={ctx} />
            <div class="field">
              <label for="pub-note">
                Note <span class="hint">what changed and why; shown in the version history</span>
              </label>
              <input id="pub-note" name="note" type="text" required maxlength={500} placeholder="e.g. Added the new web tier" />
            </div>
            <div class="row">
              <button class="btn primary" type="submit" disabled={blocked}>
                Publish v{table.publishedVersion + 1}
              </button>
              {blocked ? (
                <span class="muted small">
                  {table.columns.length === 0
                    ? "Add at least one column first."
                    : diff.issues.length
                      ? "Fix the problems above first."
                      : "There are no changes to publish."}
                </span>
              ) : null}
            </div>
          </form>
        </section>
      </div>
    </Layout>
  );
};

// ---------- row history ----------

export const RowHistoryPage: FC<{
  ctx: PageCtx;
  history: {
    table: TableRecord;
    row: number;
    records: Array<{ from: number; to: number | null; note: string; at: string; actor: string; columns: Column[]; data: Record<string, unknown> }>;
    draft?: { data: Record<string, unknown>; errors: Record<string, string> };
  };
}> = ({ ctx, history }) => {
  const { table, row, records, draft } = history;
  const cols = table.columns;
  return (
    <Layout ctx={ctx} title={`Row ${row} history`} active="tables" assets={TABLE_CSS}>
      <PageHead title={`Row ${row} of ${table.title}`} sub={`cyberdrive:${table.path}#r${row}. Row ids are never reused.`}>
        <a class="btn" href={tableUrl(table.id)}>
          Back to the grid
        </a>
      </PageHead>
      <section class="card flush">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Versions</th>
                {cols.map((c) => (
                  <th scope="col">{c.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {draft ? (
                <tr>
                  <td>
                    <span class="badge warn">Draft</span>
                  </td>
                  {cols.map((c) => (
                    <td class={draft.errors[c.id] ? "cell-bad" : undefined} title={draft.errors[c.id]}>
                      {displayValue(draft.data[c.id])}
                    </td>
                  ))}
                </tr>
              ) : (
                <tr>
                  <td>
                    <span class="badge danger">Not in the draft</span>
                  </td>
                  <td colspan={Math.max(cols.length, 1)} class="muted">
                    Deleted in the draft; publishing removes it.
                  </td>
                </tr>
              )}
              {[...records].reverse().map((r) => (
                <tr>
                  <td>
                    v{r.from}
                    {r.to === null ? "–now" : r.to - 1 > r.from ? `–v${r.to - 1}` : ""}
                    <div class="muted small">{r.note}</div>
                  </td>
                  {cols.map((c) => (
                    <td>{r.columns.some((x) => x.id === c.id) ? displayValue(r.data[c.id]) : <span class="muted">–</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Layout>
  );
};

// ---------- import preview ----------

export interface ImportPreviewData {
  stage: string;
  fileName: string;
  sheets: string[];
  sheet: number;
  rows: number;
  columns: PreviewColumn[];
  /** Existing target, or undefined for a new table. */
  table?: TableRecord;
  folders: string[];
  suggestedName: string;
}

export const ImportPreviewPage: FC<{ ctx: PageCtx; data: ImportPreviewData }> = ({ ctx, data }) => {
  const t = data.table;
  const keyGuess = t ? undefined : data.columns.find((c) => KEY_TYPES.has(c.suggested.type) && c.suggested.type !== "number")?.index;
  return (
    <Layout ctx={ctx} title="Import preview" active="tables" assets={TABLE_CSS}>
      <PageHead
        title={`Import ${data.fileName}`}
        sub={`${plural(data.rows, "row")} found${data.sheets.length > 1 ? ` in sheet ${data.sheets[data.sheet]}` : ""}. Choose how each column lands${t ? ` in ${t.path}` : ""}. The rows go to the draft; you publish after checking them.`}
      >
        <a class="btn" href="/tables">
          Cancel
        </a>
      </PageHead>
      <form method="post" action={`/tables/import/${data.stage}`} class="stack">
        <Csrf ctx={ctx} />
        {data.sheets.length > 1 ? (
          <section class="card">
            <div class="field">
              <label for="im-sheet">Sheet</label>
              <select id="im-sheet" name="sheet" data-autosubmit-sheet>
                {data.sheets.map((s, i) => (
                  <option value={String(i)} selected={i === data.sheet}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <button class="btn sm" type="submit" name="action" value="sheet">
              Show this sheet
            </button>
          </section>
        ) : (
          <input type="hidden" name="sheet" value={String(data.sheet)} />
        )}
        {t ? null : (
          <section class="card inline-form">
            <div class="field">
              <label for="im-folder">Folder</label>
              <select id="im-folder" name="folder">
                {data.folders.map((f) => (
                  <option value={f}>{f}</option>
                ))}
              </select>
            </div>
            <div class="field">
              <label for="im-name">Table name</label>
              <input id="im-name" name="name" type="text" required maxlength={64} value={data.suggestedName} />
            </div>
          </section>
        )}
        <section class="card flush" aria-labelledby="map-h">
          <div class="card-head">
            <h2 id="map-h">Columns</h2>
          </div>
          <div class="table-wrap">
            <table class="map">
              <thead>
                <tr>
                  <th scope="col">From the file</th>
                  <th scope="col">Sample</th>
                  <th scope="col">Goes to</th>
                  <th scope="col">Type (new column)</th>
                  <th scope="col">Key</th>
                </tr>
              </thead>
              <tbody>
                {data.columns.map((c) => (
                  <tr>
                    <td>
                      <strong>{c.header}</strong>
                    </td>
                    <td class="small muted">{c.sample.join(" · ")}</td>
                    <td>
                      <label class="sr-only" for={`map-${c.index}`}>
                        Where {c.header} goes
                      </label>
                      <select id={`map-${c.index}`} name={`map_${c.index}`}>
                        {t?.columns.map((col) => (
                          <option value={`col:${col.id}`} selected={c.existing === col.id}>
                            {col.name} ({typeLabel(col.type)})
                          </option>
                        ))}
                        <option value="new" selected={!c.existing}>
                          New column “{c.header}”
                        </option>
                        <option value="skip">Skip</option>
                      </select>
                    </td>
                    <td>
                      <label class="sr-only" for={`type-${c.index}`}>
                        Type for {c.header}
                      </label>
                      <TypeSelect id={`type-${c.index}`} name={`type_${c.index}`} selected={c.suggested.type} />
                      {c.suggested.options ? <input type="hidden" name={`options_${c.index}`} value={c.suggested.options.join("\n")} /> : null}
                    </td>
                    <td>
                      <input
                        type="radio"
                        name="key"
                        value={String(c.index)}
                        checked={t ? t.columns.find((x) => x.id === t.keyColumn)?.id === c.existing && !!c.existing : keyGuess === c.index}
                        aria-label={`Use ${c.header} as the key column`}
                      />
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colspan={4} class="muted small">
                    {t ? "Keep the table's current key" : "No key column"}
                  </td>
                  <td>
                    <input
                      type="radio"
                      name="key"
                      value=""
                      checked={t ? !data.columns.some((c) => c.existing && c.existing === t.keyColumn) : keyGuess === undefined}
                      aria-label="No key change"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="muted small pad">
            Types are suggestions from the header and values. With a key column, rows whose key matches an existing row update it
            instead of adding a duplicate. Invalid cells are kept as typed and shown in red so you can fix them in the grid.
          </p>
        </section>
        <div class="row">
          <button class="btn primary" type="submit" name="action" value="import">
            Import into the draft
          </button>
        </div>
      </form>
    </Layout>
  );
};

// ---------- share view ----------

export const ShareTablePage: FC<{ token: string; share: ShareRecord; rel: string; published: PublishedTable }> = ({
  token,
  share,
  rel,
  published,
}) => {
  const { table, version, rows } = published;
  const cols = version.columns;
  const folderRel = rel.slice(0, rel.lastIndexOf("/")) || "/";
  const base = (p: string) => (p === "/" ? `/s/${token}` : `/s/${token}?path=${q(p)}`);
  const MAX = 2000;
  return (
    <ShareShell title={table.title}>
      <div class="page-head">
        <div>
          <Crumbs path={folderRel} base={base} rootLabel={share.label ?? "Shared folder"} />
          <h1>{table.title}</h1>
          <p class="muted small">
            Published v{version.version} · <Time iso={version.createdAt} /> · {plural(rows.length, "row")}
          </p>
        </div>
        <a class="btn" href={`/s/${token}/table.csv?path=${q(rel)}`}>
          <Icon.download /> Download CSV
        </a>
      </div>
      <section class="card flush">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th scope="col">{c.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, MAX).map((r) => (
                <tr>
                  {cols.map((c) => (
                    <td>{displayValue(r.data[c.id])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > MAX ? <p class="muted small pad">Showing the first {MAX}; download the CSV for all rows.</p> : null}
      </section>
    </ShareShell>
  );
};
