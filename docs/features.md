# Features

Status of this personal todo app. **Refreshed against the code.** Known
platform limits and intentionally out-of-scope work are listed in `gaps.md`.

Legend: ✅ shipped · ◐ partly shipped · ⬜ still open

## Task management

| | Feature | Where |
|---|---|---|
| ✅ | Tasks with title, description, project, labels, priority | Task modal, quick add |
| ✅ | Due date **and** time of day, all-day vs timed | Due-date dialog |
| ✅ | Repeat rules ("every Monday", "every 2 weeks", …) | RRULE, due-date dialog |
| ✅ | Repeat **end conditions** (after N times / on a date) | Due-date dialog (`COUNT` / `UNTIL`) |
| ✅ | Multiple reminders per task, with preset and custom offsets | Due-date dialog |
| ✅ | Notification **Complete** and **Snooze** actions (10m / 1h / tomorrow) | System notifications |
| ✅ | In-page + system notifications while the tab is open | Reminder scheduler |
| ✅ | Server-side Web Push reminders with every tab closed | Reminder worker + service worker |
| ✅ | Per-device push management (labelled, last seen, removable) | Settings |
| ✅ | Push retry with backoff and server quiet hours | Reminder worker |
| ✅ | Estimated duration (task duration) | Task modal |
| ✅ | Sub-tasks, nested more than one level | Task rows |
| ✅ | Inline title editing | Click a title |
| ✅ | Attachments stored in SQLite + IndexedDB | Task modal, `/api/blobs` |
| ✅ | Comments per task | Task modal |
| ✅ | Sections inside projects | Project dialog, project view |
| ✅ | Quick-add defaults | Quick add |
| ✅ | Deadlines separate from due dates (date + optional time) | Due-date dialog, task rows |
| ✅ | Start dates — recurrence skips occurrences before the start date | Due-date dialog |
| ✅ | Completion-based recurrence ("every!" counts from completion) | Quick add, due-date dialog |
| ✅ | Absolute-time reminders | Due-date dialog |
| ✅ | Rich text (safe Markdown subset, checklists) in descriptions and comments | Task modal |
| ✅ | Reusable task/project templates (saved locally in the browser) | Sidebar → Templates |
| ✅ | Per-task timezone for due-time reminders | Due-date dialog |
| ✅ | Attachment thumbnails and drag-and-drop upload | Task modal |
| ✅ | Task permalinks (`#/task/<id>`) | Task modal → Link |

## Lists and views

| | Feature | Where |
|---|---|---|
| ✅ | Inbox, Today, Upcoming, Completed, No date, No priority | Sidebar |
| ✅ | Today separates **overdue** work | Today view |
| ✅ | Upcoming grouped by day, with an Overdue group | Upcoming view |
| ✅ | Completed tasks view, grouped by completion day, restorable | Completed view |
| ✅ | Board (Kanban) view, drag between **priority** columns | Header toggle |
| ✅ | Board columns by project section (incl. "No section"), drag between sections | Header toggle |
| ✅ | Calendar month, week and day views with a time grid | Sidebar → Calendar |
| ✅ | Drag a task in the calendar to reschedule; drag empty time to create | Calendar |
| ✅ | Duration-sized time blocks in week/day views | Calendar |
| ✅ | Drag an Upcoming/Today task onto a day header to reschedule | Upcoming, Today |
| ✅ | Filter query language (`p1`, `#project`, `overdue`, `7 days`, `due:`, `created:`, `has:`, `no:`, `!`, `&`, `|`) | Search box |
| ✅ | Custom / saved filters | Sidebar → My filters |
| ✅ | Sorting (manual, date, priority, name, added), remembered per view | Header menu |
| ✅ | Section filter in a project; drag a task between section columns | Project view |
| ✅ | Swipe right to complete, swipe left to open the due editor on touch | Task rows |
| ✅ | List and Completed views page at 100 rows with "Show more" | Task list |

## Organisation

| | Feature | Where |
|---|---|---|
| ✅ | Projects with colour, pin, edit, delete, drag-reorder | Sidebar |
| ✅ | Labels with colour, pin, edit, delete, drag-reorder | Sidebar |
| ✅ | Move a task to a project or label | Context menu, batch bar |
| ✅ | Move a task to a section | Context menu, board drag |
| ✅ | Drag a task onto a sidebar project or label | Sidebar |

## Working with tasks in bulk

| | Feature | Where |
|---|---|---|
| ✅ | Multi-select (Ctrl/Cmd-click), range select (Shift-click) | Task list |
| ✅ | Batch complete / prioritise / move / delete, undoable | Batch bar |
| ✅ | Right-click context menu with reschedule shortcuts | Task rows, board cards |
| ✅ | Undo and redo (Ctrl+Z / Ctrl+Shift+Z), kept across reloads | Toasts, keyboard |

## Shell

| | Feature | Where |
|---|---|---|
| ✅ | Responsive layout, off-canvas sidebar on phones | Everywhere |
| ✅ | Dark mode, system theme | Settings |
| ✅ | Settings (theme, week start, default priority/reminder, date/time format) | Sidebar → gear |
| ✅ | Deep links (`#/today?q=p1`), back/forward | Address bar |
| ✅ | Installable PWA, works offline | Manifest + service worker |
| ✅ | Export: JSON, CSV, Markdown, ICS | Sidebar → Export |
| ✅ | Import this app's JSON backup, with a pre-import safety copy | Sidebar → Import |
| ✅ | Import a **Todoist JSON backup** (projects, sections, labels, tasks, notes, reminders) | Sidebar → Import |
| ✅ | Multi-tab sync | Storage adapter change channel |
| ✅ | Undo toasts, completion and view animations | Everywhere |
| ✅ | Keyboard shortcuts with a `?` overlay | `?` |
| ✅ | Karma / productivity stats | Karma view |
| ✅ | Accessibility: arrow-key list navigation, screen-reader announcements | Task list, toasts |
| ✅ | Print stylesheet | Everywhere |

## Data and storage

| | Feature | Where |
|---|---|---|
| ✅ | Local-first storage behind a swappable adapter | `storage.js` |
| ✅ | Schema versioning with migrations (v1 → v8) | `MIGRATIONS` |
| ✅ | Documents and blobs in IndexedDB (no 5 MB localStorage cap) | `storage.js` |
| ✅ | Single-user SQLite backend (`node:sqlite`) | `server/` |
| ✅ | Per-entity sync with per-record revisions and tombstones | `/api/sync`, `core/sync.js` |
| ✅ | Sync resumes automatically when the network returns | `core/sync.js` |
| ✅ | Paged sync responses (`since` / `limit` / `hasMore`) | `/api/sync` |
| ✅ | Server-side reminders and Web Push subscriptions | `services/reminders.ts`, `/api/push` |
| ✅ | Orphan attachment cleanup after a guard period | `POST /api/blobs/cleanup` |
| ✅ | Closed-tab reminders in the service worker | `sw.js` |
| ✅ | Local-only undo history document (survives reloads) | `core/undo.js` |
