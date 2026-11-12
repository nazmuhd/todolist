/**
 * The activity view: a log of what happened to your tasks.
 *
 * Every change the app records shows up here, newest first. A task that
 * was deleted is still listed, so the history keeps the story of work that
 * is no longer in the list.
 */
import { state } from '../core/state.js';
import { escapeHtml } from '../core/text.js';
import { activityEvents, EVENT_KINDS, taskStillExists, clearActivity } from '../core/activity.js';
import { showToast } from '../core/toasts.js';
import { services } from '../core/services.js';

const PAGE_SIZE = 100;
let shown = PAGE_SIZE;

/** Groups the events by calendar day, newest day first. */
function groupedEvents(events) {
  const groups = new Map();
  events.forEach(e => {
    const d = new Date(e.at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  });
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function dayLabel(key) {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  if (key === todayKey) return 'Today';
  if (key === yesterdayKey) return 'Yesterday';
  const d = new Date(`${key}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}

function timeLabel(at) {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function eventRow(e) {
  const kind = EVENT_KINDS[e.kind] || { label: e.kind, icon: 'dot' };
  const gone = e.taskId && !taskStillExists(e.taskId);
  return `
    <li class="flex items-start gap-2 py-1.5 px-1 border-b border-gray-100" data-activity-id="${escapeHtml(e.id)}">
      <i data-lucide="${escapeHtml(kind.icon)}" class="w-3.5 h-3.5 mt-0.5 text-td-muted flex-shrink-0"></i>
      <div class="flex-1 min-w-0">
        <div class="text-sm">
          <span class="font-medium">${escapeHtml(kind.label)}</span>
          ${e.title ? `<span class="text-td-text"> ${escapeHtml(e.title)}</span>` : ''}
        </div>
        ${e.detail ? `<div class="text-xs text-td-muted">${escapeHtml(e.detail)}</div>` : ''}
        ${gone ? '<div class="text-[11px] text-td-muted">This task has since been deleted</div>' : ''}
      </div>
      <span class="text-xs text-td-muted flex-shrink-0">${escapeHtml(timeLabel(e.at))}</span>
    </li>`;
}

/** Renders the activity view into the given element. */
export function renderActivity(box) {
  const events = activityEvents();
  if (!events.length) {
    box.innerHTML = `
      <div class="text-center py-10 text-td-muted text-sm">
        <i data-lucide="history" class="w-8 h-8 mx-auto mb-2 opacity-40"></i>
        Nothing has happened yet. Complete a task or move it around and it shows up here.
      </div>`;
    return;
  }

  const groups = groupedEvents(events);
  let count = 0;
  const body = groups.map(([key, list]) => {
    const rows = list.filter(() => count < shown).map(e => { count += 1; return eventRow(e); }).join('');
    if (!rows) return '';
    return `
      <li class="day-group-header" data-day-group="${escapeHtml(key)}">
        <span>${escapeHtml(dayLabel(key))}</span>
        <span class="text-td-muted font-normal">${list.length}</span>
      </li>
      ${rows}`;
  }).join('');

  box.innerHTML = `<ul class="list-none">${body}</ul>`
    + (events.length > shown
      ? `<button type="button" class="qa-pick w-full mt-3" data-activity-more>Show ${Math.min(PAGE_SIZE, events.length - shown)} more</button>`
      : '');

  const clearBtn = document.getElementById('activity-clear');
  if (clearBtn) clearBtn.hidden = false;
}

/** Wires the buttons of the activity view. */
export function initActivityView() {
  const box = document.getElementById('activity-view');
  if (!box) return;

  box.addEventListener('click', (e) => {
    const more = e.target.closest('[data-activity-more]');
    if (more) {
      shown += PAGE_SIZE;
      renderActivity(box);
      return;
    }
    const row = e.target.closest('[data-activity-id]');
    if (!row) return;
    const event = activityEvents().find(x => x.id === row.dataset.activityId);
    if (!event || !event.taskId || !taskStillExists(event.taskId)) return;
    services.openTaskModal(event.taskId);
  });

  const clearBtn = document.getElementById('activity-clear');
  if (clearBtn) {
    clearBtn.onclick = async () => {
      if (!confirm('Clear the whole activity history? This cannot be undone.')) return;
      await clearActivity();
      shown = PAGE_SIZE;
      renderActivity(box);
      showToast('Activity history cleared', 'success');
    };
  }
}

/** Resets the page when the view is opened again. */
export function resetActivityPage() {
  shown = PAGE_SIZE;
}
