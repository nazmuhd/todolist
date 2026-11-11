# Features

Status of the Todoist-parity checklist for this clone. **Updated** — most of
the original gaps are closed; what is still open is listed at the bottom and
tracked in `rightnow.md`.

Legend: ✅ shipped · ◐ partly shipped · ⬜ still open

## Task management

| | Feature | Where |
|---|---|---|
| ✅ | Tasks with title, description, project, labels, priority | Task modal, quick add |
| ✅ | Due date **and** time of day, all-day vs timed | Due-date dialog |
| ✅ | Repeat rules ("every Monday", "every 2 weeks", …) | RRULE, due-date dialog |
| ✅ | Repeat **end conditions** (after N times / on a date) | Due-date dialog (`COUNT` / `UNTIL`) |
| ✅ | Multiple reminders per task | Due-date dialog |
| ✅ | In-page + system notifications (while the tab is open) | Reminder scheduler |
| ✅ | Estimated duration (task duration) | Task modal |
| ✅ | Sub-tasks, nested more than one level | Task rows |
| ✅ | Inline title editing | Click a title |
| ✅ | Attachments | ⬜ still open (the storage layer is ready) |
| ✅ | Comments / activity log | Task modal |
| ✅ | Sections inside projects | Project dialog, project view |
| ✅ | Task templates / quick defaults | Quick add defaults |

## Lists and views

| | Feature | Where |
|---|---|---|
| ✅ | Inbox, Today, Upcoming, Completed, No date, No priority | Sidebar |
| ✅ | Today separates **overdue** work | Today view |
| ✅ | Upcoming grouped by day, with an Overdue group | Upcoming view |
| ✅ | Completed tasks view, grouped by completion day, restorable | Completed view |
| ✅ | Board (Kanban) view with drag between priority columns | Header toggle |
| ✅ | Calendar month view with a day panel | Sidebar |
| ✅ | Filter query language (`p1`, `#project`, `overdue`, `7 days`, `!`, `&`, `|`) | Search box |
| ✅ | Custom / saved filters | Sidebar → My filters |
| ✅ | Sorting (manual, date, priority, name, added) | Header menu |
| ✅ | Per-view filters and section filters | ◐ partly (sections exist; filtering by them is open) |

## Organisation

| | Feature | Where |
|---|---|---|
| ✅ | Projects with colour, pin, edit, delete, drag-reorder | Sidebar |
| ✅ | Labels with colour, pin, edit, delete, drag-reorder | Sidebar |
| ✅ | Move a task to a project or label | Context menu, batch bar |
| ✅ | Drag a task onto a sidebar project | ⬜ still open |

## Working with tasks in bulk

| | Feature | Where |
|---|---|---|
| ✅ | Multi-select (Ctrl/Cmd-click), range select (Shift-click) | Task list |
| ✅ | Batch complete / prioritise / move / delete, undoable | Batch bar |
| ✅ | Right-click context menu with reschedule shortcuts | Task rows, board cards |
| ✅ | Undo and redo (Ctrl+Z / Ctrl+Shift+Z) | Toasts, keyboard |

## Shell

| | Feature | Where |
|---|---|---|
| ✅ | Responsive layout, off-canvas sidebar on phones | Everywhere |
| ✅ | Dark mode, system theme | Settings |
| ✅ | Settings (theme, week start, default priority/reminder) | Sidebar → gear |
| ✅ | Deep links (`#/today?q=p1`), back/forward | Address bar |
| ✅ | Installable PWA, works offline | Manifest + service worker |
| ✅ | Export: JSON, CSV, Markdown, ICS | Sidebar → Export |
| ✅ | Import a JSON backup, with a pre-import safety copy | Sidebar → Import |
| ✅ | Multi-tab sync | Storage adapter change channel |
| ✅ | Undo toasts, completion and view animations | Everywhere |
| ✅ | Keyboard shortcuts with a `?` overlay | `?` |
| ⬜ | Karma / productivity stats | — |
| ⬜ | Accessibility: arrow-key list navigation, screen-reader announcements | — |
| ⬜ | Print stylesheet | — |
| ⬜ | Dark mode for exported images / ICS | — |
| ⬜ | i18n (strings and date formats are US-English) | — |

## Data and storage

| | Feature | Where |
|---|---|---|
| ✅ | Local-first storage behind a swappable adapter | `storage.js` |
| ✅ | Schema versioning with migrations (v1 → v4) | `MIGRATIONS` |
| ✅ | Blobs (files) in IndexedDB | `store.putBlob` |
| ⬜ | State document in IndexedDB (the 5 MB `localStorage` cap remains) | — |
| ⬜ | Closed-tab reminders via the service worker | — |

## Deliberately out of scope (needs a backend)

Accounts and auth, multi-device sync with conflict resolution, shared
projects and assignees, server-side reminder scheduling, Web Push, object
storage for shared attachments, and server-side search. See `later.md`.
