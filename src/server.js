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
import { scrape, buildQueries, nicheFromQuery } from './scrape/googlemaps.js';
import { runPipeline } from './pipeline.js';
import { qualifierAvailable } from './qualify.js';
import { importPastedLeads } from './importLeads.js';
import { markContacted } from './exclusions.js';
import {
  createBroker, getBroker, getBrokerByEmail, hasActiveSubscription,
  underWhatsappCap, whatsappSendsThisMonth, qualificationsThisMonth,
  DEFAULT_WHATSAPP_CAP, DEFAULT_QUALIFY_CAP,
} from './brokers.js';
import { getSessionState, connectBroker, disconnectBroker } from './wa/sessionManager.js';
import QRCode from 'qrcode';
import {
  verifyPassword, createSession, getSessionBroker, destroySession,
  sessionCookieHeader, sessionToken,
  verifyAdminPassword, createAdminSession, getAdminSession, destroyAdminSession,
  adminCookieHeader, adminSessionToken,
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

// Fetches a lead only if it belongs to the requesting broker -- every route
// below that touches a lead by id goes through this instead of a bare
// `SELECT ... WHERE id = ?`, otherwise a logged-in broker could message or
// mutate a lead assigned to someone else just by guessing an id, the same
// class of hole the WhatsApp-session brokerId fix closed last session.
function ownedLead(req, id) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  return lead && lead.assigned_broker_id === req.broker.id ? lead : null;
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
 * Scoped to one broker's own pool -- this is the actual tenant boundary:
 * a broker only ever sees leads assigned to them.
 */
function loadBatch(brokerId) {
  const size = config.ui?.batchSize ?? 40;

  const candidates = db.prepare(`
    SELECT * FROM leads WHERE status IN ('new', 'opener_sent', 'confirmed') AND assigned_broker_id = ? ORDER BY id
  `).all(brokerId);

  // Leads finished today stay on the sheet, struck through, so the day's work
  // is visible. They sit below the active rows and don't eat into the cap.
  const doneToday = db.prepare(`
    SELECT * FROM leads
    WHERE date(pitch_sent_at) = date('now','localtime') AND assigned_broker_id = ?
    ORDER BY pitch_sent_at DESC
  `).all(brokerId);

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
    markedGood: Boolean(l.marked_good),
    opener: renderOpener(l),
    pitch: renderPitch({ ...l, contactName: l.contact_name }),
  }));
}

// Same isWorkable filter as the table, so the header stats can never claim a
// count the board itself isn't showing -- that mismatch is exactly what made
// the tier-filter bug so confusing before it was fixed.
function counts(brokerId) {
  const leads = db.prepare(`SELECT * FROM leads WHERE assigned_broker_id = ?`).all(brokerId).filter(isWorkable);
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
// /api/scrape-status. Keyed per broker (Map, in-memory only -- same
// precedent as wa/sessionManager.js) so two brokers' own on-demand scrapes
// don't collide with or overwrite each other's job status.
const scrapeJobs = new Map(); // brokerId -> job
const idleJob = { status: 'idle', message: '', added: 0, shortfall: false };

// A broker's own niches/cities, comma-parsed -- falling back to config.json's
// shared defaults when they haven't set any, so a broker who never touches
// settings gets identical behavior to the single-tenant tool.
//
// If they've marked any leads "good" (a manual, per-lead call -- see
// POST /api/mark-good), the query list leans toward whichever niche(s)
// those leads came from: 3 in 5 (60%) of the list is drawn from queries in
// a proven niche, the rest stays the full configured mix, so a proven
// niche gets more attention without the search ever narrowing to just it.
// This biases query ORDER, not a guaranteed realized split -- scrape()
// stops once it hits its target, so how much of the weighted portion
// actually runs depends on where that happens, same caveat the existing
// niche x city interleaving already has. A broker with nothing marked good
// yet gets exactly today's behavior, unchanged.
const WEIGHTED_SHARE = 3; // out of 5 -- keep in sync with the comment above if retuned
const SHARE_TOTAL = 5;

function goodNichesForBroker(brokerId) {
  return db.prepare(`
    SELECT niche, COUNT(*) n FROM leads
    WHERE assigned_broker_id = ? AND marked_good = 1 AND niche IS NOT NULL
    GROUP BY niche
  `).all(brokerId);
}

function queriesForBroker(broker) {
  const split = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : null);
  const niches = split(broker.niches) ?? config.scrape.niches;
  const cities = split(broker.cities) ?? config.scrape.cities;
  const baseline = buildQueries({ niches, cities, queries: null });

  const goodNiches = goodNichesForBroker(broker.id);
  if (!goodNiches.length) return { queries: baseline, weightedNiches: [] };

  const provenSet = new Set(goodNiches.map((g) => g.niche));
  const weighted = baseline.filter((q) => provenSet.has(nicheFromQuery(q)));
  if (!weighted.length) return { queries: baseline, weightedNiches: [] };

  const queries = [];
  let wi = 0, bi = 0;
  for (let i = 0; i < baseline.length; i += 1) {
    if (i % SHARE_TOTAL < WEIGHTED_SHARE) { queries.push(weighted[wi % weighted.length]); wi += 1; }
    else { queries.push(baseline[bi % baseline.length]); bi += 1; }
  }
  return { queries, weightedNiches: [...provenSet] };
}

