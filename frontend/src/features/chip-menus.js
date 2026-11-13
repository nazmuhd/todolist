/**
 * The task dialog's chip menus.
 *
 * Clicking a chip (due date, priority, project, labels) opens a small menu
 * under it, in the same style as the right-click context menu: a header, a
 * list of choices with a tick on the current one, and a separator before
 * the "add new" row.
 *
 * Every menu can also create a new item of its kind, so a priority, a label
 * or a project can be added without leaving the task dialog.
 */
import { $, uid, modalState } from '../core/app.js';
import { state, saveState } from '../core/state.js';
import { toISODate, todayISO, parseDate } from '../core/dates.js';
import { escapeHtml } from '../core/text.js';
import { priorityLevels, addPriorityLevel, taskLevel } from '../core/priorities.js';
import { positionMetaMenu } from '../ui/menus.js';
import { requestRender } from '../core/render.js';
import { showToast } from '../core/toasts.js';
import { services } from '../core/services.js';

/** The draft the task dialog is editing. */
const draft = () => modalState.draft;

/* The menus, and the chip each one belongs to. */
const MENUS = {
  due: { el: null, chip: null },
  priority: { el: null, chip: null },
  project: { el: null, chip: null },
  label: { el: null, chip: null },
};

let openMenu = null;

/** Registers the menus once the DOM is ready. */
export function initChipMenus() {
  MENUS.due = { el: $('#due-menu'), chip: $('#meta-due') };
  MENUS.priority = { el: $('#priority-menu'), chip: $('#meta-priority') };
  MENUS.project = { el: $('#project-menu'), chip: $('#meta-project') };
  MENUS.label = { el: $('#label-menu'), chip: $('#meta-label') };

  Object.values(MENUS).forEach(({ el, chip }) => {
    if (!el || !chip) return;
    chip.onclick = (e) => {
      e.stopPropagation();
      const kind = Object.keys(MENUS).find(k => MENUS[k].el === el);
      toggleMenu(el, chip, kind);
    };
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.target.closest('[data-chip-action]');
      if (!btn) return;
      runAction(btn.dataset.chipAction, btn.dataset.chipValue, el);
    });
  });

  // Clicking anywhere else closes the open menu.
  document.addEventListener('click', (e) => {
    if (!openMenu) return;
    if (openMenu.el.contains(e.target) || openMenu.chip.contains(e.target)) return;
    closeChipMenus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenu) {
      e.stopPropagation();
      closeChipMenus();
    }
  });

  window.addEventListener('resize', closeChipMenus);
  window.addEventListener('scroll', () => {
    if (openMenu) positionMetaMenu(openMenu.el, openMenu.chip);
  }, true);
}

export function closeChipMenus() {
  Object.values(MENUS).forEach(({ el }) => el && el.classList.add('hidden'));
  openMenu = null;
}

export function isChipMenuOpen() {
  return !!openMenu;
}

function toggleMenu(el, chip, kind) {
  const wasOpen = openMenu && openMenu.el === el;
  closeChipMenus();
  if (wasOpen) return;
  // The menu is filled when it opens, so it always shows the current data.
  renderChipMenu(kind, draft());
  el.classList.remove('hidden');
  // The menu has to be measured before it can be placed.
  positionMetaMenu(el, chip);
  openMenu = { el, chip };
}

/* ---------- The menu contents ---------- */

/** The quick date choices, the same as the context menu's reschedule list. */
function dueMenuHtml(d) {
  const today = todayISO();
  const tomorrow = toISODate(new Date(Date.now() + 86400000));
  const nextWeek = toISODate(new Date(Date.now() + 7 * 86400000));
  const pick = (value, label) => `
    <button type="button" class="context-item" data-chip-action="due-set" data-chip-value="${value}">
      <i data-lucide="calendar" class="w-3.5 h-3.5" style="color:#808080"></i>
      <span class="flex-1 truncate text-left">${label}</span>
      ${d.due === value ? '<i data-lucide="check" class="w-3.5 h-3.5 flex-shrink-0"></i>' : ''}
    </button>`;
  return `
    <div class="context-label">Due date</div>
    ${pick(today, 'Today')}
    ${pick(tomorrow, 'Tomorrow')}
    ${pick(nextWeek, 'Next week')}
    ${pick('', 'No date')}
    <div class="context-sep"></div>
    <button type="button" class="context-item" data-chip-action="due-open">
      <i data-lucide="calendar-cog" class="w-3.5 h-3.5" style="color:#808080"></i>
      <span class="flex-1 truncate text-left">Repeat, reminders, deadline…</span>
    </button>`;
}

