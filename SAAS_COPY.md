# SaaS development copy

This folder is the SaaS development fork of the personal lead board. The
personal repository must remain unchanged while product work happens here.

## Onboarding a new dev (local demo)

```
git clone <this repo>
cd "scrape and messenger - SaaS copy"
npm install                       # Chrome download for Puppeteer is skipped
                                   # by .puppeteerrc.cjs -- see comment there
npx playwright install chromium   # only the scraper/enrichment browser needs this
npm test                          # 10/10 should pass on a clean checkout
node cli.js stats                 # creates data/leads.db fresh, 0 leads
node cli.js board --no-open       # http://localhost:5173, board starts empty
```

Everything under `data/` (the SQLite DB, WhatsApp session, browser profile)
and `results/` (real WhatsApp screenshots from prior live testing) is
gitignored — a fresh clone starts with **zero leads and zero conversation
history**, which is what you want for a demo. `node cli.js board` creates
`data/` on its own now (previously it would crash on a fresh clone because
the directory didn't exist and SQLite can't create a missing parent dir —
fixed in `src/db.js`).

To actually demo the board with something in it, either paste a few test
leads through the UI's "paste leads" box / `node cli.js import`, or point
`node cli.js scrape` at a throwaway query. Sending is manual-by-default
(`wa.me` links you press send on yourself) — the `--auto` WhatsApp path needs
a real Chrome install and a QR-code login, skip that for a demo.

Requires Node **22.5+** (uses the built-in `node:sqlite`, no dependency).

## Bug fixed in this fork: leads contacted twice

Nothing that scraped or pasted a lead ever recorded that it had actually been
*messaged* — `src/exclusions.js`'s `checkExcluded()` gate (checked on every
scrape/paste) only ever looked at the manually-imported exclusion list. The
`leads.phone` UNIQUE constraint caught an exact repeat of the identical Maps
listing, but Google Maps often carries more than one listing for the same
real business (branches, call-tracking numbers, a re-crawled listing with a
reformatted number) — those have a *different* phone number, so the UNIQUE
constraint never caught them, and the same business could come back in as a
brand-new "new" lead and get an opener sent a second time.

Fixed with `markContacted()` (`src/exclusions.js`), called at every point a
message actually goes out for the first time (board, terminal queue,
automated `send`/`listen`) — it adds the lead to the exclusion list by name
and domain, not just phone, so a re-discovered duplicate is caught the same
way an already-known contacted business is. `node cli.js exclude --backfill`
back-fills this for a database that already had sends go out before the fix
(run once after pulling this change into a database with real history; a
fresh demo database has nothing to back-fill).

## Implemented in the fork

- Website enrichment discovers public Facebook, Instagram, LinkedIn company,
  TikTok and WhatsApp links published by the business itself.
- Qualification stores a stable `business_type`: `ecommerce_product`,
  `clinic_service`, `retailer_wholesaler`, or `other_service`.
- Pitch rendering selects product-sales copy, clinic-bookings copy, or a
  decision-maker-routing message. No hand-written observation is required.
- Post-pitch classification recognizes requests for information and referrals
  to an owner/director, and proposes replies that answer the prospect before
  attempting to book a call.
- Meeting handoff identifies Jaden as the strategy lead instead of saying
  "supervisor".

## Lead-source plan

1. Keep pasted/CSV imports and the existing local Maps browser source behind a
   common provider interface.
2. Treat a business's own website as the first-party discovery source for its
   public social URLs. This is what the current enrichment implements.
3. Add provider adapters for licensed/official Facebook, Instagram, LinkedIn
   and places data. Do not make the SaaS depend on logged-in social-network DOM
   scraping; it is brittle, difficult to scale, and couples all customers to
   one account/IP reputation.
4. Store provenance for every discovered value: source provider, source URL,
   observed timestamp and tenant/job identifier.
5. Deduplicate in this order: canonical phone, normalized domain, social
   profile URL, then provider-specific place/profile ID.
