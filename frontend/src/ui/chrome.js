/**
 * The app chrome: sidebar (desktop rail and mobile drawer), header controls,
 * the sort menu, the shortcuts overlay, and the global keyboard shortcuts.
 *
 * Dialog-specific close/undo logic is imported from the features so the
 * entry point stays a wiring file.
 */
import { $, $$ } from '../core/app.js';
import { state, saveState } from '../core/state.js';
import { store } from '../core/store.js';
import { undoPending, redoPending } from '../core/undo.js';
import { requestRender } from '../core/render.js';
import { services } from '../core/services.js';
import { todayISO } from '../core/dates.js';
import { isTaskModalOpen, closeTaskModal } from '../features/task-modal.js';
import { isDueEditorOpen, closeDueEditor } from '../features/due-editor.js';
import { isSettingsOpen, closeSettings } from '../features/settings.js';
import { isExportOpen, closeExport } from '../features/backup.js';
import { isProjectModalOpen, closeProjectModal, isLabelModalOpen, closeLabelModal } from '../features/projects.js';
import { isQuickAddOpen, closeQuickAdd, openQuickAdd } from '../features/quickadd.js';
import { isContextMenuOpen, closeContextMenu } from '../features/context-menu.js';
import { isRowMenuOpen, closeRowMenu } from './row-menu.js';

let renderSortMenu = () => {};
let supportsBoard = () => false;
let renderMainView = () => {};

/* ============================================================
   SIDEBAR SECTIONS (collapse Projects / Labels)
============================================================ */
export const SECTION_NAMES = ['filters', 'projects', 'labels', 'templates'];
const sectionCollapsed = { filters: false, projects: false, labels: false, templates: false };

export function setSectionCollapsed(name, collapsed) {
  const list = $(`#${name}-list`);
  const btn = $(`#toggle-${name}`);
  if (!list || !btn) return;
  list.classList.toggle('hidden', collapsed);
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = `${collapsed ? 'Expand' : 'Collapse'} ${name}`;
  const icon = btn.querySelector('[data-lucide]');
  if (icon) icon.setAttribute('data-lucide', collapsed ? 'chevron-right' : 'chevron-down');
  sectionCollapsed[name] = collapsed;
  store.setDoc(store.keys.sectionCollapse, sectionCollapsed)
    .catch(err => console.error('Could not save preferences:', err));
  lucide.createIcons();
}

SECTION_NAMES.forEach(name => {
  const btn = $(`#toggle-${name}`);
  if (!btn) return;
  btn.onclick = () => {
    const collapsed = !$(`#${name}-list`).classList.contains('hidden');
    setSectionCollapsed(name, collapsed);
  };
});

/* ============================================================
   SIDEBAR (desktop collapse rail, mobile drawer)
============================================================ */
const mobileSidebarQuery = window.matchMedia('(max-width: 767px)');
let sidebarCollapsedPref = false;

export function isMobileSidebar() {
  return mobileSidebarQuery.matches;
}

export function applySidebarState() {
  const aside = $('#sidebar');
  const btn = $('#sidebar-toggle');
  const collapsed = sidebarCollapsedPref && !isMobileSidebar();

  aside.classList.toggle('sidebar-collapsed', collapsed);
  aside.classList.toggle('w-16', collapsed);
  aside.classList.toggle('w-72', !collapsed);

  if (isMobileSidebar()) {
    const icon = btn.querySelector('[data-lucide]');
    if (icon) icon.setAttribute('data-lucide', 'x');
    btn.title = 'Close menu';
    btn.setAttribute('aria-label', 'Close menu');
    btn.setAttribute('aria-expanded', String(aside.classList.contains('mobile-open')));
  } else {
    // Swap the toggle icon so the way back is obvious.
    const icon = btn.querySelector('[data-lucide]');
    if (icon) icon.setAttribute('data-lucide', collapsed ? 'panel-left-open' : 'panel-left-close');
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-expanded', String(!collapsed));
  }

  lucide.createIcons();
}

export function setSidebarCollapsed(collapsed) {
  sidebarCollapsedPref = collapsed;
  applySidebarState();
  store.setDoc(store.keys.sidebarCollapsed, collapsed)
    .catch(err => console.error('Could not save preferences:', err));
}

export function openMobileSidebar() {
  if (!isMobileSidebar()) return;
  $('#sidebar').classList.add('mobile-open');
  $('#sidebar-backdrop').classList.remove('hidden');
  $('#mobile-menu').setAttribute('aria-expanded', 'true');
  applySidebarState();
}

export function closeMobileSidebar() {
  const aside = $('#sidebar');
  const wasOpen = aside.classList.contains('mobile-open');
  aside.classList.remove('mobile-open');
  $('#sidebar-backdrop').classList.add('hidden');
  $('#mobile-menu').setAttribute('aria-expanded', 'false');
  if (wasOpen) applySidebarState();
}

