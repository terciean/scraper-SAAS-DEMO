import { chromium } from 'playwright';
import { config } from './config.js';
import './migrate.js';
import { db } from './db.js';
import { enrichWebsite } from './enrich/website.js';
import { qualifyLead, qualifierAvailable } from './qualify.js';
import { normalisePhone, phoneType, whatsAppLikelihood } from './phone.js';
import { getBroker } from './brokers.js';
import { pushLead } from './dcsagoli.js';

const now = () => new Date().toISOString();

function saveEnrichment(lead, web) {
  if (web.error) {
    db.prepare('UPDATE leads SET enrich_error = ?, enriched_at = ? WHERE id = ?')
      .run(web.error, now(), lead.id);
    return;
  }

  // A wa.me link on the site is a better contact route than the Maps number:
  // it is the number the business actually wants WhatsApp traffic on, and Maps
  // very often lists a landline that WhatsApp cannot reach at all.
  const siteWa = web.whatsapp_link ? normalisePhone(web.whatsapp_link) : null;
  const target = siteWa || lead.phone;

  db.prepare(`
    UPDATE leads SET
      domain = ?, platform = ?, has_meta_pixel = ?, has_ecommerce = ?,
      price_min = ?, price_max = ?, price_samples = ?, socials = ?,
      whatsapp_phone = ?, phone_type = ?, wa_likelihood = ?,
      enriched_at = ?, enrich_error = NULL
    WHERE id = ?
  `).run(
    web.domain, web.platform, web.has_meta_pixel, web.has_ecommerce,
    web.price_min, web.price_max, JSON.stringify(web.price_samples ?? []),
    JSON.stringify(web.socials ?? {}),
    siteWa && siteWa !== lead.phone ? siteWa : null,
    phoneType(target), whatsAppLikelihood(target),
    now(), lead.id,
  );
}

function saveQualification(lead, q) {
  db.prepare(`
    UPDATE leads SET
      tier = ?, tier_reason = ?, category = COALESCE(?, category),
      business_type = ?,
      owner_name = ?, decision_access = ?, aov_estimate = ?,
      commerce_signal = ?, growth_signal = ?, fb_ads_angle = ?,
      web_seo_angle = ?, affordability = ?, cautions = ?, qualified_at = ?
    WHERE id = ?
  `).run(
    q.tier, q.tier_reason, q.category || null, q.business_type, q.owner_name, q.decision_access,
    q.aov_estimate, q.commerce_signal, q.growth_signal, q.fb_ads_angle,
    q.web_seo_angle, q.affordability, q.cautions, now(), lead.id,
  );
}

/**
 * Enrich (and optionally qualify) leads that have not been through the pipeline.
 * Enrichment is network-bound so it runs concurrently; qualification is an LLM
 * call per lead and runs serially after, to keep spend visible and ordered.
 */
