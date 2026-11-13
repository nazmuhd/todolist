const params = new URLSearchParams(location.search);
document.getElementById('email').value = params.get('email') || '';
const token = params.get('token') || '';

function showAlert(message, isSuccess = false) {
  const el = document.getElementById('auth-alert');
  el.className = `mb-4 p-3 rounded-lg text-xs font-medium ${isSuccess ? 'bg-green-50 text-td-green border border-green-200' : 'bg-red-50 text-td-red border border-red-200'}`;
  el.textContent = message;
  el.classList.remove('hidden');
}

async function getCsrfToken() {
  const res = await fetch('/auth/csrf', { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  return data?.csrfToken || '';
}

async function handleReset(e) {
  e.preventDefault();
  document.getElementById('auth-alert').classList.add('hidden');
  document.getElementById('password-error').classList.add('hidden');
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!token || !email) { showAlert('Missing reset token or email. Please use the link from your email.'); return; }
  if (password.length < 8) { document.getElementById('password-error').classList.remove('hidden'); return; }
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  try {
    const csrfToken = await getCsrfToken();
    const res = await fetch('/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
      credentials: 'include',
      body: JSON.stringify({ token, email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showAlert(data.error || 'Unable to reset password.'); return; }
    showAlert(data.message || 'Password reset successfully. You can now log in.', true);
    setTimeout(() => location.href = '/login.html', 1200);
  } catch (err) {
    showAlert('Unable to reach the server. Please try again.');
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('reset-form')?.addEventListener('submit', handleReset);
