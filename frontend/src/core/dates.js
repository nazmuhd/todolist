/**
 * Date and time helpers.
 *
 * Pure functions only: they read the user's format preferences from
 * `core/app.js` and never touch the DOM or the task state.
 */
import { settings } from './app.js';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The weekday names, in the order the week starts on. */
export const QUERY_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function parseDate(iso) {
  if (!iso) return null;
  const [y,m,d] = iso.split('-').map(Number);
  return new Date(y, m-1, d);
}

/** Local YYYY-MM-DD (toISOString() would shift the date in UTC+N). */
export function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayISO() {
  return toISODate(new Date());
}

export function daysFromToday(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

export function prevDayISO(iso) {
  const d = parseDate(iso);
  d.setDate(d.getDate() - 1);
  return toISODate(d);
}

export function nextWeekdayISO(name) {
  const target = QUERY_WEEKDAYS.indexOf(name);
  const d = new Date();
  const diff = (target - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return toISODate(d);
}

/** Parses "HH:mm" into [h, m]; falls back to midnight. */
export function parseTime(hhmm) {
  if (!TIME_RE.test(hhmm || '')) return [0, 0];
  const [h, m] = hhmm.split(':').map(Number);
  return [h, m];
}

/** Formats a time as 12-hour, 24-hour or the system default. */
export function formatTime(hhmm) {
  if (!TIME_RE.test(hhmm || '')) return '';
  const [h, m] = parseTime(hhmm);
  const style = settings.timeFormat || 'system';
  if (style === '24h') return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  if (style === '12h') {
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
  }
  return new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, h, m));
}

/**
 * Formats a date the way the user asked for: the browser's order, US
 * (Nov 12, 2026), day-first (12 Nov 2026) or ISO (2026-11-12).
 */
export function formatDateShort(d, { year = false } = {}) {
  const style = settings.dateFormat || 'system';
  if (style === 'iso') return toISODate(d);
  const locale = style === 'dmy' ? 'en-GB' : style === 'mdy' ? 'en-US' : undefined;
  const opts = { day: 'numeric', month: 'short' };
  if (year) opts.year = 'numeric';
  return new Intl.DateTimeFormat(locale, opts).format(d);
}

export function formatDue(iso, time) {
  if (!iso) return '';
  const d = parseDate(iso);
  const today = parseDate(todayISO());
  const diff = Math.round((d - today) / 86400000);
  let label;
  if (diff === 0) label = 'Today';
  else if (diff === 1) label = 'Tomorrow';
  else if (diff === -1) label = 'Yesterday';
  else if (diff > 1 && diff <= 6) label = new Intl.DateTimeFormat('en', { weekday: 'short' }).format(d);
  else label = formatDateShort(d);
  const t = formatTime(time);
  return t ? `${label} ${t}` : label;
}

