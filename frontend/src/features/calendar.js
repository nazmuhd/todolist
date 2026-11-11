/**
 * The calendar view: a month grid with a day panel.
 */
import { state, saveState } from '../core/state.js';
import { settings } from '../core/app.js';
import { activeTasks, priorityColor } from '../core/tasks.js';
import { parseDate, toISODate, todayISO, formatDateShort, dueSortValue } from '../core/dates.js';
import { escapeHtml } from '../core/text.js';
import { requestRender } from '../core/render.js';
import { services } from '../core/services.js';
import { renderTaskRow, bindTaskEvents } from './task-row.js';

const CAL_MAX_CELL_TASKS = 3;

export function calendarMonthShift(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function calendarMonthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
}

export function calendarDayLabel(iso) {
  const d = parseDate(iso);
  const weekday = new Intl.DateTimeFormat('en', { weekday: 'long' }).format(d);
  return `${weekday}, ${formatDateShort(d, { year: true })}`;
}

export function renderCalendar() {
  const box = document.getElementById('calendar-view');
  const today = todayISO();
  const month = state.ui.calendarMonth || today.slice(0, 7);
  const [year, mon] = month.split('-').map(Number);
  const first = new Date(year, mon - 1, 1);
  const weekStart = settings.startOfWeek === 'sun' ? 0 : 1;
  const offset = (first.getDay() - weekStart + 7) % 7;

  const selected = (state.ui.calendarSelected || '').startsWith(month)
    ? state.ui.calendarSelected
    : (month === today.slice(0, 7) ? today : `${month}-01`);

  const byDate = new Map();
  activeTasks().forEach(t => {
    if (!t.due) return;
    if (!byDate.has(t.due)) byDate.set(t.due, []);
    byDate.get(t.due).push(t);
  });

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, mon - 1, i - offset + 1);
    const iso = toISODate(d);
    cells.push({
      iso,
      num: d.getDate(),
      inMonth: d.getMonth() === mon - 1,
      tasks: byDate.get(iso) || [],
    });
  }

  const dayTasks = (byDate.get(selected) || []).sort((a, b) => dueSortValue(a) - dueSortValue(b));

  box.innerHTML = `
    <div class="cal-toolbar">
      <button type="button" id="cal-prev" class="cal-nav-btn" title="Previous month" aria-label="Previous month"><i data-lucide="chevron-left" class="w-4 h-4"></i></button>
      <h2 class="cal-title">${escapeHtml(calendarMonthLabel(month))}</h2>
      <button type="button" id="cal-next" class="cal-nav-btn" title="Next month" aria-label="Next month"><i data-lucide="chevron-right" class="w-4 h-4"></i></button>
      <button type="button" id="cal-today" class="text-xs text-td-muted hover:text-td-text px-2 py-1 ml-1">Today</button>
    </div>

    <div class="cal-scroll">
      <div class="cal-grid">
        ${(weekStart === 1 ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']).map(d => `<div class="cal-dow">${d}</div>`).join('')}
        ${cells.map(c => `
          <div class="cal-cell${c.inMonth ? '' : ' other'}${c.iso === today ? ' today' : ''}${c.iso === selected ? ' selected' : ''}" data-cal-date="${c.iso}" role="button" tabindex="0" aria-label="${escapeHtml(calendarDayLabel(c.iso))}">
            <div class="cal-num">${c.num}</div>
            ${c.tasks.slice(0, CAL_MAX_CELL_TASKS).map(t => `
              <button type="button" class="cal-task" data-cal-task="${t.id}" style="border-left-color:${priorityColor(t.priority)}" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</button>`).join('')}
            ${c.tasks.length > CAL_MAX_CELL_TASKS ? `<div class="cal-more">+${c.tasks.length - CAL_MAX_CELL_TASKS} more</div>` : ''}
          </div>`).join('')}
      </div>
    </div>

    <div class="cal-panel">
      <div class="cal-panel-head">
        <span>${escapeHtml(calendarDayLabel(selected))}</span>
        <button type="button" id="cal-add" class="text-xs text-td-muted hover:text-td-text flex items-center gap-1">
          <i data-lucide="plus" class="w-3.5 h-3.5"></i>Add task
        </button>
      </div>
      <div class="cal-panel-body">
        ${dayTasks.length
          ? `<ul class="space-y-0">${dayTasks.map(t => renderTaskRow(t, false)).join('')}</ul>`
          : '<div class="text-xs text-td-muted px-2 py-4">No tasks on this day.</div>'}
      </div>
    </div>`;

  document.getElementById('cal-prev').onclick = () => {
    state.ui.calendarMonth = calendarMonthShift(month, -1);
    state.ui.calendarSelected = null;
    saveState();
    requestRender();
  };
  document.getElementById('cal-next').onclick = () => {
    state.ui.calendarMonth = calendarMonthShift(month, 1);
    state.ui.calendarSelected = null;
    saveState();
    requestRender();
  };
  document.getElementById('cal-today').onclick = () => {
    state.ui.calendarMonth = today.slice(0, 7);
    state.ui.calendarSelected = today;
    saveState();
    requestRender();
  };
  document.getElementById('cal-add').onclick = () => services.openQuickAdd({ due: selected });

  bindTaskEvents(false);
  lucide.createIcons();
}

/**
 * One delegated handler: the calendar markup is replaced on every render.
 */
export function initCalendar() {
  document.getElementById('calendar-view').addEventListener('click', (e) => {
    const taskBtn = e.target.closest('[data-cal-task]');
    if (taskBtn) {
      e.stopPropagation();
      services.openTaskModal(taskBtn.dataset.calTask);
      return;
    }
    const cell = e.target.closest('[data-cal-date]');
    if (cell) {
      state.ui.calendarSelected = cell.dataset.calDate;
      saveState();
      requestRender();
    }
  });

  document.getElementById('calendar-view').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const cell = e.target.closest('[data-cal-date]');
    if (!cell) return;
    e.preventDefault();
    state.ui.calendarSelected = cell.dataset.calDate;
    saveState();
    requestRender();
  });
}
