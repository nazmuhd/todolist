/**
 * Reusable task and project templates.
 *
 * Project templates store a detached snapshot of project structure and tasks.
 * Task dates are stored as day offsets relative to `savedAt` so they can be
 * recreated with the same relative spacing when the template is applied.
 */
import { $, uid } from '../core/app.js';
import { state, saveState } from '../core/state.js';
import { addTask, firstRecurrenceISO, cleanRecurrenceMode } from '../core/tasks.js';
import { todayISO, cleanDuration, cleanTimeZone, cleanDueTime, parseDate, toISODate, DATE_RE } from '../core/dates.js';
import { requestRender } from '../core/render.js';
import { showToast } from '../core/toasts.js';
import { escapeHtml } from '../core/text.js';
import { services } from '../core/services.js';

function templateList() {
  if (!Array.isArray(state.templates)) state.templates = [];
  return state.templates;
}

function asText(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }
function cleanId(v) { return asText(v).trim(); }
function cleanOffset(v) { return Number.isInteger(v) ? v : null; }
function cloneJson(v, fallback) { try { return JSON.parse(JSON.stringify(v)); } catch { return fallback; } }

function daysBetween(fromISO, toISO) {
  const a = parseDate(fromISO);
  const b = parseDate(toISO);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function shiftISO(baseISO, offset) {
  if (!DATE_RE.test(asText(baseISO)) || !Number.isInteger(offset)) return null;
  const d = parseDate(baseISO);
  d.setDate(d.getDate() + offset);
  return toISODate(d);
}

function dateOffset(anchorISO, value) {
  if (!DATE_RE.test(asText(anchorISO)) || !DATE_RE.test(asText(value))) return null;
  return daysBetween(anchorISO, value);
}

function projectLayout(projectId) {
  // Layout is global in this app; keep current layout as a template hint.
  return state.ui?.layout === 'board' || state.ui?.layout === 'table' ? state.ui.layout : 'list';
}

function sanitizeTemplateTask(task, anchorISO, sectionIdToTempId, taskIdToTempId) {
  return {
    tempId: taskIdToTempId.get(task.id) || uid(),
    parentTempId: task.parentId ? (taskIdToTempId.get(task.parentId) || null) : null,
    sectionTempId: task.sectionId ? (sectionIdToTempId.get(task.sectionId) || null) : null,
    title: asText(task.title).trim() || 'Untitled',
    description: asText(task.description),
    priority: Number.isInteger(task.priority) ? task.priority : 4,
    customPriorityId: cleanId(task.customPriorityId) || null,
    labels: [...new Set((Array.isArray(task.labels) ? task.labels : []).map(cleanId).filter(Boolean))],
    dueOffset: dateOffset(anchorISO, task.due),
    dueTime: cleanDueTime(task.dueTime),
    deadlineOffset: dateOffset(anchorISO, task.deadline),
    deadlineTime: cleanDueTime(task.deadlineTime),
    startOffset: dateOffset(anchorISO, task.startDate),
    recurrence: task.recurrence || null,
    recurrenceMode: cleanRecurrenceMode(task.recurrenceMode),
    recurrenceEnd: cloneJson(task.recurrenceEnd ?? null, null),
    timeZone: cleanTimeZone(task.timeZone),
    reminders: cloneJson(Array.isArray(task.reminders) ? task.reminders : [], []),
    durationMinutes: cleanDuration(task.durationMinutes),
    comments: cloneJson(Array.isArray(task.comments) ? task.comments : [], []),
    attachments: cloneJson(Array.isArray(task.attachments) ? task.attachments : [], []),
    order: typeof task.order === 'number' ? task.order : 0,
  };
}

export function projectTemplateDraft(projectId) {
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return null;
  const projectTasks = state.tasks.filter(t => t.projectId === projectId);
  const anchorISO = todayISO();
  const sectionIdToTempId = new Map((project.sections || []).map(s => [s.id, uid()]));
  const taskIdToTempId = new Map(projectTasks.map(t => [t.id, uid()]));

  return {
    id: 'tpl_' + uid(),
    kind: 'project',
    name: project.name,
    description: '',
    color: project.color || '#246fe0',
    layout: projectLayout(projectId),
    savedAt: anchorISO,
    sections: (project.sections || []).map(s => ({ tempId: sectionIdToTempId.get(s.id), name: asText(s.name).trim() || 'Untitled section' })),
    tasks: projectTasks
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map(t => sanitizeTemplateTask(t, anchorISO, sectionIdToTempId, taskIdToTempId)),
  };
}

/** Saves the fields of an edited task as a reusable task template. */
export function saveTaskTemplate(task) {
  if (!task) return null;
  const name = String(task.title || '').trim() || 'Task template';
  const savedAt = todayISO();
  const template = {
    id: 'tpl_' + uid(),
    kind: 'task',
    name,
    description: '',
    savedAt,
    title: name,
    body: asText(task.description),
    priority: task.priority || 4,
    projectId: task.projectId || null,
    labels: [...(task.labels || [])],
    durationMinutes: cleanDuration(task.durationMinutes),
    recurrence: task.recurrence || null,
    recurrenceMode: cleanRecurrenceMode(task.recurrenceMode),
    timeZone: cleanTimeZone(task.timeZone),
    dueOffset: dateOffset(savedAt, task.due),
    dueTime: cleanDueTime(task.dueTime),
    deadlineOffset: dateOffset(savedAt, task.deadline),
    deadlineTime: cleanDueTime(task.deadlineTime),
    startOffset: dateOffset(savedAt, task.startDate),
    reminders: cloneJson(Array.isArray(task.reminders) ? task.reminders : [], []),
  };
  templateList().push(template);
  saveState();
  requestRender();
  showToast(`Template saved: ${name}`, 'success');
  return template;
}

export function saveProjectTemplate(projectId, meta = {}) {
  const draft = projectTemplateDraft(projectId);
  if (!draft) return null;
  const template = {
    ...draft,
    id: cleanId(meta.id) || draft.id,
    name: asText(meta.name).trim() || draft.name,
    description: asText(meta.description).trim(),
    color: asText(meta.color).trim() || draft.color,
    layout: ['list', 'board', 'table'].includes(meta.layout) ? meta.layout : draft.layout,
  };
  templateList().push(template);
  saveState();
  requestRender();
  showToast(`Project template saved: ${template.name}`, 'success');
  return template;
}

export function duplicateTemplate(id) {
  const template = templateList().find(t => t.id === id);
  if (!template) return null;
  const copy = cloneJson(template, null);
  if (!copy) return null;
  copy.id = 'tpl_' + uid();
  copy.name = `${asText(copy.name).trim() || 'Template'} copy`;
  templateList().push(copy);
  saveState();
  requestRender();
  showToast(`Template duplicated: ${copy.name}`, 'success');
  return copy;
}

export function updateTemplate(id, patch = {}) {
  const template = templateList().find(t => t.id === id);
  if (!template) return null;
  if (patch.name !== undefined) template.name = asText(patch.name).trim() || template.name;
  if (patch.description !== undefined) template.description = asText(patch.description).trim();
  if (patch.color !== undefined && template.kind === 'project') template.color = asText(patch.color).trim() || template.color;
  if (patch.layout !== undefined && template.kind === 'project' && ['list', 'board', 'table'].includes(patch.layout)) template.layout = patch.layout;
  saveState();
  requestRender();
  showToast(`Template updated: ${template.name}`, 'success');
  return template;
}

export async function deleteTemplate(id) {
  services.closeRowMenu?.();
  const template = templateList().find(t => t.id === id);
  if (!template) return false;
  const confirmed = services.confirmDialog
    ? await services.confirmDialog({
        title: 'Delete template',
        message: `Delete template "${template.name}"?`,
        confirmText: 'Delete template',
        danger: true,
      })
    : false;
  if (!confirmed) return false;

  state.templates = templateList().filter(t => t.id !== id);
  saveState();
  requestRender();
  showToast('Template deleted', 'info');
  return true;
}

function newId(prefix) { return `${prefix}_${uid()}`; }

function applyDateOffset(anchorApplyISO, offset) {
  if (!Number.isInteger(offset)) return null;
  return shiftISO(anchorApplyISO, offset);
}

function shiftRecurrenceEnd(end, anchorApplyISO, savedAt) {
  const e = cloneJson(end ?? null, null);
  if (!e || typeof e !== 'object') return e;
  if (DATE_RE.test(asText(e.date)) && DATE_RE.test(asText(savedAt))) {
    const off = daysBetween(savedAt, e.date);
    if (Number.isInteger(off)) e.date = applyDateOffset(anchorApplyISO, off);
  }
  return e;
}

function labelsThatExist(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map(cleanId).filter(id => state.labels.some(l => l.id === id)))];
}

