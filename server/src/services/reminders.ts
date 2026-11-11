import { exportEntities, markReminderFired, reminderAlreadyFired } from '../db/repository.ts';
import { pushIsConfigured, sendPush } from './push.ts';

const TWELVE_HOURS = 12 * 60 * 60 * 1000;

export interface ReminderTask {
  id: string;
  title: string;
  due?: string | null;
  dueTime?: string | null;
  completed?: boolean;
  reminders?: { minutes?: number | null }[];
  reminderMinutes?: number | null;
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
  const d = taskDueDate(task);
  if (!d) return null;
  if (!task.dueTime) d.setHours(9, 0, 0, 0);
  d.setMinutes(d.getMinutes() - (minutes || 0));
  return d;
}

/** The reminder offsets of a task, tolerating the old single-reminder shape. */
export function taskReminderMinutes(task: ReminderTask): number[] {
  const valid = (value: unknown): value is number =>
    Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10080;

  if (Array.isArray(task.reminders) && task.reminders.length) {
    return task.reminders.map(r => r && r.minutes).filter(valid);
  }
  if (task.reminderMinutes !== null && task.reminderMinutes !== undefined && valid(task.reminderMinutes)) {
    return [task.reminderMinutes];
  }
  return [];
}

/** Mirrors the client's reminderKey so both sides agree on what fired. */
export function reminderKey(task: ReminderTask): string {
  if (!task.due) return '';
  const offsets = taskReminderMinutes(task).sort((a, b) => a - b).join(',');
  return `${task.due}|${task.dueTime || ''}|${offsets}`;
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
    if (!task || !task.id || task.completed || !task.due) continue;
    const minutes = taskReminderMinutes(task);
    if (!minutes.length) continue;

    const key = reminderKey(task);
    if (!key || reminderAlreadyFired(task.id, key)) continue;

    const earliest = minutes
      .map(m => reminderFireDate(task, m))
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
