/**
 * Quick add: parse one line into a task (priority, project, labels, date,
 * repeat), preview the parsed bits as chips, and submit it.
 */
import { $, uid } from '../core/app.js';
import { state, saveState } from '../core/state.js';
import { toISODate, todayISO, formatDue } from '../core/dates.js';
import { addTask, parseRecurrence, recurrenceToText, firstRecurrenceISO, priorityColor, projectName, labelName } from '../core/tasks.js';
import { escapeHtml, LABEL_COLORS } from '../core/text.js';

const qaPlaceholder = $('#quick-add-placeholder');
const qaEditor = $('#quick-add-editor');
const qaCard = $('#quick-add-card');
const qaInput = $('#quick-add-input');
const qaPreview = $('#quick-add-preview');
const qaSuggest = $('#quick-add-suggest');
let quickAddDefaults = {};
// Chip edits layered on top of what the text parser understood.
let qaOverrides = {};
let qaPicker = null;
let qaSuggestItems = [];
let qaSuggestIndex = -1;
let qaMention = null; // { start, end, query }

export function isQuickAddOpen() {
  return !qaEditor.classList.contains('hidden');
}

export function openQuickAdd(defaults = {}) {
  quickAddDefaults = defaults || {};
  qaOverrides = {};
  qaPicker = null;
  closeLabelSuggest();
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
  closeLabelSuggest();
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
  updateLabelSuggest();
});

