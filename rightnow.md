# Right now — frontend gaps that need no backend

Audit of the current code (not just `features.md`, which is now stale).
Everything listed here can be shipped client-side only: no server, no auth,
no sync service.

---

## 1. Views & filtering

- [ ] **Calendar (month grid) view** — only a date-picker exists; there is no
      month overview showing which tasks land on which day.
- [ ] **Filter query language** — search is a plain substring match. No
      `&`, `|`, `!`, `overdue`, `p1`, `@work`, `7 days` syntax.
- [ ] **Custom / saved filters** — only the five built-in smart lists exist
      (Inbox, Today, Upcoming, Completed, No date, No priority).
- [ ] **Per-view filters and sorting** — no "only P1" filter, no sort by
      date / name / priority. Order is manual (drag) only.
- [ ] **Sections inside projects** — a project is a flat list of tasks, so
      "To Do / In Progress" grouping is not possible.

## 2. Task detail

- [ ] **Sub-task nesting deeper than one level** — `renderTaskRow()` renders
      children only when `!isSub`, so depth is capped at a single level.
- [ ] **Attachments** — can be local-only via IndexedDB blobs; no server needed.
- [ ] **Comments / activity log** — needs a per-task history array, stored locally.
- [ ] **Recurrence UI gaps** — the RRULE format supports `COUNT` / `UNTIL` but the
      picker does not expose them; no exceptions ("skip this occurrence"), no
      separate start date, one reminder offset only (no snooze, no multiple reminders).
- [ ] **Timezone support** — every date/time is the browser's local zone;
      no timezone picker, no travel-time awareness.

## 3. Interaction

- [ ] **Bulk select / batch actions** — no multi-select, shift-click, select all,
      or batch complete / delete / move.
- [x] **Right-click context menu and reschedule shortcuts** — right-clicking a task
      (list row or board card) opens a menu with Complete/Reopen, Today/Tomorrow/
      Next week/No date, Priority 1–4, Move to project, Edit and Delete.
- [ ] **Drag a task onto a project or label in the sidebar** — SortableJS groups
      exist only inside the task list and the board.
- [x] **Clickable chips in quick add** — the preview chips (`Tomorrow`, `P1`, `#Work`,
      `@label`) open inline pickers for date/time, repeat, priority, project and
      labels; unset values show muted "Add date / project / label" chips.
- [~] **"Move to project / label" action** — "Move to project" is available from the
      task context menu; "Move to section" still needs sections to exist.
- [ ] **Sidebar drag-reorder** of projects and labels.
- [ ] **Undo for edits, plus redo** — undo currently covers destructive actions only.

## 4. Shell, settings, polish

- [ ] **Dark mode** and a **settings panel** (theme, start of week, default
      priority, default reminder, sort preferences).
- [ ] **Karma / productivity stats** — completions per day, streaks, charts.
- [ ] **Deep-linkable URLs** — the current view lives in `localStorage`; there is no
      `#view=…`, no browser back/forward handling, and no shareable links.
- [ ] **PWA** — no `manifest.json`, no icons, no service worker, so the app cannot
      be installed and does not work offline.
- [ ] **Accessibility pass** — keyboard navigation of the task list, focus
      management for the custom popovers, screen-reader announcements on
      complete / undo, `aria-label`s on the row icon buttons.
- [ ] **Export formats** — ICS / Markdown / CSV, plus a print stylesheet.
- [ ] **i18n** — all strings and date formats are hardcoded US-English.
- [ ] **Storage hardening** — everything lives in `localStorage` (~5 MB cap,
      synchronous writes); IndexedDB would remove that ceiling.
- [ ] **Closed-tab reminders** — achievable *without* a server via a service worker
      plus Notification Triggers (best-effort only).

## 5. Small polish

- [x] Search results highlight the matching text.
- [x] `?` opens a keyboard-shortcut overlay (replaces the old toast).
- [x] Mobile task rows keep their actions visible; the board shows a
      "Scroll for more" hint while columns are off-screen.
- [x] The Today view lists overdue work in its own group.
- [ ] No "this occurrence" vs "entire series" editing for repeating tasks.
- [ ] Priority colours are not colour-blind safe; overdue / due-soon states rely
      partly on colour alone.
- [ ] Empty states are generic — no per-view illustration or copy.
- [ ] No skeleton/loading states (local only, but the UI can still feel instant-empty).

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

1. Custom filters + query language (biggest everyday win, ~1 sitting).
2. Calendar (month grid) view (the other big missing Todoist surface).
3. Accessibility pass + shortcut help overlay (cheap, high value).
4. Dark mode + settings panel.
5. Bulk select / batch actions, then the right-click context menu.
6. Storage hardening (IndexedDB) before attachments arrive.

None of these require a backend; the current `localStorage` schema (v3) stays
valid for all of them.
