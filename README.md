# Todoist Clone

A local-first Todoist clone: tasks, projects, labels, recurring tasks,
reminders, a calendar, karma stats, filters, dark mode — and it works
offline.

```
todoist/
├── todoist.html        the app
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
└── start.bat           boots the app and the API together
```

## Running it

The app is served over HTTP (ES modules and the service worker both refuse to
run from `file://`).

```bat
start.bat
```

or by hand:

```bash
python -m http.server 8000     # the app  → http://localhost:8000
cd server && pnpm install && pnpm dev   # the API → http://localhost:4000
```

## The API (optional)

The app works fully offline on its own. The API in `server/` adds
multi-device sync, shared projects and reliable push reminders — see
`docs/architecture.md` for the design.

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
