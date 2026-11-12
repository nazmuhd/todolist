# Architecture

How the app is put together. This is the reference for the code as it is
today; the feature list lives in `features.md` and the known limits in
`gaps.md`.

## 1. What this is

A local-first, single-user todo app. The browser holds the working copy of
the data (IndexedDB), and an optional Node/Express API keeps a second copy
in SQLite and delivers push reminders when the browser is closed.

Two halves, one process:

```
todolist/
├── frontend/          the app (Vite, native ES modules)
├── server/            the API (Express + TypeScript + SQLite)
├── e2e/               end-to-end test against the real server
├── docs/              this file, plus features.md and gaps.md
├── design/            the HTML mockups the UI was built from
└── start.bat          boots the app and the API together
```

## 2. Principles

- **Local-first.** The UI reads from IndexedDB and never waits for the
  network. The API is a backup, a sync target and a push sender.
- **One way in.** The app talks to storage through a single adapter
  (`storage.js`), so swapping the backend is one line in `core/store.js`.
- **No circular imports.** The layering below is enforced by convention and
  checked by the type checker.
- **Plain data.** The state is a plain object; every module reads it and
  writes through `setState()`.

## 3. Module boundaries

```
core/       imports nothing from features/ or views/
features/   imports core/ only
views/      imports core/ and features/
ui/         imports core/ and features/
app.js      imports everything and wires it together
```

Two cycles would otherwise appear, so both are broken by a registry rather
than by an import:

- **core → views.** The core repaints after a change, but it must not import
  the views. `core/render.js` holds a renderer registry that `app.js`
  fills in (`setRenderer`).
- **features → app.** The views and features open dialogs and navigate, but
  they must not import the entry point back. `core/services.js` holds an
  app-level callback registry that `app.js` fills in.

`core/state.js` also avoids importing `core/undo.js` (which needs the state)
by exposing two hooks instead: `setStateSavedHook` and
`setStateChangedHook`.

## 4. The tree

```
frontend/src/
├── app.js                  the entry point: imports, wiring, boot
├── storage.js              the storage adapter (LocalStore, ApiStore)
├── styles.css              every style, including the dark theme
├── core/
│   ├── app.js              shared singletons ($, $$, uid, settings, modalState)
│   ├── state.js            the state, its shape, migrations, normalisation
│   ├── tasks.js            creating, completing and removing tasks; recurrence
│   ├── dates.js            parsing and formatting dates
│   ├── text.js             escaping, colours, priority clamping
│   ├── priorities.js       the built-in P1-P4 plus the user's own levels
│   ├── reminders.js         in-page reminders and notification permission
│   ├── location.js         location reminders (geofencing while a tab is open)
│   ├── undo.js             undo/redo, persisted across reloads
│   ├── activity.js         the activity log
│   ├── sync.js             the per-entity push/pull cycle
│   ├── store.js            the storage singleton
│   ├── router.js           hash routing and deep links
│   ├── render.js            the renderer registry
│   ├── services.js          the app-level callback registry
│   ├── saved-filters.js     the saved filter list
│   ├── push.js             Web Push registration
│   ├── backups.js          the server's automatic backups
│   ├── notification-actions.js  handling a notification's actions
│   ├── markdown.js          the safe Markdown subset
│   └── toasts.js           toasts and the screen-reader announcements
├── features/
│   ├── task-modal.js        the task dialog
│   ├── chip-menus.js        the due / priority / project / label menus
│   ├── due-editor.js        the due-date dialog
│   ├── context-menu.js      the right-click menu
│   ├── filters.js           the query language and saved filters
│   ├── projects.js          the project and label dialogs
│   ├── quickadd.js          the one-line task box
│   ├── task-row.js          a row in the list
│   ├── selection.js         multi-select and the batch bar
│   ├── calendar.js          the calendar views
│   ├── karma.js             the productivity stats
│   ├── templates.js         reusable task and project templates
│   ├── backup.js            export and import
│   ├── settings.js          the settings dialog
│   └── empty-states.js      the empty-state artwork
├── views/
│   ├── list.js              the main column: list, and the view filters
│   ├── board.js             the board layout
│   ├── table.js             the table layout
│   ├── activity.js          the activity history view
│   └── sidebar.js           the sidebar
└── ui/
    ├── chrome.js            the header, the sidebar rail, the shortcuts
    ├── menus.js             shared popover positioning
    ├── row-menu.js          the project / label / filter "…" menu
    └── rail-menu.js         the collapsed rail's upward menu
```

## 5. What the core modules do

