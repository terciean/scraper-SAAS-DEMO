import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
import './migrate.js';
import { db } from './db.js';
import { cleanBrandName } from './templates.js';

const dash = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

function priceLine(lead) {
  if (lead.price_min == null) return '—';
  const samples = JSON.parse(lead.price_samples || '[]');
  const range = lead.price_min === lead.price_max
    ? `R${lead.price_min}`
    : `R${lead.price_min} – R${lead.price_max}`;
  return samples.length > 2 ? `${range} (${samples.length} observed)` : range;
}

function sourceUrls(lead) {
  const urls = [];
  if (lead.website) urls.push(lead.website);
  const s = JSON.parse(lead.socials || '{}');
  for (const v of Object.values(s)) if (v) urls.push(v);
  urls.push(`https://www.google.com/maps/search/${encodeURIComponent(lead.brand_name)}`);
  return urls.join('\n  ');
}

/** One lead rendered in the brief's required-information block. */
export function formatLead(lead) {
  return [
    `Business: ${cleanBrandName(lead.brand_name)}`,
    `Category: ${dash(lead.category)}`,
    `Location: ${dash(lead.address)}`,
    `Website: ${dash(lead.website)}`,
    `WhatsApp / public contact: ${dash(lead.phone)}`,
    `Owner / founder / decision maker: ${dash(lead.owner_name)}`,
    `Decision-maker access quality: ${dash(lead.decision_access)}`,
    `Product/service prices: ${priceLine(lead)}`,
    `Approximate AOV or price range: ${dash(lead.aov_estimate)}`,
    `Commerce signal: ${dash(lead.commerce_signal)}`,
    `Marketing/growth signal: ${dash(lead.growth_signal)}`,
    `Facebook Ads angle: ${dash(lead.fb_ads_angle)}`,
    `Website + SEO angle: ${dash(lead.web_seo_angle)}`,
    `Why it could afford R10k+: ${dash(lead.affordability)}`,
    `Cautions: ${dash(lead.cautions)}`,
    `Source URLs:\n  ${sourceUrls(lead)}`,
  ].join('\n');
}

export function exportLeads({ tier = 'outreach_ready', out = null } = {}) {
  const rows = tier === 'all'
    ? db.prepare("SELECT * FROM leads WHERE status != 'excluded' ORDER BY id").all()
    : db.prepare('SELECT * FROM leads WHERE tier = ? ORDER BY id').all(tier);

  if (!rows.length) {
    console.log(`[export] no leads with tier=${tier}`);
    return null;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const path = out ?? join(ROOT, 'data', `leads-${tier}-${stamp}.md`);

  const header = [
    `# ${tier === 'outreach_ready' ? 'Outreach-ready leads' : tier === 'verification' ? 'Verification queue' : 'Leads'} — ${stamp}`,
    '',
    `${rows.length} ${rows.length === 1 ? 'lead' : 'leads'}.`,
    '',
  ].join('\n');

  const body = rows.map((l) => `---\n\n${formatLead(l)}\n`).join('\n');
  writeFileSync(path, `${header}${body}`, 'utf8');

  console.log(`[export] ${rows.length} lead(s) -> ${path}`);
  return path;
}

/** CSV for a spreadsheet, one row per lead. */
export function exportCsv({ tier = 'outreach_ready', out = null } = {}) {
  const rows = tier === 'all'
    ? db.prepare("SELECT * FROM leads WHERE status != 'excluded' ORDER BY id").all()
    : db.prepare('SELECT * FROM leads WHERE tier = ? ORDER BY id').all(tier);

  if (!rows.length) {
    console.log(`[export] no leads with tier=${tier}`);
    return null;
  }

  const cols = [
    'id', 'brand_name', 'category', 'address', 'website', 'phone', 'owner_name',
    'decision_access', 'aov_estimate', 'commerce_signal', 'growth_signal',
    'fb_ads_angle', 'web_seo_angle', 'affordability', 'cautions',
    'tier', 'tier_reason', 'platform', 'has_meta_pixel', 'price_min', 'price_max', 'status',
  ];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');

  const stamp = new Date().toISOString().slice(0, 10);
  const path = out ?? join(ROOT, 'data', `leads-${tier}-${stamp}.csv`);
  writeFileSync(path, csv, 'utf8');

  console.log(`[export] ${rows.length} lead(s) -> ${path}`);
  return path;
}
