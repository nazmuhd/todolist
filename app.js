/* ============================================================
   STORAGE
   All persistence goes through the adapter in storage.js. Moving to
   a backend later is a one-line change:
     const store = new TodoStore.ApiStore({ token });
============================================================ */
const store = new TodoStore.LocalStore();

/* ============================================================
   STATE + PERSISTENCE
   Data lives in the browser for now (see storage.js). `version` is bumped whenever the
   shape changes; MIGRATIONS upgrades older payloads on load, so existing data is never thrown away.
============================================================ */
const SCHEMA_VERSION = 5;

const PROJECT_COLORS = ['#246fe0', '#058527', '#db4c3f', '#eb8909', '#8a4dff', '#0f9d58'];
const LABEL_COLORS = ['#db4c3f', '#eb8909', '#246fe0', '#058527', '#8a4dff'];

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function defaultState() {
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

/* ------------------------------------------------------------
   Migrations, keyed by the version they upgrade FROM.
   Each step gets a mutable clone and returns the next shape.
   To evolve the data later, add MIGRATIONS[SCHEMA_VERSION] and
   bump SCHEMA_VERSION.
------------------------------------------------------------ */
const MIGRATIONS = {
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
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const asText = (v) => (typeof v === 'string' ? v : '');
const cleanColor = (c, fallback) => (typeof c === 'string' && COLOR_RE.test(c) ? c : fallback);
const clampPriority = (p) => (Number.isInteger(p) && p >= 1 && p <= 4 ? p : 4);

/** Accepts only a well-formed RRULE body (e.g. "FREQ=WEEKLY;BYDAY=MO"). */
function cleanRecurrence(v) {
  if (typeof v !== 'string') return null;
  const body = v.trim().toUpperCase();
  if (!body) return null;
  if (!/^[A-Z0-9=;,:+\-]+$/.test(body)) return null;
  const lib = window.rrule;
  if (lib && lib.RRule && typeof lib.RRule.parseString === 'function') {
    try { lib.RRule.parseString(body); } catch { return null; }
  }
  return body;
}

const cleanDueTime = (v) => (typeof v === 'string' && TIME_RE.test(v) ? v : null);
const cleanReminderMinutes = (v) =>
  (Number.isInteger(v) && v >= 0 && v <= 10080 ? v : null);
const cleanDuration = (v) =>
  (Number.isInteger(v) && v > 0 && v <= 10080 ? v : null);

/** { count: n } or { until: 'YYYY-MM-DD' } — how a repeat stops. */
function normalizeRecurrenceEnd(v) {
  if (!v || typeof v !== 'object') return null;
  if (Number.isInteger(v.count) && v.count > 0) return { count: v.count, until: null };
  if (typeof v.until === 'string' && DATE_RE.test(v.until)) return { count: null, until: v.until };
  return null;
}

/** "90" -> "1h 30m"; null/0 -> "". */
function formatDuration(minutes) {
  if (!Number.isInteger(minutes) || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function durationBadge(t) {
  const text = formatDuration(t && t.durationMinutes);
  if (!text) return '';
  return `<span class="flex items-center gap-1 text-td-muted"><i data-lucide="clock" class="w-3 h-3"></i>${text}</span>`;
}

/**
 * Coerces a payload into the current shape, dropping anything unusable
 * and repairing dangling references (missing project/label/parent ids).
 * Runs after every migration, and again on import.
 */
function normalizeState(s) {
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
function migrateState(raw) {
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

/* ============================================================
   SAVED FILTERS
   Stored beside the app state so the task schema stays untouched.
============================================================ */
let savedFilters = [];

async function loadSavedFilters() {
  const raw = await store.getDoc(store.keys.filters);
  if (!Array.isArray(raw)) {
    savedFilters = [];
    return;
  }
  savedFilters = raw
    .filter(f => f && typeof f.id === 'string' && typeof f.name === 'string' && typeof f.query === 'string')
    .map(f => ({ id: f.id, name: f.name, query: f.query }));
}

function persistSavedFilters() {
  store.setDoc(store.keys.filters, savedFilters).catch(err => console.error('Could not save filters:', err));
}

/** How many open tasks a saved filter currently matches. */
function filterTaskCount(query) {
  const fn = queryMatcher(query);
  return activeTasks().filter(t => fn(t)).length;
}

// Only the most recent destructive action can be undone (like Todoist's toast).
let pendingUndo = null;
// The state before the last undo, so it can be redone.
let redoSnapshot = null;

// Filters must be known before the state is read: a saved filter can be the
// active view, and the state loader validates the view name.
let state = defaultState();

/** Reads the saved state, keeping an unreadable payload as a backup. */
async function loadState() {
  const raw = await store.loadState();
  if (!raw) return { state: defaultState(), storedVersion: null };
  try {
    return { state: migrateState(raw), storedVersion: raw.version ?? 1 };
  } catch (err) {
    console.warn('Saved data could not be read:', err);
    // Keep the unreadable payload instead of silently destroying it.
    await store.backupState('corrupt').catch(() => {});
    return { state: defaultState(), storedVersion: null };
  }
}

function persistState() {
  state.updatedAt = Date.now();
  store.saveState(state).catch(err => {
    console.error('Could not save data:', err);
    showToast('Could not save — browser storage may be full', 'error');
  });
}

function saveState() {
  // Any new change supersedes a pending undo, so a stale snapshot can
  // never wipe out work done after the action it was captured for.
  clearPendingUndo();
  persistState();
}

/* ============================================================
   HELPERS
============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Local YYYY-MM-DD (toISOString() would shift the date in UTC+N). */
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayISO() {
  return toISODate(new Date());
}
function parseDate(iso) {
  if (!iso) return null;
  const [y,m,d] = iso.split('-').map(Number);
  return new Date(y, m-1, d);
}
/** Parses "HH:mm" into [h, m]; falls back to midnight. */
function parseTime(hhmm) {
  if (!TIME_RE.test(hhmm || '')) return [0, 0];
  const [h, m] = hhmm.split(':').map(Number);
  return [h, m];
}
function formatTime(hhmm) {
  if (!TIME_RE.test(hhmm || '')) return '';
  const [h, m] = parseTime(hhmm);
  return new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, h, m));
}
function formatDue(iso, time) {
  if (!iso) return '';
  const d = parseDate(iso);
  const today = parseDate(todayISO());
  const diff = Math.round((d - today) / 86400000);
  let label;
  if (diff === 0) label = 'Today';
  else if (diff === 1) label = 'Tomorrow';
  else if (diff === -1) label = 'Yesterday';
  else if (diff > 1 && diff <= 6) label = new Intl.DateTimeFormat('en', { weekday: 'short' }).format(d);
  else label = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(d);
  const t = formatTime(time);
  return t ? `${label} ${t}` : label;
}
/** The due instant, using midnight for all-day tasks. */
function taskDueDate(t) {
  if (!t || !t.due) return null;
  const d = parseDate(t.due);
  const [h, m] = parseTime(t.dueTime);
  d.setHours(h, m, 0, 0);
  return d;
}
/** All-day reminders are treated as 9am local, like Todoist's default. */
function taskReminderDate(t) {
  const d = taskDueDate(t);
  if (!d) return null;
  if (!t.dueTime) d.setHours(9, 0, 0, 0);
  return d;
}
/** A task today is only overdue once its time has passed (all-day: after midnight). */
function isTaskOverdue(t) {
  if (!t || !t.due) return false;
  if (t.completed) return false;
  const today = todayISO();
  if (t.due < today) return true;
  if (t.due > today) return false;
  if (!t.dueTime) return false;
  return Date.now() > taskDueDate(t).getTime();
}
function dueSortValue(t) {
  if (!t || !t.due) return Number.MAX_SAFE_INTEGER;
  return new Date(`${t.due}T${t.dueTime || '00:00'}`).getTime();
}
function priorityColor(p) {
  return { 1: '#db4c3f', 2: '#eb8909', 3: '#246fe0', 4: '#999999' }[p] || '#999999';
}
/**
 * Priorities are also marked with a shape, so the level is readable
 * without relying on colour (red and orange are hard to tell apart for
 * some colour-blind users).
 */
function priorityMarker(p) {
  if (p === 1) return '<span class="prio-marker prio-1" aria-hidden="true"></span>';
  if (p === 2) return '<span class="prio-marker prio-2" aria-hidden="true"></span>';
  if (p === 3) return '<span class="prio-marker prio-3" aria-hidden="true"></span>';
  return '';
}
function priorityLabel(p) {
  return { 1: 'Priority 1', 2: 'Priority 2', 3: 'Priority 3', 4: 'Priority 4' }[p] || 'Priority 4';
}
function projectName(id) {
  return state.projects.find(p => p.id === id)?.name || '';
}
function labelName(id) {
  return state.labels.find(l => l.id === id)?.name || '';
}
function activeTasks() {
  return state.tasks.filter(t => !t.parentId);
}
function subtasksOf(id) {
  return state.tasks.filter(t => t.parentId === id);
}
/** Completed view includes subtasks too, newest completion first. */
function completedTasks() {
  return state.tasks
    .filter(t => t.completed)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0) || a.order - b.order);
}
/** Board layout is available for task lists, not grouped/archive views. */
function supportsBoard(view = state.ui.view) {
  return view !== 'upcoming' && view !== 'completed' && view !== 'calendar' && view !== 'karma' && !(state.ui.search || '').trim();
}

/* ============================================================
   RECURRENCE (rrule from CDN) + REMINDERS
============================================================ */
const WEEKDAY_WORDS = /\b(monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)\b/i;
const ORDINAL_WORDS = /\b\d{1,2}(?:st|nd|rd|th)\b/i;
const MONTH_WORDS = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;

// Handled explicitly because rrule's English parser reads bare "weekly"
// as a month/day; these are the phrases people actually type.
const RECURRENCE_ALIASES = {
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

/**
 * Turns free text ("every Monday", "every 2 weeks") into a stored RRULE
 * body. Pieces the parser guessed from today's date (e.g. "every 2 weeks"
 * becoming "on Tuesday") are dropped unless the user actually said them,
 * so the rule anchors to the task's own due date.
 */
function parseRecurrenceText(text) {
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
function recurrenceToText(body) {
  if (!body) return '';
  const lib = window.rrule;
  if (lib && lib.RRule && typeof lib.RRule.parseString === 'function') {
    try { return new lib.RRule(lib.RRule.parseString(body)).toText(); } catch {}
  }
  return body;
}

/** Next occurrence strictly after the task's current due date. */
function nextRecurrenceISO(t) {
  if (!t || !t.due || !t.recurrence) return null;
  const lib = window.rrule;
  if (!lib || !lib.RRule || typeof lib.RRule.parseString !== 'function') return null;
  try {
    const [y, m, d] = t.due.split('-').map(Number);
    const dtstart = new Date(y, m - 1, d, 12, 0, 0, 0);
    const rule = new lib.RRule({ ...lib.RRule.parseString(t.recurrence), dtstart });
    const next = rule.after(dtstart, false);
    return next ? toISODate(next) : null;
  } catch {
    return null;
  }
}

/** Next occurrence at or after `fromISO` (used when a repeat phrase has no date). */
function firstRecurrenceISO(body, fromISO) {
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

function reminderKey(t) {
  if (!t || !t.due) return '';
  const offsets = taskReminders(t).map(r => r.minutes).sort((a, b) => a - b).join(',');
  return `${t.due}|${t.dueTime || ''}|${offsets}`;
}
function reminderFireDate(t, minutes) {
  const d = taskReminderDate(t);
  if (!d) return null;
  d.setMinutes(d.getMinutes() - (minutes || 0));
  return d;
}
function ensureNotificationPermission() {
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
      n.onclick = () => { window.focus(); openTaskModal(t.id); n.close(); };
      return;
    } catch {}
  }
  // No Notification support/permission: an in-page toast still helps.
  showToast(`Reminder: ${t.title}`, 'info', {
    actionLabel: 'View',
    onAction: () => openTaskModal(t.id),
    duration: 10000,
  });
}

/**
 * Fires reminders that have come due while the tab has been open.
 * Anything missed by more than 12 hours is skipped rather than spammed.
 */
function checkReminders(now = Date.now()) {
  state.tasks.forEach(t => {
    if (t.completed || !t.due) return;
    const reminders = taskReminders(t);
    if (!reminders.length) return;
    const key = reminderKey(t);
    if (!key || t.reminderFiredKey === key) return;
    // Fire the earliest reminder that is due.
    const due = reminders
      .map(r => ({ r, at: reminderFireDate(t, r.minutes) }))
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

/* ============================================================
   FILTER QUERY LANGUAGE
   "p1 | p2", "overdue & !#work", "7 days", "@urgent", "#work",
   "has:date", quoted phrases, and ! for negation.
============================================================ */
const QUERY_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function daysFromToday(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

function nextWeekdayISO(name) {
  const target = QUERY_WEEKDAYS.indexOf(name);
  const d = new Date();
  const diff = (target - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return toISODate(d);
}

const QUERY_DATE_TERMS = {
  overdue: t => isTaskOverdue(t),
  today: t => t.due === todayISO(),
  tomorrow: t => t.due === daysFromToday(1),
  yesterday: t => t.due === daysFromToday(-1),
  week: t => !!t.due && t.due >= todayISO() && t.due <= daysFromToday(7),
  month: t => !!t.due && t.due >= todayISO() && t.due <= daysFromToday(30),
};

const QUERY_RANGES = {
  day: 1, days: 1, week: 7, weeks: 7, month: 30, months: 30,
};

function tokenizeQuery(text) {
  const tokens = [];
  const src = String(text || '').replace(/\bnext\s+/gi, ' ');
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if ('&|!()'.includes(ch)) { tokens.push({ op: ch }); i++; continue; }

    let word = '';
    if (ch === '"') {
      i++;
      while (i < src.length && src[i] !== '"') { word += src[i]; i++; }
      i++;
    } else {
      while (i < src.length && !/[\s&|!()]/.test(src[i])) { word += src[i]; i++; }
      // "7 days" / "2 weeks" are a single term.
      if (/^\d+$/.test(word)) {
        const um = /^\s*(days|day|weeks|week|months|month)/i.exec(src.slice(i));
        if (um) { word += ' ' + um[1].toLowerCase(); i += um[0].length; }
      }
    }
    if (word) tokens.push({ word });
  }
  return tokens;
}

function queryTermPredicate(word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w) return () => true;

  if (/^p[1-4]$/.test(w)) {
    const p = Number(w[1]);
    return t => t.priority === p;
  }
  if (w.startsWith('#')) {
    const name = w.slice(1);
    return t => {
      const proj = state.projects.find(p => p.name.toLowerCase() === name);
      const wanted = proj ? proj.id : name;
      return String(t.projectId || '').toLowerCase() === wanted.toLowerCase();
    };
  }
  if (w.startsWith('@')) {
    const name = w.slice(1);
    return t => {
      const lbl = state.labels.find(l => l.name.toLowerCase() === name);
      const wanted = lbl ? lbl.id : name;
      return (t.labels || []).some(lid => String(lid).toLowerCase() === wanted.toLowerCase());
    };
  }
  if (w === 'has:date') return t => !!t.due;
  if (w === 'no:date') return t => !t.due;
  if (w === 'has:project') return t => !!t.projectId;
  if (w === 'no:project') return t => !t.projectId;
  if (w === 'has:label') return t => (t.labels || []).length > 0;
  if (w === 'has:priority') return t => t.priority < 4;

  const range = /^(\d+)\s*(days|day|weeks|week|months|month)$/.exec(w);
  if (range) {
    const days = QUERY_RANGES[range[2]] * Number(range[1]);
    return t => !!t.due && t.due >= todayISO() && t.due <= daysFromToday(days);
  }
  if (QUERY_DATE_TERMS[w]) return QUERY_DATE_TERMS[w];
  if (QUERY_WEEKDAYS.includes(w)) {
    const target = nextWeekdayISO(w);
    return t => t.due === target;
  }
  return t => `${t.title} ${t.description || ''}`.toLowerCase().includes(w);
}

/** Parses a query into a predicate. | = or, & / spaces = and, ! = not. */
function parseQuery(text) {
  const tokens = tokenizeQuery(text);
  let pos = 0;
  const peek = () => tokens[pos];

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().op === '|') {
      pos++;
      const right = parseAnd();
      const l = left;
      left = t => l(t) || right(t);
    }
    return left;
  }
  function parseAnd() {
    let left = parseUnary();
    while (peek() && (peek().word || peek().op === '&' || peek().op === '!')) {
      if (peek().op === '&') pos++;
      const right = parseUnary();
      const l = left;
      left = t => l(t) && right(t);
    }
    return left;
  }
  function parseUnary() {
    if (peek() && peek().op === '!') {
      pos++;
      const inner = parseUnary();
      return t => !inner(t);
    }
    return parseTerm();
  }
  function parseTerm() {
    const tok = peek();
    if (!tok) return () => true;
    if (tok.op === '(') {
      pos++;
      const inner = parseOr();
      if (peek() && peek().op === ')') pos++;
      return inner;
    }
    if (tok.op === ')') { pos++; return () => true; }
    pos++;
    return queryTermPredicate(tok.word || '');
  }
  if (!tokens.length) return () => true;
  return parseOr();
}

// The parsed query is cached; it only changes when the text changes.
let queryCache = { text: null, fn: null };
function queryMatcher(text) {
  const key = String(text || '');
  if (queryCache.text === key) return queryCache.fn;
  queryCache = { text: key, fn: parseQuery(key) };
  return queryCache.fn;
}

/* ============================================================
   CALENDAR (month grid)
============================================================ */
const CAL_MAX_CELL_TASKS = 3;

function calendarMonthShift(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function calendarMonthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
}

function calendarDayLabel(iso) {
  return new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(parseDate(iso));
}

function renderCalendar() {
  const box = $('#calendar-view');
  const today = todayISO();
  const month = state.ui.calendarMonth || today.slice(0, 7);
  const [year, mon] = month.split('-').map(Number);
  const first = new Date(year, mon - 1, 1);
  const weekStart = settings.startOfWeek === 'sun' ? 0 : 1;
  const offset = (first.getDay() - weekStart + 7) % 7;

  const selected = (state.ui.calendarSelected || '').startsWith(month)
    ? state.ui.calendarSelected
    : (month === today.slice(0, 7) ? today : `${month}-01`);

  const byDate = new Map();
  activeTasks().forEach(t => {
    if (!t.due) return;
    if (!byDate.has(t.due)) byDate.set(t.due, []);
    byDate.get(t.due).push(t);
  });

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, mon - 1, i - offset + 1);
    const iso = toISODate(d);
    cells.push({
      iso,
      num: d.getDate(),
      inMonth: d.getMonth() === mon - 1,
      tasks: byDate.get(iso) || [],
    });
  }

  const dayTasks = (byDate.get(selected) || []).sort((a, b) => dueSortValue(a) - dueSortValue(b));

  box.innerHTML = `
    <div class="cal-toolbar">
      <button type="button" id="cal-prev" class="cal-nav-btn" title="Previous month" aria-label="Previous month"><i data-lucide="chevron-left" class="w-4 h-4"></i></button>
      <h2 class="cal-title">${escapeHtml(calendarMonthLabel(month))}</h2>
      <button type="button" id="cal-next" class="cal-nav-btn" title="Next month" aria-label="Next month"><i data-lucide="chevron-right" class="w-4 h-4"></i></button>
      <button type="button" id="cal-today" class="text-xs text-td-muted hover:text-td-text px-2 py-1 ml-1">Today</button>
    </div>

    <div class="cal-scroll">
      <div class="cal-grid">
        ${(weekStart === 1 ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']).map(d => `<div class="cal-dow">${d}</div>`).join('')}
        ${cells.map(c => `
          <div class="cal-cell${c.inMonth ? '' : ' other'}${c.iso === today ? ' today' : ''}${c.iso === selected ? ' selected' : ''}" data-cal-date="${c.iso}" role="button" tabindex="0" aria-label="${escapeHtml(calendarDayLabel(c.iso))}">
            <div class="cal-num">${c.num}</div>
            ${c.tasks.slice(0, CAL_MAX_CELL_TASKS).map(t => `
              <button type="button" class="cal-task" data-cal-task="${t.id}" style="border-left-color:${priorityColor(t.priority)}" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</button>`).join('')}
            ${c.tasks.length > CAL_MAX_CELL_TASKS ? `<div class="cal-more">+${c.tasks.length - CAL_MAX_CELL_TASKS} more</div>` : ''}
          </div>`).join('')}
      </div>
    </div>

    <div class="cal-panel">
      <div class="cal-panel-head">
        <span>${escapeHtml(calendarDayLabel(selected))}</span>
        <button type="button" id="cal-add" class="text-xs text-td-muted hover:text-td-text flex items-center gap-1">
          <i data-lucide="plus" class="w-3.5 h-3.5"></i>Add task
        </button>
      </div>
      <div class="cal-panel-body">
        ${dayTasks.length
          ? `<ul class="space-y-0">${dayTasks.map(t => renderTaskRow(t, false)).join('')}</ul>`
          : '<div class="text-xs text-td-muted px-2 py-4">No tasks on this day.</div>'}
      </div>
    </div>`;

  $('#cal-prev').onclick = () => {
    state.ui.calendarMonth = calendarMonthShift(month, -1);
    state.ui.calendarSelected = null;
    saveState();
    render();
  };
  $('#cal-next').onclick = () => {
    state.ui.calendarMonth = calendarMonthShift(month, 1);
    state.ui.calendarSelected = null;
    saveState();
    render();
  };
  $('#cal-today').onclick = () => {
    state.ui.calendarMonth = today.slice(0, 7);
    state.ui.calendarSelected = today;
    saveState();
    render();
  };
  $('#cal-add').onclick = () => openQuickAdd({ due: selected });

  bindTaskEvents(false);
  lucide.createIcons();
}

// One delegated handler: the calendar markup is replaced on every render.
$('#calendar-view').addEventListener('click', (e) => {
  const taskBtn = e.target.closest('[data-cal-task]');
  if (taskBtn) {
    e.stopPropagation();
    openTaskModal(taskBtn.dataset.calTask);
    return;
  }
  const cell = e.target.closest('[data-cal-date]');
  if (cell) {
    state.ui.calendarSelected = cell.dataset.calDate;
    saveState();
    render();
  }
});

$('#calendar-view').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const cell = e.target.closest('[data-cal-date]');
  if (!cell) return;
  e.preventDefault();
  state.ui.calendarSelected = cell.dataset.calDate;
  saveState();
  render();
});

