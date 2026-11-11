# Deferred — work not in the current build

What did **not** ship with the current build. The shipped checklist is
`features.md`; the active gap ledger is `gaps.md` (sections 1–3). This file
keeps the older "later" material, refreshed against the code: anything already
implemented is marked done so it is not picked up again by mistake.

Legend: `[x]` shipped · `[~]` partly shipped · `[ ]` open · `⏳` later

---

## 1. Background workers / scheduling

Reminders now have three layers: an in-page `setInterval` while a tab is open, a
best-effort service-worker timer after the tab closes, and **server-side Web
Push** for reliable delivery.

- [x] **Service worker reminders when the tab is closed** — the page writes the
  schedule to IndexedDB and the service worker re-arms it with `setTimeout` and
  `showNotification`. Best-effort: browsers may stop the worker.
- [x] **Web Push notifications** — VAPID delivery from the server, with push
  subscriptions stored in SQLite. Requires `VAPID_*` keys.
- [x] **Server-side reminder scheduling** — a worker reads the synced tasks and
  sends push notifications every 30 seconds; `reminder_fired` deduplicates.
- [ ] **Notification actions** — Complete / Snooze directly from the notification.
- [~] **Multiple reminders per task** — done; snooze and custom offsets are open.
- [ ] **Periodic Background Sync** — browser-throttled; not reliable on its own.
- [x] **Background sync / offline queue** — edits made offline are queued and
  pushed to `/api/sync` when the connection returns.
- [ ] **Web Worker** for heavy search/indexing if the task list gets very large
  (not needed at current scale).
- [ ] **Timezone-correct scheduling** — the reminder worker uses the server's
  local timezone.

---

## 2. Database / backend / sync

The app is local-first: IndexedDB (documents and blobs) is the offline cache and
writes sync to a single-user SQLite backend.

- [x] **Backend** — Express + SQLite (`node:sqlite`), single-user, no auth.
- [x] **Real database** — state, side documents and attachments persist in SQLite.
- [x] **Per-entity sync** — projects, labels and tasks as individual rows, with
  per-record revisions, a global cursor and tombstones for deletes.
- [x] **Paged sync responses** — `GET /api/sync?since=N&limit=L` returns
  `hasMore`; the client pages until caught up. The local model still holds
  everything.
- [x] **File attachments** — BLOBs in SQLite, cached in IndexedDB.
- [x] **Attachment cleanup** — `POST /api/blobs/cleanup` removes unreferenced
  blobs after a guard period.
- [x] **Comments** — persisted inside the task state.
- [ ] **Authentication** (accounts, login, tokens, `owner_id`) — the API is open
  and single-user.
- [ ] **Multi-device identity** — several devices share one store rather than
  being distinct users.
- [ ] **Sharing / collaboration** (assignees, shared projects).
- [ ] **Scheduled backups and retention** — backups exist, but nothing prunes
  tombstones or rotates snapshots.

---

## 3. Product features still missing

Active or later gaps from `gaps.md`; none block single-user use.

### Task model
- [ ] Deadlines separate from due dates.
- [ ] Start dates.
- [ ] Completion-based recurrence (`every!` semantics).
- [ ] Absolute-time and location reminders.
- [ ] Rich text (Markdown/checklists) in descriptions and comments.
- [ ] Reusable task/project templates (current "templates" are quick-add defaults).
- [ ] Task permalinks (deep-link to a task modal).
- [ ] Attachment previews and drag-and-drop upload.

### Views and interaction
- [x] Board / Kanban view (priority columns; drag between columns).
- [~] Board columns **by section** (Todoist behaviour); it groups by priority.
- [x] Calendar (month grid) view.
- [ ] Calendar week/day views, drag-to-reschedule and drag-to-create.
- [x] Completed-tasks view (grouped by day, restorable).
- [x] Custom filters and the filter query language.
- [x] "No date" / "No priority" views.
- [ ] Drag a task between sections.
- [~] Per-view sort memory (sorting is global).
- [ ] Mobile swipe gestures and long-press parity.

### Task detail and interaction
- [x] File attachments (add / open / remove in the task dialog).
- [x] Comments per task.
- [x] Task duration / estimated time.
- [~] Sections inside projects (sections, grouping and a filter exist;
  drag-to-section is open).
- [x] Pinned projects and labels.
- [x] Sub-task nesting deeper than one level.
- [x] Bulk select and batch complete / delete / move.
- [x] Drag a task onto a project/label in the sidebar.
- [x] Inline title editing.
- [x] Clickable date/project/label pickers in quick add.
- [~] "Move to project" / "Move to label" (moving to a section is open).
- [x] Right-click reschedule shortcuts and the task context menu.

### Shell / polish
- [x] Collapsible sidebar sections.
- [x] Sidebar drag-reorder of projects/labels.
- [x] Inline "add task" per project in the sidebar.
- [x] Settings / preferences.
- [x] Dark mode.
- [x] Karma / productivity stats (basic; goals and reports are later).
- [x] Empty states with a call to action.
- [~] Accessibility (dialogs trap focus; arrow-key navigation and
  screen-reader announcements exist, not full Todoist parity).
- [x] Completion/view animations.
- [x] Full mobile layout pass.
- [x] Basic keyboard shortcuts (`q`, `/`, `t`, `u`, `c`, `b`, `?`).
- [ ] Full i18n (English-only).
- [ ] Pixel-level visual parity with Todoist.

### Recurrence refinements
- [x] End conditions in the UI (count / until date).
- [x] Multiple reminders.
- [ ] Exceptions and skips ("every Monday except holidays").
- [ ] Separate start date distinct from the due date.
- [ ] Snooze presets.

---

## 4–9. Later

These mirror `gaps.md` §4–9 and are not current work.

### 4. Productivity and history ⏳
Karma levels/goals/reports, project activity log, vacation mode, persistent undo
history.

### 5. Data and interoperability ⏳
Todoist import/export, Google Calendar/Outlook sync, email-to-task, browser
extension, Todoist-compatible API/webhooks, scheduled backups and tombstone
pruning, bundled attachment export, encryption at rest.

### 6. Platform and integrations ⏳
Native apps, widgets, watch apps, voice assistants, Gmail/Outlook add-ins,
Slack/Teams, Zapier/Make/IFTTT.

### 7. Collaboration and security ⏳
Accounts and `owner_id`, shared projects and permissions, assignees, mentions,
2FA/SSO, audit logs, API keys.

### 8. UX and polish parity ⏳
Pixel parity, full i18n, full screen-reader parity, onboarding copy,
Todoist-level NLP breadth, sounds/haptics.

### 9. Self-hosting and operations ⏳
Auth and TLS before exposing the API, rate limiting, metrics/tracing, scheduled
migrations/backups, non-Windows hosting notes (Node 24 for `node:sqlite`).

---

## Suggested order when this is picked up

1. Finish `gaps.md` §1–3 (task model, views, notifications).
2. Re-evaluate §4+ only when the single-user surface feels complete.
3. §7 only if multi-user or sharing becomes a goal.
