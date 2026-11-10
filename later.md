# Later — deliberately not in Phase 3

Phase 3 shipped time-of-day due dates (schema v3), recurring tasks, in-page
reminders, and the day-grouped Upcoming view. This file records what was left
out, with the background-worker and database work called out separately.

---

## 1. Background workers / scheduling

Phase 3 reminders only run **while a tab is open** (a `setInterval` + a check
when the tab becomes visible). That is the honest limitation.

Deferred:

- [ ] **Service worker for reminders when the tab is closed**
  - Needs a service worker plus persisted reminder state.
  - A service worker cannot read `localStorage`, so this also requires moving
    task data (or at least a reminder index) to **IndexedDB**.
  - Push requires a server and VAPID keys.
- [ ] **Web Push notifications** (real background delivery, phone/desktop)
  - Requires backend subscription storage and permission re-request flows.
- [ ] **Notification actions** — Complete / Snooze directly from the notification.
  - Needs a service worker `notificationclick` handler and an IDB write.
- [ ] **Periodic Background Sync** — browser-throttled; not reliable on its own.
- [ ] **Background sync / offline queue** for edits made offline.
- [ ] **Web Worker** for heavy search/indexing if the task list gets large
  (not needed at current scale).
- [ ] **Snooze / multiple reminders per task** — Phase 3 has one reminder offset
  per task.

If closed-tab reminders are wanted *without* a server, the minimum viable path is:
service worker + IndexedDB + a scheduled notification check (best-effort only).
Reliable delivery still needs push + a backend.

---

## 2. Database / backend / sync

Everything still lives in this browser's `localStorage` (`todoist-clone-v1`).

Deferred:

- [ ] **Backend + authentication** (accounts, login, tokens).
- [ ] **Real database** (SQLite/Postgres or similar) instead of `localStorage`.
- [ ] **Multi-device sync** with conflict resolution (last-write-wins is not enough
  once tasks/subtasks/labels are edited concurrently).
- [ ] **API layer** and pagination for large task sets.
- [ ] **File attachments** (#9) — needs object storage in a backend, or IndexedDB
  blobs for a local-only version.
- [ ] **Comments / activity log** (#8) — needs persistent per-task history.
- [ ] **Sharing / collaboration** (assignees, shared projects).
- [ ] **Server-side reminder scheduling** (the reliable version of section 1).

A future data migration would take the current v3 task shape:

```text
id, title, description, due, dueTime, recurrence,
reminderMinutes, reminderFiredKey, priority, projectId,
labels, parentId, completed, completedAt, order, createdAt
```

plus projects, labels, and UI state, into relational tables (tasks, projects,
labels, task_labels, reminders, recurrence rules). Keep the existing
`migrateState`/`normalizeState` path as the import boundary.

---

## 3. Features still missing (not worker/DB work)

From `features.md`; none of these were part of Phase 3.

### Views
- [x] #6 Board / Kanban view (priority columns; drag between columns).
- [ ] #7 Calendar (month grid) view.
- [x] #25 Completed-tasks view (see/restore completed; grouped by day).
- [ ] #23 Custom filters and #24 filter query language (`&`, `|`, `!`, dates).
- [x] #26 "No date" / "No priority" filters.

### Task detail
- [ ] #9 File attachments (also listed above).
- [ ] #8 Comments / activity log.
- [x] #10 Task duration / estimated time.
- [ ] #11 Sections inside projects.
- [x] #12 Favourite/pinned projects and labels.
- [ ] #15 Sub-task nesting deeper than one level.

### Interaction
- [ ] #17 Bulk select / batch complete, delete, move.
- [ ] #18 Drag a task onto a project/label in the sidebar.
- [x] #19 Inline title editing.
- [ ] #20 Clickable date/project/label pickers in quick add (Phase 3 chips are
  still preview-only).
- [ ] #21 "Move to project" / "Move to section".
- [ ] #22 Right-click reschedule shortcuts and #40 task context menu.

### Shell / polish
- [x] #27 Collapsible sidebar sections.
- [ ] #28 Sidebar drag-reorder of projects/labels.
- [x] #29 Inline "add task" per project in the sidebar.
- [ ] #30 Settings / preferences (start of week, default priority, etc.).
- [ ] #31 Dark mode.
- [ ] #32 Karma / productivity stats.
- [x] #33 Better empty-state illustration and call to action.
- [ ] #37 Accessibility pass (focus trapping in dialogs, keyboard task-list
  navigation, screen-reader announcements).
- [x] #39 Completion/view animations.
- [ ] #42 Full mobile layout pass.
- [x] Basic keyboard shortcuts (`q`, `/`, `t`, `u`, `c`, `b`, `?`).

### Recurrence refinements
- [ ] Exceptions and skips ("every Monday except holidays").
- [ ] End conditions in the UI (count / until date) — the RRULE format supports
  them, the picker does not expose them yet.
- [ ] Separate "start date" distinct from due date.
- [ ] Multiple reminders and snooze.

---

## Suggested order when this is picked up

1. Service worker + IndexedDB, only if closed-tab reminders matter.
2. Local-only wins: custom filters, attachments via IndexedDB, accessibility.
3. Backend + auth + sync + object storage (attachments, comments).
4. Calendar view and collaboration.

Nothing in sections 1–3 is required for the current Phase 3 data to keep working;
schema v3 remains forward-compatible.
