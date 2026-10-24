/** Server-rendered pages for the admin UI and public share links (Hono JSX, no client framework). */
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import type { KeyRecord } from "../auth/keys.ts";
import type { ActivityRow, DriveStats, Entry, VersionRow } from "../storage/drive.ts";
import { segmentsOf } from "../storage/paths.ts";
import { APP_VERSION } from "../version.ts";
import { DEFAULT_SHARE_HOURS, SHARE_EXPIRY_HOURS, type ShareRecord } from "./shares.ts";
import type { Snippet } from "./snippets.ts";

// ---------- helpers ----------

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

const nameOf = (p: string) => segmentsOf(p).at(-1) ?? "/";
const q = (p: string) => encodeURIComponent(p);
export const filesUrl = (p: string) => (p === "/" ? "/files" : `/files?path=${q(p)}`);
export const fileUrl = (p: string) => `/files/file?path=${q(p)}`;

const Time: FC<{ iso: string | null | undefined; abs?: boolean; empty?: string }> = ({ iso, abs, empty }) =>
  iso ? (
    <time datetime={iso} data-abs={abs ? "" : undefined}>
      {iso.replace("T", " ").slice(0, 16)} UTC
    </time>
  ) : (
    <span class="muted">{empty ?? "never"}</span>
  );

function actorLabel(actor: string): { text: string; kind: "key" | "admin" | "share" | "other" } {
  if (actor.startsWith("key:")) return { text: actor.slice(4), kind: "key" };
  if (actor.startsWith("share:")) return { text: `share link ${actor.slice(6)}`, kind: "share" };
  if (actor === "admin") return { text: "admin", kind: "admin" };
  return { text: actor, kind: "other" };
}

// ---------- icons (simple 24px line icons) ----------