/* ============================================================
   DEEP LINKS
   The current view (and search) live in the URL hash, so views can be
   shared and the browser back button works.
============================================================ */
function isKnownView(view) {
  if (['inbox', 'today', 'upcoming', 'calendar', 'completed', 'no-date', 'no-priority'].includes(view)) return true;
  if (view.startsWith('project:')) return state.projects.some(p => p.id === view.slice(8));
  if (view.startsWith('label:')) return state.labels.some(l => l.id === view.slice(6));
  if (view.startsWith('filter:')) return savedFilters.some(f => f.id === view.slice(7));
  return false;
}

function currentHash() {
  const q = (state.ui.search || '').trim();
  return `#/${state.ui.view}${q ? `?q=${encodeURIComponent(q)}` : ''}`;
}

function syncHash() {
  const next = currentHash();
  if (location.hash !== next) location.hash = next;
}

function applyHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw) return;
  const [viewPart, queryPart] = raw.split('?');
  const view = decodeURIComponent(viewPart || 'inbox');
  const q = queryPart ? (new URLSearchParams(queryPart).get('q') || '') : '';
  if (!isKnownView(view)) return;
  if (view === state.ui.view && q === (state.ui.search || '')) return;
  state.ui.view = view;
  state.ui.search = q;
  const input = $('#search-input');
  if (input) input.value = q;
  saveState();
  render();
}

window.addEventListener('hashchange', applyHash);

/* ============================================================
   SERVICE WORKER (offline)
============================================================ */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .catch(err => console.warn('Service worker registration failed:', err));
  });
}

/* ============================================================
   KARMA (productivity stats)
============================================================ */
function prevDayISO(iso) {
  const d = parseDate(iso);
  d.setDate(d.getDate() - 1);
  return toISODate(d);
}

function karmaSummary(days = 14) {
  const byDay = new Map();
  state.tasks.forEach(t => {
    if (!t.completed || !t.completedAt) return;
    const key = toISODate(new Date(t.completedAt));
    byDay.set(key, (byDay.get(key) || 0) + 1);
  });

  const today = todayISO();
  const weekStart = daysFromToday(-6);
  let week = 0;
  let total = 0;
  byDay.forEach((n, key) => {
    total += n;
    if (key >= weekStart && key <= today) week += n;
  });

  // Current streak: consecutive days with a completion, ending today (or
  // yesterday, so the streak does not break before the first task of the day).
  let streak = 0;
  let cursor = byDay.has(today) ? today : prevDayISO(today);
  while (byDay.has(cursor)) {
    streak++;
    cursor = prevDayISO(cursor);
  }

  // Best streak: the longest run of consecutive days ever.
  const sorted = [...byDay.keys()].sort();
  let best = 0;
  let run = 0;
  let previous = null;
  sorted.forEach(key => {
    run = (previous && prevDayISO(key) === previous) ? run + 1 : 1;
    if (run > best) best = run;
    previous = key;
  });

  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const iso = daysFromToday(-i);
    series.push({
      iso,
      n: byDay.get(iso) || 0,
      label: new Intl.DateTimeFormat('en', { weekday: 'narrow' }).format(parseDate(iso)),
    });
  }

  return {
    byDay, today: byDay.get(today) || 0, week, streak, best, total,
    days: series,
    max: Math.max(1, ...series.map(d => d.n)),
  };
}

function renderKarma() {
  const box = $('#karma-view');
  const s = karmaSummary();
  box.innerHTML = `
    <div class="karma-cards">
      <div class="karma-card"><div class="karma-num">${s.today}</div><div class="karma-label">Completed today</div></div>
      <div class="karma-card"><div class="karma-num">${s.week}</div><div class="karma-label">Last 7 days</div></div>
      <div class="karma-card"><div class="karma-num">${s.streak}</div><div class="karma-label">Day streak</div></div>
      <div class="karma-card"><div class="karma-num">${s.best}</div><div class="karma-label">Best streak</div></div>
      <div class="karma-card"><div class="karma-num">${s.total}</div><div class="karma-label">All time</div></div>
    </div>
    <div class="karma-heading">Last 14 days</div>
    <div class="karma-chart">
      ${s.days.map(d => `
        <div class="karma-col" title="${escapeHtml(d.iso)}: ${d.n} completed">
          <div class="karma-bar${d.n ? '' : ' empty'}" style="height:${Math.max(2, Math.round((d.n / s.max) * 100))}%"></div>
          <span class="karma-day">${escapeHtml(d.label)}</span>
        </div>`).join('')}
    </div>`;
}

/* ============================================================
   SETTINGS
============================================================ */
const DEFAULT_SETTINGS = {
  theme: 'system',
  startOfWeek: 'mon',
  defaultPriority: null,
  defaultReminder: null,
};
let settings = { ...DEFAULT_SETTINGS };

const SETTINGS_DEFS = [
  { key: 'theme', label: 'Theme', options: [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']] },
  { key: 'startOfWeek', label: 'Week starts on', options: [['mon', 'Monday'], ['sun', 'Sunday']] },
  { key: 'defaultPriority', label: 'Default priority', options: [[null, 'None'], [1, 'P1'], [2, 'P2'], [3, 'P3'], [4, 'P4']] },
  {
    key: 'defaultReminder',
    label: 'Default reminder',
    options: [[null, 'None'], [0, 'At due time'], [10, '10 min before'], [30, '30 min before'], [60, '1 hour before'], [120, '2 hours before'], [1440, '1 day before']],
  },
];

async function loadSettings() {
  const raw = await store.getDoc(store.keys.settings);
  if (!raw || typeof raw !== 'object') {
    settings = { ...DEFAULT_SETTINGS };
    return;
  }
  settings = {
    theme: ['light', 'dark', 'system'].includes(raw.theme) ? raw.theme : DEFAULT_SETTINGS.theme,
    startOfWeek: ['mon', 'sun'].includes(raw.startOfWeek) ? raw.startOfWeek : DEFAULT_SETTINGS.startOfWeek,
    defaultPriority: [1, 2, 3, 4].includes(raw.defaultPriority) ? raw.defaultPriority : null,
    defaultReminder: raw.defaultReminder === null || raw.defaultReminder === undefined
      ? null
      : Number(raw.defaultReminder),
  };
}

function persistSettings() {
  store.setDoc(store.keys.settings, settings).catch(err => console.error('Could not save settings:', err));
}

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const theme = settings.theme === 'system' ? (darkMedia.matches ? 'dark' : 'light') : settings.theme;
  document.documentElement.dataset.theme = theme;
}

if (darkMedia.addEventListener) darkMedia.addEventListener('change', applyTheme);
else if (darkMedia.addListener) darkMedia.addListener(applyTheme); // older Safari

const settingsModal = $('#settings-modal');

function renderSettings() {
  $('#settings-body').innerHTML = SETTINGS_DEFS.map(def => `
    <div class="mb-4">
      <div class="text-xs text-td-muted mb-1">${escapeHtml(def.label)}</div>
      <div class="flex flex-wrap gap-1">
        ${def.options.map(([value, label]) => {
          const raw = value === null ? 'null' : String(value);
          const active = String(settings[def.key] ?? 'null') === raw;
          return `<button type="button" class="qa-pick" data-setting="${def.key}" data-value="${escapeHtml(raw)}" aria-pressed="${active}">${escapeHtml(label)}</button>`;
        }).join('')}
      </div>
    </div>`).join('');
}

$('#settings-body').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-setting]');
  if (!btn) return;
  const key = btn.dataset.setting;
  const raw = btn.dataset.value;
  const def = SETTINGS_DEFS.find(d => d.key === key);
  const option = def && def.options.find(([value]) => (value === null ? 'null' : String(value)) === raw);
  if (!option) return;
  settings[key] = option[0];
  persistSettings();
  applyTheme();
  renderSettings();
  render();
});

$('#settings-btn').onclick = () => {
  renderSettings();
  if (!settingsModal.open) settingsModal.showModal();
};
$('#settings-close').onclick = () => settingsModal.close();

/* ============================================================
   SORTING
============================================================ */
const SORT_OPTIONS = [
  { id: 'manual', label: 'Manual order' },
  { id: 'date', label: 'Due date' },
  { id: 'priority', label: 'Priority' },
  { id: 'name', label: 'Name (A–Z)' },
  { id: 'added', label: 'Date added' },
];

function sortTasks(tasks) {
  const sort = state.ui.sort || 'manual';
  const arr = [...tasks];
  if (sort === 'date') {
    arr.sort((a, b) => dueSortValue(a) - dueSortValue(b) || a.order - b.order);
  } else if (sort === 'priority') {
    arr.sort((a, b) => (a.priority - b.priority) || (a.order - b.order));
  } else if (sort === 'name') {
    arr.sort((a, b) => a.title.localeCompare(b.title) || (a.order - b.order));
  } else if (sort === 'added') {
    arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } else {
    arr.sort((a, b) => a.order - b.order);
  }
  return arr;
}

/* ============================================================
   ROUTING / VIEW LOGIC
============================================================ */
function getViewInfo() {
  const v = state.ui.view;
  const search = (state.ui.search || '').trim().toLowerCase();

  let title = 'Inbox', icon = 'inbox', subtitle = '', filter = () => true;

  if (search) {
    title = `Search: "${state.ui.search}"`;
    icon = 'search';
    subtitle = '';
    const match = queryMatcher(state.ui.search);
    filter = (t) => match(t);
  } else if (v.startsWith('filter:')) {
    const id = v.slice(7);
    const saved = savedFilters.find(f => f.id === id);
    title = saved ? saved.name : 'Filter';
    icon = 'filter';
    subtitle = saved ? saved.query : '';
    const match = saved ? queryMatcher(saved.query) : () => false;
    filter = (t) => match(t);
  } else if (v === 'inbox') {
    title = 'Inbox'; icon = 'inbox';
    subtitle = 'Tasks with no project';
    filter = (t) => !t.projectId;
  } else if (v === 'today') {
    title = 'Today'; icon = 'calendar-days';
    subtitle = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
    filter = (t) => t.due === todayISO() || isTaskOverdue(t);
  } else if (v === 'upcoming') {
    title = 'Upcoming'; icon = 'calendar';
    subtitle = '';
    filter = (t) => !!t.due;
  } else if (v === 'calendar') {
    title = 'Calendar'; icon = 'calendar-days';
    subtitle = '';
    filter = (t) => !!t.due;
  } else if (v === 'karma') {
    title = 'Karma'; icon = 'trophy';
    subtitle = 'Your productivity at a glance';
    filter = () => true;
  } else if (v === 'completed') {
    title = 'Completed'; icon = 'circle-check-big';
    subtitle = '';
    filter = (t) => !!t.completed;
  } else if (v === 'no-date') {
    title = 'No date'; icon = 'calendar-x';
    subtitle = 'Tasks without a due date';
    filter = (t) => !t.due;
  } else if (v === 'no-priority') {
    title = 'No priority'; icon = 'flag-off';
    subtitle = 'Tasks still at Priority 4';
    filter = (t) => t.priority === 4;
  } else if (v.startsWith('project:')) {
    const id = v.split(':')[1];
    const proj = state.projects.find(p => p.id === id);
    title = proj ? proj.name : 'Project';
    icon = 'hash';
    subtitle = '';
    filter = (t) => t.projectId === id;
  } else if (v.startsWith('label:')) {
    const id = v.split(':')[1];
    const lbl = state.labels.find(l => l.id === id);
    title = lbl ? `@${lbl.name}` : 'Label';
    icon = 'tag';
    subtitle = '';
    filter = (t) => (t.labels || []).includes(id);
  }
  return { title, icon, subtitle, filter };
}

/* ============================================================
   RENDERING
============================================================ */
function render() {
  renderSidebar();
  renderMain();
  renderStorageBadge();
  lucide.createIcons();
}

function renderSidebar() {
  // counts
  const inboxCount = state.tasks.filter(t => !t.parentId && !t.projectId && !t.completed).length;
  const todayCount = state.tasks.filter(t => !t.parentId && !t.completed && (t.due === todayISO() || isTaskOverdue(t))).length;
  const completedCount = state.tasks.filter(t => t.completed).length;
  const noDateCount = state.tasks.filter(t => !t.parentId && !t.completed && !t.due).length;
  const noPriorityCount = state.tasks.filter(t => !t.parentId && !t.completed && t.priority === 4).length;
  $('[data-view="inbox"] .nav-count').textContent = inboxCount || '';
  $('[data-view="today"] .nav-count').textContent = todayCount || '';
  $('[data-view="completed"] .nav-count').textContent = completedCount || '';
  $('[data-view="no-date"] .nav-count').textContent = noDateCount || '';
  $('[data-view="no-priority"] .nav-count').textContent = noPriorityCount || '';

  // active nav
  $$('.nav-item').forEach(el => {
    const isActive = el.dataset.view && el.dataset.view === state.ui.view;
    el.classList.toggle('bg-red-50', isActive);
    el.classList.toggle('text-td-red', isActive);
    el.classList.toggle('font-medium', isActive);
  });

  // projects (pinned first, stable among the rest)
  const pl = $('#projects-list');
  pl.innerHTML = [...state.projects]
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    .map(p => {
      const count = state.tasks.filter(t => !t.parentId && !t.completed && t.projectId === p.id).length;
      const active = state.ui.view === `project:${p.id}`;
      return `
      <div class="group relative" data-entry-id="${escapeHtml(p.id)}">
        <a href="#" data-view="project:${p.id}" title="${escapeHtml(p.name)}" class="nav-item flex items-center gap-2 px-2 py-1.5 pr-12 rounded hover:bg-gray-200/60 text-sm ${active ? 'bg-red-50 text-td-red font-medium' : ''}">
          <i data-lucide="hash" class="w-4 h-4 flex-shrink-0" style="color:${p.color}"></i>
          <span class="sidebar-hide truncate flex-1">${escapeHtml(p.name)}</span>
          ${p.pinned ? '<i data-lucide="star" class="sidebar-hide w-3 h-3 flex-shrink-0 text-amber-500" fill="currentColor" title="Pinned"></i>' : ''}
          <span class="sidebar-hide text-xs text-td-muted">${count || ''}</span>
        </a>
        <button type="button" class="project-quick-add sidebar-hide absolute right-7 top-1/2 -translate-y-1/2 p-0.5 rounded text-td-muted opacity-100 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 pointer-events-auto md:pointer-events-none md:group-hover:pointer-events-auto hover:text-td-text"
          data-project-id="${p.id}" title="Add task to ${escapeHtml(p.name)}" aria-label="Add task to ${escapeHtml(p.name)}">
          <i data-lucide="plus" class="w-3.5 h-3.5"></i>
        </button>
        <button type="button" class="sidebar-hide row-menu-btn absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-td-muted opacity-100 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 pointer-events-auto md:pointer-events-none md:group-hover:pointer-events-auto hover:text-td-text"
          data-menu-type="project" data-menu-id="${p.id}" title="Project actions" aria-label="Project actions">
          <i data-lucide="more-horizontal" class="w-4 h-4"></i>
        </button>
      </div>`;
    }).join('');

  // saved filters
  const fl = $('#filters-list');
  fl.innerHTML = savedFilters.map(f => {
    const count = filterTaskCount(f.query);
    const active = state.ui.view === `filter:${f.id}`;
    return `
    <div class="group relative">
      <a href="#" data-view="filter:${escapeHtml(f.id)}" title="${escapeHtml(f.query)}" class="nav-item flex items-center gap-2 px-2 py-1.5 pr-6 rounded hover:bg-gray-200/60 text-sm ${active ? 'bg-red-50 text-td-red font-medium' : ''}">
        <i data-lucide="filter" class="w-4 h-4 flex-shrink-0 text-td-muted"></i>
        <span class="sidebar-hide truncate flex-1">${escapeHtml(f.name)}</span>
        <span class="sidebar-hide text-xs text-td-muted">${count || ''}</span>
      </a>
      <button type="button" class="sidebar-hide row-menu-btn absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-td-muted opacity-100 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 pointer-events-auto md:pointer-events-none md:group-hover:pointer-events-auto hover:text-td-text"
        data-menu-type="filter" data-menu-id="${escapeHtml(f.id)}" title="Filter actions" aria-label="Filter actions">
        <i data-lucide="more-horizontal" class="w-4 h-4"></i>
      </button>
    </div>`;
  }).join('');

  // labels (pinned first)
  const ll = $('#labels-list');
  ll.innerHTML = [...state.labels]
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    .map(l => {
      const active = state.ui.view === `label:${l.id}`;
      return `
      <div class="group relative" data-entry-id="${escapeHtml(l.id)}">
        <a href="#" data-view="label:${l.id}" title="@${escapeHtml(l.name)}" class="nav-item flex items-center gap-2 px-2 py-1.5 pr-6 rounded hover:bg-gray-200/60 text-sm ${active ? 'bg-red-50 text-td-red font-medium' : ''}">
          <i data-lucide="tag" class="w-4 h-4 flex-shrink-0" style="color:${l.color}"></i>
          <span class="sidebar-hide truncate flex-1">@${escapeHtml(l.name)}</span>
          ${l.pinned ? '<i data-lucide="star" class="sidebar-hide w-3 h-3 flex-shrink-0 text-amber-500" fill="currentColor" title="Pinned"></i>' : ''}
        </a>
        <button type="button" class="sidebar-hide row-menu-btn absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-td-muted opacity-100 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 pointer-events-auto md:pointer-events-none md:group-hover:pointer-events-auto hover:text-td-text"
          data-menu-type="label" data-menu-id="${l.id}" title="Label actions" aria-label="Label actions">
          <i data-lucide="more-horizontal" class="w-4 h-4"></i>
        </button>
      </div>`;
    }).join('');

  $$('.row-menu-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openRowMenu(btn, btn.dataset.menuType, btn.dataset.menuId);
    };
  });

  $$('.project-quick-add').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigateTo(`project:${btn.dataset.projectId}`);
      closeMobileSidebar();
      openQuickAdd();
    };
  });

  bindSidebarSortables();
}