function handleSidebarBreakpoint() {
  if (!isMobileSidebar()) closeMobileSidebar();
  applySidebarState();
}

if (mobileSidebarQuery.addEventListener) {
  mobileSidebarQuery.addEventListener('change', handleSidebarBreakpoint);
} else if (mobileSidebarQuery.addListener) {
  mobileSidebarQuery.addListener(handleSidebarBreakpoint); // older Safari
}

$('#sidebar-toggle').onclick = () => {
  if (isMobileSidebar()) closeMobileSidebar();
  else setSidebarCollapsed(!sidebarCollapsedPref);
};

$('#mobile-menu').onclick = () => {
  if ($('#sidebar').classList.contains('mobile-open')) closeMobileSidebar();
  else openMobileSidebar();
};

$('#sidebar-backdrop').onclick = closeMobileSidebar;

/* ============================================================
   HEADER: layout, sort menu, search, navigation
============================================================ */
$('#view-layout').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-layout]');
  if (!btn) return;
  const layout = btn.dataset.layout === 'board' ? 'board' : 'list';
  if (state.ui.layout === layout) return;
  state.ui.layout = layout;
  saveState();
  requestRender();
  pulseViewIn();
});

$('#sort-menu-btn').onclick = (e) => {
  e.stopPropagation();
  const sortMenu = $('#sort-menu');
  const opening = sortMenu.classList.contains('hidden');
  services.closeMetaMenus();
  renderSortMenu();
  sortMenu.classList.toggle('hidden', !opening);
  lucide.createIcons();
};

$('#sort-menu').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sort]');
  if (!btn) return;
  state.ui.sort = btn.dataset.sort;
  if (!state.ui.sortByView) state.ui.sortByView = {};
  state.ui.sortByView[state.ui.view] = state.ui.sort;
  $('#sort-menu').classList.add('hidden');
  saveState();
  requestRender();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#sort-menu') && !e.target.closest('#sort-menu-btn')) {
    $('#sort-menu').classList.add('hidden');
  }
});

document.addEventListener('click', (e) => {
  const nav = e.target.closest('.nav-item');
  if (nav && nav.dataset.view) {
    e.preventDefault();
    services.navigateTo(nav.dataset.view);
    closeMobileSidebar();
  }
});

$('#search-input').addEventListener('input', (e) => {
  state.ui.search = e.target.value;
  saveState();
  renderMainView();
  lucide.createIcons();
  services.syncHash();
});

$('#empty-cta').onclick = () => {
  const v = state.ui.view;
  const defaults = (v === 'today' || v === 'upcoming') ? { due: todayISO() } : {};
  openQuickAdd(defaults);
};

function pulseViewIn() {
  const el = $('#content-container');
  if (!el) return;
  el.classList.remove('view-enter');
  void el.offsetWidth;
  el.classList.add('view-enter');
}

/* ============================================================
   KEYBOARD NAVIGATION OF THE TASK LIST
============================================================ */
document.addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const active = document.activeElement;
  if (!active || !active.classList.contains('task-title')) return;
  const titles = $$('#task-list .task-title');
  const index = titles.indexOf(active);
  if (index < 0) return;
  e.preventDefault();

  let next = null;
  if (e.key === 'ArrowDown') next = titles[index + 1];
  else if (e.key === 'ArrowUp') next = titles[index - 1];
  else if (e.key === 'Home') next = titles[0];
  else if (e.key === 'End') next = titles[titles.length - 1];
  if (next) next.focus();
});

/* ============================================================
   KEYBOARD SHORTCUTS
============================================================ */
const SHORTCUTS = [
  { keys: ['q'], label: 'Add a task' },
  { keys: ['a'], label: 'Add a task' },
  { keys: ['/'], label: 'Search' },
  { keys: ['i'], label: 'Go to Inbox' },
  { keys: ['t'], label: 'Go to Today' },
  { keys: ['u'], label: 'Go to Upcoming' },
  { keys: ['c'], label: 'Go to Completed' },
  { keys: ['k'], label: 'Go to Calendar' },
  { keys: ['g', 'i'], label: 'Go to Inbox (sequence)' },
  { keys: ['g', 't'], label: 'Go to Today (sequence)' },
  { keys: ['g', 'u'], label: 'Go to Upcoming (sequence)' },
  { keys: ['g', 'c'], label: 'Go to Calendar (sequence)' },
  { keys: ['b'], label: 'Toggle board / list' },
  { keys: ['?'], label: 'Show this help' },
  { keys: ['Esc'], label: 'Close dialogs and menus' },
  { keys: ['Ctrl', 'Z'], label: 'Undo the last action' },
  { keys: ['Ctrl', 'Shift', 'Z'], label: 'Redo the last action' },
  { keys: ['Ctrl', 'Click'], label: 'Select tasks' },
];

const shortcutsModal = $('#shortcuts-modal');

