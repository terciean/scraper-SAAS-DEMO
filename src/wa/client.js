import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.js';

const { Client, LocalAuth } = pkg;

// Plain '\' escapes silently drop the backslash for any letter that isn't a
// real escape code (\P, \G, \C, \A aren't -- e.g. "\Program" -> "Program"),
// so these must be raw forward slashes; Windows accepts either.
const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

function chromePath() {
  return CHROME_PATHS.find((p) => existsSync(p));
}

// Session is persisted under data/wa-session, so the QR scan is a one-time step.
//
// `clientId` namespaces LocalAuth's on-disk session under
// `<dataPath>/session-<clientId>/`, which is enough by itself to run several
// Client instances concurrently without colliding -- so broker sessions get
// their own dataPath (data/wa-sessions, plural) entirely separate from the
// single-operator session above, and never need per-broker dataPath. Calling
// createClient() with no args (the existing single-operator call sites in
// send.js/listen.js) is untouched: no clientId, same dataPath, same
// `headless: false` default.
export function createClient({ clientId, headless = false } = {}) {
  const dataPath = clientId
    ? join(ROOT, 'data', 'wa-sessions')
    : join(ROOT, 'data', 'wa-session');
  return new Client({
    authStrategy: new LocalAuth({ dataPath, clientId }),
    puppeteer: {
      headless,
      executablePath: chromePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });
}

export function startClient(client, { onReady, onMessage, onQr, onAuthFailure, onDisconnected } = {}) {
  client.on('qr', (qr) => {
    if (onQr) { onQr(qr); return; }
    console.log('\nScan this QR with WhatsApp > Linked devices:\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => console.log('[wa] authenticated'));
  client.on('auth_failure', (m) => { console.error('[wa] auth failure:', m); onAuthFailure?.(m); });
  client.on('disconnected', (r) => { console.error('[wa] disconnected:', r); onDisconnected?.(r); });

  client.on('ready', async () => {
    console.log('[wa] ready');
    if (onReady) await onReady(client);
  });

  if (onMessage) client.on('message', (msg) => onMessage(msg, client));

  return client.initialize();
}
