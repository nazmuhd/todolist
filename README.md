# Todoist Clone

A local-first Todoist clone: tasks, projects, labels, recurring tasks,
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
├── server/                   the API (Node + Express, pnpm, TypeScript)
│   ├── database/supabase/    migrations, seed, schema
│   ├── src/                  the express app
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
```

The tests need a Chromium-based browser (Edge or Chrome). Set `BROWSER` to
its executable if it is not in the usual location. `pnpm test:smoke` covers
the main flows; `pnpm test:offline` loads the app once, switches the network
off and verifies the reload still boots from the service-worker cache.

A plain static server (`python -m http.server` inside `frontend/dist`) still
works for the app alone, but then the API is a different origin.

## The API (optional)

The app works fully offline on its own — the API only adds multi-device sync,
shared projects and reliable push reminders. See `docs/architecture.md` for the
design.

```bash
cd server
cp .env.example .env      # fill in your Supabase project
pnpm migrate              # apply server/database/supabase/migrations
pnpm test
```

## Docs

- `docs/architecture.md` — the module layout, the split plan and the backend design
- `docs/features.md` — feature status
- `docs/rightnow.md` — what is left, and what was deliberately declined
- `docs/later.md` — the work that needs a backend
