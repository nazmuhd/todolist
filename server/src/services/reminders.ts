import { exportEntities, markReminderFired, reminderAlreadyFired } from '../db/repository.ts';
import { pushIsConfigured, sendPush } from './push.ts';

const TWELVE_HOURS = 12 * 60 * 60 * 1000;

export interface ReminderTask {
  id: string;
  title: string;
  due?: string | null;
  dueTime?: string | null;
  timeZone?: string | null;
  completed?: boolean;
  reminders?: { id?: string; minutes?: number | null; at?: string | null }[];
  reminderMinutes?: number | null;
}

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

function validMinutes(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10080;
}

/** Converts a wall-clock datetime in `timeZone` to a real instant. */
export function zonedDateTimeToDate(local: string, timeZone?: string | null): Date | null {
  if (!DATETIME_RE.test(local)) return null;
  const [y, mo, d] = local.slice(0, 10).split('-').map(Number) as [number, number, number];
  const [h, mi] = local.slice(11, 16).split(':').map(Number) as [number, number];
  if (!timeZone) return new Date(y, mo - 1, d, h, mi, 0, 0);

  let formatter: Intl.DateTimeFormat;
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
    // Unknown timezone: fall back to the server's local time.
    return new Date(y, mo - 1, d, h, mi, 0, 0);
  }

  const wall = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  let instant = wall;
  for (let i = 0; i < 4; i++) {
    const parts = formatter.formatToParts(new Date(instant));
    const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
    const asWall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    const diff = wall - asWall;
    if (!diff) break;
    instant += diff;
  }
  return new Date(instant);
}

function parseDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y as number, (m as number) - 1, d as number);
}

function parseTime(hhmm: string | null | undefined): [number, number] {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm || '')) return [0, 0];
  const [h, m] = (hhmm as string).split(':').map(Number);
  return [h as number, m as number];
}

/** The due instant, using midnight for all-day tasks. */
export function taskDueDate(task: ReminderTask): Date | null {
  if (!task.due) return null;
  const d = parseDate(task.due);
  const [h, m] = parseTime(task.dueTime);
  d.setHours(h, m, 0, 0);
  return d;
}

/** All-day reminders are treated as 9am, like the client. */
export function reminderFireDate(task: ReminderTask, minutes: number): Date | null {
  if (!task.due) return null;
  // A task's own timezone decides which instant its wall-clock due time means.
  const wall = `${task.due}T${task.dueTime || '09:00'}`;
  const d = zonedDateTimeToDate(wall, task.timeZone) ?? taskDueDate(task);
  if (!d || Number.isNaN(d.getTime())) return null;
  d.setMinutes(d.getMinutes() - (minutes || 0));
  return d;
}

/** The reminder offsets of a task, tolerating the old single-reminder shape. */
export function taskReminderMinutes(task: ReminderTask): number[] {
  return taskReminderList(task)
    .map(r => r.minutes)
    .filter((value): value is number => validMinutes(value));
}

export interface ServerReminder {
  id?: string;
  minutes?: number;
  at?: string;
}

/** Normalizes both reminder shapes into one list. */
export function taskReminderList(task: ReminderTask): ServerReminder[] {
  if (Array.isArray(task.reminders) && task.reminders.length) {
    return task.reminders.flatMap((r): ServerReminder[] => {
      if (!r || typeof r !== 'object') return [];
      if (typeof r.at === 'string' && DATETIME_RE.test(r.at)) return [{ id: r.id, at: r.at }];
      if (validMinutes(r.minutes)) return [{ id: r.id, minutes: r.minutes }];
      return [];
    });
  }
  if (task.reminderMinutes !== null && task.reminderMinutes !== undefined && validMinutes(task.reminderMinutes)) {
    return [{ minutes: task.reminderMinutes }];
  }
  return [];
}

/** The instant a reminder fires, honouring an absolute time and timezone. */
export function reminderAt(task: ReminderTask, reminder: ServerReminder): Date | null {
  if (reminder.at) return zonedDateTimeToDate(reminder.at, task.timeZone);
  if (validMinutes(reminder.minutes)) return reminderFireDate(task, reminder.minutes);
  return null;
}

/** Mirrors the client's reminderKey so both sides agree on what fired. */
export function reminderKey(task: ReminderTask): string {
  const parts = taskReminderList(task)
    .map(r => (r.at ? `at:${r.at}` : `m:${r.minutes}`))
    .sort()
    .join(',');
  if (!parts) return '';
  return `${task.due || ''}|${task.dueTime || ''}|${task.timeZone || ''}|${parts}`;
}

export interface DueReminder {
  task: ReminderTask;
  key: string;
}

/**
 * Reminders that came due in the last 12 hours and have not been sent yet.
 * Anything older is skipped rather than spammed.
 */
export function dueReminders(now = Date.now()): DueReminder[] {
  const tasks = exportEntities().tasks as ReminderTask[];
  const due: DueReminder[] = [];

  for (const task of tasks) {
    if (!task || !task.id || task.completed) continue;
    const reminders = taskReminderList(task);
    if (!reminders.length) continue;

    const key = reminderKey(task);
    if (!key || reminderAlreadyFired(task.id, key)) continue;

    const earliest = reminders
      .map(r => reminderAt(task, r))
      .filter((d): d is Date => Boolean(d))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (!earliest) continue;

    const fireAt = earliest.getTime();
    if (now < fireAt) continue;
    if (now - fireAt > TWELVE_HOURS) continue;

    due.push({ task, key });
  }

  return due;
}

/** Fires every due reminder and records what was sent. */
export async function runReminders(now = Date.now()): Promise<{ fired: number; sent: number }> {
  const due = dueReminders(now);
  if (!due.length || !pushIsConfigured()) return { fired: 0, sent: 0 };

  let fired = 0;
  let sent = 0;

  for (const item of due) {
    const result = await sendPush({
      title: 'Task reminder',
      body: item.task.title,
      taskId: item.task.id,
      tag: `todoist-clone-${item.task.id}`,
    });
    if (result.sent > 0) {
      markReminderFired(item.task.id, item.key);
      fired += 1;
      sent += result.sent;
    }
  }

  return { fired, sent };
}

let timer: NodeJS.Timeout | null = null;

/** Starts the background reminder loop. Safe to call once. */
export function startReminderWorker(intervalMs = 30_000): void {
  if (timer || !pushIsConfigured()) return;
  timer = setInterval(() => {
    runReminders().catch(err => console.error('Reminder worker failed:', err));
  }, intervalMs);
  timer.unref?.();
}

export function stopReminderWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
