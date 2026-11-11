# Architecture & reorganization plan

How the repo is organised and how the backend fits in. The module split and
the first SQLite backend are now implemented; this document records the plan
and the decisions behind them.

---

## 1. Goals

1. `app.js` (≈5,100 lines) stops being one file and becomes a set of modules
   with clear ownership.
2. The `.md` notes move into `docs/` so the app root only contains things the
   browser loads.
3. The **storage layer stays the single seam** between the app and any backend.
   The backend then lands in one place (`storage.js` + a future `sync.js`), not
   scattered through features.
4. No behaviour change. Every step below is shippable on its own and is
   verified with the existing headless test harness before the next step.

---

## 2. Principles carried over from the current code

- **No build step, no framework.** Native ES modules, served as-is.
- **A feature is a section, not a file.** A concern becomes a file only when it
  has a stable interface other code talks to (that is why `storage.js` exists).
- **Layering, no circular imports** (see §4).
- `escapeHtml()` on every interpolated value; every write goes through the
  store adapter; every schema change bumps `SCHEMA_VERSION` *and* adds a
  numbered migration.
- One commit per step, docs updated in the same commit.

---

## 3. Target tree

```
todoist/
├── frontend/                ← the app (Vite + TypeScript)
│   ├── index.html            ← the app shell
│   ├── src/                  ← the modules
│   ├── public/               ← manifest, icon, service worker, vendor
│   ├── vite.config.ts
│   └── package.json          ← pnpm (workspace)
│
├── server/                 ← the API and worker (pnpm)
│   ├── database/
│   │   └── sqlite/         ← migrations
│   │       └── migrations/ ← numbered SQL, applied in order
│   └── src/                ← the express app (see §10)
│
├── docs/                     ← notes, not shipped
│   ├── architecture.md       ← this file
│   ├── features.md
│   ├── later.md
│   ├── rightnow.md
│   └── font.md
│
├── .env.example
└── .gitignore
```

The app's own modules live under `frontend/src/`:

```
frontend/src/
├── app.js                 ← the entry point: imports the modules, boots
├── core/
│   ├── app.js             ← shared singletons: settings, uid, $, $$
│   ├── state.js           ← defaultState, normalizeState, MIGRATIONS, saveState
│   ├── store.js           ← re-export of storage.js (see §6)
│   ├── dates.js           ← date/time helpers, formatDue, parseDate, …
│   ├── tasks.js           ← task CRUD: addTask, toggleComplete, removeTask
│   ├── undo.js            ← snapshots, undo/redo
│   ├── toasts.js          ← showToast + the screen-reader live region
│   ├── text.js            ← escapeHtml, highlightHtml, the colour palettes
│   ├── render.js          ← the renderer registry (breaks the core → views cycle)
│   ├── services.js        ← the app-level callback registry (views → app cycle)
│   ├── router.js          ← hash deep links and navigation
│   ├── reminders.js       ← notification permission, firing and the scheduler
│   └── saved-filters.js   ← the saved filter list the state normaliser reads
├── features/
│   ├── filters.js         ← query language, saved filters, the filter editor
│   ├── empty-states.js    ← per-view empty states
│   ├── task-row.js        ← the task row and its events
│   ├── task-modal.js      ← the task dialog, comments, sections, attachments
│   ├── due-editor.js      ← the due-date dialog, reminders and repeat end
│   ├── quickadd.js        ← quick-add parser, chips, pickers and submit
│   ├── context-menu.js    ← the task right-click menu
│   ├── projects.js        ← project/label dialogs and deletion
│   ├── settings.js        ← settings dialog, preferences and theme
│   ├── backup.js          ← JSON/CSV/Markdown/ICS export and import
│   ├── selection.js       ← bulk selection and the batch bar
│   ├── calendar.js        ← month grid view
│   └── karma.js           ← productivity stats view
├── views/
│   ├── list.js            ← renderMain + the grouped views
│   ├── board.js           ← board view + its drag groups
│   └── sidebar.js         ← sidebar rendering, reordering, drop targets
└── ui/                    ← chrome, menus
    ├── chrome.js          ← sidebar drawer, header, sort menu, shortcut overlay
    ├── menus.js           ← popover positioning (a leaf: imports nothing)
    └── row-menu.js        ← the project/label/filter "…" menu
```

---

## 4. Module boundaries (the rule that prevents circular imports)

