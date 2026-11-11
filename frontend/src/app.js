import './styles.css';

import { settings, uid, $, $$, cleanRecurrence } from './core/app.js';
import { store } from './core/store.js';
import { parseDate, toISODate, todayISO, formatDue, reminderFireDate, cleanDuration } from './core/dates.js';
import { SCHEMA_VERSION, MIGRATIONS, defaultState, migrateState, state, setState, saveState, persistState, syncReminderSchedule, clearPendingUndo } from './core/state.js';
import { addTask, removeTask, toggleComplete, deleteTask, skipOccurrence, snoozeTask, parseRecurrenceText, recurrenceToText, firstRecurrenceISO, taskReminders, priorityColor, priorityLabel, projectName, labelName } from './core/tasks.js';
import { snapshotData, offerUndo, undoPending, redoPending } from './core/undo.js';
import { plural, showToast } from './core/toasts.js';
import { escapeHtml, PROJECT_COLORS, LABEL_COLORS } from './core/text.js';
import { services } from './core/services.js';
import { setRenderer } from './core/render.js';
import { loadSavedFilters, savedFilters, deleteFilter, openFilterEditor, initFilterEditor } from './features/filters.js';
import { initSelection } from './features/selection.js';
import { initCalendar } from './features/calendar.js';
import { renderMain, renderSortMenu, supportsBoard, initListView, completionDayLabel } from './views/list.js';
import { renderSidebar } from './views/sidebar.js';
import { initBoard } from './views/board.js';

/* ============================================================
   STORAGE
   All persistence goes through the adapter in storage.js. Moving to
   a backend later is a one-line change:
     const store = new TodoStore.ApiStore({ token });
============================================================ */

/* ============================================================
   STATE + PERSISTENCE
   Data lives in the browser for now (see storage.js). `version` is bumped whenever the
   shape changes; MIGRATIONS upgrades older payloads on load, so existing data is never thrown away.
============================================================ */


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


/* ------------------------------------------------------------
   REMINDER SCHEDULE FOR THE SERVICE WORKER
   The worker re-arms its timers from this list, so reminders can
   fire after the tab is closed (best effort — browsers may stop the
   worker at any time).
------------------------------------------------------------ */



/** Next occurrence strictly after the task's current due date. */

