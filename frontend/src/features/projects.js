/**
 * Project and label dialogs: name, colour, project sections and deletion.
 */
import { $, $$, uid } from '../core/app.js';
import { state, saveState } from '../core/state.js';
import { escapeHtml, PROJECT_COLORS, LABEL_COLORS } from '../core/text.js';
import { snapshotData, offerUndo } from '../core/undo.js';
import { plural } from '../core/toasts.js';
import { requestRender } from '../core/render.js';
import { services } from '../core/services.js';

const projectModal = $('#project-modal');
const labelModal = $('#label-modal');

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

export function isProjectModalOpen() {
  return projectModal.open;
}

export function closeProjectModal() {
  if (projectModal.open) projectModal.close();
}

export function isLabelModalOpen() {
  return labelModal.open;
}

export function closeLabelModal() {
  if (labelModal.open) labelModal.close();
}

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

export function openProjectModal(id = null) {
  services.closeRowMenu();
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
  if (!services.isMobileSidebar()) setTimeout(() => $('#project-name').focus(), 50);
}

export function openLabelModal(id = null) {
  services.closeRowMenu();
  const lbl = id ? state.labels.find(l => l.id === id) : null;
  if (id && !lbl) return;
  editingLabelId = id;
  $('#label-modal-title').textContent = lbl ? 'Edit label' : 'Add label';
  $('#label-name').value = lbl ? lbl.name : '';
  $('#save-label').textContent = lbl ? 'Save' : 'Add';
  labelDraftColor = lbl ? lbl.color : LABEL_COLORS[state.labels.length % LABEL_COLORS.length];
  renderColorSwatches($('#label-colors'), labelDraftColor, pickLabelColor);
  labelModal.showModal();
  if (!services.isMobileSidebar()) setTimeout(() => $('#label-name').focus(), 50);
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
  requestRender();
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
  requestRender();
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

export function deleteProject(id) {
  services.closeRowMenu();
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
  requestRender();
  offerUndo(`Project "${proj.name}" deleted`, snapshot);
}

export function deleteLabel(id) {
  services.closeRowMenu();
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
  requestRender();
  offerUndo(`Label "@${lbl.name}" deleted`, snapshot);
}