```
core/      imports nothing from features/ or ui/
features/  imports core/ only
views/     imports core/ and features/
ui/        imports core/ and features/
main.js    imports everything and wires the events
```

**Shared mutable state lives in `core/app.js`**, not in a feature module. It
exports the singletons the old file had as globals:

```js
export const state = { ... };        // the live state object
export const els = { ... };          // cached DOM references
export let editingTaskId = null;
export const selection = new Set();
```

Features import what they need (`import { state, els } from '../core/app.js'`).
This is the one structural change that matters: today every section reaches
every other section through globals, so the split is mechanical *only* if the
shared things are named and exported once.

**Two registries break the remaining cycles.** Both live in `core/`, so
nothing points back up:

| Module | Holds | Why |
|---|---|---|
| `core/render.js` | the renderer | The core repaints after a change, but the core must not import the views: the views import the core. The entry point registers the real renderer once. |
| `core/services.js` | app-level callbacks | The views open dialogs and navigate, but those features live in the entry point. The entry point registers the callbacks once; the views call them through `services`. |

`core/app.js` also owns `modalState` (`editingTaskId` + `draft`). The task
dialog and the due-date editor both edit that draft, so keeping it in the
shared core is what stops those two features from importing each other.

`ui/menus.js` is the one deliberate exception to the layering rule: it only
positions popovers and imports nothing, so features can use it safely.

---

## 5. What maps to what

| New module | Comes from |
|---|---|
| `core/app.js` | the module-level `let state`, `const modal`, `const dueModal`, `const projectMenu`, `selection`, `editingTaskId` |
| `core/state.js` | `defaultState`, `normalizeState`, `migrateState`, `MIGRATIONS`, `SCHEMA_VERSION` |
| `core/dates.js` | `parseDate`, `toISODate`, `todayISO`, `daysFromToday`, `formatDue`, `formatTime`, `formatDateShort`, `formatDuration`, `isTaskOverdue`, `dueSortValue`, `taskDueDate` |
| `core/tasks.js` | `addTask`, `toggleComplete`, `removeTask`, `deleteTask`, `subtasksOf`, `nextOrder`, `cleanRecurrence`, `parseRecurrenceText`, `recurrenceToText`, `nextRecurrenceISO`, `firstRecurrenceISO`, `skipOccurrence`, `snoozeTask` |
| `core/text.js` | `escapeHtml`, `highlightHtml`, `asText`, `cleanColor`, `clampPriority`, the colour palettes |
| `core/undo.js` | `snapshotData`, `offerUndo`, `undoPending`, `redoPending`, `pendingUndo` |
| `core/toasts.js` | `showToast`, `announce`, the `#sr-status` live region |
| `core/render.js` | the renderer registry that breaks the core → views cycle |
| `core/services.js` | the app-level callback registry that breaks the views → app cycle |
| `core/router.js` | `isKnownView`, `currentHash`, `syncHash`, `applyHash`, `navigateTo` |
| `core/reminders.js` | `reminderKey`, `ensureNotificationPermission`, `notifyTask`, `checkReminders`, `startReminders` |
| `core/saved-filters.js` | the saved filter list, so the state normaliser can validate the active view |
| `features/due-editor.js` | the whole due-date dialog: `openDueEditor`, `syncDueEditor`, `applyNaturalDue`, `initDueCalendar`, repeat-end controls, reminders, start date |
| `features/task-modal.js` | `openTaskModal`, comments, sections, attachments, inline title edit |
| `features/task-row.js` | `renderTaskRow`, `bindTaskEvents`, the inline title and subtask editors |
| `features/selection.js` | `selectTask`, `clearSelection`, `renderSelection`, the batch bar and its actions |
| `features/context-menu.js` | `openContextMenu`, `runContextAction` |
| `features/quickadd.js` | `parseQuickAdd`, `updatePreview`, chip pickers, `submitQuickAdd` |
| `features/projects.js` | `openProjectModal`, `openLabelModal`, `deleteProject`, `deleteLabel` |
| `features/settings.js` | the settings dialog, `loadSettings`, `persistSettings`, theme application |
| `features/backup.js` | `exportData`, `exportCsv`, `exportMarkdown`, `exportIcs`, `parseBackup`, `applyBackup` |
| `features/filters.js` | `parseQuery`, `queryMatcher`, saved filters, the filter editor |
| `features/calendar.js` | `renderCalendar`, month navigation, the day panel |
| `features/karma.js` | `karmaSummary`, `renderKarma` |
| `features/empty-states.js` | `EMPTY_STATES`, `currentEmptyState`, `showEmptyState` |
| `views/list.js` | `renderMain`, `renderUpcoming`, `renderCompleted`, `renderToday`, `renderProjectSectionsView`, `getViewInfo`, `sortTasks` |
| `views/board.js` | `renderBoard`, `renderBoardCard`, board drag groups |
| `views/sidebar.js` | `renderSidebar`, project/label rows, drag-reorder, drop targets |
| `ui/chrome.js` | the header, layout + sort menus, shortcut overlay, keyboard shortcuts, sidebar drawer |
| `ui/menus.js` | `positionMetaMenu`, `positionContextMenu`, `positionBelowTrigger` |
| `ui/row-menu.js` | `openRowMenu`, `closeRowMenu` |

