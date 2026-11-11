/**
 * Task records: creating, completing and removing tasks, plus the
 * recurrence rules that decide when a repeating task comes back.
 */
import { state, saveState } from './state.js';
import { requestRender } from './render.js';
import { settings, uid, cleanRecurrence } from './app.js';
import { parseDate, toISODate, todayISO, isTaskOverdue, cleanDueTime, cleanDuration, cleanReminderMinutes, formatDue, DATE_RE } from './dates.js';
import { snapshotData, offerUndo } from './undo.js';

/* The phrases people actually type, checked before rrule's own parser:
   it reads a bare "weekly" as a month/day. */
const WEEKDAY_WORDS = /\b(monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)\b/i;
const ORDINAL_WORDS = /\b\d{1,2}(?:st|nd|rd|th)\b/i;
const MONTH_WORDS = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;

export const RECURRENCE_ALIASES = {
  daily: 'FREQ=DAILY;INTERVAL=1',
  'every day': 'FREQ=DAILY;INTERVAL=1',
  weekly: 'FREQ=WEEKLY;INTERVAL=1',
  'every week': 'FREQ=WEEKLY;INTERVAL=1',
  monthly: 'FREQ=MONTHLY;INTERVAL=1',
  'every month': 'FREQ=MONTHLY;INTERVAL=1',
  yearly: 'FREQ=YEARLY;INTERVAL=1',
  annually: 'FREQ=YEARLY;INTERVAL=1',
  'every year': 'FREQ=YEARLY;INTERVAL=1',
  weekday: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR',
  weekdays: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR',
  'every weekday': 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR',
  'every other day': 'FREQ=DAILY;INTERVAL=2',
  'every other week': 'FREQ=WEEKLY;INTERVAL=2',
  'every other month': 'FREQ=MONTHLY;INTERVAL=2',
  'every other year': 'FREQ=YEARLY;INTERVAL=2',
};


export function activeTasks() {
  return state.tasks.filter(t => !t.parentId);
}

/** Completed view includes subtasks too, newest completion first. */
export function completedTasks() {
  return state.tasks
    .filter(t => t.completed)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0) || a.order - b.order);
}

export function subtasksOf(id) {
  return state.tasks.filter(t => t.parentId === id);
}

export function nextOrder() {
  const top = activeTasks();
  return top.length ? Math.max(...top.map(t => t.order || 0)) + 1 : 0;
}

export function addTask(data) {
  // Settings fill in what the caller did not specify.
  const priority = data.priority && data.priority < 4 ? data.priority : (settings.defaultPriority || data.priority || 4);
  const reminder = data.reminderMinutes === undefined || data.reminderMinutes === null
    ? (settings.defaultReminder === null || settings.defaultReminder === undefined ? null : settings.defaultReminder)
    : data.reminderMinutes;

  const task = {
    id: uid(),
    title: data.title || 'New task',
    description: data.description || '',
    due: data.due || null,
    dueTime: cleanDueTime(data.dueTime),
    recurrence: cleanRecurrence(data.recurrence),
    reminderMinutes: cleanReminderMinutes(
      reminder === undefined || reminder === null ? null : Number(reminder)
    ),
    reminderFiredKey: null,
    durationMinutes: cleanDuration(data.durationMinutes),
    priority,
    projectId: data.projectId || null,
    labels: data.labels || [],
    parentId: data.parentId || null,
    completed: false,
    order: nextOrder(),
    createdAt: Date.now(),
  };
  state.tasks.push(task);
  saveState();
  requestRender();
  return task;
}

