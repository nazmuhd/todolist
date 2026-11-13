import './landing.css';
import './lucide-setup.js';

(async () => {
  try {
    const res = await fetch('/auth/me', { credentials: 'include' });
    if (res.ok) window.location.replace('/app/v1/#/inbox');
  } catch {}
})();

function togglePasswordVisibility() {
  const input = document.getElementById('auth-password');
  const icon = document.getElementById('eye-icon');
  if (input.type === 'password') {
    input.type = 'text';
    icon.setAttribute('data-lucide', 'eye-off');
  } else {
    input.type = 'password';
    icon.setAttribute('data-lucide', 'eye');
  }
  if (window.lucide?.createIcons) lucide.createIcons();
}

function updatePasswordHint() {}

async function getCsrfToken() {
  const res = await fetch('/auth/csrf', { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  return data?.csrfToken || '';
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  clearErrors();

  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  if (!emailValid) {
    document.getElementById('email-wrap').classList.add('error');
    document.getElementById('email-error').classList.remove('hidden');
    return;
  }

  if (password.length < 8) {
    document.getElementById('password-wrap').classList.add('error');
    document.getElementById('password-error').classList.remove('hidden');
    return;
  }

  const btn = document.getElementById('auth-submit-btn');
  btn.disabled = true;
  try {
    const csrfToken = await getCsrfToken();
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showAlert(data.error || 'Login failed.', false);
      return;
    }
    showAlert('Logged in successfully. Redirecting...', true);
    setTimeout(() => { window.location.href = '/app/v1/#/inbox'; }, 600);
  } catch (err) {
    showAlert('Unable to reach the server. Please try again.', false);
  } finally {
    btn.disabled = false;
  }
}

function clearErrors() {
  document.getElementById('auth-alert').classList.add('hidden');
  document.getElementById('email-wrap').classList.remove('error');
  document.getElementById('email-error').classList.add('hidden');
  document.getElementById('password-wrap').classList.remove('error');
  document.getElementById('password-error').classList.add('hidden');
}

function showAlert(message, isSuccess = false) {
  const alertBox = document.getElementById('auth-alert');
  alertBox.className = `mb-4 p-3 rounded-lg text-xs font-medium flex items-start gap-2 ${isSuccess ? 'bg-green-50 text-td-green border border-green-200' : 'bg-red-50 text-td-red border border-red-200'}`;
  alertBox.replaceChildren();
  const span = document.createElement('span');
  span.textContent = String(message ?? '');
  alertBox.appendChild(span);
  alertBox.classList.remove('hidden');
}

function handleOAuth(provider) {
  showAlert(`${provider} sign-in is not available yet.`, false);
}

document.getElementById('auth-form')?.addEventListener('submit', handleAuthSubmit);
document.querySelector('button[aria-label="Toggle password visibility"]')?.addEventListener('click', togglePasswordVisibility);
document.querySelectorAll('[data-oauth-provider]').forEach(btn => {
  btn.addEventListener('click', () => handleOAuth(btn.dataset.oauthProvider || 'Provider'));
});

if (window.lucide?.createIcons) lucide.createIcons();