`app.js` (the current monolith) is **deleted** once its contents are distributed;
the new `app.js` is a ~20-line entry point.

---

## 6. The storage layer

`storage.js` stays exactly where it is, at the repo root, because it is loaded
as a **classic script** today and exposes `window.TodoStore`.

Two options for the module world:

- **(a) Keep it classic** — `storage.js` continues to set `window.TodoStore`, and
  `core/store.js` re-exports it:
  ```js
  export const { LocalStore, ApiStore } = window.TodoStore;
  ```
  Zero risk, no change to the file, and the service worker keeps caching it
  the same way.

- **(b) Convert it to a module** — cleaner, but it changes the load order and
  the service-worker cache list.

**Recommendation: (a).** `storage.js` is the one file a backend team will want
to read first, and keeping it classic means `ApiStore` can be added later
without touching the module graph.

---

## 7. The one behavioural change to be aware of

ES modules are fetched with CORS rules, so **`file://` will stop working** —
you would need a local server:

```
python -m http.server 8000      # then open http://localhost:8000
```

This is a smaller loss than it sounds:
- The **service worker already requires http(s)**, so `file://` today already
  loses the PWA, offline support and the install prompt.
- A one-line `serve.md` note (or a `start.bat` / `npm start` script) covers it.

If staying double-clickable matters more than the module split, the
alternative is a tiny concatenating build (`node build.js` → `app.bundle.js`)
that keeps `file://` working. **I recommend the local server**, and I will add
a `start.bat` + a note in the README so it is one double-click.

---

## 8. Step-by-step sequence

Each step is a commit, each keeps the app working, and each is verified with
the headless test harness (`__seed.js` + `__expr.js` + `__cdp.js`, temporary).

| # | Step | Verified by |
|---|---|---|
| 1 | Move the `.md` files into `docs/`; add `.gitignore`, `.env.example`, `docs/architecture.md` | app still boots, docs reachable |
| 2 | Add `src/` skeleton + `core/app.js` holding the shared singletons; `app.js` still contains everything but imports the singletons from `core/app.js` | app boots, no globals duplicated |
| 3 | Extract `core/dates.js`, `core/state.js`, `core/tasks.js`, `core/undo.js`, `core/toasts.js` | existing suites re-run unchanged |
| 4 | Extract `features/quickadd.js`, `features/due-editor.js`, `features/task-modal.js` | due-editor + quick-add suites |
| 5 | Extract `features/context-menu.js`, `features/filters.js`, `features/settings.js` | context-menu + query-language suites |
| 6 | Extract `views/list.js`, `views/board.js`, `views/sidebar.js`, `features/calendar.js`, `features/karma.js` | calendar + karma + board suites |
| 7 | Extract `ui/*`; delete the old monolith; `app.js` becomes the entry point | full suite + a manual pass over every view |

Steps 5 and 6 needed a cycle breaker before they could be done at all: the
views need the task dialog and the quick add, and the core needs the views to
repaint. `core/render.js` and `core/services.js` hold those two registries
(§4), so the imports keep pointing one way.
| 8 | Update `sw.js` (cache list), `manifest.webmanifest` (`start_url`), add `start.bat` / README notes | **done** — offline check: first visit, network off, reload; app, styles, vendor libraries and icons all load (8/8 headless Edge checks) |

Notes on the order: **core first** (everything depends on it), then the
features with the most tests, then views, then the chrome. The trickiest
module (`due-editor.js`, ~400 lines with the calendar, chrono, reminders and
repeat-end controls) is extracted early, while the rest of the file is still
untouched and easy to compare against.

---

## 9. Risks and how they are contained

