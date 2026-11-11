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
      view groups tasks under them and the task dialog can pick one; a
      "move to section" drag and a section filter are still open.

## 2. Task detail

- [x] **Sub-task nesting deeper than one level**.
- [ ] **Attachments** — needs IndexedDB blobs plus a file picker.
- [x] **Comments / activity log** — per-task comments in the task dialog.
- [x] **Recurrence UI gaps** — a repeat can now end after N times or on a date
      (COUNT / UNTIL). Still missing: exceptions ("skip this occurrence"),
      a separate start date, snooze.
- [x] **Multiple reminders** — the due-date dialog takes a list of reminders.
- [ ] **Timezone support** — every date/time is the browser's local zone.

## 3. Interaction

- [x] **Bulk select / batch actions** — Ctrl/Cmd-click selects, Shift-click
      selects a range, and the batch bar completes, reprioritises, moves or
      deletes the selection (undoable as a whole).
- [x] **Right-click context menu and reschedule shortcuts** — complete,
      Today/Tomorrow/Next week/No date, Priority 1–4, Move to project, edit,
      delete; works on list rows and board cards.
- [ ] **Drag a task onto a project or label in the sidebar**.
- [x] **Clickable chips in quick add** — date, repeat, priority, project and
      label chips open inline pickers.
- [~] **"Move to project / label" action** — available from the context menu
      and the batch bar; "move to label" was added to the context menu, but
      there is still no drag between labels.
- [x] **Sidebar drag-reorder** of projects and labels.
- [x] **Undo for edits, plus redo** (Ctrl/Cmd+Shift+Z).

## 4. Shell, settings, polish

- [x] **Dark mode** and a **settings panel** (theme, first day of the week,
      default priority, default reminder).
- [ ] **Karma / productivity stats** — completions per day, streaks, charts.
- [x] **Deep-linkable URLs** — `#/today?q=p1`; views are shareable and the
      browser back button works.
- [x] **PWA / offline** — manifest, icon and a service worker; the libraries
      are vendored locally, so one visit is enough to work offline.
- [~] **Accessibility pass** — native dialogs trap focus, keyboard shortcuts
      exist, task rows are selectable by keyboard. Still missing: arrow-key
      navigation of the task list, screen-reader announcements on complete.
- [x] **Export formats** — JSON, CSV, Markdown and ICS.
- [x] **Print stylesheet** — the sidebar, header, quick-add and row actions
      are hidden on paper; the task list prints cleanly.
- [ ] **i18n** — all strings and date formats are hardcoded US-English.
- [~] **Storage hardening** — everything goes through the storage adapter and
      blobs already live in IndexedDB, but the **state document** is still in
      `localStorage` (~5 MB cap). Moving it is now a small change inside
      `LocalStore` only, because the interface is already asynchronous.
- [ ] **Closed-tab reminders** — the service worker is in place but does not
      schedule notifications yet.

## 5. Small polish

- [x] Search results highlight the matching text.
- [x] `?` opens a keyboard-shortcut overlay.
- [x] Mobile task rows keep their actions visible; the board shows a
      "Scroll for more" hint while columns are off-screen.
- [x] The Today view lists overdue work in its own group.
- [ ] "This occurrence" vs "entire series" editing for repeating tasks.
- [x] Priority levels carry a **shape** as well as a colour (square, dot,
      ring) so they are readable without colour vision.
- [x] Empty states are per view, each with its own copy and artwork.
- [ ] No skeleton/loading states.

---

## Docs drift to fix

`features.md` and `later.md` are out of date. These items are **already
implemented** but still listed as missing:

- Time-of-day due dates, recurring tasks, reminders, overdue bucket,
  day-grouped Upcoming view, board (Kanban) view.
- Project/label edit + delete, project colour picker, pinned projects/labels.
- Undo + toasts, JSON import/export, completed-tasks view, multi-tab sync.
- Inline title editing, collapsible sidebar sections, inline "add task" per
  project in the sidebar, better empty state, completion/view animations.
- **Full mobile layout pass** — done in `5991c05` (off-canvas sidebar drawer,
      fluid header/quick-add, viewport-capped dialogs, touch-friendly rows).

## Suggested order

1. Attachments + IndexedDB (also lifts the storage ceiling).
2. Karma / productivity stats.
3. Accessibility pass (arrow-key list navigation, screen-reader announcements).
4. i18n and a print stylesheet.
5. Drag a task onto a sidebar project, and "move to label".

None of these require a backend; the current `localStorage` schema (v4) stays
valid for all of them.

