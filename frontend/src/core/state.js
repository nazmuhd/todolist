/**
 * Application state: the default shape, migrations, normalisation and the
 * live state object itself.
 */
import { uid } from './app.js';
import { store } from './store.js';
import { cleanDueTime, cleanDuration, cleanReminderMinutes } from './dates.js';

export const SCHEMA_VERSION = 7;


export const MIGRATIONS = {
  // v1 (unversioned) -> v2 (versioned payload + normalised records)
  1: (s) => {
    // Old payloads could contain tasks without an explicit sort order.
    (Array.isArray(s.tasks) ? s.tasks : []).forEach((t, i) => {
      if (t && typeof t.order !== 'number') t.order = i;
    });
    return s;
  },
  // v2 -> v3 (time-of-day, recurrence, reminders). Existing tasks simply
  // become all-day, non-repeating tasks with no reminder.
  2: (s) => {
    (Array.isArray(s.tasks) ? s.tasks : []).forEach((t) => {
      if (!t || typeof t !== 'object') return;
      if (t.dueTime === undefined) t.dueTime = null;
      if (t.recurrence === undefined) t.recurrence = null;
      if (t.reminderMinutes === undefined) t.reminderMinutes = null;
      if (t.reminderFiredKey === undefined) t.reminderFiredKey = null;
    });
    return s;
  },
  // v3 -> v4 (sections, comments, multiple reminders, recurrence end).
  // Existing tasks simply gain empty collections; nothing is dropped.
  3: (s) => {
    (Array.isArray(s.projects) ? s.projects : []).forEach((p) => {
      if (p && !Array.isArray(p.sections)) p.sections = [];
    });
    (Array.isArray(s.tasks) ? s.tasks : []).forEach((t) => {
      if (!t || typeof t !== 'object') return;
      if (!Array.isArray(t.comments)) t.comments = [];
      if (!Array.isArray(t.skippedDates)) t.skippedDates = [];
      if (!Array.isArray(t.reminders)) {
        t.reminders = (t.reminderMinutes === null || t.reminderMinutes === undefined)
          ? []
          : [{ id: uid(), minutes: t.reminderMinutes }];
      }
      if (t.sectionId === undefined) t.sectionId = null;
      if (t.recurrenceEnd === undefined) t.recurrenceEnd = null;
    });
    return s;
  },
  // v4 -> v5 (attachments). Files live in IndexedDB; the task only keeps
  // the metadata needed to find them again.
  4: (s) => {
    (Array.isArray(s.tasks) ? s.tasks : []).forEach((t) => {
      if (t && typeof t === 'object' && !Array.isArray(t.attachments)) t.attachments = [];
    });
    return s;
  },
  // v5 -> v6 (per-occurrence exceptions). Existing tasks simply gain an
  // empty list of skipped dates.
  5: (s) => {
    (Array.isArray(s.tasks) ? s.tasks : []).forEach((t) => {
      if (t && typeof t === 'object' && !Array.isArray(t.exceptions)) t.exceptions = [];
    });
    return s;
  },
  // v6 -> v7 (separate start date for repeating tasks).
  6: (s) => {
    (Array.isArray(s.tasks) ? s.tasks : []).forEach((t) => {
      if (t && typeof t === 'object' && t.startDate === undefined) t.startDate = null;
    });
    return s;
  },
};


export function defaultState() {
  return {
    version: SCHEMA_VERSION,
    projects: [
      { id: 'proj_default', name: 'Work', color: '#246fe0' },
      { id: 'proj_home', name: 'Personal', color: '#058527' },
    ],
    labels: [
      { id: 'lbl_urgent', name: 'urgent', color: '#db4c3f' },
    ],
    tasks: [],
    ui: { view: 'inbox', activeId: null, search: '', layout: 'list', sort: 'manual' },
    updatedAt: 0,
  };
}

/**
 * Coerces a payload into the current shape, dropping anything unusable
 * and repairing dangling references (missing project/label/parent ids).
 * Runs after every migration, and again on import.
 */