function priorityMenuHtml(d) {
  const current = taskLevel(d);
  const rows = priorityLevels().map(level => {
    const isCurrent = current && current.id === level.id;
    return `
      <button type="button" class="context-item" data-chip-action="priority-set" data-chip-value="${escapeHtml(level.id)}">
        <i data-lucide="flag" class="w-3.5 h-3.5 flex-shrink-0" style="color:${escapeHtml(level.color)}"></i>
        <span class="flex-1 truncate text-left">${escapeHtml(level.name)}</span>
        ${isCurrent ? '<i data-lucide="check" class="w-3.5 h-3.5 flex-shrink-0"></i>' : ''}
      </button>`;
  }).join('');
  return `
    <div class="context-label">Priority</div>
    ${rows}
    <div class="context-sep"></div>
    ${addNewRow('priority-new', 'plus', 'Add a priority')}
    <div class="context-sep"></div>
    ${addNewRow('priority-remove', 'trash-2', 'Remove the custom priority', 'danger')}`;
}

function projectMenuHtml(d) {
  const rows = state.projects.map(p => `
    <button type="button" class="context-item" data-chip-action="project-set" data-chip-value="${escapeHtml(p.id)}">
      <i data-lucide="hash" class="w-3.5 h-3.5 flex-shrink-0" style="color:${escapeHtml(p.color)}"></i>
      <span class="flex-1 truncate text-left">${escapeHtml(p.name)}</span>
      ${d.projectId === p.id ? '<i data-lucide="check" class="w-3.5 h-3.5 flex-shrink-0"></i>' : ''}
    </button>`).join('');
  return `
    <div class="context-label">Project</div>
    <button type="button" class="context-item" data-chip-action="project-set" data-chip-value="">
      <i data-lucide="hash" class="w-3.5 h-3.5 flex-shrink-0" style="color:#999"></i>
      <span class="flex-1 truncate text-left">No project</span>
      ${!d.projectId ? '<i data-lucide="check" class="w-3.5 h-3.5 flex-shrink-0"></i>' : ''}
    </button>
    ${rows}
    <div class="context-sep"></div>
    ${addNewRow('project-new', 'plus', 'Add a project')}`;
}

function labelMenuHtml(d) {
  const rows = state.labels.map(l => {
    const on = (d.labels || []).includes(l.id);
    return `
      <button type="button" class="context-item" data-chip-action="label-toggle" data-chip-value="${escapeHtml(l.id)}">
        <span class="w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center">${on ? '<i data-lucide="check" class="w-3 h-3"></i>' : ''}</span>
        <i data-lucide="tag" class="w-3.5 h-3.5 flex-shrink-0" style="color:${escapeHtml(l.color)}"></i>
        <span class="flex-1 truncate text-left">@${escapeHtml(l.name)}</span>
      </button>`;
  }).join('');
  return `
    <div class="context-label">Labels</div>
    ${rows || '<div class="px-3 py-2 text-xs text-td-muted">No labels yet.</div>'}
    <div class="context-sep"></div>
    ${addNewRow('label-new', 'plus', 'Add a label')}`;
}

/** The "add a new …" row at the foot of a menu. */
function addNewRow(action, icon, label, tone = '') {
  return `
    <button type="button" class="context-item${tone ? ' ' + tone : ''}" data-chip-action="${action}">
      <i data-lucide="${icon}" class="w-3.5 h-3.5" style="color:#808080"></i>
      <span class="flex-1 truncate text-left">${escapeHtml(label)}</span>
    </button>`;
}

/* ---------- The actions ---------- */

