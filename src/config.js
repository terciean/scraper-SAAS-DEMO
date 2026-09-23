import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// No dotenv dependency -- .env is optional and only ever holds OPENAI_API_KEY
// today. Never overrides a real env var already set in the shell/host.
try {
  const envFile = readFileSync(join(ROOT, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = value;
  }
} catch { /* no .env file -- fine, env vars can be set another way */ }

export const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));

// Mutates the shared config object (so it takes effect immediately for this
// run too) and writes it back to disk as the new default for next time.
export function setBatchSize(n) {
  config.ui = config.ui ?? {};
  config.ui.batchSize = n;
  writeFileSync(join(ROOT, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}