6. Run discovery as queued jobs with per-tenant budgets and idempotency keys.

Suggested source contract:

```js
discover({ tenantId, query, location, cursor })
// -> { leads, nextCursor, usage: { requests, providerCost } }
```

Each lead should carry `source`, `source_id`, `source_url`, `observed_at`,
`facebook_url`, `instagram_url`, `linkedin_url`, `website`, and normalized
contact data.

## Before shipping

This was intentionally made as a direct repository copy. It therefore contains
the personal SQLite database and browser profile. Never distribute those files.
Create clean development fixtures, move secrets and browser state outside the
application package, and add `tenant_id` isolation before onboarding anyone.

## What "SaaS ready for brokers, integrated into another system" actually needs

This is still a single-tenant, single-operator desktop tool wearing a web UI.
Concretely, in the order they'd bite:

1. **Everything is one SQLite file with no tenant column.** `src/db.js` opens
   one hardcoded `data/leads.db`. `leads`, `messages`, `exclusions` have no
   `tenant_id`/`broker_id` anywhere in the schema (`src/migrate.js`). Multiple
   brokers today means multiple full copies of this repo, not multiple rows —
   there is no isolation between two brokers' leads, exclusion lists, or
   conversation history short of running separate processes on separate
   machines.
2. **No auth on the board.** `src/server.js` binds an unauthenticated HTTP
   server to `localhost:5173`. Every `/api/*` route trusts whoever can reach
   the port. Fine on a laptop; not fine the moment this is reachable by more
   than one person or hosted anywhere.
3. **Outreach is tied to one human's personal WhatsApp.** The core send path
   is `wa.me` deep links the operator clicks themselves (`src/queue.js`), and
   the `--auto` path (`src/wa/send.js`, `src/wa/listen.js`) drives one
   `whatsapp-web.js` session against one linked phone number via a QR scan —
   see the ban-risk section in README.md. A real multi-broker product needs
   the WhatsApp Business Platform (Cloud API), one number/session per broker
   tenant, not N brokers sharing a risk of a single number getting banned or
   N brokers each running their own copy of this repo.
4. **Business identity and templates live in one shared `config.json`.** The
   pitch copy, sender name ("Tristan Lindsay"), proof/case-study clients, and
   send-safety numbers are all one flat file, not per-tenant data. A broker
   onboarding today would be editing your production config by hand.
5. **Scraping is DOM automation against Google Maps** (`src/scrape/googlemaps.js`,
   Playwright driving a real browser). It works for one operator's volume; it
   is not something to run concurrently per-tenant at scale — same IP/account
   reputation risk the lead-source plan above already calls out. The
   provider-adapter plan in this doc (licensed Maps/Places/social APIs) is the
   real fix, not scaling this scraper up.
6. **In-memory, single-process job state.** `src/server.js`'s `scrapeJob`
   is one module-level variable — a second concurrent scrape (from a second
   tenant, or a second tab) silently collides with the first. Any
   multi-tenant deployment needs that moved to per-tenant persisted job state.
7. **Qualification and reply classification shell out to a local `claude` CLI**
   (`src/cliModel.js`, `spawnSync('claude', …)`), riding on whatever session
   is authenticated on the machine running it. That is not a deployable
   server-side dependency — a hosted SaaS needs the Anthropic API directly
   (an API key per environment, not a logged-in CLI session on the host).
8. **"Integrated into another system"** — there is no outbound webhook, no
   public API, no event stream. Anything downstream today would have to poll
   the SQLite file directly. A stable API surface (leads, statuses, messages)
   is undesigned so far; start from the `discover()` provider contract above
   as the shape to mirror on the way out, not just the way in.

None of this is a small patch — it's the difference between "a personal tool
one more person could run a copy of" (what a `git clone` + the onboarding
steps above gets you today) and "a hosted product multiple brokers log into."
Sequence it roughly in the order above: tenant isolation and auth block
everything else; the WhatsApp platform migration and the licensed lead-source
adapters are the two genuinely large pieces of net-new work.
