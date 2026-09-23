import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));

// Mutates the shared config object (so it takes effect immediately for this
// run too) and writes it back to disk as the new default for next time.
export function setBatchSize(n) {
  config.ui = config.ui ?? {};
  config.ui.batchSize = n;
  writeFileSync(join(ROOT, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}
