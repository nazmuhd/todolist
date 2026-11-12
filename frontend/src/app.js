import './styles.css';

import { $, settings, modalState } from './core/app.js';
import { store } from './core/store.js';
import { defaultState, migrateState, SCHEMA_VERSION, state, setState, saveState, syncReminderSchedule } from './core/state.js';
import { addTask } from './core/tasks.js';
import { formatDue } from './core/dates.js';
import { showToast } from './core/toasts.js';
import { services } from './core/services.js';
import { setRenderer } from './core/render.js';
import { isKnownView, syncHash, navigateTo, taskIdFromHash } from './core/router.js';
import { actionFromHash, handleNotificationAction, initNotificationActions } from './core/notification-actions.js';
import { startReminders } from './core/reminders.js';
import { syncLocationWatch } from './core/location.js';
import { loadActivity } from './core/activity.js';
import { loadUndoHistory, clearUndoHistory, initUndo } from './core/undo.js';
import { initSync, scheduleSync } from './core/sync.js';
import { loadSavedFilters, initFilterEditor } from './features/filters.js';
import { initSelection } from './features/selection.js';
import { initCalendar } from './features/calendar.js';
import { initTemplates } from './features/templates.js';
import { renderMain, renderSortMenu, supportsBoard, initListView, completionDayLabel } from './views/list.js';
import { renderSidebar } from './views/sidebar.js';
import { initBoard } from './views/board.js';
import { initActivityView } from './views/activity.js';
import { initRailMenu, closeRailMenu } from './ui/rail-menu.js';
import { setSidebarCollapsed } from './ui/chrome.js';
import { renderStorageBadge } from './features/backup.js';
import { loadSettings, applyTheme } from './features/settings.js';
import { openTaskModal, closeTaskModal } from './features/task-modal.js';
import { openQuickAdd, parseQuickAdd } from './features/quickadd.js';
import { initChrome, applySidebarState } from './ui/chrome.js';
import { openRowMenu } from './ui/row-menu.js';

/* ============================================================
   STORAGE
   All persistence goes through the adapter in storage.js. Moving to
   a backend later is a one-line change:
     const store = new TodoStore.ApiStore({ token });
============================================================ */

// The undo layer retires a stale snapshot on every save.
initUndo();

/** Reads the saved state, keeping an unreadable payload as a backup. */
async function loadState() {
  const raw = await store.loadState();
  if (!raw) return { state: defaultState(), storedVersion: null };
  try {
    return { state: migrateState(raw), storedVersion: raw.version ?? 1 };
  } catch (err) {
    console.warn('Saved data could not be read:', err);
    // Keep the unreadable payload instead of silently destroying it.
    await store.backupState('corrupt').catch(() => {});
    return { state: defaultState(), storedVersion: null };
  }
}

/* ============================================================
   SERVICE WORKER (offline)
============================================================ */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .catch(err => console.warn('Service worker registration failed:', err));
  });
}

/* ============================================================
   RENDERING
============================================================ */
function render() {
  renderSidebar();
  renderMain();
  renderStorageBadge();
  lucide.createIcons();
}

// The core asks for a repaint through this hook, so it never has to
// import the views (which would be a circular dependency).
setRenderer(render);

// The features reach the entry point through this registry for the same
// reason: the other way round would be a cycle.
services.openTaskModal = openTaskModal;
services.openQuickAdd = openQuickAdd;
services.navigateTo = navigateTo;
services.openRowMenu = openRowMenu;
services.closeRailMenu = closeRailMenu;
services.setSidebarCollapsed = setSidebarCollapsed;
services.syncHash = syncHash;
services.scheduleSync = scheduleSync;

/* ============================================================
   CROSS-TAB SYNC
   The store announces saves in other tabs (BroadcastChannel, with the
   storage event as a fallback). We adopt their data but keep this
   tab's current view/search so the UI doesn't jump under the user.
============================================================ */
let syncingFromPeer = false;

store.onChange(async (key) => {
  if (syncingFromPeer) return;
  if (key && key !== store.keys.state) return;

  let incoming;
  try {
    const raw = await store.loadState();
    if (!raw) return;
    incoming = migrateState(raw);
  } catch (err) {
    console.warn('Ignored malformed data from another tab:', err);
    return;
  }

  const editing = modalState.editingTaskId;
  clearUndoHistory(); // remote data supersedes the local undo history
  setState({ ...incoming, ui: state.ui });
  render();

  if (editing && !state.tasks.some(t => t.id === editing)) {
    closeTaskModal();
    showToast('That task was deleted in another tab', 'error');
  } else {
    showToast('Synced from another tab');
  }
});

/* ============================================================
   INIT
============================================================ */
async function init() {
  // The state loads from IndexedDB, so show a placeholder while it does.
  $('#loading-skeleton').classList.remove('hidden');

  // A notification action link is handled after the data is loaded.
  const pendingAction = actionFromHash();

  // Filters must be known before the state is read: a saved filter can be
  // the active view, and the state loader validates the view name.
  await loadSavedFilters();

  const loaded = await loadState();
  setState(loaded.state);

  await loadUndoHistory();
  await loadActivity();
  await loadSettings();
  applyTheme();
  await initChrome({ renderSortMenu, supportsBoard, renderMain });

  if (location.hash.length > 1) {
    const raw = location.hash.replace(/^#\/?/, '');
    if (!taskIdFromHash()) {
      const [viewPart, queryPart] = raw.split('?');
      const view = decodeURIComponent(viewPart || 'inbox');
      const q = queryPart ? (new URLSearchParams(queryPart).get('q') || '') : '';
      if (isKnownView(view)) {
        state.ui.view = view;
        state.ui.search = q;
        state.ui.sort = (state.ui.sortByView && state.ui.sortByView[view]) || 'manual';
        $('#search-input').value = q;
      }
    }
  }

  render();
  $('#loading-skeleton').classList.add('hidden');
  applySidebarState();

  initNotificationActions();
  if (pendingAction) {
    handleNotificationAction(pendingAction.action, pendingAction.taskId);
    syncHash();
  }

  const linkedTaskId = taskIdFromHash();
  if (linkedTaskId && state.tasks.some(t => t.id === linkedTaskId)) {
    openTaskModal(linkedTaskId);
  }

  // Persist right away on first run, or right after a migration.
  if (loaded.storedVersion !== SCHEMA_VERSION) saveState();

  syncReminderSchedule();
  startReminders();
  // Location reminders fire while a tab is open and the browser shares a
  // position. The watcher is only armed when a task actually has one.
  syncLocationWatch();
  // Per-entity server sync runs after the first paint; it never blocks boot.
  initSync().catch(() => {});
  // Handy hook for tests and for anything that wants to wait for boot.
  window.__appReady = true;
}

/* The views and features wire their own event handlers. */
initSelection();
initCalendar();
initTemplates();
initBoard();
initActivityView();
initFilterEditor();
initRailMenu();
initListView(() => renderMain());

init();

/* ============================================================
   TEST SURFACE
   The headless harness imports this module to drive the app, so the
   pieces it needs are exported (live bindings, so `state` stays live).
============================================================ */
export { state, settings, formatDue, parseQuickAdd, addTask, completionDayLabel, saveState };
