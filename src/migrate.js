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

  -- Durable identity + last-known WhatsApp connection outcome for a broker.
  -- The live connection itself (current status, in-flight QR) is NOT stored
  -- here -- it only exists while the process driving it is running, so it
  -- lives in src/wa/sessionManager.js's in-memory map, same precedent as
  -- server.js's single in-memory scrapeJob. This table is what survives a
  -- restart: who the broker is, and what they were last known to be at.
  CREATE TABLE IF NOT EXISTS brokers (
    id                INTEGER PRIMARY KEY,
    name              TEXT NOT NULL,
    email             TEXT,
    wa_status         TEXT NOT NULL DEFAULT 'disconnected',
    wa_phone          TEXT,
    wa_connected_at   TEXT,
    wa_last_error     TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Login sessions, persisted (not in-memory) so a server restart doesn't log
  -- every broker out -- unlike WhatsApp connection state, that would be a
  -- real regression for something as cheap as a session row.
  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    broker_id   INTEGER NOT NULL REFERENCES brokers(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL
  );
`);

// brokers already existed on disk before login was added, so its own new
// column needs the same additive ALTER-TABLE treatment as `leads` above.
const brokerColumns = new Set(db.prepare('PRAGMA table_info(brokers)').all().map((c) => c.name));
if (!brokerColumns.has('password_hash')) {
  db.exec('ALTER TABLE brokers ADD COLUMN password_hash TEXT');
  added += 1;
}

// email is the login identifier now -- partial index so multiple NULL emails
// (there shouldn't be any going forward, but don't break on old rows) don't
// collide, only real ones need to be unique.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_brokers_email ON brokers(email) WHERE email IS NOT NULL');

if (added) console.log(`[migrate] added ${added} column(s)`);
export const migrated = true;
