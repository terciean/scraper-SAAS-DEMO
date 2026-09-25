import { config } from './config.js';
import { callModel, modelAvailable } from './llm.js';
import { getBroker, underQualifyCap, logQualification } from './brokers.js';

const QUALIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    tier: { type: 'string', enum: ['outreach_ready', 'verification', 'rejected'] },
    business_type: { type: 'string', enum: ['ecommerce_product', 'clinic_service', 'retailer_wholesaler', 'other_service'] },
    tier_reason: { type: 'string' },
    category: { type: 'string' },
    owner_name: { type: 'string' },
    decision_access: { type: 'string' },
    aov_estimate: { type: 'string' },
    commerce_signal: { type: 'string' },
    growth_signal: { type: 'string' },
    fb_ads_angle: { type: 'string' },
    web_seo_angle: { type: 'string' },
    affordability: { type: 'string' },
    cautions: { type: 'string' },
  },
  required: [
    'tier', 'business_type', 'tier_reason', 'category', 'owner_name', 'decision_access',
    'aov_estimate', 'commerce_signal', 'growth_signal', 'fb_ads_angle',
    'web_seo_angle', 'affordability', 'cautions',
  ],
  additionalProperties: false,
};

const SYSTEM = `You qualify South African leads for Impact Innovations Media, an agency
selling Facebook Ads management at a minimum of R10,000/month. Website design and SEO are
secondary services, relevant only after a Facebook Ads fit is established.

You are given public evidence scraped from Google Maps and the business's own website.
Judge only from that evidence. Never invent a fact, a name, a price or a contact route.
Where the evidence does not support a field, say "not established from public evidence".

TARGET: small-to-medium, owner-led South African businesses in health, wellness, beauty,
skincare, haircare, supplements, aesthetics, fitness and adjacent categories. Products or
services above R40, ideally with items or bundles in the R300-R2,000+ range. Ecommerce or
high-ticket service businesses are the strongest fits.

STRONGEST PROSPECT TYPES: supplements/wellness products, skincare brands, hair-growth and
haircare brands, natural health products, aesthetic clinics, beauty clinics,
weight-management businesses, premium wellness services, health-product ecommerce, and
brands selling bundles, subscriptions or repeat-purchase products.

REJECT outright: large national chains, major corporations, businesses routed through a
call centre or generic customer support, extremely low AOV with no bundle or repeat-purchase
economics, pre-launch businesses, and businesses with no functioning commercial offer.

TIER RULES - assign "outreach_ready" ONLY when all five hold on the evidence:
  1. a viable product or service
  2. commercial pricing that is actually visible
  3. a public contact route
  4. a plausible decision-maker or owner access route
  5. a realistic Facebook Ads opportunity at R10k/month

If pricing, WhatsApp/contact, or decision-maker access cannot be verified, the tier is
"verification" - not "outreach_ready". Do not pad the outreach list; "verification" is the
correct and expected answer for a large share of leads.
Use "rejected" for anything in the REJECT set above.

BUSINESS TYPE - always choose exactly one:
  ecommerce_product     a product brand or ecommerce business selling online
  clinic_service        a clinic, aesthetics practice, coach or appointment-led service
  retailer_wholesaler   a shop, branch, reseller or wholesaler where the contact may be staff
  other_service         another service business that does not fit the clinic group

This classification controls outreach wording. Base it on the actual offer and sales model,
not merely the Maps category. A clinic with a small product shelf is still clinic_service;
an online supplement brand is ecommerce_product.

A Meta Pixel on the site means they already advertise on Meta - that raises affordability
confidence and changes the Facebook Ads angle from "start" to "improve/scale".

The agency's proof point, usable as the relevance hook:
"We've generated over R5 million in sales through Facebook advertising for a business in
the same health/wellness industry."

Keep every field to one or two plain sentences. No marketing language.`;

function evidence(lead, web) {
  const money = (web?.price_samples ?? []).slice(0, 25);
  return [
    `BUSINESS: ${lead.brand_name}`,
    `MAPS CATEGORY: ${lead.category ?? 'unknown'}`,
    `LOCATION: ${lead.address ?? 'unknown'}`,
    `MAPS RATING: ${lead.rating ?? 'n/a'} from ${lead.reviews ?? 0} reviews`,
    `LISTED PHONE: ${lead.phone}`,
    `WEBSITE: ${web?.final_url ?? lead.website ?? 'none'}`,
    web ? `WHATSAPP LINK ON SITE: ${web.whatsapp_link ?? 'none found'}` : '',
    web ? `ECOMMERCE PLATFORM: ${web.platform}` : '',
    web ? `META PIXEL PRESENT: ${web.has_meta_pixel ? 'yes' : 'no'}` : '',
    web ? `ANALYTICS/GOOGLE TAGS: ${web.has_google_ads ? 'yes' : 'no'}` : '',
    web ? `CART/CHECKOUT PRESENT: ${web.has_ecommerce ? 'yes' : 'no'}` : '',
    web ? `BUNDLES/COMBOS MENTIONED: ${web.has_bundles ? 'yes' : 'no'}` : '',
    web ? `SUBSCRIPTION MENTIONED: ${web.has_subscription ? 'yes' : 'no'}` : '',
    web ? `OBSERVED PRICES (ZAR): ${money.length ? money.join(', ') : 'none found'}` : '',
    web ? `SOCIALS: ${JSON.stringify(web.socials ?? {})}` : '',
    web?.home_text ? `\nHOME PAGE TEXT:\n${web.home_text}` : '',
    web?.about_text ? `\nABOUT PAGE TEXT:\n${web.about_text}` : '',
    !web ? '\nNOTE: the website could not be fetched. Judge on the Maps data alone and prefer "verification".' : '',
  ].filter(Boolean).join('\n');
}

export function qualifierAvailable() {
  return modelAvailable(config.models?.qualify);
}

/**
 * Qualify one enriched lead against the brief. Returns null when unavailable
 * -- either no qualifier configured, or (for a broker's own lead) that
 * broker has hit their monthly qualification cap. Either way the lead just
 * stays unqualified; pipeline.js already treats a null result as "nothing
 * to save", not an error.
 */
export async function qualifyLead(lead, web) {
  if (!qualifierAvailable()) return null;

  // Only a broker-owned lead is capped -- the operator's own legacy pool
  // (assigned_broker_id IS NULL) is unscoped everywhere else, same here.
  if (lead.assigned_broker_id != null) {
    const broker = getBroker(lead.assigned_broker_id);
    if (!broker || !underQualifyCap(broker)) return null;
  }

  const result = await callModel(config.models?.qualify, {
    system: SYSTEM,
    prompt: evidence(lead, web),
    jsonSchema: QUALIFICATION_SCHEMA,
  });

  if (lead.assigned_broker_id != null) logQualification(lead.assigned_broker_id);
  return result;
}
