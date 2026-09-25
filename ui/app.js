const rowsEl = document.getElementById('rows');
const statsEl = document.getElementById('stats');
const emptyEl = document.getElementById('empty');
const labelEl = document.getElementById('batchLabel');
const toastEl = document.getElementById('toast');

let leads = [];
let searchQuery = '';

// Filters what's shown, never what's counted -- stats/counts stay based on
// the full set from the server regardless of what's typed in the search box.
function matchesSearch(l) {
  if (!searchQuery) return true;
  const haystack = `${l.rawBrand} ${l.phone} ${l.category ?? ''} ${l.contactName ?? ''}`.toLowerCase();
  return haystack.includes(searchQuery);
}

const api = async (path, body) => {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  // Session expired mid-use -- bounce to login rather than rendering an
  // {error:'unauthorized'} payload as if it were a batch of leads.
  if (res.status === 401) { window.location.href = '/login.html'; return new Promise(() => {}); }
  return res.json();
};

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

// web.whatsapp.com/send opens WhatsApp Web directly with the message already in
// the compose box. wa.me would bounce through a redirect page first.
function openWhatsApp(phone, text) {
  const url = `https://web.whatsapp.com/send?phone=${phone.replace(/\D/g, '')}&text=${encodeURIComponent(text)}`;
  window.open(url, 'whatsapp');
}

function renderStats(c) {
  statsEl.innerHTML = `
    <div class="stat"><b>${c.sentToday}</b><span>sent today</span></div>
    <div class="stat"><b>${c.awaiting}</b><span>awaiting reply</span></div>
    <div class="stat"><b>${c.pitched}</b><span>pitched</span></div>
    <div class="stat"><b>${c.untouched}</b><span>in pipeline</span></div>`;
}

function stateCell(l) {
  if (l.pitchSent) return '<span class="state done">✓ contacted</span>';
  if (l.openerSent) return '<span class="state waiting">awaiting reply</span>';
  return '<span class="state todo">not started</span>';
}

function render() {
  rowsEl.innerHTML = '';

  if (!leads.length) {
    emptyEl.hidden = false;
    emptyEl.textContent = 'No leads in the batch. Run `node cli.js scrape` to add more.';
    return;
  }

  const visible = leads.filter(matchesSearch);
  if (!visible.length) {
    emptyEl.hidden = false;
    emptyEl.textContent = `No leads match "${searchQuery}".`;
    return;
  }
  emptyEl.hidden = true;

  visible.forEach((l, i) => {
    const tr = document.createElement('tr');
    tr.className = [l.pitchSent ? 'complete' : '', l.reach === 'no' ? 'unreachable' : '', l.noResponse ? 'flagged' : ''].filter(Boolean).join(' ');
    tr.dataset.id = l.id;

    const site = l.website
      ? `<a href="${l.website}" target="_blank" rel="noreferrer">${l.brand}</a>`
      : l.brand;

    // Landlines are never on WhatsApp; say so before a click is wasted.
    const reachBadge = l.reach === 'no'
      ? `<span class="warn" title="${l.phoneType} — not a mobile, almost certainly not on WhatsApp">landline</span>`
      : l.reach === 'maybe'
        ? `<span class="maybe" title="${l.phoneType} — may not be on WhatsApp">unsure</span>`
        : '';
    const src = l.fromSite ? '<span class="src" title="WhatsApp number found on their website">site</span>' : '';

    tr.innerHTML = `
      <td class="c-n">${i + 1}</td>
      <td class="c-brand"><div class="biz">${site}</div>${l.tier ? `<div class="tier">${l.tier.replace('_', ' ')}</div>` : ''}</td>
      <td class="c-phone">${l.phone} ${src}${reachBadge}</td>
      <td class="c-cat">${l.category ?? ''}</td>
      <td class="c-vcf">
        <a class="btn ghost ${l.contactSaved ? 'done' : ''}" href="/vcf/${l.id}" download>${l.contactSaved ? '✓ saved' : '⬇ save'}</a>
      </td>
      <td class="c-act">
        <button class="btn ${l.openerSent ? 'done' : 'primary'}" data-act="opener" title="${l.openerSent ? 'Reopen WhatsApp with this message again' : ''}">
          ${l.openerSent ? '↻ resend' : 'Opener'}
        </button>
      </td>
      <td class="c-name">
        <input class="name" type="text" placeholder="name…" value="${l.contactName ?? ''}">
      </td>
      <td class="c-act">
        <button class="btn ${l.pitchSent ? 'done' : ''}" data-act="pitch" ${l.openerSent ? '' : 'disabled'} title="${l.pitchSent ? 'Reopen WhatsApp with this message again' : ''}">
          ${l.pitchSent ? '↻ resend' : 'Pitch'}
        </button>
      </td>
      <td class="c-state">${stateCell(l)}</td>
      <td class="c-flag">
        <input type="checkbox" class="no-response" data-flag title="Mark as no / no reply" ${l.noResponse ? 'checked' : ''}>
      </td>`;

    rowsEl.appendChild(tr);
  });
}

