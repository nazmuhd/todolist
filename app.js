/* ============================================================
   STATE + PERSISTENCE
   Data lives in localStorage. `version` is bumped whenever the
   shape changes; MIGRATIONS upgrades older payloads on load and
   on import, so existing data is never thrown away.
============================================================ */
const STORAGE_KEY = 'todoist-clone-v1';
const SCHEMA_VERSION = 3;

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
    ui: { view: 'inbox', activeId: null, search: '', layout: 'list' },
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
    });
  });
  // A parent must exist and can't be the task itself.
  tasks.forEach(t => {
    if (t.parentId && (t.parentId === t.id || !taskIds.has(t.parentId))) t.parentId = null;
  });

  const rawUi = s.ui && typeof s.ui === 'object' ? s.ui : {};
  let view = asText(rawUi.view) || 'inbox';
  const knownView =
    view === 'inbox' || view === 'today' || view === 'upcoming' ||
    view === 'completed' || view === 'no-date' || view === 'no-priority' ||
    (view.startsWith('project:') && projectIds.has(view.slice(8))) ||
    (view.startsWith('label:') && labelIds.has(view.slice(6)));
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

// Only the most recent destructive action can be undone (like Todoist's toast).
let pendingUndo = null;

let state = loadState();

function loadState() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); }
  catch (err) {
    console.warn('localStorage unavailable:', err);
    return defaultState();
  }
  if (!raw) return defaultState();

  try {
    return migrateState(JSON.parse(raw));
  } catch (err) {
    console.warn('Saved data could not be read:', err);
    // Keep the unreadable payload instead of silently destroying it.
    try { localStorage.setItem(`${STORAGE_KEY}-corrupt-backup`, raw); } catch {}
    return defaultState();
  }
}

function persistState() {
  state.updatedAt = Date.now();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error('Could not save data:', err);
    showToast('Could not save — browser storage may be full', 'error');
  }
}

function saveState() {
  // Any new change supersedes a pending undo, so a stale snapshot can
  // never wipe out work done after the action it was captured for.
  clearPendingUndo();
  persistState();
}