function runAction(action, value, el) {
  const d = draft();
  if (!d) return;

  if (action === 'due-set') {
    d.due = value || null;
    if (!value) d.dueTime = null;
    d.reminderFiredKey = null;
    closeChipMenus();
    services.updateModalChips();
    return;
  }
  if (action === 'due-open') {
    closeChipMenus();
    // The full editor lives in the due-date feature.
    import('./due-editor.js').then(m => m.openDueEditor());
    return;
  }
  if (action === 'priority-set') {
    const level = priorityLevels().find(l => l.id === value);
    if (level) {
      d.customPriorityId = level.custom ? level.id : null;
      d.priority = level.custom ? 4 : level.priority;
    }
    closeChipMenus();
    services.updateModalChips();
    return;
  }
  if (action === 'priority-new') {
    closeChipMenus();
    promptForNew('New priority', (name) => {
      const level = addPriorityLevel(name);
      if (!level) return;
      d.customPriorityId = level.id;
      d.priority = 4;
      saveState();
      services.updateModalChips();
      showToast(`Added the priority "${level.name}"`, 'success');
    });
    return;
  }
  if (action === 'priority-remove') {
    const level = taskLevel(d);
    if (!level || !level.custom) {
      showToast('The built-in priorities cannot be removed', 'error');
      return;
    }
    closeChipMenus();
    import('../core/priorities.js').then(m => {
      m.removePriorityLevel(level.id);
      d.customPriorityId = null;
      saveState();
      services.updateModalChips();
      showToast(`Removed the priority "${level.name}"`, 'success');
    });
    return;
  }
  if (action === 'project-set') {
    d.projectId = value || null;
    // The section list belongs to the project, so it changes with it.
    d.sectionId = null;
    closeChipMenus();
    services.updateModalChips();
    return;
  }
  if (action === 'project-new') {
    closeChipMenus();
    promptForNew('New project', (name) => {
      const id = 'proj_' + uid();
      state.projects.push({ id, name, color: '#246fe0', sections: [] });
      d.projectId = id;
      d.sectionId = null;
      saveState();
      services.updateModalChips();
      requestRender();
      showToast(`Added the project "${name}"`, 'success');
    });
    return;
  }
  if (action === 'label-toggle') {
    const arr = d.labels || [];
    d.labels = arr.includes(value) ? arr.filter(x => x !== value) : [...arr, value];
    saveState();
    services.updateModalChips();
    return;
  }
  if (action === 'label-new') {
    closeChipMenus();
    promptForNew('New label', (name) => {
      const id = 'lbl_' + uid();
      state.labels.push({ id, name, color: '#db4c3f' });
      d.labels = [...(d.labels || []), id];
      saveState();
      services.updateModalChips();
      requestRender();
      showToast(`Added the label "@${name}"`, 'success');
    });
  }
}

/**
 * Asks for a name with a small inline prompt.
 * The prompt is drawn in the page, so no browser dialog is used.
 */
function promptForNew(title, onDone) {
  const existing = document.getElementById('quick-name-prompt');
  if (existing) existing.remove();

  const wrap = document.createElement('div');
  wrap.id = 'quick-name-prompt';
  wrap.className = 'fixed inset-0 z-[60] flex items-center justify-center bg-black/20';
  wrap.innerHTML = `
    <div class="bg-white rounded-lg shadow-2xl border border-td-border p-4 w-full max-w-xs">
      <div class="text-sm font-semibold mb-2">${escapeHtml(title)}</div>
      <input type="text" class="w-full text-sm border border-td-border rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-td-red/30" placeholder="Name" />
      <div class="mt-3 flex justify-end gap-2">
        <button type="button" class="text-xs text-td-muted px-2 py-1" data-prompt-cancel>Cancel</button>
        <button type="button" class="bg-td-red text-white text-xs font-semibold px-3 py-1.5 rounded" data-prompt-ok>Add</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const input = wrap.querySelector('input');
  input.focus();

  const done = (ok) => {
    const name = input.value.trim();
    wrap.remove();
    if (ok && name) onDone(name);
  };
  wrap.querySelector('[data-prompt-ok]').onclick = () => done(true);
  wrap.querySelector('[data-prompt-cancel]').onclick = () => done(false);
  wrap.onclick = (e) => {
    if (e.target === wrap) done(false);
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    if (e.key === 'Escape') { e.preventDefault(); done(false); }
  };
}

/** Fills a menu with its content and shows it. */
export function renderChipMenu(kind, d) {
  const entry = MENUS[kind];
  if (!entry || !entry.el || !d) return;
  if (kind === 'due') entry.el.innerHTML = dueMenuHtml(d);
  else if (kind === 'priority') entry.el.innerHTML = priorityMenuHtml(d);
  else if (kind === 'project') entry.el.innerHTML = projectMenuHtml(d);
  else if (kind === 'label') entry.el.innerHTML = labelMenuHtml(d);
  lucide.createIcons();
}
