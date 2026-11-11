/**
 * The due-date dialog: the inline calendar, natural-language parsing,
 * reminders, repeat rules and the repeat end condition.
 *
 * It edits the task dialog's draft through `core/app.js` so the task modal
 * and this module never import each other.
 */
import { $, $$, uid, modalState, cleanRecurrence } from '../core/app.js';
import { toISODate, todayISO, formatDue, parseDate } from '../core/dates.js';
import { taskReminders, parseRecurrenceText, recurrenceToText } from '../core/tasks.js';
import { escapeHtml } from '../core/text.js';
import { services } from '../core/services.js';
import { ensureNotificationPermission } from '../core/reminders.js';

const dueModal = $('#due-modal');
const dueNlInput = $('#due-nl');
const dueNlStatus = $('#due-nl-status');
const dueTimeInput = $('#due-time');
const dueAllDayInput = $('#due-allday');
const dueRepeatInput = $('#due-repeat');
const dueRepeatStatus = $('#due-repeat-status');
const dueRemindersBox = $('#due-reminders');
const dueRepeatEndBox = $('#due-repeat-end');
const dueRepeatEndMode = $('#due-repeat-end-mode');
const dueRepeatEndCount = $('#due-repeat-end-count');
const dueRepeatEndUntil = $('#due-repeat-end-until');
const dueRepeatEndUnit = $('#due-repeat-end-unit');
const dueStartWrap = $('#due-start-wrap');
const dueStartInput = $('#due-start');

const draft = () => modalState.draft;

dueStartInput.addEventListener('change', () => {
  if (!draft()) return;
  draft().startDate = dueStartInput.value || null;
  services.updateModalChips();
});

const REMINDER_OPTIONS = [
  [0, 'At time of due date'],
  [10, '10 minutes before'],
  [30, '30 minutes before'],
  [60, '1 hour before'],
  [120, '2 hours before'],
  [1440, '1 day before'],
];

function setDraftReminders(list) {
  if (!draft()) return;
  draft().reminders = list;
  // The first reminder stays the "primary" one for the scheduler.
  draft().reminderMinutes = list.length ? list[0].minutes : null;
}

