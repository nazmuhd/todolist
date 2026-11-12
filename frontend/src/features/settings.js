/**
 * Settings: the dialog, the stored preferences and the theme.
 */
import { $, settings } from '../core/app.js';
import { store } from '../core/store.js';
import { escapeHtml } from '../core/text.js';
import { requestRender } from '../core/render.js';
import { pushSupported, pushPermission, isPushEnabled, enablePush, disablePush, listPushDevices, removePushDevice } from '../core/push.js';
import { listBackups, takeBackup, restoreBackup, backupLabel } from '../core/backups.js';

const DEFAULT_SETTINGS = {
  theme: 'system',
  startOfWeek: 'mon',
  dateFormat: 'system',
  timeFormat: 'system',
  defaultPriority: null,
  defaultReminder: null,
};

const SETTINGS_DEFS = [
  { key: 'theme', label: 'Theme', options: [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']] },
  { key: 'startOfWeek', label: 'Week starts on', options: [['mon', 'Monday'], ['sun', 'Sunday']] },
  { key: 'dateFormat', label: 'Date format', options: [['system', 'System'], ['mdy', 'Nov 12, 2026'], ['dmy', '12 Nov 2026'], ['iso', '2026-11-12']] },
  { key: 'timeFormat', label: 'Time format', options: [['system', 'System'], ['12h', '12-hour'], ['24h', '24-hour']] },
  { key: 'defaultPriority', label: 'Default priority', options: [[null, 'None'], [1, 'P1'], [2, 'P2'], [3, 'P3'], [4, 'P4']] },
  {
    key: 'defaultReminder',
    label: 'Default reminder',
    options: [[null, 'None'], [0, 'At due time'], [10, '10 min before'], [30, '30 min before'], [60, '1 hour before'], [120, '2 hours before'], [1440, '1 day before']],
  },
];

export async function loadSettings() {
  const raw = await store.getDoc(store.keys.settings);
  if (!raw || typeof raw !== 'object') {
    Object.assign(settings, DEFAULT_SETTINGS);
    return;
  }
  Object.assign(settings, {
    theme: ['light', 'dark', 'system'].includes(raw.theme) ? raw.theme : DEFAULT_SETTINGS.theme,
    startOfWeek: ['mon', 'sun'].includes(raw.startOfWeek) ? raw.startOfWeek : DEFAULT_SETTINGS.startOfWeek,
    dateFormat: ['system', 'mdy', 'dmy', 'iso'].includes(raw.dateFormat) ? raw.dateFormat : DEFAULT_SETTINGS.dateFormat,
    timeFormat: ['system', '12h', '24h'].includes(raw.timeFormat) ? raw.timeFormat : DEFAULT_SETTINGS.timeFormat,
    defaultPriority: [1, 2, 3, 4].includes(raw.defaultPriority) ? raw.defaultPriority : null,
    defaultReminder: raw.defaultReminder === null || raw.defaultReminder === undefined
      ? null
      : Number(raw.defaultReminder),
  });
}

export function persistSettings() {
  store.setDoc(store.keys.settings, settings).catch(err => console.error('Could not save settings:', err));
}

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme() {
  const theme = settings.theme === 'system' ? (darkMedia.matches ? 'dark' : 'light') : settings.theme;
  document.documentElement.dataset.theme = theme;
}

if (darkMedia.addEventListener) darkMedia.addEventListener('change', applyTheme);
else if (darkMedia.addListener) darkMedia.addListener(applyTheme); // older Safari

const settingsModal = $('#settings-modal');
let pushReady = false;
let pushDevices = [];

function deviceRow(device, index) {
  const name = device.label || 'Unknown device';
  const last = device.lastSeenAt ? new Date(device.lastSeenAt) : null;
  const seen = last && !Number.isNaN(last.getTime())
    ? ` · last seen ${last.toLocaleDateString()}`
    : '';
  return `
    <div class="flex items-center gap-2 text-xs py-1" data-device-row="${index}">
      <i data-lucide="smartphone" class="w-3.5 h-3.5 text-td-muted flex-shrink-0"></i>
      <span class="flex-1 truncate" title="${escapeHtml(device.userAgent || name)}">${escapeHtml(name)}${escapeHtml(seen)}</span>
      <button type="button" class="text-td-muted hover:text-red-600 p-0.5" data-device-remove="${index}" title="Remove this device" aria-label="Remove ${escapeHtml(name)}">
        <i data-lucide="x" class="w-3.5 h-3.5"></i>
      </button>
    </div>`;
}

async function refreshPushDevices() {
  pushDevices = await listPushDevices();
  if (settingsModal.open) renderSettings();
}

function pushSection() {
  if (!pushSupported()) return '';
  const blocked = pushPermission() === 'denied';
  return `
    <div class="mb-2 border-t border-td-border pt-4">
      <div class="text-xs text-td-muted mb-1">Reminders on this device</div>
      <p class="text-xs text-td-muted mb-2">Push reminders keep arriving after you close the app.</p>
      <button type="button" class="qa-pick" data-push-toggle ${blocked ? 'disabled' : ''}>
        ${blocked ? 'Notifications blocked in browser settings' : (pushReady ? 'Disable push reminders' : 'Enable push reminders')}
      </button>
      ${pushDevices.length ? `
        <div class="mt-3">
          <div class="text-xs text-td-muted mb-1">Registered devices</div>
          ${pushDevices.map(deviceRow).join('')}
        </div>` : ''}
    </div>`;
}

/** The automatic backups the server holds. */
let backupRows = [];
let backupsLoaded = false;

function backupRow(row) {
  return `
    <div class="flex items-center gap-2 text-xs py-1" data-backup-row="${row.id}">
      <i data-lucide="archive" class="w-3.5 h-3.5 text-td-muted flex-shrink-0"></i>
      <span class="flex-1 truncate" title="${escapeHtml(backupLabel(row))}">${escapeHtml(backupLabel(row))}</span>
      <button type="button" class="text-td-muted hover:text-td-text px-1 py-0.5 rounded" data-backup-restore="${row.id}" title="Restore this backup">Restore</button>
    </div>`;
}

/**
 * The backups section. The server takes a backup on its own every hour and
 * keeps the last 24; this shows them and lets one be restored.
 */
function backupSection() {
  if (!backupsLoaded) return '';
  return `
    <div class="mb-2 border-t border-td-border pt-4">
      <div class="text-xs text-td-muted mb-1">Automatic backups</div>
      <p class="text-xs text-td-muted mb-2">The server snapshots your data every hour and keeps the last 24. Restore one to go back to it.</p>
      <button type="button" class="qa-pick" data-backup-now>Back up now</button>
      ${backupRows.length ? `
        <div class="mt-3">
          <div class="text-xs text-td-muted mb-1">Backups</div>
          ${backupRows.slice(0, 10).map(backupRow).join('')}
          ${backupRows.length > 10 ? `<div class="text-[11px] text-td-muted mt-1">and ${backupRows.length - 10} more</div>` : ''}
        </div>` : `
        <div class="text-[11px] text-td-muted mt-2">No backups yet.</div>`}
    </div>`;
}

async function refreshBackups() {
  backupRows = await listBackups();
  backupsLoaded = true;
  if (settingsModal.open) renderSettings();
}

/**
 * The keyboard shortcuts live in their own overlay, which the header button
 * and the collapsed-rail menu both open.
 */
function shortcutsSection() {
  return `
    <div class="mb-2 border-t border-td-border pt-4">
      <div class="text-xs text-td-muted mb-1">Keyboard shortcuts</div>
      <p class="text-xs text-td-muted mb-2">Press <kbd class="kbd">?</kbd> anywhere to see the full list.</p>
      <button type="button" class="qa-pick" data-open-shortcuts>
        <i data-lucide="keyboard" class="w-3.5 h-3.5"></i> Show the keyboard shortcuts
      </button>
    </div>`;
}

function renderSettings() {
  $('#settings-body').innerHTML = SETTINGS_DEFS.map(def => `
    <div class="mb-4">
      <div class="text-xs text-td-muted mb-1">${escapeHtml(def.label)}</div>
      <div class="flex flex-wrap gap-1">
        ${def.options.map(([value, label]) => {
          const raw = value === null ? 'null' : String(value);
          const active = String(settings[def.key] ?? 'null') === raw;
          return `<button type="button" class="qa-pick" data-setting="${def.key}" data-value="${escapeHtml(raw)}" aria-pressed="${active}">${escapeHtml(label)}</button>`;
        }).join('')}
      </div>
    </div>`).join('') + shortcutsSection() + backupSection() + pushSection();
}

$('#settings-body').addEventListener('click', async (e) => {
  // Open the keyboard shortcuts overlay.
  if (e.target.closest('[data-open-shortcuts]')) {
    closeSettings();
    document.getElementById('shortcuts-btn')?.click();
    return;
  }

  // Restore one of the automatic backups.
  const restoreBtn = e.target.closest('[data-backup-restore]');
  if (restoreBtn) {
    const id = Number(restoreBtn.dataset.backupRestore);
    if (!confirm('Restore this backup? Your current data will be replaced.')) return;
    restoreBtn.disabled = true;
    const ok = await restoreBackup(id);
    if (ok) {
      showToast('Backup restored', 'success');
      // The live data changed under us, so it is pulled again.
      window.location.reload();
    }
    return;
  }

  // Take a backup right now.
  if (e.target.closest('[data-backup-now]')) {
    const btn = e.target.closest('[data-backup-now]');
    btn.disabled = true;
    const rows = await takeBackup();
    if (rows) {
      backupRows = rows;
      backupsLoaded = true;
      showToast('Backup taken', 'success');
    }
    renderSettings();
    return;
  }

  const removeBtn = e.target.closest('[data-device-remove]');
  if (removeBtn) {
    const device = pushDevices[Number(removeBtn.dataset.deviceRemove)];
    if (!device) return;
    removeBtn.disabled = true;
    await removePushDevice(device.endpoint);
    await refreshPushDevices();
    return;
  }

  const pushBtn = e.target.closest('[data-push-toggle]');
  if (pushBtn) {
    pushBtn.disabled = true;
    if (pushReady) {
      await disablePush();
      pushReady = false;
    } else {
      pushReady = await enablePush();
    }
    await refreshPushDevices();
    return;
  }

  const btn = e.target.closest('[data-setting]');
  if (!btn) return;
  const key = btn.dataset.setting;
  const raw = btn.dataset.value;
  const def = SETTINGS_DEFS.find(d => d.key === key);
  const option = def && def.options.find(([value]) => (value === null ? 'null' : String(value)) === raw);
  if (!option) return;
  settings[key] = option[0];
  persistSettings();
  applyTheme();
  renderSettings();
  requestRender();
});

$('#settings-btn').onclick = () => {
  renderSettings();
  if (!settingsModal.open) settingsModal.showModal();
  isPushEnabled().then((enabled) => {
    if (enabled !== pushReady) {
      pushReady = enabled;
      if (settingsModal.open) renderSettings();
    }
  });
  refreshPushDevices();
  refreshBackups();
};
$('#settings-close').onclick = () => settingsModal.close();

export function isSettingsOpen() {
  return settingsModal.open;
}

export function closeSettings() {
  if (settingsModal.open) settingsModal.close();
}
