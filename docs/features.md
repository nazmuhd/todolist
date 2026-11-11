# Features

Status of the Todoist-parity checklist for this clone. **Refreshed against the
code.** The remaining gaps are tracked in `gaps.md`; sections 1–3 there are
the active work, sections 4–9 are deliberately deferred.

Legend: ✅ shipped · ◐ partly shipped · ⬜ still open · ⏳ later

## Task management

| | Feature | Where |
|---|---|---|
| ✅ | Tasks with title, description, project, labels, priority | Task modal, quick add |
| ✅ | Due date **and** time of day, all-day vs timed | Due-date dialog |
| ✅ | Repeat rules ("every Monday", "every 2 weeks", …) | RRULE, due-date dialog |
| ✅ | Repeat **end conditions** (after N times / on a date) | Due-date dialog (`COUNT` / `UNTIL`) |
| ✅ | Multiple reminders per task | Due-date dialog |
| ✅ | In-page + system notifications while the tab is open | Reminder scheduler |
| ✅ | Server-side Web Push reminders with every tab closed | Reminder worker + service worker |
| ✅ | Estimated duration (task duration) | Task modal |
| ✅ | Sub-tasks, nested more than one level | Task rows |
| ✅ | Inline title editing | Click a title |
| ✅ | Attachments stored in SQLite + IndexedDB | Task modal, `/api/blobs` |
| ✅ | Comments per task | Task modal |
| ✅ | Sections inside projects | Project dialog, project view |
| ✅ | Quick-add defaults | Quick add |
| ⬜ | Deadlines separate from due dates | — |
| ⬜ | Start dates | — |
| ⬜ | Completion-based recurrence ("every!") | — |
| ⬜ | Absolute-time and location reminders | — |
| ⬜ | Reusable task/project templates | — |
| ⏳ | Assignees | — |

## Lists and views

| | Feature | Where |
|---|---|---|
| ✅ | Inbox, Today, Upcoming, Completed, No date, No priority | Sidebar |
| ✅ | Today separates **overdue** work | Today view |
| ✅ | Upcoming grouped by day, with an Overdue group | Upcoming view |
| ✅ | Completed tasks view, grouped by completion day, restorable | Completed view |
| ✅ | Board (Kanban) view, drag between **priority** columns | Header toggle |
| ◐ | Board columns by project section (Todoist behaviour) | Board uses priority columns |
| ◐ | Calendar month view; no week/day view or drag rescheduling | Sidebar |
| ✅ | Filter query language (`p1`, `#project`, `overdue`, `7 days`, `!`, `&`, `|`) | Search box |
| ✅ | Custom / saved filters | Sidebar → My filters |
| ✅ | Sorting (manual, date, priority, name, added) | Header menu |
| ◐ | Section filter in a project; drag-to-section still open | Project view |
| ✅ | List and Completed views page at 100 rows with "Show more" | Task list |

## Organisation

| | Feature | Where |
|---|---|---|
| ✅ | Projects with colour, pin, edit, delete, drag-reorder | Sidebar |
| ✅ | Labels with colour, pin, edit, delete, drag-reorder | Sidebar |
| ✅ | Move a task to a project or label | Context menu, batch bar |
| ✅ | Drag a task onto a sidebar project or label | Sidebar |

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
| ✅ | Settings (theme, week start, default priority/reminder, date/time format) | Sidebar → gear |
| ✅ | Deep links (`#/today?q=p1`), back/forward | Address bar |
| ✅ | Installable PWA, works offline | Manifest + service worker |
| ✅ | Export: JSON, CSV, Markdown, ICS | Sidebar → Export |
| ✅ | Import a JSON backup, with a pre-import safety copy | Sidebar → Import |
| ✅ | Multi-tab sync | Storage adapter change channel |
| ✅ | Undo toasts, completion and view animations | Everywhere |
| ✅ | Keyboard shortcuts with a `?` overlay | `?` |
| ✅ | Karma / productivity stats | Karma view |
| ✅ | Accessibility: arrow-key list navigation, screen-reader announcements | Task list, toasts |
| ✅ | Print stylesheet | Everywhere |
| ⏳ | i18n (English-only by design) | — |
| ⏳ | Native mobile/desktop apps, widgets, watch apps | — |

## Data and storage

| | Feature | Where |
|---|---|---|
| ✅ | Local-first storage behind a swappable adapter | `storage.js` |
| ✅ | Schema versioning with migrations (v1 → v7) | `MIGRATIONS` |
| ✅ | Documents and blobs in IndexedDB (no 5 MB localStorage cap) | `storage.js` |
| ✅ | Single-user SQLite backend (`node:sqlite`) | `server/` |
| ✅ | Per-entity sync with per-record revisions and tombstones | `/api/sync`, `core/sync.js` |
| ✅ | Paged sync responses (`since` / `limit` / `hasMore`) | `/api/sync` |
| ✅ | Server-side reminders and Web Push subscriptions | `services/reminders.ts`, `/api/push` |
| ✅ | Orphan attachment cleanup after a guard period | `POST /api/blobs/cleanup` |
| ✅ | Closed-tab reminders in the service worker | `sw.js` |
| ⬜ | Todoist import (CSV or Todoist backup) and Todoist-format export | — |
| ⏳ | Automated backups, retention, encryption at rest | — |

## Deliberately deferred

Tracked with detail in `gaps.md` §4–9:

- Productivity goals/reports, activity history, vacation mode
- Todoist import, calendar/email integrations, Todoist-compatible API
- Native apps, widgets, browser extensions, Slack/Zapier/IFTTT
- Accounts, sharing, assignees, permissions, 2FA/SSO
- Visual parity, full i18n, onboarding polish
- Auth, TLS, rate limiting, metrics, scheduled backups
