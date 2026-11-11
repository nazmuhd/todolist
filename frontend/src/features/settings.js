/**
 * Settings: the dialog, the stored preferences and the theme.
 */
import { $, settings } from '../core/app.js';
import { store } from '../core/store.js';
import { escapeHtml } from '../core/text.js';
import { requestRender } from '../core/render.js';
import { pushSupported, pushPermission, isPushEnabled, enablePush, disablePush } from '../core/push.js';

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
    </div>`).join('') + pushSection();
}

$('#settings-body').addEventListener('click', async (e) => {
  const pushBtn = e.target.closest('[data-push-toggle]');
  if (pushBtn) {
    pushBtn.disabled = true;
    if (pushReady) {
      await disablePush();
      pushReady = false;
    } else {
      pushReady = await enablePush();
    }
    renderSettings();
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
    if (enabled === pushReady) return;
    pushReady = enabled;
    if (settingsModal.open) renderSettings();
  });
};
$('#settings-close').onclick = () => settingsModal.close();

export function isSettingsOpen() {
  return settingsModal.open;
}

export function closeSettings() {
  if (settingsModal.open) settingsModal.close();
}
