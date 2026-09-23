import { db } from './db.js';

// Additive migration: new columns for the qualification schema. Runs on every
// import; ALTER TABLE ADD COLUMN throws if the column exists, so we check first.
const existing = new Set(db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name));

const COLUMNS = {
  // enrichment (scraped from the website)
  domain:            'TEXT',
  platform:          'TEXT',    // shopify / woocommerce / wix / squarespace / unknown
  has_meta_pixel:    'INTEGER', // already advertising on Meta -- strongest signal
  has_ecommerce:     'INTEGER',
  price_min:         'REAL',
  price_max:         'REAL',
  price_samples:     'TEXT',    // JSON array of observed prices
  socials:           'TEXT',    // JSON {instagram, facebook, tiktok}
  owner_name:        'TEXT',
  owner_source:      'TEXT',
  enriched_at:       'TEXT',
  enrich_error:      'TEXT',

  // qualification (judged from the enriched data)
  tier:              'TEXT',    // outreach_ready | verification | rejected
  tier_reason:       'TEXT',
  aov_estimate:      'TEXT',
  commerce_signal:   'TEXT',
  growth_signal:     'TEXT',
  fb_ads_angle:      'TEXT',
  web_seo_angle:     'TEXT',
  affordability:     'TEXT',
  cautions:          'TEXT',
  decision_access:   'TEXT',
  source_urls:       'TEXT',
  qualified_at:      'TEXT',
  business_type:     'TEXT',    // ecommerce_product | clinic_service | retailer_wholesaler | other_service

  // conversation
  contact_name:      'TEXT',    // first name they gave, used to personalise the pitch
  stage:             'TEXT',    // post-pitch stage: meeting_request, asking_proof, ...
  suggested_reply:   'TEXT',    // drafted reply awaiting approval
  inbound_count:     'INTEGER', // unprompted repeat inbounds flag an autoresponder

  phone_type:        'TEXT',    // MOBILE / FIXED_LINE / UAN ... landlines are not on WhatsApp
  whatsapp_phone:    'TEXT',    // wa.me number found on the site; beats the Maps listing
  wa_likelihood:     'TEXT',    // yes | maybe | no

  contact_exported_at: 'TEXT',  // saved to a .vcf; messaging a saved contact flags less

  // exclusion
  excluded_reason:   'TEXT',

  // manual tracking — your own call, doesn't drive any pipeline logic
  no_response:       'INTEGER', // 1 = you've marked this as a no/no-reply, toggle any time
};

let added = 0;
for (const [name, type] of Object.entries(COLUMNS)) {
  if (existing.has(name)) continue;
  db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${type}`);
  added += 1;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS exclusions (
    id          INTEGER PRIMARY KEY,
    name_key    TEXT UNIQUE,
    raw_name    TEXT,
    phone       TEXT,
    domain      TEXT,
    reason      TEXT NOT NULL DEFAULT 'contacted',
    added_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_excl_phone  ON exclusions(phone);
  CREATE INDEX IF NOT EXISTS idx_excl_domain ON exclusions(domain);
`);

if (added) console.log(`[migrate] added ${added} column(s)`);
export const migrated = true;