| Risk | Containment |
|---|---|
| Circular imports | Strict layering (§4); `core/app.js` owns the shared singletons |
| The old file uses globals everywhere | Step 2 introduces the shared module *first*, so the rest is mechanical |
| `file://` breaks | §7 — a local server is required (the service worker already needed one); `start.bat` provided |
| The service worker serves a stale bundle | Step 8 bumps the cache name (`todoist-clone-v3` → `v4`); the worker precaches the shell's hashed bundle and vendored scripts on install, and fetches network-first afterwards |
| A behaviour slips through the split | The existing headless suites are re-run after every step; nothing is deleted until its replacement passes |
| Half-finished state on disk | Every step is a separate commit, so any step can be reverted on its own |

---

## 10. The backend: Node + Express with pnpm

**Decision:** the backend is a **single-user SQLite store** behind a
**Node + Express API** (pnpm, TypeScript). Supabase has been removed, and there
is no auth yet.

```
todoist/
├── frontend/                       ← the app (Vite)
├── server/                         ← the API (pnpm)
│   ├── database/sqlite/migrations/ ← numbered SQL, applied in order
│   ├── .env.example                ← DATABASE_PATH, PORT, CORS_ORIGINS, VAPID_*
│   ├── src/
│   │   ├── index.ts                ← express app
│   │   ├── server.ts               ← http server, migrations, graceful shutdown
│   │   ├── config.ts               ← env parsing and validation
│   │   ├── middleware/             ← errorHandler
│   │   ├── routes/                 ← health, state, docs, blobs
│   │   └── db/                     ← connection, migration runner, repository
│   └── tests/                      ← node:test
└── docs/
```

**Rules that keep it simple:**

- **The client talks only to the Express API.** The API also serves the built
  app, so there is one process and one port (`http://localhost:4000`): the app
  at `/`, the API under `/api`.
- **No auth.** The server is a single-user store; every row belongs to the
  instance. Accounts and `owner_id` columns arrive later.
- **Per-entity sync.** Projects, labels and tasks are separate `entities` rows,
  each with its own `rev` and a global `seq`. `GET /api/sync?since=<cursor>`
  returns everything after the cursor, and `POST /api/sync` pushes individual
  records with the revision they were based on. A stale revision is a conflict
  for that record only; the client retries with the server's revision. Deletes
  are tombstones (`deleted = 1`), never hard deletes. Side documents (settings,
  filters, reminders) and attachments are still `documents`/`blobs` rows.
  `GET/PUT /api/state` remains as a whole-state compatibility endpoint over the
  entity rows (exports/imports).
- **The client stays local-first.** `ApiStore` extends `LocalStore`: writes go
  to IndexedDB first, then sync best-effort. `core/sync.js` owns the
  push/pull cycle and its local cursor/revision metadata. Offline use and the
  service-worker reminder index keep working unchanged.
- **Migrations run on boot** and through `pnpm migrate`. The SQL lives only in
  `server/database/sqlite/migrations/`.
- **pnpm only for `server/`.** The front-end keeps zero runtime dependencies
  (the libraries are vendored in `public/vendor/`).
- **SQLite via `node:sqlite`**, built into Node 24 — no native module to
  compile on Windows.

**Scripts in `server/package.json`**

```json
{
  "scripts": {
    "dev": "node --watch --experimental-strip-types src/server.ts",
    "start": "node --experimental-strip-types src/server.ts",
    "test": "node --test",
    "migrate": "node --experimental-strip-types src/db/migrate.ts"
  }
}
```

---

## 11. How this helps the backend work

After the split, the backend lands in exactly three places:

1. `server/database/sqlite/migrations/*.sql` — the schema, numbered like the
   client's `MIGRATIONS`, applied by `pnpm migrate` or on server boot.
2. `frontend/src/storage.js` — `ApiStore` implements the **existing** interface
   (`loadState`/`saveState`/`getDoc`/`setDoc`/`putBlob`/`getBlob`/
   `deleteBlob`/`onChange`) on top of the local cache. No feature code changes.
3. `frontend/src/core/sync.js` — the per-entity sync loop (push/pull,
   per-record revisions, tombstones and conflict retries). It keeps its
   bookkeeping (cursor, revisions, last snapshot) in local storage, never on
   the server.

Everything else — tasks, views, modals — stays untouched. That is the whole
point of doing this first.

---

## 12. Open questions for you

1. **`file://` vs a local server** — accept the server requirement (§8), or
   keep double-click support with a tiny build step? (With an API server in the
   picture you need a server anyway, so this is now moot.)
