# Gaps

This is a personal, single-user todo app. The active work is done; what
remains is either intentionally out of scope or blocked by browser platform
limits. The shipped checklist lives in `features.md`.

## Known limits

- **Location reminders** — arrival/leaving needs a native app with geofencing;
  a web app cannot do this reliably. Custom reminders are fully supported
  (relative to the due date, or at a specific date and time).
- **Email notifications** — needs an SMTP provider. Web Push already delivers
  reminders with the app closed.
- **Accounts, sharing and assignees** — out of scope by design. The server is a
  single-user local store.
- **Attachment size** — the number of files per task is unlimited, but each
  file must be 25 MB or smaller.
- **Layouts** — the task list has a **List** and a **Board** layout. The
  **Calendar** is a separate sidebar view (month, week, day), not a third
  layout. There is no table layout.

## Not built

- **Activity history** — the Karma view counts completions per day, streaks
  and totals from the tasks themselves. It is not an audit log: there is no
  record of edits, and a deleted task leaves no trace.
- **Automatic backups** — nothing is backed up on a schedule. A safety copy is
  kept when the saved data turns out to be unreadable, and again before an
  import. Your data otherwise lives in the browser's IndexedDB and, if you run
  the server, in the SQLite file.

## Interoperability

- ✅ Import a **Todoist JSON backup** (projects, sections, labels, tasks,
  sub-tasks, notes, reminders, priorities, due dates and completion).
- ✅ Export this app's data as JSON, CSV, Markdown or ICS.
