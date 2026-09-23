import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { config, ROOT } from './config.js';
import './migrate.js';
import { db, logMessage, setStatus } from './db.js';
import { renderOpener, renderPitch, cleanBrandName } from './templates.js';
import { bestPhone, phoneType, whatsAppLikelihood } from './phone.js';
import { isWorkable, assembleBoard, countUnsentWorkable } from './leadFilters.js';
import { scrape } from './scrape/googlemaps.js';
import { runPipeline } from './pipeline.js';
import { qualifierAvailable } from './qualify.js';
import { importPastedLeads } from './importLeads.js';
import { markContacted } from './exclusions.js';
import { createBroker, getBroker, getBrokerByEmail } from './brokers.js';
import { getSessionState, connectBroker, disconnectBroker } from './wa/sessionManager.js';
import QRCode from 'qrcode';
import {
  verifyPassword, createSession, getSessionBroker, destroySession,
  sessionCookieHeader, sessionToken,
} from './auth.js';

const UI = join(ROOT, 'ui');
const now = () => new Date().toISOString();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.vcf': 'text/vcard; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  // no-store: this is live pipeline state, and a browser (or an extension,
  // or a flaky corporate proxy) silently serving a cached GET /api/batch is
  // exactly the kind of thing that would make freshly-added leads look like
  // they never showed up.
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

/**
 * Working sheet: newest unsent leads (capped) sit at the top so a paste is
 * immediately actionable. Awaiting-reply leads sit below that, uncapped --
 * they stay visible until they reply, and they never steal opener slots.
 */
function loadBatch() {
  const size = config.ui?.batchSize ?? 40;

  const candidates = db.prepare(`
    SELECT * FROM leads WHERE status IN ('new', 'opener_sent', 'confirmed') ORDER BY id
  `).all();

  // Leads finished today stay on the sheet, struck through, so the day's work
  // is visible. They sit below the active rows and don't eat into the cap.
  const doneToday = db.prepare(`
    SELECT * FROM leads
    WHERE date(pitch_sent_at) = date('now','localtime')
    ORDER BY pitch_sent_at DESC
  `).all();

  const rows = [...assembleBoard(candidates, { size }), ...doneToday];

  return rows.map((l) => ({
    id: l.id,
    brand: cleanBrandName(l.brand_name),
    rawBrand: l.brand_name,
    phone: bestPhone(l),
    mapsPhone: l.phone,
    fromSite: Boolean(l.whatsapp_phone),
    reach: whatsAppLikelihood(bestPhone(l)),
    phoneType: phoneType(bestPhone(l)),
    category: l.category,
    address: l.address,
    website: l.website,
    tier: l.tier,
    status: l.status,
    contactName: l.contact_name,
    openerSent: Boolean(l.opener_sent_at),
    pitchSent: Boolean(l.pitch_sent_at),
    contactSaved: Boolean(l.contact_exported_at),
    noResponse: Boolean(l.no_response),
    opener: renderOpener(l),
    pitch: renderPitch({ ...l, contactName: l.contact_name }),
  }));
}

// Same isWorkable filter as the table, so the header stats can never claim a
// count the board itself isn't showing -- that mismatch is exactly what made
// the tier-filter bug so confusing before it was fixed.
function counts() {
  const leads = db.prepare(`SELECT * FROM leads`).all().filter(isWorkable);
  const today = (col) => (l) => l[col] && String(l[col]).slice(0, 10) === new Date().toLocaleDateString('en-CA');

  return {
    untouched: leads.filter((l) => l.status === 'new').length,
    awaiting: leads.filter((l) => l.status === 'opener_sent').length,
    pitched: leads.filter((l) => l.status === 'pitch_sent' || l.status === 'replied').length,
    sentToday: leads.filter(today('opener_sent_at')).length,
  };
}

function vcardFor(lead) {
  const esc = (s) => String(s ?? '').replace(/([\\,;])/g, '\\$1').replace(/\r?\n/g, '\\n');
  const name = `${config.contacts?.namePrefix ?? ''}${cleanBrandName(lead.brand_name)}`;
  return [
    'BEGIN:VCARD', 'VERSION:3.0',
    `N:;${esc(name)};;;`, `FN:${esc(name)}`,
    `ORG:${esc(cleanBrandName(lead.brand_name))}`,
    `TEL;TYPE=CELL:${bestPhone(lead)}`,
    lead.website ? `URL:${esc(lead.website)}` : null,
    'END:VCARD',
  ].filter(Boolean).join('\r\n');
}

