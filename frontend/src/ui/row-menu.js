/**
 * The project / label / filter "…" menu.
 */
import { $ } from '../core/app.js';
import { state, saveState } from '../core/state.js';
import { requestRender } from '../core/render.js';
import { services } from '../core/services.js';
import { savedFilters, deleteFilter, openFilterEditor } from '../features/filters.js';
import { openProjectModal, openLabelModal, deleteProject, deleteLabel } from '../features/projects.js';
import { openSaveProjectTemplateModal, applyTemplate, deleteTemplate, duplicateTemplate, openTemplateEditor } from '../features/templates.js';
import { positionBelowTrigger } from './menus.js';

const rowMenu = $('#row-menu');
let rowMenuTarget = null;

export function openRowMenu(trigger, type, id) {
  const isProject = type === 'project';
  const isFilter = type === 'filter';
  const isTemplate = type === 'template';
  const entry = isProject
    ? state.projects.find(p => p.id === id)
    : isFilter
      ? savedFilters.find(f => f.id === id)
      : isTemplate
        ? (state.templates || []).find(t => t.id === id)
        : state.labels.find(l => l.id === id);
  if (!entry) return;

  rowMenuTarget = { type, id };
  rowMenu.innerHTML = isFilter ? `
    <button type="button" data-row-action="edit" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2">
      <i data-lucide="pencil" class="w-3.5 h-3.5 text-td-muted"></i>Edit filter
    </button>
    <button type="button" data-row-action="delete" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 text-red-600">
      <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>Delete filter
    </button>` : isTemplate ? `
    <button type="button" data-row-action="apply-template" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2">
      <i data-lucide="${entry.kind === 'project' ? 'folder-plus' : 'copy-plus'}" class="w-3.5 h-3.5 text-td-muted"></i>${entry.kind === 'project' ? 'Create project from template' : 'Add task from template'}
    </button>
    <button type="button" data-row-action="edit-template" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2">
      <i data-lucide="pencil" class="w-3.5 h-3.5 text-td-muted"></i>Edit template
    </button>
    <button type="button" data-row-action="duplicate-template" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2">
      <i data-lucide="copy" class="w-3.5 h-3.5 text-td-muted"></i>Save as new template
    </button>
    <button type="button" data-row-action="delete" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 text-red-600">
      <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>Delete template
    </button>` : `
    <button type="button" data-row-action="pin" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2">
      <i data-lucide="star" class="w-3.5 h-3.5 text-td-muted"></i>${entry.pinned ? 'Unpin from top' : 'Pin to top'}
    </button>
    <button type="button" data-row-action="edit" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2">
      <i data-lucide="pencil" class="w-3.5 h-3.5 text-td-muted"></i>Edit ${isProject ? 'project' : 'label'}
    </button>
    ${isProject ? `<button type="button" data-row-action="template" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2">
      <i data-lucide="copy-plus" class="w-3.5 h-3.5 text-td-muted"></i>Save as template
    </button>` : ''}
    <button type="button" data-row-action="delete" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 text-red-600">
      <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>Delete ${isProject ? 'project' : 'label'}
    </button>`;

  rowMenu.classList.remove('hidden');
  positionBelowTrigger(rowMenu, trigger);
  lucide.createIcons();
}

export function closeRowMenu() {
  rowMenuTarget = null;
  rowMenu.classList.add('hidden');
  rowMenu.innerHTML = '';
}

export function isRowMenuOpen() {
  return !rowMenu.classList.contains('hidden');
}

rowMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-row-action]');
  if (!btn || !rowMenuTarget) return;
  e.stopPropagation();
  const { type, id } = rowMenuTarget;
  const action = btn.dataset.rowAction;

  if (action === 'pin') {
    const entry = type === 'project'
      ? state.projects.find(p => p.id === id)
      : state.labels.find(l => l.id === id);
    if (entry) entry.pinned = !entry.pinned;
    closeRowMenu();
    saveState();
    requestRender();
    return;
  }
  if (action === 'edit') {
    closeRowMenu();
    if (type === 'project') openProjectModal(id);
    else if (type === 'filter') openFilterEditor(id);
    else openLabelModal(id);
    return;
  }
  if (action === 'template') {
    closeRowMenu();
    openSaveProjectTemplateModal(id);
    return;
  }
  if (action === 'apply-template') {
    closeRowMenu();
    applyTemplate(id);
    return;
  }
  if (action === 'edit-template') {
    closeRowMenu();
    openTemplateEditor(id);
    return;
  }
  if (action === 'duplicate-template') {
    closeRowMenu();
    duplicateTemplate(id);
    return;
  }
  if (action === 'delete') {
    closeRowMenu();
    if (type === 'project') void deleteProject(id);
    else if (type === 'filter') void deleteFilter(id);
    else if (type === 'template') void deleteTemplate(id);
    else void deleteLabel(id);
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

services.closeRowMenu = closeRowMenu;