| Module | Responsibility |
|---|---|
| `core/state.js` | the live state, `defaultState`, `normalizeState`, `MIGRATIONS` (v1 → v9) |
| `core/tasks.js` | `addTask`, `toggleComplete`, `removeTask`, recurrence rules |
| `core/priorities.js` | the built-in P1-P4 and the user's own levels |
| `core/undo.js` | `snapshotData`, `offerUndo`, `undoPending`, `redoPending` (a local-only `undo-history` doc) |
| `core/activity.js` | `recordActivity` and the log (a local-only `activity-history` doc) |
| `core/location.js` | the distance maths and the position watcher for location reminders |
| `core/sync.js` | `syncNow`, the push/pull cycle and its cursor metadata |
| `core/reminders.js` | when a reminder is due, and asking for notification permission |
| `core/router.js` | `isKnownView`, `navigateTo`, deep links |
| `core/render.js` | `setRenderer`, `requestRender` |
| `core/services.js` | the app-level callback registry |
| `features/chip-menus.js` | the task dialog's due / priority / project / label menus |
| `features/backup.js` | export (JSON, CSV, Markdown, ICS) and import |
| `features/due-editor.js` | the due-date dialog: calendar, repeat rules, reminders |
| `ui/menus.js` | `positionMetaMenu`, `positionBelowTrigger` |
| `ui/chrome.js` | the header, the sidebar rail, the keyboard shortcuts |

## 6. Storage

`frontend/src/storage.js` is an ES module with two classes:

- **`LocalStore`** — documents in IndexedDB (the `docs` store), attachments as
  blobs (the `files` store), and a `BroadcastChannel` for change
  notifications between tabs. `localStorage` is only the fallback for
  browsers without IndexedDB.
- **`ApiStore`** — extends `LocalStore`. Writes still go to IndexedDB first,
  then to the API best-effort. If the API is unreachable, everything keeps
  working; the sync catches up later.

The app only ever touches `store` (`core/store.js`), which is a single
`ApiStore` instance.

Side documents (`settings`, `filters`, the sidebar's preferences) are keyed
strings in the same store. The undo history and the activity log are
**local-only**: they are never sent to the server.

## 7. The backend

A single-user SQLite store behind a Node + Express API (TypeScript, pnpm).

```
server/
├── database/sqlite/migrations/   numbered SQL, applied in order
├── src/
│   ├── index.ts                 the express app
│   ├── server.ts                the http server, migrations, the workers
│   ├── config.ts                env parsing and validation
│   ├── middleware/              errorHandler
│   ├── routes/                  health, state, docs, blobs, sync, push
│   ├── services/                push delivery, reminders, automatic backups
│   └── db/                      the connection, the migration runner, the repository
└── tests/                       node:test
```

The rules that keep it simple:

- **One process, one port.** The API also serves the built app, so there is
  no CORS to configure and the service worker behaves normally.
- **No auth.** Every row belongs to the instance. Accounts arrive later.
- **Per-entity sync.** Projects, labels and tasks are separate `entities`
  rows, each with its own `rev` and a global `seq`. `GET /api/sync?since=`
  returns everything after the cursor; `POST /api/sync` pushes records with
  the revision they were based on. A stale revision is a conflict for that
  record only, and the client retries with the server's revision. Deletes are
  tombstones (`deleted = 1`), never hard deletes.
- **Reminders run server-side.** A worker reads the synced tasks every 30
  seconds and sends Web Push through VAPID. Without keys the worker does
  not start, and the in-page and service-worker timers remain as fallbacks.
- **Automatic backups.** The server snapshots the data after the writes
  settle, keeps the last 24, and can restore one (`/api/state/backups`).

The environment is validated on boot (`config.ts`); see `server/.env.example`
for the full list.

## 8. Testing

| Suite | What it covers |
|---|---|
| `frontend/tests/smoke.mjs` | the main flows, in a real browser |
| `frontend/tests/offline*.mjs` | offline use, the service worker, sync on reconnect |
| `frontend/tests/closed-tab.mjs` | work survives the tab closing |
| `frontend/tests/sync-regression.mjs` | a first sync must not lose local work |
| `frontend/tests/chip-menus.mjs`, `filters-dark.mjs` | the dialogs, the menus, dark mode |
| `frontend/tests/table-layout.mjs`, `location-reminders.mjs`, `activity-history.mjs` | the newer features |
| `server/tests/` | the API, on an in-memory database |
| `e2e/e2e.mjs` | the real server and the real app together |

The browser suites drive a headless Chromium over the DevTools protocol.