/** Lets projects and labels be dragged into a new order. */
function bindSidebarSortables() {
  [['#projects-list', 'projects'], ['#labels-list', 'labels']].forEach(([sel, kind]) => {
    const el = $(sel);
    if (!el) return;
    if (el._sortable) { el._sortable.destroy(); el._sortable = null; }
    el._sortable = new Sortable(el, {
      animation: 150,
      handle: '.nav-item',
      filter: 'button',
      onEnd: () => {
        const ids = $$(`${sel} > div`).map(d => d.dataset.entryId).filter(Boolean);
        const list = kind === 'projects' ? state.projects : state.labels;
        const byId = new Map(list.map(x => [x.id, x]));
        const next = ids.map(i => byId.get(i)).filter(Boolean);
        list.forEach(x => { if (!ids.includes(x.id)) next.push(x); });
        if (kind === 'projects') state.projects = next;
        else state.labels = next;
        saveState();
        render();
      },
    });
  });
}

/* Copy and artwork for an empty list, per view. */
const EMPTY_STATES = {
  inbox: { title: 'Nothing in your inbox', text: 'Tasks you add without a project land here.', icon: 'inbox' },
  today: { title: 'Nothing due today', text: 'You are all caught up for today.', icon: 'calendar-check' },
  upcoming: { title: 'Nothing coming up', text: 'Tasks with a due date will appear here.', icon: 'calendar' },
  completed: { title: 'No completed tasks yet', text: 'Finished tasks appear here, ready to restore.', icon: 'circle-check-big' },
  'no-date': { title: 'Everything has a date', text: 'No undated tasks right now.', icon: 'calendar-x' },
  'no-priority': { title: 'Every task has a priority', text: 'No P4 tasks right now.', icon: 'flag' },
  project: { title: 'No tasks in this project', text: 'Add a task to get started.', icon: 'hash' },
  label: { title: 'No tasks with this label', text: 'Tasks with this label will show up here.', icon: 'tag' },
  filter: { title: 'No matches', text: 'This filter matches nothing right now.', icon: 'filter' },
  search: { title: 'No matches', text: 'Try a different word or clear the search.', icon: 'search' },
};

function currentEmptyState() {
  const view = state.ui.view;
  if ((state.ui.search || '').trim()) return EMPTY_STATES.search;
  if (view.startsWith('project:')) return EMPTY_STATES.project;
  if (view.startsWith('label:')) return EMPTY_STATES.label;
  if (view.startsWith('filter:')) return EMPTY_STATES.filter;
  return EMPTY_STATES[view] || { title: 'All clear', text: 'Add your first task to get started.', icon: 'clipboard-check' };
}

function showEmptyState(title, text, showCta = true) {
  const preset = currentEmptyState();
  $('#empty-state').classList.remove('hidden');
  $('#empty-title').textContent = title || preset.title;
  $('#empty-text').textContent = text || preset.text;
  $('#empty-cta').classList.toggle('hidden', !showCta);
  const card = $('#empty-illustration-card');
  if (card) {
    card.innerHTML = `<i data-lucide="${preset.icon}" class="w-7 h-7"></i>`;
    lucide.createIcons();
  }
}

function renderMain() {
  const info = getViewInfo();
  $('#view-title-text').textContent = info.title;
  $('#view-icon').setAttribute('data-lucide', info.icon);
  $('#view-subtitle').textContent = info.subtitle;
  updateLayoutToggle();

  const list = $('#task-list');
  const board = $('#board-view');
  const searchActive = !!(state.ui.search || '').trim();

  // Reset whichever content mode was shown last.
  list.classList.remove('hidden');
  list.innerHTML = '';
  destroyBoardSortables();
  board.classList.add('hidden');
  board.innerHTML = '';
  $('#calendar-view').classList.add('hidden');
  $('#calendar-view').innerHTML = '';
  $('#karma-view').classList.add('hidden');
  $('#karma-view').innerHTML = '';
  $('#empty-state').classList.add('hidden');
  $('#content-container').classList.remove('board-mode');
  $('#content-container').classList.remove('calendar-mode');

  // Upcoming gets day buckets instead of one flat list (no drag reorder).
  if (state.ui.view === 'upcoming' && !searchActive) {
    renderUpcoming(list);
    return;
  }
  if (state.ui.view === 'calendar' && !searchActive) {
    list.classList.add('hidden');
    $('#calendar-view').classList.remove('hidden');
    $('#content-container').classList.add('calendar-mode');
    renderCalendar();
    return;
  }
  if (state.ui.view === 'karma' && !searchActive) {
    list.classList.add('hidden');
    $('#karma-view').classList.remove('hidden');
    renderKarma();
    return;
  }
  if (state.ui.view === 'completed' && !searchActive) {
    renderCompleted(list);
    return;
  }
  // Today keeps overdue tasks separate from today's own list, so it is
  // grouped (and not drag-ordered) like Upcoming.
  if (state.ui.view === 'today' && !searchActive && state.ui.layout !== 'board') {
    renderToday(list);
    return;
  }
  if (!searchActive && state.ui.layout === 'board' && supportsBoard()) {
    renderBoard(info);
    return;
  }

  // A project with sections groups its tasks under section headers.
  if (state.ui.view.startsWith('project:') && !searchActive) {
    const proj = state.projects.find(p => p.id === state.ui.view.slice(8));
    if (proj && Array.isArray(proj.sections) && proj.sections.length) {
      renderProjectSectionsView(list);
      return;
    }
  }

  // Normal list views hide completed tasks; the Completed view is their home.
  // Completed matches sort last but keep the chosen order otherwise.
  const visible = sortTasks(
    activeTasks()
      .filter(info.filter)
      .filter(t => searchActive || !t.completed)
  ).sort((a, b) => a.completed - b.completed);
  if (!visible.length) {
    // Each view brings its own copy and artwork.
    if (state.ui.search) showEmptyState('', '', false);
    else showEmptyState();
    return;
  }

  list.innerHTML = visible.map(t => renderTaskRow(t, false)).join('');
  bindTaskEvents(true);
}