export function applyTemplate(id) {
  const template = templateList().find(t => t.id === id);
  if (!template) return false;
  const applyAnchor = todayISO();

  if (template.kind === 'project') {
    const projectId = newId('proj');
    const sectionMap = new Map();
    const sections = (Array.isArray(template.sections) ? template.sections : []).map(s => {
      const sectionId = newId('sec');
      const key = cleanId(s.tempId || s.name);
      if (key) sectionMap.set(key, sectionId);
      if (s.name) sectionMap.set(asText(s.name), sectionId);
      return { id: sectionId, name: asText(s.name).trim() || 'Untitled section' };
    });
    state.projects.push({ id: projectId, name: asText(template.name).trim() || 'Project', color: asText(template.color) || '#246fe0', sections });

    const taskIdMap = new Map();
    const items = (Array.isArray(template.tasks) ? template.tasks : []).map((item, i) => ({ ...item, _i: i }));
    for (const item of items) {
      const oldId = cleanId(item.tempId || item.id || item._i);
      taskIdMap.set(oldId, uid());
    }

    // Create parents before children by order; subtasks have parentTempId.
    const sorted = [...items].sort((a, b) => (a.parentTempId ? 1 : 0) - (b.parentTempId ? 1 : 0) || (a.order || 0) - (b.order || 0) || a._i - b._i);
    for (const item of sorted) {
      const oldId = cleanId(item.tempId || item.id || item._i);
      const taskId = taskIdMap.get(oldId) || uid();
      const parentId = item.parentTempId ? (taskIdMap.get(cleanId(item.parentTempId)) || null) : null;
      const sectionId = item.sectionTempId ? (sectionMap.get(cleanId(item.sectionTempId)) || null) : (item.section ? (sectionMap.get(asText(item.section)) || null) : null);
      const due = Number.isInteger(item.dueOffset) ? applyDateOffset(applyAnchor, item.dueOffset) : null;
      const deadline = Number.isInteger(item.deadlineOffset) ? applyDateOffset(applyAnchor, item.deadlineOffset) : null;
      const startDate = Number.isInteger(item.startOffset) ? applyDateOffset(applyAnchor, item.startOffset) : null;

      state.tasks.push({
        id: taskId,
        title: asText(item.title).trim() || 'Untitled',
        description: asText(item.description),
        due,
        dueTime: cleanDueTime(item.dueTime),
        deadline,
        deadlineTime: cleanDueTime(item.deadlineTime),
        startDate,
        recurrence: item.recurrence || null,
        recurrenceMode: cleanRecurrenceMode(item.recurrenceMode),
        recurrenceEnd: shiftRecurrenceEnd(item.recurrenceEnd ?? null, applyAnchor, template.savedAt),
        timeZone: cleanTimeZone(item.timeZone),
        reminderMinutes: null,
        reminderFiredKey: null,
        reminders: cloneJson(Array.isArray(item.reminders) ? item.reminders : [], []),
        durationMinutes: cleanDuration(item.durationMinutes),
        priority: Number.isInteger(item.priority) ? item.priority : 4,
        customPriorityId: cleanId(item.customPriorityId) || null,
        projectId,
        labels: labelsThatExist(item.labels),
        parentId,
        completed: false,
        completedAt: null,
        order: typeof item.order === 'number' ? item.order : 0,
        createdAt: Date.now(),
        sectionId,
        comments: cloneJson(Array.isArray(item.comments) ? item.comments : [], []),
        skippedDates: [],
        exceptions: [],
        attachments: cloneJson(Array.isArray(item.attachments) ? item.attachments : [], []),
      });
    }

    saveState();
    requestRender();
    services.navigateTo(`project:${projectId}`);
    services.closeMobileSidebar?.();
    showToast(`Created ${template.name}`, 'success');
    return true;
  }

  const recurrence = template.recurrence || null;
  const due = Number.isInteger(template.dueOffset)
    ? applyDateOffset(applyAnchor, template.dueOffset)
    : (recurrence ? (firstRecurrenceISO(recurrence, applyAnchor) || applyAnchor) : null);
  const task = {
    id: uid(),
    title: asText(template.title || template.name).trim() || 'Untitled',
    description: asText(template.body ?? template.description ?? ''),
    due,
    dueTime: cleanDueTime(template.dueTime),
    deadline: Number.isInteger(template.deadlineOffset) ? applyDateOffset(applyAnchor, template.deadlineOffset) : null,
    deadlineTime: cleanDueTime(template.deadlineTime),
    startDate: Number.isInteger(template.startOffset) ? applyDateOffset(applyAnchor, template.startOffset) : null,
    recurrence,
    recurrenceMode: cleanRecurrenceMode(template.recurrenceMode),
    recurrenceEnd: shiftRecurrenceEnd(template.recurrenceEnd ?? null, applyAnchor, template.savedAt),
    timeZone: cleanTimeZone(template.timeZone),
    reminderMinutes: null,
    reminderFiredKey: null,
    reminders: cloneJson(Array.isArray(template.reminders) ? template.reminders : [], []),
    durationMinutes: cleanDuration(template.durationMinutes),
    priority: Number.isInteger(template.priority) ? template.priority : 4,
    customPriorityId: cleanId(template.customPriorityId) || null,
    projectId: state.projects.some(p => p.id === template.projectId) ? template.projectId : null,
    labels: labelsThatExist(template.labels),
    parentId: null,
    completed: false,
    completedAt: null,
    order: (state.tasks.filter(t => !t.parentId).reduce((m, t) => Math.max(m, t.order || 0), -1) + 1),
    createdAt: Date.now(),
    sectionId: null,
    comments: [],
    skippedDates: [],
    exceptions: [],
    attachments: [],
  };
  state.tasks.push(task);
  saveState();
  requestRender();
  services.closeMobileSidebar?.();
  showToast(`Added from ${template.name}`, 'success');
  return true;
}