// Scraping is real minutes of live browser automation, not an HTTP-request-shaped
// thing -- kicked off fire-and-forget from POST /api/scrape, polled via GET
// /api/scrape-status. Single in-memory job: this is a one-person tool, and a
// second live scrape sharing the same browser profile would just collide.
let scrapeJob = { status: 'idle', message: '', added: 0, shortfall: false };

// "Shortfall" is tracked separately from "error": the scrape ran fine, Chrome
// didn't crash, nothing threw -- it just could not find as many workable
// leads as were asked for, because the configured niche x city queries are
// running dry of new, reachable results. That is a real outcome the UI must
// say plainly, not a `status: 'done'` that reads the same as a full success.
async function runScrapeJob(target) {
  const before = countUnsentWorkable(db);
  scrapeJob = { status: 'running', message: `opening Chrome, scraping for ${target} new lead(s)…`, added: 0, shortfall: false };
  try {
    const s = await scrape({ target });
    scrapeJob.added = s.added;
    if (s.added > 0) {
      scrapeJob.message = `found ${s.added}, enriching…`;
      await runPipeline({ limit: s.added, qualify: qualifierAvailable() });
    }

    // Re-count after enrichment, not just s.added: enrichment can rescue a
    // landline (a wa.me number found on the site) or reject a lead outright,
    // both of which change how many of what was scraped actually count.
    const gained = countUnsentWorkable(db) - before;
    scrapeJob.status = 'done';

    if (gained >= target) {
      scrapeJob.message = `added ${gained} new lead(s)`;
      scrapeJob.shortfall = false;
    } else if (gained > 0) {
      scrapeJob.message = `only found ${gained} of the ${target} requested — Google Maps is running low on new, reachable results for your current niches/cities`;
      scrapeJob.shortfall = true;
    } else {
      scrapeJob.message = `found 0 new leads — everything for your current niches/cities already appears to be in the database`;
      scrapeJob.shortfall = true;
    }
  } catch (err) {
    scrapeJob.status = 'error';
    scrapeJob.message = err.message.slice(0, 200);
  }
}