export function toggleComplete(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  const snapshot = snapshotData();

  // Recurring tasks roll forward to their next occurrence instead of
  // being marked done, so there is only ever one copy of the task.
  if (!t.completed && t.recurrence && t.due) {
    // An overdue repeat skips ahead to the next future occurrence rather
    // than landing back in the past.
    const anchor = t.due < todayISO() ? todayISO() : t.due;
    const next = nextRecurrenceISO({ ...t, due: anchor });
    if (next) {
      t.due = next;
      t.completed = false;
      t.completedAt = null;
      t.reminderFiredKey = null;
      subtasksOf(t.id).forEach(s => {
        s.completed = false;
        s.completedAt = null;
        s.reminderFiredKey = null;
      });
      saveState();
      requestRender();
      offerUndo(`Task moved to ${formatDue(t.due, t.dueTime)}`, snapshot);
      return;
    }
    // An exhausted rule (COUNT/UNTIL) falls through and completes normally.
  }

  t.completed = !t.completed;
  if (t.completed) {
    t.completedAt = Date.now();
    // complete subtasks too
    subtasksOf(t.id).forEach(s => { s.completed = true; s.completedAt = Date.now(); });
  } else {
    t.completedAt = null;
  }
  saveState();
  requestRender();
  offerUndo(t.completed ? 'Task completed' : 'Task reopened', snapshot);
}

/** Deletes a task (and its subtasks) without confirming. Returns success. */
export function removeTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return false;
  const snapshot = snapshotData();
  state.tasks = state.tasks.filter(x => x.id !== id && x.parentId !== id);
  saveState();
  requestRender();
  offerUndo('Task deleted', snapshot);
  return true;
}

export function deleteTask(id) {
  // No confirmation dialog: deletion is immediate and undoable from the toast.
  return removeTask(id);
}

/**
 * Turns free text ("every Monday", "every 2 weeks") into a stored RRULE
 * body. Pieces the parser guessed from today's date (e.g. "every 2 weeks"
 * becoming "on Tuesday") are dropped unless the user actually said them,
 * so the rule anchors to the task's own due date.
 */