// "Shortfall" is tracked separately from "error": the scrape ran fine, Chrome
// didn't crash, nothing threw -- it just could not find as many workable
// leads as were asked for, because the configured niche x city queries are
// running dry of new, reachable results. That is a real outcome the UI must
// say plainly, not a `status: 'done'` that reads the same as a full success.
async function runScrapeJob(broker, target) {
  const brokerId = broker.id;
  const before = countUnsentWorkable(db, brokerId);
  const { queries, weightedNiches } = queriesForBroker(broker);
  const weightNote = weightedNiches.length ? ` (leaning toward: ${weightedNiches.join(', ')})` : '';
  scrapeJobs.set(brokerId, { status: 'running', message: `opening Chrome, scraping for ${target} new lead(s)…${weightNote}`, added: 0, shortfall: false });
  try {
    const s = await scrape({ target, queries, brokerId });
    const job = scrapeJobs.get(brokerId);
    job.added = s.added;
    if (s.added > 0) {
      job.message = `found ${s.added}, enriching…`;
      await runPipeline({ limit: s.added, qualify: qualifierAvailable(), brokerId });
    }

    // Re-count after enrichment, not just s.added: enrichment can rescue a
    // landline (a wa.me number found on the site) or reject a lead outright,
    // both of which change how many of what was scraped actually count.
    const gained = countUnsentWorkable(db, brokerId) - before;
    job.status = 'done';

    if (gained >= target) {
      job.message = `added ${gained} new lead(s)`;
      job.shortfall = false;
    } else if (gained > 0) {
      job.message = `only found ${gained} of the ${target} requested — Google Maps is running low on new, reachable results for your current niches/cities`;
      job.shortfall = true;
    } else {
      job.message = `found 0 new leads — everything for your current niches/cities already appears to be in the database`;
      job.shortfall = true;
    }
  } catch (err) {
    scrapeJobs.set(brokerId, { status: 'error', message: err.message.slice(0, 200), added: 0, shortfall: false });
  }
}

