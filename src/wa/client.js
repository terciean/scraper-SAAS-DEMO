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
export function createClient() {
  return new Client({
    authStrategy: new LocalAuth({ dataPath: join(ROOT, 'data', 'wa-session') }),
    puppeteer: {
      headless: false,
      executablePath: chromePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });
}

export function startClient(client, { onReady, onMessage } = {}) {
  client.on('qr', (qr) => {
    console.log('\nScan this QR with WhatsApp > Linked devices:\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => console.log('[wa] authenticated'));
  client.on('auth_failure', (m) => console.error('[wa] auth failure:', m));
  client.on('disconnected', (r) => console.error('[wa] disconnected:', r));

  client.on('ready', async () => {
    console.log('[wa] ready');
    if (onReady) await onReady(client);
  });

  if (onMessage) client.on('message', (msg) => onMessage(msg, client));

  return client.initialize();
}
