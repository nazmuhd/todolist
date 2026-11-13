/**
 * The due-date dialog: the inline calendar, natural-language parsing,
 * reminders, repeat rules and the repeat end condition.
 *
 * It edits the task dialog's draft through `core/app.js` so the task modal
 * and this module never import each other.
 */
import { $, $$, uid, modalState, cleanRecurrence } from '../core/app.js';
import { toISODate, todayISO, formatDue, parseDate, localTimeZone, cleanDateTime, toLocalDateTime } from '../core/dates.js';
import { taskReminders, parseRecurrence, recurrenceToText } from '../core/tasks.js';
import { escapeHtml } from '../core/text.js';
import { services } from '../core/services.js';
import { ensureNotificationPermission } from '../core/reminders.js';
import { currentPosition } from '../core/location.js';
import { showToast } from '../core/toasts.js';

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
const dueDeadlineInput = $('#due-deadline');
const dueDeadlineTimeInput = $('#due-deadline-time');
const dueRepeatMode = $('#due-repeat-mode');
const dueRepeatModeWrap = $('#due-repeat-mode-wrap');
const dueTimeZone = $('#due-timezone');

const draft = () => modalState.draft;

function toDateTimeInput(d) {
  return d ? toLocalDateTime(d) : '';
}

function defaultReminderAt(r) {
  if (r && r.at) return r.at;
  const t = draft() || {};
  if (t.due) return `${t.due}T${t.dueTime || '09:00'}`;
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return toDateTimeInput(d);
}

/** Replaces one reminder with the shape the chosen kind needs. */
function reminderWithKind(r, kind) {
  const id = r.id || uid();
  if (kind === 'absolute') return { id, at: defaultReminderAt(r) };
  if (kind === 'location') {
    // A location reminder starts at the user's own position, so it is
    // already armed the moment it is saved.
    return { id, lat: 0, lon: 0, radius: 150, name: '' };
  }
  return { id, minutes: Number.isInteger(r.minutes) ? r.minutes : 30 };
}

dueStartInput.addEventListener('change', () => {
  if (!draft()) return;
  draft().startDate = dueStartInput.value || null;
  services.updateModalChips();
});

dueDeadlineInput.addEventListener('change', () => {
  if (!draft()) return;
  draft().deadline = dueDeadlineInput.value || null;
  if (!draft().deadline) draft().deadlineTime = null;
  services.updateModalChips();
});

dueDeadlineTimeInput.addEventListener('change', () => {
  if (!draft()) return;
  draft().deadlineTime = dueDeadlineTimeInput.value || null;
  services.updateModalChips();
});

dueTimeZone.addEventListener('change', () => {
  if (!draft()) return;
  draft().timeZone = dueTimeZone.value || null;
  renderDueReminders();
  services.updateModalChips();
});

function fillTimeZones() {
  if (dueTimeZone.options.length) return;
  const local = localTimeZone();
  dueTimeZone.innerHTML = `<option value="">Browser timezone${local ? ` (${escapeHtml(local)})` : ''}</option>`;
  let zones = [];
  try {
    if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone');
  } catch { /* older browsers */ }
  if (!zones.length) {
    zones = ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Istanbul', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];
  }
  dueTimeZone.insertAdjacentHTML('beforeend', zones.map(z => `<option value="${escapeHtml(z)}">${escapeHtml(z)}</option>`).join(''));
}

const REMINDER_OPTIONS = [
  [0, 'At time of due date'],
  [10, '10 minutes before'],
  [30, '30 minutes before'],
  [60, '1 hour before'],
  [120, '2 hours before'],
  [1440, '1 day before'],
];

const REMINDER_UNITS = [
  [1, 'minutes'],
  [60, 'hours'],
  [1440, 'days'],
];

/** Splits a custom offset into the largest whole unit. */
export function reminderCustomParts(minutes) {
  const n = Number.isInteger(minutes) ? minutes : 15;
  if (n > 0 && n % 1440 === 0) return { value: n / 1440, unit: 1440 };
  if (n > 0 && n % 60 === 0) return { value: n / 60, unit: 60 };
  return { value: n, unit: 1 };
}

function setDraftReminders(list) {
  if (!draft()) return;
  draft().reminders = list;
  // The first relative reminder stays the "primary" one for older code.
  const relative = list.find(r => Number.isInteger(r.minutes));
  draft().reminderMinutes = relative ? relative.minutes : null;
}

