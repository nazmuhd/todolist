/**
 * Activity history: a log of what happened to your tasks.
 *
 * Every change is recorded as an event (created, completed, moved, edited,
 * deleted, and so on). The log lives in its own local-only document, so it
 * never slows the state down and never syncs: it is a record of what this
 * browser did, not shared data.
 *
 * The log is unbounded by design, but it is trimmed to a sane maximum so a
 * very long history cannot fill the disk.
 */
import { store } from './store.js';
import { state } from './state.js';
import { requestRender } from './render.js';

const HISTORY_KEY = 'activity-history';

/** The most events kept. Old ones are dropped, newest first are kept. */
export const MAX_EVENTS = 5000;

let events = [];
let loaded = false;
let saving = false;

/** The event kinds the app records. */
export const EVENT_KINDS = {
  created: { label: 'Created', icon: 'plus' },
  completed: { label: 'Completed', icon: 'circle-check' },
  reopened: { label: 'Reopened', icon: 'circle' },
  edited: { label: 'Edited', icon: 'pencil' },
  moved: { label: 'Moved', icon: 'folder-symlink' },
  rescheduled: { label: 'Rescheduled', icon: 'calendar-clock' },
  deleted: { label: 'Deleted', icon: 'trash-2' },
  commented: { label: 'Commented', icon: 'message-square' },
  recurring: { label: 'Rolled forward', icon: 'repeat' },
  skipped: { label: 'Skipped occurrence', icon: 'skip-forward' },
};

/** Reads the stored log. Safe to call more than once. */
export async function loadActivity() {
  if (loaded) return events;
  loaded = true;
  try {
    const doc = await store.getLocalDoc(HISTORY_KEY);
    events = Array.isArray(doc) ? doc.filter(e => e && typeof e === 'object' && typeof e.at === 'number') : [];
  } catch {
    events = [];
  }
  return events;
}

/** The events, newest first. */
export function activityEvents() {
  return [...events].sort((a, b) => b.at - a.at);
}

/** The events for one task, newest first. */
export function activityForTask(taskId) {
  return activityEvents().filter(e => e.taskId === taskId);
}

/**
 * Records one event.
 *
 * `task` is the task it happened to (may be gone already), `detail` is a
 * short sentence describing it.
 */
export function recordActivity(kind, task, detail = '') {
  if (!kind) return;
  const event = {
    id: `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    kind,
    taskId: task && task.id ? task.id : null,
    title: task && task.title ? String(task.title).slice(0, 200) : '',
    detail: String(detail || '').slice(0, 300),
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  persistActivity();
  return event;
}

function persistActivity() {
  if (saving) return;
  saving = true;
  // Writes are batched: a burst of changes (completing a task with
  // subtasks, for example) does not write once per event.
  setTimeout(() => {
    saving = false;
    store.setLocalDoc(HISTORY_KEY, events).catch(() => {});
  }, 250);
}

/** Empties the log. */
export async function clearActivity() {
  events = [];
  loaded = true;
  await store.setLocalDoc(HISTORY_KEY, events).catch(() => {});
  requestRender();
}

/**
 * The activity for one day, for the summary card.
 */
export function activitySummary(days = 14) {
  const byDay = new Map();
  activityEvents().forEach(e => {
    const d = new Date(e.at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    byDay.set(key, (byDay.get(key) || 0) + 1);
  });
  return byDay;
}

/** True when the task no longer exists, so the row can be marked. */
export function taskStillExists(taskId) {
  if (!taskId) return false;
  return state.tasks.some(t => t.id === taskId);
}
