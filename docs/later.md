# Later — deliberately not in Phase 3

Phase 3 shipped time-of-day due dates (schema v3), recurring tasks, in-page
reminders, and the day-grouped Upcoming view. This file records what was left
out, with the background-worker and database work called out separately.

---

## 1. Background workers / scheduling

In-page reminders run on a `setInterval` plus a check when the tab becomes
visible. The service worker also arms best-effort timers after the tab closes,
but only push makes delivery reliable.

Deferred:

- [~] **Service worker for reminders when the tab is closed** — implemented as a
  best-effort local timer: the page writes the schedule to IndexedDB and the
  service worker re-arms it with `setTimeout` and `showNotification`.
  - Browsers may stop the worker at any time, so delivery is not reliable.
  - Push requires a server and VAPID keys (below).
- [ ] **Web Push notifications** (real background delivery, phone/desktop)
  - Requires backend subscription storage and permission re-request flows.
- [ ] **Notification actions** — Complete / Snooze directly from the notification.
  - Needs a service worker `notificationclick` handler and an IDB write.
- [ ] **Periodic Background Sync** — browser-throttled; not reliable on its own.
- [ ] **Background sync / offline queue** for edits made offline.
- [ ] **Web Worker** for heavy search/indexing if the task list gets large
  (not needed at current scale).
- [~] **Multiple reminders per task** — done; **snooze** is still open.

If closed-tab reminders are wanted *without* a server, the minimum viable path is:
service worker + IndexedDB + a scheduled notification check (best-effort only).
Reliable delivery still needs push + a backend.

---

## 2. Database / backend / sync

The app is still local-first, but writes now sync to a single-user SQLite
backend as well; IndexedDB stays the offline cache.

Deferred:

- [x] **Backend** — Express + SQLite (`node:sqlite`), single-user, no auth.
- [ ] **Authentication** (accounts, login, tokens) — the API is currently open
  and single-user.
- [x] **Real database** — the app state, side documents and attachments persist
  in SQLite instead of only this browser's storage.
- [ ] **Per-entity / multi-device sync** — the first backend syncs the whole
  state document with last-write-wins. Fine-grained sync and conflict
  resolution are still open.
- [ ] **API pagination** for large task sets.
- [x] **File attachments** — stored as BLOBs in SQLite and cached in IndexedDB.
- [x] **Comments** — persisted inside the task state.
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
- [x] #7 Calendar (month grid) view.
- [x] #25 Completed-tasks view (see/restore completed; grouped by day).
- [x] #23 Custom filters and #24 filter query language (`&`, `|`, `!`, dates).
- [x] #26 "No date" / "No priority" filters.

### Task detail
- [ ] #9 File attachments — the storage layer is ready (`store.putBlob`), only the UI is missing.
- [x] #8 Comments / activity log.
- [x] #10 Task duration / estimated time.
- [~] #11 Sections inside projects (sections and grouping exist; drag-to-section and a filter are open).
- [x] #12 Favourite/pinned projects and labels.
- [x] #15 Sub-task nesting deeper than one level.

### Interaction
- [x] #17 Bulk select / batch complete, delete, move.
- [ ] #18 Drag a task onto a project/label in the sidebar.
- [x] #19 Inline title editing.
- [x] #20 Clickable date/project/label pickers in quick add.
- [~] #21 "Move to project" / "Move to label" (moving to a section is still open).
- [x] #22 Right-click reschedule shortcuts and #40 task context menu.

### Shell / polish
- [x] #27 Collapsible sidebar sections.
- [x] #28 Sidebar drag-reorder of projects/labels.
- [x] #29 Inline "add task" per project in the sidebar.
- [x] #30 Settings / preferences (start of week, default priority, etc.).
- [x] #31 Dark mode.
- [ ] #32 Karma / productivity stats.
- [x] #33 Better empty-state illustration and call to action.
- [~] #37 Accessibility pass (dialogs trap focus; arrow-key task-list
  navigation and screen-reader announcements are still open).
- [x] #39 Completion/view animations.
- [x] #42 Full mobile layout pass.
- [x] Basic keyboard shortcuts (`q`, `/`, `t`, `u`, `c`, `b`, `?`).

### Recurrence refinements
- [ ] Exceptions and skips ("every Monday except holidays").
- [x] End conditions in the UI (count / until date) — the RRULE format supports
  them, the picker does not expose them yet.
- [ ] Separate "start date" distinct from due date.
- [~] Multiple reminders (done) and snooze (open).

---

## Suggested order when this is picked up

1. Service worker + IndexedDB, only if closed-tab reminders matter.
2. Local-only wins: custom filters, attachments via IndexedDB, accessibility.
3. Backend + auth + sync + object storage (attachments, comments).
4. Calendar view and collaboration.

Nothing in sections 1–3 is required for the current Phase 3 data to keep working;
schema v3 remains forward-compatible.
