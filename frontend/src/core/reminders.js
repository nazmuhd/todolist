/**
 * Reminders.
 *
 * The app schedules reminders while a tab is open; the service worker is a
 * best-effort fallback when it is not. `core/state.js` writes the schedule
 * the worker reads, and this module fires the notifications and in-page
 * toasts.
 */
import { state, persistState } from './state.js';
import { taskReminders } from './tasks.js';
import { formatDue, reminderAt } from './dates.js';
import { showToast } from './toasts.js';
import { services } from './services.js';

/** Identifies the due date + reminder schedule a task was last fired for. */
export function reminderKey(t) {
  if (!t) return '';
  const parts = taskReminders(t)
    .map(r => (r.at ? `at:${r.at}` : `m:${r.minutes}`))
    .sort()
    .join(',');
  if (!parts) return '';
  return `${t.due || ''}|${t.dueTime || ''}|${t.timeZone || ''}|${parts}`;
}

export function ensureNotificationPermission() {
  if (!('Notification' in window)) return;
  if (window.Notification.permission !== 'default') return;
  try {
    const p = window.Notification.requestPermission();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {}
}

function notifyTask(t) {
  const dueLabel = formatDue(t.due, t.dueTime);
  const body = `${t.title}${dueLabel ? ' · ' + dueLabel : ''}`;
  if ('Notification' in window && window.Notification.permission === 'granted') {
    try {
      const n = new window.Notification('Task reminder', { body, tag: 'todoist-clone-' + t.id });
      n.onclick = () => { window.focus(); services.openTaskModal(t.id); n.close(); };
      return;
    } catch {}
  }
  // No Notification support/permission: an in-page toast still helps.
  showToast(`Reminder: ${t.title}`, 'info', {
    actionLabel: 'View',
    onAction: () => services.openTaskModal(t.id),
    duration: 10000,
  });
}

/**
 * Fires reminders that have come due while the tab has been open.
 * Anything missed by more than 12 hours is skipped rather than spammed.
 */
export function checkReminders(now = Date.now()) {
  state.tasks.forEach(t => {
    if (t.completed) return;
    const reminders = taskReminders(t);
    if (!reminders.length) return;
    const key = reminderKey(t);
    if (!key || t.reminderFiredKey === key) return;
    // Fire the earliest reminder that is due.
    const due = reminders
      .map(r => ({ r, at: reminderAt(t, r) }))
      .filter(x => x.at)
      .sort((a, b) => a.at - b.at);
    const hit = due.find(x => now >= x.at.getTime());
    if (!hit) return;
    if (now - hit.at.getTime() > 12 * 60 * 60 * 1000) return;
    t.reminderFiredKey = key;
    persistState();
    notifyTask(t);
  });
}

let reminderTimer = null;

export function startReminders() {
  if (reminderTimer) return;
  checkReminders();
  reminderTimer = setInterval(() => checkReminders(), 30000);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkReminders();
});
