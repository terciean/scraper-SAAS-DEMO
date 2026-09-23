const emailEl = document.getElementById('email');
const passwordEl = document.getElementById('password');
const errorEl = document.getElementById('error');
const submitBtn = document.getElementById('submit');

async function submit() {
  errorEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Logging in…';

  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: emailEl.value.trim(), password: passwordEl.value }),
  });
  const r = await res.json();

  submitBtn.disabled = false;
  submitBtn.textContent = 'Log in';

  if (r.error) {
    errorEl.textContent = r.error;
    errorEl.hidden = false;
    return;
  }

  window.location.href = '/connect.html';
}

submitBtn.addEventListener('click', submit);
passwordEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