function templateSummary(t) {
  if (t.kind === 'project') {
    const sections = Array.isArray(t.sections) ? t.sections.length : 0;
    const tasks = Array.isArray(t.tasks) ? t.tasks.length : 0;
    return `${tasks} task${tasks === 1 ? '' : 's'}${sections ? ` · ${sections} section${sections === 1 ? '' : 's'}` : ''}`;
  }
  return 'Task template';
}

export function renderTemplates() {
  const list = document.getElementById('templates-list');
  if (!list) return;
  const templates = templateList();
  if (!templates.length) {
    list.innerHTML = `
      <div class="sidebar-hide px-2 py-1 text-[11px] text-td-muted">Save a task or project as a template.</div>
      <div class="sidebar-collapsed-only justify-center py-1 text-td-muted" title="Save a task or project as a template" aria-label="Save a task or project as a template">
        <i data-lucide="copy-plus" class="w-4 h-4"></i>
      </div>`;
    lucide.createIcons();
    return;
  }
  list.innerHTML = templates.map(t => `
    <div class="group relative" data-template-id="${escapeHtml(t.id)}">
      <a href="#" data-template-apply="${escapeHtml(t.id)}" title="Create from ${escapeHtml(t.name)}"
        class="nav-item flex items-center gap-2 px-2 py-1.5 pr-6 rounded hover:bg-gray-200/60 text-sm">
        <i data-lucide="${t.kind === 'project' ? 'folder-plus' : 'copy-plus'}" class="w-4 h-4 flex-shrink-0 text-td-muted"></i>
        <span class="sidebar-hide truncate flex-1">${escapeHtml(t.name)}</span>
      </a>
      <button type="button" class="sidebar-hide row-menu-btn absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-td-muted opacity-100 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 pointer-events-auto md:pointer-events-none md:group-hover:pointer-events-auto hover:text-td-text"
        data-menu-type="template" data-menu-id="${escapeHtml(t.id)}" title="Template actions" aria-label="Template actions">
        <i data-lucide="more-horizontal" class="w-4 h-4"></i>
      </button>
    </div>`).join('');
}

