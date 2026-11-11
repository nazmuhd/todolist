/**
 * Bulk selection of tasks.
 *
 * Ctrl/Cmd-click toggles a task, Shift-click selects a range. The
 * selection is a set of task ids that the views highlight and the batch
 * bar acts on.
 */
import { state, saveState } from '../core/state.js';
import { subtasksOf, projectName } from '../core/tasks.js';
import { snapshotData, offerUndo } from '../core/undo.js';
import { requestRender } from '../core/render.js';

export const selection = new Set();
let lastSelectedId = null;

export function visibleTaskIds() {
  return [...document.querySelectorAll('#task-list > li[data-task-id]')].map(li => li.dataset.taskId);
}

export function selectTask(id, e) {
  if (!state.tasks.some(t => t.id === id)) return;
  if (e.shiftKey && lastSelectedId) {
    const ids = visibleTaskIds();
    const from = ids.indexOf(lastSelectedId);
    const to = ids.indexOf(id);
    if (from >= 0 && to >= 0) {
      const [a, b] = from < to ? [from, to] : [to, from];
      for (let i = a; i <= b; i++) selection.add(ids[i]);
    }
  } else if (selection.has(id)) {
    selection.delete(id);
  } else {
    selection.add(id);
  }
  lastSelectedId = id;
  renderSelection();
}

export function clearSelection() {
  selection.clear();
  lastSelectedId = null;
  renderSelection();
}

export function renderSelection() {
  // Forget tasks that no longer exist.
  for (const id of [...selection]) {
    if (!state.tasks.some(t => t.id === id)) selection.delete(id);
  }
  document.querySelectorAll('#task-list > li[data-task-id]').forEach(li => {
    li.classList.toggle('selected', selection.has(li.dataset.taskId));
  });

  const bar = document.getElementById('batch-bar');
  const count = selection.size;
  bar.classList.toggle('hidden', count === 0);
  if (!count) return;
  document.getElementById('batch-count').textContent = `${count} selected`;

  const tasks = state.tasks.filter(t => selection.has(t.id));
  const allDone = tasks.length > 0 && tasks.every(t => t.completed);
  document.getElementById('batch-complete').textContent = allDone ? 'Reopen' : 'Complete';
}

export function batchRun(mutate, label) {
  const ids = [...selection];
  if (!ids.length) return;
  const snapshot = snapshotData();
  ids.forEach(mutate);
  saveState();
  requestRender();
  clearSelection();
  offerUndo(label, snapshot);
}

export function batchComplete() {
  const tasks = state.tasks.filter(t => selection.has(t.id));
  const allDone = tasks.length > 0 && tasks.every(t => t.completed);
  batchRun((id) => {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    t.completed = !allDone;
    t.completedAt = allDone ? null : Date.now();
    subtasksOf(t.id).forEach(s => {
      s.completed = !allDone;
      s.completedAt = allDone ? null : Date.now();
    });
  }, allDone ? 'Tasks reopened' : 'Tasks completed');
}

export function batchDelete() {
  batchRun((id) => {
    state.tasks = state.tasks.filter(x => x.id !== id && x.parentId !== id);
  }, 'Tasks deleted');
}

export function batchPriority(p) {
  batchRun((id) => {
    const t = state.tasks.find(x => x.id === id);
    if (t) t.priority = p;
  }, `Priority set to P${p}`);
}

export function batchProject(projectId) {
  batchRun((id) => {
    const t = state.tasks.find(x => x.id === id);
    if (t) t.projectId = projectId || null;
  }, projectId ? `Moved to ${projectName(projectId)}` : 'Removed from project');
}

/** Wires the batch bar. Called once, when the app boots. */
export function initSelection() {
  document.getElementById('batch-complete').onclick = () => batchComplete();
  document.getElementById('batch-delete').onclick = () => batchDelete();
  document.getElementById('batch-clear').onclick = () => clearSelection();
  document.getElementById('batch-select-all').onclick = () => {
    visibleTaskIds().forEach(id => selection.add(id));
    renderSelection();
  };

  document.getElementById('batch-priority').onclick = (e) => {
    e.stopPropagation();
    const menu = document.getElementById('batch-priority-menu');
    const tasks = state.tasks.filter(t => selection.has(t.id));
    const current = tasks.length && tasks.every(t => t.priority === 1) ? 1 : null;
    menu.innerHTML = [1, 2, 3, 4].map(p => `
      <button type="button" class="batch-menu-item" data-batch-priority="${p}" aria-pressed="${current === p}">P${p}</button>`).join('');
    menu.classList.remove('hidden');
  };

  document.getElementById('batch-project').onclick = (e) => {
    e.stopPropagation();
    const menu = document.getElementById('batch-project-menu');
    const tasks = state.tasks.filter(t => selection.has(t.id));
    const current = tasks.length && tasks.every(t => t.projectId === 'none') ? 'none' : null;
    menu.innerHTML = `
      <button type="button" class="batch-menu-item" data-batch-project="none" aria-pressed="${current === 'none'}">No project</button>
      ${state.projects.map(p => `
        <button type="button" class="batch-menu-item" data-batch-project="${escapeAttr(p.id)}" aria-pressed="${tasks.length > 0 && tasks.every(t => t.projectId === p.id)}">
          <span style="color:${escapeAttr(p.color)}">#</span>${escapeAttr(p.name)}
        </button>`).join('')}`;
    menu.classList.remove('hidden');
  };

  document.getElementById('batch-priority-menu').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-batch-priority]');
    if (!btn) return;
    document.getElementById('batch-priority-menu').classList.add('hidden');
    batchPriority(Number(btn.dataset.batchPriority));
  });

  document.getElementById('batch-project-menu').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-batch-project]');
    if (!btn) return;
    document.getElementById('batch-project-menu').classList.add('hidden');
    const id = btn.dataset.batchProject;
    batchProject(id === 'none' ? null : id);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#batch-priority-menu') && !e.target.closest('#batch-priority')) {
      document.getElementById('batch-priority-menu').classList.add('hidden');
    }
    if (!e.target.closest('#batch-project-menu') && !e.target.closest('#batch-project')) {
      document.getElementById('batch-project-menu').classList.add('hidden');
    }
  });
}

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
