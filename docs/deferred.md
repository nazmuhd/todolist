# Deferred work

This is a personal, single-user todo app. No further parity work is planned.

The remaining limits are platform-blocked or deliberate: location reminders
only fire while a tab is open, email notifications need an SMTP provider, and
accounts/sharing are out of scope for a single-user app. There are no AI
features. See `gaps.md` for the full list.

Delivered instead:

- Todoist JSON backup import (projects, sections, labels, tasks, notes,
  reminders and completion state).
- Undo/redo history persisted locally, so Ctrl+Z survives a reload.
- Move-to-section from the task context menu, alongside board drag-and-drop.
- A table layout, location reminders, an activity history and automatic
  server backups with restore.
