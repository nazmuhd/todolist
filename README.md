# Todoist Clone

A local-first Todoist clone: tasks, projects, labels, recurring tasks,
reminders, a calendar, karma stats, filters, dark mode — and it works
offline.

```
todoist/
├── todoist.html        the app shell
├── app.js              the app (ES module entry point)
├── storage.js          the storage adapter: localStorage + IndexedDB
├── styles.css
├── sw.js               service worker (offline)
├── manifest.webmanifest
├── vendor/             self-hosted libraries
├── src/                the app, split into modules
│   ├── core/           app.js (shared singletons) · dates.js (date helpers)
│   ├── features/       views and dialogs
│   └── views/          list · board · sidebar
├── server/             the API (Node + Express, pnpm, TypeScript)
│   ├── database/supabase/   migrations, seed, schema
│   ├── src/            the express app
│   └── tests/
├── docs/               architecture plan and notes
└── start.bat           boots the server (app + API)
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

The API lives under `/api`; the app is served from the repository root.
A plain static server (`python -m http.server`) still works for the app alone,
but then the API is a different origin.

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