/** Shows the list/board switch only where a board makes sense. */
function updateLayoutToggle() {
  const wrap = $('#view-layout');
  const show = supportsBoard();
  wrap.classList.toggle('hidden', !show);
  if (!show) return;
  $$('#view-layout [data-layout]').forEach(btn => {
    const active = btn.dataset.layout === (state.ui.layout === 'board' ? 'board' : 'list');
    btn.classList.toggle('layout-btn-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

/** Upcoming: Overdue first, then one section per calendar day. */
function upcomingGroups() {
  const today = todayISO();
  const tomorrowDate = parseDate(today);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = toISODate(tomorrowDate);

  const tasks = activeTasks()
    .filter(t => t.due && !t.completed)
    .sort((a, b) => dueSortValue(a) - dueSortValue(b) || a.order - b.order);

  const groups = [];
  const overdue = tasks.filter(t => t.due < today);
  if (overdue.length) groups.push({ key: 'overdue', label: 'Overdue', tasks: overdue });

  const byDay = new Map();
  tasks.filter(t => t.due >= today).forEach(t => {
    if (!byDay.has(t.due)) byDay.set(t.due, []);
    byDay.get(t.due).push(t);
  });

  [...byDay.keys()].sort().forEach(day => {
    const label = day === today ? 'Today'
      : day === tomorrow ? 'Tomorrow'
      : new Intl.DateTimeFormat('en', { weekday: 'long', month: 'short', day: 'numeric' }).format(parseDate(day));
    groups.push({ key: day, label, tasks: byDay.get(day) });
  });
  return groups;
}

function renderUpcoming(list) {
  const groups = upcomingGroups();
  if (!groups.length) {
    list.innerHTML = '';
    showEmptyState();
    return;
  }
  $('#empty-state').classList.add('hidden');
  list.innerHTML = groups.map(g => `
    <li class="day-group-header" data-day-group="${g.key}">
      <span>${escapeHtml(g.label)}</span>
      <span class="text-td-muted font-normal">${g.tasks.length}</span>
    </li>
    ${g.tasks.map(t => renderTaskRow(t, false)).join('')}
  `).join('');
  // Grouped order is date order, so drag reordering is disabled here.
  bindTaskEvents(false);
}

/**
 * Today: overdue work first (its own group), then the tasks due today.
 * A task due earlier today counts as overdue once its time has passed.
 */
function todayGroups() {
  const today = todayISO();
  const tasks = activeTasks()
    .filter(t => t.due && !t.completed)
    .filter(t => t.due === today || isTaskOverdue(t))
    .sort((a, b) => dueSortValue(a) - dueSortValue(b) || a.order - b.order);

  const groups = [];
  const overdue = tasks.filter(t => isTaskOverdue(t));
  if (overdue.length) groups.push({ key: 'overdue', label: 'Overdue', tasks: overdue });

  const dueToday = tasks.filter(t => !isTaskOverdue(t));
  if (dueToday.length) groups.push({ key: 'today', label: '', tasks: dueToday });
  return groups;
}

function renderToday(list) {
  const groups = todayGroups();
  if (!groups.length) {
    list.innerHTML = '';
    showEmptyState();
    return;
  }
  $('#empty-state').classList.add('hidden');
  list.innerHTML = groups.map(g => `
    ${g.label ? `
    <li class="day-group-header" data-day-group="${g.key}">
      <span>${escapeHtml(g.label)}</span>
      <span class="text-td-muted font-normal">${g.tasks.length}</span>
    </li>` : ''}
    ${g.tasks.map(t => renderTaskRow(t, false)).join('')}
  `).join('');
  // Grouped order is date order, so drag reordering is disabled here.
  bindTaskEvents(false);
}

/** A project with sections groups its tasks under section headers. */
function renderProjectSectionsView(list) {
  const projId = state.ui.view.slice(8);
  const proj = state.projects.find(p => p.id === projId);
  const sections = proj && Array.isArray(proj.sections) ? proj.sections : [];
  const tasks = activeTasks()
    .filter(t => t.projectId === projId && !t.completed)
    .sort((a, b) => a.order - b.order);

  const groups = sections
    .map(s => ({ key: s.id, label: s.name, tasks: tasks.filter(t => t.sectionId === s.id) }))
    .filter(g => g.tasks.length);
  const ungrouped = tasks.filter(t => !t.sectionId || !sections.some(s => s.id === t.sectionId));
  if (ungrouped.length) groups.push({ key: '', label: 'No section', tasks: ungrouped });

  if (!groups.length) {
    list.innerHTML = '';
    showEmptyState();
    return;
  }
  $('#empty-state').classList.add('hidden');
  list.innerHTML = groups.map(g => `
    <li class="day-group-header" data-day-group="${escapeHtml(g.key)}">
      <span>${escapeHtml(g.label)}</span>
      <span class="text-td-muted font-normal">${g.tasks.length}</span>
    </li>
    ${g.tasks.map(t => renderTaskRow(t, false)).join('')}`).join('');
  bindTaskEvents(false);
}

/** "Earlier" covers completed tasks from older data with no timestamp. */
function completionDayKey(ts) {
  return ts ? toISODate(new Date(ts)) : 'earlier';
}

function completionDayLabel(key) {
  if (key === 'earlier') return 'Earlier';
  const today = parseDate(todayISO());
  const day = parseDate(key);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const opts = { weekday: 'long', month: 'short', day: 'numeric' };
  if (day.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return new Intl.DateTimeFormat('en', opts).format(day);
}

/** Completed: newest first, one section per completion day, subtasks included. */
function renderCompleted(list) {
  const tasks = completedTasks();
  if (!tasks.length) {
    showEmptyState('', '', false);
    return;
  }
  $('#empty-state').classList.add('hidden');

  const groups = new Map();
  tasks.forEach(t => {
    const key = completionDayKey(t.completedAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === 'earlier') return 1;
    if (b === 'earlier') return -1;
    return b.localeCompare(a);
  });

  list.innerHTML = keys.map(key => `
    <li class="day-group-header" data-day-group="${key}">
      <span>${escapeHtml(completionDayLabel(key))}</span>
      <span class="text-td-muted font-normal">${groups.get(key).length}</span>
    </li>
    ${groups.get(key).map(t => renderTaskRow(t, !!t.parentId, {
      parentTitle: t.parentId ? state.tasks.find(p => p.id === t.parentId)?.title : '',
      noSubtasks: true,
    })).join('')}
  `).join('');
  // Completion dates define the order, so drag reordering is disabled here.
  bindTaskEvents(false);
}

const BOARD_PRIORITIES = [1, 2, 3, 4];

function renderBoard(info) {
  const list = $('#task-list');
  const board = $('#board-view');
  list.classList.add('hidden');
  list.innerHTML = '';
  board.classList.remove('hidden');
  $('#content-container').classList.add('board-mode');

  const base = activeTasks().filter(info.filter).filter(t => !t.completed);
  board.innerHTML = `<div class="board-scroll"><div class="board-grid">` + BOARD_PRIORITIES.map(priority => {
    const tasks = base
      .filter(t => t.priority === priority)
      .sort((a, b) => a.order - b.order);
    return `
      <section class="board-column" data-priority="${priority}">
        <header class="board-column-header">
          <span class="flex items-center gap-1.5 text-sm font-semibold">
            <i data-lucide="flag" class="w-3.5 h-3.5" style="color:${priorityColor(priority)}"></i>
            P${priority}
          </span>
          <span class="board-count text-xs text-td-muted" title="${tasks.length} tasks">${tasks.length}</span>
        </header>
        <ul class="board-cards" data-priority="${priority}" aria-label="${escapeHtml(priorityLabel(priority))}">
          ${tasks.map(t => renderBoardCard(t)).join('')}
        </ul>
      </section>`;
  }).join('') + `</div></div>` + `<div class="board-scroll-hint" aria-hidden="true"><i data-lucide="move-right" class="w-3.5 h-3.5"></i>Scroll for more</div>`;
  $('#empty-state').classList.add('hidden');

  bindTaskEvents(false);
  bindBoardSortables();
  updateBoardOverflowHint();
}

function renderBoardCard(t) {
  const dueBadge = t.due ? `
    <span class="flex items-center gap-1 ${isTaskOverdue(t) ? 'text-red-600' : t.due === todayISO() ? 'text-green-700' : 'text-td-muted'}">
      <i data-lucide="calendar" class="w-3 h-3"></i>${escapeHtml(formatDue(t.due, t.dueTime))}
      ${t.recurrence ? '<i data-lucide="repeat" class="w-3 h-3 ml-0.5"></i>' : ''}
    </span>` : '';
  const projBadge = t.projectId ? `
    <span class="flex items-center gap-1 text-td-muted">
      <i data-lucide="hash" class="w-3 h-3" style="color:${state.projects.find(p=>p.id===t.projectId)?.color || '#999'}"></i>${escapeHtml(projectName(t.projectId))}
    </span>` : '';
  const labelBadges = (t.labels || []).map(lid => {
    const l = state.labels.find(x => x.id === lid);
    if (!l) return '';
    return `<span class="flex items-center gap-0.5 text-td-muted"><i data-lucide="tag" class="w-3 h-3" style="color:${l.color}"></i>@${escapeHtml(l.name)}</span>`;
  }).join('');

  return `
    <li class="board-card group" data-task-id="${t.id}">
      <div class="flex items-start gap-2 p-2.5">
        <button class="task-check mt-0.5 flex-shrink-0 w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center"
          style="border-color:${priorityColor(t.priority)}" title="Complete task">
        </button>
        <div class="flex-1 min-w-0">
          <div class="task-title cursor-pointer text-sm font-medium" tabindex="0">${priorityMarker(t.priority)}${highlightHtml(t.title, searchTerm())}</div>
          ${t.description ? `<div class="text-xs text-td-muted mt-0.5 truncate-2">${highlightHtml(t.description, searchTerm())}</div>` : ''}
          <div class="flex flex-wrap items-center gap-2 text-xs mt-1">
            ${dueBadge}${durationBadge(t)}${projBadge}${labelBadges}
          </div>
        </div>
        <div class="task-actions flex items-center gap-0.5">
          <button class="task-edit text-td-muted hover:text-td-text p-1" title="Edit">
            <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
          </button>
          <button class="task-delete text-td-muted hover:text-red-600 p-1" title="Delete">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </div>
    </li>`;
}

/** One Sortable group; dropping into a column rewrites the task's priority. */
function destroyBoardSortables() {
  $$('.board-cards').forEach(el => {
    if (el._sortable) { el._sortable.destroy(); el._sortable = null; }
  });
}

function bindBoardSortables() {
  const board = $('#board-view');
  if (!board) return;
  destroyBoardSortables();
  $$('.board-cards', board).forEach(el => {
    el._sortable = new Sortable(el, {
      group: 'board-tasks',
      animation: 150,
      handle: '.board-card',
      filter: 'button',
      ghostClass: 'board-card-ghost',
      onEnd: (evt) => {
        const taskId = evt.item && evt.item.dataset ? evt.item.dataset.taskId : null;
        const task = state.tasks.find(x => x.id === taskId);
        const to = evt.to;
        if (!task || !to) return;
        const column = to.closest ? to.closest('.board-column') : null;
        const priority = Number((column && column.dataset.priority) || to.dataset.priority);
        if (priority >= 1 && priority <= 4) task.priority = priority;

        let order = 0;
        $$('.board-cards .board-card', board).forEach(card => {
          const t = state.tasks.find(x => x.id === card.dataset.taskId);
          if (t) t.order = order++;
        });
        saveState();
        updateBoardCounts();
      },
    });
  });
}

/** Shows a "scroll for more" hint while board columns are off-screen. */
function updateBoardOverflowHint() {
  const view = $('#board-view');
  if (!view) return;
  const scroller = view.querySelector('.board-scroll');
  if (!scroller) {
    view.classList.remove('board-overflow');
    return;
  }
  const overflowing = scroller.scrollWidth > scroller.clientWidth + 1;
  const atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 2;
  view.classList.toggle('board-overflow', overflowing && !atEnd);
}

$('#board-view').addEventListener('scroll', updateBoardOverflowHint, true);
window.addEventListener('resize', updateBoardOverflowHint);

function updateBoardCounts() {
  $$('.board-column').forEach(col => {
    const count = col.querySelectorAll('.board-card').length;
    const badge = col.querySelector('.board-count');
    if (badge) {
      badge.textContent = String(count);
      badge.title = `${count} tasks`;
    }
  });
}

function renderTaskRow(t, isSub, opts = {}) {
  // Sub-tasks can nest, so children are rendered at every level.
  const subs = opts.noSubtasks ? [] : subtasksOf(t.id);
  const parentBadge = opts.parentTitle ? `
    <span class="flex items-center gap-1 text-td-muted">
      <i data-lucide="corner-down-right" class="w-3 h-3"></i>${escapeHtml(opts.parentTitle)}
    </span>` : '';
  const dueBadge = t.due ? `
    <span class="flex items-center gap-1 ${isTaskOverdue(t) ? 'text-red-600' : t.due === todayISO() ? 'text-green-700' : 'text-td-muted'}">
      <i data-lucide="calendar" class="w-3 h-3"></i>${escapeHtml(formatDue(t.due, t.dueTime))}
      ${t.recurrence ? '<i data-lucide="repeat" class="w-3 h-3 ml-0.5"></i>' : ''}
      ${t.reminderMinutes !== null && t.reminderMinutes !== undefined ? '<i data-lucide="bell" class="w-3 h-3 ml-0.5"></i>' : ''}
    </span>` : '';
  const projBadge = t.projectId ? `
    <span class="flex items-center gap-1 text-td-muted">
      <i data-lucide="hash" class="w-3 h-3" style="color:${state.projects.find(p=>p.id===t.projectId)?.color || '#999'}"></i>${escapeHtml(projectName(t.projectId))}
    </span>` : '';
  const labelBadges = (t.labels || []).map(lid => {
    const l = state.labels.find(x => x.id === lid);
    if (!l) return '';
    return `<span class="flex items-center gap-0.5 text-td-muted"><i data-lucide="tag" class="w-3 h-3" style="color:${l.color}"></i>@${escapeHtml(l.name)}</span>`;
  }).join('');

  const checkColor = priorityColor(t.priority);
  const completedClass = t.completed ? 'line-through text-td-muted' : '';

  return `
    <li class="task-row group" data-task-id="${t.id}">
      <div class="flex items-start gap-2 py-2 px-1 border-b border-gray-100 hover:bg-gray-50 rounded">
        <button class="task-check mt-0.5 flex-shrink-0 w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center"
          style="border-color:${t.completed ? '#808080' : checkColor}; ${t.completed ? 'background:#808080;' : ''}"
          title="${t.completed ? 'Reopen task' : 'Complete task'} · ${priorityLabel(t.priority)}"
          aria-label="${t.completed ? 'Reopen task' : 'Complete task'} · ${priorityLabel(t.priority)}">
          ${t.completed ? '<i data-lucide="check" class="w-3 h-3 text-white"></i>' : ''}
        </button>
        <div class="task-content flex-1 min-w-0">
          <div class="task-title cursor-pointer text-sm ${completedClass}" tabindex="0">${priorityMarker(t.priority)}${highlightHtml(t.title, searchTerm())}</div>
          ${t.description ? `<div class="text-xs text-td-muted mt-0.5 truncate-2">${highlightHtml(t.description, searchTerm())}</div>` : ''}
          <div class="flex flex-wrap items-center gap-2 text-xs mt-1">
            ${parentBadge}${dueBadge}${durationBadge(t)}${projBadge}${labelBadges}
            ${(t.attachments || []).length ? `<span class="flex items-center gap-1 text-td-muted"><i data-lucide="paperclip" class="w-3 h-3"></i>${t.attachments.length}</span>` : ''}
          </div>
          ${subs.length ? `<ul class="mt-1.5 space-y-0.5 pl-3 border-l-2 border-gray-100">
            ${subs.map(s => renderTaskRow(s, true)).join('')}
          </ul>` : ''}
        </div>
        <div class="task-actions flex items-center gap-0.5">
          <button class="task-edit text-td-muted hover:text-td-text p-1" title="Edit">
            <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
          </button>
          ${!isSub ? `<button class="task-addsub text-td-muted hover:text-td-text p-1" title="Add subtask">
            <i data-lucide="git-branch-plus" class="w-3.5 h-3.5"></i>
          </button>` : ''}
          <button class="task-delete text-td-muted hover:text-red-600 p-1" title="Delete">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </div>
    </li>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/** The term the user is currently searching for (empty when not searching). */
function searchTerm() {
  return (state.ui.search || '').trim();
}

/**
 * Escapes text and wraps every occurrence of the current search term in
 * <mark>, so matches stand out in the result list.
 */
function highlightHtml(text, term) {
  const safe = escapeHtml(text);
  const needle = escapeHtml((term || '').trim());
  if (!needle) return safe;
  try {
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return safe.replace(re, (m) => `<mark class="search-hit">${m}</mark>`);
  } catch {
    return safe;
  }
}

/* ============================================================
   TASK CONTEXT MENU (right click)
============================================================ */
const contextMenu = $('#context-menu');
let contextTaskId = null;

function closeContextMenu() {
  contextTaskId = null;
  contextMenu.classList.add('hidden');
  contextMenu.innerHTML = '';
}

/** Keeps the menu inside the viewport, opening upward when needed. */
function positionContextMenu(x, y) {
  const margin = 8;
  const rect = contextMenu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = x;
  if (left + rect.width > vw - margin) left = vw - rect.width - margin;
  left = Math.max(margin, left);

  const spaceBelow = vh - margin - y;
  const spaceAbove = y - margin;
  let top;
  if (rect.height <= spaceBelow) top = y;
  else if (rect.height <= spaceAbove) top = y - rect.height;
  else top = Math.max(margin, Math.min(y, vh - rect.height - margin));

  contextMenu.style.left = `${Math.round(left)}px`;
  contextMenu.style.top = `${Math.round(Math.max(margin, top))}px`;
}

function openContextMenu(taskId, x, y) {
  const t = state.tasks.find(task => task.id === taskId);
  if (!t) return;
  contextTaskId = taskId;

  const items = [];
  const sep = () => items.push({ sep: true });
  const header = (label) => items.push({ header: label });
  const item = (action, label, icon, extra = {}) => items.push({ action, label, icon, ...extra });

  item('complete', t.completed ? 'Reopen task' : 'Complete task', t.completed ? 'rotate-ccw' : 'circle-check');
  sep();

  header('Reschedule');
  item('due-today', 'Today', 'calendar');
  item('due-tomorrow', 'Tomorrow', 'calendar');
  item('due-next-week', 'Next week', 'calendar');
  item('due-none', 'No date', 'calendar-x');
  sep();

  header('Priority');
  [1, 2, 3, 4].forEach(p => {
    item(`priority-${p}`, `Priority ${p}`, 'flag', { checked: t.priority === p, color: priorityColor(p) });
  });
  sep();

  const projects = state.projects.slice(0, 8);
  if (projects.length) {
    header('Move to project');
    item('project-none', 'No project', 'hash', { checked: !t.projectId });
    projects.forEach(p => {
      item(`project-${p.id}`, p.name, 'hash', { checked: t.projectId === p.id, color: p.color });
    });
    sep();
  }

  const labels = state.labels.slice(0, 8);
  if (labels.length) {
    header('Labels');
    item('label-none', 'Clear labels', 'tag', { checked: !(t.labels || []).length });
    labels.forEach(l => {
      item(`label-${l.id}`, `@${l.name}`, 'tag', { checked: (t.labels || []).includes(l.id), color: l.color });
    });
    sep();
  }

  item('edit', 'Edit task', 'pencil');
  item('delete', 'Delete task', 'trash-2', { danger: true });

  contextMenu.innerHTML = items.map(it => {
    if (it.sep) return '<div class="context-sep"></div>';
    if (it.header) return `<div class="context-label">${escapeHtml(it.label)}</div>`;
    const iconStyle = it.color ? ` style="color:${escapeHtml(it.color)}"` : '';
    return `<button type="button" class="context-item${it.danger ? ' danger' : ''}" data-context-action="${escapeHtml(it.action)}">
      <i data-lucide="${it.icon}" class="w-3.5 h-3.5 flex-shrink-0"${it.color ? iconStyle : ' style="color:#808080"'}></i>
      <span class="flex-1 truncate text-left">${escapeHtml(it.label)}</span>
      ${it.checked ? '<i data-lucide="check" class="w-3.5 h-3.5 flex-shrink-0"></i>' : ''}
    </button>`;
  }).join('');

  contextMenu.classList.remove('hidden');
  lucide.createIcons();
  positionContextMenu(x, y);
}

/** Applies a context-menu action to a task. */
function runContextAction(action, id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;

  if (action === 'complete') { toggleComplete(id); return; }
  if (action === 'edit') { openTaskModal(id); return; }
  if (action === 'delete') { deleteTask(id); return; }

  if (action.startsWith('priority-')) {
    const p = Number(action.slice('priority-'.length));
    if (!Number.isInteger(p) || p < 1 || p > 4) return;
    t.priority = p;
    saveState();
    render();
    showToast(`Priority ${p}`, 'info');
    return;
  }

  if (action.startsWith('label-')) {
    const labelId = action.slice('label-'.length);
    const current = t.labels || [];
    const next = labelId === 'none'
      ? []
      : (current.includes(labelId) ? current.filter(x => x !== labelId) : [...current, labelId]);
    if (next.length === current.length) return;
    const snapshot = snapshotData();
    t.labels = next;
    saveState();
    render();
    offerUndo(next.length ? `Label @${labelName(labelId)} added` : 'Label removed', snapshot);
    return;
  }

  if (action.startsWith('project-')) {
    const projectId = action.slice('project-'.length);
    const next = projectId === 'none' ? null : projectId;
    if (next && !state.projects.some(p => p.id === next)) return;
    if (t.projectId === next) return;
    const snapshot = snapshotData();
    t.projectId = next;
    saveState();
    render();
    offerUndo(next ? `Moved to ${projectName(next)}` : 'Removed from project', snapshot);
    return;
  }

  if (action.startsWith('due-')) {
    const snapshot = snapshotData();
    const d = new Date();
    if (action === 'due-today') t.due = todayISO();
    else if (action === 'due-tomorrow') { d.setDate(d.getDate() + 1); t.due = toISODate(d); }
    else if (action === 'due-next-week') { d.setDate(d.getDate() + 7); t.due = toISODate(d); }
    else if (action === 'due-none') {
      t.due = null;
      t.dueTime = null;
      t.recurrence = null;
      t.reminderFiredKey = null;
    } else {
      return;
    }
    t.reminderFiredKey = null;
    saveState();
    render();
    offerUndo(t.due ? `Moved to ${formatDue(t.due, t.dueTime)}` : 'Date removed', snapshot);
  }
}

contextMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-context-action]');
  if (!btn) return;
  e.stopPropagation();
  const id = contextTaskId;
  const action = btn.dataset.contextAction;
  closeContextMenu();
  if (id) runContextAction(action, id);
});

document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('[data-task-id]');
  if (!row) return;
  e.preventDefault();
  closeRowMenu();
  const x = e.clientX;
  const y = e.clientY;
  // Deferred so the click that may follow a right-click cannot close it.
  setTimeout(() => openContextMenu(row.dataset.taskId, x, y), 0);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#context-menu')) closeContextMenu();
});

window.addEventListener('scroll', closeContextMenu, true);
window.addEventListener('resize', closeContextMenu);

/* ============================================================
   BULK SELECTION
   Ctrl/Cmd-click toggles a task, Shift-click selects a range.
============================================================ */
const selection = new Set();
let lastSelectedId = null;

function visibleTaskIds() {
  return $$('#task-list > li[data-task-id]').map(li => li.dataset.taskId);
}

function selectTask(id, e) {
  if (!state.tasks.some(t => t.id === id)) return;
  if (e.shiftKey && lastSelectedId) {
    const ids = visibleTaskIds();
    const from = ids.indexOf(lastSelectedId);
    const to = ids.indexOf(id);
    if (from >= 0 && to >= 0) {
      const [a, b] = from < to ? [from, to] : [to, from];
      for (let i = a; i <= b; i++) selection.add(ids[i]);
    }
  } else if (selection.has(id)) {
    selection.delete(id);
  } else {
    selection.add(id);
  }
  lastSelectedId = id;
  renderSelection();
}

function clearSelection() {
  selection.clear();
  lastSelectedId = null;
  renderSelection();
}

function renderSelection() {
  // Forget tasks that no longer exist.
  for (const id of [...selection]) {
    if (!state.tasks.some(t => t.id === id)) selection.delete(id);
  }
  $$('#task-list > li[data-task-id]').forEach(li => {
    li.classList.toggle('selected', selection.has(li.dataset.taskId));
  });

  const bar = $('#batch-bar');
  const count = selection.size;
  bar.classList.toggle('hidden', count === 0);
  if (!count) return;
  $('#batch-count').textContent = `${count} selected`;

  const tasks = state.tasks.filter(t => selection.has(t.id));
  const allDone = tasks.length > 0 && tasks.every(t => t.completed);
  $('#batch-complete').textContent = allDone ? 'Reopen' : 'Complete';
}

function batchRun(mutate, label) {
  const ids = [...selection];
  if (!ids.length) return;
  const snapshot = snapshotData();
  ids.forEach(mutate);
  saveState();
  render();
  clearSelection();
  offerUndo(label, snapshot);
}

function batchComplete() {
  const tasks = state.tasks.filter(t => selection.has(t.id));
  const allDone = tasks.length > 0 && tasks.every(t => t.completed);
  batchRun((id) => {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    t.completed = !allDone;
    t.completedAt = allDone ? null : Date.now();
    subtasksOf(t.id).forEach(s => {
      s.completed = !allDone;
      s.completedAt = allDone ? null : Date.now();
    });
  }, allDone ? 'Tasks reopened' : 'Tasks completed');
}

function batchDelete() {
  batchRun((id) => {
    state.tasks = state.tasks.filter(x => x.id !== id && x.parentId !== id);
  }, 'Tasks deleted');
}

function batchPriority(p) {
  batchRun((id) => {
    const t = state.tasks.find(x => x.id === id);
    if (t) t.priority = p;
  }, `Priority set to P${p}`);
}

function batchProject(projectId) {
  batchRun((id) => {
    const t = state.tasks.find(x => x.id === id);
    if (t) t.projectId = projectId || null;
  }, projectId ? `Moved to ${projectName(projectId)}` : 'Removed from project');
}

$('#batch-complete').onclick = () => batchComplete();
$('#batch-delete').onclick = () => batchDelete();
$('#batch-clear').onclick = () => clearSelection();
$('#batch-select-all').onclick = () => {
  visibleTaskIds().forEach(id => selection.add(id));
  renderSelection();
};

$('#batch-priority').onclick = (e) => {
  e.stopPropagation();
  const menu = $('#batch-priority-menu');
  const tasks = state.tasks.filter(t => selection.has(t.id));
  const current = tasks.length && tasks.every(t => t.priority === 1) ? 1 : null;
  menu.innerHTML = [1, 2, 3, 4].map(p => `
    <button type="button" class="batch-menu-item" data-batch-priority="${p}" aria-pressed="${current === p}">P${p}</button>`).join('');
  menu.classList.remove('hidden');
};

$('#batch-project').onclick = (e) => {
  e.stopPropagation();
  const menu = $('#batch-project-menu');
  const tasks = state.tasks.filter(t => selection.has(t.id));
  const current = tasks.length && tasks.every(t => t.projectId === 'none') ? 'none' : null;
  menu.innerHTML = `
    <button type="button" class="batch-menu-item" data-batch-project="none" aria-pressed="${current === 'none'}">No project</button>
    ${state.projects.map(p => `
      <button type="button" class="batch-menu-item" data-batch-project="${escapeHtml(p.id)}" aria-pressed="${tasks.length > 0 && tasks.every(t => t.projectId === p.id)}">
        <span style="color:${escapeHtml(p.color)}">#</span>${escapeHtml(p.name)}
      </button>`).join('')}`;
  menu.classList.remove('hidden');
};

$('#batch-priority-menu').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-batch-priority]');
  if (!btn) return;
  $('#batch-priority-menu').classList.add('hidden');
  batchPriority(Number(btn.dataset.batchPriority));
});

$('#batch-project-menu').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-batch-project]');
  if (!btn) return;
  $('#batch-project-menu').classList.add('hidden');
  const id = btn.dataset.batchProject;
  batchProject(id === 'none' ? null : id);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#batch-priority-menu') && !e.target.closest('#batch-priority')) {
    $('#batch-priority-menu').classList.add('hidden');
  }
  if (!e.target.closest('#batch-project-menu') && !e.target.closest('#batch-project')) {
    $('#batch-project-menu').classList.add('hidden');
  }
});

/* ============================================================
   TASK ROW EVENTS
============================================================ */
/** Adds a subtask with an inline input (no browser prompt). */
function openInlineSubtask(parentId) {
  const row = document.querySelector(`[data-task-id="${parentId}"]`);
  if (!row) return;
  const content = row.querySelector('.task-content');
  if (!content) return;

  const existing = content.querySelector('.subtask-inline-editor');
  if (existing) { existing.querySelector('input').focus(); return; }
  $$('.subtask-inline-editor').forEach(el => el.remove());

  const editor = document.createElement('div');
  editor.className = 'subtask-inline-editor flex items-center gap-2 mt-2 pl-1';

  const icon = document.createElement('i');
  icon.setAttribute('data-lucide', 'git-branch-plus');
  icon.className = 'w-3.5 h-3.5 text-td-muted';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'subtask-inline-input flex-1 text-sm border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30';
  input.placeholder = 'Subtask name';

  editor.appendChild(icon);
  editor.appendChild(input);
  content.appendChild(editor);
  lucide.createIcons();

  let settled = false;
  const close = () => { settled = true; editor.remove(); };
  const commit = () => {
    if (settled) return;
    const title = input.value.trim();
    close();
    if (!title) return;
    addTask({ title, parentId });
    // Keep the flow going: show a fresh inline input for the next subtask.
    openInlineSubtask(parentId);
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  input.addEventListener('blur', () => { if (!settled) close(); });

  input.focus();
}

/** Clicking a task title edits it in place; the pencil still opens the modal. */
function openInlineTitle(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  const row = document.querySelector(`[data-task-id="${taskId}"]`);
  if (!task || !row) return;
  const titleEl = row.querySelector('.task-title');
  if (!titleEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = task.title;
  input.className = 'task-title-inline w-full text-sm font-medium border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30';
  input.setAttribute('aria-label', 'Task title');
  titleEl.replaceWith(input);

  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    const title = input.value.trim();
    if (title && title !== task.title) {
      task.title = title;
      saveState();
    }
    render();
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    render();
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Escape') { event.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', () => { if (!settled) commit(); });

  input.focus();
  input.select();
}

function bindTaskEvents(sortable = true) {
  renderSelection();
  $$('.task-check').forEach(btn => {
    btn.onclick = (e) => {
      const id = e.currentTarget.closest('[data-task-id]').dataset.taskId;
      const task = state.tasks.find(t => t.id === id);
      if (!task) return;
      if (task.completed) {
        toggleComplete(id);
        return;
      }
      if (btn._busy) return;
      // Give the check a visible pop before a completed task disappears.
      btn._busy = true;
      btn.classList.add('task-check-pop');
      setTimeout(() => toggleComplete(id), 110);
    };
  });
  $$('.task-title').forEach(el => {
    el.onclick = (e) => {
      const id = e.currentTarget.closest('[data-task-id]').dataset.taskId;
      // Ctrl/Cmd/Shift-click selects instead of editing.
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        selectTask(id, e);
        return;
      }
      openInlineTitle(id);
    };
    // Keyboard equivalent: Enter edits, Space completes.
    el.onkeydown = (e) => {
      const id = el.closest('[data-task-id]').dataset.taskId;
      if (e.key === 'Enter') {
        e.preventDefault();
        openInlineTitle(id);
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        if (state.tasks.some(t => t.id === id)) toggleComplete(id);
      }
    };
  });
  $$('.task-row').forEach(row => {
    row.onclick = (e) => {
      if (e.target.closest('button')) return;
      if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
      e.preventDefault();
      e.stopPropagation();
      selectTask(row.dataset.taskId, e);
    };
  });
  $$('.task-edit').forEach(el => {
    el.onclick = (e) => {
      const id = e.currentTarget.closest('[data-task-id]').dataset.taskId;
      openTaskModal(id);
    };
  });
  $$('.task-delete').forEach(el => {
    el.onclick = (e) => {
      const id = e.currentTarget.closest('[data-task-id]').dataset.taskId;
      deleteTask(id);
    };
  });
  $$('.task-addsub').forEach(el => {
    el.onclick = (e) => {
      const id = e.currentTarget.closest('[data-task-id]').dataset.taskId;
      openInlineSubtask(id);
    };
  });

  // drag reorder (top-level only)
  const list = $('#task-list');
  if (list._sortable) { list._sortable.destroy(); list._sortable = null; }
  if (!sortable) return;
  list._sortable = new Sortable(list, {
    animation: 150,
    handle: '.task-row',
    filter: 'button',
    onEnd: () => {
      const ids = $$('#task-list > li').map(li => li.dataset.taskId);
      ids.forEach((id, i) => {
        const t = state.tasks.find(x => x.id === id);
        if (t) t.order = i;
      });
      saveState();
    }
  });
}

/* ============================================================
   TASK MUTATIONS
============================================================ */
function nextOrder() {
  const top = activeTasks();
  return top.length ? Math.max(...top.map(t => t.order || 0)) + 1 : 0;
}

function addTask(data) {
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
  render();
  return task;
}

function toggleComplete(id) {
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
      render();
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
  render();
  offerUndo(t.completed ? 'Task completed' : 'Task reopened', snapshot);
}

/** Deletes a task (and its subtasks) without confirming. Returns success. */
function removeTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return false;
  const snapshot = snapshotData();
  state.tasks = state.tasks.filter(x => x.id !== id && x.parentId !== id);
  saveState();
  render();
  offerUndo('Task deleted', snapshot);
  return true;
}

function deleteTask(id) {
  // No confirmation dialog: deletion is immediate and undoable from the toast.
  return removeTask(id);
}

/* ============================================================
   TASK MODAL
============================================================ */
let editingTaskId = null;
let modalDraft = null;

const modal = $('#task-modal');
const priorityMenu = $('#priority-menu');
const projectMenu = $('#project-menu');
const labelMenu = $('#label-menu');

/* ---------- Task modal: attachments ---------- */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// Blobs added in this dialog but not saved are cleaned up when it closes.
const pendingAttachments = new Set();

function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function renderModalAttachments() {
  const list = (modalDraft && Array.isArray(modalDraft.attachments)) ? modalDraft.attachments : [];
  $('#modal-attachments').classList.toggle('hidden', !list.length && !editingTaskId);
  $('#modal-attachment-list').innerHTML = list.map(a => `
    <li class="flex items-center gap-2 text-xs">
      <i data-lucide="paperclip" class="w-3 h-3 text-td-muted flex-shrink-0"></i>
      <button type="button" class="flex-1 text-left truncate hover:underline" data-attachment-open="${escapeHtml(a.id)}" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</button>
      <span class="text-td-muted flex-shrink-0">${formatFileSize(a.size)}</span>
      <button type="button" class="text-td-muted hover:text-red-600 flex-shrink-0" data-attachment-remove="${escapeHtml(a.id)}" title="Remove attachment" aria-label="Remove attachment">
        <i data-lucide="x" class="w-3 h-3"></i>
      </button>
    </li>`).join('');
  lucide.createIcons();
}

$('#modal-attachment-add').onclick = () => $('#modal-attachment-input').click();

$('#modal-attachment-input').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length || !modalDraft) return;

  if (!Array.isArray(modalDraft.attachments)) modalDraft.attachments = [];
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      showToast(`${file.name} is larger than 25 MB`, 'error');
      continue;
    }
    const id = uid();
    try {
      await store.putBlob(id, file);
    } catch (err) {
      showToast(`Could not store ${file.name}`, 'error');
      continue;
    }
    pendingAttachments.add(id);
    modalDraft.attachments.push({
      id,
      name: file.name,
      type: file.type,
      size: file.size,
      addedAt: Date.now(),
    });
  }
  renderModalAttachments();
});

$('#modal-attachment-list').addEventListener('click', async (e) => {
  const openBtn = e.target.closest('[data-attachment-open]');
  if (openBtn) {
    const id = openBtn.dataset.attachmentOpen;
    try {
      const blob = await store.getBlob(id);
      if (!blob) { showToast('That file is no longer stored', 'error'); return; }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = (modalDraft.attachments.find(a => a.id === id) || {}).name || 'file';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      showToast('Could not open that file', 'error');
    }
    return;
  }

  const removeBtn = e.target.closest('[data-attachment-remove]');
  if (!removeBtn) return;
  const id = removeBtn.dataset.attachmentRemove;
  modalDraft.attachments = (modalDraft.attachments || []).filter(a => a.id !== id);
  pendingAttachments.add(id);
  store.deleteBlob(id).catch(() => {});
  renderModalAttachments();
});

function openTaskModal(id) {
  editingTaskId = id;
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  // The collections are copied so editing the draft never touches the task
  // until it is saved.
  modalDraft = {
    ...t,
    labels: [...(t.labels || [])],
    comments: [...(t.comments || [])],
    attachments: [...(t.attachments || [])],
  };

  $('#modal-title').value = t.title;
  $('#modal-desc').value = t.description || '';
  $('#modal-duration').value = t.durationMinutes || '';
  updateModalChips();
  renderPriorityMenu();
  renderProjectMenu();
  renderLabelMenu();
  renderModalComments();
  renderModalSections();
  renderModalAttachments();
  modal.showModal();
  // Don't open the on-screen keyboard on phones: it would cover the dialog.
  if (!isMobileSidebar()) setTimeout(() => $('#modal-title').focus(), 50);
}

/* ---------- Task modal: comments and sections ---------- */
function renderModalComments() {
  const list = (modalDraft && Array.isArray(modalDraft.comments)) ? modalDraft.comments : [];
  $('#modal-comments').classList.remove('hidden');
  $('#modal-comment-list').innerHTML = list.map(c => `
    <li class="flex items-start gap-2 text-xs">
      <span class="flex-1">${escapeHtml(c.text)}</span>
      <button type="button" class="text-td-muted hover:text-red-600" data-comment-remove="${escapeHtml(c.id)}" title="Delete comment" aria-label="Delete comment">
        <i data-lucide="x" class="w-3 h-3"></i>
      </button>
    </li>`).join('');
  lucide.createIcons();
}

function renderModalSections() {
  const wrap = $('#modal-section-wrap');
  const select = $('#modal-section');
  const t = modalDraft || {};
  const proj = state.projects.find(p => p.id === t.projectId);
  const sections = proj && Array.isArray(proj.sections) ? proj.sections : [];
  wrap.style.display = sections.length ? '' : 'none';
  select.innerHTML = `<option value="">No section</option>${
    sections.map(s => `<option value="${escapeHtml(s.id)}" ${t.sectionId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}`;
}

$('#modal-section').onchange = (e) => {
  modalDraft.sectionId = e.target.value || null;
};

$('#modal-comment-add').onclick = () => {
  const input = $('#modal-comment-input');
  const text = input.value.trim();
  if (!text) return;
  if (!Array.isArray(modalDraft.comments)) modalDraft.comments = [];
  modalDraft.comments.push({ id: uid(), text, createdAt: Date.now() });
  input.value = '';
  renderModalComments();
};

$('#modal-comment-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#modal-comment-add').click(); }
});

$('#modal-comment-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-comment-remove]');
  if (!btn) return;
  modalDraft.comments = (modalDraft.comments || []).filter(c => c.id !== btn.dataset.commentRemove);
  renderModalComments();
});

function updateModalChips() {
  const t = modalDraft;
  // due
  $('#meta-due-text').textContent = t.due ? `${formatDue(t.due, t.dueTime)}${t.recurrence ? ' ↻' : ''}` : 'Due date';
  $('#meta-due').classList.toggle('text-td-red', !!t.due);
  // priority
  $('#meta-priority-text').textContent = priorityLabel(t.priority);
  $('#meta-priority-icon').style.color = priorityColor(t.priority);
  $('#meta-priority-icon').setAttribute('fill', t.priority < 4 ? priorityColor(t.priority) : 'none');
  // project
  $('#meta-project-text').textContent = t.projectId ? projectName(t.projectId) : 'Project';
  // labels
  const names = (t.labels || []).map(labelName).filter(Boolean);
  $('#meta-label-text').textContent = names.length ? names.map(n => '@' + n).join(', ') : 'Labels';
}

function renderPriorityMenu() {
  const opts = [1,2,3,4];
  priorityMenu.innerHTML = opts.map(p => `
    <button type="button" data-p="${p}" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2">
      <i data-lucide="flag" class="w-3.5 h-3.5" style="color:${priorityColor(p)}"></i>
      ${priorityLabel(p)}
    </button>`).join('');
  priorityMenu.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      modalDraft.priority = +b.dataset.p;
      updateModalChips();
      priorityMenu.classList.add('hidden');
      lucide.createIcons();
    };
  });
  lucide.createIcons();
}

