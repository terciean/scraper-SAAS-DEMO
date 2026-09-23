import { bestPhone, whatsAppLikelihood } from './phone.js';

/**
 * A confirmed landline can never receive a WhatsApp message. If nothing has
 * been sent to it yet, it doesn't belong in the batch at all -- not just
 * sorted last, where it would still eat a batch slot and offer a live Opener
 * button that can only fail. Once an opener has actually gone out, leave it
 * be; that already proved (or disproved) reachability, this filter is not
 * the place to relitigate it. 'rejected' tier is excluded outright, at any
 * status -- it means the business itself was disqualified, not just its phone.
 *
 * This is the single source of truth for "does this lead count toward a
 * batch/target". server.js (what the board shows) and cli.js (what `board
 * --limit=N` decides it needs to scrape) both import this -- they used to
 * each have their own copy, which drifted: cli.js counted every 'new' row as
 * workable with no reachability check, so a request for 30 leads could scrape
 * for a handful when most of what was already in the database was landlines
 * the board would never show anyway.
 */
export function isWorkable(l) {
  if (l.tier === 'rejected') return false;
  if (l.status === 'new' && whatsAppLikelihood(bestPhone(l)) === 'no') return false;
  return true;
}

const statusRank = (l) => ({ confirmed: 0, opener_sent: 1 }[l.status] ?? 2);
const reach = (l) => ({ yes: 0, maybe: 1 }[whatsAppLikelihood(bestPhone(l))] ?? 2);

/**
 * Board order: newest unsent leads first (so a paste is immediately actionable),
 * then awaiting-reply rows. Awaiting-reply never consumes opener slots -- those
 * leads just sit until they reply. Unsent is capped at `size`; awaiting is not.
 */
export function assembleBoard(candidates, { size }) {
  const workable = candidates.filter(isWorkable);

  const fresh = workable
    .filter((l) => l.status === 'new')
    .sort((a, b) => b.id - a.id)
    .slice(0, size);

  const awaiting = workable
    .filter((l) => l.status === 'opener_sent' || l.status === 'confirmed')
    .sort((a, b) => statusRank(a) - statusRank(b) || reach(a) - reach(b) || a.id - b.id);

  return [...fresh, ...awaiting];
}

export function countWorkable(db) {
  return db.prepare(`
    SELECT * FROM leads WHERE status IN ('new', 'opener_sent', 'confirmed')
  `).all().filter(isWorkable).length;
}

/** Unsent, messageable leads only -- awaiting-reply does not fill this quota. */
export function countUnsentWorkable(db) {
  return db.prepare(`SELECT * FROM leads WHERE status = 'new'`).all().filter(isWorkable).length;
}
