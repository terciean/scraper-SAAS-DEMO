import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { config } from './config.js';
import './migrate.js';
import { db, logMessage, setStatus } from './db.js';
import { renderOpener, renderPitch } from './templates.js';
import { markContacted } from './exclusions.js';

const now = () => new Date().toISOString();

/**
 * wa.me deep link with the message pre-filled. Opening this puts the text in
 * the compose box of the user's own WhatsApp -- they press send themselves.
 * No automation client, no unofficial API, nothing for Meta to fingerprint.
 */
export function waLink(phone, text) {
  return `https://wa.me/${phone.replace(/^\+/, '')}?text=${encodeURIComponent(text)}`;
}

function openInBrowser(url) {
  // `start` is a cmd builtin, so it needs a shell; the empty "" is the window
  // title argument, without which a quoted URL is treated as the title.
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}

function eligible(limit) {
  const needContact = config.send.safety?.requireContactsExported;
  // Only gate on tier once qualification has actually run. Without an API key
  // nothing is tiered, and refusing to queue anything would make the tool
  // unusable for the manual flow, which does not depend on qualification.
  const anyTiered = db.prepare('SELECT COUNT(*) n FROM leads WHERE tier IS NOT NULL').get().n > 0;
  const tier = anyTiered ? config.send.onlyTier : null;

  // node:sqlite rejects named params the statement does not reference, so the
  // bindings have to match whichever clauses were actually interpolated.
  const stmt = db.prepare(`
    SELECT * FROM leads
    WHERE status = 'new'
      ${tier ? 'AND tier = @tier' : ''}
      ${needContact ? 'AND contact_exported_at IS NOT NULL' : ''}
    ORDER BY id LIMIT @limit
  `);

  const rows = tier ? stmt.all({ tier, limit }) : stmt.all({ limit });
  return { rows, tierGated: Boolean(tier) };
}

// Resolve on close as well as on an answer: without it, EOF on stdin (Ctrl+D,
// or a piped script running out of input) leaves the promise pending forever.
function ask(rl, q) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    rl.once('close', () => finish('q'));
    rl.question(q, (a) => finish(a.trim().toLowerCase()));
  });
}

/**
 * Walk the eligible leads one at a time. For each: show the message, open the
 * pre-filled chat, and record what happened once the user says so.
 */
export async function runQueue({ limit = null, noOpen = false } = {}) {
  const cap = limit ?? config.send.dailyCap;
  const { rows: leads, tierGated } = eligible(cap);

  if (!leads.length) {
    const d = db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE tier IS NULL)                             AS unqualified,
        COUNT(*) FILTER (WHERE tier = ? AND contact_exported_at IS NULL) AS unsaved
      FROM leads WHERE status = 'new'
    `).get(config.send.onlyTier);
    console.log('\n  nothing queued.');
    if (d.unqualified) console.log(`  ${d.unqualified} lead(s) not qualified   -> node cli.js pipeline`);
    if (d.unsaved)     console.log(`  ${d.unsaved} lead(s) not saved as contacts -> node cli.js contacts`);
    console.log();
    return;
  }

  const sentToday = db.prepare(`
    SELECT COUNT(*) n FROM leads WHERE date(opener_sent_at) = date('now','localtime')
  `).get().n;

  console.log(`\n  ${leads.length} lead(s) queued · ${sentToday} already sent today`);
  if (!tierGated) console.log('  (not qualified yet — queueing all scraped leads)');
  console.log('  [enter] sent  ·  s skip  ·  w wrong/bad  ·  q quit\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let sent = 0;

  for (const [i, lead] of leads.entries()) {
    const msg = renderOpener(lead);
    const link = waLink(lead.phone, msg);

    console.log(`\n  ─── ${i + 1}/${leads.length} ─────────────────────────────`);
    console.log(`  ${lead.brand_name}`);
    console.log(`  ${lead.phone}${lead.category ? `  ·  ${lead.category}` : ''}`);
    if (lead.fb_ads_angle) console.log(`  angle: ${lead.fb_ads_angle.slice(0, 100)}`);
    console.log(`\n  "${msg}"\n`);
    console.log(`  ${link}\n`);

    if (!noOpen) openInBrowser(link);

    const a = await ask(rl, '  > ');
    if (a === 'q') break;

    if (a === 's') { console.log('  skipped'); continue; }

    if (a === 'w') {
      setStatus(lead.id, 'wrong_number', { notes: 'marked bad in queue' });
      console.log('  marked wrong_number');
      continue;
    }

    setStatus(lead.id, 'opener_sent', { opener_sent_at: now() });
    markContacted(lead);
    logMessage(lead.id, 'out', msg);
    sent += 1;
    console.log(`  recorded as sent (${sent})`);
  }

  rl.close();
  console.log(`\n  done — ${sent} recorded as sent.`);
  console.log('  log replies with:  node cli.js reply-to --id=N "what they said"\n');
}

/** Queue the pitch for leads that confirmed, same manual flow. */
export async function runPitchManual({ noOpen = false } = {}) {
  const leads = db.prepare("SELECT * FROM leads WHERE status = 'confirmed' ORDER BY confirmed_at").all();
  if (!leads.length) return console.log('\n  nobody waiting in confirmed.\n');

  console.log(`\n  ${leads.length} confirmed lead(s) to pitch`);
  console.log('  [enter] sent  ·  s skip  ·  q quit\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let sent = 0;

  for (const [i, lead] of leads.entries()) {
    const msg = renderPitch({ ...lead, contactName: lead.contact_name });
    const link = waLink(lead.phone, msg);

    console.log(`\n  ─── ${i + 1}/${leads.length} ─────────────────────────────`);
    console.log(`  ${lead.brand_name}${lead.contact_name ? `  ·  ${lead.contact_name}` : ''}`);
    console.log(`  they said: ${JSON.stringify((lead.last_inbound ?? '').slice(0, 110))}`);
    console.log(`\n  "${msg.slice(0, 200)}${msg.length > 200 ? '…' : ''}"\n`);
    console.log(`  ${link}\n`);

    if (!noOpen) openInBrowser(link);

    const a = await ask(rl, '  > ');
    if (a === 'q') break;
    if (a === 's') { console.log('  skipped'); continue; }

    setStatus(lead.id, 'pitch_sent', { pitch_sent_at: now() });
    markContacted(lead);
    logMessage(lead.id, 'out', msg);
    sent += 1;
    console.log(`  recorded as pitched (${sent})`);
  }

  rl.close();
  console.log(`\n  done — ${sent} pitched.\n`);
}