function renderProjectMenu() {
  const opts = [{ id: null, name: 'No project', color: '#999' }, ...state.projects];
  projectMenu.innerHTML = opts.map(p => `
    <button type="button" data-id="${p.id ?? ''}" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2">
      <i data-lucide="hash" class="w-3.5 h-3.5" style="color:${p.color}"></i>
      ${escapeHtml(p.name)}
    </button>`).join('');
  projectMenu.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      modalDraft.projectId = b.dataset.id || null;
      // The section list belongs to the project, so it changes with it.
      modalDraft.sectionId = null;
      updateModalChips();
      renderModalSections();
      projectMenu.classList.add('hidden');
      lucide.createIcons();
    };
  });
  lucide.createIcons();
}

function renderLabelMenu() {
  if (!state.labels.length) {
    labelMenu.innerHTML = `<div class="px-3 py-2 text-td-muted text-xs">No labels yet</div>`;
    return;
  }
  labelMenu.innerHTML = state.labels.map(l => {
    const checked = (modalDraft.labels || []).includes(l.id);
    return `
      <button type="button" data-id="${l.id}" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2">
        <span class="w-3.5 h-3.5 flex items-center justify-center">${checked ? '<i data-lucide="check" class="w-3 h-3"></i>' : ''}</span>
        <i data-lucide="tag" class="w-3.5 h-3.5" style="color:${l.color}"></i>
        @${escapeHtml(l.name)}
      </button>`;
  }).join('');
  labelMenu.querySelectorAll('button').forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = b.dataset.id;
      const arr = modalDraft.labels || [];
      modalDraft.labels = arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id];
      renderLabelMenu();
      updateModalChips();
      labelMenu.classList.remove('hidden');
    };
  });
  lucide.createIcons();
}

// ---------- Due date dialog (Flatpickr + natural language) ----------
const dueModal = $('#due-modal');
const dueNlInput = $('#due-nl');
const dueNlStatus = $('#due-nl-status');
const dueTimeInput = $('#due-time');
const dueAllDayInput = $('#due-allday');
const dueRepeatInput = $('#due-repeat');
const dueRepeatStatus = $('#due-repeat-status');
const dueReminderSelect = null; // replaced by the multi-reminder list
const dueRemindersBox = $('#due-reminders');
const dueRepeatEndBox = $('#due-repeat-end');
const dueRepeatEndMode = $('#due-repeat-end-mode');
const dueRepeatEndCount = $('#due-repeat-end-count');
const dueRepeatEndUntil = $('#due-repeat-end-until');
const dueRepeatEndUnit = $('#due-repeat-end-unit');

const REMINDER_OPTIONS = [
  [0, 'At time of due date'],
  [10, '10 minutes before'],
  [30, '30 minutes before'],
  [60, '1 hour before'],
  [120, '2 hours before'],
  [1440, '1 day before'],
];

/** The reminders of a task, tolerating the old single-reminder shape. */
function taskReminders(t) {
  if (!t) return [];
  if (Array.isArray(t.reminders) && t.reminders.length) {
    return t.reminders.filter(r => r && cleanReminderMinutes(r.minutes) !== null);
  }
  if (t.reminderMinutes !== null && t.reminderMinutes !== undefined) {
    return [{ id: 'legacy', minutes: t.reminderMinutes }];
  }
  return [];
}

function setDraftReminders(list) {
  if (!modalDraft) return;
  modalDraft.reminders = list;
  // The first reminder stays the "primary" one for the scheduler.
  modalDraft.reminderMinutes = list.length ? list[0].minutes : null;
}

