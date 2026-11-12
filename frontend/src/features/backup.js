/**
 * Data backup: JSON export/import plus CSV, Markdown and ICS exports.
 */
import { $ } from '../core/app.js';
import { state, setState, saveState, SCHEMA_VERSION, migrateState } from '../core/state.js';
import { store } from '../core/store.js';
import { toISODate, todayISO, parseDate } from '../core/dates.js';
import { projectName, labelName, recurrenceToText } from '../core/tasks.js';
import { plural, showToast } from '../core/toasts.js';
import { escapeHtml } from '../core/text.js';
import { requestRender } from '../core/render.js';
import { services } from '../core/services.js';

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

/** Reads a backup's text and returns { state } or { error }. */
export function parseBackup(text) {
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

  setState({ ...imported, ui: { ...imported.ui, view: 'inbox', activeId: null, search: '' } });
  $('#search-input').value = '';
  saveState();
  requestRender();
  services.syncHash();
  showToast(`Imported ${plural(n, 'task')}`, 'success');
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
    await applyBackup(result.state);
  } catch (err) {
    console.error('Import failed:', err);
    showToast('Could not read that file.', 'error');
  }
});
