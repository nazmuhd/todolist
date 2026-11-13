# Todolist

A local-first todo app: tasks, projects, labels, recurring tasks, reminders, a
calendar, karma stats, filters, dark mode — and it works offline. No AI
features, no accounts, no API keys.

## Run it

**One process serves everything** (app + API + landing page):

```bat
start.bat
```

Then open **http://localhost:4000** (landing page) — the app lives at
**http://localhost:4000/app/v1/#/inbox**.

By hand:

```bash
cd server
pnpm install
pnpm dev          # http://localhost:4000 — app + API + HMR
```

Frontend only:

```bash
cd frontend
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # production bundle in frontend/dist
pnpm typecheck    # tsc --noEmit
pnpm test         # 14 headless suites (builds first)
pnpm test:profile # profile/nav/add-task/due-date UI checks
```

Tests need a Chromium-based browser (Edge or Chrome). Set `BROWSER` to its
executable if it isn't in the usual location.

## Stack

- **Frontend:** Vite, native ES modules, IndexedDB + a sync adapter
- **Backend:** Node + Express, TypeScript, SQLite via Node's built-in
  `node:sqlite` (`DatabaseSync`, synchronous). No native module to build.
- **Push:** Web Push (VAPID) with per-device management and retry/backoff
- **Backups:** hourly server snapshots, last 24 kept, restore from the app

## Key features

- Tasks: title, description, project, labels, priority, due date/time, all-day
- Recurrence (RRULE) with end conditions (after N / on a date), completion-based
- Multiple reminders (preset + custom offsets) and absolute-time reminders
- Location reminders (fire while a tab is open)
- Custom priority levels, sub-tasks, sections, comments, attachments (≤25 MB)
- Deadlines separate from due dates; estimated duration
- List / Board / Table layouts; calendar view (month/week/day)
- Saved filters, quick add with NLP dates, reusable templates
- Undo/redo across reloads, multi-tab sync, dark mode, PWA/offline
- Karma stats, activity history, notifications with snooze/complete actions

## Environment

```bash
cd server
cp .env.example .env      # optional
pnpm migrate              # also runs on boot
```

Optional push env: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
Quiet hours: `QUIET_HOURS_START=22:00`, `QUIET_HOURS_END=07:00`.
Backup schedule: `BACKUP_INTERVAL_MINUTES=60`, `BACKUP_KEEP=24`.

Attachment cleanup: `POST /api/blobs/cleanup?olderThanHours=24`.

## Docs

- `docs/architecture.md` — module layout, layering, storage, backend design
- `docs/features.md` — feature status
- `docs/gaps.md` — known limits and what is not built
- `design/` — the HTML mockups the UI was built from

## Notes

- Exports: `todolist-*.json` / `.csv` / `.md` / `.ics`. Older `todoist-*`
  backups still import (format detected from contents).
- Undo history lives in IndexedDB (latest action, 24 h).
- Database file (`server/data/todoist.db`) and `-wal`/`-shm` siblings are
  created on first boot and must not be committed.
- No auth yet: single-user store. Accounts/sharing are out of scope.