function renderDueReminders() {
  const list = taskReminders(modalDraft);
  dueRemindersBox.innerHTML = list.length ? list.map(r => `
    <div class="flex items-center gap-1" data-reminder-id="${escapeHtml(r.id)}">
      <select class="flex-1 text-xs border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30" data-reminder-minutes aria-label="Reminder">
        ${REMINDER_OPTIONS.map(([v, l]) => `<option value="${v}" ${Number(r.minutes) === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <button type="button" class="text-td-muted hover:text-red-600 p-1" data-reminder-remove title="Remove reminder" aria-label="Remove reminder">
        <i data-lucide="x" class="w-3.5 h-3.5"></i>
      </button>
    </div>`).join('')
    : '<div class="text-[11px] text-td-muted">No reminders.</div>';
  lucide.createIcons();
}

/* ---------- Repeat end conditions (COUNT / UNTIL) ---------- */
function recurrenceBase(body) {
  return String(body || '').split(';').filter(p => p && !/^(COUNT|UNTIL)=/i.test(p)).join(';');
}

function recurrenceEndFromBody(body) {
  const c = /COUNT=(\d+)/i.exec(body || '');
  const u = /UNTIL=([0-9]{8})/i.exec(body || '');
  return {
    count: c ? Number(c[1]) : null,
    until: u ? `${u[1].slice(0, 4)}-${u[1].slice(4, 6)}-${u[1].slice(6, 8)}` : null,
  };
}

function recurrenceWithEnd(body, end) {
  const base = recurrenceBase(body);
  if (!base) return null;
  const parts = [base];
  if (end && end.count) parts.push(`COUNT=${end.count}`);
  else if (end && end.until) parts.push(`UNTIL=${end.until.replace(/-/g, '')}T235959Z`);
  return parts.join(';');
}

function syncDueRepeatEnd() {
  const body = modalDraft ? modalDraft.recurrence : null;
  if (!body) {
    dueRepeatEndBox.classList.add('hidden');
    return;
  }
  dueRepeatEndBox.classList.remove('hidden');
  const end = recurrenceEndFromBody(body);
  dueRepeatEndMode.value = end.count ? 'count' : end.until ? 'until' : 'never';
  dueRepeatEndCount.value = end.count || '';
  dueRepeatEndUntil.value = end.until || '';
  const mode = dueRepeatEndMode.value;
  dueRepeatEndCount.classList.toggle('hidden', mode !== 'count');
  dueRepeatEndUnit.classList.toggle('hidden', mode !== 'count');
  dueRepeatEndUntil.classList.toggle('hidden', mode !== 'until');
}

function applyDueRepeatEnd() {
  if (!modalDraft) return;
  const mode = dueRepeatEndMode.value;
  const end = mode === 'count'
    ? { count: Math.max(1, Math.min(999, Number(dueRepeatEndCount.value) || 1)) }
    : mode === 'until' && dueRepeatEndUntil.value
      ? { until: dueRepeatEndUntil.value }
      : null;
  const body = recurrenceWithEnd(modalDraft.recurrence, end);
  modalDraft.recurrence = body ? cleanRecurrence(body) : null;
  dueRepeatInput.value = modalDraft.recurrence ? recurrenceToText(modalDraft.recurrence) : '';
  syncDueRepeatEnd();
  updateModalChips();
}

dueRepeatEndMode.addEventListener('change', applyDueRepeatEnd);
dueRepeatEndCount.addEventListener('change', applyDueRepeatEnd);
dueRepeatEndUntil.addEventListener('change', applyDueRepeatEnd);

dueRemindersBox.addEventListener('change', (e) => {
  const select = e.target.closest('[data-reminder-minutes]');
  if (!select) return;
  const row = select.closest('[data-reminder-id]');
  const list = taskReminders(modalDraft).map(r => (r.id === row.dataset.reminderId
    ? { ...r, minutes: Number(select.value) }
    : r));
  setDraftReminders(list);
});

dueRemindersBox.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-reminder-remove]');
  if (!btn) return;
  const row = btn.closest('[data-reminder-id]');
  setDraftReminders(taskReminders(modalDraft).filter(r => r.id !== row.dataset.reminderId));
  renderDueReminders();
  updateModalChips();
});

$('#due-add-reminder').onclick = () => {
  const list = taskReminders(modalDraft);
  list.push({ id: uid(), minutes: 30 });
  setDraftReminders(list);
  renderDueReminders();
  updateModalChips();
};

let dueCalendar = null;
let dueCalendarSyncing = false;
let dueEditorSnapshot = null;
let dueEditorCommitted = false;

function setDueNlStatus(text, tone) {
  dueNlStatus.textContent = text || '';
  dueNlStatus.className = `text-[11px] mb-3 min-h-[16px] ${
    tone === 'error' ? 'text-red-600' : tone === 'ok' ? 'text-green-700' : 'text-td-muted'
  }`;
}

/** Keeps the calendar and the natural-language field in step with the draft. */
function syncDueDateControls() {
  const t = modalDraft || {};
  if (dueCalendar) {
    dueCalendarSyncing = true;
    if (t.due) {
      dueCalendar.setDate(t.due, false);
      dueCalendar.jumpToDate(parseDate(t.due), false);
    } else {
      dueCalendar.clear();
    }
    dueCalendarSyncing = false;
  }
  dueNlInput.value = t.due ? formatDue(t.due, t.dueTime) : '';
  setDueNlStatus(t.due ? `Selected: ${formatDue(t.due, t.dueTime)}` : 'No due date selected');
}

function syncDueEditor() {
  const t = modalDraft || {};
  dueTimeInput.value = t.dueTime || '';
  dueAllDayInput.checked = !t.dueTime;
  dueTimeInput.disabled = !t.dueTime;
  dueRepeatInput.value = t.recurrence ? recurrenceToText(t.recurrence) : '';
  dueRepeatStatus.textContent = '';
  dueRepeatStatus.className = 'text-[11px] mt-0.5 min-h-[14px] text-td-muted';
  setDraftReminders(taskReminders(t));
  renderDueReminders();
  syncDueRepeatEnd();
  syncDueDateControls();
}

function setDueDate(iso) {
  modalDraft.due = iso || null;
  if (!iso) {
    modalDraft.dueTime = null;
    modalDraft.recurrence = null;
    setDraftReminders([]);
  }
  syncDueEditor();
  updateModalChips();
}

/** Parses “tomorrow”, “next Friday”, “Jan 5 at 4pm” … */
function applyNaturalDue(raw) {
  const text = (raw || '').trim();
  if (!text) {
    setDueNlStatus('');
    return false;
  }
  if (!window.chrono) {
    setDueNlStatus('Natural language dates are unavailable.', 'error');
    return false;
  }

  const results = window.chrono.parse(text, new Date(), { forwardDate: true });
  if (!results.length) {
    setDueNlStatus('Could not find a date in that phrase.', 'error');
    return false;
  }

  const start = results[0].start;
  const date = start.date();
  const hasTime = start.isCertain('hour') || start.isCertain('minute');

  modalDraft.due = toISODate(date);
  if (hasTime) {
    modalDraft.dueTime = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  syncDueEditor();
  setDueNlStatus(`Due ${formatDue(modalDraft.due, modalDraft.dueTime)}`, 'ok');
  updateModalChips();
  return true;
}

function initDueCalendar() {
  if (dueCalendar || typeof window.flatpickr === 'undefined') return;
  dueCalendar = window.flatpickr('#due-calendar', {
    inline: true,
    dateFormat: 'Y-m-d',
    defaultDate: null,
    onChange: (dates, dateStr) => {
      if (dueCalendarSyncing || !modalDraft) return;
      modalDraft.due = dateStr || null;
      if (!dateStr) {
        modalDraft.dueTime = null;
        modalDraft.recurrence = null;
        setDraftReminders([]);
        dueTimeInput.value = '';
        dueAllDayInput.checked = true;
        dueTimeInput.disabled = true;
        dueRepeatInput.value = '';
        renderDueReminders();
        syncDueRepeatEnd();
      }
      dueNlInput.value = dateStr ? formatDue(dateStr, modalDraft.dueTime) : '';
      setDueNlStatus(dateStr ? `Selected: ${formatDue(dateStr, modalDraft.dueTime)}` : 'No due date selected');
      updateModalChips();
    },
  });
}

function openDueEditor() {
  if (!modalDraft || dueModal.open) return;
  dueEditorSnapshot = {
    due: modalDraft.due,
    dueTime: modalDraft.dueTime,
    recurrence: modalDraft.recurrence,
    reminders: taskReminders(modalDraft).map(r => ({ ...r })),
    reminderMinutes: modalDraft.reminderMinutes,
  };
  dueEditorCommitted = false;
  dueModal.showModal();
  initDueCalendar();
  syncDueEditor();
  if (!isMobileSidebar()) {
    dueNlInput.focus();
    const end = dueNlInput.value.length;
    dueNlInput.setSelectionRange(end, end);
  }
}

function parseDueRepeatField() {
  const raw = dueRepeatInput.value.trim();
  if (!raw) {
    modalDraft.recurrence = null;
    dueRepeatStatus.textContent = '';
    syncDueRepeatEnd();
    return true;
  }
  const body = parseRecurrenceText(raw);
  if (!body) {
    dueRepeatStatus.textContent = 'Not sure what that means — try “every Monday”.';
    dueRepeatStatus.className = 'text-[11px] mt-0.5 min-h-[14px] text-red-600';
    return false;
  }
  // Keep any end condition the user already chose.
  modalDraft.recurrence = recurrenceWithEnd(body, recurrenceEndFromBody(modalDraft.recurrence));
  if (!modalDraft.due) setDueDate(todayISO());
  dueRepeatInput.value = modalDraft.recurrence ? recurrenceToText(modalDraft.recurrence) : '';
  dueRepeatStatus.textContent = `Repeats: ${recurrenceToText(modalDraft.recurrence)}`;
  dueRepeatStatus.className = 'text-[11px] mt-0.5 min-h-[14px] text-green-700';
  syncDueRepeatEnd();
  return true;
}

function commitDueEdits() {
  if (!modalDraft) return false;
  if (dueModal.open && !parseDueRepeatField()) return false;
  if (!modalDraft.due) {
    modalDraft.dueTime = null;
    modalDraft.recurrence = null;
    setDraftReminders([]);
  }
  updateModalChips();
  return true;
}

$('#meta-due').onclick = (e) => {
  e.stopPropagation();
  priorityMenu.classList.add('hidden');
  projectMenu.classList.add('hidden');
  labelMenu.classList.add('hidden');
  openDueEditor();
};

dueNlInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  applyNaturalDue(dueNlInput.value);
});
dueNlInput.addEventListener('change', () => {
  if (dueNlInput.value.trim()) applyNaturalDue(dueNlInput.value);
});
dueAllDayInput.addEventListener('change', () => {
  if (dueAllDayInput.checked) {
    modalDraft.dueTime = null;
    dueTimeInput.value = '';
    dueTimeInput.disabled = true;
  } else {
    dueTimeInput.disabled = false;
    if (!dueTimeInput.value) dueTimeInput.value = '09:00';
    modalDraft.dueTime = dueTimeInput.value;
  }
  dueNlInput.value = modalDraft.due ? formatDue(modalDraft.due, modalDraft.dueTime) : '';
  updateModalChips();
});
dueTimeInput.addEventListener('change', () => {
  if (!dueTimeInput.value) {
    dueAllDayInput.checked = true;
    modalDraft.dueTime = null;
  } else {
    modalDraft.dueTime = dueTimeInput.value;
  }
  dueNlInput.value = modalDraft.due ? formatDue(modalDraft.due, modalDraft.dueTime) : '';
  updateModalChips();
});
dueRepeatInput.addEventListener('input', () => {
  dueRepeatStatus.textContent = '';
});
dueRepeatInput.addEventListener('change', parseDueRepeatField);
dueRepeatInput.addEventListener('blur', parseDueRepeatField);

dueRemindersBox.addEventListener('change', (e) => {
  if (e.target.closest('[data-reminder-minutes]')) ensureNotificationPermission();
});

$$('[data-due-preset]').forEach(btn => {
  btn.onclick = (e) => {
    e.stopPropagation();
    const d = new Date();
    if (btn.dataset.duePreset === 'tomorrow') d.setDate(d.getDate() + 1);
    if (btn.dataset.duePreset === 'next-week') d.setDate(d.getDate() + 7);
    setDueDate(toISODate(d));
  };
});

$('#due-clear').onclick = (e) => {
  e.stopPropagation();
  setDueDate(null);
};

$('#due-done').onclick = (e) => {
  e.stopPropagation();
  if (!parseDueRepeatField()) {
    dueRepeatInput.focus();
    return;
  }
  dueEditorCommitted = true;
  dueModal.close();
};

$('#due-cancel').onclick = () => dueModal.close();
$('#due-close').onclick = () => dueModal.close();

dueModal.addEventListener('close', () => {
  if (!dueEditorCommitted && dueEditorSnapshot && modalDraft) {
    modalDraft.due = dueEditorSnapshot.due;
    modalDraft.dueTime = dueEditorSnapshot.dueTime;
    modalDraft.recurrence = dueEditorSnapshot.recurrence;
    setDraftReminders((dueEditorSnapshot.reminders || []).map(r => ({ ...r })));
    modalDraft.reminderMinutes = dueEditorSnapshot.reminderMinutes;
    updateModalChips();
  }
  dueEditorCommitted = false;
  dueEditorSnapshot = null;
});

// priority / project / label menus are viewport-positioned so the task
// dialog never clips them and they stay clear of the screen edges.
const META_MENU_GAP = 4;
const META_MENU_MARGIN = 8;

function positionMetaMenu(menu, trigger) {
  if (!menu || !trigger || menu.classList.contains('hidden')) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const anchor = trigger.getBoundingClientRect();

  // Measure at the origin first so clamping uses the real size.
  menu.style.position = 'fixed';
  menu.style.marginTop = '0';
  menu.style.maxHeight = 'none';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();

  const width = Math.min(rect.width, vw - META_MENU_MARGIN * 2);
  let left = anchor.left;
  if (left + width > vw - META_MENU_MARGIN) left = vw - META_MENU_MARGIN - width;
  left = Math.max(META_MENU_MARGIN, left);

  const spaceBelow = vh - META_MENU_MARGIN - (anchor.bottom + META_MENU_GAP);
  const spaceAbove = anchor.top - META_MENU_GAP - META_MENU_MARGIN;

  let top;
  let maxHeight;
  if (rect.height <= spaceBelow) {
    top = anchor.bottom + META_MENU_GAP;
    maxHeight = spaceBelow;
  } else if (rect.height <= spaceAbove) {
    top = anchor.top - META_MENU_GAP - rect.height;
    maxHeight = spaceAbove;
  } else if (spaceBelow >= spaceAbove) {
    top = anchor.bottom + META_MENU_GAP;
    maxHeight = spaceBelow;
  } else {
    top = META_MENU_MARGIN;
    maxHeight = spaceAbove;
  }

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.maxHeight = `${Math.max(1, Math.floor(maxHeight))}px`;
  menu.style.overflowY = 'auto';
  menu.style.overscrollBehavior = 'contain';
}

function closeMetaMenus() {
  [priorityMenu, projectMenu, labelMenu].forEach(menu => menu.classList.add('hidden'));
}

function toggleMetaMenu(menu, trigger) {
  const opening = menu.classList.contains('hidden');
  closeMetaMenus();
  if (!opening) return;
  menu.classList.remove('hidden');
  positionMetaMenu(menu, trigger);
}

window.addEventListener('resize', () => {
  if (!priorityMenu.classList.contains('hidden')) positionMetaMenu(priorityMenu, $('#meta-priority'));
  if (!projectMenu.classList.contains('hidden')) positionMetaMenu(projectMenu, $('#meta-project'));
  if (!labelMenu.classList.contains('hidden')) positionMetaMenu(labelMenu, $('#meta-label'));
});
window.addEventListener('scroll', () => {
  if (!priorityMenu.classList.contains('hidden')) positionMetaMenu(priorityMenu, $('#meta-priority'));
  if (!projectMenu.classList.contains('hidden')) positionMetaMenu(projectMenu, $('#meta-project'));
  if (!labelMenu.classList.contains('hidden')) positionMetaMenu(labelMenu, $('#meta-label'));
}, true);

$('#meta-priority').onclick = (e) => {
  e.stopPropagation();
  toggleMetaMenu(priorityMenu, e.currentTarget);
};
$('#meta-project').onclick = (e) => {
  e.stopPropagation();
  toggleMetaMenu(projectMenu, e.currentTarget);
};
$('#meta-label').onclick = (e) => {
  e.stopPropagation();
  toggleMetaMenu(labelMenu, e.currentTarget);
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('.meta-chip') && !e.target.closest('#priority-menu') && !e.target.closest('#project-menu') && !e.target.closest('#label-menu')) {
    closeMetaMenus();
  }
  if (!e.target.closest('#sort-menu') && !e.target.closest('#sort-menu-btn')) {
    sortMenu.classList.add('hidden');
  }
});

$$('.close-modal').forEach(b => b.onclick = () => modal.close());
modal.addEventListener('close', () => {
  editingTaskId = null;
  modalDraft = null;
  // Files added in the dialog but never saved are thrown away.
  pendingAttachments.forEach(id => store.deleteBlob(id).catch(() => {}));
  pendingAttachments.clear();
  if (dueModal.open) {
    dueEditorCommitted = true;
    dueModal.close();
  }
});

$('#modal-save').onclick = () => {
  if (!editingTaskId || !modalDraft) return;
  if (!commitDueEdits()) {
    showToast('That repeat rule is not valid', 'error');
    dueRepeatInput.focus();
    return;
  }
  const t = state.tasks.find(x => x.id === editingTaskId);
  if (!t) return;
  const previousReminderKey = reminderKey(t);
  t.title = $('#modal-title').value.trim() || 'Untitled';
  t.description = $('#modal-desc').value.trim();
  t.due = modalDraft.due;
  t.dueTime = modalDraft.dueTime;
  t.recurrence = modalDraft.recurrence;
  t.recurrenceEnd = recurrenceEndFromBody(modalDraft.recurrence);
  t.reminders = taskReminders(modalDraft).map(r => ({ id: r.id, minutes: r.minutes }));
  t.reminderMinutes = t.reminders.length ? t.reminders[0].minutes : null;
  t.comments = (modalDraft.comments || []).map(c => ({ ...c }));
  t.attachments = (modalDraft.attachments || []).map(a => ({ ...a }));
  // The files now belong to the task, so the close handler must not remove them.
  pendingAttachments.clear();
  t.sectionId = modalDraft.sectionId || null;
  if (reminderKey(t) !== previousReminderKey) t.reminderFiredKey = null;
  if (t.reminderMinutes !== null) ensureNotificationPermission();
  t.durationMinutes = cleanDuration(Number($('#modal-duration').value));
  t.priority = modalDraft.priority;
  t.projectId = modalDraft.projectId;
  t.labels = modalDraft.labels;
  saveState();
  render();
  modal.close();
};

$('#modal-delete').onclick = () => {
  if (!editingTaskId) return;
  const id = editingTaskId;
  modal.close();
  removeTask(id);
};

/* ============================================================
   QUICK ADD
============================================================ */
const qaWrapper = $('#quick-add-wrapper');
const qaPlaceholder = $('#quick-add-placeholder');
const qaEditor = $('#quick-add-editor');
const qaInput = $('#quick-add-input');
const qaPreview = $('#quick-add-preview');
let quickAddDefaults = {};
// Chip edits layered on top of what the text parser understood.
let qaOverrides = {};
let qaPicker = null;

function openQuickAdd(defaults = {}) {
  quickAddDefaults = defaults || {};
  qaOverrides = {};
  qaPicker = null;
  renderQaPicker();
  qaPlaceholder.classList.add('hidden');
  qaEditor.classList.remove('hidden');
  qaInput.value = '';
  qaPreview.innerHTML = '';
  qaInput.style.height = 'auto';
  qaInput.focus();
  updatePreview();
}
function closeQuickAdd() {
  quickAddDefaults = {};
  qaOverrides = {};
  qaPicker = null;
  renderQaPicker();
  qaPlaceholder.classList.remove('hidden');
  qaEditor.classList.add('hidden');
}
qaPlaceholder.onclick = openQuickAdd;
$('#quick-add-cancel').onclick = closeQuickAdd;

qaInput.addEventListener('input', () => {
  qaInput.style.height = 'auto';
  qaInput.style.height = Math.min(qaInput.scrollHeight, 120) + 'px';
  // The text is the source of truth, so chip edits are dropped on new input.
  qaOverrides = {};
  updatePreview();
});

/** Pulls an "every …" phrase out of free text using the rrule parser. */
const RECURRENCE_TOKEN_RE = new RegExp(
  '^(?:' + [
    '\\d{1,2}(?:st|nd|rd|th)?', 'one', 'two', 'three', 'four', 'five', 'six',
    'seven', 'eight', 'nine', 'ten', 'other', 'every', 'last', 'first', 'second',
    'third', 'fourth', 'fifth', 'on', 'the', 'of', 'and',
    'day', 'days', 'week', 'weeks', 'weekday', 'weekdays', 'weekend',
    'month', 'months', 'year', 'years',
    'mon', 'monday', 'tue', 'tues', 'tuesday', 'wed', 'weds', 'wednesday',
    'thu', 'thur', 'thurs', 'thursday', 'fri', 'friday', 'sat', 'saturday',
    'sun', 'sunday',
    'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april',
    'may', 'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept',
    'september', 'oct', 'october', 'nov', 'november', 'dec', 'december',
  ].join('|') + ')$',
  'i'
);

function extractRecurrencePhrase(text) {
  const tokens = text.split(/\s+/);
  const isRecurrenceToken = (tok) => RECURRENCE_TOKEN_RE.test(tok.replace(/[,;]+$/, ''));

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].toLowerCase() !== 'every') continue;
    // Consume only words that can belong to a repeat phrase. Unknown words
    // (e.g. "with team") stay in the task title.
    let end = i + 1;
    while (end < tokens.length && isRecurrenceToken(tokens[end])) end++;
    for (let len = end - i; len >= 1; len--) {
      const candidate = tokens.slice(i, i + len).join(' ');
      const body = parseRecurrenceText(candidate);
      if (body) {
        const rest = [...tokens.slice(0, i), ...tokens.slice(i + len)].join(' ');
        return { body, rest };
      }
    }
  }
  return null;
}

function parseQuickAdd(text) {
  let title = text;
  let due = null, dueTime = null, recurrence = null, priority = 4, projectId = null, labels = [];

  // priority: p1..p4
  const pMatch = title.match(/\bp([1-4])\b/i);
  if (pMatch) {
    priority = +pMatch[1];
    title = title.replace(pMatch[0], '').trim();
  }

  // project: #name
  const projMatch = title.match(/(?:^|\s)#([\w-]+)/);
  if (projMatch) {
    const name = projMatch[1].toLowerCase();
    const proj = state.projects.find(p => p.name.toLowerCase() === name);
    if (proj) {
      projectId = proj.id;
      title = title.replace(projMatch[0], '').trim();
    }
  }

  // labels: @name
  const labelMatches = [...title.matchAll(/(?:^|\s)@([\w-]+)/g)];
  labelMatches.forEach(m => {
    const name = m[1].toLowerCase();
    const lbl = state.labels.find(l => l.name.toLowerCase() === name);
    if (lbl) {
      labels.push(lbl.id);
      title = title.replace(m[0], '').trim();
    }
  });

  // recurrence: "every Monday", "every 2 weeks", ...
  const rec = extractRecurrencePhrase(title);
  if (rec) {
    recurrence = rec.body;
    title = rec.rest.trim();
  }

  // date/time via chrono
  const chrono = window.chrono;
  let explicitDate = false;
  if (chrono) {
    const parsed = chrono.parse(title, new Date(), { forwardDate: true });
    if (parsed.length) {
      const p = parsed[0];
      const d = p.start.date();
      explicitDate = ['day', 'weekday', 'month', 'year'].some(k => p.start.isCertain(k));
      if (p.start.isCertain('hour')) {
        dueTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }
      d.setHours(0,0,0,0);
      due = toISODate(d);
      // remove date text from title
      title = (title.slice(0, p.index) + title.slice(p.index + p.text.length)).trim();
    }
  }

  // A repeat phrase decides the date unless the user gave an explicit one.
  if (recurrence && (!due || !explicitDate)) {
    due = firstRecurrenceISO(recurrence, todayISO()) || due || todayISO();
  }

  // cleanup multiple spaces
  title = title.replace(/\s+/g, ' ').trim();
  return { title, due, dueTime, recurrence, priority, projectId, labels };
}

/* ------------------------------------------------------------
   QUICK ADD CHIPS + PICKERS
   The text is the source of truth; the pickers write overrides on
   top of what the text parser understood.
------------------------------------------------------------ */
function applyQaOverrides(parsed) {
  const o = qaOverrides;
  return {
    ...parsed,
    due: o.due !== undefined ? o.due : parsed.due,
    dueTime: o.dueTime !== undefined ? o.dueTime : parsed.dueTime,
    recurrence: o.recurrence !== undefined ? o.recurrence : parsed.recurrence,
    priority: o.priority !== undefined ? o.priority : parsed.priority,
    projectId: o.projectId !== undefined ? o.projectId : parsed.projectId,
    labels: o.labels !== undefined ? o.labels : parsed.labels,
  };
}

/** `label` is pre-escaped HTML (icon + text). */
function qaChip(kind, icon, label, extra = '') {
  return `<button type="button" class="qa-chip${qaPicker === kind ? ' active' : ''}" data-qa-picker="${kind}"${extra}>${label}</button>`;
}

function updatePreview() {
  const text = qaInput.value.trim();
  if (!text) {
    qaPreview.innerHTML = '';
    qaOverrides = {};
    qaPicker = null;
    renderQaPicker();
    return;
  }
  const p = applyQaOverrides(parseQuickAdd(text));
  const parts = [];
  if (p.due) {
    parts.push(qaChip('date', 'calendar',
      `<i data-lucide="calendar" class="w-3 h-3"></i>${escapeHtml(formatDue(p.due, p.dueTime))}`));
  }
  if (p.recurrence) {
    parts.push(qaChip('repeat', 'repeat',
      `<i data-lucide="repeat" class="w-3 h-3"></i>${escapeHtml(recurrenceToText(p.recurrence))}`));
  }
  if (p.priority < 4) {
    parts.push(qaChip('priority', 'flag',
      `<i data-lucide="flag" class="w-3 h-3" style="color:${priorityColor(p.priority)}"></i>P${p.priority}`));
  }
  if (p.projectId) {
    parts.push(qaChip('project', 'hash',
      `<i data-lucide="hash" class="w-3 h-3"></i>${escapeHtml(projectName(p.projectId))}`));
  }
  p.labels.forEach(lid => {
    parts.push(qaChip('label', 'tag',
      `<i data-lucide="tag" class="w-3 h-3"></i>@${escapeHtml(labelName(lid))}`));
  });

  // Affordances for the values the text does not mention yet.
  if (!p.due) {
    parts.push(qaChip('date', 'calendar-plus',
      `<i data-lucide="calendar-plus" class="w-3 h-3"></i>Add date`, ` style="color:#808080"`));
  }
  if (!p.projectId) {
    parts.push(qaChip('project', 'hash',
      `<i data-lucide="hash" class="w-3 h-3"></i>Add project`, ` style="color:#808080"`));
  }
  if (!p.labels.length) {
    parts.push(qaChip('label', 'tag',
      `<i data-lucide="tag" class="w-3 h-3"></i>Add label`, ` style="color:#808080"`));
  }

  qaPreview.innerHTML = parts.join('');
  lucide.createIcons();
}

/** Renders the inline editor for the currently open chip. */
function renderQaPicker() {
  const box = $('#quick-add-picker');
  if (!box) return;
  if (!qaPicker) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const p = applyQaOverrides(parseQuickAdd(qaInput.value.trim()));
  box.classList.remove('hidden');

  if (qaPicker === 'date') {
    const d = new Date();
    const tomorrow = new Date(d.getTime() + 86400000);
    const nextWeek = new Date(d.getTime() + 7 * 86400000);
    box.innerHTML = `
      <div class="flex flex-wrap items-center gap-1 mb-2">
        <button type="button" class="qa-pick" data-qa-date="today">Today</button>
        <button type="button" class="qa-pick" data-qa-date="tomorrow">Tomorrow</button>
        <button type="button" class="qa-pick" data-qa-date="next-week">Next week</button>
        <button type="button" class="qa-pick" data-qa-date="none">No date</button>
      </div>
      <div class="flex items-center gap-2">
        <input id="qa-date-input" type="date" aria-label="Due date" class="text-xs border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30" value="${escapeHtml(p.due || '')}" />
        <input id="qa-time-input" type="time" aria-label="Due time" class="text-xs border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30" value="${escapeHtml(p.dueTime || '')}" />
      </div>`;
  } else if (qaPicker === 'project') {
    box.innerHTML = `<div class="flex flex-wrap items-center gap-1">
      <button type="button" class="qa-pick" data-qa-project="none" aria-pressed="${!p.projectId}">No project</button>
      ${state.projects.map(proj => `
        <button type="button" class="qa-pick" data-qa-project="${escapeHtml(proj.id)}" aria-pressed="${p.projectId === proj.id}">
          <span style="color:${escapeHtml(proj.color)}">#</span>${escapeHtml(proj.name)}
        </button>`).join('')}
    </div>`;
  } else if (qaPicker === 'label') {
    box.innerHTML = state.labels.length ? `<div class="flex flex-wrap items-center gap-1">
      ${state.labels.map(lbl => `
        <button type="button" class="qa-pick" data-qa-label="${escapeHtml(lbl.id)}" aria-pressed="${p.labels.includes(lbl.id)}">
          <span style="color:${escapeHtml(lbl.color)}">@</span>${escapeHtml(lbl.name)}
        </button>`).join('')}
    </div>` : '<span class="text-td-muted">No labels yet.</span>';
  } else if (qaPicker === 'priority') {
    box.innerHTML = `<div class="flex flex-wrap items-center gap-1">
      ${[1, 2, 3, 4].map(pr => `
        <button type="button" class="qa-pick" data-qa-priority="${pr}" aria-pressed="${p.priority === pr}">
          <span style="color:${priorityColor(pr)}">&#9873;</span>P${pr}
        </button>`).join('')}
    </div>`;
  } else if (qaPicker === 'repeat') {
    box.innerHTML = `
      <input id="qa-repeat-input" type="text" placeholder="e.g. every Monday" autocomplete="off"
        class="w-full text-xs border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30"
        value="${escapeHtml(p.recurrence ? recurrenceToText(p.recurrence) : '')}" />
      <div class="text-[11px] text-td-muted mt-1">Leave empty for no repeat.</div>`;
  }
}

function openQaPicker(kind) {
  qaPicker = qaPicker === kind ? null : kind;
  renderQaPicker();
  updatePreview();
}

function refreshQa() {
  updatePreview();
  renderQaPicker();
}

$('#quick-add-preview').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-qa-picker]');
  if (!chip) return;
  e.preventDefault();
  openQaPicker(chip.dataset.qaPicker);
});

$('#quick-add-picker').addEventListener('click', (e) => {
  const dateBtn = e.target.closest('[data-qa-date]');
  if (dateBtn) {
    const kind = dateBtn.dataset.qaDate;
    const d = new Date();
    if (kind === 'today') qaOverrides.due = todayISO();
    else if (kind === 'tomorrow') { d.setDate(d.getDate() + 1); qaOverrides.due = toISODate(d); }
    else if (kind === 'next-week') { d.setDate(d.getDate() + 7); qaOverrides.due = toISODate(d); }
    else { qaOverrides.due = null; qaOverrides.dueTime = null; }
    refreshQa();
    return;
  }
  const projBtn = e.target.closest('[data-qa-project]');
  if (projBtn) {
    const id = projBtn.dataset.qaProject;
    qaOverrides.projectId = id === 'none' ? null : id;
    refreshQa();
    return;
  }
  const lblBtn = e.target.closest('[data-qa-label]');
  if (lblBtn) {
    const id = lblBtn.dataset.qaLabel;
    const current = qaOverrides.labels !== undefined
      ? qaOverrides.labels
      : applyQaOverrides(parseQuickAdd(qaInput.value.trim())).labels;
    qaOverrides.labels = current.includes(id) ? current.filter(x => x !== id) : [...current, id];
    refreshQa();
    return;
  }
  const prioBtn = e.target.closest('[data-qa-priority]');
  if (prioBtn) {
    qaOverrides.priority = Number(prioBtn.dataset.qaPriority);
    refreshQa();
  }
});

$('#quick-add-picker').addEventListener('change', (e) => {
  if (e.target.id === 'qa-date-input') {
    qaOverrides.due = e.target.value || null;
    if (!e.target.value) qaOverrides.dueTime = null;
    refreshQa();
    return;
  }
  if (e.target.id === 'qa-time-input') {
    qaOverrides.dueTime = e.target.value || null;
    refreshQa();
    return;
  }
  if (e.target.id === 'qa-repeat-input') {
    const raw = e.target.value.trim();
    qaOverrides.recurrence = raw ? (parseRecurrenceText(raw) || null) : null;
    refreshQa();
  }
});

function submitQuickAdd() {
  const text = qaInput.value.trim();
  if (!text) { closeQuickAdd(); return; }
  const p = applyQaOverrides(parseQuickAdd(text));
  if (!p.title) { closeQuickAdd(); return; }
  // Empty-state shortcuts can prefill context (e.g. Today adds a due date).
  if (!p.due && quickAddDefaults.due) p.due = quickAddDefaults.due;
  if (!p.projectId && quickAddDefaults.projectId) p.projectId = quickAddDefaults.projectId;
  // default project from current view
  if (!p.projectId && state.ui.view.startsWith('project:')) {
    p.projectId = state.ui.view.split(':')[1];
  }
  addTask(p);
  qaInput.value = '';
  qaInput.style.height = 'auto';
  qaPreview.innerHTML = '';
  qaOverrides = {};
  qaPicker = null;
  renderQaPicker();
  qaInput.focus();
}

$('#quick-add-submit').onclick = submitQuickAdd;
qaInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitQuickAdd(); }
  if (e.key === 'Escape') closeQuickAdd();
});

/* ============================================================
   SAVED FILTER UI + SORT MENU
============================================================ */
let editingFilterId = null;

function openFilterEditor(id) {
  const f = savedFilters.find(x => x.id === id);
  if (!f) return;
  editingFilterId = id;
  const row = $('#filter-save-row');
  const input = $('#filter-name-input');
  row.classList.remove('hidden');
  input.value = f.name;
  input.dataset.query = f.query;
  input.focus();
  input.select();
}

function deleteFilter(id) {
  savedFilters = savedFilters.filter(f => f.id !== id);
  persistSavedFilters();
  if (state.ui.view === `filter:${id}`) {
    state.ui.view = 'inbox';
    saveState();
  }
  render();
  showToast('Filter deleted', 'info');
}

function saveFilterFromRow() {
  const input = $('#filter-name-input');
  const name = input.value.trim();
  const query = input.dataset.query !== undefined ? input.dataset.query : (state.ui.search || '').trim();
  if (!name || !query) {
    showToast('A filter needs a name and a search', 'error');
    return;
  }
  const editing = editingFilterId;
  let id = editing;
  if (editing) {
    const f = savedFilters.find(x => x.id === editing);
    if (f) { f.name = name; f.query = query; }
  } else {
    id = uid();
    savedFilters.push({ id, name, query });
  }
  editingFilterId = null;
  persistSavedFilters();
  input.value = '';
  delete input.dataset.query;
  $('#filter-save-row').classList.add('hidden');
  if (!editing) {
    state.ui.search = '';
    $('#search-input').value = '';
  }
  saveState();
  navigateTo(`filter:${id}`);
  showToast(editing ? 'Filter updated' : 'Filter saved', 'success');
}

$('#add-filter-btn').onclick = () => {
  editingFilterId = null;
  const input = $('#filter-name-input');
  input.value = '';
  delete input.dataset.query;
  $('#filter-save-row').classList.remove('hidden');
  input.focus();
  if (!(state.ui.search || '').trim()) {
    showToast('Type a search first, then save it as a filter', 'error');
  }
};

$('#filter-save-btn').onclick = saveFilterFromRow;
$('#filter-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveFilterFromRow(); }
});

const sortMenu = $('#sort-menu');

function renderSortMenu() {
  sortMenu.innerHTML = SORT_OPTIONS.map(o => `
    <button type="button" data-sort="${o.id}" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 ${state.ui.sort === o.id ? 'text-td-red font-medium' : ''}">
      <i data-lucide="check" class="w-3.5 h-3.5 ${state.ui.sort === o.id ? '' : 'invisible'}"></i>${o.label}
    </button>`).join('');
}

$('#sort-menu-btn').onclick = (e) => {
  e.stopPropagation();
  const opening = sortMenu.classList.contains('hidden');
  priorityMenu.classList.add('hidden');
  projectMenu.classList.add('hidden');
  labelMenu.classList.add('hidden');
  renderSortMenu();
  sortMenu.classList.toggle('hidden');
  lucide.createIcons();
};

sortMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sort]');
  if (!btn) return;
  state.ui.sort = btn.dataset.sort;
  sortMenu.classList.add('hidden');
  saveState();
  render();
});

/* ============================================================
   SIDEBAR NAV
============================================================ */
function pulseViewIn() {
  const el = $('#content-container');
  if (!el) return;
  el.classList.remove('view-enter');
  void el.offsetWidth;
  el.classList.add('view-enter');
}

function navigateTo(view) {
  state.ui.view = view;
  state.ui.search = '';
  $('#search-input').value = '';
  saveState();
  render();
  syncHash();
  pulseViewIn();
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('.nav-item');
  if (nav && nav.dataset.view) {
    e.preventDefault();
    navigateTo(nav.dataset.view);
    closeMobileSidebar();
  }
});

$('#search-input').addEventListener('input', (e) => {
  state.ui.search = e.target.value;
  saveState();
  renderMain();
  lucide.createIcons();
  syncHash();
});

$('#view-layout').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-layout]');
  if (!btn) return;
  const layout = btn.dataset.layout === 'board' ? 'board' : 'list';
  if (state.ui.layout === layout) return;
  state.ui.layout = layout;
  saveState();
  render();
  pulseViewIn();
});

$('#empty-cta').onclick = () => {
  const v = state.ui.view;
  const defaults = (v === 'today' || v === 'upcoming') ? { due: todayISO() } : {};
  openQuickAdd(defaults);
};

/* ============================================================
   PROJECT / LABEL EDITING
============================================================ */
const projectModal = $('#project-modal');
const labelModal = $('#label-modal');
const rowMenu = $('#row-menu');

// Todoist-ish palette; also used when a stored colour is off-palette.
const COLOR_PALETTE = [
  '#db4c3f', '#eb8909', '#f5a623', '#058527', '#0f9d58', '#14aaf5',
  '#246fe0', '#8a4dff', '#e05194', '#b8256f', '#7e7e7e', '#202020',
];

let editingProjectId = null;
let projectDraftColor = null;
let projectDraftSections = [];
let editingLabelId = null;
let labelDraftColor = null;

function renderProjectSections() {
  $('#project-sections').innerHTML = projectDraftSections.length ? projectDraftSections.map(s => `
    <div class="flex items-center gap-1" data-section-id="${escapeHtml(s.id)}">
      <span class="flex-1 text-sm truncate">${escapeHtml(s.name)}</span>
      <button type="button" class="text-td-muted hover:text-red-600 p-0.5" data-section-remove="${escapeHtml(s.id)}" title="Remove section" aria-label="Remove section">
        <i data-lucide="x" class="w-3.5 h-3.5"></i>
      </button>
    </div>`).join('')
    : '<div class="text-[11px] text-td-muted">No sections yet.</div>';
  lucide.createIcons();
}

$('#project-sections').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-section-remove]');
  if (!btn) return;
  projectDraftSections = projectDraftSections.filter(s => s.id !== btn.dataset.sectionRemove);
  renderProjectSections();
});

$('#project-section-add').onclick = () => {
  const input = $('#project-section-name');
  const name = input.value.trim();
  if (!name) return;
  projectDraftSections.push({ id: uid(), name });
  input.value = '';
  renderProjectSections();
  input.focus();
};

$('#project-section-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#project-section-add').click(); }
});

function renderColorSwatches(container, selected, onPick) {
  const colors = COLOR_PALETTE.includes(selected) ? COLOR_PALETTE : [selected, ...COLOR_PALETTE];
  container.innerHTML = colors.map(c => `
    <button type="button" class="color-swatch" data-color="${c}" title="${c}" aria-label="Colour ${c}" aria-pressed="${c === selected}"
      style="background:${c}">
      ${c === selected ? '<i data-lucide="check" class="w-3 h-3 text-white"></i>' : ''}
    </button>`).join('');
  container.querySelectorAll('button').forEach(btn => {
    btn.onclick = () => onPick(btn.dataset.color);
  });
  lucide.createIcons();
}

function pickProjectColor(color) {
  projectDraftColor = color;
  renderColorSwatches($('#project-colors'), color, pickProjectColor);
}

function pickLabelColor(color) {
  labelDraftColor = color;
  renderColorSwatches($('#label-colors'), color, pickLabelColor);
}

function openProjectModal(id = null) {
  closeRowMenu();
  const proj = id ? state.projects.find(p => p.id === id) : null;
  if (id && !proj) return;
  editingProjectId = id;
  $('#project-modal-title').textContent = proj ? 'Edit project' : 'Add project';
  $('#project-name').value = proj ? proj.name : '';
  $('#save-project').textContent = proj ? 'Save' : 'Add';
  projectDraftColor = proj ? proj.color : PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length];
  projectDraftSections = proj && Array.isArray(proj.sections) ? proj.sections.map(s => ({ ...s })) : [];
  renderColorSwatches($('#project-colors'), projectDraftColor, pickProjectColor);
  renderProjectSections();
  projectModal.showModal();
  if (!isMobileSidebar()) setTimeout(() => $('#project-name').focus(), 50);
}

function openLabelModal(id = null) {
  closeRowMenu();
  const lbl = id ? state.labels.find(l => l.id === id) : null;
  if (id && !lbl) return;
  editingLabelId = id;
  $('#label-modal-title').textContent = lbl ? 'Edit label' : 'Add label';
  $('#label-name').value = lbl ? lbl.name : '';
  $('#save-label').textContent = lbl ? 'Save' : 'Add';
  labelDraftColor = lbl ? lbl.color : LABEL_COLORS[state.labels.length % LABEL_COLORS.length];
  renderColorSwatches($('#label-colors'), labelDraftColor, pickLabelColor);
  labelModal.showModal();
  if (!isMobileSidebar()) setTimeout(() => $('#label-name').focus(), 50);
}

$('#add-project-btn').onclick = () => openProjectModal(null);
$('#save-project').onclick = () => {
  const name = $('#project-name').value.trim();
  if (!name) { $('#project-name').focus(); return; }

  if (editingProjectId) {
    const proj = state.projects.find(p => p.id === editingProjectId);
    if (!proj) { projectModal.close(); return; }
    proj.name = name;
    proj.color = projectDraftColor;
    proj.sections = projectDraftSections.map(s => ({ ...s }));
  } else {
    state.projects.push({ id: 'proj_' + uid(), name, color: projectDraftColor, sections: projectDraftSections.map(s => ({ ...s })) });
  }
  saveState();
  render();
  projectModal.close();
};
$$('.close-project-modal').forEach(b => b.onclick = () => projectModal.close());
projectModal.addEventListener('close', () => { editingProjectId = null; });

$('#add-label-btn').onclick = () => openLabelModal(null);
$('#save-label').onclick = () => {
  const name = $('#label-name').value.replace(/^@/, '').trim();
  if (!name) { $('#label-name').focus(); return; }

  if (editingLabelId) {
    const lbl = state.labels.find(l => l.id === editingLabelId);
    if (!lbl) { labelModal.close(); return; }
    lbl.name = name;
    lbl.color = labelDraftColor;
  } else {
    state.labels.push({ id: 'lbl_' + uid(), name, color: labelDraftColor });
  }
  saveState();
  render();
  labelModal.close();
};
$$('.close-label-modal').forEach(b => b.onclick = () => labelModal.close());
labelModal.addEventListener('close', () => { editingLabelId = null; });

// Enter submits either modal.
$('#project-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#save-project').click(); }
});
$('#label-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#save-label').click(); }
});

function deleteProject(id) {
  closeRowMenu();
  const proj = state.projects.find(p => p.id === id);
  if (!proj) return;
  const affected = state.tasks.filter(t => t.projectId === id).length;
  const extra = affected ? `\n\n${plural(affected, 'task')} will move to Inbox.` : '';
  if (!confirm(`Delete project "${proj.name}"?${extra}`)) return;

  const snapshot = snapshotData();
  state.projects = state.projects.filter(p => p.id !== id);
  state.tasks.forEach(t => { if (t.projectId === id) t.projectId = null; });
  if (state.ui.view === `project:${id}`) {
    state.ui.view = 'inbox';
    state.ui.search = '';
    $('#search-input').value = '';
  }
  saveState();
  render();
  offerUndo(`Project "${proj.name}" deleted`, snapshot);
}

function deleteLabel(id) {
  closeRowMenu();
  const lbl = state.labels.find(l => l.id === id);
  if (!lbl) return;
  const affected = state.tasks.filter(t => (t.labels || []).includes(id)).length;
  const extra = affected ? `\n\nIt will be removed from ${plural(affected, 'task')}.` : '';
  if (!confirm(`Delete label "@${lbl.name}"?${extra}`)) return;

  const snapshot = snapshotData();
  state.labels = state.labels.filter(l => l.id !== id);
  state.tasks.forEach(t => { t.labels = (t.labels || []).filter(lid => lid !== id); });
  if (state.ui.view === `label:${id}`) {
    state.ui.view = 'inbox';
    state.ui.search = '';
    $('#search-input').value = '';
  }
  saveState();
  render();
  offerUndo(`Label "@${lbl.name}" deleted`, snapshot);
}

/* ---------- Row action menu (project / label "…" button) ---------- */
let rowMenuTarget = null;

function openRowMenu(trigger, type, id) {
  const isProject = type === 'project';
  const isFilter = type === 'filter';
  const entry = isProject
    ? state.projects.find(p => p.id === id)
    : isFilter
      ? savedFilters.find(f => f.id === id)
      : state.labels.find(l => l.id === id);
  if (!entry) return;

  rowMenuTarget = { type, id };
  rowMenu.innerHTML = isFilter ? `
    <button type="button" data-row-action="edit" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2">
      <i data-lucide="pencil" class="w-3.5 h-3.5 text-td-muted"></i>Edit filter
    </button>
    <button type="button" data-row-action="delete" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 text-red-600">
      <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>Delete filter
    </button>` : `
    <button type="button" data-row-action="pin" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2">
      <i data-lucide="star" class="w-3.5 h-3.5 text-td-muted"></i>${entry.pinned ? 'Unpin from top' : 'Pin to top'}
    </button>
    <button type="button" data-row-action="edit" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2">
      <i data-lucide="pencil" class="w-3.5 h-3.5 text-td-muted"></i>Edit ${isProject ? 'project' : 'label'}
    </button>
    <button type="button" data-row-action="delete" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 text-red-600">
      <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>Delete ${isProject ? 'project' : 'label'}
    </button>`;

  rowMenu.classList.remove('hidden');

  // Position under the trigger, flipping up / clamping inside the viewport.
  const rect = trigger.getBoundingClientRect();
  const menuRect = rowMenu.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(rect.left, window.innerWidth - menuRect.width - margin);
  let top = rect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - margin) top = rect.top - menuRect.height - 4;
  rowMenu.style.left = `${Math.max(margin, left)}px`;
  rowMenu.style.top = `${Math.max(margin, top)}px`;

  lucide.createIcons();
}

function closeRowMenu() {
  rowMenuTarget = null;
  rowMenu.classList.add('hidden');
  rowMenu.innerHTML = '';
}

rowMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-row-action]');
  if (!btn || !rowMenuTarget) return;
  e.stopPropagation();
  const { type, id } = rowMenuTarget;
  if (btn.dataset.rowAction === 'pin') {
    const entry = type === 'project'
      ? state.projects.find(p => p.id === id)
      : state.labels.find(l => l.id === id);
    if (entry) entry.pinned = !entry.pinned;
    closeRowMenu();
    saveState();
    render();
    return;
  }
  if (btn.dataset.rowAction === 'edit') {
    closeRowMenu();
    if (type === 'project') openProjectModal(id);
    else if (type === 'filter') openFilterEditor(id);
    else openLabelModal(id);
  } else if (btn.dataset.rowAction === 'delete') {
    if (type === 'project') deleteProject(id);
    else if (type === 'filter') deleteFilter(id);
    else deleteLabel(id);
  }
});

document.addEventListener('click', (e) => {
  if (rowMenu.classList.contains('hidden')) return;
  if (e.target.closest('#row-menu') || e.target.closest('.row-menu-btn')) return;
  closeRowMenu();
});

// A fixed-position menu would drift away from its row on scroll.
document.addEventListener('scroll', () => {
  if (!rowMenu.classList.contains('hidden')) closeRowMenu();
}, true);

/* ============================================================
   TOASTS
============================================================ */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Shows a transient message. `actionLabel` adds a button (used for
 * "Undo"); `onTimeout` runs when the toast expires on its own.
 */
/* ============================================================
   SCREEN READER ANNOUNCEMENTS
   Toasts are visual only, so the same message is repeated in a
   polite live region for assistive technology.
============================================================ */
const srStatus = $('#sr-status');
let srTimer = null;

function announce(message) {
  if (!message || !srStatus) return;
  srStatus.textContent = '';
  clearTimeout(srTimer);
  srTimer = setTimeout(() => { srStatus.textContent = message; }, 60);
}

function showToast(message, type = 'info', { actionLabel, onAction, duration = 2600, onTimeout } = {}) {
  announce(message);
  const container = document.getElementById('toast-container');
  if (!container) { console.log(message); return null; }

  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' toast-error' : type === 'success' ? ' toast-success' : '');

  const text = document.createElement('span');
  text.className = 'toast-message';
  text.textContent = message;
  el.appendChild(text);

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  };

  if (actionLabel && typeof onAction === 'function') {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = actionLabel;
    action.onclick = () => { dismiss(); onAction(); };
    el.appendChild(action);
  }

  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  timer = setTimeout(() => {
    if (typeof onTimeout === 'function') onTimeout();
    dismiss();
  }, duration);
  return el;
}

/* ============================================================
   UNDO
   The pre-action data (not the UI) is snapshotted, so undo restores
   exactly what was there. Only the most recent action is undoable;
   any other save discards it — see saveState / clearPendingUndo.
============================================================ */
function snapshotData() {
  return JSON.parse(JSON.stringify({
    projects: state.projects,
    labels: state.labels,
    tasks: state.tasks,
  }));
}

function clearPendingUndo() {
  if (!pendingUndo) return;
  const el = pendingUndo.toastEl;
  pendingUndo = null;
  if (el && el.parentNode) el.remove();
}

/** Offers an undo toast that restores `snapshot` (captured before the action). */
function offerUndo(message, snapshot) {
  const el = showToast(message, 'info', {
    actionLabel: 'Undo',
    duration: 7000,
    onAction: undoPending,
    onTimeout: () => {
      if (pendingUndo && pendingUndo.toastEl === el) pendingUndo = null;
    },
  });
  pendingUndo = { snapshot, toastEl: el };
}

function undoPending() {
  if (!pendingUndo) return;
  const { snapshot } = pendingUndo;
  clearPendingUndo();

  // Remember the current state so the undo itself can be redone.
  redoSnapshot = {
    projects: state.projects,
    labels: state.labels,
    tasks: state.tasks,
  };

  state = normalizeState({
    ...state,
    projects: snapshot.projects,
    labels: snapshot.labels,
    tasks: snapshot.tasks,
  });
  saveState();
  render();
  syncHash();
  showToast('Undone', 'success', {
    actionLabel: 'Redo',
    onAction: redoPending,
    duration: 7000,
  });
}

function redoPending() {
  if (!redoSnapshot) return;
  const snapshot = redoSnapshot;
  redoSnapshot = null;
  state = normalizeState({
    ...state,
    projects: snapshot.projects,
    labels: snapshot.labels,
    tasks: snapshot.tasks,
  });
  saveState();
  render();
  syncHash();
  showToast('Redone', 'success');
}

/* ============================================================
   DATA BACKUP (EXPORT / IMPORT)
============================================================ */
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportData() {
  const payload = {
    app: 'todoist-clone',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      projects: state.projects,
      labels: state.labels,
      tasks: state.tasks,
    },
  };

  downloadFile(`todoist-backup-${todayISO()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  showToast(`Exported ${plural(state.tasks.length, 'task')}`, 'success');
}

/* ---------- Other export formats ---------- */
const EXPORT_FORMATS = [
  { id: 'json', label: 'JSON backup', hint: 'Everything, re-importable', icon: 'braces' },
  { id: 'csv', label: 'CSV', hint: 'One row per task', icon: 'table' },
  { id: 'md', label: 'Markdown', hint: 'Checklist grouped by project', icon: 'file-text' },
  { id: 'ics', label: 'Calendar (ICS)', hint: 'Dated tasks as events', icon: 'calendar' },
];

function csvCell(value) {
  const s = String(value === null || value === undefined ? '' : value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvText() {
  const header = ['title', 'project', 'labels', 'priority', 'due', 'time', 'repeat', 'completed', 'created'];
  const rows = state.tasks.map(t => [
    t.title,
    t.projectId ? projectName(t.projectId) : '',
    (t.labels || []).map(labelName).join(' '),
    `P${t.priority}`,
    t.due || '',
    t.dueTime || '',
    t.recurrence ? recurrenceToText(t.recurrence) : '',
    t.completed ? 'yes' : 'no',
    toISODate(new Date(t.createdAt || Date.now())),
  ]);
  return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}

function exportCsv() {
  downloadFile(`todoist-${todayISO()}.csv`, csvText(), 'text/csv;charset=utf-8');
}

function markdownText() {
  const groups = new Map();
  state.tasks.forEach(t => {
    const key = t.projectId ? projectName(t.projectId) : 'Inbox';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });
  const lines = [`# Tasks (${todayISO()})`, ''];
  for (const [name, tasks] of groups) {
    lines.push(`## ${name}`, '');
    tasks
      .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'))
      .forEach(t => {
        const bits = [];
        if (t.due) bits.push(`@${t.due}${t.dueTime ? ` ${t.dueTime}` : ''}`);
        if (t.priority < 4) bits.push(`(P${t.priority})`);
        (t.labels || []).forEach(lid => bits.push(`#${labelName(lid)}`));
        lines.push(`- [${t.completed ? 'x' : ' '}] ${t.title}${bits.length ? ` — ${bits.join(' ')}` : ''}`);
      });
    lines.push('');
  }
  return lines.join('\n');
}

function exportMarkdown() {
  downloadFile(`todoist-${todayISO()}.md`, markdownText(), 'text/markdown;charset=utf-8');
}

function icsEscape(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsText() {
  const stamp = (d) => toISODate(d).replace(/-/g, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Todoist Clone//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  state.tasks.filter(t => t.due && !t.completed).forEach(t => {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${t.id}@todoist-clone`);
    lines.push(`DTSTAMP:${stamp(new Date())}T000000`);
    if (t.dueTime) {
      lines.push(`DTSTART:${t.due.replace(/-/g, '')}T${t.dueTime.replace(':', '')}00`);
      lines.push(`SUMMARY:${icsEscape(t.title)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${t.due.replace(/-/g, '')}`);
      const next = parseDate(t.due);
      next.setDate(next.getDate() + 1);
      lines.push(`DTEND;VALUE=DATE:${stamp(next)}`);
      lines.push(`SUMMARY:${icsEscape(t.title)}`);
    }
    if (t.description) lines.push(`DESCRIPTION:${icsEscape(t.description)}`);
    if (t.recurrence) lines.push(`RRULE:${t.recurrence}`);
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function exportIcs() {
  downloadFile(`todoist-${todayISO()}.ics`, icsText(), 'text/calendar;charset=utf-8');
}

const exportModal = $('#export-modal');

function renderExportOptions() {
  $('#export-options').innerHTML = EXPORT_FORMATS.map(f => `
    <button type="button" data-export="${f.id}" class="w-full flex items-center gap-3 px-2 py-2 rounded hover:bg-gray-50 text-left">
      <i data-lucide="${f.icon}" class="w-4 h-4 text-td-muted flex-shrink-0"></i>
      <span class="flex-1">
        <span class="block text-sm">${escapeHtml(f.label)}</span>
        <span class="block text-[11px] text-td-muted">${escapeHtml(f.hint)}</span>
      </span>
    </button>`).join('');
  lucide.createIcons();
}

$('#export-data-btn').onclick = () => {
  renderExportOptions();
  if (!exportModal.open) exportModal.showModal();
};
$('#export-close').onclick = () => exportModal.close();
$('#export-options').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-export]');
  if (!btn) return;
  const format = btn.dataset.export;
  exportModal.close();
  if (format === 'csv') exportCsv();
  else if (format === 'md') exportMarkdown();
  else if (format === 'ics') exportIcs();
  else exportData();
});

/** Reads a backup's text and returns { state } or { error }. */
function parseBackup(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch { return { error: 'That file is not valid JSON.' }; }

  // Accept either our { data: {...} } envelope or a bare state object.
  const data = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' ? raw.data : raw;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'Unrecognised backup format.' };
  }
  if (!Array.isArray(data.tasks)) return { error: 'That backup has no task list.' };

  const fileVersion = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion
    : Number.isInteger(raw.version) ? raw.version : 1;
  if (fileVersion > SCHEMA_VERSION) {
    return { error: `That backup comes from a newer version (v${fileVersion}).` };
  }

  let imported;
  try {
    imported = migrateState({
      version: fileVersion,
      projects: data.projects,
      labels: data.labels,
      tasks: data.tasks,
    });
  } catch (err) {
    return { error: err.message || 'Could not read that backup.' };
  }

  if (data.tasks.length > 0 && imported.tasks.length === 0) {
    return { error: 'No usable tasks were found in that backup.' };
  }
  return { state: imported };
}

async function applyBackup(imported) {
  const n = imported.tasks.length;
  const ok = confirm(
    `Replace your current data with this backup?\n\n` +
    `Backup contains ${plural(n, 'task')}, ${plural(imported.projects.length, 'project')} ` +
    `and ${plural(imported.labels.length, 'label')}.\n\n` +
    `Your current data is saved to a recovery slot first.`
  );
  if (!ok) return;

  try {
    await store.backupState('pre-import-backup');
  } catch {}

  state = { ...imported, ui: { ...imported.ui, view: 'inbox', activeId: null, search: '' } };
  $('#search-input').value = '';
  saveState();
  render();
  syncHash();
  showToast(`Imported ${plural(n, 'task')}`, 'success');
}

function renderStorageBadge() {
  const badge = $('#schema-badge');
  if (!badge) return;
  badge.textContent = `v${SCHEMA_VERSION}`;
  badge.title = `${plural(state.tasks.length, 'task')} stored in this browser · schema v${SCHEMA_VERSION}`;
}

$('#import-data-btn').onclick = () => $('#import-file').click();
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow re-picking the same file
  if (!file) return;
  try {
    const result = parseBackup(await file.text());
    if (result.error) { showToast(result.error, 'error'); return; }
    await applyBackup(result.state);
  } catch (err) {
    console.error('Import failed:', err);
    showToast('Could not read that file.', 'error');
  }
});

/* ============================================================
   CROSS-TAB SYNC
   The store announces saves in other tabs (BroadcastChannel, with the
   storage event as a fallback). We adopt their data but keep this
   tab's current view/search so the UI doesn't jump under the user.
============================================================ */
let syncingFromPeer = false;

store.onChange(async (key) => {
  if (syncingFromPeer) return;
  if (key && key !== store.keys.state) return;

  let incoming;
  try {
    const raw = await store.loadState();
    if (!raw) return;
    incoming = migrateState(raw);
  } catch (err) {
    console.warn('Ignored malformed data from another tab:', err);
    return;
  }

  const editing = editingTaskId;
  clearPendingUndo(); // remote data supersedes any local undo snapshot
  state = { ...incoming, ui: state.ui };
  render();

  if (editing && !state.tasks.some(t => t.id === editing)) {
    modal.close();
    showToast('That task was deleted in another tab', 'error');
  } else {
    showToast('Synced from another tab');
  }
});

/* ============================================================
   KEYBOARD NAVIGATION OF THE TASK LIST
   Up/Down move between task titles, Home/End jump to the ends.
============================================================ */
document.addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const active = document.activeElement;
  if (!active || !active.classList.contains('task-title')) return;
  const titles = $$('#task-list .task-title');
  const index = titles.indexOf(active);
  if (index < 0) return;
  e.preventDefault();

  let next = null;
  if (e.key === 'ArrowDown') next = titles[index + 1];
  else if (e.key === 'ArrowUp') next = titles[index - 1];
  else if (e.key === 'Home') next = titles[0];
  else if (e.key === 'End') next = titles[titles.length - 1];
  if (next) next.focus();
});

