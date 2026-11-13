/**
 * Quick add: parse one line into a task (priority, project, labels, date,
 * repeat), preview the parsed bits as chips, and submit it.
 */
import { $ } from '../core/app.js';
import { state } from '../core/state.js';
import { toISODate, todayISO, formatDue } from '../core/dates.js';
import { addTask, parseRecurrence, recurrenceToText, firstRecurrenceISO, priorityColor, projectName, labelName } from '../core/tasks.js';
import { escapeHtml } from '../core/text.js';

const qaPlaceholder = $('#quick-add-placeholder');
const qaEditor = $('#quick-add-editor');
const qaCard = $('#quick-add-card');
const qaInput = $('#quick-add-input');
const qaPreview = $('#quick-add-preview');
let quickAddDefaults = {};
// Chip edits layered on top of what the text parser understood.
let qaOverrides = {};
let qaPicker = null;

export function isQuickAddOpen() {
  return !qaEditor.classList.contains('hidden');
}

export function openQuickAdd(defaults = {}) {
  quickAddDefaults = defaults || {};
  qaOverrides = {};
  qaPicker = null;
  renderQaPicker();
  qaPlaceholder.classList.add('hidden');
  qaEditor.classList.remove('hidden');
  qaCard?.classList.add('expanded');
  qaInput.value = '';
  qaPreview.innerHTML = '';
  qaInput.style.height = 'auto';
  qaInput.focus();
  updatePreview();
}

export function closeQuickAdd() {
  quickAddDefaults = {};
  qaOverrides = {};
  qaPicker = null;
  renderQaPicker();
  qaPlaceholder.classList.remove('hidden');
  qaEditor.classList.add('hidden');
  qaCard?.classList.remove('expanded');
}
qaPlaceholder.onclick = () => openQuickAdd();
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
  const isRecurrenceToken = (tok) => RECURRENCE_TOKEN_RE.test(tok.replace(/[,;!]+$/, ''));

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].toLowerCase().replace(/!$/, '') !== 'every') continue;
    // Consume only words that can belong to a repeat phrase. Unknown words
    // (e.g. "with team") stay in the task title.
    let end = i + 1;
    while (end < tokens.length && isRecurrenceToken(tokens[end])) end++;
    for (let len = end - i; len >= 1; len--) {
      const candidate = tokens.slice(i, i + len).join(' ');
      const parsed = parseRecurrence(candidate);
      if (parsed.body) {
        const rest = [...tokens.slice(0, i), ...tokens.slice(i + len)].join(' ');
        return { ...parsed, rest };
      }
    }
  }
  return null;
}

export function parseQuickAdd(text) {
  let title = text;
  let due = null, dueTime = null, recurrence = null, recurrenceMode = 'scheduled', priority = 4, projectId = null, labels = [];

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
    recurrenceMode = rec.mode;
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
  return { title, due, dueTime, recurrence, recurrenceMode, priority, projectId, labels };
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
    recurrenceMode: o.recurrenceMode !== undefined ? o.recurrenceMode : parsed.recurrenceMode,
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
          <span style="color:${escapeHtml(priorityColor(pr))}">&#9873;</span>P${pr}
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
    const parsed = raw ? parseRecurrence(raw) : { body: null, mode: 'scheduled' };
    qaOverrides.recurrence = parsed.body;
    qaOverrides.recurrenceMode = parsed.mode;
    refreshQa();
  }
});

export function submitQuickAdd() {
  const text = qaInput.value.trim();
  if (!text) { closeQuickAdd(); return; }
  const p = applyQaOverrides(parseQuickAdd(text));
  if (!p.title) { closeQuickAdd(); return; }
  // Empty-state shortcuts can prefill context (e.g. Today adds a due date).
  if (!p.due && quickAddDefaults.due) p.due = quickAddDefaults.due;
  if (!p.dueTime && quickAddDefaults.dueTime) p.dueTime = quickAddDefaults.dueTime;
  if (!p.durationMinutes && quickAddDefaults.durationMinutes) p.durationMinutes = quickAddDefaults.durationMinutes;
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
