import { config } from './config.js';
import { cleanBrandName } from './templates.js';
import { bestPhone } from './phone.js';

/**
 * Pushes one qualified lead into dcsagoli's CRM via its ingest-business-lead
 * edge function -- an additional funnel into an existing system, never a
 * replacement for this app's own board/leads table. Fire-and-log: a broker
 * with no dcsagoli_key configured is silently skipped (the feature simply
 * doesn't apply to them yet, same pattern as niches/cities/caps), and a
 * failed push is logged but never throws into the caller -- this must not
 * be able to break qualification for anyone.
 */
export async function pushLead(lead, broker) {
  if (!broker?.dcsagoli_key) return { skipped: true };
  if (!config.dcsagoli?.ingestUrl) return { skipped: true };

  const notesParts = [
    lead.tier ? `Tier: ${lead.tier}` : null,
    lead.business_type ? `Type: ${lead.business_type}` : null,
    lead.website ? `Website: ${lead.website}` : null,
    lead.source_query ? `Found via: "${lead.source_query}"` : null,
  ].filter(Boolean);

  const payload = {
    integration_key: broker.dcsagoli_key,
    source: 'google_maps_scraper',
    external_lead_id: `scraper-${lead.id}`,
    full_name: cleanBrandName(lead.brand_name),
    phone: bestPhone(lead),
    lead_source: 'Google Maps scraper',
    product_interest: lead.category || null,
    notes: notesParts.join('\n') || null,
    form_reporting: {
      tier: lead.tier,
      tier_reason: lead.tier_reason,
      business_type: lead.business_type,
      website: lead.website,
      whatsapp_phone: lead.whatsapp_phone,
      source_query: lead.source_query,
      qualified_at: lead.qualified_at,
    },
  };

  try {
    const res = await fetch(config.dcsagoli.ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log(`  [dcsagoli] push failed for lead ${lead.id}: ${res.status} ${body.error ?? ''}`);
      return { ok: false, status: res.status, error: body.error };
    }
    return { ok: true, status: body.status };
  } catch (err) {
    console.log(`  [dcsagoli] push failed for lead ${lead.id}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
