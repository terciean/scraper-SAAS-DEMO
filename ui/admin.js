const loginView = document.getElementById('loginView');
const brokersView = document.getElementById('brokersView');
const adminBar = document.getElementById('adminBar');
const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const toastEl = document.getElementById('toast');

const api = async (path, body) => {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

const SUB_LABEL = { trialing: 'trialing', active: 'active', past_due: 'past due', canceled: 'canceled' };

function showLogin() {
  loginView.hidden = false;
  brokersView.hidden = true;
  adminBar.hidden = true;
}

function showBrokers() {
  loginView.hidden = true;
  brokersView.hidden = false;
  adminBar.hidden = false;
}

function render(brokers) {
  rowsEl.innerHTML = '';
  emptyEl.hidden = brokers.length > 0;

  brokers.forEach((b) => {
    const tr = document.createElement('tr');
    const trialNote = b.subscriptionStatus === 'trialing' && b.trialEndsAt
      ? `<div class="sub">until ${new Date(`${b.trialEndsAt.replace(' ', 'T')}Z`).toLocaleDateString()}</div>`
      : '';

    const nearCap = (used, cap) => used >= cap ? 'sub-status canceled' : used >= cap * 0.8 ? 'sub-status past_due' : 'sub';

    tr.innerHTML = `
      <td>${b.name}<div class="sub">${b.email}</div></td>
      <td><span class="wa-status ${b.waStatus}">${b.waStatus}</span>${b.waPhone ? `<span class="wa-phone">+${b.waPhone}</span>` : ''}</td>
      <td>${b.leadCount} total<div class="sub">${b.contactedCount} contacted · ${b.repliedCount} replied</div></td>
      <td>
        <div class="${nearCap(b.whatsappSent, b.whatsappCap)}">${b.whatsappSent}/${b.whatsappCap} sends</div>
        <div class="${nearCap(b.qualified, b.qualifyCap)}">${b.qualified}/${b.qualifyCap} qualified</div>
      </td>
      <td><span class="sub-status ${b.subscriptionStatus}">${SUB_LABEL[b.subscriptionStatus] ?? b.subscriptionStatus}</span>${trialNote}</td>
      <td>
        <div class="admin-actions">
          <button class="btn ghost" data-status="active" ${b.subscriptionStatus === 'active' ? 'disabled' : ''}>Activate</button>
          <button class="btn ghost" data-status="past_due" ${b.subscriptionStatus === 'past_due' ? 'disabled' : ''}>Past due</button>
          <button class="btn ghost" data-status="canceled" ${b.subscriptionStatus === 'canceled' ? 'disabled' : ''}>Cancel</button>
          <button class="btn ghost" data-status="trialing">Reset trial</button>
        </div>
      </td>`;
    tr.dataset.id = b.id;
    rowsEl.appendChild(tr);
  });
}

async function loadBrokers() {
  const { status, data } = await api('/api/admin/brokers');
  if (status === 401) { showLogin(); return; }
  showBrokers();
  render(data.brokers ?? []);
}

document.getElementById('submit').addEventListener('click', async () => {
  const passwordEl = document.getElementById('password');
  const errorEl = document.getElementById('error');
  errorEl.hidden = true;

  const { status, data } = await api('/api/admin/login', { password: passwordEl.value });
  if (status !== 200) {
    errorEl.textContent = data.error || 'login failed';
    errorEl.hidden = false;
    return;
  }
  passwordEl.value = '';
  loadBrokers();
});

document.getElementById('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('submit').click();
});

document.getElementById('refresh').addEventListener('click', loadBrokers);

document.getElementById('logout').addEventListener('click', async () => {
  await api('/api/admin/logout', {});
  showLogin();
});

rowsEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-status]');
  if (!btn) return;
  const brokerId = Number(btn.closest('tr').dataset.id);
  const status = btn.dataset.status;
  btn.disabled = true;
  const { status: httpStatus, data } = await api('/api/admin/subscription', { brokerId, status });
  if (httpStatus !== 200) { toast(data.error || 'failed'); btn.disabled = false; return; }
  toast(`Updated`);
  loadBrokers();
});

loadBrokers();
