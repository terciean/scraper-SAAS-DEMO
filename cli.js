#!/usr/bin/env node
import './src/migrate.js';
import { db } from './src/db.js';
import { config, setBatchSize } from './src/config.js';
import { scrape } from './src/scrape/googlemaps.js';
import { countUnsentWorkable } from './src/leadFilters.js';
import { importPastedLeads } from './src/importLeads.js';
import { readFileSync } from 'node:fs';
import { exportContacts } from './src/contacts.js';
import { runSend, todaysCap } from './src/wa/send.js';
import { runListen, runPitchQueue, runSendReply } from './src/wa/listen.js';
import { runPipeline, runQualifyOnly } from './src/pipeline.js';
import { qualifierAvailable } from './src/qualify.js';
import { exportLeads, exportCsv, formatLead } from './src/export.js';
import { importExclusions, addExclusion, applyExclusionsToExisting, backfillContactedExclusions } from './src/exclusions.js';
import { renderOpener } from './src/templates.js';
import { runQueue, runPitchManual } from './src/queue.js';
import { handlePastedReply, findLead } from './src/replyto.js';
import { startServer } from './src/server.js';

const argv = process.argv.slice(2);
const cmd = argv[0];

const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const num = (name, fallback = null) => (opt(name) ? Number(opt(name)) : fallback);

function stats() {
  const byStatus = db.prepare('SELECT status, COUNT(*) n FROM leads GROUP BY status ORDER BY n DESC').all();
  const byTier = db.prepare('SELECT tier, COUNT(*) n FROM leads WHERE tier IS NOT NULL GROUP BY tier ORDER BY n DESC').all();
  const total = byStatus.reduce((s, r) => s + r.n, 0);

  console.log(`\n  ${total} leads total\n`);
  for (const r of byStatus) console.log(`    ${String(r.n).padStart(5)}  ${r.status}`);

  if (byTier.length) {
    console.log('\n  qualification:');
    for (const r of byTier) console.log(`    ${String(r.n).padStart(5)}  ${r.tier}`);
  }

  const t = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM leads WHERE date(created_at)     = date('now','localtime')) scraped,
      (SELECT COUNT(*) FROM leads WHERE date(opener_sent_at) = date('now','localtime')) openers,
      (SELECT COUNT(*) FROM leads WHERE date(pitch_sent_at)  = date('now','localtime')) pitches
  `).get();
  console.log(`\n  today: ${t.scraped} scraped, ${t.openers} openers (cap ${todaysCap()}), ${t.pitches} pitches`);

  const pend = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM leads WHERE status='new' AND enriched_at IS NULL) unenriched,
      (SELECT COUNT(*) FROM leads WHERE status='new' AND enriched_at IS NOT NULL AND tier IS NULL) unqualified,
      (SELECT COUNT(*) FROM leads WHERE status='confirmed')                   confirmed,
      (SELECT COUNT(*) FROM leads WHERE suggested_reply IS NOT NULL)          drafts,
      (SELECT COUNT(*) FROM leads WHERE status='needs_review')                review,
      (SELECT COUNT(*) FROM exclusions)                                       excl
  `).get();

  console.log();
  if (pend.unenriched)  console.log(`  ${pend.unenriched} scraped, not yet enriched     -> node cli.js pipeline`);
  if (pend.unqualified) console.log(`  ${pend.unqualified} enriched, not yet qualified   -> node cli.js qualify  (needs the \`claude\` CLI on PATH)`);
  if (pend.confirmed)  console.log(`  ${pend.confirmed} confirmed, awaiting pitch     -> node cli.js pitch`);
  if (pend.drafts)     console.log(`  ${pend.drafts} drafted repl(y/ies) to approve   -> node cli.js review`);
  if (pend.review)     console.log(`  ${pend.review} repl(y/ies) need a human look    -> node cli.js review`);
  console.log(`  ${pend.excl} businesses on the exclusion list\n`);
}

function review() {
  const drafts = db.prepare('SELECT * FROM leads WHERE suggested_reply IS NOT NULL ORDER BY last_inbound_at DESC').all();
  const others = db.prepare(`
    SELECT * FROM leads
    WHERE status IN ('needs_review','replied','confirmed') AND suggested_reply IS NULL
    ORDER BY last_inbound_at DESC LIMIT 30
  `).all();

  if (!drafts.length && !others.length) return console.log('\n  nothing to review\n');

  if (drafts.length) {
    console.log('\n  === drafted replies awaiting approval ===');
    for (const r of drafts) {
      console.log(`\n  [${r.id}] ${r.brand_name}${r.contact_name ? ` (${r.contact_name})` : ''} — ${r.stage}`);
      console.log(`      they said: ${JSON.stringify((r.last_inbound ?? '').slice(0, 130))}`);
      console.log(`      draft:     ${JSON.stringify(r.suggested_reply)}`);
      console.log(`      send:      node cli.js reply --id=${r.id}`);
    }
  }

  if (others.length) {
    console.log('\n  === other replies ===');
    for (const r of others) {
      console.log(`\n  [${r.id}] ${r.brand_name}${r.contact_name ? ` (${r.contact_name})` : ''} — ${r.status}${r.stage ? `/${r.stage}` : ''}`);
      console.log(`      they said: ${JSON.stringify((r.last_inbound ?? '').slice(0, 130))}`);
    }
  }
  console.log(`\n  reply by hand:  node cli.js reply --id=N --text="..."\n`);
}

