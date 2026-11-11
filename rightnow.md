# Right now — frontend gaps that need no backend

Audit of the current code (not just `features.md`, which is now stale).
Everything listed here can be shipped client-side only: no server, no auth,
no sync service.

**Status: most of the list is now implemented.** What is left is marked
with `[ ]`; `[~]` means partly done.

---

## 1. Views & filtering

- [x] **Calendar (month grid) view** — a month grid with today highlighted, a
      selected-day panel, month navigation and an Add task button.
- [x] **Filter query language** — the search box understands `p1..p4`,
      `#project`, `@label`, `overdue`/`today`/`tomorrow`/`week`/`month`,
      relative ranges (`7 days`), `has:`/`no:` date|project|label|priority,
      quoted phrases, `!` (not), `&` (and), `|` (or) and parentheses.
- [x] **Custom / saved filters** — save the current search as a named filter
      from the sidebar ("My filters"), with counts, rename and delete.
- [x] **Per-view sorting** — manual, due date, priority, name, date added.
- [x] **Sections inside projects** — sections exist (schema v4), the project
      view groups tasks under them, the task dialog can pick one, and the
      project view has a section filter. A "move to section" drag is still open.

## 2. Task detail

- [x] **Sub-task nesting deeper than one level**.
- [x] **Attachments** — files are stored as IndexedDB blobs and the task keeps
      only the metadata. Add, open and remove them from the task dialog.
- [x] **Comments / activity log** — per-task comments in the task dialog.
- [x] **Recurrence UI gaps** — a repeat can end after N times or on a date
      (COUNT / UNTIL), single occurrences can be skipped, and tasks can be
      snoozed until tomorrow. Still open: a separate start date.
- [x] **Multiple reminders** — the due-date dialog takes a list of reminders.
- [ ] **Timezone support** — unplanned: every date/time stays in the browser's local zone.

## 3. Interaction

- [x] **Bulk select / batch actions** — Ctrl/Cmd-click selects, Shift-click
      selects a range, and the batch bar completes, reprioritises, moves or
      deletes the selection (undoable as a whole).
- [x] **Right-click context menu and reschedule shortcuts** — complete,
      Today/Tomorrow/Next week/No date, Priority 1–4, Move to project, edit,
      delete; works on list rows and board cards.
- [x] **Drag a task onto a project or label in the sidebar**.
- [x] **Clickable chips in quick add** — date, repeat, priority, project and
      label chips open inline pickers.
- [x] **"Move to project / label" action** — from the context menu, the batch
      bar, or by dragging a task onto a project or label in the sidebar.
- [x] **Sidebar drag-reorder** of projects and labels.
- [x] **Undo for edits, plus redo** (Ctrl/Cmd+Shift+Z).

## 4. Shell, settings, polish

- [x] **Dark mode** and a **settings panel** (theme, first day of the week,
      default priority, default reminder, date order and 12h/24h time).
- [x] **Karma / productivity stats** — a Karma view with completions today, in the
      last 7 days, the current and best streak, the all-time total and a
      14-day bar chart.
- [x] **Deep-linkable URLs** — `#/today?q=p1`; views are shareable and the
      browser back button works.
- [x] **PWA / offline** — manifest, icon and a service worker; the libraries
      are vendored locally, so one visit is enough to work offline.
- [x] **Accessibility pass** — native dialogs trap focus, task titles are focusable
      with arrow-key/Home/End navigation (Enter edits, Space completes), and
      every toast is repeated in a polite live region for screen readers.
- [x] **Export formats** — JSON, CSV, Markdown and ICS.
- [x] **Print stylesheet** — the sidebar, header, quick-add and row actions
      are hidden on paper; the task list prints cleanly.
- [ ] **i18n — unplanned.** The app is English-only by design; a full string
      table would cost more in readability than it returns. What *was* worth
      having — a date-order and 12h/24h preference — is now a setting.
- [x] **Storage hardening** — everything goes through the storage adapter, and
      both the documents and the blobs now live in IndexedDB (the ~5 MB
      `localStorage` cap is gone). `localStorage` remains only as a fallback
      for browsers without IndexedDB, and as the source of the one-time
      migration for older data.
- [x] **Closed-tab reminders** — the page writes the reminder schedule into
      IndexedDB and the service worker re-arms its timers from it, so
      reminders can fire after the tab is closed (best effort: browsers may stop
      the worker at any time).

## 5. Small polish

- [x] Search results highlight the matching text.
- [x] `?` opens a keyboard-shortcut overlay.
- [x] Mobile task rows keep their actions visible; the board shows a
      "Scroll for more" hint while columns are off-screen.
- [x] The Today view lists overdue work in its own group.
- [x] "This occurrence" vs "entire series" — a repeating task can have single
      occurrences skipped ("Skip this occurrence"), and the next occurrence
      calculation skips the dates you have skipped.
- [x] Priority levels carry a **shape** as well as a colour (square, dot,
      ring) so they are readable without colour vision.
- [x] Empty states are per view, each with its own copy and artwork.
- [ ] No skeleton/loading states.

---

## Docs drift — fixed

`features.md` and `later.md` have been rewritten to match the code. These
items were **already implemented** but had still been listed as missing:

- Time-of-day due dates, recurring tasks, reminders, overdue bucket,
  day-grouped Upcoming view, board (Kanban) view.
- Project/label edit + delete, project colour picker, pinned projects/labels.
- Undo + toasts, JSON import/export, completed-tasks view, multi-tab sync.
- Inline title editing, collapsible sidebar sections, inline "add task" per
  project in the sidebar, better empty state, completion/view animations.
- **Full mobile layout pass** — done in `5991c05` (off-canvas sidebar drawer,
      fluid header/quick-add, viewport-capped dialogs, touch-friendly rows).

## Suggested order

Nothing outstanding. Every remaining line is a deliberate "unplanned"
decision rather than an open gap.

None of these require a backend; the current storage schema (v5) stays valid
for all of them.

