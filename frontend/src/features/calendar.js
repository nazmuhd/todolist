/**
 * The calendar view: a month grid, or a week/day time grid with tasks
 * blocked by duration. Tasks can be dragged to reschedule them and an
 * empty time range can be dragged to create one.
 */
import { state, saveState } from '../core/state.js';
import { settings } from '../core/app.js';
import { activeTasks, priorityColor } from '../core/tasks.js';
import { parseDate, toISODate, todayISO, formatDateShort, formatDue, dueSortValue } from '../core/dates.js';
import { escapeHtml } from '../core/text.js';
import { requestRender } from '../core/render.js';
import { services } from '../core/services.js';
import { renderTaskRow, bindTaskEvents } from './task-row.js';

const CAL_MAX_CELL_TASKS = 3;
const HOUR_HEIGHT = 44;
const SNAP_MINUTES = 15;

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

function calendarScale() {
  return state.ui.calendarScale === 'week' || state.ui.calendarScale === 'day'
    ? state.ui.calendarScale
    : 'month';
}

/** The date the week/day grid is anchored on. */
function calendarAnchor(month, today) {
  const selected = state.ui.calendarSelected;
  if (selected && /^\d{4}-\d{2}-\d{2}$/.test(selected)) return selected;
  if (month === today.slice(0, 7)) return today;
  return `${month}-01`;
}

function weekDays(anchor) {
  const d = parseDate(anchor);
  const weekStart = settings.startOfWeek === 'sun' ? 0 : 1;
  d.setDate(d.getDate() - ((d.getDay() - weekStart + 7) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(d);
    day.setDate(d.getDate() + i);
    return toISODate(day);
  });
}

function shiftAnchor(anchor, scale, delta) {
  const d = parseDate(anchor);
  if (scale === 'day') d.setDate(d.getDate() + delta);
  else if (scale === 'week') d.setDate(d.getDate() + 7 * delta);
  else d.setMonth(d.getMonth() + delta);
  return toISODate(d);
}

function scaleLabel(anchor, scale) {
  if (scale === 'day') return calendarDayLabel(anchor);
  if (scale === 'week') {
    const days = weekDays(anchor);
    const first = parseDate(days[0]);
    const last = parseDate(days[6]);
    const opts = { month: 'short', day: 'numeric' };
    const start = formatDateShort(first, { year: first.getFullYear() !== last.getFullYear() });
    const end = formatDateShort(last, { year: first.getFullYear() !== last.getFullYear() });
    return `${start} – ${end}`;
  }
  return calendarMonthLabel(anchor.slice(0, 7));
}

function timeToMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function minutesToTime(minutes) {
  const total = Math.max(0, Math.min(24 * 60, minutes));
  const h = Math.floor(total / 60) % 24;
  const m = Math.round(total % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function snapMinutes(minutes) {
  return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
}

/** Timed tasks on a day, sorted by start time. */
function timedTasksOn(date) {
  return activeTasks()
    .filter(t => !t.completed && t.due === date && t.dueTime)
    .sort((a, b) => timeToMinutes(a.dueTime) - timeToMinutes(b.dueTime) || a.order - b.order);
}

function allDayTasksOn(date) {
  return activeTasks()
    .filter(t => !t.completed && t.due === date && !t.dueTime)
    .sort((a, b) => dueSortValue(a) - dueSortValue(b) || a.order - b.order);
}

function taskChip(t, extra = '') {
  return `<button type="button" class="cal-task" data-cal-task="${t.id}" draggable="true"
    style="border-left-color:${priorityColor(t.priority)}" title="${escapeHtml(t.title)}">${extra}${escapeHtml(t.title)}</button>`;
}

/** A positioned time-block chip; duration controls its height. */
function timeChip(t) {
  const start = timeToMinutes(t.dueTime);
  const duration = Number.isFinite(t.durationMinutes) && t.durationMinutes > 0 ? t.durationMinutes : 30;
  const top = (start / 60) * HOUR_HEIGHT;
  const height = Math.max(22, (duration / 60) * HOUR_HEIGHT);
  const label = `${t.dueTime} ${t.title}`;
  return `<button type="button" class="cal-time-chip" data-cal-task="${t.id}" draggable="true"
    style="top:${top}px;height:${height}px;border-left-color:${priorityColor(t.priority)}"
    title="${escapeHtml(`${t.dueTime}–${minutesToTime(start + duration)} ${t.title}`)}">${escapeHtml(label)}</button>`;
}

function renderTimeGrid(anchor, scale, today) {
  const days = scale === 'day' ? [anchor] : weekDays(anchor);
  const hours = Array.from({ length: 24 }, (_, h) => h);

  const head = `
    <div class="cal-time-head">
      <div class="cal-time-gutter"></div>
      <div class="cal-time-days" style="grid-template-columns:repeat(${days.length},minmax(0,1fr))">
        ${days.map(day => {
          const d = parseDate(day);
          const name = new Intl.DateTimeFormat('en', { weekday: 'short' }).format(d);
          return `<div class="cal-time-dayname${day === today ? ' today' : ''}" data-cal-date="${day}">
            <span>${name}</span><strong>${d.getDate()}</strong>
          </div>`;
        }).join('')}
      </div>
    </div>`;

  const allDay = `
    <div class="cal-allday">
      <div class="cal-time-gutter cal-allday-label">All day</div>
      <div class="cal-time-days" style="grid-template-columns:repeat(${days.length},minmax(0,1fr))">
        ${days.map(day => `
          <div class="cal-allday-cell" data-cal-date="${day}">
            ${allDayTasksOn(day).map(t => taskChip(t)).join('')}
          </div>`).join('')}
      </div>
    </div>`;

  const body = `
    <div class="cal-time-body">
      <div class="cal-time-gutter">
        ${hours.map(h => `<div class="cal-hour-label">${String(h).padStart(2, '0')}:00</div>`).join('')}
      </div>
      <div class="cal-time-days" style="grid-template-columns:repeat(${days.length},minmax(0,1fr))">
        ${days.map(day => `
          <div class="cal-time-col${day === today ? ' today' : ''}" data-cal-date="${day}">
            ${hours.map(h => `<div class="cal-time-slot" data-cal-hour="${h}"></div>`).join('')}
            ${timedTasksOn(day).map(t => timeChip(t)).join('')}
          </div>`).join('')}
      </div>
    </div>`;

  return `<div class="cal-time-scroll">${head}${allDay}${body}</div>`;
}

function renderMonthGrid(month, today) {
  const [year, mon] = month.split('-').map(Number);
  const first = new Date(year, mon - 1, 1);
  const weekStart = settings.startOfWeek === 'sun' ? 0 : 1;
  const offset = (first.getDay() - weekStart + 7) % 7;

  const selected = (state.ui.calendarSelected || '').startsWith(month)
    ? state.ui.calendarSelected
    : (month === today.slice(0, 7) ? today : `${month}-01`);

  return { offset, selected };
}

export function renderCalendar() {
  const box = document.getElementById('calendar-view');
  const today = todayISO();
  const month = state.ui.calendarMonth || today.slice(0, 7);
  const scale = calendarScale();
  const anchor = calendarAnchor(month, today);

  let title;
  let body;
  let dayPanel = '';

  if (scale === 'month') {
    const { offset } = renderMonthGrid(month, today);
    const [year, mon] = month.split('-').map(Number);
    title = calendarMonthLabel(month);

    const byDate = new Map();
    activeTasks().forEach(t => {
      if (!t.due) return;
      if (!byDate.has(t.due)) byDate.set(t.due, []);
      byDate.get(t.due).push(t);
    });

    const selected = (state.ui.calendarSelected || '').startsWith(month)
      ? state.ui.calendarSelected
      : (month === today.slice(0, 7) ? today : `${month}-01`);

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

    body = `
      <div class="cal-scroll">
        <div class="cal-grid">
          ${(settings.startOfWeek === 'sun' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']).map(d => `<div class="cal-dow">${d}</div>`).join('')}
          ${cells.map(c => `
            <div class="cal-cell${c.inMonth ? '' : ' other'}${c.iso === today ? ' today' : ''}${c.iso === selected ? ' selected' : ''}" data-cal-date="${c.iso}" role="button" tabindex="0" aria-label="${escapeHtml(calendarDayLabel(c.iso))}">
              <div class="cal-num">${c.num}</div>
              ${c.tasks.slice(0, CAL_MAX_CELL_TASKS).map(t => taskChip(t)).join('')}
              ${c.tasks.length > CAL_MAX_CELL_TASKS ? `<div class="cal-more">+${c.tasks.length - CAL_MAX_CELL_TASKS} more</div>` : ''}
            </div>`).join('')}
        </div>
      </div>`;

    const dayTasks = (byDate.get(selected) || []).sort((a, b) => dueSortValue(a) - dueSortValue(b));
    const groupBy = state.ui.calendarGroupBy === 'section' ? 'section' : state.ui.calendarGroupBy === 'project' ? 'project' : 'none';
    const groupLabel = (t) => {
      if (groupBy === 'project') {
        const p = state.projects.find(x => x.id === t.projectId);
        return p ? p.name : 'Inbox';
      }
      if (groupBy === 'section') {
        const p = state.projects.find(x => x.id === t.projectId);
        const s = p?.sections?.find(x => x.id === t.sectionId);
        if (s) return `${p?.name || 'Inbox'} / ${s.name}`;
        return p ? `${p.name} / No section` : 'Inbox / No section';
      }
      return '';
    };
    let dayBody = '<div class="text-xs text-td-muted px-2 py-4">No tasks on this day.</div>';
    if (dayTasks.length) {
      if (groupBy === 'none') {
        dayBody = `<ul class="space-y-0">${dayTasks.map(t => renderTaskRow(t, false)).join('')}</ul>`;
      } else {
        const groups = new Map();
        dayTasks.forEach(t => {
          const label = groupLabel(t) || 'Other';
          if (!groups.has(label)) groups.set(label, []);
          groups.get(label).push(t);
        });
        dayBody = [...groups.entries()].map(([label, tasks]) => `
          <div class="mb-3">
            <div class="text-xs font-semibold text-td-muted px-2 py-1">${escapeHtml(label)} <span class="font-normal">(${tasks.length})</span></div>
            <ul class="space-y-0">${tasks.map(t => renderTaskRow(t, false)).join('')}</ul>
          </div>`).join('');
      }
    }
    dayPanel = `
      <div class="cal-panel">
        <div class="cal-panel-head">
          <span>${escapeHtml(calendarDayLabel(selected))}</span>
          <div class="flex items-center gap-2">
            <label class="text-[11px] text-td-muted flex items-center gap-1">Group
              <select id="cal-group-by" class="text-xs border border-td-border rounded px-1.5 py-0.5 bg-white">
                <option value="none"${groupBy === 'none' ? ' selected' : ''}>None</option>
                <option value="project"${groupBy === 'project' ? ' selected' : ''}>Project</option>
                <option value="section"${groupBy === 'section' ? ' selected' : ''}>Section</option>
              </select>
            </label>
            <button type="button" id="cal-add" class="text-xs text-td-muted hover:text-td-text flex items-center gap-1">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i>Add task
            </button>
          </div>
        </div>
        <div class="cal-panel-body">${dayBody}</div>
      </div>`;
  } else {
    title = scaleLabel(anchor, scale);
    body = renderTimeGrid(anchor, scale, today);
  }

  box.innerHTML = `
    <div class="cal-toolbar">
      <button type="button" id="cal-prev" class="cal-nav-btn" title="Previous" aria-label="Previous"><i data-lucide="chevron-left" class="w-4 h-4"></i></button>
      <h2 class="cal-title">${escapeHtml(title)}</h2>
      <button type="button" id="cal-next" class="cal-nav-btn" title="Next" aria-label="Next"><i data-lucide="chevron-right" class="w-4 h-4"></i></button>
      <button type="button" id="cal-today" class="text-xs text-td-muted hover:text-td-text px-2 py-1 ml-1">Today</button>
      <div class="cal-scale" role="group" aria-label="Calendar scale">
        ${['month', 'week', 'day'].map(s => `
          <button type="button" data-cal-scale="${s}" class="cal-scale-btn${s === scale ? ' active' : ''}" aria-pressed="${s === scale}">
            ${s[0].toUpperCase() + s.slice(1)}
          </button>`).join('')}
      </div>
    </div>
    ${body}
    ${dayPanel}`;

  document.getElementById('cal-prev').onclick = () => {
    const next = shiftAnchor(anchor, scale, -1);
    state.ui.calendarSelected = next;
    state.ui.calendarMonth = next.slice(0, 7);
    saveState();
    requestRender();
  };
  document.getElementById('cal-next').onclick = () => {
    const next = shiftAnchor(anchor, scale, 1);
    state.ui.calendarSelected = next;
    state.ui.calendarMonth = next.slice(0, 7);
    saveState();
    requestRender();
  };
  document.getElementById('cal-today').onclick = () => {
    state.ui.calendarMonth = today.slice(0, 7);
    state.ui.calendarSelected = today;
    saveState();
    requestRender();
  };
  const addBtn = document.getElementById('cal-add');
  if (addBtn) addBtn.onclick = () => services.openQuickAdd({ due: state.ui.calendarSelected || anchor });
  const groupSel = document.getElementById('cal-group-by');
  if (groupSel) groupSel.onchange = (e) => {
    state.ui.calendarGroupBy = e.target.value || 'none';
    saveState();
    requestRender();
  };
  box.querySelectorAll('[data-cal-scale]').forEach(btn => {
    btn.onclick = () => {
      state.ui.calendarScale = btn.dataset.calScale;
      state.ui.calendarSelected = anchor;
      saveState();
      requestRender();
    };
  });

  // Keep the time grid scrolled to the working day rather than midnight.
  const scroller = box.querySelector('.cal-time-scroll');
  if (scroller) scroller.scrollTop = 7 * HOUR_HEIGHT;

  bindTaskEvents(false);
  lucide.createIcons();
}

/* ---------- Calendar interaction: drag to reschedule / create ---------- */

function taskIdFromDrag(e) {
  return e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
}

/** Where a drop landed within a day column, as minutes from midnight. */
function dropMinutes(col, clientY) {
  const rect = col.getBoundingClientRect();
  const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
  return Math.min(24 * 60 - SNAP_MINUTES, Math.floor((y / HOUR_HEIGHT) * 60 / SNAP_MINUTES) * SNAP_MINUTES);
}

let unblockCalendar = null;

/**
 * One delegated handler: the calendar markup is replaced on every render.
 */
export function initCalendar() {
  const view = document.getElementById('calendar-view');

  view.addEventListener('click', (e) => {
    const taskBtn = e.target.closest('[data-cal-task]');
    if (taskBtn) {
      e.stopPropagation();
      services.openTaskModal(taskBtn.dataset.calTask);
      return;
    }
    const cell = e.target.closest('.cal-cell[data-cal-date]');
    if (cell) {
      state.ui.calendarSelected = cell.dataset.calDate;
      saveState();
      requestRender();
    }
  });

  view.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const cell = e.target.closest('.cal-cell[data-cal-date]');
    if (!cell) return;
    e.preventDefault();
    state.ui.calendarSelected = cell.dataset.calDate;
    saveState();
    requestRender();
  });

  // Drag a task onto a date/time to reschedule it.
  view.addEventListener('dragstart', (e) => {
    const chip = e.target.closest('[data-cal-task]');
    if (!chip) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', chip.dataset.calTask);
  });
  view.addEventListener('dragover', (e) => {
    const target = e.target.closest('[data-cal-date]');
    if (!target) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    target.classList.add('cal-drop-target');
  });
  view.addEventListener('dragleave', (e) => {
    const target = e.target.closest('[data-cal-date]');
    if (target) target.classList.remove('cal-drop-target');
  });
  view.addEventListener('drop', (e) => {
    const target = e.target.closest('[data-cal-date]');
    if (!target) return;
    e.preventDefault();
    target.classList.remove('cal-drop-target');
    const task = state.tasks.find(t => t.id === taskIdFromDrag(e));
    if (!task) return;
    const date = target.dataset.calDate;
    task.due = date;
    if (target.classList.contains('cal-time-col')) {
      task.dueTime = minutesToTime(dropMinutes(target, e.clientY));
    } else if (target.classList.contains('cal-allday-cell')) {
      task.dueTime = null;
    }
    saveState();
    requestRender();
  });

  // Drag vertically on empty time to create a task with a duration.
  let creating = null;
  view.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('[data-cal-task]') || e.target.closest('button')) return;
    const col = e.target.closest('.cal-time-col');
    if (!col) return;
    e.preventDefault();
    const start = dropMinutes(col, e.clientY);
    const ghost = document.createElement('div');
    ghost.className = 'cal-create-ghost';
    ghost.style.top = `${(start / 60) * HOUR_HEIGHT}px`;
    ghost.style.height = `${SNAP_MINUTES / 60 * HOUR_HEIGHT}px`;
    col.appendChild(ghost);
    creating = { col, date: col.dataset.calDate, start, end: start + SNAP_MINUTES, ghost };
  });
  const onMove = (e) => {
    if (!creating) return;
    const end = Math.max(creating.start + SNAP_MINUTES, dropMinutes(creating.col, e.clientY));
    creating.end = end;
    creating.ghost.style.top = `${(creating.start / 60) * HOUR_HEIGHT}px`;
    creating.ghost.style.height = `${((end - creating.start) / 60) * HOUR_HEIGHT}px`;
  };
  const onUp = () => {
    if (!creating) return;
    const { date, start, end, ghost } = creating;
    ghost.remove();
    creating = null;
    services.openQuickAdd({
      due: date,
      dueTime: minutesToTime(start),
      durationMinutes: Math.max(SNAP_MINUTES, end - start),
    });
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

  unblockCalendar = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
}

export function destroyCalendar() {
  if (unblockCalendar) unblockCalendar();
  unblockCalendar = null;
}