function sweep() {
  const days = num('days', 5);
  const info = db.prepare(`
    UPDATE leads SET status = 'no_answer'
    WHERE status = 'opener_sent' AND last_inbound_at IS NULL
      AND opener_sent_at < datetime('now', ?)
  `).run(`-${days} days`);
  console.log(`[sweep] ${info.changes} lead(s) with no reply in ${days} days -> no_answer`);
}

const HELP = `
  scrape-and-messenger — Impact Innovations Media

  pipeline
    node cli.js scrape    [--target=N] [--query="..."] [--headless]
    node cli.js pipeline  [--limit=50] [--no-qualify]   enrich websites + qualify
    node cli.js qualify   [--limit=50]                  qualify already-enriched leads
    node cli.js export    [--tier=outreach_ready|verification|all] [--csv]
    node cli.js contacts  [--tier=outreach_ready]       .vcf for Google Contacts

  outreach — manual, nothing connects to WhatsApp
    node cli.js board     [--no-open]                   spreadsheet UI (or run leads.bat)
    node cli.js queue     [--limit=N] [--no-open]       terminal version of the board
    node cli.js pitch                                   pitch the confirmed, same way
    node cli.js find      "brand or number"             look up a lead id
    node cli.js reply-to  --id=N "what they said"       log a reply, get the next message

  outreach — automated (ban risk; opt in explicitly)
    node cli.js send --auto [--dry-run] [--limit=N]
    node cli.js listen    [--no-auto-pitch]
    node cli.js pitch --auto
    node cli.js reply     --id=N [--text="..."]

  exclusions
    node cli.js exclude   --file=path.txt               import a contacted list
    node cli.js exclude   --name="Brand" [--reason=...] add one
    node cli.js exclude   --apply                       re-apply list to stored leads
    node cli.js exclude   --backfill                     add every already-contacted lead
                                                          in this db to the list (run once
                                                          after upgrading, protects past sends)

  inspect
    node cli.js stats | review | show --id=N
    node cli.js classify "their reply"
    node cli.js sweep     [--days=5]
    node cli.js mark      --id=N --status=S

  daily:  scrape -> pipeline -> contacts -> queue
`;

