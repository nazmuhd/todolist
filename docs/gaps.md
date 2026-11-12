# Gaps — current backlog

Audit of the code as it stands. `features.md` is the shipped checklist; this
file is the gap ledger. Sections **1–3 are the active backlog**; sections
**4–9 are marked later** and should not be started now.

Legend: `[x]` shipped · `[~]` partly shipped · `[ ]` active gap · `⏳ later`

## Shipped since the previous audit

- [x] Attachments: SQLite BLOBs + IndexedDB cache, add/open/remove in the task dialog.
- [x] Closed-tab reminders: the service worker re-arms from IndexedDB.
- [x] Server-side reminders: a worker checks synced tasks and sends Web Push.
- [x] Push subscriptions, VAPID delivery, dead-endpoint cleanup, test notification.
- [x] Per-entity sync: projects/labels/tasks with per-record revisions, tombstones and retries.
- [x] Paged sync responses (`since` / `limit` / `hasMore`), with the client paging until caught up.
- [x] Task-list pagination: 100 rows plus "Show more".
- [x] Orphan attachment cleanup with a guard period.
- [x] Karma view, print stylesheet, accessibility pass, drag-to-project/label.
- [x] `?` shortcut overlay, deep links, import/export, multi-tab sync.

---

## 1. Task model — active

- [x] **Deadlines** separate from due dates (`deadline` + optional `deadlineTime`).
- [~] **Start dates** — stored and recurrence skips occurrences before it; the
  next occurrence still anchors to the due date, not the start date.
- [x] **Completion-based recurrence** — Todoist's `every!` semantics (next occurrence from completion).
- [x] **Absolute reminders** — "remind me at 09:00 on Thursday", not only offsets.
- [ ] **Location reminders** — arrival/leaving. Web cannot do this without a mobile app; stays open.
- [x] **Rich text** in descriptions/comments — safe local Markdown (bold, italics, code, lists, checklists, links).
- [x] **Reusable templates** for tasks and projects. Stored in `state.templates`; not synced to the server yet.
- [x] **Per-task timezone** — used when a due-time reminder is converted to an instant.
- [x] **Attachment UX** — image thumbnails and drag-and-drop upload.
- [x] **Task permalinks** — `#/task/<id>` opens the task modal.
- [~] **Assignees** — no owner field; awaits auth.

## 2. Views and interaction — active

- [ ] **Board columns by section** — Todoist boards group sections; this board groups priority.
- [ ] **Calendar week/day views**, drag-to-reschedule and drag-to-create.
- [ ] **Time blocking** — durations shown visually in the calendar.
- [ ] **Upcoming parity** — calendar-style Upcoming with drag rescheduling.
- [ ] **Move/drag a task between sections** (the section filter already exists).
- [~] **Per-view sort memory** — sorting is global, not remembered per project/view.
- [ ] **Filter syntax parity** — align with Todoist's operators and add autocomplete/help.
- [ ] **Mobile gestures** — swipe to complete/schedule, long-press parity.
- [~] **Keyboard shortcut coverage** — many exist, not Todoist's full set.

## 3. Notifications — active

- [ ] **Notification actions** — Complete and Snooze straight from the notification.
- [ ] **Snooze presets** on reminders.
- [ ] **Custom reminder offsets** — currently fixed (at due, 10m, 30m, 1h, 2h, 1d).
- [x] **Timezone-correct server scheduling** — the worker converts due times with the task's `timeZone`.
- [ ] **Per-device subscription management** — the single-user store cannot target devices.
- [ ] **Delivery retry and quiet-hours behavior** when push fails or the server is down.
- [ ] **Email notifications** — none.

---

## Later — do not start yet

### 4. Productivity and history ⏳

- Karma levels, goals, weekly/monthly reports (the current view is basic stats).
- Project/task activity log beyond per-task comments.
- Vacation mode and streak handling.
- Persistent undo/action history (undo is session-level).

### 5. Data and interoperability ⏳

- Todoist import (CSV or Todoist backup) and Todoist-format export.
- Two-way Google Calendar / Outlook sync.
- Email-to-task.
- Browser extension / share sheet.
- Todoist-compatible REST API and webhooks.
- Scheduled backups, retention and tombstone pruning.
- Bundled attachment export.
- Encryption at rest.

### 6. Platform and integrations ⏳

- Native iOS/Android/desktop apps, widgets, Apple Watch, Wear OS.
- Siri / Google Assistant / Alexa.
- Gmail/Outlook add-ins.
- Slack/Teams.
- Zapier / Make / IFTTT.

### 7. Collaboration and security ⏳

- Accounts, login, `owner_id`.
- Shared projects, teams, permissions.
- Assignees, mentions, shared comments.
- Multi-device identity (the current server is one shared store).
- 2FA/SSO, audit logs, API keys.

### 8. UX and polish parity ⏳

- Pixel-level visual parity with Todoist (layout, typography, motion).
- Full i18n (English-only by design).
- Complete screen-reader/announcement parity.
- Onboarding, help and empty-state text parity.
- Quick-add NLP breadth (Chrono + RRULE is capable, not identical to Todoist's parser).
- Sounds/haptics.

### 9. Self-hosting and operations ⏳

- Authentication and TLS before exposing the API beyond localhost.
- Rate limiting.
- Metrics/tracing.
- Scheduled migrations/backups beyond boot migrations.
- Non-Windows hosting notes (Node 24 is required for `node:sqlite`).

---

## Suggested order

1. Sections 1–3 in the order above.
2. Re-evaluate section 4+ only when the single-user feature surface feels complete.
3. Section 7 only if multi-user or sharing becomes a goal.
