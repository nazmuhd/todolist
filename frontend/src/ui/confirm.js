import { $ } from '../core/app.js';
import { services } from '../core/services.js';

let resolver = null;
let lastFocused = null;

function cleanup(result) {
  const modal = $('#confirm-modal');
  if (!modal) return;
  if (resolver) {
    const resolve = resolver;
    resolver = null;
    resolve(result);
  }
  if (modal.open) modal.close();
  const restore = lastFocused;
  lastFocused = null;
  if (restore && typeof restore.focus === 'function') {
    try { restore.focus(); } catch {}
  }
}

export function confirmDialog({
  title = 'Confirm',
  message = '',
  confirmText = 'Delete',
  cancelText = 'Cancel',
  danger = true,
} = {}) {
  const modal = $('#confirm-modal');
  if (!modal) return Promise.resolve(window.confirm(message || title));

  // Resolve any pending confirmation as cancelled.
  if (resolver) cleanup(false);

  $('#confirm-modal-title').textContent = title;
  $('#confirm-modal-message').textContent = message;
  $('#confirm-modal-cancel').textContent = cancelText;

  const confirmBtn = $('#confirm-modal-confirm');
  confirmBtn.textContent = confirmText;
  confirmBtn.className = danger
    ? 'px-4 py-2 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors'
    : 'px-4 py-2 text-sm font-medium rounded-lg bg-td-red text-white hover:bg-red-700 transition-colors';

  const iconWrap = $('#confirm-modal-icon');
  if (iconWrap) {
    iconWrap.className = danger
      ? 'mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600'
      : 'mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-gray-100 text-td-text';
  }

  lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (typeof lucide !== 'undefined') lucide.createIcons();

  return new Promise((resolve) => {
    resolver = resolve;
    modal.showModal();
    setTimeout(() => confirmBtn.focus(), 0);
  });
}

export function initConfirmDialog() {
  const modal = $('#confirm-modal');
  if (!modal) return;

  $('#confirm-modal-cancel')?.addEventListener('click', () => cleanup(false));
  $('#confirm-modal-confirm')?.addEventListener('click', () => cleanup(true));

  modal.addEventListener('cancel', (e) => {
    e.preventDefault();
    cleanup(false);
  });

  modal.addEventListener('close', () => {
    // Handles ESC or programmatic close without explicit resolution.
    if (resolver) cleanup(false);
  });

  services.confirmDialog = confirmDialog;
}
