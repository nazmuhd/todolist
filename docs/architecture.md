# Architecture & reorganization plan

How the repo will be organised before the Supabase work starts. This document
is the plan — nothing below has been executed yet.

---

## 1. Goals

1. `app.js` (≈5,100 lines) stops being one file and becomes a set of modules
   with clear ownership.
2. The `.md` notes move into `docs/` so the app root only contains things the
   browser loads.
3. The **storage layer stays the single seam** between the app and any backend.
   Supabase then lands in one place (`storage.js` + a new `sync.js`), not
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
│   │   └── supabase/       ← migrations, functions, README
│   │       ├── migrations/ ← numbered SQL, applied in order
│   │       └── functions/  ← Edge Functions (reminders, push)
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
│   └── saved-filters.js   ← the saved filter list the state normaliser reads
├── features/
│   ├── filters.js         ← query language, saved filters, the filter editor
│   ├── empty-states.js    ← per-view empty states
│   ├── task-row.js        ← the task row and its events
│   ├── selection.js       ← bulk selection and the batch bar
│   ├── calendar.js        ← month grid view
│   └── karma.js           ← productivity stats view
├── views/
│   ├── list.js            ← renderMain + the grouped views
│   ├── board.js           ← board view + its drag groups
│   └── sidebar.js         ← sidebar rendering, reordering, drop targets
└── ui/                     ← (step 7) chrome, menus
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
| `core/saved-filters.js` | the saved filter list, so the state normaliser can validate the active view |
| `features/due-editor.js` | the whole due-date dialog: `openDueEditor`, `syncDueEditor`, `applyNaturalDue`, `initDueCalendar`, repeat-end controls, reminders, start date |
| `features/task-modal.js` | `openTaskModal`, comments, sections, attachments, inline title edit |
| `features/task-row.js` | `renderTaskRow`, `bindTaskEvents`, the inline title and subtask editors |
| `features/selection.js` | `selectTask`, `clearSelection`, `renderSelection`, the batch bar and its actions |
| `features/context-menu.js` | `openContextMenu`, `runContextAction` |
| `features/quickadd.js` | `parseQuickAdd`, `updatePreview`, chip pickers, `submitQuickAdd` |
| `features/filters.js` | `parseQuery`, `queryMatcher`, saved filters, the filter editor |
| `features/settings.js` | the settings dialog, `loadSettings`, `persistSettings`, theme application |
| `features/calendar.js` | `renderCalendar`, month navigation, the day panel |
| `features/karma.js` | `karmaSummary`, `renderKarma` |
| `features/empty-states.js` | `EMPTY_STATES`, `currentEmptyState`, `showEmptyState` |
| `views/list.js` | `renderMain`, `renderUpcoming`, `renderCompleted`, `renderToday`, `renderProjectSectionsView`, `getViewInfo`, `sortTasks` |
| `views/board.js` | `renderBoard`, `renderBoardCard`, board drag groups |
| `views/sidebar.js` | `renderSidebar`, project/label rows, drag-reorder, drop targets |
| `ui/chrome.js` | the header, layout + sort menus, shortcut overlay, mobile-menu button |
| `ui/menus.js` | `positionMetaMenu`, `positionContextMenu`, the shared popover helpers |

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
| 8 | Update `sw.js` (cache list), `manifest.webmanifest` (`start_url`), add `start.bat` / README notes | offline check: reload with the network off |

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
| The service worker serves a stale bundle | Step 8 bumps the cache name (`todoist-clone-v2` → `v3`) and the cache list is updated with every new file |
| A behaviour slips through the split | The existing headless suites are re-run after every step; nothing is deleted until its replacement passes |
| Half-finished state on disk | Every step is a separate commit, so any step can be reverted on its own |

---

## 10. The backend: Node + Express with pnpm

**Decision:** Supabase provides the *services* (Postgres, Auth, Storage) and a
**Node + Express API** (pnpm-managed) is the single door the app talks to.

