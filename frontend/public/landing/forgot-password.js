(async () => {
  try {
    const res = await fetch('/auth/me', { credentials: 'include' });
    if (res.ok) window.location.replace('/app/v1/#/inbox');
  } catch {}
})();

async function getCsrfToken() {
  const res = await fetch('/auth/csrf', { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  return data?.csrfToken || '';
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  clearErrors();

  const email = document.getElementById('auth-email').value.trim();
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  if (!emailValid) {
    document.getElementById('email-wrap').classList.add('error');
    document.getElementById('email-error').classList.remove('hidden');
    return;
  }

  const btn = document.getElementById('auth-submit-btn');
  btn.disabled = true;
  try {
    const csrfToken = await getCsrfToken();
    const res = await fetch('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
      credentials: 'include',
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showAlert(data.error || 'Unable to process request.', false);
      return;
    }
    showAlert(data.message || 'If an account with that email exists, a password reset link has been sent.', true);
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

document.getElementById('auth-form')?.addEventListener('submit', handleAuthSubmit);
if (window.lucide?.createIcons) lucide.createIcons();