let pendingProjectTemplateId = null;

function renderTemplateManager() {
  const body = document.getElementById('template-manager-body');
  if (!body) return;
  const templates = templateList();
  if (!templates.length) {
    body.innerHTML = `<p class="text-sm text-td-muted">No templates yet. Save a project as a template from its menu, or save a task from the task editor.</p>`;
    return;
  }
  body.innerHTML = `
    <div class="space-y-2">
      ${templates.map(t => `
        <div class="border border-td-border rounded-lg p-3 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <i data-lucide="${t.kind === 'project' ? 'folder-plus' : 'copy-plus'}" class="w-4 h-4 text-td-muted flex-shrink-0"></i>
              <span class="font-medium text-sm truncate">${escapeHtml(t.name)}</span>
              <span class="text-[11px] text-td-muted flex-shrink-0">${t.kind === 'project' ? 'Project' : 'Task'}</span>
            </div>
            <div class="text-xs text-td-muted mt-0.5">${escapeHtml(templateSummary(t))}</div>
            ${t.description ? `<div class="text-xs text-td-muted mt-1 whitespace-pre-line">${escapeHtml(t.description)}</div>` : ''}
          </div>
          <div class="flex items-center gap-1 flex-shrink-0">
            <button type="button" class="px-2 py-1 text-xs rounded border border-td-border hover:bg-gray-50" data-template-manage="apply" data-template-id="${escapeHtml(t.id)}">Use</button>
            <button type="button" class="px-2 py-1 text-xs rounded border border-td-border hover:bg-gray-50" data-template-manage="edit" data-template-id="${escapeHtml(t.id)}">Edit</button>
            <button type="button" class="px-2 py-1 text-xs rounded border border-td-border hover:bg-gray-50" data-template-manage="duplicate" data-template-id="${escapeHtml(t.id)}">Duplicate</button>
            <button type="button" class="px-2 py-1 text-xs rounded border border-red-200 text-red-600 hover:bg-red-50" data-template-manage="delete" data-template-id="${escapeHtml(t.id)}">Delete</button>
          </div>
        </div>`).join('')}
    </div>`;
  lucide.createIcons();
}