2. **Rename `todoist.html` → `index.html`?** Cleaner URLs, but it touches the
   manifest, the service worker and your deep links.
3. **`storage.js` classic or module?** I recommend keeping it classic (§6).
4. **Naming**: keep `app.js` as the entry point, or call it `main.js` and put
   the entry in `src/`?
5. **Server language**: plain ESM JavaScript (no build, like the front-end) or
   TypeScript (types for the API contract; one extra command)? I recommend
   **TypeScript**, because a server is exactly where types pay off — but plain
   JS keeps the "no build step anywhere" symmetry.

---

## 13. Progress

| Step | Status |
|---|---|
| 1 — docs moved to `docs/`, `.gitignore`, `start.bat` | **done** |
| 0 — Vite + TypeScript (gradual), pnpm workspace, `frontend/` + `server/` | **done** |
| — `server/` skeleton (Express + TypeScript, pnpm) with `/health`, auth middleware, migration runner | **done** |
| — `server/database/supabase/migrations/0001_schema.sql` — tables, `rev`/`updated_at` triggers, RLS enabled | **removed** (Supabase dropped) |
| — SQLite backend — `node:sqlite`, `0001_init.sql`, repository, `/api/state`, `/api/docs`, `/api/blobs`, `ApiStore` | **done** |
| 2 — `src/` skeleton + `core/app.js` singletons | **done** (`core/app.js`, `core/dates.js`) |
| 3 — extract the rest of `core/*` (state, tasks, undo, toasts) | **done** |
| 4 — extract `features/quickadd, due-editor, task-modal` | **done** (`features/quickadd.js`, `features/due-editor.js`, `features/task-modal.js`) |
| 5 — extract `features/context-menu, filters, settings` | **done** (`features/context-menu.js`, `features/filters.js`, `features/settings.js`; project/label dialogs in `features/projects.js`, backup in `features/backup.js`) |
| 6 — extract `views/*`, `features/calendar, karma` | **done** (`views/list.js`, `views/board.js`, `views/sidebar.js`, `features/calendar.js`, `features/karma.js`) |
| 7 — extract `ui/*`; `app.js` becomes the entry point | **done** (`ui/chrome.js`, `ui/menus.js`, `ui/row-menu.js`; `app.js` is now ~170 lines of wiring) |
| 8 — offline check (the service worker now serves network-first) | **done** (`start_url` points at the app shell; the worker precaches the bundle and vendor scripts on install; permanent `frontend/tests/` harness: 24 smoke + 8 offline checks) |

Decisions taken: **Vite + TypeScript** (gradual: `allowJs` first), **pnpm
workspaces** (one root install), `frontend/` and `server/` as the two halves, the
shell becomes `frontend/index.html`, and `storage.js` becomes a module so Vite can
bundle it. In development the Express server mounts Vite in middleware mode, so
there is still one process and one port.

**The app now needs a server** (ES modules and the service worker do not work
from `file://`). `start.bat` starts the static app and the API together.
`app.js` exports a small test surface so the headless harness can drive it
with `await import("/app.js")`.

The app now has no monolith: `frontend/src/app.js` is the entry point, and
everything else lives under `core/`, `features/`, `views/` and `ui/`. The
extraction is covered by a permanent headless-browser suite
(`frontend/tests/`, run with `pnpm test`): a 24-check smoke pass over
project/label creation, quick add, the task dialog, the due editor, the
context menu, completion + undo, every view, board layout, settings, the
shortcut overlay, export and the sidebar drawer, plus an 8-check offline pass
that reloads with the network off.

### The cycles the split ran into

Two cycles had to be broken, and both are broken with a registry in `core/`
rather than with an import:

- **core → views.** `core/tasks.js` and `core/undo.js` repaint after a
  change, but the views import the core. `core/render.js` holds the renderer;
  the entry point registers the real one.
- **views → app.** The views open the task dialog, the quick add and the
  row menu, but those features still live in the entry point.
  `core/services.js` holds the callbacks; the entry point registers them.

The earlier extraction had left both cycles unresolved, which left dangling
references in `core/tasks.js` (`snapshotData`, `offerUndo`) and `core/undo.js`
(`render`, `syncHash`) — the undo path threw at runtime. Splitting the views
meant resolving them, so that is fixed here too.

---

*Steps 2–8 are complete. The frontend is modular and verified offline; backend
integration is the remaining work (§10–§11).*
