import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import './migrate.js';
import { db } from './db.js';

const SESSION_DAYS = 30;
const COOKIE_NAME = 'sid';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  const hash = scryptSync(password, salt, 64);
  const stored_ = Buffer.from(hashHex, 'hex');
  // Lengths must match before timingSafeEqual -- a mismatched length throws
  // rather than returning false, which would leak length info anyway if not
  // guarded first.
  if (hash.length !== stored_.length) return false;
  return timingSafeEqual(hash, stored_);
}

export function createSession(brokerId) {
  const token = randomBytes(32).toString('hex');
  db.prepare(`
    INSERT INTO sessions (token, broker_id, expires_at)
    VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))
  `).run(token, brokerId);
  return token;
}

/** Returns the broker row for a valid, unexpired session token -- or null.
 * Lazily deletes the row if it's expired, so there's no separate cleanup job. */
export function getSessionBroker(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT b.* FROM sessions s
    JOIN brokers b ON b.id = s.broker_id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token);
  if (row) return row;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return null;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Hand-rolled Cookie/Set-Cookie handling -- the raw node:http server here has
// no cookie-parsing middleware, and this is the only cookie the app sets.
export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((p) => {
      const i = p.indexOf('=');
      return i === -1 ? [p.trim(), ''] : [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())];
    }),
  );
}

export function sessionCookieHeader(token, { clear = false } = {}) {
  // No `Secure` flag: this serves plain HTTP for local/LAN demo use today.
  // Add `Secure` the moment this is ever deployed behind HTTPS.
  const base = `${COOKIE_NAME}=${clear ? '' : token}; HttpOnly; SameSite=Lax; Path=/`;
  return clear ? `${base}; Max-Age=0` : `${base}; Max-Age=${SESSION_DAYS * 86400}`;
}

export function sessionToken(req) {
  return parseCookies(req)[COOKIE_NAME];
}

// ---------- admin ----------
// A fully separate credential from broker sessions above -- one shared
// password (ADMIN_PASSWORD in .env), not a per-admin account, so an admin
// session can never be confused with or escalated from a broker one.
const ADMIN_SESSION_DAYS = 7;
const ADMIN_COOKIE_NAME = 'asid';

export function verifyAdminPassword(password) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || !password) return false;
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createAdminSession() {
  const token = randomBytes(32).toString('hex');
  db.prepare(`
    INSERT INTO admin_sessions (token, expires_at)
    VALUES (?, datetime('now', '+${ADMIN_SESSION_DAYS} days'))
  `).run(token);
  return token;
}

export function getAdminSession(token) {
  if (!token) return false;
  const row = db.prepare('SELECT 1 FROM admin_sessions WHERE token = ? AND expires_at > datetime(\'now\')').get(token);
  if (row) return true;
  db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
  return false;
}

export function destroyAdminSession(token) {
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
}

export function adminCookieHeader(token, { clear = false } = {}) {
  const base = `${ADMIN_COOKIE_NAME}=${clear ? '' : token}; HttpOnly; SameSite=Lax; Path=/`;
  return clear ? `${base}; Max-Age=0` : `${base}; Max-Age=${ADMIN_SESSION_DAYS * 86400}`;
}

export function adminSessionToken(req) {
  return parseCookies(req)[ADMIN_COOKIE_NAME];
}
