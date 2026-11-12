# Todolist

A local-first todo app: tasks, projects, labels, recurring tasks,
reminders, a calendar, karma stats, filters, dark mode — and it works
offline.

```
todoist/
├── frontend/                 the app (Vite, native ES modules)
│   ├── index.html            the app shell
│   ├── src/
│   │   ├── app.js            entry point and wiring
│   │   ├── storage.js        the storage adapter: localStorage + IndexedDB
│   │   ├── core/             state, store, router, services, dates, reminders
│   │   ├── features/         dialogs and feature logic (task modal, quick add, …)
│   │   ├── ui/               chrome, menus, row menu
│   │   └── views/            list · board · calendar · karma · sidebar
│   └── public/               service worker, manifest, icon, vendor libraries
├── e2e/                      real-server end-to-end test (Express + SQLite + browser)
├── server/                   the API (Node + Express, pnpm, TypeScript)
│   ├── database/sqlite/      numbered SQL migrations
│   ├── src/                  the express app, SQLite repository and routes
│   └── tests/
├── docs/                     architecture plan and notes
└── start.bat                 boots the server (app + API)
```

## Running it

**One process serves everything.** The Express server hosts the API *and* the
static app, so the app and the API share an origin (no CORS to configure) and
the service worker behaves normally.

```bat
start.bat
```

then open **http://localhost:4000**.

By hand:

```bash
cd server
pnpm install
pnpm dev          # http://localhost:4000 — app + API
```

The API lives under `/api`; the app is built from `frontend/` and served from
`frontend/dist` in production. To work on the app alone with hot reloading:

```bash
cd frontend
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # production bundle in frontend/dist
pnpm typecheck    # tsc --noEmit
pnpm test         # headless smoke + offline tests (builds first)
pnpm test:e2e     # real Express + SQLite + browser, per-entity sync
```

The tests need a Chromium-based browser (Edge or Chrome). Set `BROWSER` to
its executable if it is not in the usual location. `pnpm test:smoke` covers
the main flows; `pnpm test:offline` loads the app once, switches the network
off and verifies the reload still boots from the service-worker cache.
`pnpm test:e2e` starts the real server against a throwaway SQLite file and
checks that a task is pushed to `/api/sync`, pulled back by a second client
and restored after a reload.

A plain static server (`python -m http.server` inside `frontend/dist`) still
works for the app alone: the API is unavailable there, so the app simply stays
local-only in that browser.

## The API (optional)

The app works fully offline on its own — the API only adds persistence beyond
this browser, multi-device sync and reliable push reminders. It is a
**single-user SQLite store with no auth yet** (per-entity sync, side documents
and attachments). See `docs/architecture.md` for the design.

```bash
cd server
cp .env.example .env      # optional; DATABASE_PATH defaults to ./data/todoist.db
pnpm migrate              # also applied automatically on boot
pnpm test
```

SQLite comes from Node's built-in `node:sqlite` (Node 24), so there is no native
module to build. The database file and its `-wal`/`-shm` siblings are created
on first boot and should not be committed.

The sync feed is pageable for large datasets:
`GET /api/sync?since=<cursor>&limit=100` returns `hasMore` and a `cursor` to
resume from. The app does this automatically; the response bodies stay bounded
while the local model still holds the full set.

### Push reminders

Generate VAPID keys and put them in `server/.env`:

```bash
npx web-push generate-vapid-keys
```

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

Restart the server, then open **Settings → Enable push reminders**. The server
worker checks the synced tasks every 30 seconds and sends notifications through
the service worker, so they still arrive with the app closed. Without VAPID
keys the in-page and service-worker timers keep working as before.

Reminders can be completed or snoozed from the notification itself. Each
browser registers as its own device (shown in Settings and removable), and
transient push failures are retried. To hold notifications overnight:

```
QUIET_HOURS_START=22:00
QUIET_HOURS_END=07:00
```

A window may cross midnight; leave both blank (or equal) to disable it.

### Attachment cleanup

Attachments abandoned without a task (an upload that was never saved, or a
deleted task) can be removed after a guard period:

```bash
curl -X POST "http://localhost:4000/api/blobs/cleanup?olderThanHours=24"
```

### Backups, imports and undo

**Sidebar → Export** downloads this app's data as JSON, CSV, Markdown or ICS.
**Sidebar → Import** accepts either this app's JSON backup or a **Todoist JSON
backup**; projects, sections, labels, sub-tasks, notes, reminders, priorities,
due dates and completed items are converted. Your current data is copied to a
pre-import recovery slot first.

Exports are named `todolist-*.json` / `.csv` / `.md` / `.ics`. Older backups
named `todoist-*` still import: the format is detected from the file's
contents, not its name.

Undo/redo history is kept in IndexedDB (the latest action, for 24 hours), so
Ctrl+Z / Ctrl+Shift+Z still work after a reload.

## Docs

- `docs/architecture.md` — the module layout, the split plan and the backend design
- `docs/features.md` — feature status
- `docs/gaps.md` — known limits and interoperability
- `docs/deferred.md` — what is intentionally not built