function renderShortcuts() {
  $('#shortcuts-list').innerHTML = SHORTCUTS.map(s => `
    <li class="shortcut-row">
      <span class="shortcut-keys">${s.keys.map(k => `<kbd class="kbd">${k}</kbd>`).join('')}</span>
      <span class="shortcut-label">${s.label}</span>
    </li>`).join('');
}

function openShortcuts() {
  renderShortcuts();
  if (!shortcutsModal.open) shortcutsModal.showModal();
}

export function isShortcutsOpen() {
  return shortcutsModal.open;
}

export function closeShortcuts() {
  if (shortcutsModal.open) shortcutsModal.close();
}

$('#shortcuts-close').onclick = () => shortcutsModal.close();

// Two-key sequences such as "g i".
let gPrefix = false;
let gPrefixTimer = 0;

document.addEventListener('keydown', (e) => {
  // Don't trigger inside inputs/textarea
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

  if (typing) return;

  // Ctrl/Cmd+Z undoes the last destructive action.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undoPending();
    return;
  }
  // Ctrl/Cmd+Shift+Z (or Ctrl+Y) redoes it.
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault();
    redoPending();
    return;
  }

  const dialogOpen = isTaskModalOpen() || isProjectModalOpen() || isLabelModalOpen() || isDueEditorOpen()
    || isShortcutsOpen() || isSettingsOpen() || isExportOpen();
  if (e.key === 'Escape') {
    // Handle every case ourselves; otherwise the browser would also
    // close the dialog while we only meant to dismiss the popover.
    e.preventDefault();
    if (isDueEditorOpen()) closeDueEditor();
    else if (isExportOpen()) closeExport();
    else if (isSettingsOpen()) closeSettings();
    else if (isShortcutsOpen()) closeShortcuts();
    else if (isRowMenuOpen()) closeRowMenu();
    else if (isContextMenuOpen()) closeContextMenu();
    else if ($('#sidebar').classList.contains('mobile-open')) closeMobileSidebar();
    else if (isTaskModalOpen()) closeTaskModal();
    else if (isProjectModalOpen()) closeProjectModal();
    else if (isLabelModalOpen()) closeLabelModal();
    else if (isQuickAddOpen()) closeQuickAdd();
    return;
  }
  if (dialogOpen) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === '/') {
    e.preventDefault();
    const search = $('#search-input');
    search.focus();
    search.select();
    return;
  }

  const key = e.key.toLowerCase();
  if (key === 'g') {
    e.preventDefault();
    gPrefix = true;
    clearTimeout(gPrefixTimer);
    gPrefixTimer = setTimeout(() => { gPrefix = false; }, 1200);
    return;
  }
  if (gPrefix) {
    gPrefix = false;
    clearTimeout(gPrefixTimer);
    const destinations = {
      i: 'inbox', t: 'today', u: 'upcoming', c: 'calendar',
      d: 'completed', n: 'no-date', p: 'no-priority',
    };
    if (destinations[key]) {
      e.preventDefault();
      services.navigateTo(destinations[key]);
      return;
    }
  }
  if (key === 'q' || key === 'a') { e.preventDefault(); openQuickAdd(); return; }
  if (key === 'i') { e.preventDefault(); services.navigateTo('inbox'); return; }
  if (key === 't') { e.preventDefault(); services.navigateTo('today'); return; }
  if (key === 'u') { e.preventDefault(); services.navigateTo('upcoming'); return; }
  if (key === 'c') { e.preventDefault(); services.navigateTo('completed'); return; }
  if (key === 'k') { e.preventDefault(); services.navigateTo('calendar'); return; }
  if (key === 'b') {
    if (!supportsBoard()) return;
    e.preventDefault();
    state.ui.layout = state.ui.layout === 'board' ? 'list' : 'board';
    saveState();
    requestRender();
    pulseViewIn();
    return;
  }
  if (e.key === '?') {
    e.preventDefault();
    openShortcuts();
  }
});

/* ============================================================
   BOOT
============================================================ */
export async function initChrome({ renderSortMenu: sortMenuFn, supportsBoard: boardFn, renderMain } = {}) {
  if (sortMenuFn) renderSortMenu = sortMenuFn;
  if (boardFn) supportsBoard = boardFn;
  if (renderMain) renderMainView = renderMain;

  // Feature modules ask the chrome about the mobile drawer through the
  // registry, because features must not import UI modules.
  services.isMobileSidebar = isMobileSidebar;
  services.closeMobileSidebar = closeMobileSidebar;

  // Sidebar preferences (device-local, never synced).
  const [sidebarPref, sections] = await Promise.all([
    store.getDoc(store.keys.sidebarCollapsed),
    store.getDoc(store.keys.sectionCollapse),
  ]);
  sidebarCollapsedPref = sidebarPref === true;
  if (sections && typeof sections === 'object') {
    SECTION_NAMES.forEach(name => {
      if (typeof sections[name] === 'boolean') setSectionCollapsed(name, sections[name]);
    });
  }
  applySidebarState();
}