async function load({ announceNew = false } = {}) {
  const previousIds = new Set(leads.map((l) => l.id));
  const data = await api('/api/batch');
  leads = data.leads;
  renderStats(data.counts);
  const unsent = leads.filter((l) => !l.openerSent && !l.pitchSent).length;
  const awaiting = leads.filter((l) => l.openerSent && !l.pitchSent).length;
  labelEl.textContent = `${unsent} ready · ${awaiting} awaiting · ${leads.length} on sheet`;
  render();

  if (announceNew) {
    const newCount = leads.filter((l) => !previousIds.has(l.id)).length;
    toast(newCount ? `${newCount} new lead${newCount === 1 ? '' : 's'} loaded` : 'No new leads yet');
  }
}

// One delegated listener: rows are re-rendered constantly, so per-row handlers
// would have to be rebound every time.
rowsEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || btn.disabled) return;

  const tr = btn.closest('tr');
  const id = Number(tr.dataset.id);
  const lead = leads.find((l) => l.id === id);
  if (!lead) return;

  if (btn.dataset.act === 'opener') {
    openWhatsApp(lead.phone, lead.opener);
    const r = await api('/api/opener', { id });
    lead.openerSent = true;
    renderStats(r.counts);
    render();
    toast(r.resent
      ? `Opener re-opened for ${lead.brand} — press send again`
      : `Opener opened for ${lead.brand} — press send in WhatsApp`);
    return;
  }

  if (btn.dataset.act === 'pitch') {
    const name = tr.querySelector('input.name').value.trim();
    // Re-render the pitch with the name they just typed before opening --
    // also lets you fix a typo'd name and resend with the corrected pitch.
    const { pitch } = await api('/api/name', { id, contactName: name });
    openWhatsApp(lead.phone, pitch || lead.pitch);
    const r = await api('/api/pitch', { id, contactName: name });
    lead.pitchSent = true;
    lead.contactName = name || lead.contactName;
    renderStats(r.counts);
    render();
    toast(r.resent
      ? `Pitch re-opened for ${lead.brand}${name ? ` (${name})` : ''} — press send again`
      : `Pitch opened for ${lead.brand}${name ? ` (${name})` : ''} — press send`);
  }
});

// Persist the name as it is typed, so a refresh never loses it.
let nameTimer;
rowsEl.addEventListener('input', (e) => {
  const input = e.target.closest('input.name');
  if (!input) return;
  const id = Number(input.closest('tr').dataset.id);
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => api('/api/name', { id, contactName: input.value }), 400);
});

// Checkbox toggles are instant, no debounce — it's just a manual tag, not
// something that needs to survive a half-typed state.
rowsEl.addEventListener('change', async (e) => {
  const box = e.target.closest('input[data-flag]');
  if (!box) return;
  const tr = box.closest('tr');
  const id = Number(tr.dataset.id);
  const lead = leads.find((l) => l.id === id);
  if (!lead) return;
  lead.noResponse = box.checked;
  tr.classList.toggle('flagged', box.checked);
  await api('/api/flag', { id, value: box.checked });
});

document.getElementById('refresh').addEventListener('click', () => load({ announceNew: true }));
document.getElementById('search').addEventListener('input', (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  render();
});
document.getElementById('logout').addEventListener('click', async () => {
  await api('/api/auth/logout', {});
  window.location.href = '/login.html';
});
document.getElementById('hideHint').addEventListener('click', () => {
  document.getElementById('hint').hidden = true;
  try { localStorage.setItem('hideHint', '1'); } catch { /* private mode */ }
});

try {
  if (localStorage.getItem('hideHint')) document.getElementById('hint').hidden = true;
} catch { /* private mode */ }