export async function runPipeline({ limit = 50, qualify = true, headless = true, brokerId } = {}) {
  // brokerId omitted (cli.js's own usage) -> unscoped, unchanged from before.
  // brokerId given (a broker's own on-demand scrape-then-enrich cycle) ->
  // only touch that broker's own freshly-scraped rows, so it can't
  // accidentally consume enrichment work queued by a different broker's
  // concurrent scrape.
  const scopeClause = brokerId != null ? 'AND assigned_broker_id = ?' : '';
  const args = brokerId != null ? [brokerId, limit] : [limit];
  const leads = db.prepare(`
    SELECT * FROM leads
    WHERE status = 'new' AND enriched_at IS NULL ${scopeClause}
    ORDER BY id LIMIT ?
  `).all(...args);

  if (!leads.length) {
    console.log('[pipeline] nothing to enrich. Run `node cli.js scrape` first.');
    return;
  }

  console.log(`[pipeline] enriching ${leads.length} lead(s)`);

  const enriched = new Map();
  const report = (lead, web) => console.log(web.error
    ? `  - ${lead.brand_name}: ${web.error}`
    : `  + ${lead.brand_name}: ${web.platform}, prices ${web.price_min ?? '?'}-${web.price_max ?? '?'}, pixel ${web.has_meta_pixel ? 'yes' : 'no'}`);

  // Pass 1: plain fetch, concurrent. Fast, and handles most sites.
  const failed = [];
  const queue = [...leads];
  await Promise.all(Array.from({ length: Math.max(1, config.enrich.concurrency) }, async () => {
    while (queue.length) {
      const lead = queue.shift();
      if (!lead.website) {
        db.prepare('UPDATE leads SET enrich_error = ?, enriched_at = ? WHERE id = ?')
          .run('no website listed', now(), lead.id);
        console.log(`  - ${lead.brand_name}: no website`);
        continue;
      }
      const web = await enrichWebsite(lead.website);
      if (web.error) { failed.push(lead); continue; }
      saveEnrichment(lead, web);
      enriched.set(lead.id, web);
      report(lead, web);
    }
  }));

  // Pass 2: the failures go through a real browser, serially -- one shared page
  // cannot be driven concurrently. 403s and TLS-fussy hosts usually recover here.
  if (failed.length && config.enrich.useBrowserFallback) {
    console.log(`  … retrying ${failed.length} failed site(s) through a browser`);
    const browser = await chromium.launch({ headless });
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    for (const lead of failed) {
      const web = await enrichWebsite(lead.website, { page });
      saveEnrichment(lead, web);
      if (!web.error) enriched.set(lead.id, web);
      report(lead, web);
    }
    await browser.close();
  } else {
    for (const lead of failed) {
      const web = await enrichWebsite(lead.website);
      saveEnrichment(lead, web);
      report(lead, web);
    }
  }

  if (!qualify) return;
  if (!qualifierAvailable()) {
    console.log('\n[pipeline] `claude` CLI not found on PATH -- skipping qualification.');
    console.log('           Leads are enriched; install/sign in to Claude Code, then run `node cli.js qualify`.');
    return;
  }

  console.log(`\n[pipeline] qualifying ${leads.length} lead(s) with ${config.models.qualify.provider}:${config.models.qualify.model}`);
  const counts = {};
  for (const lead of leads) {
    const fresh = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
    try {
      const q = await qualifyLead(fresh, enriched.get(lead.id) ?? null);
      if (!q) { console.log(`  ? ${lead.brand_name}: no structured output`); continue; }
      saveQualification(fresh, q);
      counts[q.tier] = (counts[q.tier] ?? 0) + 1;
      console.log(`  ${q.tier === 'outreach_ready' ? '*' : ' '} ${lead.brand_name}: ${q.tier} — ${q.tier_reason.slice(0, 90)}`);

      // Funnel into dcsagoli, if this broker has it configured -- fire and
      // log, never lets a CRM push failure interrupt qualification itself.
      if (fresh.assigned_broker_id != null) {
        const broker = getBroker(fresh.assigned_broker_id);
        await pushLead({ ...fresh, ...q, qualified_at: now() }, broker);
      }
    } catch (err) {
      console.log(`  ! ${lead.brand_name}: ${err.message.slice(0, 100)}`);
    }
  }
  console.log(`\n[pipeline] ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing qualified'}`);
}

/** Qualify leads that are already enriched but not yet tiered. */
export async function runQualifyOnly({ limit = 50, brokerId } = {}) {
  if (!qualifierAvailable()) {
    console.log('[qualify] `claude` CLI not found on PATH.');
    return;
  }
  const scopeClause = brokerId != null ? 'AND assigned_broker_id = ?' : '';
  const args = brokerId != null ? [brokerId, limit] : [limit];
  const leads = db.prepare(`
    SELECT * FROM leads WHERE enriched_at IS NOT NULL AND tier IS NULL ${scopeClause} ORDER BY id LIMIT ?
  `).all(...args);

  if (!leads.length) return console.log('[qualify] nothing waiting.');
  console.log(`[qualify] ${leads.length} lead(s) with ${config.models.qualify.provider}:${config.models.qualify.model}`);

  for (const lead of leads) {
    try {
      const q = await qualifyLead(lead, null);
      if (!q) continue;
      saveQualification(lead, q);
      console.log(`  ${q.tier === 'outreach_ready' ? '*' : ' '} ${lead.brand_name}: ${q.tier}`);
    } catch (err) {
      console.log(`  ! ${lead.brand_name}: ${err.message.slice(0, 100)}`);
    }
  }
}