```
todoist/
├── src/                    ← the front-end (modules, no build step)
├── server/                 ← the API and worker (pnpm)
│   ├── package.json        ← "packageManager": "pnpm@9.x", engines: node >= 20
│   ├── pnpm-lock.yaml
│   ├── .npmrc              ← engine-strict=true, auto-install-peers=true
│   ├── tsconfig.json
│   ├── .env.example        ← DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
│   │                         VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, CORS_ORIGINS
│   ├── src/
│   │   ├── index.js        ← express app
│   │   ├── server.js       ← http server + graceful shutdown
│   │   ├── config.js       ← env parsing and validation
│   │   ├── lib/            ← supabase admin client, pg pool, JWT verification, logger
│   │   ├── middleware/     ← requireAuth, errorHandler, rateLimit
│   │   ├── routes/         ← tasks, projects, labels, comments, attachments,
│   │   │                     sync, reminders
│   │   ├── services/       ← sync/revision logic, reminder computation, Web Push
│   │   ├── jobs/           ← reminderWorker (the cron-like loop)
│   │   └── db/             ← pool + migration runner
│   └── tests/              ← node:test
├── supabase/
│   ├── migrations/         ← the ONE source of truth for SQL (numbered)
│   ├── seed.sql
│   └── functions/          ← optional Edge Functions
└── docs/
```

**Rules that keep it simple:**

- **The client talks only to the Express API**, never straight to PostgREST.
  One origin, one auth path, one place for validation — and the Supabase
  service-role key never reaches the browser. The API also serves the static
  app, so there is one process and one port (`http://localhost:4000`): the
  app at `/`, the API under `/api`.
- **Auth is Supabase Auth.** The client signs in (magic link / OAuth) and sends
  the access token as `Authorization: Bearer …`; the API verifies it against
  Supabase's JWKS and attaches `req.user`.
- **Attachments bypass the API for the bytes:** the client asks
  `POST /attachments/sign` for a presigned upload URL, uploads straight to
  Supabase Storage, then records the metadata.
- **Sync is per record.** Each table has a `rev` and `updated_at`; the client
  pulls `GET /sync/changes?since=<cursor>` and pushes
  `POST /sync/changes` with `{id, rev, patch}`. A stale `rev` comes back as a
  conflict *for that record only*.
- **Reminders run server-side.** The worker finds due reminders and sends Web
  Push (VAPID); the service worker in the browser stays as the best-effort
  fallback while the tab is closed.
- **pnpm only for `server/`.** The front-end keeps zero npm dependencies (the
  libraries are vendored in `vendor/`), so the two halves stay independent.

**Scripts in `server/package.json`**

```json
{
  "scripts": {
    "dev": "node --watch src/server.js",
    "start": "node src/server.js",
    "test": "node --test",
    "migrate": "node src/db/migrate.js",
    "seed": "node src/db/seed.js"
  }
}
```

---

## 11. How this helps the backend work

After the split, the backend lands in exactly three places:

1. `server/database/supabase/migrations/*.sql` — the schema, numbered like the client's
   `MIGRATIONS`, applied by `pnpm migrate` (the server) or the Supabase CLI.
2. `storage.js` — a new `SupabaseStore` implementing the **existing**
   interface (`loadState`/`saveState`/`getDoc`/`setDoc`/`putBlob`/`getBlob`/
   `deleteBlob`/`onChange`). No feature code changes.
3. `src/core/sync.js` — the client-side sync loop (push/pull, revisions,
   conflicts), a new core concern with its own interface.

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
| — `server/database/supabase/migrations/0001_schema.sql` — tables, `rev`/`updated_at` triggers, RLS enabled | **done** |
| 2 — `src/` skeleton + `core/app.js` singletons | **done** (`core/app.js`, `core/dates.js`) |
| 3 — extract the rest of `core/*` (state, tasks, undo, toasts) | **done** |
| 4 — extract `features/quickadd, due-editor, task-modal` | |
| 5 — extract `features/context-menu, filters, settings` | **done** (`features/filters.js`) |
| 6 — extract `views/*`, `features/calendar, karma` | **done** (`views/list.js`, `views/board.js`, `views/sidebar.js`, `features/calendar.js`, `features/karma.js`) |
| 7 — extract `ui/*` | |
| 8 — offline check (the service worker now serves network-first) | |

Decisions taken: **Vite + TypeScript** (gradual: `allowJs` first), **pnpm
workspaces** (one root install), `frontend/` and `server/` as the two halves, the
shell becomes `frontend/index.html`, and `storage.js` becomes a module so Vite can
bundle it. In development the Express server mounts Vite in middleware mode, so
there is still one process and one port.

**The app now needs a server** (ES modules and the service worker do not work
from `file://`). `start.bat` starts the static app and the API together.
`app.js` exports a small test surface so the headless harness can drive it
with `await import("/app.js")`.

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

*Plan only — steps 2–8 have not been executed yet.*