/* ============================================================
   KEYBOARD SHORTCUTS
============================================================ */
const SHORTCUTS = [
  { keys: ['q'], label: 'Add a task' },
  { keys: ['/'], label: 'Search' },
  { keys: ['i'], label: 'Go to Inbox' },
  { keys: ['t'], label: 'Go to Today' },
  { keys: ['u'], label: 'Go to Upcoming' },
  { keys: ['c'], label: 'Go to Completed' },
  { keys: ['b'], label: 'Toggle board / list' },
  { keys: ['?'], label: 'Show this help' },
  { keys: ['Esc'], label: 'Close dialogs and menus' },
  { keys: ['Ctrl', 'Z'], label: 'Undo the last action' },
  { keys: ['Ctrl', 'Shift', 'Z'], label: 'Redo the last action' },
  { keys: ['Ctrl', 'Click'], label: 'Select tasks' },
];

const shortcutsModal = $('#shortcuts-modal');

function renderShortcuts() {
  $('#shortcuts-list').innerHTML = SHORTCUTS.map(s => `
    <li class="shortcut-row">
      <span class="shortcut-keys">${s.keys.map(k => `<kbd class="kbd">${escapeHtml(k)}</kbd>`).join('')}</span>
      <span class="shortcut-label">${escapeHtml(s.label)}</span>
    </li>`).join('');
}

