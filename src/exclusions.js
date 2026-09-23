import { readFileSync } from 'node:fs';
import './migrate.js';
import { db } from './db.js';
import { cleanBrandName } from './templates.js';

// Canonical key for name matching: brand-cleaned, lowercased, punctuation and
// filler words removed. "Dis-Chem Pharmacy (Pty) Ltd" and "dischem" both key to
// "dischem", so an exclusion entered either way still matches.
export function nameKey(name) {
  return cleanBrandName(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(the|pty|ltd|cc|inc|sa|south africa|pharmacy|stores?|shop|online|group|holdings|brands?)\b/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

export function domainKey(url) {
  if (!url) return null;
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`)
      .hostname.replace(/^www\./, '').toLowerCase();
  } catch { return null; }
}

// National chains, franchise groups, corporates and MLMs. The brief rules these
// out regardless of what the scrape surfaces, so they are filtered before a lead
// is ever written -- they never reach the outreach pool.
export const CHAINS = [
  'dischem', 'clicks', 'wellnesswarehouse', 'hollandandbarrett', 'sportsmanswarehouse',
  'faithfultonature', 'takealot', 'checkers', 'picknpay', 'woolworths', 'shoprite',
  'makro', 'game', 'spar', 'medirite', 'alphapharm', 'linkpharmacy', 'localchoice',
  'netcare', 'mediclinic', 'lifehealthcare', 'intercare', 'ampath', 'lancet',
  'virginactive', 'planetfitness', 'zonefitness', 'curves', 'body20', 'bodytec',
  'sorbet', 'placecol', 'skinrenewal', 'drskin', 'clinix',
  'herbalife', 'nuskin', 'amway', 'forever living', 'foreverliving', 'juiceplus',
  'usn', 'biogen', 'nutritech', 'futurelife', 'bioplus',
  'discovery', 'momentum', 'bestmed', 'vitality',
];

const CHAIN_KEYS = new Set(CHAINS.map(nameKey));

export function isChain(name) {
  const k = nameKey(name);
  if (!k) return false;
  if (CHAIN_KEYS.has(k)) return true;
  // Substring guard catches "Clicks Canal Walk" -> key "clickscanalwalk".
  return [...CHAIN_KEYS].some((c) => c.length >= 6 && k.includes(c));
}

export function addExclusion({ name, phone = null, domain = null, reason = 'contacted' }) {
  const key = nameKey(name);
  if (!key) return false;
  db.prepare(`
    INSERT INTO exclusions (name_key, raw_name, phone, domain, reason)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name_key) DO UPDATE SET
      phone  = COALESCE(excluded.phone,  exclusions.phone),
      domain = COALESCE(excluded.domain, exclusions.domain),
      reason = excluded.reason
  `).run(key, name.trim(), phone, domainKey(domain), reason);
  return true;
}

/**
 * Check a lead against the exclusion list and the chain filter.
 * Matches on any of: canonical name key, exact phone, website domain.
 */
export function checkExcluded({ brand_name, phone = null, website = null }) {
  if (isChain(brand_name)) return { excluded: true, reason: 'national chain / corporate / MLM' };

  const key = nameKey(brand_name);
  const dom = domainKey(website);

  const hit = db.prepare(`
    SELECT raw_name, reason FROM exclusions
    WHERE name_key = ?
       OR (phone  IS NOT NULL AND phone  = ?)
       OR (domain IS NOT NULL AND domain = ?)
    LIMIT 1
  `).get(key, phone, dom);

  return hit
    ? { excluded: true, reason: `${hit.reason} (matched "${hit.raw_name}")` }
    : { excluded: false };
}

/**
 * Import an exclusion list. Accepts one business per line; an optional phone,
 * URL or reason may follow after a comma, tab or pipe, in any order.
 */
export function importExclusions(path, reason = 'contacted') {
  const text = readFileSync(path, 'utf8');
  let n = 0, skipped = 0;

  for (const line of text.split('\n')) {
    const t = line.trim().replace(/^[-*\u2022]\s*/, '');
    if (!t || /^#/.test(t)) continue;

    const parts = t.split(/\s*[,\t|]\s*/).filter(Boolean);
    const name = parts.shift();
    if (!name || nameKey(name).length < 2) { skipped += 1; continue; }

    let phone = null, domain = null, lineReason = reason;
    for (const p of parts) {
      if (/^\+?[\d\s()-]{7,}$/.test(p)) phone = p.replace(/[^\d+]/g, '');
      else if (/\./.test(p) && !/\s/.test(p)) domain = p;
      else lineReason = p; // anything else is a free-text reason
    }

    if (addExclusion({ name, phone, domain, reason: lineReason })) n += 1;
  }

  console.log(`[exclusions] imported ${n}${skipped ? `, skipped ${skipped} unusable line(s)` : ''}`);
  return n;
}

/**
 * Record that a lead has actually been messaged, so it (or a re-discovered
 * duplicate of the same business under a different phone number / Maps
 * listing) can never be scraped or pasted back into the pool as 'new'.
 *
 * This is the fix for leads getting contacted twice: `checkExcluded()` was
 * always run at scrape/import time, but nothing ever added a contacted lead
 * to the `exclusions` table it checks. The `leads.phone` UNIQUE constraint
 * caught an exact repeat scrape of the identical Maps listing, but Google
 * Maps frequently carries more than one listing for the same real business
 * (branches, call-tracking numbers, re-crawled listings with a reformatted
 * number) -- those have a different phone, so the UNIQUE constraint never
 * saw them and they came back in as brand-new, unsent leads. Matching on
 * name_key/domain here (not just phone) is what actually catches that case.
 */
export function markContacted(lead) {
  return addExclusion({
    name: lead.brand_name,
    phone: lead.phone,
    domain: lead.website,
    reason: 'contacted',
  });
}

// One-time repair for a database that already had sends go out before
// markContacted() existed: back-fill the exclusion list from send history so
// past contacts are protected too, not just contacts made from now on.
export function backfillContactedExclusions() {
  const rows = db.prepare(`
    SELECT brand_name, phone, website FROM leads
    WHERE opener_sent_at IS NOT NULL OR pitch_sent_at IS NOT NULL
  `).all();
  let n = 0;
  for (const r of rows) if (markContacted(r)) n += 1;
  console.log(`[exclusions] back-filled ${n} contacted lead(s) into the exclusion list`);
  return n;
}

// Retro-apply the list to leads already in the database.
export function applyExclusionsToExisting() {
  const rows = db.prepare("SELECT id, brand_name, phone, website FROM leads WHERE status NOT IN ('excluded')").all();
  let n = 0;
  for (const r of rows) {
    const { excluded, reason } = checkExcluded(r);
    if (!excluded) continue;
    db.prepare("UPDATE leads SET status='excluded', excluded_reason=? WHERE id=?").run(reason, r.id);
    n += 1;
  }
  console.log(`[exclusions] marked ${n} existing lead(s) excluded`);
  return n;
}
