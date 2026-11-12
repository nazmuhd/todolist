/**
 * Data backup: JSON export/import plus CSV, Markdown and ICS exports.
 */
import { $, uid } from '../core/app.js';
import { state, setState, saveState, SCHEMA_VERSION, migrateState, normalizeState } from '../core/state.js';
import { store } from '../core/store.js';
import { toISODate, todayISO, parseDate } from '../core/dates.js';
import { projectName, labelName, recurrenceToText, parseRecurrence } from '../core/tasks.js';
import { plural, showToast } from '../core/toasts.js';
import { escapeHtml } from '../core/text.js';
import { requestRender } from '../core/render.js';
import { services } from '../core/services.js';
import { clearUndoHistory } from '../core/undo.js';

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
      templates: state.templates || [],
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
  const header = ['title', 'project', 'labels', 'priority', 'due', 'time', 'deadline', 'start', 'repeat', 'repeat_mode', 'timezone', 'completed', 'created'];
  const rows = state.tasks.map(t => [
    t.title,
    t.projectId ? projectName(t.projectId) : '',
    (t.labels || []).map(labelName).join(' '),
    `P${t.priority}`,
    t.due || '',
    t.dueTime || '',
    t.deadline || '',
    t.startDate || '',
    t.recurrence ? recurrenceToText(t.recurrence) : '',
    t.recurrence ? (t.recurrenceMode === 'completion' ? 'completion' : 'due') : '',
    t.timeZone || '',
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
        if (t.deadline) bits.push(`deadline ${t.deadline}`);
        if (t.startDate) bits.push(`starts ${t.startDate}`);
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

export function isExportOpen() {
  return exportModal.open;
}

export function closeExport() {
  if (exportModal.open) exportModal.close();
}

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

/* ---------- Todoist backup import ---------- */

const TODOIST_COLORS = {
  berry_red: '#b8256f', red: '#db4c3f', orange: '#ff9a14', yellow: '#ffc400',
  olive_green: '#afb83b', lime_green: '#7ecc49', green: '#299438',
  mint_green: '#6accbc', teal: '#158fad', sky_blue: '#14aaf5',
  light_blue: '#96c3eb', blue: '#4073ff', grape: '#884dff', violet: '#af38eb',
  lavender: '#eb96eb', magenta: '#e05194', salmon: '#ff8d85',
  charcoal: '#808080', grey: '#b8b8b8', taupe: '#ccac93',
};

function todoistColor(value) {
  if (typeof value !== 'string' || !value) return undefined;
  if (value.startsWith('#')) return value;
  return TODOIST_COLORS[value] || undefined;
}

/** Todoist stores priority as 4 = highest; this app uses 1 = highest. */
function todoistPriority(value) {
  const p = Number(value);
  return p >= 1 && p <= 4 ? 5 - p : 4;
}

/** Splits a Todoist due/deadline object into our date and time fields. */
function todoistWhen(value) {
  if (!value || typeof value !== 'object') return { date: null, time: null, timeZone: null, text: '' };
  const raw = String(value.datetime || value.date || '');
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  return {
    date: match ? match[1] : null,
    time: match ? `${match[2]}:${match[3]}` : null,
    timeZone: typeof value.timezone === 'string' && value.timezone ? value.timezone : null,
    text: typeof value.string === 'string' ? value.string : '',
  };
}

function todoistDuration(value) {
  if (!value || typeof value !== 'object') return null;
  const amount = Number(value.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = String(value.unit || 'minute').toLowerCase();
  const minutes = unit.startsWith('hour') ? amount * 60
    : unit.startsWith('day') ? amount * 1440
      : amount;
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null;
}

function todoistTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function todoistReminder(reminder, index) {
  if (!reminder || reminder.is_deleted) return null;
  const id = `tdr_${reminder.id || index}`;
  const type = String(reminder.type || (reminder.minute_offset != null ? 'relative' : ''));
  if (type === 'relative' || reminder.minute_offset != null) {
    const minutes = Number(reminder.minute_offset);
    if (Number.isFinite(minutes) && minutes >= 0) return { id, minutes };
  }
  if (type === 'absolute' && reminder.due) {
    const when = todoistWhen(reminder.due);
    if (when.date) return { id, at: `${when.date}T${when.time || '09:00'}` };
  }
  return null;
}

/**
 * Converts a Todoist JSON backup (the Sync-API-shaped export with `items`,
 * `projects`, `sections`, `labels`, `notes` and `reminders`) into this app's
 * state shape. Unknown fields are ignored; normalizeState repairs the rest.
 */
export function todoistBackupToState(raw) {
  const source = raw && raw.data && Array.isArray(raw.data.items) ? raw.data : raw;
  const projectsRaw = Array.isArray(source.projects) ? source.projects.filter(p => p && !p.is_deleted) : [];
  const sectionsRaw = Array.isArray(source.sections) ? source.sections.filter(s => s && !s.is_deleted) : [];
  const itemsRaw = Array.isArray(source.items) ? source.items.filter(i => i && !i.is_deleted) : [];
  const labelsRaw = Array.isArray(source.labels) ? source.labels.filter(l => l && !l.is_deleted) : [];
  const notesRaw = Array.isArray(source.notes) ? source.notes.filter(n => n && !n.is_deleted) : [];
  const remindersRaw = Array.isArray(source.reminders) ? source.reminders : [];

  const projectByTodoist = new Map();
  projectsRaw.forEach(p => projectByTodoist.set(String(p.id), p));
  const projectId = todoistId => (todoistId !== undefined && todoistId !== null && todoistId !== ''
    ? `tdp_${todoistId}` : null);

  // Flatten Todoist's project hierarchy into readable names.
  const nameCache = new Map();
  const fullProjectName = (todoistId, depth = 0) => {
    const key = String(todoistId);
    if (nameCache.has(key)) return nameCache.get(key);
    const p = projectByTodoist.get(key);
    if (!p) return '';
    let name = String(p.name || '').trim() || 'Project';
    if (p.parent_id && depth < 5) {
      const parent = fullProjectName(p.parent_id, depth + 1);
      if (parent) name = `${parent} / ${name}`;
    }
    nameCache.set(key, name);
    return name;
  };

  const projectIds = new Set([...projectByTodoist.keys()].map(projectId));

  const sectionsByProject = new Map();
  const sectionOwner = new Map();
  sectionsRaw.forEach((s) => {
    const pid = projectId(s.project_id);
    if (!pid || !projectIds.has(pid)) return;
    const sid = `tds_${s.id}`;
    sectionOwner.set(sid, pid);
    if (!sectionsByProject.has(pid)) sectionsByProject.set(pid, []);
    sectionsByProject.get(pid).push({ id: sid, name: String(s.name || '').trim() || 'Section' });
  });

  const projects = projectsRaw.map(p => ({
    id: projectId(p.id),
    name: fullProjectName(p.id),
    color: todoistColor(p.color),
    sections: sectionsByProject.get(projectId(p.id)) || [],
  }));

  // Labels are referenced by name on items, so collect both sources.
  const labelByName = new Map();
  const labels = [];
  const ensureLabel = (name, color) => {
    const clean = String(name || '').trim().replace(/^@/, '');
    if (!clean) return null;
    const key = clean.toLowerCase();
    if (labelByName.has(key)) return labelByName.get(key);
    const id = `tdl_${uid()}`;
    labelByName.set(key, id);
    labels.push({ id, name: clean, color: todoistColor(color) });
    return id;
  };
  labelsRaw.forEach(l => ensureLabel(l.name, l.color));

  const notesByItem = new Map();
  notesRaw.forEach((note) => {
    const key = String(note.item_id);
    if (!notesByItem.has(key)) notesByItem.set(key, []);
    notesByItem.get(key).push(note);
  });
  const remindersByItem = new Map();
  remindersRaw.forEach((reminder) => {
    if (!reminder || reminder.is_deleted || reminder.type === 'location') return;
    const key = String(reminder.item_id);
    if (!remindersByItem.has(key)) remindersByItem.set(key, []);
    remindersByItem.get(key).push(reminder);
  });

  const tasks = itemsRaw.map((item, index) => {
    const due = todoistWhen(item.due);
    const deadline = todoistWhen(item.deadline);
    let recurrence = null;
    let recurrenceMode = 'scheduled';
    if (item.due && item.due.is_recurring && due.text) {
      const parsed = parseRecurrence(due.text);
      recurrence = parsed.body;
      recurrenceMode = parsed.mode;
    }

    const labelIds = [];
    (Array.isArray(item.labels) ? item.labels : []).forEach((name) => {
      const id = ensureLabel(name);
      if (id && !labelIds.includes(id)) labelIds.push(id);
    });

    const notes = notesByItem.get(String(item.id)) || [];
    const reminders = remindersByItem.get(String(item.id)) || [];
    const order = Number(item.child_order);
    const completedAt = todoistTimestamp(item.completed_at);

    return {
      id: `tdt_${item.id}`,
      title: String(item.content || '').trim() || 'Untitled',
      description: String(item.description || ''),
      due: due.date,
      dueTime: due.time,
      timeZone: due.timeZone,
      deadline: deadline.date,
      deadlineTime: deadline.time,
      recurrence,
      recurrenceMode,
      priority: todoistPriority(item.priority),
      projectId: projectId(item.project_id),
      sectionId: (() => {
        const sid = item.section_id != null ? `tds_${item.section_id}` : null;
        return sid && sectionOwner.get(sid) === projectId(item.project_id) ? sid : null;
      })(),
      parentId: item.parent_id != null ? `tdt_${item.parent_id}` : null,
      labels: labelIds,
      completed: item.checked === 1 || item.checked === true || Boolean(item.completed_at),
      completedAt,
      order: Number.isFinite(order) ? order : index,
      createdAt: todoistTimestamp(item.added_at) || Date.now(),
      durationMinutes: todoistDuration(item.duration),
      reminders: reminders.map(todoistReminder).filter(Boolean),
      comments: notes.map((note, i) => ({
        id: `tdn_${note.id || i}`,
        text: String(note.content || ''),
        createdAt: todoistTimestamp(note.posted_at) || Date.now(),
      })),
    };
  });

  return normalizeState({
    version: SCHEMA_VERSION,
    projects,
    labels,
    tasks,
    templates: [],
  });
}

/** True for Todoist's Sync-API-shaped JSON export. */
function isTodoistBackup(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const data = raw.data && Array.isArray(raw.data.items) ? raw.data : raw;
  return Array.isArray(data.items) && (Array.isArray(data.projects) || Array.isArray(data.sections) || Array.isArray(data.labels));
}

/** Reads a backup's text and returns { state, source } or { error }. */
export function parseBackup(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch { return { error: 'That file is not valid JSON.' }; }

  // A Todoist JSON export (items/projects/sections/labels) has a different
  // shape from this app's backup and is converted first.
  if (isTodoistBackup(raw)) {
    let imported;
    try {
      imported = todoistBackupToState(raw);
    } catch (err) {
      return { error: err.message || 'Could not read that Todoist backup.' };
    }
    const sourceItems = raw.data && Array.isArray(raw.data.items) ? raw.data.items : raw.items;
    if (Array.isArray(sourceItems) && sourceItems.length > 0 && imported.tasks.length === 0) {
      return { error: 'No usable tasks were found in that Todoist backup.' };
    }
    return { state: imported, source: 'todoist' };
  }

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
      templates: data.templates,
    });
  } catch (err) {
    return { error: err.message || 'Could not read that backup.' };
  }

  if (data.tasks.length > 0 && imported.tasks.length === 0) {
    return { error: 'No usable tasks were found in that backup.' };
  }
  return { state: imported };
}

async function applyBackup(imported, source) {
  const n = imported.tasks.length;
  const origin = source === 'todoist' ? 'Todoist backup' : 'backup';
  const ok = confirm(
    `Replace your current data with this ${origin}?\n\n` +
    `It contains ${plural(n, 'task')}, ${plural(imported.projects.length, 'project')} ` +
    `and ${plural(imported.labels.length, 'label')}.\n\n` +
    `Your current data is saved to a recovery slot first.`
  );
  if (!ok) return;

  try {
    await store.backupState('pre-import-backup');
  } catch {}

  clearUndoHistory();
  setState({ ...imported, ui: { ...imported.ui, view: 'inbox', activeId: null, search: '' } });
  $('#search-input').value = '';
  saveState();
  requestRender();
  services.syncHash();
  showToast(`Imported ${plural(n, 'task')}${source === 'todoist' ? ' from Todoist' : ''}`, 'success');
}

export function renderStorageBadge() {
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
    await applyBackup(result.state, result.source);
  } catch (err) {
    console.error('Import failed:', err);
    showToast('Could not read that file.', 'error');
  }
});