function openShortcuts() {
  renderShortcuts();
  if (!shortcutsModal.open) shortcutsModal.showModal();
}

$('#shortcuts-close').onclick = () => shortcutsModal.close();

document.addEventListener('keydown', (e) => {
  // Don't trigger inside inputs/textarea
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

  if (typing) return;

  // Ctrl/Cmd+Z undoes the last destructive action.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undoPending();
    return;
  }
  // Ctrl/Cmd+Shift+Z (or Ctrl+Y) redoes it.
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault();
    redoPending();
    return;
  }

  const dialogOpen = modal.open || projectModal.open || labelModal.open || dueModal.open || shortcutsModal.open || settingsModal.open || exportModal.open;
  if (e.key === 'Escape') {
    // Handle every case ourselves; otherwise the browser would also
    // close the dialog while we only meant to dismiss the popover.
    e.preventDefault();
    if (dueModal.open) dueModal.close();
    else if (exportModal.open) exportModal.close();
    else if (settingsModal.open) settingsModal.close();
    else if (shortcutsModal.open) shortcutsModal.close();
    else if (!rowMenu.classList.contains('hidden')) closeRowMenu();
    else if (!contextMenu.classList.contains('hidden')) closeContextMenu();
    else if ($('#sidebar').classList.contains('mobile-open')) closeMobileSidebar();
    else if (modal.open) modal.close();
    else if (projectModal.open) projectModal.close();
    else if (labelModal.open) labelModal.close();
    else if (!qaEditor.classList.contains('hidden')) closeQuickAdd();
    return;
  }
  if (dialogOpen) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === '/') {
    e.preventDefault();
    const search = $('#search-input');
    search.focus();
    search.select();
    return;
  }

  const key = e.key.toLowerCase();
  if (key === 'q') { e.preventDefault(); openQuickAdd(); return; }
  if (key === 'i') { e.preventDefault(); navigateTo('inbox'); return; }
  if (key === 't') { e.preventDefault(); navigateTo('today'); return; }
  if (key === 'u') { e.preventDefault(); navigateTo('upcoming'); return; }
  if (key === 'c') { e.preventDefault(); navigateTo('completed'); return; }
  if (key === 'b') {
    if (!supportsBoard()) return;
    e.preventDefault();
    state.ui.layout = state.ui.layout === 'board' ? 'list' : 'board';
    saveState();
    render();
    pulseViewIn();
    return;
  }
  if (e.key === '?') {
    e.preventDefault();
    openShortcuts();
  }
});

/* ============================================================
   SIDEBAR SECTIONS (collapse Projects / Labels)
============================================================ */
const SECTION_NAMES = ['filters', 'projects', 'labels'];
const sectionCollapsed = { filters: false, projects: false, labels: false };

function setSectionCollapsed(name, collapsed) {
  const list = $(`#${name}-list`);
  const btn = $(`#toggle-${name}`);
  if (!list || !btn) return;
  list.classList.toggle('hidden', collapsed);
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = `${collapsed ? 'Expand' : 'Collapse'} ${name}`;
  const icon = btn.querySelector('[data-lucide]');
  if (icon) icon.setAttribute('data-lucide', collapsed ? 'chevron-right' : 'chevron-down');
  sectionCollapsed[name] = collapsed;
  store.setDoc(store.keys.sectionCollapse, sectionCollapsed)
    .catch(err => console.error('Could not save preferences:', err));
  lucide.createIcons();
}

SECTION_NAMES.forEach(name => {
  const btn = $(`#toggle-${name}`);
  if (!btn) return;
  btn.onclick = () => {
    const collapsed = !$(`#${name}-list`).classList.contains('hidden');
    setSectionCollapsed(name, collapsed);
  };
});

/* ============================================================
   SIDEBAR (desktop collapse rail, mobile drawer)
============================================================ */
const mobileSidebarQuery = window.matchMedia('(max-width: 767px)');
let sidebarCollapsedPref = false;

function isMobileSidebar() {
  return mobileSidebarQuery.matches;
}

function applySidebarState() {
  const aside = $('#sidebar');
  const btn = $('#sidebar-toggle');
  const collapsed = sidebarCollapsedPref && !isMobileSidebar();

  aside.classList.toggle('sidebar-collapsed', collapsed);
  aside.classList.toggle('w-16', collapsed);
  aside.classList.toggle('w-72', !collapsed);

  if (isMobileSidebar()) {
    const icon = btn.querySelector('[data-lucide]');
    if (icon) icon.setAttribute('data-lucide', 'x');
    btn.title = 'Close menu';
    btn.setAttribute('aria-label', 'Close menu');
    btn.setAttribute('aria-expanded', String(aside.classList.contains('mobile-open')));
  } else {
    // Swap the toggle icon so the way back is obvious.
    const icon = btn.querySelector('[data-lucide]');
    if (icon) icon.setAttribute('data-lucide', collapsed ? 'panel-left-open' : 'panel-left-close');
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-expanded', String(!collapsed));
  }

  lucide.createIcons();
}

function setSidebarCollapsed(collapsed) {
  sidebarCollapsedPref = collapsed;
  applySidebarState();
  store.setDoc(store.keys.sidebarCollapsed, collapsed)
    .catch(err => console.error('Could not save preferences:', err));
}

function openMobileSidebar() {
  if (!isMobileSidebar()) return;
  $('#sidebar').classList.add('mobile-open');
  $('#sidebar-backdrop').classList.remove('hidden');
  $('#mobile-menu').setAttribute('aria-expanded', 'true');
  applySidebarState();
}

function closeMobileSidebar() {
  const aside = $('#sidebar');
  const wasOpen = aside.classList.contains('mobile-open');
  aside.classList.remove('mobile-open');
  $('#sidebar-backdrop').classList.add('hidden');
  $('#mobile-menu').setAttribute('aria-expanded', 'false');
  if (wasOpen) applySidebarState();
}

function handleSidebarBreakpoint() {
  if (!isMobileSidebar()) closeMobileSidebar();
  applySidebarState();
}

if (mobileSidebarQuery.addEventListener) {
  mobileSidebarQuery.addEventListener('change', handleSidebarBreakpoint);
} else if (mobileSidebarQuery.addListener) {
  mobileSidebarQuery.addListener(handleSidebarBreakpoint); // older Safari
}

$('#sidebar-toggle').onclick = () => {
  if (isMobileSidebar()) closeMobileSidebar();
  else setSidebarCollapsed(!sidebarCollapsedPref);
};

$('#mobile-menu').onclick = () => {
  if ($('#sidebar').classList.contains('mobile-open')) closeMobileSidebar();
  else openMobileSidebar();
};

$('#sidebar-backdrop').onclick = closeMobileSidebar;

/* ============================================================
   REMINDER SCHEDULER
   Works while this tab is open (browser limitation); the check
   also runs when the tab becomes visible again.
============================================================ */
let reminderTimer = null;
function startReminders() {
  if (reminderTimer) return;
  checkReminders();
  reminderTimer = setInterval(() => checkReminders(), 30000);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkReminders();
});

/* ============================================================
   INIT
============================================================ */
async function init() {
  // Filters must be known before the state is read: a saved filter can be
  // the active view, and the state loader validates the view name.
  await loadSavedFilters();

  const loaded = await loadState();
  state = loaded.state;

  await loadSettings();
  applyTheme();

  if (location.hash.length > 1) {
    const raw = location.hash.replace(/^#\/?/, '');
    const [viewPart, queryPart] = raw.split('?');
    const view = decodeURIComponent(viewPart || 'inbox');
    const q = queryPart ? (new URLSearchParams(queryPart).get('q') || '') : '';
    if (isKnownView(view)) {
      state.ui.view = view;
      state.ui.search = q;
      $('#search-input').value = q;
    }
  }

  // Sidebar preferences (device-local, never synced).
  const [sidebarPref, sections] = await Promise.all([
    store.getDoc(store.keys.sidebarCollapsed),
    store.getDoc(store.keys.sectionCollapse),
  ]);
  sidebarCollapsedPref = sidebarPref === true;
  if (sections && typeof sections === 'object') {
    SECTION_NAMES.forEach(name => {
      if (typeof sections[name] === 'boolean') setSectionCollapsed(name, sections[name]);
    });
  }

  render();
  applySidebarState();

  // Persist right away on first run, or right after a migration.
  if (loaded.storedVersion !== SCHEMA_VERSION) saveState();

  startReminders();
  // Handy hook for tests and for anything that wants to wait for boot.
  window.__appReady = true;
}
init();
