/**
 * Reusable task and project templates.
 *
 * A task template remembers the fields that describe the work (title,
 * description, priority, project, labels, duration, repeat rule). A project
 * template also remembers its sections and the tasks inside it. Dates are
 * deliberately not stored: a template is a starting point, not a copy of an
 * old deadline.
 */
import { state, saveState } from '../core/state.js';
import { uid } from '../core/app.js';
import { addTask, firstRecurrenceISO, cleanRecurrenceMode } from '../core/tasks.js';
import { todayISO, cleanDuration, cleanTimeZone } from '../core/dates.js';
import { requestRender } from '../core/render.js';
import { showToast } from '../core/toasts.js';
import { escapeHtml } from '../core/text.js';
import { services } from '../core/services.js';

function templateList() {
  if (!Array.isArray(state.templates)) state.templates = [];
  return state.templates;
}

/** Saves the fields of an edited task as a reusable task template. */
export function saveTaskTemplate(task) {
  if (!task) return null;
  const name = String(task.title || '').trim() || 'Task template';
  const template = {
    id: 'tpl_' + uid(),
    kind: 'task',
    name,
    title: name,
    description: task.description || '',
    priority: task.priority || 4,
    projectId: task.projectId || null,
    labels: [...(task.labels || [])],
    durationMinutes: cleanDuration(task.durationMinutes),
    recurrence: task.recurrence || null,
    recurrenceMode: cleanRecurrenceMode(task.recurrenceMode),
    timeZone: cleanTimeZone(task.timeZone),
  };
  templateList().push(template);
  saveState();
  requestRender();
  showToast(`Template saved: ${name}`, 'success');
  return template;
}

/** Saves a project with its sections and tasks as a project template. */
export function saveProjectTemplate(projectId) {
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return null;
  const sectionName = new Map((project.sections || []).map(s => [s.id, s.name]));
  const template = {
    id: 'tpl_' + uid(),
    kind: 'project',
    name: project.name,
    color: project.color,
    sections: (project.sections || []).map(s => ({ name: s.name })),
    tasks: state.tasks
      .filter(t => t.projectId === projectId && !t.parentId)
      .map(t => ({
        title: t.title,
        description: t.description || '',
        priority: t.priority || 4,
        labels: [...(t.labels || [])],
        section: t.sectionId ? (sectionName.get(t.sectionId) || null) : null,
        durationMinutes: cleanDuration(t.durationMinutes),
      })),
  };
  templateList().push(template);
  saveState();
  requestRender();
  showToast(`Project template saved: ${project.name}`, 'success');
  return template;
}

export function deleteTemplate(id) {
  const before = templateList().length;
  state.templates = templateList().filter(t => t.id !== id);
  if (state.templates.length === before) return false;
  saveState();
  requestRender();
  return true;
}

function newId(prefix) {
  return `${prefix}_${uid()}`;
}

export function applyTemplate(id) {
  const template = templateList().find(t => t.id === id);
  if (!template) return false;

  if (template.kind === 'project') {
    const projectId = newId('proj');
    const sectionIds = new Map();
    const sections = (template.sections || []).map(s => {
      const sectionId = newId('sec');
      sectionIds.set(s.name, sectionId);
      return { id: sectionId, name: s.name };
    });
    state.projects.push({ id: projectId, name: template.name, color: template.color || '#246fe0', sections });
    for (const item of template.tasks || []) {
      addTask({
        title: item.title,
        description: item.description,
        priority: item.priority,
        projectId,
        sectionId: item.section ? (sectionIds.get(item.section) || null) : null,
        labels: (item.labels || []).filter(lid => state.labels.some(l => l.id === lid)),
        durationMinutes: item.durationMinutes,
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
  addTask({
    title: template.title || template.name,
    description: template.description,
    priority: template.priority,
    projectId: state.projects.some(p => p.id === template.projectId) ? template.projectId : null,
    labels: (template.labels || []).filter(lid => state.labels.some(l => l.id === lid)),
    durationMinutes: template.durationMinutes,
    recurrence,
    recurrenceMode: template.recurrenceMode || 'scheduled',
    timeZone: template.timeZone || null,
    due: recurrence ? (firstRecurrenceISO(recurrence, todayISO()) || todayISO()) : null,
  });
  saveState();
  requestRender();
  services.closeMobileSidebar?.();
  showToast(`Added from ${template.name}`, 'success');
  return true;
}

export function renderTemplates() {
  const list = document.getElementById('templates-list');
  if (!list) return;
  const templates = templateList();
  if (!templates.length) {
    list.innerHTML = '<div class="px-2 py-1 text-[11px] text-td-muted">Save a task or project as a template.</div>';
    return;
  }
  list.innerHTML = templates.map(t => `
    <div class="group relative" data-template-id="${escapeHtml(t.id)}">
      <a href="#" data-template-apply="${escapeHtml(t.id)}" title="Create from ${escapeHtml(t.name)}"
        class="nav-item flex items-center gap-2 px-2 py-1.5 pr-7 rounded hover:bg-gray-200/60 text-sm">
        <i data-lucide="${t.kind === 'project' ? 'folder-plus' : 'copy-plus'}" class="w-4 h-4 flex-shrink-0 text-td-muted"></i>
        <span class="sidebar-hide truncate flex-1">${escapeHtml(t.name)}</span>
      </a>
      <button type="button" class="sidebar-hide absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-td-muted opacity-100 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 hover:text-red-600"
        data-template-delete="${escapeHtml(t.id)}" title="Delete template" aria-label="Delete template">
        <i data-lucide="x" class="w-3.5 h-3.5"></i>
      </button>
    </div>`).join('');
}

export function initTemplates() {
  const list = document.getElementById('templates-list');
  if (!list) return;
  list.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-template-delete]');
    if (remove) {
      e.preventDefault();
      deleteTemplate(remove.dataset.templateDelete);
      return;
    }
    const apply = e.target.closest('[data-template-apply]');
    if (!apply) return;
    e.preventDefault();
    applyTemplate(apply.dataset.templateApply);
  });
}