const ROUTES = {
  'GET /api/batch': (req, res) => json(res, { leads: loadBatch(), counts: counts(), batchSize: config.ui?.batchSize ?? 40 }),

  'GET /api/scrape-status': (req, res) => json(res, { job: scrapeJob }),

  'POST /api/scrape': async (req, res) => {
    if (scrapeJob.status === 'running') return json(res, { error: 'already running', job: scrapeJob }, 409);
    const { count } = await readBody(req);
    // No explicit count: top the board up to a full batch rather than a fixed
    // number, so the button's "how many" always matches what the board
    // actually needs to fill -- the same demand-driven rule leads.bat's
    // prompt uses.
    const target = Number(count) > 0
      ? Number(count)
      : Math.max(1, (config.ui?.batchSize ?? 40) - countUnsentWorkable(db));
    runScrapeJob(target); // not awaited -- the response returns immediately, the UI polls
    json(res, { ok: true, job: scrapeJob });
  },

  // First click marks it sent (status + timestamp, counted toward today's
  // cap). Every click after that reopens WhatsApp with the same text but is
  // a no-op on status/timestamps -- clicking Opener again because WhatsApp
  // Web opened the wrong chat, or you never actually pressed send, must not
  // be blocked by a board that already believes it went out.
  'POST /api/opener': async (req, res) => {
    const { id } = await readBody(req);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!lead) return json(res, { error: 'no such lead' }, 404);
    const resent = Boolean(lead.opener_sent_at);
    if (!resent) {
      setStatus(lead.id, 'opener_sent', { opener_sent_at: now() });
      markContacted(lead);
    }
    logMessage(lead.id, 'out', renderOpener(lead));
    json(res, { ok: true, counts: counts(), resent });
  },

  'POST /api/pitch': async (req, res) => {
    const { id, contactName } = await readBody(req);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!lead) return json(res, { error: 'no such lead' }, 404);
    const name = (contactName || '').trim() || lead.contact_name || null;
    const resent = Boolean(lead.pitch_sent_at);
    if (!resent) {
      setStatus(lead.id, 'pitch_sent', { pitch_sent_at: now(), contact_name: name });
      markContacted(lead);
    } else if (name !== lead.contact_name) db.prepare('UPDATE leads SET contact_name = ? WHERE id = ?').run(name, id);
    logMessage(lead.id, 'out', renderPitch({ ...lead, contactName: name }));
    json(res, { ok: true, counts: counts(), resent });
  },

  'POST /api/name': async (req, res) => {
    const { id, contactName } = await readBody(req);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!lead) return json(res, { error: 'no such lead' }, 404);
    const name = (contactName || '').trim() || null;
    db.prepare('UPDATE leads SET contact_name = ? WHERE id = ?').run(name, id);
    json(res, { ok: true, pitch: renderPitch({ ...lead, contactName: name }) });
  },

  'POST /api/status': async (req, res) => {
    const { id, status } = await readBody(req);
    if (!db.prepare('SELECT 1 FROM leads WHERE id = ?').get(id)) return json(res, { error: 'no such lead' }, 404);
    setStatus(id, status, {});
    json(res, { ok: true, counts: counts() });
  },

  // Paste-in leads: runs every line through the exact same chain filter,
  // exclusion list, and phone dedupe the scraper uses (src/importLeads.js) --
  // a pasted lead gets no less scrutiny than a scraped one.
  'POST /api/import': async (req, res) => {
    const { text } = await readBody(req);
    if (!text || !text.trim()) return json(res, { error: 'nothing pasted' }, 400);
    const r = importPastedLeads(text);
    json(res, { ok: true, ...r, counts: counts() });
  },

  // Manual "said no / no reply" tag. Purely for your own tracking — it never
  // moves the lead, changes its status, or affects any pipeline logic.
  'POST /api/flag': async (req, res) => {
    const { id, value } = await readBody(req);
    if (!db.prepare('SELECT 1 FROM leads WHERE id = ?').get(id)) return json(res, { error: 'no such lead' }, 404);
    db.prepare('UPDATE leads SET no_response = ? WHERE id = ?').run(value ? 1 : 0, id);
    json(res, { ok: true });
  },

  'POST /api/auth/signup': async (req, res) => {
    const { name, email, password } = await readBody(req);
    const r = createBroker({ name, email, password });
    if (r.error) return json(res, r, 400);
    const token = createSession(r.broker.id);
    res.setHeader('Set-Cookie', sessionCookieHeader(token));
    json(res, { ok: true, broker: { id: r.broker.id, name: r.broker.name, email: r.broker.email } });
  },

  'POST /api/auth/login': async (req, res) => {
    const { email, password } = await readBody(req);
    const broker = email ? getBrokerByEmail(email.trim()) : null;
    if (!broker || !verifyPassword(password || '', broker.password_hash)) {
      return json(res, { error: 'incorrect email or password' }, 401);
    }
    const token = createSession(broker.id);
    res.setHeader('Set-Cookie', sessionCookieHeader(token));
    json(res, { ok: true, broker: { id: broker.id, name: broker.name, email: broker.email } });
  },

  'POST /api/auth/logout': (req, res) => {
    destroySession(sessionToken(req));
    res.setHeader('Set-Cookie', sessionCookieHeader(null, { clear: true }));
    json(res, { ok: true });
  },

  'GET /api/auth/me': (req, res) => {
    const b = req.broker;
    json(res, { broker: { id: b.id, name: b.name, email: b.email } });
  },

  // Fire-and-forget, same shape as POST /api/scrape: connectBroker() launches
  // a real browser and talks to WhatsApp Web, so the response reflects
  // whatever state is available the instant it's called (usually
  // 'connecting') and the UI polls the status route below for the QR/outcome.
  // Scoped to req.broker (the logged-in session), never a client-supplied id
  // -- that was the actual hole a login flow needed to close: previously any
  // caller could pass any brokerId and connect/disconnect someone else's
  // WhatsApp session.
  'POST /api/broker-whatsapp/connect': (req, res) => {
    const state = connectBroker(req.broker.id);
    json(res, { ok: true, status: state.status });
  },

  'GET /api/broker-whatsapp/status': async (req, res) => {
    const broker = getBroker(req.broker.id);
    const live = getSessionState(broker.id);
    const qrDataUrl = live.qr ? await QRCode.toDataURL(live.qr) : null;
    json(res, {
      status: live.status,
      qrDataUrl,
      phone: live.phone ?? broker.wa_phone,
      error: live.error ?? broker.wa_last_error,
    });
  },

  'POST /api/broker-whatsapp/disconnect': async (req, res) => {
    await disconnectBroker(req.broker.id);
    json(res, { ok: true });
  },
};