export function normalizeState(s) {
  const projects = [];
  const projectIds = new Set();
  (Array.isArray(s.projects) ? s.projects : []).forEach((p, i) => {
    if (!p || typeof p !== 'object') return;
    const id = asText(p.id) || 'proj_' + uid();
    if (projectIds.has(id)) return;
    projectIds.add(id);
    projects.push({
      id,
      name: asText(p.name).trim() || 'Untitled project',
      color: cleanColor(p.color, PROJECT_COLORS[i % PROJECT_COLORS.length]),
      pinned: !!p.pinned,
      sections: (Array.isArray(p.sections) ? p.sections : [])
        .filter(x => x && typeof x === 'object' && asText(x.id))
        .map(x => ({ id: asText(x.id), name: asText(x.name).trim() || 'Untitled section' })),
    });
  });

  const labels = [];
  const labelIds = new Set();
  (Array.isArray(s.labels) ? s.labels : []).forEach((l, i) => {
    if (!l || typeof l !== 'object') return;
    const id = asText(l.id) || 'lbl_' + uid();
    const name = asText(l.name).replace(/^@/, '').trim();
    if (!name || labelIds.has(id)) return;
    labelIds.add(id);
    labels.push({ id, name, color: cleanColor(l.color, LABEL_COLORS[i % LABEL_COLORS.length]), pinned: !!l.pinned });
  });

  const tasks = [];
  const taskIds = new Set();
  (Array.isArray(s.tasks) ? s.tasks : []).forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    let id = asText(t.id);
    if (!id || taskIds.has(id)) id = uid();
    taskIds.add(id);
    tasks.push({
      id,
      title: asText(t.title).trim() || 'Untitled',
      description: asText(t.description),
      due: typeof t.due === 'string' && DATE_RE.test(t.due) ? t.due : null,
      dueTime: cleanDueTime(t.dueTime),
      recurrence: cleanRecurrence(t.recurrence),
      reminderMinutes: cleanReminderMinutes(t.reminderMinutes),
      reminderFiredKey: asText(t.reminderFiredKey) || null,
      durationMinutes: cleanDuration(t.durationMinutes),
      priority: clampPriority(t.priority),
      projectId: projectIds.has(t.projectId) ? t.projectId : null,
      labels: [...new Set((Array.isArray(t.labels) ? t.labels : []).map(asText).filter(lid => labelIds.has(lid)))],
      parentId: asText(t.parentId) || null,
      completed: !!t.completed,
      completedAt: typeof t.completedAt === 'number' ? t.completedAt : null,
      order: typeof t.order === 'number' ? t.order : i,
      createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
      // v4 additions
      sectionId: asText(t.sectionId) || null,
      comments: (Array.isArray(t.comments) ? t.comments : [])
        .filter(c => c && typeof c === 'object' && asText(c.text))
        .map(c => ({
          id: asText(c.id) || uid(),
          text: asText(c.text),
          createdAt: typeof c.createdAt === 'number' ? c.createdAt : Date.now(),
        })),
      reminders: (Array.isArray(t.reminders) ? t.reminders : [])
        .filter(r => r && typeof r === 'object' && cleanReminderMinutes(r.minutes) !== null)
        .map(r => ({ id: asText(r.id) || uid(), minutes: cleanReminderMinutes(r.minutes) })),
      skippedDates: (Array.isArray(t.skippedDates) ? t.skippedDates : [])
        .map(asText)
        .filter(d => DATE_RE.test(d)),
      recurrenceEnd: normalizeRecurrenceEnd(t.recurrenceEnd),
      startDate: DATE_RE.test(asText(t.startDate)) ? asText(t.startDate) : null,
      exceptions: (Array.isArray(t.exceptions) ? t.exceptions : [])
        .map(e => (typeof e === 'string' ? { date: e, action: 'skip' } : e))
        .filter(e => e && typeof e === 'object' && DATE_RE.test(asText(e.date)))
        .map(e => ({ date: asText(e.date), action: asText(e.action) || 'skip' })),
      attachments: (Array.isArray(t.attachments) ? t.attachments : [])
        .filter(a => a && typeof a === 'object' && asText(a.id))
        .map(a => ({
          id: asText(a.id),
          name: asText(a.name) || 'file',
          type: asText(a.type),
          size: Number.isFinite(a.size) ? a.size : 0,
          addedAt: typeof a.addedAt === 'number' ? a.addedAt : Date.now(),
        })),
    });
  });
  // A parent must exist and can't be the task itself.
  tasks.forEach(t => {
    if (t.parentId && (t.parentId === t.id || !taskIds.has(t.parentId))) t.parentId = null;
  });

  const rawUi = s.ui && typeof s.ui === 'object' ? s.ui : {};
  let view = asText(rawUi.view) || 'inbox';
  const knownView =
    view === 'inbox' || view === 'today' || view === 'upcoming' || view === 'calendar' || view === 'karma' ||
    view === 'completed' || view === 'no-date' || view === 'no-priority' ||
    (view.startsWith('project:') && projectIds.has(view.slice(8))) ||
    (view.startsWith('label:') && labelIds.has(view.slice(6))) ||
    (view.startsWith('filter:') && savedFilters.some(f => f.id === view.slice(7)));
  if (!knownView) view = 'inbox';

  return {
    version: SCHEMA_VERSION,
    projects,
    labels,
    tasks,
    ui: {
      view,
      activeId: asText(rawUi.activeId) || null,
      search: asText(rawUi.search),
      layout: rawUi.layout === 'board' ? 'board' : 'list',
      sort: ['manual', 'date', 'priority', 'name', 'added'].includes(rawUi.sort) ? rawUi.sort : 'manual',
      calendarMonth: /^\d{4}-\d{2}$/.test(asText(rawUi.calendarMonth)) ? asText(rawUi.calendarMonth) : null,
      calendarSelected: /^\d{4}-\d{2}-\d{2}$/.test(asText(rawUi.calendarSelected)) ? asText(rawUi.calendarSelected) : null,
    },
    updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
  };
}

/** Upgrades a raw parsed payload (any supported version) to the current shape. */
export function migrateState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultState();
  let s;
  try { s = JSON.parse(JSON.stringify(raw)); } catch { return defaultState(); }

  let from = Number.isInteger(s.version) ? s.version : 1;
  if (from > SCHEMA_VERSION) throw new Error(`Data is from a newer version (v${from})`);
  while (from < SCHEMA_VERSION) {
    const step = MIGRATIONS[from];
    if (typeof step === 'function') s = step(s) || s;
    from += 1;
    s.version = from;
  }
  return normalizeState(s);
}


/** The live state. Reassign it through setState() so importers see it. */
export let state = defaultState();

export function setState(next) {
  state = next;
}
