# scrape and messenger — Impact Innovations Media

Google Maps lead scraper → website enrichment → LLM qualification → two-step
WhatsApp outreach, built around the schema and the real outreach transcripts.

```
scrape      Google Maps → SQLite, chains and contacted businesses filtered out
pipeline    fetch each website → prices, platform, Meta Pixel, socials, owner
            → qualify against the brief → outreach_ready | verification | rejected
contacts    .vcf of qualified leads, brand names cleaned
queue       walks you through the openers, pre-filled — you press send
reply-to    paste in what they said → classified → hands you the next message
```

**Sending is manual by default.** Nothing connects to WhatsApp unless you
explicitly opt into the `--auto` commands.

---

## ⚠️ Manual steps — nothing else is left

Everything else is built and tested. These need you:

**1. Nothing to add — no API key needed**

Qualification and reply classification call the `claude` CLI directly (the
same Claude Code you're already signed into), using Haiku, instead of the
Anthropic API. There's no `ANTHROPIC_API_KEY` and no `.env` to set up. If
`claude` is ever missing from PATH: enrichment still runs, qualification is
skipped, and reply classification falls back to the regex matcher.

**2. Paste your contacted/exclusion list**

`data/exclusions-seed.txt` is seeded with the 13 businesses from your lead
history. Your message referencing the full list got cut off before the list
itself — add the rest, one per line, then:

```
node cli.js exclude --file=data/exclusions-seed.txt
```

**3. Nothing to link**

The default flow never connects to WhatsApp — you send from your own account.
Only the `--auto` commands need a QR scan, and you don't need them.

**4. Import contacts to your phone — this one is not optional**

```
node cli.js contacts
```

Import the `.vcf` at contacts.google.com → Import, let your phone sync.

`send` will refuse to message a lead that hasn't been through this step.
WhatsApp treats messages to non-contacts as considerably more spam-like, so
saving the number first is one of the few real protections available.

---

## Daily rhythm

**Double-click `leads.bat`.** It starts the board and opens the tab. Everything
below is the same thing from a terminal.


```
node cli.js scrape              # ~120 leads/day across 128 niche×city queries
node cli.js pipeline            # enrich + qualify
node cli.js contacts            # .vcf → import to Google Contacts
node cli.js board               # or just double-click leads.bat
```

When someone replies, paste it in:

```
node cli.js find "zero bs"                        # get the lead id
node cli.js reply-to --id=12 "Hi yes it is"       # → classifies, hands you the pitch
```

Check in with `node cli.js stats` and `node cli.js review`.

## Manual by default — why

The valuable part of this tool is finding and qualifying leads. The only part
that risks your WhatsApp account is the automated `sendMessage` call.

So `queue` walks you through the batch one lead at a time: it prints the
message, opens a `wa.me` link with the text **already in the compose box**, and
records the outcome when you say so. You press send in your own WhatsApp.

```
  ─── 1/25 ─────────────────────────────
  Zero BS Cosmetics
  +27834543940  ·  Skin care clinic

  "Hi there, is this the right contact for Zero BS Cosmetics?"

  https://wa.me/27834543940?text=Hi%20there%2C%20is%20this...

  [enter] sent  ·  s skip  ·  w wrong/bad  ·  q quit
```

Nothing connects to WhatsApp. No unofficial client, no fingerprint, no ToS
violation on the sending side. At 25 leads that is about ten minutes.

The automated path still exists behind `--auto` (`send --auto`, `pitch --auto`,
`listen`) if you ever decide the tradeoff is worth it.

## Commands

| command | what it does |
|---|---|
| `scrape [--target=N] [--query="..."]` | Maps → SQLite, deduped by phone, chains filtered |
| `pipeline [--limit=50] [--no-qualify]` | enrich websites, then qualify against the brief |
| `qualify [--limit=50]` | qualify leads already enriched |
| `export [--tier=…] [--csv]` | required-information blocks, or CSV |
| `contacts [--tier=…]` | `.vcf` with cleaned brand names |
| **`queue [--limit=N] [--no-open]`** | **openers, pre-filled — you press send** |
| **`pitch`** | **pitch the confirmed, same manual way** |
| **`find "brand or number"`** | **look up a lead id** |
| **`reply-to --id=N "what they said"`** | **log a reply, get the next message** |
| `exclude --file=… / --name=… / --apply` | manage the exclusion list |
| `show --id=N` | one lead in full schema format |
| `classify "text" [--post]` | test the classifier |
| `stats` / `review` / `sweep` / `mark` | pipeline state and manual fixes |

Automated equivalents, off by default: `send --auto`, `pitch --auto`, `listen`,
`reply --id=N`.

## Qualification

`outreach_ready` requires all five, per the brief: viable product/service,
visible commercial pricing, a public contact route, a plausible decision-maker
route, and a realistic Facebook Ads opportunity at R10k/month. Anything missing
one goes to `verification`, never to outreach. Both `queue` and `send` refuse
anything that is not `outreach_ready`.

Chains, corporates and MLMs are filtered during the scrape (`src/exclusions.js`
→ `CHAINS`) and never even stored.

## Message flow

Opener, in your proven wording:

> Hi there, is this the right contact for **{{brand_name}}**?

When they confirm, the pitch is personalised with the name from their reply —
matching what you do by hand:

> Thank you for confirming **Natasha**, this is Tristan Lindsay from Impact Innovations Media…

**Post-pitch replies are drafted, not sent.** Meeting requests, "which business
did you work with?", "what do you specialise in?", and "we already have an
agency" each get a suggested reply drawn from what actually worked, queued in
`node cli.js review`. Booking a time needs your calendar, so a bot should not
be answering those unsupervised. Flip `send.autoReplyPostPitch` in
`config.json` if you disagree.

Autoresponders are detected and parked in `bot_autoresponder` — Zuri Ayurveda
in your history was a product chatbot that burned two messages.

## Status flow

```
new → opener_sent → confirmed → pitch_sent → replied
```

Branches: `wrong_number`, `opted_out`, `bot_autoresponder`, `needs_review`,
`no_answer`, `no_whatsapp`, `send_failed`, `excluded`.

Nothing is auto-replied to after `pitch_sent` without your approval.

## Pacing and safety — tuned for a personal number

This runs on your personal WhatsApp, so a ban costs your real chats, not just
the outreach. Defaults are set accordingly (`config.json → send`):

- `warmup` ramps **5/day, +3/day**, to a `dailyCap` of **25**
- **3–7 minutes** randomised between sends
- `sendWindow` 08:00–17:00, weekdays only
- only `outreach_ready` leads, and only ones saved as contacts

### Circuit breaker

Bans follow from recipients reacting badly, not from volume alone. `send`
halts itself when the numbers turn:

| trigger | default |
|---|---|
| opt-outs today | 2 |
| wrong numbers today | 4 |
| bad outcomes in the last 30 sends | 25% |

A halt means the lead batch is bad — fix quality before sending more. Check
with `node cli.js review`. It can be disabled via `send.safety.enabled`, but
it exists because it is cheaper to stop a run than to lose the account.

### About the 100/day target

Scraping 100+/day is easy and the scraper does it. **Sending** 100 cold
messages a day from a personal number is the single most reliable way to lose
it, which is why the send cap starts at 5 and tops out at 25. The scrape and
send volumes are deliberately decoupled: build the qualified list fast, drip
the outreach slowly. Raising `dailyCap` is one line, and it is your call —
just raise it after the warmup has run clean for a couple of weeks, not before.

## Tests

```
npm test
```

Fixtures in `test/fixtures.test.js` are verbatim replies from your real
transcripts — they are the regression suite for the classifier and the name
extractor.

## Known risk (only if you use `--auto`)

`whatsapp-web.js` drives a real linked WhatsApp session. Unsolicited bulk
outreach is against WhatsApp's Business Messaging Policy, and numbers that send
cold messages at volume do get banned — appeals rarely succeed and the number
is usually gone for good.

On a personal number that means losing your real chats too. The mitigations
built in — warmup, long randomised gaps, contacts-first, qualified-only, and
the circuit breaker — reduce the odds; they do not remove them.

**The default `queue` flow avoids this entirely**, because you are the one
pressing send. What remains is ordinary outreach risk: if enough recipients
block or report you, the account is still at risk — but that is true of manual
outreach by anyone, and your own numbers so far are 8 contacted, 0 reports.
Stop immediately if anyone says they reported or blocked you.

## The lead board (`leads.bat`)

Double-click `leads.bat`. A tab opens at `localhost:5173` with the batch of 40
as a spreadsheet. Per row:

| column | what it does |
|---|---|
| **Contact** | downloads that lead's `.vcf` — open it to add the contact |
| **Opener** | opens WhatsApp Web with *"Hi there, is this the right contact for X?"* already typed. Press send. |
| **Their name** | type the name from their reply; the pitch personalises to it |
| **Pitch** | opens WhatsApp Web with the full pitch typed. Press send. |
| **Status** | not started → awaiting reply → ✓ contacted |

Once both buttons are used the row is struck through and greyed for the rest of
the day. **Save all contacts** at the top grabs the whole batch as one `.vcf`.

### Numbers WhatsApp can't reach

Most Google Maps listings are landlines, and WhatsApp cannot message those —
roughly 6 in 10 scraped numbers. The board handles this:

- enrichment prefers a `wa.me` number found on the business's own website over
  the Maps listing (marked **SITE**), which rescues leads whose listed number is
  a dead 086/021 line
- numbers that are still not mobile are badged **LANDLINE** or **UNSURE** and
  sorted to the bottom, so you never waste a click discovering it

A browser cannot write to your phone's contacts — no web API exists for it.
The `.vcf` download is the closest possible: open the file and the contact is
added, which is also what makes WhatsApp show the brand name.
