/**
 * Toasts and screen-reader announcements.
 *
 * Toasts are visual only, so the same message is repeated in a polite
 * live region for assistive technology.
 */
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;


export function showToast(message, type = 'info', { actionLabel, onAction, duration = 2600, onTimeout } = {}) {
  announce(message);
  const container = document.getElementById('toast-container');
  if (!container) { console.log(message); return null; }

  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' toast-error' : type === 'success' ? ' toast-success' : '');

  const text = document.createElement('span');
  text.className = 'toast-message';
  text.textContent = message;
  el.appendChild(text);

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  };

  if (actionLabel && typeof onAction === 'function') {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = actionLabel;
    action.onclick = () => { dismiss(); onAction(); };
    el.appendChild(action);
  }

  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  timer = setTimeout(() => {
    if (typeof onTimeout === 'function') onTimeout();
    dismiss();
  }, duration);
  return el;
}

export function announce(message) {
  if (!message || !srStatus) return;
  srStatus.textContent = '';
  clearTimeout(srTimer);
  srTimer = setTimeout(() => { srStatus.textContent = message; }, 60);
}

// The live region the message is written to. It is looked up lazily, so
// the module can be imported before the document is parsed.
const srStatus = document.getElementById('sr-status');
let srTimer = null;
