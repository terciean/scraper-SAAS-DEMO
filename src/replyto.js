import './migrate.js';
import { db, logMessage, setStatus } from './db.js';
import { extractContactName, suggestReply, renderPitch } from './templates.js';
import { classifyInbound, classifyAfterPitch, classifierMode } from './classify.js';
import { waLink } from './queue.js';

const now = () => new Date().toISOString();

/**
 * Paste-in reply handling: you read the reply in WhatsApp yourself and paste it
 * here. Nothing connects to WhatsApp, so there is no automation surface at all.
 * Returns the next action and a ready-to-send link where one applies.
 */
export async function handlePastedReply(leadId, text, { noOpen = false } = {}) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) return console.log(`  no lead ${leadId}`);
  if (!text) return console.log('  usage: node cli.js reply-to --id=N "what they said"');

  logMessage(lead.id, 'in', text);
  const name = lead.contact_name ?? extractContactName(text);
  const pitched = lead.status === 'pitch_sent' || lead.status === 'replied';

  console.log(`\n  ${lead.brand_name}${name ? `  ·  ${name}` : ''}`);
  console.log(`  classifier: ${classifierMode()}`);

  const { label, via } = pitched
    ? await classifyAfterPitch(text)
    : await classifyInbound(text, lead);

  console.log(`  -> ${label}  [${via}]\n`);

  // ---- post-pitch: suggest, never decide ----
  if (pitched) {
    const draft = suggestReply(label, { contactName: name });
    setStatus(lead.id, 'replied', {
      last_inbound_at: now(), last_inbound: text, contact_name: name,
      stage: label, suggested_reply: draft,
    });

    if (draft) {
      console.log(`  suggested reply:\n\n  "${draft}"\n`);
      console.log(`  ${waLink(lead.phone, draft)}\n`);
    } else {
      console.log('  no canned reply for this one — answer it yourself.\n');
    }
    return;
  }

  // ---- reply to the opener ----
  if (label !== 'confirmed') {
    setStatus(lead.id, label, {
      last_inbound_at: now(), last_inbound: text, contact_name: name,
    });
    console.log(`  marked ${label}. Nothing further to send.\n`);
    return;
  }

  setStatus(lead.id, 'confirmed', {
    confirmed_at: now(), last_inbound_at: now(), last_inbound: text, contact_name: name,
  });

  const pitch = renderPitch({ ...lead, contactName: name });
  console.log(`  confirmed — send the pitch${name ? ` (addressed to ${name})` : ''}:\n`);
  console.log(`  "${pitch}"\n`);
  console.log(`  ${waLink(lead.phone, pitch)}\n`);
  console.log(`  once sent:  node cli.js mark --id=${lead.id} --status=pitch_sent\n`);
}

/** Find a lead by a fragment of its name or number, so you don't need the id. */
export function findLead(needle) {
  const rows = db.prepare(`
    SELECT id, brand_name, phone, status, contact_name FROM leads
    WHERE brand_name LIKE ? OR phone LIKE ?
    ORDER BY id LIMIT 15
  `).all(`%${needle}%`, `%${needle}%`);

  if (!rows.length) return console.log(`  no lead matching "${needle}"`);
  console.log();
  for (const r of rows) {
    console.log(`  [${r.id}] ${r.brand_name}${r.contact_name ? ` (${r.contact_name})` : ''} — ${r.phone} — ${r.status}`);
  }
  console.log();
}