function reminderKey(t) {
  if (!t || !t.due) return '';
  const offsets = taskReminders(t).map(r => r.minutes).sort((a, b) => a - b).join(',');
  return `${t.due}|${t.dueTime || ''}|${offsets}`;
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
   SETTINGS
============================================================ */
const DEFAULT_SETTINGS = {
  theme: 'system',
  startOfWeek: 'mon',
  dateFormat: 'system',
  timeFormat: 'system',
  defaultPriority: null,
  defaultReminder: null,
};

const SETTINGS_DEFS = [
  { key: 'theme', label: 'Theme', options: [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']] },
  { key: 'startOfWeek', label: 'Week starts on', options: [['mon', 'Monday'], ['sun', 'Sunday']] },
  { key: 'dateFormat', label: 'Date format', options: [['system', 'System'], ['mdy', 'Nov 12, 2026'], ['dmy', '12 Nov 2026'], ['iso', '2026-11-12']] },
  { key: 'timeFormat', label: 'Time format', options: [['system', 'System'], ['12h', '12-hour'], ['24h', '24-hour']] },
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
    Object.assign(settings, DEFAULT_SETTINGS);
    return;
  }
  Object.assign(settings, {
    theme: ['light', 'dark', 'system'].includes(raw.theme) ? raw.theme : DEFAULT_SETTINGS.theme,
    startOfWeek: ['mon', 'sun'].includes(raw.startOfWeek) ? raw.startOfWeek : DEFAULT_SETTINGS.startOfWeek,
    dateFormat: ['system', 'mdy', 'dmy', 'iso'].includes(raw.dateFormat) ? raw.dateFormat : DEFAULT_SETTINGS.dateFormat,
    timeFormat: ['system', '12h', '24h'].includes(raw.timeFormat) ? raw.timeFormat : DEFAULT_SETTINGS.timeFormat,
    defaultPriority: [1, 2, 3, 4].includes(raw.defaultPriority) ? raw.defaultPriority : null,
    defaultReminder: raw.defaultReminder === null || raw.defaultReminder === undefined
      ? null
      : Number(raw.defaultReminder),
  });
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
   RENDERING
============================================================ */
function render() {
  renderSidebar();
  renderMain();
  renderStorageBadge();
  lucide.createIcons();
}

// The core asks for a repaint through this hook, so it never has to
// import the views (which would be a circular dependency).
setRenderer(render);

// The views reach the app-level features (dialogs, navigation) through
// this registry, for the same reason: the other way round would be a
// cycle.
services.openTaskModal = (id) => openTaskModal(id);
services.openQuickAdd = (defaults) => openQuickAdd(defaults);
services.navigateTo = (view) => navigateTo(view);
services.openRowMenu = (trigger, type, id) => openRowMenu(trigger, type, id);
services.closeMobileSidebar = () => closeMobileSidebar();
services.syncHash = () => syncHash();

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

  if (t.recurrence) {
    item('skip-occurrence', 'Skip this occurrence', 'calendar-off');
  }
  if (t.due) {
    item('snooze', 'Snooze until tomorrow', 'moon');
  }
  if (t.recurrence || t.due) sep();

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
  if (action === 'skip-occurrence') { const t = state.tasks.find(x => x.id === id); if (t) skipOccurrence(t); return; }
  if (action === 'snooze') { const t = state.tasks.find(x => x.id === id); if (t) snoozeTask(t); return; }
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
   TASK MUTATIONS
============================================================ */

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
const dueStartWrap = $('#due-start-wrap');
const dueStartInput = $('#due-start');

dueStartInput.addEventListener('change', () => {
  if (!modalDraft) return;
  modalDraft.startDate = dueStartInput.value || null;
  updateModalChips();
});

const REMINDER_OPTIONS = [
  [0, 'At time of due date'],
  [10, '10 minutes before'],
  [30, '30 minutes before'],
  [60, '1 hour before'],
  [120, '2 hours before'],
  [1440, '1 day before'],
];

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
  dueStartInput.value = t.startDate || '';
  dueStartWrap.classList.toggle('hidden', !t.recurrence);
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
  t.startDate = modalDraft.startDate || null;
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

const sortMenu = $('#sort-menu');

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
/**
 * Shows a transient message. `actionLabel` adds a button (used for
 * "Undo"); `onTimeout` runs when the toast expires on its own.
 */
/* ============================================================
   SCREEN READER ANNOUNCEMENTS
   Toasts are visual only, so the same message is repeated in a
   polite live region for assistive technology.
============================================================ */
/* ============================================================
   UNDO
   The pre-action data (not the UI) is snapshotted, so undo restores
   exactly what was there. Only the most recent action is undoable;
   any other save discards it — see saveState / clearPendingUndo.
============================================================ */

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

  setState({ ...imported, ui: { ...imported.ui, view: 'inbox', activeId: null, search: '' } });;
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
  setState({ ...incoming, ui: state.ui });;
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
  // The state loads from IndexedDB, so show a placeholder while it does.
  $('#loading-skeleton').classList.remove('hidden');

  // Filters must be known before the state is read: a saved filter can be
  // the active view, and the state loader validates the view name.
  await loadSavedFilters();

  const loaded = await loadState();
  setState(loaded.state);;

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
  $('#loading-skeleton').classList.add('hidden');
  applySidebarState();

  // Persist right away on first run, or right after a migration.
  if (loaded.storedVersion !== SCHEMA_VERSION) saveState();

  syncReminderSchedule();
  startReminders();
  // Handy hook for tests and for anything that wants to wait for boot.
  window.__appReady = true;
}

/* The views and features wire their own event handlers. */
initSelection();
initCalendar();
initBoard();
initFilterEditor();
initListView(() => renderMain());

init();

/* ============================================================
   TEST SURFACE
   The headless harness imports this module to drive the app, so the
   pieces it needs are exported (live bindings, so `state` stays live).
============================================================ */
export { state, settings, formatDue, parseQuickAdd, addTask, completionDayLabel, saveState };
