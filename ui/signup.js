const nameEl = document.getElementById('name');
const emailEl = document.getElementById('email');
const passwordEl = document.getElementById('password');
const errorEl = document.getElementById('error');
const submitBtn = document.getElementById('submit');

async function submit() {
  errorEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing up…';

  const res = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nameEl.value.trim(), email: emailEl.value.trim(), password: passwordEl.value }),
  });
  const r = await res.json();

  submitBtn.disabled = false;
  submitBtn.textContent = 'Sign up';

  if (r.error) {
    errorEl.textContent = r.error;
    errorEl.hidden = false;
    return;
  }

  window.location.href = '/connect.html';
}

submitBtn.addEventListener('click', submit);
passwordEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