function renderDueReminders() {
  const list = taskReminders(draft());
  dueRemindersBox.innerHTML = list.length ? list.map(r => `
    <div class="flex items-center gap-1" data-reminder-id="${escapeHtml(r.id)}">
      <select class="flex-1 text-xs border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30" data-reminder-minutes aria-label="Reminder">
        ${REMINDER_OPTIONS.map(([v, l]) => `<option value="${v}" ${Number(r.minutes) === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <button type="button" class="text-td-muted hover:text-red-600 p-1" data-reminder-remove title="Remove reminder" aria-label="Remove reminder">
        <i data-lucide="x" class="w-3.5 h-3.5"></i>
      </button>
    </div>`).join('')
    : '<div class="text-[11px] text-td-muted">No reminders.</div>';
  lucide.createIcons();
}

/* ---------- Repeat end conditions (COUNT / UNTIL) ---------- */
function recurrenceBase(body) {
  return String(body || '').split(';').filter(p => p && !/^(COUNT|UNTIL)=/i.test(p)).join(';');
}

export function recurrenceEndFromBody(body) {
  const c = /COUNT=(\d+)/i.exec(body || '');
  const u = /UNTIL=([0-9]{8})/i.exec(body || '');
  return {
    count: c ? Number(c[1]) : null,
    until: u ? `${u[1].slice(0, 4)}-${u[1].slice(4, 6)}-${u[1].slice(6, 8)}` : null,
  };
}

function recurrenceWithEnd(body, end) {
  const base = recurrenceBase(body);
  if (!base) return null;
  const parts = [base];
  if (end && end.count) parts.push(`COUNT=${end.count}`);
  else if (end && end.until) parts.push(`UNTIL=${end.until.replace(/-/g, '')}T235959Z`);
  return parts.join(';');
}

function syncDueRepeatEnd() {
  const body = draft() ? draft().recurrence : null;
  if (!body) {
    dueRepeatEndBox.classList.add('hidden');
    return;
  }
  dueRepeatEndBox.classList.remove('hidden');
  const end = recurrenceEndFromBody(body);
  dueRepeatEndMode.value = end.count ? 'count' : end.until ? 'until' : 'never';
  dueRepeatEndCount.value = end.count || '';
  dueRepeatEndUntil.value = end.until || '';
  const mode = dueRepeatEndMode.value;
  dueRepeatEndCount.classList.toggle('hidden', mode !== 'count');
  dueRepeatEndUnit.classList.toggle('hidden', mode !== 'count');
  dueRepeatEndUntil.classList.toggle('hidden', mode !== 'until');
}

function applyDueRepeatEnd() {
  if (!draft()) return;
  const mode = dueRepeatEndMode.value;
  const end = mode === 'count'
    ? { count: Math.max(1, Math.min(999, Number(dueRepeatEndCount.value) || 1)) }
    : mode === 'until' && dueRepeatEndUntil.value
      ? { until: dueRepeatEndUntil.value }
      : null;
  const body = recurrenceWithEnd(draft().recurrence, end);
  draft().recurrence = body ? cleanRecurrence(body) : null;
  dueRepeatInput.value = draft().recurrence ? recurrenceToText(draft().recurrence) : '';
  syncDueRepeatEnd();
  services.updateModalChips();
}

dueRepeatEndMode.addEventListener('change', applyDueRepeatEnd);
dueRepeatEndCount.addEventListener('change', applyDueRepeatEnd);
dueRepeatEndUntil.addEventListener('change', applyDueRepeatEnd);

dueRemindersBox.addEventListener('change', (e) => {
  const select = e.target.closest('[data-reminder-minutes]');
  if (!select) return;
  const row = select.closest('[data-reminder-id]');
  const list = taskReminders(draft()).map(r => (r.id === row.dataset.reminderId
    ? { ...r, minutes: Number(select.value) }
    : r));
  setDraftReminders(list);
});

dueRemindersBox.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-reminder-remove]');
  if (!btn) return;
  const row = btn.closest('[data-reminder-id]');
  setDraftReminders(taskReminders(draft()).filter(r => r.id !== row.dataset.reminderId));
  renderDueReminders();
  services.updateModalChips();
});

$('#due-add-reminder').onclick = () => {
  const list = taskReminders(draft());
  list.push({ id: uid(), minutes: 30 });
  setDraftReminders(list);
  renderDueReminders();
  services.updateModalChips();
};

let dueCalendar = null;
let dueCalendarSyncing = false;
let dueEditorSnapshot = null;
let dueEditorCommitted = false;

function setDueNlStatus(text, tone) {
  dueNlStatus.textContent = text || '';
  dueNlStatus.className = `text-[11px] mb-3 min-h-[16px] ${
    tone === 'error' ? 'text-red-600' : tone === 'ok' ? 'text-green-700' : 'text-td-muted'
  }`;
}

/** Keeps the calendar and the natural-language field in step with the draft. */
function syncDueDateControls() {
  const t = draft() || {};
  if (dueCalendar) {
    dueCalendarSyncing = true;
    if (t.due) {
      dueCalendar.setDate(t.due, false);
      dueCalendar.jumpToDate(parseDate(t.due), false);
    } else {
      dueCalendar.clear();
    }
    dueCalendarSyncing = false;
  }
  dueNlInput.value = t.due ? formatDue(t.due, t.dueTime) : '';
  setDueNlStatus(t.due ? `Selected: ${formatDue(t.due, t.dueTime)}` : 'No due date selected');
}

export function syncDueEditor() {
  const t = draft() || {};
  dueTimeInput.value = t.dueTime || '';
  dueAllDayInput.checked = !t.dueTime;
  dueTimeInput.disabled = !t.dueTime;
  dueRepeatInput.value = t.recurrence ? recurrenceToText(t.recurrence) : '';
  dueStartInput.value = t.startDate || '';
  dueStartWrap.classList.toggle('hidden', !t.recurrence);
  dueRepeatStatus.textContent = '';
  dueRepeatStatus.className = 'text-[11px] mt-0.5 min-h-[14px] text-td-muted';
  setDraftReminders(taskReminders(t));
  renderDueReminders();
  syncDueRepeatEnd();
  syncDueDateControls();
}

function setDueDate(iso) {
  draft().due = iso || null;
  if (!iso) {
    draft().dueTime = null;
    draft().recurrence = null;
    setDraftReminders([]);
  }
  syncDueEditor();
  services.updateModalChips();
}

/** Parses “tomorrow”, “next Friday”, “Jan 5 at 4pm” … */
function applyNaturalDue(raw) {
  const text = (raw || '').trim();
  if (!text) {
    setDueNlStatus('');
    return false;
  }
  if (!window.chrono) {
    setDueNlStatus('Natural language dates are unavailable.', 'error');
    return false;
  }

  const results = window.chrono.parse(text, new Date(), { forwardDate: true });
  if (!results.length) {
    setDueNlStatus('Could not find a date in that phrase.', 'error');
    return false;
  }

  const start = results[0].start;
  const date = start.date();
  const hasTime = start.isCertain('hour') || start.isCertain('minute');

  draft().due = toISODate(date);
  if (hasTime) {
    draft().dueTime = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  syncDueEditor();
  setDueNlStatus(`Due ${formatDue(draft().due, draft().dueTime)}`, 'ok');
  services.updateModalChips();
  return true;
}

function initDueCalendar() {
  if (dueCalendar || typeof window.flatpickr === 'undefined') return;
  dueCalendar = window.flatpickr('#due-calendar', {
    inline: true,
    dateFormat: 'Y-m-d',
    defaultDate: null,
    onChange: (dates, dateStr) => {
      if (dueCalendarSyncing || !draft()) return;
      draft().due = dateStr || null;
      if (!dateStr) {
        draft().dueTime = null;
        draft().recurrence = null;
        setDraftReminders([]);
        dueTimeInput.value = '';
        dueAllDayInput.checked = true;
        dueTimeInput.disabled = true;
        dueRepeatInput.value = '';
        renderDueReminders();
        syncDueRepeatEnd();
      }
      dueNlInput.value = dateStr ? formatDue(dateStr, draft().dueTime) : '';
      setDueNlStatus(dateStr ? `Selected: ${formatDue(dateStr, draft().dueTime)}` : 'No due date selected');
      services.updateModalChips();
    },
  });
}

export function openDueEditor() {
  if (!draft() || dueModal.open) return;
  dueEditorSnapshot = {
    due: draft().due,
    dueTime: draft().dueTime,
    recurrence: draft().recurrence,
    reminders: taskReminders(draft()).map(r => ({ ...r })),
    reminderMinutes: draft().reminderMinutes,
  };
  dueEditorCommitted = false;
  dueModal.showModal();
  initDueCalendar();
  syncDueEditor();
  if (!services.isMobileSidebar()) {
    dueNlInput.focus();
    const end = dueNlInput.value.length;
    dueNlInput.setSelectionRange(end, end);
  }
}

function parseDueRepeatField() {
  const raw = dueRepeatInput.value.trim();
  if (!raw) {
    draft().recurrence = null;
    dueRepeatStatus.textContent = '';
    syncDueRepeatEnd();
    return true;
  }
  const body = parseRecurrenceText(raw);
  if (!body) {
    dueRepeatStatus.textContent = 'Not sure what that means — try “every Monday”.';
    dueRepeatStatus.className = 'text-[11px] mt-0.5 min-h-[14px] text-red-600';
    return false;
  }
  // Keep any end condition the user already chose.
  draft().recurrence = recurrenceWithEnd(body, recurrenceEndFromBody(draft().recurrence));
  if (!draft().due) setDueDate(todayISO());
  dueRepeatInput.value = draft().recurrence ? recurrenceToText(draft().recurrence) : '';
  dueRepeatStatus.textContent = `Repeats: ${recurrenceToText(draft().recurrence)}`;
  dueRepeatStatus.className = 'text-[11px] mt-0.5 min-h-[14px] text-green-700';
  syncDueRepeatEnd();
  return true;
}

export function commitDueEdits() {
  if (!draft()) return false;
  if (dueModal.open && !parseDueRepeatField()) return false;
  if (!draft().due) {
    draft().dueTime = null;
    draft().recurrence = null;
    setDraftReminders([]);
  }
  services.updateModalChips();
  return true;
}

export function isDueEditorOpen() {
  return dueModal.open;
}

export function closeDueEditor() {
  if (dueModal.open) dueModal.close();
}

$('#meta-due').onclick = (e) => {
  e.stopPropagation();
  services.closeMetaMenus();
  openDueEditor();
};

dueNlInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  applyNaturalDue(dueNlInput.value);
});
dueNlInput.addEventListener('change', () => {
  if (dueNlInput.value.trim()) applyNaturalDue(dueNlInput.value);
});
dueAllDayInput.addEventListener('change', () => {
  if (dueAllDayInput.checked) {
    draft().dueTime = null;
    dueTimeInput.value = '';
    dueTimeInput.disabled = true;
  } else {
    dueTimeInput.disabled = false;
    if (!dueTimeInput.value) dueTimeInput.value = '09:00';
    draft().dueTime = dueTimeInput.value;
  }
  dueNlInput.value = draft().due ? formatDue(draft().due, draft().dueTime) : '';
  services.updateModalChips();
});
dueTimeInput.addEventListener('change', () => {
  if (!dueTimeInput.value) {
    dueAllDayInput.checked = true;
    draft().dueTime = null;
  } else {
    draft().dueTime = dueTimeInput.value;
  }
  dueNlInput.value = draft().due ? formatDue(draft().due, draft().dueTime) : '';
  services.updateModalChips();
});
dueRepeatInput.addEventListener('input', () => {
  dueRepeatStatus.textContent = '';
});
dueRepeatInput.addEventListener('change', parseDueRepeatField);
dueRepeatInput.addEventListener('blur', parseDueRepeatField);

dueRemindersBox.addEventListener('change', (e) => {
  if (e.target.closest('[data-reminder-minutes]')) ensureNotificationPermission();
});

$$('[data-due-preset]').forEach(btn => {
  btn.onclick = (e) => {
    e.stopPropagation();
    const d = new Date();
    if (btn.dataset.duePreset === 'tomorrow') d.setDate(d.getDate() + 1);
    if (btn.dataset.duePreset === 'next-week') d.setDate(d.getDate() + 7);
    setDueDate(toISODate(d));
  };
});

$('#due-clear').onclick = (e) => {
  e.stopPropagation();
  setDueDate(null);
};

$('#due-done').onclick = (e) => {
  e.stopPropagation();
  if (!parseDueRepeatField()) {
    dueRepeatInput.focus();
    return;
  }
  dueEditorCommitted = true;
  dueModal.close();
};

$('#due-cancel').onclick = () => dueModal.close();
$('#due-close').onclick = () => dueModal.close();

dueModal.addEventListener('close', () => {
  if (!dueEditorCommitted && dueEditorSnapshot && draft()) {
    draft().due = dueEditorSnapshot.due;
    draft().dueTime = dueEditorSnapshot.dueTime;
    draft().recurrence = dueEditorSnapshot.recurrence;
    setDraftReminders((dueEditorSnapshot.reminders || []).map(r => ({ ...r })));
    draft().reminderMinutes = dueEditorSnapshot.reminderMinutes;
    services.updateModalChips();
  }
  dueEditorCommitted = false;
  dueEditorSnapshot = null;
});