/** "90" -> "1h 30m"; null/0 -> "". */
export function formatDuration(minutes) {
  if (!Number.isInteger(minutes) || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** A task today is only overdue once its time has passed (all-day: after midnight). */
export function isTaskOverdue(t) {
  if (!t || !t.due) return false;
  if (t.completed) return false;
  const today = todayISO();
  if (t.due < today) return true;
  if (t.due > today) return false;
  if (!t.dueTime) return false;
  return Date.now() > taskDueDate(t).getTime();
}

export function dueSortValue(t) {
  if (!t || !t.due) return Number.MAX_SAFE_INTEGER;
  return new Date(`${t.due}T${t.dueTime || '00:00'}`).getTime();
}

/** The due instant, using midnight for all-day tasks. */
export function taskDueDate(t) {
  if (!t || !t.due) return null;
  const d = parseDate(t.due);
  const [h, m] = parseTime(t.dueTime);
  d.setHours(h, m, 0, 0);
  return d;
}

/** All-day reminders are treated as 9am local, like Todoist's default. */
export function taskReminderDate(t) {
  const d = taskDueDate(t);
  if (!d) return null;
  if (!t.dueTime) d.setHours(9, 0, 0, 0);
  return d;
}

export function reminderFireDate(t, minutes) {
  if (!t || !t.due) return null;
  // A task's own timezone decides which instant its wall-clock due time means.
  const wall = `${t.due}T${t.dueTime || '09:00'}`;
  const d = zonedDateTimeToDate(wall, t.timeZone || null) || taskReminderDate(t);
  if (!d) return null;
  d.setMinutes(d.getMinutes() - (minutes || 0));
  return d;
}

/** A wall-clock datetime such as "2026-11-12T09:00" (no timezone suffix). */
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

export const cleanDateTime = (v) => (typeof v === 'string' && DATETIME_RE.test(v) ? v : null);

/** Formats a Date as the wall-clock value a datetime-local input expects. */
export function toLocalDateTime(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function cleanTimeZone(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return v;
  } catch {
    return null;
  }
}

/**
 * Converts a wall-clock datetime in `timeZone` to a real instant.
 * With no timezone it is the browser's local time.
 */
export function zonedDateTimeToDate(local, timeZone) {
  const match = DATETIME_RE.exec(local || '');
  if (!match) return null;
  const [y, mo, d] = local.slice(0, 10).split('-').map(Number);
  const [h, mi] = local.slice(11, 16).split(':').map(Number);
  if (!timeZone) return new Date(y, mo - 1, d, h, mi, 0, 0);

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    // Unknown timezone: fall back to the browser's local time.
    return new Date(y, mo - 1, d, h, mi, 0, 0);
  }

  const wall = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  let instant = wall;
  for (let i = 0; i < 4; i++) {
    const parts = formatter.formatToParts(new Date(instant));
    const get = (type) => Number(parts.find(p => p.type === type)?.value);
    const asWall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    const diff = wall - asWall;
    if (!diff) break;
    instant += diff;
  }
  return new Date(instant);
}

/** The browser's IANA timezone, used when a task has no explicit zone. */
export function localTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

/**
 * The instant a reminder fires (absolute or relative to the due date).
 *
 * A location reminder has no instant: it fires when you are near a place,
 * so it has no time and is skipped here.
 */
export function reminderAt(t, reminder) {
  if (!t || !reminder) return null;
  if (Number.isFinite(reminder.lat) && Number.isFinite(reminder.lon)) return null;
  if (cleanDateTime(reminder.at)) return zonedDateTimeToDate(reminder.at, t.timeZone || null);
  if (Number.isInteger(reminder.minutes)) return reminderFireDate(t, reminder.minutes);
  return null;
}

/** Human-readable reminder text, e.g. "Nov 12, 09:00" or "30 minutes before". */
export function formatReminder(t, reminder) {
  if (!reminder) return '';
  if (Number.isFinite(reminder.lat) && Number.isFinite(reminder.lon)) {
    const radius = Number.isFinite(reminder.radius) && reminder.radius > 0 ? reminder.radius : 150;
    return reminder.name ? `When near ${reminder.name}` : `Within ${radius} m`;
  }
  if (cleanDateTime(reminder.at)) {
    const d = zonedDateTimeToDate(reminder.at, t && t.timeZone);
    if (!d) return reminder.at;
    return `${formatDateShort(d, { year: true })} ${formatTime(reminder.at.slice(11, 16))}`;
  }
  return reminder.minutes === 0 ? 'At due time' : `${formatDuration(reminder.minutes)} before`;
}

/** A deadline has passed once its day is before today. */
export function isDeadlineOverdue(t) {
  if (!t || !t.deadline || t.completed) return false;
  return t.deadline < todayISO();
}

export const cleanDueTime = (v) => (typeof v === 'string' && TIME_RE.test(v) ? v : null);

export const cleanDuration = (v) =>
  (Number.isInteger(v) && v > 0 && v <= 10080 ? v : null);

export const cleanReminderMinutes = (v) =>
  (Number.isInteger(v) && v >= 0 && v <= 10080 ? v : null);
