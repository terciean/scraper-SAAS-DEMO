import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

// `data/` is gitignored (it holds the real lead database and browser
// profile) so a fresh clone/copy has no `data/` directory at all -- SQLite
// can create the .db file but not a missing parent directory, so opening it
// would otherwise fail on the very first command with no useful error.
mkdirSync(join(ROOT, 'data'), { recursive: true });

export const db = new DatabaseSync(join(ROOT, 'data', 'leads.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS leads (
    id              INTEGER PRIMARY KEY,
    brand_name      TEXT    NOT NULL,
    phone           TEXT    NOT NULL UNIQUE,
    category        TEXT,
    address         TEXT,
    website         TEXT,
    rating          REAL,
    reviews         INTEGER,
    source          TEXT,
    source_query    TEXT,
    status          TEXT    NOT NULL DEFAULT 'new',
    opener_sent_at  TEXT,
    confirmed_at    TEXT,
    pitch_sent_at   TEXT,
    last_inbound_at TEXT,
    last_inbound    TEXT,
    notes           TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY,
    lead_id   INTEGER REFERENCES leads(id),
    direction TEXT NOT NULL,
    body      TEXT,
    ts        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id);
`);

/*
 * status flow
 *   new -> opener_sent -> confirmed -> pitch_sent -> replied
 * terminal branches off opener_sent:
 *   wrong_number   they said it isn't the brand
 *   opted_out      stop / not interested / blocked
 *   needs_review   replied with something the matcher can't classify
 *   no_answer      swept by `cli.js sweep` after N days of silence
 */

export function upsertLead(lead) {
  const existing = db.prepare('SELECT id FROM leads WHERE phone = ?').get(lead.phone);
  if (existing) return { inserted: false, id: existing.id };

  try {
    const info = db.prepare(`
      INSERT INTO leads (brand_name, phone, category, address, website, rating, reviews, source, source_query, niche, assigned_broker_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      lead.brand_name,
      lead.phone,
      lead.category ?? null,
      lead.address ?? null,
      lead.website ?? null,
      lead.rating ?? null,
      lead.reviews ?? null,
      lead.source ?? 'google_maps',
      lead.source_query ?? null,
      lead.niche ?? null,
      lead.assigned_broker_id ?? null,
    );

    return { inserted: true, id: Number(info.lastInsertRowid) };
  } catch (err) {
    // Two brokers' scrapes can now genuinely race on the same real business
    // between this function's SELECT above and its INSERT -- the `phone`
    // UNIQUE constraint is what actually decides who wins, so a constraint
    // failure here means someone else's insert landed first, not a real
    // error. Treat it exactly like the existing "already exists" branch.
    if (!/UNIQUE constraint failed/.test(err.message)) throw err;
    const winner = db.prepare('SELECT id FROM leads WHERE phone = ?').get(lead.phone);
    return { inserted: false, id: winner.id };
  }
}

export function logMessage(leadId, direction, body) {
  db.prepare('INSERT INTO messages (lead_id, direction, body) VALUES (?, ?, ?)')
    .run(leadId, direction, body);
}

export function setStatus(leadId, status, extra = {}) {
  const cols = Object.keys(extra);
  const sets = ['status = ?', ...cols.map((c) => `${c} = ?`)].join(', ');
  db.prepare(`UPDATE leads SET ${sets} WHERE id = ?`)
    .run(status, ...cols.map((c) => extra[c]), leadId);
}

export function leadByPhone(phone) {
  return db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone);
}

export function sentToday() {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM leads
    WHERE date(opener_sent_at) = date('now', 'localtime')
  `).get().n;
}

export function firstSendDate() {
  return db.prepare(`
    SELECT date(MIN(opener_sent_at)) AS d FROM leads WHERE opener_sent_at IS NOT NULL
  `).get().d;
}