async function serveStatic(req, res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  try {
    const buf = await readFile(join(UI, file));
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

export function startServer({ open = true } = {}) {
  const port = config.ui?.port ?? 5173;

  // /api/auth/me deliberately excluded from PUBLIC_AUTH_ROUTES below: it
  // reports on the current session, so unlike signup/login/logout it needs
  // req.broker set by the gate, not skipped by it.
  const PUBLIC_AUTH_ROUTES = new Set(['/api/auth/signup', '/api/auth/login', '/api/auth/logout']);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const { pathname } = url;

      // Global auth gate. Public without a session: the login/signup pages
      // themselves, the three routes above, and any stylesheet/script (so
      // those pages can load their own styling before you're logged in at
      // all). Everything else -- the board, /connect.html, every other
      // /api/* route, the per-lead vCard routes below -- requires a session.
      const isPublic = /\.(css|js)$/.test(pathname)
        || pathname === '/login.html' || pathname === '/signup.html'
        || PUBLIC_AUTH_ROUTES.has(pathname);

      if (!isPublic) {
        const broker = getSessionBroker(sessionToken(req));
        if (!broker) {
          if (pathname.startsWith('/api/')) return json(res, { error: 'unauthorized' }, 401);
          res.writeHead(302, { Location: '/login.html' });
          return res.end();
        }
        req.broker = broker;
      }

      const key = `${req.method} ${pathname}`;
      if (ROUTES[key]) return await ROUTES[key](req, res, url);

      // Per-lead vCard download: /vcf/12 -> one contact to add on the phone.
      const vcf = url.pathname.match(/^\/vcf\/(\d+)$/);
      if (vcf) {
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(vcf[1]));
        if (!lead) { res.writeHead(404); return res.end('not found'); }
        db.prepare('UPDATE leads SET contact_exported_at = ? WHERE id = ?').run(now(), lead.id);
        const body = vcardFor(lead);
        res.writeHead(200, {
          'Content-Type': MIME['.vcf'],
          'Content-Disposition': `attachment; filename="${cleanBrandName(lead.brand_name).replace(/[^\w ]/g, '')}.vcf"`,
        });
        return res.end(body);
      }

      // Whole batch as one file -- import once, get all 40 contacts.
      if (url.pathname === '/vcf-batch') {
        const ids = loadBatch().map((l) => l.id);
        if (!ids.length) { res.writeHead(404); return res.end('empty batch'); }
        const rows = db.prepare(`SELECT * FROM leads WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
        const mark = db.prepare('UPDATE leads SET contact_exported_at = ? WHERE id = ?');
        for (const r of rows) mark.run(now(), r.id);
        res.writeHead(200, {
          'Content-Type': MIME['.vcf'],
          'Content-Disposition': 'attachment; filename="lead-batch.vcf"',
        });
        return res.end(rows.map(vcardFor).join('\r\n') + '\r\n');
      }

      return serveStatic(req, res, url.pathname);
    } catch (err) {
      // A bug in one route must not take the whole board offline for every
      // broker -- this replaces an uncaught-exception process crash (the
      // Node default for an async handler that throws) with a 500 for that
      // one request.
      console.error('[server] unhandled error:', err);
      if (!res.headersSent) json(res, { error: 'internal error' }, 500);
    }
  });

  const url = `http://localhost:${port}`;

  // Double-clicking the .bat twice is the normal way this happens; a raw
  // EADDRINUSE stack trace would look like the tool is broken.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`\n  The board is already running at ${url}`);
      console.log('  Opening that tab instead.\n');
      if (open) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      process.exit(0);
    }
    console.error(`\n  Could not start the board: ${err.message}\n`);
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`\n  lead board running at ${url}`);
    console.log('  close this window when you are done.\n');
    if (open) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  });

  return server;
}