switch (cmd) {
  case 'scrape': {
    const q = opt('query');
    const s = await scrape({
      queries: q ? [q] : undefined,
      target: num('target'),
      headless: flag('headless') ? true : undefined,
    });
    console.log(`\n[scrape] added ${s.added}, excluded ${s.excluded}, duplicates ${s.duplicates}, no phone ${s.noPhone}, failed ${s.failed}, seen ${s.seen}`);
    break;
  }

  case 'pipeline':
    await runPipeline({ limit: num('limit', 50), qualify: !flag('no-qualify'), headless: !flag('show-browser') });
    break;

  case 'qualify':
    await runQualifyOnly({ limit: num('limit', 50) });
    break;

  case 'export':
    (flag('csv') ? exportCsv : exportLeads)({ tier: opt('tier', 'outreach_ready') });
    break;

  case 'contacts':
    exportContacts({ tier: opt('tier', 'outreach_ready'), status: opt('status') });
    break;

  case 'board': {
    const limit = num('limit');
    if (limit && limit > 0) {
      setBatchSize(limit);

      // "How many leads do you want today" means today, not "of what's
      // already sitting in the db" -- top up with a live scrape when short.
      // countUnsentWorkable() applies the same landline/rejected filter the
      // board uses, and ignores awaiting-reply rows -- those sit until they
      // respond and must not shrink the "how many new openers do I need" quota.
      let workable = countUnsentWorkable(db);
      const shortfall = limit - workable;

      if (shortfall > 0) {
        console.log(`\n  ${workable} workable lead(s) ready, ${limit} requested -- scraping ${shortfall} more first.`);
        console.log('  A Chrome window will open; leave it alone until it closes.\n');
        const s = await scrape({ target: shortfall });
        console.log(`[scrape] added ${s.added}, excluded ${s.excluded}, duplicates ${s.duplicates}, no phone ${s.noPhone}, failed ${s.failed}, seen ${s.seen}`);

        if (s.added > 0) {
          console.log('\n  Enriching the new leads...\n');
          await runPipeline({ limit: s.added, qualify: qualifierAvailable() });
        }

        // Re-count after enrichment (a site wa.me number can rescue a landline,
        // or qualification can reject a lead outright) and say plainly if the
        // requested count still was not met -- silently opening the board with
        // fewer leads than asked for is exactly what was broken before.
        workable = countUnsentWorkable(db);
        if (workable < limit) {
          const totalQueries = (config.scrape.niches?.length ?? 0) * (config.scrape.cities?.length ?? 0);
          console.log(`\n  ⚠ COULD NOT REACH ${limit} LEADS.`);
          console.log(`     ${workable} workable lead(s) available -- ${limit - workable} short of what you asked for.`);
          console.log(`     Ran all ${totalQueries} configured niche x city searches; most of what they return`);
          console.log('     is already in the database or unreachable on WhatsApp (landlines).');
          console.log('     Add more niches/cities to config.json -> scrape, or work with a smaller batch.\n');
        } else {
          console.log(`\n  ${workable} workable lead(s) ready -- target met.\n`);
        }
      }
    }
    startServer({ open: !flag('no-open') });
    break;
  }

  case 'queue':
    await runQueue({ limit: num('limit'), noOpen: flag('no-open') });
    break;

  case 'reply-to':
    await handlePastedReply(num('id'), argv.slice(1).filter((a) => !a.startsWith('--')).join(' '), { noOpen: flag('no-open') });
    break;

  case 'find':
    findLead(argv.slice(1).filter((a) => !a.startsWith('--')).join(' '));
    break;

  case 'send':
    if (!flag('auto')) {
      console.log('\n  `send` automates WhatsApp and carries ban risk.');
      console.log('  Use `node cli.js queue` for the manual flow (pre-filled, you press send).');
      console.log('  If you really want automated sending: node cli.js send --auto\n');
      break;
    }
    await runSend({ dryRun: flag('dry-run'), limit: num('limit'), force: flag('force') });
    break;

  case 'listen':
    await runListen({ autoPitch: !flag('no-auto-pitch') });
    break;

  case 'pitch':
    if (flag('auto')) await runPitchQueue();
    else await runPitchManual({ noOpen: flag('no-open') });
    break;

  case 'reply':
    await runSendReply(num('id'), opt('text'));
    break;

  case 'exclude': {
    if (flag('backfill')) { backfillContactedExclusions(); break; }
    if (opt('file')) importExclusions(opt('file'), opt('reason', 'contacted'));
    else if (opt('name')) {
      addExclusion({ name: opt('name'), phone: opt('phone'), domain: opt('domain'), reason: opt('reason', 'contacted') });
      console.log(`[exclusions] added ${opt('name')}`);
    } else if (!flag('apply')) {
      console.log('  need --file=, --name=, --apply or --backfill');
      break;
    }
    if (flag('apply') || opt('file') || opt('name')) applyExclusionsToExisting();
    break;
  }

  case 'import': {
    const file = opt('file');
    if (!file) {
      console.log('  usage: node cli.js import --file=path.txt');
      console.log('  format, one lead per line: Business Name, Phone, Category (optional), Website (optional)');
      break;
    }
    const r = importPastedLeads(readFileSync(file, 'utf8'));
    console.log(`[import] added ${r.added}, duplicates ${r.duplicates}, excluded ${r.excluded}, invalid ${r.invalid}`);
    for (const l of r.invalidLines) console.log(`  ! ${l.reason}: ${JSON.stringify(l.line)}`);
    break;
  }

  case 'show': {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(num('id'));
    if (!lead) { console.log('  no such lead'); break; }
    console.log(`\n${formatLead(lead)}\n`);
    console.log(`Tier: ${lead.tier ?? 'not qualified'} — ${lead.tier_reason ?? ''}`);
    console.log(`Status: ${lead.status}\n`);
    break;
  }

  case 'classify': {
    const { classifyInbound, classifyAfterPitch, classifierMode } = await import('./src/classify.js');
    const text = argv.slice(1).filter((a) => !a.startsWith('--')).join(' ');
    if (!text) { console.log('  usage: node cli.js classify "their reply" [--post]'); break; }
    console.log(`  classifier: ${classifierMode()}`);
    const r = flag('post')
      ? await classifyAfterPitch(text)
      : await classifyInbound(text, { brand_name: opt('brand', 'Total Skin and Body') });
    console.log(`  ${JSON.stringify(text)} -> ${r.label}  [${r.via}]`);
    break;
  }

  case 'stats':  stats(); break;
  case 'review': review(); break;
  case 'sweep':  sweep(); break;

  case 'mark': {
    const id = num('id'), status = opt('status');
    if (!id || !status) { console.log('  need --id= and --status='); break; }
    db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, id);
    console.log(`  lead ${id} -> ${status}`);
    break;
  }

  case 'preview': {
    for (const l of db.prepare("SELECT * FROM leads WHERE status='new' LIMIT 10").all()) {
      console.log(`  ${l.phone}  ${renderOpener(l)}`);
    }
    break;
  }

  default: console.log(HELP);
}
