import { updateWaState } from '../brokers.js';
import { toWhatsAppId } from '../phone.js';
import { createClient, startClient } from './client.js';

// Live WhatsApp connection state, per broker. Deliberately in-memory only --
// see the comment on the `brokers` table in src/migrate.js for why: this
// mirrors server.js's existing single in-memory scrapeJob, just keyed by
// broker id instead of being a singleton. A server restart drops this map;
// brokers.js's wa_status/wa_phone columns are what survives, for display.
const sessions = new Map(); // brokerId -> { client, status, qr, phone, error }

export function getSessionState(brokerId) {
  return sessions.get(brokerId) ?? { status: 'disconnected', qr: null, phone: null, error: null };
}

/** Idempotent: calling this again while already connecting/connected just
 * returns the current state instead of starting a second session. */
export function connectBroker(brokerId) {
  const existing = sessions.get(brokerId);
  if (existing && ['connecting', 'qr_ready', 'connected'].includes(existing.status)) {
    return existing;
  }

  const state = { client: null, status: 'connecting', qr: null, phone: null, error: null };
  sessions.set(brokerId, state);

  // Headless here, unlike the existing single-operator client -- N broker
  // Chrome windows popping up on the server is not workable even at a
  // handful of brokers.
  const client = createClient({ clientId: `broker-${brokerId}`, headless: true });
  state.client = client;

  startClient(client, {
    onQr: (qr) => {
      state.status = 'qr_ready';
      state.qr = qr;
    },
    onReady: () => {
      state.status = 'connected';
      state.qr = null;
      state.phone = client.info?.wid?.user ?? null;
      state.error = null;
      updateWaState(brokerId, { status: 'connected', phone: state.phone, error: null });
    },
    onAuthFailure: (msg) => {
      state.status = 'auth_failed';
      state.error = msg;
      updateWaState(brokerId, { status: 'auth_failed', error: msg });
    },
    onDisconnected: (reason) => {
      state.status = 'disconnected';
      state.error = reason;
      updateWaState(brokerId, { status: 'disconnected', error: reason });
      sessions.delete(brokerId);
    },
  }).catch((err) => {
    state.status = 'auth_failed';
    state.error = err.message;
    updateWaState(brokerId, { status: 'auth_failed', error: err.message });
  });

  return state;
}

export async function disconnectBroker(brokerId) {
  const state = sessions.get(brokerId);
  if (state?.client) await state.client.destroy().catch(() => {});
  sessions.delete(brokerId);
  updateWaState(brokerId, { status: 'disconnected', error: null });
}

/** The integration point future opener/pitch wiring calls into once leads
 * carry a broker/tenant id -- not used by the board yet (see the plan). */
export async function sendViaBroker(brokerId, phone, text) {
  const state = sessions.get(brokerId);
  if (!state || state.status !== 'connected') {
    throw new Error(`broker ${brokerId} has no connected WhatsApp session`);
  }
  await state.client.sendMessage(toWhatsAppId(phone), text);
}
