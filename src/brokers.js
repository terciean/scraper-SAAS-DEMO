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

  const info = db.prepare('INSERT INTO brokers (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name.trim(), email.trim(), hashPassword(password));
  return { broker: getBroker(Number(info.lastInsertRowid)) };
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
