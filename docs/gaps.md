# Gaps

This is a personal, single-user todo app. The active work is done; what
remains is either intentionally out of scope or blocked by browser platform
limits. The shipped checklist lives in `features.md`.

## Known limits

- **Location reminders** — a web app cannot geofence in the background, so
  these fire while a tab is open and the browser shares a position. Arriving
  or leaving a place with the app closed needs a native app. Custom
  reminders (relative to the due date, or at a specific date and time) are
  fully supported.
- **Email notifications** — needs an SMTP provider. Web Push already delivers
  reminders with the app closed.
- **Accounts, sharing and assignees** — out of scope by design. The server is a
  single-user local store.
- **Attachment size** — the number of files per task is unlimited, but each
  file must be 25 MB or smaller.
- **Layouts** — the task list has a **List**, a **Board** and a **Table**
  layout. The **Calendar** is a separate sidebar view (month, week, day).

## Not built

- **AI features** — there is no AI anywhere in the app: no task assist, no
  email assist, and no meeting-notes ("ramble") capture. Nothing is sent to
  a model provider, and the app needs no API key or account to work.
- **Activity history** — every change is logged (created, completed, moved,
  edited, deleted) and the log survives reloads. It records what happened,
  not the contents of an edit: there is no field-by-field diff, and the log
  is local to this browser rather than synced.
- **Automatic backups** — the server snapshots the data every hour and keeps
  the last 24, and you can restore one from Settings. The backups live on
  the server, so they need the server to be running; without it, the export
  button writes a backup file instead.

## Interoperability

- ✅ Import a **Todoist JSON backup** (projects, sections, labels, tasks,
  sub-tasks, notes, reminders, priorities, due dates and completion).
- ✅ Export this app's data as JSON, CSV, Markdown or ICS.
