# Gaps

This is a personal, single-user todo app. The active work is done; what
remains is either intentionally out of scope or blocked by browser platform
limits. The shipped checklist lives in `features.md`.

## Known limits

- **Location reminders** — arrival/leaving needs a native app with geofencing;
  a web app cannot do this reliably.
- **Email notifications** — needs an SMTP provider. Web Push already delivers
  reminders with the app closed.
- **Accounts, sharing and assignees** — out of scope by design. The server is a
  single-user local store.

## Interoperability

- ✅ Import a **Todoist JSON backup** (projects, sections, labels, tasks,
  sub-tasks, notes, reminders, priorities, due dates and completion).
- ✅ Export this app's data as JSON, CSV, Markdown or ICS.