const ROUTES = {
  'GET /api/batch': (req, res) => json(res, { leads: loadBatch(req.broker.id), counts: counts(req.broker.id), batchSize: config.ui?.batchSize ?? 40 }),

  'GET /api/scrape-status': (req, res) => json(res, { job: scrapeJobs.get(req.broker.id) ?? idleJob }),

  'POST /api/scrape': async (req, res) => {
    const current = scrapeJobs.get(req.broker.id);
    if (current?.status === 'running') return json(res, { error: 'already running', job: current }, 409);
    const { count } = await readBody(req);
    // No explicit count: top the board up to a full batch rather than a fixed
    // number, so the button's "how many" always matches what the board
    // actually needs to fill -- the same demand-driven rule leads.bat's
    // prompt uses.
    const target = Number(count) > 0
      ? Number(count)
      : Math.max(1, (config.ui?.batchSize ?? 40) - countUnsentWorkable(db, req.broker.id));
    runScrapeJob(req.broker, target); // not awaited -- the response returns immediately, the UI polls
    json(res, { ok: true, job: scrapeJobs.get(req.broker.id) });
  },

  // First click marks it sent (status + timestamp, counted toward today's
  // cap). Every click after that reopens WhatsApp with the same text but is
  // a no-op on status/timestamps -- clicking Opener again because WhatsApp
  // Web opened the wrong chat, or you never actually pressed send, must not
  // be blocked by a board that already believes it went out.
  'POST /api/opener': async (req, res) => {
    const { id } = await readBody(req);
    const lead = ownedLead(req, id);
    if (!lead) return json(res, { error: 'no such lead' }, 404);
    const resent = Boolean(lead.opener_sent_at);
    // Cap only gates a *first* send, same as every other first-send-only
    // side effect here (status change, markContacted) -- a resend never
    // trips it, matching the existing "resends are always allowed" contract.
    if (!resent && !underWhatsappCap(req.broker)) {
      return json(res, { error: 'monthly message limit reached' }, 402);
    }
    if (!resent) {
      setStatus(lead.id, 'opener_sent', { opener_sent_at: now() });
      markContacted(lead);
    }
    logMessage(lead.id, 'out', renderOpener(lead));
    json(res, { ok: true, counts: counts(req.broker.id), resent });
  },

  'POST /api/pitch': async (req, res) => {
    const { id, contactName } = await readBody(req);
    const lead = ownedLead(req, id);
    if (!lead) return json(res, { error: 'no such lead' }, 404);
    const name = (contactName || '').trim() || lead.contact_name || null;
    const resent = Boolean(lead.pitch_sent_at);
    if (!resent && !underWhatsappCap(req.broker)) {
      return json(res, { error: 'monthly message limit reached' }, 402);
    }
    if (!resent) {
      setStatus(lead.id, 'pitch_sent', { pitch_sent_at: now(), contact_name: name });
      markContacted(lead);
    } else if (name !== lead.contact_name) db.prepare('UPDATE leads SET contact_name = ? WHERE id = ?').run(name, id);
    logMessage(lead.id, 'out', renderPitch({ ...lead, contactName: name }));
    json(res, { ok: true, counts: counts(req.broker.id), resent });
  },

  'POST /api/name': async (req, res) => {
    const { id, contactName } = await readBody(req);
    const lead = ownedLead(req, id);
    if (!lead) return json(res, { error: 'no such lead' }, 404);
    const name = (contactName || '').trim() || null;
    db.prepare('UPDATE leads SET contact_name = ? WHERE id = ?').run(name, id);
    json(res, { ok: true, pitch: renderPitch({ ...lead, contactName: name }) });
  },

  'POST /api/status': async (req, res) => {
    const { id, status } = await readBody(req);
    if (!ownedLead(req, id)) return json(res, { error: 'no such lead' }, 404);
    setStatus(id, status, {});
    json(res, { ok: true, counts: counts(req.broker.id) });
  },

  // Paste-in leads: runs every line through the exact same chain filter,
  // exclusion list, and phone dedupe the scraper uses (src/importLeads.js) --
  // a pasted lead gets no less scrutiny than a scraped one.
  'POST /api/import': async (req, res) => {
    const { text } = await readBody(req);
    if (!text || !text.trim()) return json(res, { error: 'nothing pasted' }, 400);
    const r = importPastedLeads(text, req.broker.id);
    json(res, { ok: true, ...r, counts: counts(req.broker.id) });
  },

  // Manual "said no / no reply" tag. Purely for your own tracking — it never
  // moves the lead, changes its status, or affects any pipeline logic.
  'POST /api/flag': async (req, res) => {
    const { id, value } = await readBody(req);
    if (!ownedLead(req, id)) return json(res, { error: 'no such lead' }, 404);
    db.prepare('UPDATE leads SET no_response = ? WHERE id = ?').run(value ? 1 : 0, id);
    json(res, { ok: true });
  },

  // Manual "this was a good lead" tag -- feeds queriesForBroker's niche
  // weighting above, otherwise exactly as inert as /api/flag.
  'POST /api/mark-good': async (req, res) => {
    const { id, value } = await readBody(req);
    if (!ownedLead(req, id)) return json(res, { error: 'no such lead' }, 404);
    db.prepare('UPDATE leads SET marked_good = ? WHERE id = ?').run(value ? 1 : 0, id);
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

  // What a broker's own "+ Get new leads" searches for. Comma-separated
  // text in, comma-separated text out -- deliberately just two fields, no
  // options panel. Never blank: falls back to config.json's shared
  // defaults so the field always shows something real, not an empty box.
  'GET /api/broker-settings': (req, res) => {
    const broker = getBroker(req.broker.id);
    json(res, {
      niches: broker.niches || config.scrape.niches.join(', '),
      cities: broker.cities || config.scrape.cities.join(', '),
    });
  },

  'POST /api/broker-settings': async (req, res) => {
    const { niches, cities } = await readBody(req);
    db.prepare('UPDATE brokers SET niches = ?, cities = ? WHERE id = ?')
      .run((niches || '').trim() || null, (cities || '').trim() || null, req.broker.id);
    json(res, { ok: true });
  },

  // ---- admin: a fully separate credential from broker accounts (one
  // shared password, no per-admin identity) -- see src/auth.js. ----
  'POST /api/admin/login': async (req, res) => {
    const { password } = await readBody(req);
    if (!verifyAdminPassword(password || '')) return json(res, { error: 'incorrect password' }, 401);
    const token = createAdminSession();
    res.setHeader('Set-Cookie', adminCookieHeader(token));
    json(res, { ok: true });
  },

  'POST /api/admin/logout': (req, res) => {
    destroyAdminSession(adminSessionToken(req));
    res.setHeader('Set-Cookie', adminCookieHeader(null, { clear: true }));
    json(res, { ok: true });
  },

  // One row per broker with everything the panel needs -- lead counts by
  // outcome, WhatsApp status, subscription state -- in one query rather
  // than N+1 round trips per broker.
  'GET /api/admin/brokers': (req, res) => {
    const brokers = db.prepare(`
      SELECT
        b.*,
        COUNT(l.id) AS lead_count,
        COUNT(CASE WHEN l.opener_sent_at IS NOT NULL THEN 1 END) AS contacted_count,
        COUNT(CASE WHEN l.status = 'replied' THEN 1 END) AS replied_count
      FROM brokers b
      LEFT JOIN leads l ON l.assigned_broker_id = b.id
      GROUP BY b.id
      ORDER BY b.id
    `).all();
    json(res, {
      brokers: brokers.map((b) => ({
        id: b.id, name: b.name, email: b.email, createdAt: b.created_at,
        waStatus: b.wa_status, waPhone: b.wa_phone,
        subscriptionStatus: b.subscription_status, trialEndsAt: b.trial_ends_at,
        active: hasActiveSubscription(b),
        leadCount: b.lead_count, contactedCount: b.contacted_count, repliedCount: b.replied_count,
        whatsappSent: whatsappSendsThisMonth(b.id), whatsappCap: b.whatsapp_cap ?? DEFAULT_WHATSAPP_CAP,
        qualified: qualificationsThisMonth(b.id), qualifyCap: b.qualify_cap ?? DEFAULT_QUALIFY_CAP,
      })),
    });
  },

  'POST /api/admin/subscription': async (req, res) => {
    const { brokerId, status } = await readBody(req);
    if (!['trialing', 'active', 'past_due', 'canceled'].includes(status)) {
      return json(res, { error: 'invalid status' }, 400);
    }
    if (!getBroker(brokerId)) return json(res, { error: 'no such broker' }, 404);
    // A manual "Reset trial" also needs a fresh trial_ends_at, not just the
    // status flip, or it would immediately re-evaluate as expired.
    if (status === 'trialing') {
      db.prepare("UPDATE brokers SET subscription_status = ?, trial_ends_at = datetime('now', '+14 days') WHERE id = ?")
        .run(status, brokerId);
    } else {
      db.prepare('UPDATE brokers SET subscription_status = ? WHERE id = ?').run(status, brokerId);
    }
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
  // req.broker set by the gate, not skipped by it. Same reasoning keeps
  // /api/admin/login (not /api/admin/logout) out of the admin branch below.
  const PUBLIC_AUTH_ROUTES = new Set(['/api/auth/signup', '/api/auth/login', '/api/auth/logout']);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const { pathname } = url;

      // Admin is a fully separate credential from broker sessions -- checked
      // and dispatched before the broker gate even runs, on its own cookie
      // (asid, not sid). /admin.html itself is public (it's just the login
      // form); every /api/admin/* route except login needs a valid admin
      // session, never a broker one.
      if (pathname.startsWith('/api/admin/') && pathname !== '/api/admin/login') {
        if (!getAdminSession(adminSessionToken(req))) return json(res, { error: 'unauthorized' }, 401);
        req.admin = true;
      }

      // Global auth gate. Public without a session: the login/signup/admin
      // pages themselves, the routes above, and any stylesheet/script (so
      // those pages can load their own styling before you're logged in at
      // all). Everything else -- the board, /connect.html, every other
      // /api/* route, the per-lead vCard routes below -- requires a session.
      const isPublic = /\.(css|js)$/.test(pathname)
        || pathname === '/login.html' || pathname === '/signup.html' || pathname === '/admin.html'
        || PUBLIC_AUTH_ROUTES.has(pathname) || pathname === '/api/admin/login'
        || pathname.startsWith('/api/admin/');

      if (!isPublic) {
        const broker = getSessionBroker(sessionToken(req));
        if (!broker) {
          if (pathname.startsWith('/api/')) return json(res, { error: 'unauthorized' }, 401);
          res.writeHead(302, { Location: '/login.html' });
          return res.end();
        }
        req.broker = broker;

        // A broker with no active subscription (trial expired, past due,
        // canceled) can still reach /subscribe.html -- nothing else. (Logout
        // needs no exemption here: it's already fully public above, so it
        // never reaches this check in the first place.) Checked once, here,
        // rather than in every route.
        if (pathname !== '/subscribe.html' && !hasActiveSubscription(broker)) {
          if (pathname.startsWith('/api/')) return json(res, { error: 'subscription required' }, 402);
          res.writeHead(302, { Location: '/subscribe.html' });
          return res.end();
        }
      }

      const key = `${req.method} ${pathname}`;
      if (ROUTES[key]) return await ROUTES[key](req, res, url);

      // Per-lead vCard download: /vcf/12 -> one contact to add on the phone.
      const vcf = url.pathname.match(/^\/vcf\/(\d+)$/);
      if (vcf) {
        const lead = ownedLead(req, Number(vcf[1]));
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
        const ids = loadBatch(req.broker.id).map((l) => l.id);
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