// Persist right away on first run, or right after a migration.
(function persistAfterLoad() {
  let storedVersion = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    storedVersion = raw ? (JSON.parse(raw).version ?? 1) : null;
  } catch {}
  if (storedVersion !== SCHEMA_VERSION) saveState();
})();

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
  return view !== 'upcoming' && view !== 'completed' && !(state.ui.search || '').trim();
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
  return t && t.due ? `${t.due}|${t.dueTime || ''}|${t.reminderMinutes}` : '';
}
function reminderFireDate(t) {
  const d = taskReminderDate(t);
  if (!d) return null;
  d.setMinutes(d.getMinutes() - (t.reminderMinutes || 0));
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
    if (t.reminderMinutes === null || t.reminderMinutes === undefined) return;
    const key = reminderKey(t);
    if (!key || t.reminderFiredKey === key) return;
    const at = reminderFireDate(t);
    if (!at) return;
    const late = now - at.getTime();
    if (late < 0 || late > 12 * 60 * 60 * 1000) return;
    t.reminderFiredKey = key;
    persistState();
    notifyTask(t);
  });
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
    filter = (t) =>
      t.title.toLowerCase().includes(search) ||
      (t.description || '').toLowerCase().includes(search);
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
      <div class="group relative">
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

  // labels (pinned first)
  const ll = $('#labels-list');
  ll.innerHTML = [...state.labels]
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    .map(l => {
      const active = state.ui.view === `label:${l.id}`;
      return `
      <div class="group relative">
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
}

function showEmptyState(title, text, showCta = true) {
  $('#empty-state').classList.remove('hidden');
  $('#empty-title').textContent = title;
  $('#empty-text').textContent = text;
  $('#empty-cta').classList.toggle('hidden', !showCta);
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
  $('#empty-state').classList.add('hidden');
  $('#content-container').classList.remove('board-mode');

  // Upcoming gets day buckets instead of one flat list (no drag reorder).
  if (state.ui.view === 'upcoming' && !searchActive) {
    renderUpcoming(list);
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

  // Normal list views hide completed tasks; the Completed view is their home.
  const visible = activeTasks()
    .filter(info.filter)
    .filter(t => searchActive || !t.completed)
    .sort((a,b) => (a.completed - b.completed) || (a.order - b.order));

  if (!visible.length) {
    if (state.ui.search) {
      showEmptyState('No matches', 'Try a different word or clear the search.', false);
    } else if (info.title === 'Today') {
      showEmptyState('Nothing due today', 'You are all caught up for today.');
    } else if (info.title === 'No date') {
      showEmptyState('Everything has a date', 'No undated tasks right now.');
    } else if (info.title === 'No priority') {
      showEmptyState('Every task has a priority', 'No P4 tasks right now.');
    } else {
      showEmptyState('All clear', 'Add your first task to get started.');
    }
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
    showEmptyState('Nothing coming up', 'Tasks with a due date will appear here.');
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
    showEmptyState('Nothing due today', 'You are all caught up for today.');
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
    showEmptyState('No completed tasks yet', 'Finished tasks will appear here, ready to restore.', false);
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
          <div class="task-title cursor-pointer text-sm font-medium">${highlightHtml(t.title, searchTerm())}</div>
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
  const subs = !isSub && !opts.noSubtasks ? subtasksOf(t.id) : [];
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
          style="border-color:${t.completed ? '#808080' : checkColor}; ${t.completed ? 'background:#808080;' : ''}">
          ${t.completed ? '<i data-lucide="check" class="w-3 h-3 text-white"></i>' : ''}
        </button>
        <div class="task-content flex-1 min-w-0">
          <div class="task-title cursor-pointer text-sm ${completedClass}">${highlightHtml(t.title, searchTerm())}</div>
          ${t.description ? `<div class="text-xs text-td-muted mt-0.5 truncate-2">${highlightHtml(t.description, searchTerm())}</div>` : ''}
          <div class="flex flex-wrap items-center gap-2 text-xs mt-1">
            ${parentBadge}${dueBadge}${durationBadge(t)}${projBadge}${labelBadges}
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
      openInlineTitle(id);
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
  const task = {
    id: uid(),
    title: data.title || 'New task',
    description: data.description || '',
    due: data.due || null,
    dueTime: cleanDueTime(data.dueTime),
    recurrence: cleanRecurrence(data.recurrence),
    reminderMinutes: cleanReminderMinutes(
      data.reminderMinutes === undefined || data.reminderMinutes === null ? null : Number(data.reminderMinutes)
    ),
    reminderFiredKey: null,
    durationMinutes: cleanDuration(data.durationMinutes),
    priority: data.priority || 4,
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

function openTaskModal(id) {
  editingTaskId = id;
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  modalDraft = { ...t, labels: [...(t.labels || [])] };

  $('#modal-title').value = t.title;
  $('#modal-desc').value = t.description || '';
  $('#modal-duration').value = t.durationMinutes || '';
  updateModalChips();
  renderPriorityMenu();
  renderProjectMenu();
  renderLabelMenu();
  modal.showModal();
  // Don't open the on-screen keyboard on phones: it would cover the dialog.
  if (!isMobileSidebar()) setTimeout(() => $('#modal-title').focus(), 50);
}

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
      updateModalChips();
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
const dueReminderSelect = $('#due-reminder');

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
  dueReminderSelect.disabled = !t.due;
  setDueNlStatus(t.due ? `Selected: ${formatDue(t.due, t.dueTime)}` : 'No due date selected');
}

function syncDueEditor() {
  const t = modalDraft || {};
  dueTimeInput.value = t.dueTime || '';
  dueAllDayInput.checked = !t.dueTime;
  dueTimeInput.disabled = !t.dueTime;
  dueRepeatInput.value = t.recurrence ? recurrenceToText(t.recurrence) : '';
  dueReminderSelect.value = (t.reminderMinutes === null || t.reminderMinutes === undefined)
    ? '' : String(t.reminderMinutes);
  dueRepeatStatus.textContent = '';
  dueRepeatStatus.className = 'text-[11px] mt-0.5 min-h-[14px] text-td-muted';
  syncDueDateControls();
}

function setDueDate(iso) {
  modalDraft.due = iso || null;
  if (!iso) {
    modalDraft.dueTime = null;
    modalDraft.recurrence = null;
    modalDraft.reminderMinutes = null;
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
        modalDraft.reminderMinutes = null;
        dueTimeInput.value = '';
        dueAllDayInput.checked = true;
        dueTimeInput.disabled = true;
        dueRepeatInput.value = '';
        dueReminderSelect.value = '';
      }
      dueReminderSelect.disabled = !dateStr;
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
    return true;
  }
  const body = parseRecurrenceText(raw);
  if (!body) {
    dueRepeatStatus.textContent = 'Not sure what that means — try “every Monday”.';
    dueRepeatStatus.className = 'text-[11px] mt-0.5 min-h-[14px] text-red-600';
    return false;
  }
  modalDraft.recurrence = body;
  if (!modalDraft.due) setDueDate(todayISO());
  dueRepeatStatus.textContent = `Repeats: ${recurrenceToText(body)}`;
  dueRepeatStatus.className = 'text-[11px] mt-0.5 min-h-[14px] text-green-700';
  return true;
}

function commitDueEdits() {
  if (!modalDraft) return false;
  if (dueModal.open && !parseDueRepeatField()) return false;
  if (!modalDraft.due) {
    modalDraft.dueTime = null;
    modalDraft.recurrence = null;
    modalDraft.reminderMinutes = null;
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
dueReminderSelect.addEventListener('change', () => {
  const val = dueReminderSelect.value;
  modalDraft.reminderMinutes = val === '' ? null : Number(val);
  if (modalDraft.reminderMinutes !== null) ensureNotificationPermission();
  updateModalChips();
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
});

$$('.close-modal').forEach(b => b.onclick = () => modal.close());
modal.addEventListener('close', () => {
  editingTaskId = null;
  modalDraft = null;
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
  t.reminderMinutes = modalDraft.reminderMinutes;
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
let editingLabelId = null;
let labelDraftColor = null;

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
  renderColorSwatches($('#project-colors'), projectDraftColor, pickProjectColor);
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
  } else {
    state.projects.push({ id: 'proj_' + uid(), name, color: projectDraftColor });
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
  const entry = isProject
    ? state.projects.find(p => p.id === id)
    : state.labels.find(l => l.id === id);
  if (!entry) return;

  rowMenuTarget = { type, id };
  rowMenu.innerHTML = `
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
    else openLabelModal(id);
  } else {
    if (type === 'project') deleteProject(id);
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
function showToast(message, type = 'info', { actionLabel, onAction, duration = 2600, onTimeout } = {}) {
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

  state = normalizeState({
    ...state,
    projects: snapshot.projects,
    labels: snapshot.labels,
    tasks: snapshot.tasks,
  });
  saveState();
  render();
  showToast('Undone', 'success');
}

/* ============================================================
   DATA BACKUP (EXPORT / IMPORT)
============================================================ */
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

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `todoist-backup-${todayISO()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  showToast(`Exported ${plural(state.tasks.length, 'task')}`, 'success');
}

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

function applyBackup(imported) {
  const n = imported.tasks.length;
  const ok = confirm(
    `Replace your current data with this backup?\n\n` +
    `Backup contains ${plural(n, 'task')}, ${plural(imported.projects.length, 'project')} ` +
    `and ${plural(imported.labels.length, 'label')}.\n\n` +
    `Your current data is saved to a recovery slot first.`
  );
  if (!ok) return;

  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current) localStorage.setItem(`${STORAGE_KEY}-pre-import-backup`, current);
  } catch {}

  state = { ...imported, ui: { view: 'inbox', activeId: null, search: '' } };
  $('#search-input').value = '';
  saveState();
  render();
  showToast(`Imported ${plural(n, 'task')}`, 'success');
}

function renderStorageBadge() {
  const badge = $('#schema-badge');
  if (!badge) return;
  badge.textContent = `v${SCHEMA_VERSION}`;
  badge.title = `${plural(state.tasks.length, 'task')} stored in this browser · schema v${SCHEMA_VERSION}`;
}

$('#export-data-btn').onclick = exportData;
$('#import-data-btn').onclick = () => $('#import-file').click();
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow re-picking the same file
  if (!file) return;
  try {
    const result = parseBackup(await file.text());
    if (result.error) { showToast(result.error, 'error'); return; }
    applyBackup(result.state);
  } catch (err) {
    console.error('Import failed:', err);
    showToast('Could not read that file.', 'error');
  }
});

/* ============================================================
   CROSS-TAB SYNC
   Other tabs announce their saves through the `storage` event.
   We adopt their data but keep this tab's current view/search so
   the UI doesn't jump under the user.
============================================================ */
window.addEventListener('storage', (e) => {
  if (e.key !== STORAGE_KEY || e.newValue === null) return;

  let incoming;
  try { incoming = migrateState(JSON.parse(e.newValue)); }
  catch (err) { console.warn('Ignored malformed data from another tab:', err); return; }

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

  const dialogOpen = modal.open || projectModal.open || labelModal.open || dueModal.open || shortcutsModal.open;
  if (e.key === 'Escape') {
    // Handle every case ourselves; otherwise the browser would also
    // close the dialog while we only meant to dismiss the popover.
    e.preventDefault();
    if (dueModal.open) dueModal.close();
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
const SECTION_COLLAPSE_KEYS = {
  projects: 'todoist-clone-projects-collapsed',
  labels: 'todoist-clone-labels-collapsed',
};

function setSectionCollapsed(name, collapsed) {
  const list = $(`#${name}-list`);
  const btn = $(`#toggle-${name}`);
  if (!list || !btn) return;
  list.classList.toggle('hidden', collapsed);
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = `${collapsed ? 'Expand' : 'Collapse'} ${name}`;
  const icon = btn.querySelector('[data-lucide]');
  if (icon) icon.setAttribute('data-lucide', collapsed ? 'chevron-right' : 'chevron-down');
  try { localStorage.setItem(SECTION_COLLAPSE_KEYS[name], collapsed ? '1' : '0'); } catch {}
  lucide.createIcons();
}

Object.keys(SECTION_COLLAPSE_KEYS).forEach(name => {
  const btn = $(`#toggle-${name}`);
  if (!btn) return;
  btn.onclick = () => {
    const collapsed = !$(`#${name}-list`).classList.contains('hidden');
    setSectionCollapsed(name, collapsed);
  };
  let collapsed = false;
  try { collapsed = localStorage.getItem(SECTION_COLLAPSE_KEYS[name]) === '1'; } catch {}
  setSectionCollapsed(name, collapsed);
});

/* ============================================================
   SIDEBAR (desktop collapse rail, mobile drawer)
============================================================ */
const SIDEBAR_COLLAPSED_KEY = 'todoist-clone-sidebar-collapsed';
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
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch {}
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
function init() {
  render();
  try { sidebarCollapsedPref = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch {}
  applySidebarState();
  startReminders();
}
init();
