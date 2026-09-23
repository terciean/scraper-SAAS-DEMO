import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from './config.js';
import { db } from './db.js';
import { cleanBrandName } from './templates.js';

// vCard escaping: commas, semicolons and backslashes are field separators.
const esc = (s) => String(s ?? '').replace(/([\,;])/g, '\$1').replace(/\r?\n/g, '\n');

function vcard(lead) {
  const name = `${config.contacts.namePrefix ?? ''}${cleanBrandName(lead.brand_name)}`;
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:;${esc(name)};;;`,
    `FN:${esc(name)}`,
    `ORG:${esc(cleanBrandName(lead.brand_name))}`,
    `TEL;TYPE=CELL:${lead.phone}`,
    lead.website ? `URL:${esc(lead.website)}` : null,
    lead.address ? `ADR;TYPE=WORK:;;${esc(lead.address)};;;;` : null,
    `NOTE:${esc(`${lead.category ?? 'lead'} | ${lead.source_query ?? ''}`)}`,
    'END:VCARD',
  ].filter(Boolean).join('\r\n');
}

export function exportContacts({ tier = 'outreach_ready', status = null, out = null } = {}) {
  // `status` wins when given; otherwise select by qualification tier so the
  // phone only ever fills up with leads that are actually going to be messaged.
  let rows, label;
  if (status) {
    label = `status-${status}`;
    rows = status === 'all'
      ? db.prepare("SELECT * FROM leads WHERE status != 'excluded' ORDER BY id").all()
      : db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY id').all(status);
  } else {
    label = tier;
    rows = tier === 'all'
      ? db.prepare("SELECT * FROM leads WHERE status != 'excluded' ORDER BY id").all()
      : db.prepare('SELECT * FROM leads WHERE tier = ? ORDER BY id').all(tier);
  }

  if (!rows.length) {
    console.log(`[contacts] no leads matching ${label}`);
    return null;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const path = out ?? join(ROOT, 'data', `contacts-${label}-${stamp}.vcf`);
  writeFileSync(path, rows.map(vcard).join('\r\n') + '\r\n', 'utf8');

  // Mark them exported so `send` can insist the number was saved as a contact
  // first -- WhatsApp treats messages to non-contacts as more spam-like.
  const mark = db.prepare('UPDATE leads SET contact_exported_at = ? WHERE id = ?');
  const stampedAt = new Date().toISOString();
  for (const r of rows) mark.run(stampedAt, r.id);

  console.log(`[contacts] ${rows.length} contacts -> ${path}`);
  console.log('  Import at contacts.google.com > Import, then let your phone sync.');
  console.log('  WhatsApp will then show the brand name instead of a bare number.');
  return path;
}
