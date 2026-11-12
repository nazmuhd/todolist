/**
 * Notification actions: Complete and Snooze straight from a reminder.
 *
 * The service worker cannot mutate task data directly (the store is local
 * first), so it forwards the action to an open tab through postMessage, or
 * opens the app with `#/action?action=…&task=…` when no tab is running.
 * This module performs the action once the app is loaded.
 */
import { state } from './state.js';
import { toggleComplete, snoozeReminder } from './tasks.js';
import { showToast } from './toasts.js';

/** Snooze presets used by notifications and the context menu. */
export const SNOOZE_PRESETS = [
  { action: 'snooze-10', minutes: 10, label: '10 minutes' },
  { action: 'snooze-60', minutes: 60, label: '1 hour' },
  { action: 'snooze-1440', minutes: 1440, label: 'Tomorrow' },
];

/** Default action attached to a notification's Snooze button. */
export const NOTIFICATION_SNOOZE_ACTION = 'snooze-60';

/** Parses `#/action?action=complete&task=<id>` into an action, or null. */
export function actionFromHash(hash = location.hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  if (!raw.startsWith('action')) return null;
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);
  const action = params.get('action') || '';
  if (!action) return null;
  return { action, taskId: params.get('task') || '' };
}

/**
 * Runs a notification action. Returns whether anything changed, so callers
 * can decide whether to refresh the view.
 */
export function handleNotificationAction(action, taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) {
    showToast('That reminder is for a task that no longer exists', 'error');
    return false;
  }

  if (action === 'complete') {
    toggleComplete(task.id);
    return true;
  }

  const snooze = action === 'snooze'
    ? SNOOZE_PRESETS.find(p => p.action === NOTIFICATION_SNOOZE_ACTION)
    : SNOOZE_PRESETS.find(p => p.action === action);
  if (!snooze) return false;
  snoozeReminder(task, snooze.minutes);
  showToast(`Reminder snoozed for ${snooze.label.toLowerCase()}`, 'info');
  return true;
}

/** Wires service-worker messages and action links into the running app. */
export function initNotificationActions() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type !== 'notification-action') return;
      handleNotificationAction(data.action, data.taskId);
    });
  }

  window.addEventListener('hashchange', () => {
    const action = actionFromHash();
    if (!action) return;
    if (handleNotificationAction(action.action, action.taskId)) {
      // Clear the action hash so a reload cannot replay it. Imported lazily
      // to avoid a module cycle through app.js.
      import('./router.js').then(({ syncHash }) => syncHash());
    }
  });
}
