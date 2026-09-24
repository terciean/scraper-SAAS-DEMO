import './migrate.js';
import { db } from './db.js';
import { hashPassword } from './auth.js';

export function getBroker(id) {
  return db.prepare('SELECT * FROM brokers WHERE id = ?').get(id);
}

export function getBrokerByEmail(email) {
  return db.prepare('SELECT * FROM brokers WHERE email = ?').get(email);
}

// Brokers are created through signup only -- there's no separate
// admin-creates-a-broker-with-no-password path any more, since every broker
// needs a password to log in and manage their own WhatsApp connection.
export function createBroker({ name, email, password }) {
  if (!name || !name.trim()) return { error: 'name is required' };
  if (!email || !email.trim()) return { error: 'email is required' };
  if (!password || password.length < 8) return { error: 'password must be at least 8 characters' };
  if (getBrokerByEmail(email.trim())) return { error: 'an account with that email already exists' };

  const info = db.prepare(`
    INSERT INTO brokers (name, email, password_hash, trial_ends_at)
    VALUES (?, ?, ?, datetime('now', '+14 days'))
  `).run(name.trim(), email.trim(), hashPassword(password));
  return { broker: getBroker(Number(info.lastInsertRowid)) };
}

/**
 * Single source of truth for "does this broker currently have access" --
 * the request gate in server.js and anything that ever needs to display
 * subscription state both go through this, so they can't drift apart the
 * way cli.js's and server.js's workable-lead counts once did
 * (src/leadFilters.js's isWorkable() was written for exactly that reason).
 */
// SQLite's datetime() stores UTC as "YYYY-MM-DD HH:MM:SS" (no 'Z', no 'T').
// Handing that straight to `new Date()` parses it as LOCAL time instead of
// UTC -- verified live: on this machine (UTC+2) that silently shifted every
// trial's expiry by 2 hours. Force it back to a real ISO UTC string first.
function parseSqliteUtc(s) {
  return new Date(`${s.replace(' ', 'T')}Z`);
}

export function hasActiveSubscription(broker) {
  if (broker.subscription_status === 'active') return true;
  if (broker.subscription_status === 'trialing') {
    return Boolean(broker.trial_ends_at) && parseSqliteUtc(broker.trial_ends_at) > new Date();
  }
  return false;
}

/** Persist the last-known WhatsApp outcome for a broker -- called by the
 * session manager whenever the live (in-memory) connection state changes. */
export function updateWaState(id, { status, phone = undefined, error = undefined }) {
  const sets = ['wa_status = ?'];
  const args = [status];
  if (status === 'connected') sets.push("wa_connected_at = datetime('now')");
  if (phone !== undefined) { sets.push('wa_phone = ?'); args.push(phone); }
  if (error !== undefined) { sets.push('wa_last_error = ?'); args.push(error); }
  args.push(id);
  db.prepare(`UPDATE brokers SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}