qaInput.addEventListener('click', () => { updateLabelSuggest(); });
qaInput.addEventListener('keyup', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateLabelSuggest();
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

function normalizeLabelName(name) {
  return String(name || '').replace(/^@/, '').trim();
}

function ensureLabelByName(name) {
  const clean = normalizeLabelName(name).replace(/\s+/g, '-');
  if (!clean) return null;
  const existing = state.labels.find(l => l.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing.id;
  const label = {
    id: 'lbl_' + uid(),
    name: clean,
    color: LABEL_COLORS[state.labels.length % LABEL_COLORS.length],
    pinned: false,
  };
  state.labels.push(label);
  return label.id;
}

function extractLabelMatches(text) {
  return [...String(text || '').matchAll(/(?:^|\s)@([\w-]+)/g)].map(m => ({ raw: m[0], name: m[1] }));
}

export function parseQuickAdd(text) {
  let title = text;
  let due = null, dueTime = null, recurrence = null, recurrenceMode = 'scheduled', priority = 4, projectId = null, sectionId = null, labels = [];

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

  // section: /name (assign within selected/current project)
  const sectionMatch = title.match(/(?:^|\s)\/([\w-]+)/);
  if (sectionMatch) {
    const secName = sectionMatch[1].replace(/_/g, '-').toLowerCase();
    const resolvedProjectId = projectId || (String(state.ui?.view || '').startsWith('project:') ? String(state.ui.view).slice(8) : null);
    const proj = state.projects.find(p => p.id === resolvedProjectId);
    const section = proj?.sections?.find(s => String(s.name || '').trim().toLowerCase().replace(/\s+/g, '-') === secName || String(s.name || '').trim().toLowerCase() === sectionMatch[1].toLowerCase());
    if (section) {
      projectId = proj.id;
      sectionId = section.id;
      title = title.replace(sectionMatch[0], '').trim();
    }
  }

  // labels: @name (existing labels in preview/parse; unknowns created on submit)
  const labelMatches = extractLabelMatches(title);
  labelMatches.forEach(m => {
    const name = m.name.toLowerCase();
    const lbl = state.labels.find(l => l.name.toLowerCase() === name);
    if (lbl) {
      labels.push(lbl.id);
      title = title.replace(m.raw, ' ').trim();
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
  return { title, due, dueTime, recurrence, recurrenceMode, priority, projectId, sectionId, labels };
}

/* ---------- @ label autocomplete (Quick Add) ---------- */
function getMentionAtCursor() {
  const text = qaInput.value || '';
  const caret = qaInput.selectionStart ?? text.length;
  const before = text.slice(0, caret);
  const m = /(^|\s)@([\w-]*)$/.exec(before);
  if (!m) return null;
  const query = m[2] || '';
  const start = before.length - query.length - 1; // position of '@'
  return { start, end: caret, query };
}

function closeLabelSuggest() {
  qaMention = null;
  qaSuggestItems = [];
  qaSuggestIndex = -1;
  if (qaSuggest) {
    qaSuggest.classList.add('hidden');
    qaSuggest.innerHTML = '';
  }
}

function renderLabelSuggest() {
  if (!qaSuggest || !qaMention) return;
  const query = qaMention.query.toLowerCase();
  const existing = [...state.labels]
    .filter(l => l.name.toLowerCase().includes(query))
    .slice(0, 8)
    .map(l => ({ type: 'existing', id: l.id, name: l.name, color: l.color }));
  const exact = query && state.labels.some(l => l.name.toLowerCase() === query);
  const createItem = query && !exact ? [{ type: 'create', name: qaMention.query }] : [];
  qaSuggestItems = [...existing, ...createItem].slice(0, 8);
  if (!qaSuggestItems.length) {
    closeLabelSuggest();
    return;
  }
  qaSuggestIndex = Math.min(Math.max(qaSuggestIndex, 0), qaSuggestItems.length - 1);
  qaSuggest.innerHTML = qaSuggestItems.map((item, i) => {
    const active = i === qaSuggestIndex ? ' active' : '';
    if (item.type === 'create') {
      return `<button type="button" class="qa-suggest-item${active}" data-qa-suggest-index="${i}" role="option" aria-selected="${i === qaSuggestIndex}"><i data-lucide="plus" class="w-3.5 h-3.5 text-td-muted"></i><span>Create label <strong>@${escapeHtml(item.name)}</strong></span></button>`;
    }
    return `<button type="button" class="qa-suggest-item${active}" data-qa-suggest-index="${i}" role="option" aria-selected="${i === qaSuggestIndex}"><i data-lucide="tag" class="w-3.5 h-3.5" style="color:${escapeHtml(item.color)}"></i><span>@${escapeHtml(item.name)}</span></button>`;
  }).join('');
  qaSuggest.classList.remove('hidden');
  if (window.lucide) lucide.createIcons({ nodes: [qaSuggest] });
}

function updateLabelSuggest() {
  const mention = getMentionAtCursor();
  if (!mention) {
    closeLabelSuggest();
    return;
  }
  qaMention = mention;
  qaSuggestIndex = 0;
  renderLabelSuggest();
}

function applyLabelSuggestion(item) {
  if (!qaMention || !item) return;
  const name = normalizeLabelName(item.name).replace(/\s+/g, '-');
  if (!name) return;
  const before = qaInput.value.slice(0, qaMention.start);
  const after = qaInput.value.slice(qaMention.end);
  const insertion = `@${name} `;
  qaInput.value = before + insertion + after.replace(/^\s*/, '');
  const caret = (before + insertion).length;
  qaInput.setSelectionRange(caret, caret);
  qaOverrides = {};
  updatePreview();
  closeLabelSuggest();
  qaInput.focus();
}

qaSuggest?.addEventListener('mousedown', (e) => {
  // prevent textarea blur before click handling
  e.preventDefault();
});
qaSuggest?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-qa-suggest-index]');
  if (!btn) return;
  const item = qaSuggestItems[Number(btn.dataset.qaSuggestIndex)];
  if (item) applyLabelSuggestion(item);
});

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
    sectionId: o.sectionId !== undefined ? o.sectionId : parsed.sectionId,
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
    const proj = state.projects.find(x => x.id === p.projectId);
    const section = proj?.sections?.find(s => s.id === p.sectionId);
    const text2 = section ? `${projectName(p.projectId)} / ${section.name}` : projectName(p.projectId);
    parts.push(qaChip('project', 'hash',
      `<i data-lucide="hash" class="w-3 h-3"></i>${escapeHtml(text2)}`));
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

  // Inline label creation: ensure any @tokens become real labels.
  const labelNames = extractLabelMatches(text).map(m => normalizeLabelName(m.name).replace(/\s+/g, '-')).filter(Boolean);
  if (labelNames.length) {
    let changed = false;
    labelNames.forEach(name => {
      if (!state.labels.some(l => l.name.toLowerCase() === name.toLowerCase())) {
        ensureLabelByName(name);
        changed = true;
      }
    });
    if (changed) saveState();
  }

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
  // section must belong to resolved project
  if (p.sectionId) {
    const proj = state.projects.find(x => x.id === p.projectId);
    if (!proj?.sections?.some(s => s.id === p.sectionId)) p.sectionId = null;
  }
  addTask(p);
  qaInput.value = '';
  qaInput.style.height = 'auto';
  qaPreview.innerHTML = '';
  qaOverrides = {};
  qaPicker = null;
  closeLabelSuggest();
  renderQaPicker();
  qaInput.focus();
}

$('#quick-add-submit').onclick = submitQuickAdd;
qaInput.addEventListener('keydown', (e) => {
  if (!qaSuggest?.classList.contains('hidden') && qaSuggestItems.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      qaSuggestIndex = (qaSuggestIndex + 1) % qaSuggestItems.length;
      renderLabelSuggest();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      qaSuggestIndex = (qaSuggestIndex - 1 + qaSuggestItems.length) % qaSuggestItems.length;
      renderLabelSuggest();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      applyLabelSuggestion(qaSuggestItems[qaSuggestIndex] || qaSuggestItems[0]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeLabelSuggest();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitQuickAdd(); }
  if (e.key === 'Escape') closeQuickAdd();
});

document.addEventListener('click', (e) => {
  if (e.target === qaInput || qaSuggest?.contains(e.target)) return;
  closeLabelSuggest();
});