export function openTemplateManager() {
  const modal = $('#template-manager-modal');
  if (!modal) return;
  renderTemplateManager();
  modal.showModal();
}

export function closeTemplateManager() {
  const modal = $('#template-manager-modal');
  if (modal?.open) modal.close();
}

function renderTemplateContentsEditor(template) {
  const wrap = $('#template-edit-contents');
  const body = $('#template-edit-contents-body');
  if (!wrap || !body) return;
  if (!template || template.kind !== 'project') {
    wrap.classList.add('hidden');
    body.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  const sections = Array.isArray(template.sections) ? template.sections : [];
  const sectionName = new Map(sections.map(s => [s.tempId || s.name, s.name]));
  const tasks = Array.isArray(template.tasks) ? template.tasks : [];
  const bySection = new Map([['__none__', []]]);
  sections.forEach(s => bySection.set(s.tempId || s.name, []));
  tasks.forEach(t => {
    const key = t.sectionTempId || (t.section ? (sections.find(s => s.name === t.section)?.tempId || t.section) : null) || '__none__';
    if (!bySection.has(key)) bySection.set('__none__', bySection.get('__none__'));
    (bySection.get(key) || bySection.get('__none__')).push(t);
  });

  const renderTaskRow = (t) => `
    <div class="flex items-center justify-between gap-2 py-1 border-b border-td-border last:border-b-0">
      <div class="min-w-0">
        <div class="truncate ${t.parentTempId ? 'pl-4 text-[13px]' : ''}">${escapeHtml(t.title || 'Untitled')}</div>
      </div>
      <button type="button" class="text-xs text-red-600 hover:underline flex-shrink-0" data-template-content-action="remove-task" data-temp-id="${escapeHtml(t.tempId)}">Remove</button>
    </div>`;

  let html = '';
  const none = bySection.get('__none__') || [];
  if (none.length) {
    html += `<div><div class="text-xs font-medium text-td-muted mb-1">No section</div>${none.map(renderTaskRow).join('')}</div>`;
  }
  sections.forEach(s => {
    const key = s.tempId || s.name;
    const items = bySection.get(key) || [];
    html += `<div class="mt-2">
      <div class="flex items-center justify-between gap-2 mb-1">
        <div class="text-xs font-medium text-td-muted truncate">${escapeHtml(s.name || 'Section')}</div>
        <button type="button" class="text-xs text-red-600 hover:underline flex-shrink-0" data-template-content-action="remove-section" data-section-id="${escapeHtml(key)}">Remove section</button>
      </div>
      ${items.length ? items.map(renderTaskRow).join('') : '<div class="text-xs text-td-muted py-1">No tasks</div>'}
    </div>`;
  });
  if (!sections.length && !none.length) {
    html = '<div class="text-xs text-td-muted">This template has no tasks.</div>';
  }
  body.innerHTML = html;
}

export function openTemplateEditor(id) {
  const template = templateList().find(t => t.id === id);
  const modal = $('#template-edit-modal');
  if (!template || !modal) return;
  modal.dataset.templateId = id;
  $('#template-edit-title').textContent = 'Edit template';
  $('#template-edit-name').value = template.name || '';
  $('#template-edit-description').value = template.description || '';
  const meta = $('#template-edit-meta');
  if (meta) {
    meta.textContent = template.kind === 'project'
      ? `${templateSummary(template)} · Saved snapshot (detached). Applying creates a new project; editing this template does not change projects created from it.`
      : 'Task template. Applying adds a task copy from this template.';
  }
  renderTemplateContentsEditor(template);
  modal.showModal();
  setTimeout(() => $('#template-edit-name')?.focus(), 30);
}

export function openSaveProjectTemplateModal(projectId) {
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return;
  pendingProjectTemplateId = projectId;
  const modal = $('#save-template-modal');
  if (!modal) return;
  $('#save-template-project-name').textContent = project.name;
  $('#save-template-name').value = project.name;
  $('#save-template-description').value = '';
  const tasks = state.tasks.filter(t => t.projectId === projectId);
  const top = tasks.filter(t => !t.parentId).length;
  const subs = tasks.length - top;
  const sections = (project.sections || []).length;
  $('#save-template-summary').textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'}${subs ? ` (including ${subs} subtask${subs === 1 ? '' : 's'})` : ''}${sections ? ` · ${sections} section${sections === 1 ? '' : 's'}` : ''}. Includes tasks, subtasks, sections, comments, attachments metadata, labels, priorities, durations, recurrence, reminders, and date offsets for relative rescheduling on apply.`;
  modal.showModal();
  setTimeout(() => $('#save-template-name')?.focus(), 30);
}

export function initTemplates() {
  const list = document.getElementById('templates-list');
  if (list) {
    list.addEventListener('click', (e) => {
      const remove = e.target.closest('[data-template-delete]');
      if (remove) {
        e.preventDefault();
        void deleteTemplate(remove.dataset.templateDelete);
        return;
      }
      const apply = e.target.closest('[data-template-apply]');
      if (!apply) return;
      e.preventDefault();
      applyTemplate(apply.dataset.templateApply);
    });
  }

  // Manager button (if present in sidebar header area) can be wired by id.
  document.getElementById('manage-templates-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    openTemplateManager();
  });

  const manager = $('#template-manager-modal');
  if (manager) {
    $('#template-manager-close')?.addEventListener('click', closeTemplateManager);
    manager.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-template-manage]');
      if (!btn) return;
      const { templateManage: action, templateId } = btn.dataset;
      if (action === 'apply') { applyTemplate(templateId); closeTemplateManager(); }
      else if (action === 'edit') { openTemplateEditor(templateId); }
      else if (action === 'duplicate') { duplicateTemplate(templateId); renderTemplateManager(); }
      else if (action === 'delete') { await deleteTemplate(templateId); renderTemplateManager(); }
    });
  }

  const editModal = $('#template-edit-modal');
  if (editModal) {
    $('#template-edit-cancel')?.addEventListener('click', () => editModal.close());
    $('#template-edit-save')?.addEventListener('click', () => {
      const id = editModal.dataset.templateId;
      updateTemplate(id, {
        name: $('#template-edit-name')?.value || '',
        description: $('#template-edit-description')?.value || '',
      });
      editModal.close();
      renderTemplateManager();
    });
    $('#template-edit-duplicate')?.addEventListener('click', () => {
      const id = editModal.dataset.templateId;
      duplicateTemplate(id);
      editModal.close();
      renderTemplateManager();
    });
    $('#template-edit-contents-body')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-template-content-action]');
      if (!btn) return;
      const id = editModal.dataset.templateId;
      const template = templateList().find(t => t.id === id);
      if (!template || template.kind !== 'project') return;
      const action = btn.dataset.templateContentAction;
      if (action === 'remove-task') {
        const tempId = btn.dataset.tempId;
        const toRemove = new Set([tempId]);
        // also remove subtasks of removed task
        let changed = true;
        while (changed) {
          changed = false;
          for (const task of (template.tasks || [])) {
            if (task.parentTempId && toRemove.has(task.parentTempId) && !toRemove.has(task.tempId)) {
              toRemove.add(task.tempId); changed = true;
            }
          }
        }
        template.tasks = (template.tasks || []).filter(t => !toRemove.has(t.tempId));
      } else if (action === 'remove-section') {
        const sectionId = btn.dataset.sectionId;
        template.sections = (template.sections || []).filter(s => (s.tempId || s.name) !== sectionId);
        (template.tasks || []).forEach(t => { if ((t.sectionTempId || t.section) === sectionId) { t.sectionTempId = null; t.section = null; } });
      }
      saveState();
      requestRender();
      renderTemplateContentsEditor(template);
      renderTemplateManager();
    });
  }

  const saveModal = $('#save-template-modal');
  if (saveModal) {
    const closeSave = () => { pendingProjectTemplateId = null; saveModal.close(); };
    $('#save-template-cancel')?.addEventListener('click', closeSave);
    saveModal.addEventListener('cancel', () => { pendingProjectTemplateId = null; });
    $('#save-template-submit')?.addEventListener('click', () => {
      const name = asText($('#save-template-name')?.value).trim();
      const description = asText($('#save-template-description')?.value).trim();
      if (!name) { showToast('Template name is required', 'error'); $('#save-template-name')?.focus(); return; }
      if (!description) { showToast('Please add a template description', 'error'); $('#save-template-description')?.focus(); return; }
      if (!pendingProjectTemplateId) { saveModal.close(); return; }
      saveProjectTemplate(pendingProjectTemplateId, { name, description });
      pendingProjectTemplateId = null;
      saveModal.close();
    });
  }
}
