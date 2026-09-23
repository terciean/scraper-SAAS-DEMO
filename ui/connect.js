const toastEl = document.getElementById('toast');
const whoamiEl = document.getElementById('whoami');
const statusBadge = document.getElementById('statusBadge');
const phoneLabel = document.getElementById('phoneLabel');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');

const api = async (path, body) => {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  if (res.status === 401) { window.location.href = '/login.html'; return {}; }
  return res.json();
};

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

const STATUS_LABEL = {
  disconnected: 'not connected',
  connecting: 'connecting…',
  qr_ready: 'scan QR',
  connected: 'connected',
  auth_failed: 'connection failed',
};

function paintStatus(status, phone) {
  statusBadge.className = `wa-status ${status}`;
  statusBadge.textContent = STATUS_LABEL[status] ?? status;
  phoneLabel.textContent = phone ? `+${phone}` : '';
  const connected = status === 'connected';
  connectBtn.hidden = connected;
  disconnectBtn.hidden = !connected;
}

async function loadMe() {
  const { broker } = await api('/api/auth/me');
  if (!broker) return;
  whoamiEl.textContent = `${broker.name} · ${broker.email}`;
}

async function refreshStatus() {
  const s = await api('/api/broker-whatsapp/status');
  if (!s.status) return;
  paintStatus(s.status, s.phone);
}

// ---------- connect / QR modal ----------
const qrModal = document.getElementById('qrModal');
const qrHint = document.getElementById('qrHint');
const qrBox = document.getElementById('qrBox');

let pollTimer;
let lastStatus = null;

function closeModal() {
  qrModal.hidden = true;
  clearTimeout(pollTimer);
}

// Same shape as ui/app.js's pollScrape(): recursive setTimeout, edge-triggered
// reactions so a status already reported once isn't re-toasted every tick.
async function pollStatus() {
  const s = await api('/api/broker-whatsapp/status');
  if (!s.status) return;
  paintStatus(s.status, s.phone);

  if (s.status !== lastStatus) {
    if (s.status === 'qr_ready' && s.qrDataUrl) {
      qrHint.textContent = 'Scan with WhatsApp → Linked devices';
      qrBox.innerHTML = `<img src="${s.qrDataUrl}" alt="WhatsApp QR code">`;
    } else if (s.status === 'connected') {
      qrHint.textContent = `Connected as +${s.phone}`;
      qrBox.innerHTML = '<span class="spinner">✓ ready to send</span>';
      toast('WhatsApp connected');
    } else if (s.status === 'auth_failed') {
      qrHint.textContent = s.error || 'Connection failed — try again';
      qrBox.innerHTML = '';
    } else if (s.status === 'connecting') {
      qrHint.textContent = 'Opening a browser and requesting a QR code…';
      qrBox.innerHTML = '<span class="spinner">…</span>';
    }
  }
  lastStatus = s.status;

  if (['connecting', 'qr_ready'].includes(s.status)) {
    pollTimer = setTimeout(pollStatus, 1500);
  }
}

connectBtn.addEventListener('click', async () => {
  lastStatus = null;
  qrHint.textContent = 'Opening a browser and requesting a QR code…';
  qrBox.innerHTML = '<span class="spinner">…</span>';
  qrModal.hidden = false;

  await api('/api/broker-whatsapp/connect', {});
  clearTimeout(pollTimer);
  pollStatus();
});

disconnectBtn.addEventListener('click', async () => {
  disconnectBtn.disabled = true;
  await api('/api/broker-whatsapp/disconnect', {});
  disconnectBtn.disabled = false;
  toast('WhatsApp disconnected');
  refreshStatus();
});

document.getElementById('qrClose').addEventListener('click', closeModal);
qrModal.addEventListener('click', (e) => { if (e.target === qrModal) closeModal(); });

document.getElementById('logout').addEventListener('click', async () => {
  await api('/api/auth/logout', {});
  window.location.href = '/login.html';
});

loadMe();
refreshStatus();