function renderDueReminders() {
  const list = taskReminders(draft());
  dueRemindersBox.innerHTML = list.length ? list.map(r => {
    const absolute = Boolean(r.at);
    const location = Number.isFinite(r.lat) && Number.isFinite(r.lon);
    return `
    <div class="rounded border border-td-border p-1.5 space-y-1" data-reminder-id="${escapeHtml(r.id)}">
      <div class="flex items-center gap-1">
        <select class="flex-1 min-w-0 text-xs bg-transparent focus:outline-none" data-reminder-kind aria-label="Reminder type">
          <option value="relative" ${absolute || location ? '' : 'selected'}>Relative to due</option>
          <option value="absolute" ${absolute ? 'selected' : ''}>At a specific time</option>
          <option value="location" ${location ? 'selected' : ''}>When I'm nearby</option>
        </select>
        <button type="button" class="text-td-muted hover:text-red-600 p-1" data-reminder-remove title="Remove reminder" aria-label="Remove reminder">
          <i data-lucide="x" class="w-3.5 h-3.5"></i>
        </button>
      </div>
      ${location ? `
        <input type="text" value="${escapeHtml(r.name || '')}" data-reminder-location-name placeholder="Place name (optional)"
          class="w-full text-xs border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30" />
        <div class="flex items-center gap-1">
          <input type="number" step="any" value="${r.lat}" data-reminder-lat aria-label="Latitude"
            class="w-24 text-xs border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30" />
          <input type="number" step="any" value="${r.lon}" data-reminder-lon aria-label="Longitude"
            class="w-24 text-xs border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30" />
          <input type="number" min="10" max="50000" step="10" value="${r.radius || 150}" data-reminder-radius aria-label="Radius in metres"
            class="w-20 text-xs border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30" />
          <span class="text-[11px] text-td-muted">m</span>
        </div>
        <button type="button" class="qa-pick w-full" data-reminder-use-location>
          <i data-lucide="map-pin" class="w-3 h-3"></i> Use my current location
        </button>`
      : absolute ? `
        <input type="datetime-local" data-reminder-at value="${escapeHtml(r.at)}" aria-label="Reminder time"
          class="w-full text-xs border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30" />`
      : (() => {
        const preset = REMINDER_OPTIONS.some(([v]) => v === Number(r.minutes));
        const parts = reminderCustomParts(r.minutes);
        return `
        <select class="w-full text-xs border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30" data-reminder-minutes aria-label="Reminder">
          ${REMINDER_OPTIONS.map(([v, l]) => `<option value="${v}" ${Number(r.minutes) === v ? 'selected' : ''}>${l}</option>`).join('')}
          <option value="custom" ${preset ? '' : 'selected'}>Custom…</option>
        </select>
        <div class="flex items-center gap-1 ${preset ? 'hidden' : ''}" data-reminder-custom>
          <input type="number" min="1" max="10080" step="1" value="${parts.value}" data-reminder-custom-value
            aria-label="Custom reminder amount"
            class="w-16 text-xs border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30" />
          <select class="text-xs border border-td-border rounded px-1 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30" data-reminder-custom-unit aria-label="Custom reminder unit">
            ${REMINDER_UNITS.map(([v, l]) => `<option value="${v}" ${parts.unit === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <span class="text-[11px] text-td-muted">before</span>
        </div>`;
      })()}
    </div>`;
  }).join('')
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
  const row = e.target.closest('[data-reminder-id]');
  if (!row) return;
  const list = taskReminders(draft());
  if (e.target.matches('[data-reminder-kind]')) {
    const kind = e.target.value;
    setDraftReminders(list.map(r => (r.id === row.dataset.reminderId ? reminderWithKind(r, kind) : r)));
    renderDueReminders();
    services.updateModalChips();
    return;
  }
  if (e.target.matches('[data-reminder-at]')) {
    const at = cleanDateTime(e.target.value);
    setDraftReminders(list.map(r => (r.id === row.dataset.reminderId
      ? (at ? { id: r.id, at } : r)
      : r)));
    return;
  }
  if (e.target.matches('[data-reminder-lat]') || e.target.matches('[data-reminder-lon]')) {
    const latInput = row.querySelector('[data-reminder-lat]');
    const lonInput = row.querySelector('[data-reminder-lon]');
    const radiusInput = row.querySelector('[data-reminder-radius]');
    const lat = Number(latInput?.value);
    const lon = Number(lonInput?.value);
    const radius = Math.max(10, Math.min(50000, Number(radiusInput?.value) || 150));
    setDraftReminders(list.map(r => (r.id === row.dataset.reminderId
      ? { id: r.id, lat, lon, radius, name: r.name || '' }
      : r)));
    return;
  }
  if (e.target.matches('[data-reminder-radius]')) {
    const radius = Math.max(10, Math.min(50000, Number(e.target.value) || 150));
    setDraftReminders(list.map(r => (r.id === row.dataset.reminderId
      ? { id: r.id, lat: r.lat, lon: r.lon, radius, name: r.name || '' }
      : r)));
    return;
  }
  if (e.target.matches('[data-reminder-location-name]')) {
    const name = e.target.value;
    setDraftReminders(list.map(r => (r.id === row.dataset.reminderId
      ? { id: r.id, lat: r.lat, lon: r.lon, radius: r.radius, name }
      : r)));
    return;
  }
  const select = e.target.closest('[data-reminder-minutes]');
  if (!select) return;
  if (select.value === 'custom') {
    // Switch a preset to a custom offset using a non-preset default.
    setDraftReminders(list.map(r => {
      if (r.id !== row.dataset.reminderId) return r;
      const current = Number(r.minutes);
      const preset = REMINDER_OPTIONS.some(([v]) => v === current);
      return { id: r.id, minutes: preset ? 15 : current };
    }));
    renderDueReminders();
    const input = dueRemindersBox.querySelector('[data-reminder-id="' + row.dataset.reminderId + '"] [data-reminder-custom-value]');
    if (input) input.focus();
    services.updateModalChips();
    return;
  }
  setDraftReminders(list.map(r => (r.id === row.dataset.reminderId
    ? { id: r.id, minutes: Number(select.value) }
    : r)));
});

// Live-update a custom offset without re-rendering (keeps focus in the input).
dueRemindersBox.addEventListener('input', (e) => {
  if (!e.target.matches('[data-reminder-custom-value]')) return;
  const row = e.target.closest('[data-reminder-id]');
  if (!row) return;
  const unit = Number(row.querySelector('[data-reminder-custom-unit]')?.value) || 1;
  const amount = Math.max(0, Math.min(10080, Math.round(Number(e.target.value) || 0)));
  const minutes = Math.min(10080, amount * unit);
  setDraftReminders(taskReminders(draft()).map(r => (r.id === row.dataset.reminderId
    ? { id: r.id, minutes }
    : r)));
  services.updateModalChips();
});
dueRemindersBox.addEventListener('change', (e) => {
  if (!e.target.matches('[data-reminder-custom-unit]')) return;
  const row = e.target.closest('[data-reminder-id]');
  if (!row) return;
  const valueInput = row.querySelector('[data-reminder-custom-value]');
  const amount = Math.max(0, Math.min(10080, Math.round(Number(valueInput?.value) || 0)));
  const minutes = Math.min(10080, amount * (Number(e.target.value) || 1));
  setDraftReminders(taskReminders(draft()).map(r => (r.id === row.dataset.reminderId
    ? { id: r.id, minutes }
    : r)));
  services.updateModalChips();
});

dueRemindersBox.addEventListener('click', async (e) => {
  // "Use my current location" fills the coordinates in.
  const locate = e.target.closest('[data-reminder-use-location]');
  if (locate) {
    const row = locate.closest('[data-reminder-id]');
    if (!row) return;
    locate.disabled = true;
    try {
      const pos = await currentPosition();
      const latInput = row.querySelector('[data-reminder-lat]');
      const lonInput = row.querySelector('[data-reminder-lon]');
      if (latInput) latInput.value = pos.lat.toFixed(5);
      if (lonInput) lonInput.value = pos.lon.toFixed(5);
      const list = taskReminders(draft());
      setDraftReminders(list.map(r => (r.id === row.dataset.reminderId
        ? { id: r.id, lat: pos.lat, lon: pos.lon, radius: r.radius || 150, name: r.name || '' }
        : r)));
      services.updateModalChips();
    } catch (err) {
      showToast(err.message || 'Could not read your location', 'error');
    } finally {
      locate.disabled = false;
    }
    return;
  }

  const btn = e.target.closest('[data-reminder-remove]');
  if (!btn) return;
  const row = btn.closest('[data-reminder-id]');
  setDraftReminders(taskReminders(draft()).filter(r => r.id !== row.dataset.reminderId));
  renderDueReminders();
  services.updateModalChips();
});

$('#due-add-reminder').onclick = () => {
  const list = taskReminders(draft());
  // A relative reminder needs something to be relative to; don't silently
  // drop it on save. Defaulting to today matches Todoist's prompting flow.
  if (!draft().due) setDueDate(todayISO());
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
  dueNlStatus.className = `text-xs mt-2 ml-1 min-h-[16px] ${
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
  fillTimeZones();
  dueTimeInput.value = t.dueTime || '';
  dueAllDayInput.checked = !t.dueTime;
  dueTimeInput.disabled = !t.dueTime;
  dueRepeatInput.value = t.recurrence ? recurrenceToText(t.recurrence) : '';
  dueStartInput.value = t.startDate || '';
  dueStartWrap.classList.toggle('hidden', !t.recurrence);
  dueRepeatMode.value = t.recurrenceMode === 'completion' ? 'completion' : 'scheduled';
  dueRepeatModeWrap.classList.toggle('hidden', !t.recurrence);
  dueDeadlineInput.value = t.deadline || '';
  dueDeadlineTimeInput.value = t.deadlineTime || '';
  dueTimeZone.value = t.timeZone || '';
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
    // Absolute reminders do not need a due date; relative ones do.
    setDraftReminders(taskReminders(draft()).filter(r => r.at));
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
        setDraftReminders(taskReminders(draft()).filter(r => r.at));
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
    deadline: draft().deadline,
    deadlineTime: draft().deadlineTime,
    recurrence: draft().recurrence,
    recurrenceMode: draft().recurrenceMode,
    timeZone: draft().timeZone,
    startDate: draft().startDate,
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
  const parsed = parseRecurrence(raw);
  if (!parsed.body) {
    dueRepeatStatus.textContent = 'Not sure what that means — try “every Monday”.';
    dueRepeatStatus.className = 'text-[11px] mt-0.5 min-h-[14px] text-red-600';
    return false;
  }
  // Keep any end condition the user already chose.
  draft().recurrence = recurrenceWithEnd(parsed.body, recurrenceEndFromBody(draft().recurrence));
  draft().recurrenceMode = parsed.mode;
  dueRepeatMode.value = parsed.mode;
  if (!draft().due) setDueDate(todayISO());
  dueRepeatInput.value = draft().recurrence ? recurrenceToText(draft().recurrence) : '';
  dueRepeatStatus.textContent = `Repeats: ${recurrenceToText(draft().recurrence)}`;
  dueRepeatStatus.className = 'text-[11px] mt-0.5 min-h-[14px] text-green-700';
  syncDueRepeatEnd();
  return true;
}

dueRepeatMode.addEventListener('change', () => {
  if (!draft()) return;
  draft().recurrenceMode = dueRepeatMode.value === 'completion' ? 'completion' : 'scheduled';
});

export function commitDueEdits() {
  if (!draft()) return false;
  if (dueModal.open && !parseDueRepeatField()) return false;
  if (!draft().due) {
    draft().dueTime = null;
    draft().recurrence = null;
    setDraftReminders(taskReminders(draft()).filter(r => r.at));
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

// The due chip opens the quick menu (features/chip-menus.js), which offers
// this editor from its last row. The editor is also opened from the
// context menu and the swipe gesture.

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
    draft().deadline = dueEditorSnapshot.deadline;
    draft().deadlineTime = dueEditorSnapshot.deadlineTime;
    draft().recurrence = dueEditorSnapshot.recurrence;
    draft().recurrenceMode = dueEditorSnapshot.recurrenceMode;
    draft().timeZone = dueEditorSnapshot.timeZone;
    draft().startDate = dueEditorSnapshot.startDate;
    setDraftReminders((dueEditorSnapshot.reminders || []).map(r => ({ ...r })));
    draft().reminderMinutes = dueEditorSnapshot.reminderMinutes;
    services.updateModalChips();
  }
  dueEditorCommitted = false;
  dueEditorSnapshot = null;
});