// A live scrape takes real minutes (it opens an actual Chrome window against
// Google Maps), so the button fires the job and polls -- it never blocks the
// page, and reflects a job already running (e.g. started from another tab).
const getLeadsBtn = document.getElementById('getLeads');
const scrapeWarningEl = document.getElementById('scrapeWarning');
const scrapeWarningTextEl = document.getElementById('scrapeWarningText');
let pollTimer;

function setScrapeButton(job) {
  if (job.status === 'running') {
    getLeadsBtn.disabled = true;
    getLeadsBtn.textContent = job.message || 'Scraping…';
  } else {
    getLeadsBtn.disabled = false;
    getLeadsBtn.textContent = '+ Get new leads';
  }
}

// A scrape that comes up short of what was asked for is a real failure to
// report, not something a 2.6s toast can be trusted to communicate -- if you
// looked away, you'd never know, and the board would just be quietly short.
// This banner stays up until you dismiss it or a later scrape succeeds clean.
function showShortfall(message) {
  scrapeWarningTextEl.textContent = `⚠ ${message}`;
  scrapeWarningEl.hidden = false;
}

let lastScrapeStatus = null;
async function pollScrape() {
  const { job } = await api('/api/scrape-status');
  setScrapeButton(job);

  if (job.status === 'running') {
    pollTimer = setTimeout(pollScrape, 3000);
    lastScrapeStatus = job.status;
    return;
  }

  // Only act once per finished job -- pollScrape can be called again later
  // (e.g. a fresh page load) and must not re-toast a job that already finished.
  if (job.status !== lastScrapeStatus) {
    if (job.status === 'done') {
      if (job.shortfall) {
        showShortfall(job.message);
      } else if (job.added > 0) {
        toast(job.message);
      }
      if (job.added > 0) load({ announceNew: true });
    } else if (job.status === 'error') {
      showShortfall(`Scrape failed: ${job.message}`);
    }
  }
  lastScrapeStatus = job.status;
}

getLeadsBtn.addEventListener('click', async () => {
  const res = await api('/api/scrape', {});
  if (res.error) {
    toast(res.error === 'already running' ? 'Already scraping — hang tight' : res.error);
    return;
  }
  scrapeWarningEl.hidden = true;
  lastScrapeStatus = 'running';
  toast('Opening Chrome to find new leads — this takes a few minutes, leave it alone');
  clearTimeout(pollTimer);
  pollScrape();
});

document.getElementById('hideScrapeWarning').addEventListener('click', () => {
  scrapeWarningEl.hidden = true;
});

// ---------- paste-import ----------
const importModal = document.getElementById('importModal');
const importText = document.getElementById('importText');
const importResult = document.getElementById('importResult');

function openImport() {
  importResult.hidden = true;
  importText.value = '';
  importModal.hidden = false;
  importText.focus();
}
function closeImport() {
  importModal.hidden = true;
}

document.getElementById('openImport').addEventListener('click', openImport);
document.getElementById('importCancel').addEventListener('click', closeImport);
importModal.addEventListener('click', (e) => { if (e.target === importModal) closeImport(); });

document.getElementById('importSubmit').addEventListener('click', async () => {
  const text = importText.value.trim();
  if (!text) return;

  const btn = document.getElementById('importSubmit');
  btn.disabled = true;
  btn.textContent = 'Importing…';

  const r = await api('/api/import', { text });

  btn.disabled = false;
  btn.textContent = 'Import';

  if (r.error) {
    importResult.className = 'modal-result has-issues';
    importResult.textContent = r.error;
    importResult.hidden = false;
    return;
  }

  const bits = [`${r.added} added`];
  if (r.duplicates) bits.push(`${r.duplicates} already in the database`);
  if (r.excluded) bits.push(`${r.excluded} on the exclusion list`);
  if (r.invalid) bits.push(`${r.invalid} couldn't be parsed`);

  importResult.className = `modal-result${r.invalid || r.excluded ? ' has-issues' : ''}`;
  let msg = bits.join(' · ');
  if (r.invalidLines?.length) {
    msg += '\n' + r.invalidLines.map((l) => `  ${l.reason}: "${l.line}"`).join('\n');
  }
  importResult.textContent = msg;
  importResult.style.whiteSpace = 'pre-line';
  importResult.hidden = false;

  renderStats(r.counts);
  if (r.added > 0) {
    load({ announceNew: true });
    setTimeout(closeImport, 1400);
  }
});

load();
pollScrape(); // picks up a job already running from a previous page load or the .bat prompt