const Svg: FC<PropsWithChildren<{ class?: string }>> = ({ children, class: cls }) => (
  <svg
    class={cls}
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);
export const Icon = {
  home: () => (
    <Svg>
      <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
    </Svg>
  ),
  folder: (p: { class?: string }) => (
    <Svg class={p.class}>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
    </Svg>
  ),
  file: () => (
    <Svg>
      <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z" />
      <path d="M14 3v5h5" />
    </Svg>
  ),
  key: () => (
    <Svg>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9M16 7l3 3M14 9l2 2" />
    </Svg>
  ),
  link: () => (
    <Svg>
      <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
      <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
    </Svg>
  ),
  activity: () => (
    <Svg>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </Svg>
  ),
  settings: () => (
    <Svg>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" />
    </Svg>
  ),
  upload: () => (
    <Svg>
      <path d="M12 16V4M7 9l5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </Svg>
  ),
  download: () => (
    <Svg>
      <path d="M12 4v12M7 11l5 5 5-5M4 20h16" />
    </Svg>
  ),
  copy: () => (
    <Svg>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </Svg>
  ),
  plus: () => (
    <Svg>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  dots: () => (
    <Svg>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </Svg>
  ),
  history: () => (
    <Svg>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </Svg>
  ),
  moon: () => (
    <Svg>
      <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />
    </Svg>
  ),
  logout: () => (
    <Svg>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11" />
    </Svg>
  ),
};

// ---------- shared pieces ----------

export interface Flash {
  kind: "ok" | "error" | "warn";
  message: string;
}

export interface PageCtx {
  csrf: string;
  mcpUrl: string;
  flash?: Flash;
}

const Csrf: FC<{ ctx: PageCtx }> = ({ ctx }) => <input type="hidden" name="_csrf" value={ctx.csrf} />;

const FlashBox: FC<{ flash?: Flash }> = ({ flash }) =>
  flash ? (
    <div class={`flash ${flash.kind}`} role={flash.kind === "error" ? "alert" : "status"}>
      {flash.message}
    </div>
  ) : null;

export const CopyField: FC<{ id: string; value: string; big?: boolean; label?: string }> = ({ id, value, big, label }) => (
  <div class={big ? "copy big" : "copy"}>
    <code id={id}>{value}</code>
    <button type="button" class="btn" data-copy={id} aria-label={label ?? "Copy"}>
      <Icon.copy />
      <span class="label">Copy</span>
    </button>
  </div>
);

const Head: FC<{ title: string; csrf?: string }> = ({ title, csrf }) => (
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="referrer" content="same-origin" />
    <meta name="robots" content="noindex, nofollow" />
    {csrf ? <meta name="csrf" content={csrf} /> : null}
    <title>{title} · Thumbdrive</title>
    <link rel="icon" href="/assets/icon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/assets/app.css" />
    <script src="/assets/theme.js"></script>
    <script src="/assets/app.js" defer></script>
  </head>
);

const Brand: FC<{ sub?: boolean }> = ({ sub }) => (
  <a class="brand" href="/">
    <img src="/assets/icon.svg" alt="" />
    <span class="name">
      Thumbdrive
      {sub ? <small>Read-only drive for agents</small> : null}
    </span>
  </a>
);

const NAV = [
  { href: "/", label: "Dashboard", icon: Icon.home, id: "home" },
  { href: "/files", label: "Files", icon: Icon.folder, id: "files" },
  { href: "/keys", label: "Agent keys", icon: Icon.key, id: "keys" },
  { href: "/shares", label: "Share links", icon: Icon.link, id: "shares" },
  { href: "/activity", label: "Activity", icon: Icon.activity, id: "activity" },
  { href: "/settings", label: "Settings", icon: Icon.settings, id: "settings" },
] as const;

export const Layout: FC<PropsWithChildren<{ ctx: PageCtx; title: string; active: string }>> = ({
  ctx,
  title,
  active,
  children,
}) => (
  <html lang="en">
    <Head title={title} csrf={ctx.csrf} />
    <body>
      <a class="skip" href="#main">
        Skip to content
      </a>
      <div class="shell">
        <header class="nav">
          <Brand sub />
          <nav aria-label="Main">
            <ul>
              {NAV.map((item) => (
                <li>
                  <a class="item" href={item.href} aria-current={item.id === active ? "page" : undefined} title={item.label}>
                    <item.icon />
                    <span class="label">{item.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div class="foot">
            <button type="button" class="btn ghost" data-theme-toggle aria-label="Switch light or dark theme">
              <Icon.moon />
              <span class="label">Theme</span>
            </button>
            <form method="post" action="/logout" class="plain">
              <Csrf ctx={ctx} />
              <button type="submit" class="btn ghost" aria-label="Sign out">
                <Icon.logout />
                <span class="label">Sign out</span>
              </button>
            </form>
            <span class="muted small label">v{APP_VERSION}</span>
          </div>
        </header>
        <main id="main">
          <FlashBox flash={ctx.flash} />
          {children}
        </main>
      </div>
    </body>
  </html>
);

const PageHead: FC<PropsWithChildren<{ title: Child; sub?: Child }>> = ({ title, sub, children }) => (
  <div class="page-head">
    <div>
      <h1>{title}</h1>
      {sub ? <p class="muted">{sub}</p> : null}
    </div>
    {children ? <div class="row">{children}</div> : null}
  </div>
);

// ---------- setup and login ----------

const AuthShell: FC<PropsWithChildren<{ title: string; csrf: string; flash?: Flash }>> = ({ title, csrf, flash, children }) => (
  <html lang="en">
    <Head title={title} csrf={csrf} />
    <body>
      <main class="auth" id="main">
        <div class="card">
          <Brand />
          <FlashBox flash={flash} />
          {children}
        </div>
      </main>
    </body>
  </html>
);

export const SetupPage: FC<{ csrf: string; flash?: Flash; minLength: number }> = ({ csrf, flash, minLength }) => (
  <AuthShell title="Set up" csrf={csrf} flash={flash}>
    <h1>Welcome</h1>
    <p class="muted">Choose the admin password. You will use it to manage files, keys and share links here.</p>
    <form method="post" action="/setup">
      <input type="hidden" name="_csrf" value={csrf} />
      <div class="field">
        <label for="password">Admin password</label>
        <input id="password" name="password" type="password" autocomplete="new-password" required minlength={minLength} autofocus />
        <span class="hint">At least {minLength} characters.</span>
      </div>
      <div class="field">
        <label for="confirm">Repeat password</label>
        <input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength={minLength} />
      </div>
      <button class="btn primary" type="submit">
        Save and continue
      </button>
    </form>
  </AuthShell>
);

export const LoginPage: FC<{ csrf: string; flash?: Flash; next: string }> = ({ csrf, flash, next }) => (
  <AuthShell title="Sign in" csrf={csrf} flash={flash}>
    <h1 class="sr-only">Sign in</h1>
    <form method="post" action="/login">
      <input type="hidden" name="_csrf" value={csrf} />
      <input type="hidden" name="next" value={next} />
      <input type="text" name="username" value="admin" autocomplete="username" hidden readonly />
      <div class="field">
        <label for="password">Admin password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
      </div>
      <button class="btn primary" type="submit">
        Sign in
      </button>
    </form>
    <p class="muted small">
      Forgot it? Run <code>node dist/admin.js set-password</code> on the server.
    </p>
  </AuthShell>
);

// ---------- dashboard ----------

export interface DashboardData {
  stats: DriveStats;
  activeKeys: number;
  activeShares: number;
  agentCalls24h: number;
  recent: ActivityRow[];
  loopback: boolean;
}

const McpUrlCard: FC<{ url: string; loopback: boolean }> = ({ url, loopback }) => (
  <section class="card highlight" aria-labelledby="mcp-url">
    <h2 id="mcp-url">MCP server URL</h2>
    <CopyField id="mcp-url-value" value={url} big label="Copy MCP URL" />
    <p class="muted small">
      Agents connect here with a key (<code>Authorization: Bearer td_…</code>). They can only read.
      {loopback
        ? " This address only works on this machine; agents on other devices use this machine's LAN address or hostname."
        : null}
    </p>
  </section>
);

export const DashboardPage: FC<{ ctx: PageCtx; data: DashboardData }> = ({ ctx, data }) => {
  const { stats } = data;
  const steps = [
    { done: stats.files > 0, text: <a href="/files">Upload files</a> },
    { done: data.activeKeys > 0, text: <a href="/keys">Create a key for an agent</a> },
    { done: data.agentCalls24h > 0 || data.recent.length > 0, text: <span>Paste the snippet into your agent and ask it to list the drive</span> },
  ];
  return (
    <Layout ctx={ctx} title="Dashboard" active="home">
      <PageHead title="Dashboard" sub="Your agents read from here. Only you can change what is on the drive.">
        <a class="btn" href="/files">
          <Icon.upload /> Upload files
        </a>
        <a class="btn" href="/keys#new-key">
          <Icon.key /> New key
        </a>
        <a class="btn" href="/shares#new-share">
          <Icon.link /> Share a folder
        </a>
      </PageHead>
      <div class="stack">
        <McpUrlCard url={ctx.mcpUrl} loopback={data.loopback} />
        <div class="grid stats">
          <a class="card stat" href="/files">
            <span class="value">{stats.files}</span>
            <span class="label">Files</span>
          </a>
          <a class="card stat" href="/files">
            <span class="value">{stats.folders}</span>
            <span class="label">Folders</span>
          </a>
          <div class="card stat">
            <span class="value">{formatBytes(stats.bytes)}</span>
            <span class="label">Stored (current files)</span>
          </div>
          <a class="card stat" href="/keys">
            <span class="value">{data.activeKeys}</span>
            <span class="label">Active keys</span>
          </a>
          <a class="card stat" href="/shares">
            <span class="value">{data.activeShares}</span>
            <span class="label">Active share links</span>
          </a>
          <a class="card stat" href="/activity">
            <span class="value">{data.agentCalls24h}</span>
            <span class="label">Agent reads, 24 h</span>
          </a>
        </div>
        {steps.some((s) => !s.done) ? (
          <section class="card">
            <h2>Get started</h2>
            <ol class="steps">
              {steps.map((s) => (
                <li class={s.done ? "done" : undefined}>{s.text}</li>
              ))}
            </ol>
          </section>
        ) : null}
        <section class="card flush" aria-labelledby="recent">
          <div class="card-head row">
            <h2 id="recent">Recent agent activity</h2>
            <span class="spacer" />
            <a href="/activity" class="small">
              All activity
            </a>
          </div>
          <ActivityTable rows={data.recent} empty="No agent has read anything yet." />
        </section>
      </div>
    </Layout>
  );
};

// ---------- files ----------

const Crumbs: FC<{ path: string; base?: (p: string) => string; rootLabel?: string; currentIsFile?: boolean }> = ({
  path,
  base = filesUrl,
  rootLabel = "Drive",
}) => {
  const segs = segmentsOf(path);
  return (
    <nav aria-label="Folder path" class="crumbs">
      {segs.length === 0 ? (
        <span aria-current="page">{rootLabel}</span>
      ) : (
        <a href={base("/")}>{rootLabel}</a>
      )}
      {segs.map((seg, i) => {
        const p = "/" + segs.slice(0, i + 1).join("/");
        return (
          <>
            <span class="sep" aria-hidden="true">
              /
            </span>
            {i === segs.length - 1 ? <span aria-current="page">{seg}</span> : <a href={base(p)}>{seg}</a>}
          </>
        );
      })}
    </nav>
  );
};

const MoveForm: FC<{ ctx: PageCtx; path: string; kind: "file" | "folder" }> = ({ ctx, path, kind }) => (
  <form method="post" action="/files/move" class="stack">
    <Csrf ctx={ctx} />
    <input type="hidden" name="path" value={path} />
    <div class="field">
      <label for={`mv-${q(path)}`}>Rename or move {kind}</label>
      <input id={`mv-${q(path)}`} type="text" name="to" value={path} required />
      <span class="hint">Change the name, or the whole path to move it.</span>
    </div>
    <button class="btn primary sm" type="submit">
      Save
    </button>
  </form>
);

const DeleteForm: FC<{ ctx: PageCtx; path: string; kind: "file" | "folder" }> = ({ ctx, path, kind }) => (
  <form
    method="post"
    action="/files/delete"
    class="plain"
    data-confirm={
      kind === "folder"
        ? `Delete the folder ${path} and everything in it? Each file keeps its history and can be restored.`
        : `Delete ${path}? Its history is kept and it can be restored.`
    }
  >
    <Csrf ctx={ctx} />
    <input type="hidden" name="path" value={path} />
    <button class="btn danger sm" type="submit">
      Delete {kind}
    </button>
  </form>
);

const EntryMenu: FC<{ ctx: PageCtx; entry: Entry }> = ({ ctx, entry }) => (
  <details class="menu">
    <summary class="btn ghost sm" aria-label={`Actions for ${entry.name}`}>
      <Icon.dots />
    </summary>
    <div class="pop">
      {entry.type === "file" ? (
        <div class="row">
          <a class="btn sm" href={`/files/download?path=${q(entry.path)}`}>
            <Icon.download /> Download
          </a>
          <a class="btn sm" href={fileUrl(entry.path)}>
            <Icon.history /> History
          </a>
        </div>
      ) : (
        <a class="btn sm" href={`/shares?folder=${q(entry.path)}#new-share`}>
          <Icon.link /> Share link
        </a>
      )}
      <hr />
      <MoveForm ctx={ctx} path={entry.path} kind={entry.type} />
      <hr />
      <DeleteForm ctx={ctx} path={entry.path} kind={entry.type} />
    </div>
  </details>
);

export interface FolderData {
  path: string;
  entries: Entry[];
  deleted: Array<{ path: string; name: string; deleted_at: string }>;
  maxFileBytes: number;
}

export const FolderPage: FC<{ ctx: PageCtx; data: FolderData }> = ({ ctx, data }) => {
  const { path, entries } = data;
  return (
    <Layout ctx={ctx} title={path === "/" ? "Files" : nameOf(path)} active="files">
      <div class="page-head">
        <Crumbs path={path} />
        <div class="row">
          <details class="menu">
            <summary class="btn">
              <Icon.plus /> New folder
            </summary>
            <div class="pop">
              <form method="post" action="/files/mkdir" class="stack">
                <Csrf ctx={ctx} />
                <input type="hidden" name="dir" value={path} />
                <div class="field">
                  <label for="new-folder">Folder name</label>
                  <input id="new-folder" type="text" name="name" required placeholder="e.g. handbook" />
                </div>
                <button class="btn primary sm" type="submit">
                  Create
                </button>
              </form>
            </div>
          </details>
          <a class="btn" href={`/shares?folder=${q(path)}#new-share`}>
            <Icon.link /> Share
          </a>
          {path !== "/" ? (
            <details class="menu">
              <summary class="btn" aria-label="Folder actions">
                <Icon.dots />
              </summary>
              <div class="pop">
                <MoveForm ctx={ctx} path={path} kind="folder" />
                <hr />
                <DeleteForm ctx={ctx} path={path} kind="folder" />
              </div>
            </details>
          ) : null}
        </div>
      </div>
      <div class="stack">
        <form
          id="dropzone"
          class="dropzone"
          method="post"
          action="/files/upload"
          enctype="multipart/form-data"
          data-dir={path}
          data-max={String(data.maxFileBytes)}
        >
          <Csrf ctx={ctx} />
          <input type="hidden" name="dir" value={path} />
          <div class="row">
            <Icon.upload />
            <span>
              Drop files or folders here to add them to <strong>{path === "/" ? "the drive" : nameOf(path)}</strong>, or
            </span>
            <input id="pick-files" class="file-input" type="file" name="file" multiple />
            <label for="pick-files" class="btn sm">
              Choose files
            </label>
            <input id="pick-folder" class="file-input" type="file" {...{ webkitdirectory: "" }} />
            <label for="pick-folder" class="btn sm">
              Choose a folder
            </label>
            <button class="btn sm primary no-js" type="submit">
              Upload
            </button>
          </div>
          <p class="muted small">
            Up to {formatBytes(data.maxFileBytes)} per file. A file with the same name gets a new version; the old one stays
            in its history.
          </p>
          <ul id="upload-list" class="uploads" hidden aria-live="polite"></ul>
        </form>

        <section class="card flush" aria-label="Folder contents">
          {entries.length === 0 ? (
            <p class="empty">This folder is empty.</p>
          ) : (
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col" class="num">
                      Size
                    </th>
                    <th scope="col" class="hide-sm">
                      Modified
                    </th>
                    <th scope="col" class="hide-sm">
                      SHA-256
                    </th>
                    <th scope="col">
                      <span class="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr>
                      <td class="name">
                        {e.type === "folder" ? (
                          <a href={filesUrl(e.path)}>
                            <Icon.folder class="folder" />
                            {e.name}
                          </a>
                        ) : (
                          <a href={fileUrl(e.path)}>
                            <Icon.file />
                            {e.name}
                          </a>
                        )}
                      </td>
                      <td class="num">{e.type === "file" ? formatBytes(e.size) : ""}</td>
                      <td class="hide-sm muted">
                        <Time iso={e.modified} />
                      </td>
                      <td class="hide-sm mono muted" title={e.sha256}>
                        {e.sha256 ? e.sha256.slice(0, 12) : ""}
                      </td>
                      <td class="actions">
                        <EntryMenu ctx={ctx} entry={e} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {data.deleted.length > 0 ? (
          <details class="section">
            <summary>Deleted from this folder ({data.deleted.length})</summary>
            <div class="card flush">
              <table>
                <tbody>
                  {data.deleted.map((d) => (
                    <tr>
                      <td class="name">
                        <a href={fileUrl(d.path)}>
                          <Icon.file />
                          {d.name}
                        </a>
                      </td>
                      <td class="muted">
                        deleted <Time iso={d.deleted_at} />
                      </td>
                      <td class="actions">
                        <a class="btn sm" href={fileUrl(d.path)}>
                          <Icon.history /> Restore…
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
      </div>
    </Layout>
  );
};

export interface FileData {
  path: string;
  exists: boolean;
  size?: number;
  sha256?: string;
  version?: number | null;
  modified?: string;
  history: VersionRow[];
}

export const FilePage: FC<{ ctx: PageCtx; data: FileData }> = ({ ctx, data }) => {
  const { path, history } = data;
  const parent = "/" + segmentsOf(path).slice(0, -1).join("/");
  return (
    <Layout ctx={ctx} title={nameOf(path)} active="files">
      <div class="page-head">
        <Crumbs path={path} />
        <div class="row">
          {data.exists ? (
            <>
              <a class="btn primary" href={`/files/download?path=${q(path)}`}>
                <Icon.download /> Download
              </a>
              <details class="menu">
                <summary class="btn">Rename or move</summary>
                <div class="pop">
                  <MoveForm ctx={ctx} path={path} kind="file" />
                </div>
              </details>
              <DeleteForm ctx={ctx} path={path} kind="file" />
            </>
          ) : (
            <span class="badge danger">Deleted</span>
          )}
        </div>
      </div>
      <div class="stack">
        {data.exists ? (
          <section class="card">
            <dl class="kv">
              <dt>Size</dt>
              <dd>{formatBytes(data.size)}</dd>
              <dt>Version</dt>
              <dd>{data.version ? `v${data.version}` : <span class="muted">no stored version yet (copied in by hand)</span>}</dd>
              <dt>Modified</dt>
              <dd>
                <Time iso={data.modified} abs />
              </dd>
              <dt>SHA-256</dt>
              <dd>
                <CopyField id="sha" value={data.sha256 ?? ""} label="Copy SHA-256" />
              </dd>
            </dl>
          </section>
        ) : (
          <div class="flash warn">This file was deleted. Restore any version below to bring it back.</div>
        )}
        <section class="card flush" aria-labelledby="hist">
          <div class="card-head">
            <h2 id="hist">Version history</h2>
          </div>
          {history.length === 0 ? (
            <p class="empty">No stored versions yet. The next change made here or with the CLI records one.</p>
          ) : (
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">Change</th>
                    <th scope="col" class="num">
                      Size
                    </th>
                    <th scope="col" class="hide-sm">
                      SHA-256
                    </th>
                    <th scope="col">When</th>
                    <th scope="col">
                      <span class="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((v) => {
                    const current = data.exists && data.version === v.version;
                    return (
                      <tr>
                        <td>
                          v{v.version} {current ? <span class="badge accent">current</span> : null}
                        </td>
                        <td>{v.action === "put" ? "saved" : <span class="badge danger">deleted</span>}</td>
                        <td class="num">{formatBytes(v.size)}</td>
                        <td class="hide-sm mono muted" title={v.sha256 ?? ""}>
                          {v.sha256?.slice(0, 12) ?? ""}
                        </td>
                        <td class="muted">
                          <Time iso={v.created_at} />
                        </td>
                        <td class="actions">
                          {v.action === "put" ? (
                            <div class="row">
                              <a
                                class="btn sm ghost"
                                href={`/files/download?path=${q(path)}&version=${v.version}`}
                                aria-label={`Download version ${v.version}`}
                              >
                                <Icon.download />
                              </a>
                              {current ? null : (
                                <form
                                  method="post"
                                  action="/files/restore"
                                  class="plain"
                                  data-confirm={`Restore v${v.version}? It becomes a new version; nothing is lost.`}
                                >
                                  <Csrf ctx={ctx} />
                                  <input type="hidden" name="path" value={path} />
                                  <input type="hidden" name="version" value={String(v.version)} />
                                  <button class="btn sm" type="submit">
                                    Restore
                                  </button>
                                </form>
                              )}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <p>
          <a href={filesUrl(parent)}>← Back to {parent === "/" ? "the drive" : nameOf(parent)}</a>
        </p>
      </div>
    </Layout>
  );
};

// ---------- keys ----------

const depthClass = (p: string) => {
  const d = Math.min(segmentsOf(p).length, 5);
  return d ? `d${d}` : undefined;
};

const FolderChecks: FC<{ folders: string[]; checked: string[]; idPrefix: string; legend: string }> = ({
  folders,
  checked,
  idPrefix,
  legend,
}) => (
  <fieldset class="checks">
    <legend class="sr-only">{legend}</legend>
    {folders.map((f, i) => (
      <label class={depthClass(f)} for={`${idPrefix}-${i}`}>
        <input id={`${idPrefix}-${i}`} type="checkbox" name="folders" value={f} checked={checked.includes(f)} />
        {f === "/" ? (
          <span>
            <strong>Whole drive</strong> <span class="muted">/</span>
          </span>
        ) : (
          <span>{nameOf(f)}</span>
        )}
      </label>
    ))}
  </fieldset>
);

export interface NewKey {
  name: string;
  token: string;
  folders: string[];
  snippets: Snippet[];
}

const NewKeyCard: FC<{ created: NewKey }> = ({ created }) => (
  <section class="card highlight stack" aria-labelledby="new-key-title">
    <div>
      <h2 id="new-key-title">Key “{created.name}” is ready</h2>
      <p class="muted">
        Copy it now. Only a hash is stored, so it cannot be shown again. It can read{" "}
        {created.folders.map((f) => (
          <span class="badge">{f}</span>
        ))}{" "}
        and nothing else.
      </p>
    </div>
    <CopyField id="new-token" value={created.token} big label="Copy key" />
    <div class="tabs">
      <div role="tablist" aria-label="Connection snippets">
        {created.snippets.map((s, i) => (
          <button
            type="button"
            role="tab"
            id={`tab-${s.id}`}
            aria-controls={`panel-${s.id}`}
            aria-selected={i === 0 ? "true" : "false"}
            tabindex={i === 0 ? 0 : -1}
          >
            {s.label}
          </button>
        ))}
      </div>
      {created.snippets.map((s, i) => (
        <div role="tabpanel" id={`panel-${s.id}`} aria-labelledby={`tab-${s.id}`} hidden={i !== 0}>
          <p class="muted small">{s.hint}</p>
          <div class="code-wrap">
            <pre class="code">
              <code id={`snippet-${s.id}`}>{s.code}</code>
            </pre>
            <button type="button" class="btn sm" data-copy={`snippet-${s.id}`} aria-label={`Copy ${s.label} snippet`}>
              <Icon.copy />
              <span class="label">Copy</span>
            </button>
          </div>
        </div>
      ))}
    </div>
  </section>
);

export const KeysPage: FC<{
  ctx: PageCtx;
  keys: KeyRecord[];
  folders: string[];
  created?: NewKey;
  form?: { name: string; folders: string[] };
}> = ({ ctx, keys, folders, created, form }) => {
  const active = keys.filter((k) => !k.revoked_at);
  const revoked = keys.filter((k) => k.revoked_at);
  return (
    <Layout ctx={ctx} title="Agent keys" active="keys">
      <PageHead
        title="Agent keys"
        sub="Each agent gets its own read-only key that opens only the folders you pick. Everything else is invisible to it."
      />
      <div class="stack">
        {created ? <NewKeyCard created={created} /> : null}
        <section class="card" id="new-key" aria-labelledby="new-key-h">
          <h2 id="new-key-h">New key</h2>
          <form method="post" action="/keys" class="grid two">
            <Csrf ctx={ctx} />
            <div>
              <div class="field">
                <label for="key-name">Name</label>
                <input
                  id="key-name"
                  type="text"
                  name="name"
                  required
                  maxlength={64}
                  pattern="[A-Za-z0-9][A-Za-z0-9 ._\-]{0,63}"
                  placeholder="e.g. laptop-cursor"
                  value={form?.name ?? ""}
                />
                <span class="hint">Who or what will use it. Letters, digits, spaces, dots, dashes.</span>
              </div>
              <button class="btn primary" type="submit">
                <Icon.key /> Create key
              </button>
            </div>
            <div class="field">
              <strong aria-hidden="true">Folders it can read</strong>
              <FolderChecks folders={folders} checked={form?.folders ?? []} idPrefix="nk" legend="Folders it can read" />
              <span class="hint">Pick one or more. Subfolders are included.</span>
            </div>
          </form>
        </section>
        <section class="card flush" aria-labelledby="keys-h">
          <div class="card-head">
            <h2 id="keys-h">Active keys</h2>
          </div>
          {active.length === 0 ? (
            <p class="empty">No keys yet. Create one above and paste it into your agent.</p>
          ) : (
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Folders</th>
                    <th scope="col" class="hide-sm">
                      Created
                    </th>
                    <th scope="col">Last used</th>
                    <th scope="col">
                      <span class="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((k) => (
                    <tr>
                      <td>
                        <strong>{k.name}</strong>
                        <div class="mono muted small">{k.prefix}…</div>
                      </td>
                      <td>
                        <div class="row">
                          {k.folders.map((f) => (
                            <span class="badge">{f}</span>
                          ))}
                        </div>
                      </td>
                      <td class="hide-sm muted">
                        <Time iso={k.created_at} />
                      </td>
                      <td class="muted">
                        <Time iso={k.last_used_at} />
                      </td>
                      <td class="actions">
                        <details class="menu">
                          <summary class="btn sm">Edit</summary>
                          <div class="pop">
                            <form method="post" action={`/keys/${k.id}/folders`} class="stack">
                              <Csrf ctx={ctx} />
                              <strong aria-hidden="true">Folders for {k.name}</strong>
                              <FolderChecks folders={folders} checked={k.folders} idPrefix={`k${k.id}`} legend={`Folders for ${k.name}`} />
                              <button class="btn primary sm" type="submit">
                                Save folders
                              </button>
                            </form>
                            <hr />
                            <form
                              method="post"
                              action={`/keys/${k.id}/revoke`}
                              class="plain"
                              data-confirm={`Revoke ${k.name}? Agents using it lose access immediately.`}
                            >
                              <Csrf ctx={ctx} />
                              <button class="btn danger sm" type="submit">
                                Revoke key
                              </button>
                            </form>
                          </div>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {revoked.length > 0 ? (
          <details class="section">
            <summary>Revoked keys ({revoked.length})</summary>
            <div class="card flush">
              <table>
                <tbody>
                  {revoked.map((k) => (
                    <tr>
                      <td>{k.name}</td>
                      <td class="muted">{k.folders.join(", ")}</td>
                      <td class="muted">
                        revoked <Time iso={k.revoked_at} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
      </div>
    </Layout>
  );
};

// ---------- share links ----------

const hoursLabel = (h: number) => (h < 24 ? `${h} hour${h === 1 ? "" : "s"}` : `${h / 24} day${h === 24 ? "" : "s"}`);

export const SharesPage: FC<{
  ctx: PageCtx;
  active: ShareRecord[];
  inactive: ShareRecord[];
  folders: string[];
  selected?: string;
  created?: { url: string; record: ShareRecord };
}> = ({ ctx, active, inactive, folders, selected, created }) => (
  <Layout ctx={ctx} title="Share links" active="shares">
    <PageHead
      title="Share links"
      sub="A share link lets anyone who has it browse and download one folder in a browser, read-only, until it expires."
    />
    <div class="stack">
      {created ? (
        <section class="card highlight" aria-labelledby="new-share-title">
          <h2 id="new-share-title">Link for {created.record.folder} is ready</h2>
          <CopyField id="share-url" value={created.url} big label="Copy share link" />
          <p class="muted small">
            Works until <Time iso={created.record.expires_at} abs />. Copy it now; only a hash is stored, so it cannot be
            shown again.
          </p>
        </section>
      ) : null}
      <section class="card" id="new-share" aria-labelledby="new-share-h">
        <h2 id="new-share-h">New share link</h2>
        <form method="post" action="/shares" class="inline-form">
          <Csrf ctx={ctx} />
          <div class="field">
            <label for="share-folder">Folder</label>
            <select id="share-folder" name="folder" required>
              {folders.map((f) => (
                <option value={f} selected={f === selected}>
                  {f === "/" ? "/ (whole drive)" : f}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="share-expiry">Expires after</label>
            <select id="share-expiry" name="hours">
              {SHARE_EXPIRY_HOURS.map((h) => (
                <option value={String(h)} selected={h === DEFAULT_SHARE_HOURS}>
                  {hoursLabel(h)}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="share-label">Note (optional)</label>
            <input id="share-label" type="text" name="label" maxlength={80} placeholder="e.g. for Sam" />
          </div>
          <button class="btn primary" type="submit">
            <Icon.link /> Create link
          </button>
        </form>
      </section>
      <section class="card flush" aria-labelledby="shares-h">
        <div class="card-head">
          <h2 id="shares-h">Active links</h2>
        </div>
        {active.length === 0 ? (
          <p class="empty">No active share links.</p>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Folder</th>
                  <th scope="col" class="hide-sm">
                    Link
                  </th>
                  <th scope="col">Expires</th>
                  <th scope="col" class="num">
                    Downloads
                  </th>
                  <th scope="col">
                    <span class="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {active.map((s) => (
                  <tr>
                    <td>
                      <strong>{s.folder}</strong>
                      {s.label ? <div class="muted small">{s.label}</div> : null}
                    </td>
                    <td class="hide-sm mono muted">/s/{s.prefix}…</td>
                    <td>
                      <Time iso={s.expires_at} />
                    </td>
                    <td class="num">{s.downloads}</td>
                    <td class="actions">
                      <form
                        method="post"
                        action={`/shares/${s.id}/revoke`}
                        class="plain"
                        data-confirm="Revoke this link? It stops working immediately."
                      >
                        <Csrf ctx={ctx} />
                        <button class="btn danger sm" type="submit">
                          Revoke
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {inactive.length > 0 ? (
        <details class="section">
          <summary>Expired and revoked ({inactive.length})</summary>
          <div class="card flush">
            <table>
              <tbody>
                {inactive.map((s) => (
                  <tr>
                    <td>{s.folder}</td>
                    <td class="muted">{s.label ?? ""}</td>
                    <td class="muted">
                      {s.revoked_at ? (
                        <>
                          revoked <Time iso={s.revoked_at} />
                        </>
                      ) : (
                        <>
                          expired <Time iso={s.expires_at} />
                        </>
                      )}
                    </td>
                    <td class="num muted">{s.downloads} downloads</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  </Layout>
);

// ---------- activity ----------

const ActivityTable: FC<{ rows: ActivityRow[]; empty: string }> = ({ rows, empty }) =>
  rows.length === 0 ? (
    <p class="empty">{empty}</p>
  ) : (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">Action</th>
            <th scope="col">Path</th>
            <th scope="col" class="hide-sm">
              Detail
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const who = actorLabel(r.actor);
            return (
              <tr>
                <td class="muted">
                  <Time iso={r.at} />
                </td>
                <td>
                  <span class={who.kind === "key" ? "badge accent" : who.kind === "share" ? "badge warn" : "badge"}>
                    {who.text}
                  </span>
                </td>
                <td>{r.action}</td>
                <td class="mono">{r.path ?? ""}</td>
                <td class="hide-sm muted small">{r.detail ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

export interface ActivityFilter {
  actor: string;
  action: string;
  path: string;
  all: boolean;
}

export const ActivityPage: FC<{
  ctx: PageCtx;
  rows: ActivityRow[];
  filter: ActivityFilter;
  actors: string[];
  actions: string[];
}> = ({ ctx, rows, filter, actors, actions }) => (
  <Layout ctx={ctx} title="Activity" active="activity">
    <PageHead title="Activity" sub="Every agent read, plus your own changes when you include them. Newest first." />
    <div class="stack">
      <form method="get" action="/activity" class="card inline-form" data-autosubmit aria-label="Filter activity">
        <div class="field">
          <label for="f-actor">Key</label>
          <select id="f-actor" name="actor">
            <option value="">All</option>
            {actors.map((a) => (
              <option value={a} selected={a === filter.actor}>
                {actorLabel(a).text}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="f-action">Action</label>
          <select id="f-action" name="action">
            <option value="">All</option>
            {actions.map((a) => (
              <option value={a} selected={a === filter.action}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="f-path">Path contains</label>
          <input id="f-path" type="search" name="path" value={filter.path} placeholder="e.g. handbook" />
        </div>
        <label class="row">
          <input type="checkbox" name="all" value="1" checked={filter.all} /> Include admin and share links
        </label>
        <button class="btn" type="submit">
          Filter
        </button>
      </form>
      <section class="card flush" aria-label="Activity log">
        <ActivityTable rows={rows} empty="Nothing matches." />
      </section>
      {rows.length >= 200 ? <p class="muted small">Showing the latest 200 entries.</p> : null}
    </div>
  </Layout>
);

// ---------- settings ----------

export const SettingsPage: FC<{ ctx: PageCtx; dataDir: string; maxFileBytes: number; envPassword: boolean }> = ({
  ctx,
  dataDir,
  maxFileBytes,
  envPassword,
}) => (
  <Layout ctx={ctx} title="Settings" active="settings">
    <PageHead title="Settings" />
    <div class="grid two">
      <section class="card" aria-labelledby="pw-h">
        <h2 id="pw-h">Admin password</h2>
        {envPassword ? (
          <p class="flash warn">
            THUMBDRIVE_ADMIN_PASSWORD is set, so the server resets the password to it on every start.
          </p>
        ) : null}
        <form method="post" action="/settings/password">
          <Csrf ctx={ctx} />
          <div class="field">
            <label for="current">Current password</label>
            <input id="current" name="current" type="password" autocomplete="current-password" required />
          </div>
          <div class="field">
            <label for="password">New password</label>
            <input id="password" name="password" type="password" autocomplete="new-password" required minlength={8} />
          </div>
          <div class="field">
            <label for="confirm">Repeat new password</label>
            <input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength={8} />
          </div>
          <button class="btn primary" type="submit">
            Change password
          </button>
          <p class="muted small">Changing it signs out every browser.</p>
        </form>
      </section>
      <section class="card" aria-labelledby="srv-h">
        <h2 id="srv-h">Server</h2>
        <dl class="kv">
          <dt>Version</dt>
          <dd>{APP_VERSION}</dd>
          <dt>MCP URL</dt>
          <dd class="mono">{ctx.mcpUrl}</dd>
          <dt>Data folder</dt>
          <dd class="mono">{dataDir}</dd>
          <dt>Largest file</dt>
          <dd>{formatBytes(maxFileBytes)}</dd>
        </dl>
        <p class="muted small">
          The admin CLI still works next to the UI, e.g. <code>node dist/admin.js key list</code>.
        </p>
      </section>
    </div>
  </Layout>
);

// ---------- public share pages ----------

const ShareShell: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <Head title={title} />
    <body>
      <main class="share-page" id="main">
        {children}
        <p class="muted small">Shared read-only with Thumbdrive.</p>
      </main>
    </body>
  </html>
);

export const SharePage: FC<{
  token: string;
  share: ShareRecord;
  rel: string;
  entries: Entry[];
}> = ({ token, share, rel, entries }) => {
  const base = (p: string) => (p === "/" ? `/s/${token}` : `/s/${token}?path=${q(p)}`);
  const title = share.label ?? nameOf(share.folder);
  return (
    <ShareShell title={title}>
      <div class="page-head">
        <div>
          <Crumbs path={rel} base={base} rootLabel={nameOf(share.folder) === "/" ? "Shared drive" : nameOf(share.folder)} />
          <p class="muted small">
            {share.label ? `${share.label} · ` : ""}Link expires <Time iso={share.expires_at} />
          </p>
        </div>
      </div>
      <section class="card flush" aria-label="Shared files">
        {entries.length === 0 ? (
          <p class="empty">This folder is empty.</p>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" class="num">
                    Size
                  </th>
                  <th scope="col" class="hide-sm">
                    SHA-256
                  </th>
                  <th scope="col">
                    <span class="sr-only">Download</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const childRel = rel === "/" ? `/${e.name}` : `${rel}/${e.name}`;
                  return (
                    <tr>
                      <td class="name">
                        {e.type === "folder" ? (
                          <a href={base(childRel)}>
                            <Icon.folder class="folder" />
                            {e.name}
                          </a>
                        ) : (
                          <a href={`/s/${token}/download?path=${q(childRel)}`}>
                            <Icon.file />
                            {e.name}
                          </a>
                        )}
                      </td>
                      <td class="num">{e.type === "file" ? formatBytes(e.size) : ""}</td>
                      <td class="hide-sm mono muted" title={e.sha256}>
                        {e.sha256?.slice(0, 12) ?? ""}
                      </td>
                      <td class="actions">
                        {e.type === "file" ? (
                          <a class="btn sm" href={`/s/${token}/download?path=${q(childRel)}`} aria-label={`Download ${e.name}`}>
                            <Icon.download />
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </ShareShell>
  );
};

export const MessagePage: FC<{ title: string; message: string; link?: { href: string; text: string } }> = ({
  title,
  message,
  link,
}) => (
  <html lang="en">
    <Head title={title} />
    <body>
      <main class="auth" id="main">
        <div class="card">
          <Brand />
          <h1>{title}</h1>
          <p class="muted">{message}</p>
          {link ? (
            <p>
              <a href={link.href}>{link.text}</a>
            </p>
          ) : null}
        </div>
      </main>
    </body>
  </html>
);