export function parseRecurrenceText(text) {
  const raw = String(text || '').trim().replace(/^repeat\s+/i, '');
  if (!raw) return null;
  if (/^FREQ=/i.test(raw)) return cleanRecurrence(raw);
  const lower = raw.toLowerCase().replace(/\s+/g, ' ');
  if (RECURRENCE_ALIASES[lower]) return RECURRENCE_ALIASES[lower];

  const lib = window.rrule;
  if (!lib || !lib.RRule || typeof lib.RRule.fromText !== 'function') return null;

  let parsed;
  try { parsed = lib.RRule.fromText(raw); } catch { return null; }
  if (!parsed || !parsed.options) return null;

  const KEEP = ['freq', 'interval', 'byweekday', 'bymonthday', 'bymonth', 'count', 'until', 'wkst'];
  const opts = {};
  for (const key of KEEP) {
    const value = parsed.options[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    opts[key] = value;
  }
  if (!WEEKDAY_WORDS.test(lower)) delete opts.byweekday;
  if (!ORDINAL_WORDS.test(lower)) delete opts.bymonthday;
  if (!MONTH_WORDS.test(lower)) delete opts.bymonth;

  try {
    // Noon keeps the calendar date identical in every timezone.
    const rule = new lib.RRule({ ...opts, dtstart: new Date(2020, 0, 1, 12, 0, 0, 0) });
    const line = rule.toString().split('\n').find(l => l.startsWith('RRULE:'));
    return line ? cleanRecurrence(line.slice(6)) : null;
  } catch {
    return null;
  }
}

/** Human-readable version of a stored RRULE body. */
export function recurrenceToText(body) {
  if (!body) return '';
  const lib = window.rrule;
  if (lib && lib.RRule && typeof lib.RRule.parseString === 'function') {
    try { return new lib.RRule(lib.RRule.parseString(body)).toText(); } catch {}
  }
  return body;
}

export function nextRecurrenceISO(t) {
  if (!t || !t.due || !t.recurrence) return null;
  const lib = window.rrule;
  if (!lib || !lib.RRule || typeof lib.RRule.parseString !== 'function') return null;
  try {
    const [y, m, d] = t.due.split('-').map(Number);
    const dtstart = new Date(y, m - 1, d, 12, 0, 0, 0);
    const rule = new lib.RRule({ ...lib.RRule.parseString(t.recurrence), dtstart });
    // Walk forward until an occurrence that has not been skipped and that
    // is not before the task's start date.
    let cursor = dtstart;
    for (let i = 0; i < 60; i++) {
      const next = rule.after(cursor, false);
      if (!next) return null;
      const iso = toISODate(next);
      if (isSkippedOccurrence(t, iso)) { cursor = next; continue; }
      if (t.startDate && iso < t.startDate) { cursor = next; continue; }
      return iso;
    }
    return null;
  } catch {
    return null;
  }
}

/** Next occurrence at or after `fromISO` (used when a repeat phrase has no date). */
export function firstRecurrenceISO(body, fromISO) {
  if (!body) return null;
  const lib = window.rrule;
  if (!lib || !lib.RRule || typeof lib.RRule.parseString !== 'function') return null;
  try {
    const [y, m, d] = (fromISO || todayISO()).split('-').map(Number);
    const dtstart = new Date(y, m - 1, d, 12, 0, 0, 0);
    const rule = new lib.RRule({ ...lib.RRule.parseString(body), dtstart });
    const next = rule.after(dtstart, true);
    return next ? toISODate(next) : null;
  } catch {
    return null;
  }
}

/** True when a specific occurrence of a repeating task was skipped. */
export function isSkippedOccurrence(t, iso) {
  if (!t || !Array.isArray(t.exceptions)) return false;
  return t.exceptions.some(e => e.date === iso && e.action !== 'done');
}

/** Skips one occurrence of a repeating task and rolls it to the next one. */
export function skipOccurrence(task) {
  if (!task || !task.recurrence || !task.due) return false;
  const snapshot = snapshotData();
  const skipped = Array.isArray(task.exceptions) ? [...task.exceptions] : [];
  if (!skipped.some(e => e.date === task.due)) {
    skipped.push({ date: task.due, action: 'skip' });
  }
  task.exceptions = skipped;
  const next = nextRecurrenceISO(task);
  if (next) {
    task.due = next;
    task.reminderFiredKey = null;
  }
  saveState();
  requestRender();
  offerUndo('Occurrence skipped', snapshot);
  return true;
}

/** Moves a task to tomorrow, as an all-day task. */
export function snoozeTask(task) {
  if (!task || !task.due) return false;
  const snapshot = snapshotData();
  const d = new Date();
  d.setDate(d.getDate() + 1);
  task.due = toISODate(d);
  task.dueTime = null;
  task.reminderFiredKey = null;
  saveState();
  requestRender();
  offerUndo('Snoozed until tomorrow', snapshot);
  return true;
}

/** The reminders of a task, tolerating the old single-reminder shape. */
export function taskReminders(t) {
  if (!t) return [];
  if (Array.isArray(t.reminders) && t.reminders.length) {
    return t.reminders.filter(r => r && cleanReminderMinutes(r.minutes) !== null);
  }
  if (t.reminderMinutes !== null && t.reminderMinutes !== undefined) {
    return [{ id: 'legacy', minutes: t.reminderMinutes }];
  }
  return [];
}

/** { count: n } or { until: 'YYYY-MM-DD' } — how a repeat stops. */
export function normalizeRecurrenceEnd(v) {
  if (!v || typeof v !== 'object') return null;
  if (Number.isInteger(v.count) && v.count > 0) return { count: v.count, until: null };
  if (typeof v.until === 'string' && DATE_RE.test(v.until)) return { count: null, until: v.until };
  return null;
}

export function priorityColor(p) {
  return { 1: '#db4c3f', 2: '#eb8909', 3: '#246fe0', 4: '#999999' }[p] || '#999999';
}

export function priorityLabel(p) {
  return { 1: 'Priority 1', 2: 'Priority 2', 3: 'Priority 3', 4: 'Priority 4' }[p] || 'Priority 4';
}

export function projectName(id) {
  return state.projects.find(p => p.id === id)?.name || '';
}

export function labelName(id) {
  return state.labels.find(l => l.id === id)?.name || '';
}
