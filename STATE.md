# Current state — 22 Sep 2026

Snapshot of exactly where this project stands right now. Supersedes the
19 Sep snapshot in full — a lot changed since then, including real usage and
a separate AI's changes to this repo. Re-run the checks below rather than
trust this file blindly once more time has passed.

## This is no longer "nothing sent" — real messages have gone out

Unlike the 19 Sep snapshot, **this tool has been used for real**:

    openers ever sent ... 14
    pitches ever sent .... 5
    messages logged ..... 19
    contacts exported .... 9

That happened through the manual board (`leads.bat` → click Opener/Pitch →
press send in your own WhatsApp) — still nothing automated ever touched
WhatsApp itself.

## What changed since 19 Sep (another AI's work)

A separate AI session worked on this repo between 19 and 22 Sep and made
real, substantive changes:

- **`src/cliModel.js` (new)** — qualification and reply classification now
  shell out to the `claude` CLI (`spawnSync('claude', [...])`) instead of the
  Anthropic SDK. No `ANTHROPIC_API_KEY` is needed any more; it rides on
  whatever `claude` session is already authenticated on this machine. Verified
  working (tested live, ~6s per call — slow but functional).
- **`config.json` → `models.qualify`** was changed from `claude-opus-5` to
  `claude-haiku-4-5-20251001`. Cheaper and faster, but a real quality tradeoff
  for R10k/month lead-scoring — worth deciding deliberately, not by default.
- **`leads.bat`** now prompts "How many leads do you want to work today?" and
  passes `--limit=N` to `node cli.js board`.
- **The board UI** gained a **"+ Get new leads"** button (scrapes live from
  inside the browser tab, polls a job status) and a **"No reply"** checkbox
  column (`no_response` — a pure manual tag, doesn't touch pipeline logic).

## Bugs found and fixed this session (22 Sep)

You reported two things. Both were real, both are fixed and verified:

**1. "Click 30, get 3."** `cli.js`'s `board --limit=N` computed how many more
leads to scrape by counting raw `new`/`opener_sent`/`confirmed` rows — with no
check for whether WhatsApp can actually reach them. `server.js`'s board
already filtered those same rows down to reachable ones before displaying
them. The two counts disagreed: on the real database, the naive count said
29 "workable" leads existed when only **15** actually were (the rest were
landlines or rejected-tier). Asking for 30 meant scraping for `30 − 29 = 1`
more, while the board would only ever be able to show ~16.

Fixed by extracting one shared filter, `src/leadFilters.js` → `isWorkable()` /
`countWorkable()`, imported by both `cli.js` and `server.js` — they can't
drift apart again because there's only one definition now.

**2. Silent partial success / no failure signal.** Neither the `board`
command nor the "+ Get new leads" button ever checked whether a scrape
actually met what was asked for. A shortfall was reported exactly like full
success — `added 3 new lead(s)` — with nothing flagging that 3 was way under
the ask. Fixed: `scrape()` now returns `metTarget`/`queriesExhausted`; the
`board` command prints a `⚠ COULD NOT REACH N LEADS` block naming the actual
shortfall when the target isn't hit; the button-triggered job gets a
`shortfall: true` flag that the UI shows as a **persistent banner** (not a
toast — a toast disappearing in 2.6s is exactly the kind of thing that let
this go unnoticed) until you dismiss it or a later scrape succeeds clean.

**3. "This UI lies" / wanting to resend openers.** Once Opener or Pitch was
clicked, the button became permanently disabled ("✓ sent") with no way to
reopen WhatsApp for that lead again — so if the tab opened wrong, you never
actually pressed send, or you want to send it again, the board gave no way
back in. Fixed: both buttons stay clickable forever. First click sets the
real status/timestamp (counts toward today's cap, as before). Every click
after that reopens WhatsApp with the same message and logs it, but does not
touch the status or the original timestamp — so resending is honest: the
board's counts don't quietly inflate, and it never claims something happened
that didn't. The name field for Pitch also stays editable after sending, so a
typo'd name can be corrected and the corrected pitch resent. Verified live via
the API: `resent: false` on first send, `resent: true` after; `opener_sent_at`
unchanged across three resends; pitch text picked up a corrected name on
resend while `pitch_sent_at` stayed fixed.

All three verified against the real database and a live server, not just
read. `npm test` still 6/6.

## Database — `data/leads.db`

    35 leads total
       20  new
        9  opener_sent      -- sent, waiting on a reply
        5  pitch_sent       -- pitched
        1  excluded         -- national chain

    reachability (updated after the 22 Sep pipeline run)
       15  yes              mobile numbers
       13  no                landline / 086 -- filtered out of the board entirely
        1  maybe             ambiguous prefix
        6  (unenriched)      no website, or the website fetch failed -- still qualified on Maps data alone

    qualification -- everything is now tiered, nothing left pending
       28  verification
        6  rejected
        0  outreach_ready    -- see "Update" below, this is expected, not broken

    14  exclusions           8 contacted (from your lead history) + 5 clients + 1 leftover test entry
     9  contacts exported

Two leads still carry a WhatsApp number recovered from their own website
because the Maps listing was a dead landline (unchanged from 19 Sep — Manna
Health Products, Zero BS Cosmetics). More may have joined since; check
`whatsapp_phone IS NOT NULL` if it matters.

## Nothing is running

Server stopped, port 5173 free, WAL checkpointed into `leads.db`. Nothing
runs on a schedule — no daemon, no cron. It stays exactly as described here
until a command is run.

## Update — later same day (22 Sep)

Ran the full pipeline on everything that was waiting: enriched the 10
unenriched leads, then qualified all 19 leads that had no tier yet (10 fresh +
9 already-enriched leftovers — more had piled up than the morning snapshot
showed). **Every lead now has a tier. Nothing is left in limbo.**

    28  verification
     6  rejected           (2 more than before -- both national chains, correctly caught)
     0  outreach_ready

Worth being direct about that last line: **zero of the 34 qualified leads
reached `outreach_ready`.** Not a bug — every single one is missing at least
one of the five required things (usually a verified WhatsApp contact or a
named owner/decision-maker), so Haiku correctly parked all of them in
`verification` rather than padding the outreach list. That's the qualifier
doing its job, but it does mean the board is currently full of "needs a human
look" leads, not "ready to message" ones — `send.onlyTier: outreach_ready`
means the automated path would refuse to send to any of them (as designed);
the manual board still shows and lets you message `verification`-tier leads,
since `isWorkable()` only excludes `rejected`, not `verification`.

**Model stays on Haiku, confirmed** — `config.json → models.qualify` is
untouched at `claude-haiku-4-5-20251001`, not Opus 5. Cost note from this
run: ~34s and one Haiku call per lead qualified; 19 leads this session, so
budget accordingly for future batches.

**Resend confirmed live, twice** — once via direct API calls, once again
against a fresh, previously-untouched lead through the actually-running
board: click 1 sent for real (`resent:false`, counted toward today's cap and
the daily-send number), clicks 2 and 3 reopened WhatsApp with the identical
message (`resent:true`) without moving the original timestamp or inflating
any count. Three messages logged in the audit trail, one fixed send time.
Test lead was reset to untouched afterward — no real data left in a fake
"sent" state.

## What is still waiting on you

1. **The rest of the exclusion list** — never arrived (message was cut off on
   19 Sep). `data/exclusions-seed.txt` still only has the 13 recovered from
   your transcripts.
2. **34 `verification`-tier leads need a human look** before you'd call them
   outreach-ready — check `node cli.js review` or `node cli.js show --id=N`
   for what's specifically missing on each (usually: no WhatsApp number found,
   no owner name). None of them are wrong to have in the board; they're just
   not pre-vetted the way `outreach_ready` would be.

## Verified working (this session)

- The shared `isWorkable` count fix — matches server.js exactly, tested
  against the live DB (29 naive vs 15 real)
- `scrape()`'s `metTarget`/`queriesExhausted` fields — forced a real shortfall
  with an impossible query and confirmed the fields come back correct
- Resend on both Opener and Pitch — full request/response cycle tested live,
  including the corrected-name-on-resend case
- The `claude`-CLI-routed classifier (`src/classify.js`) — one live call,
  correct label, ~6s
- 6/6 fixture tests, including every real transcript reply

## Also verified this session: qualification itself

`qualifyLead()` (the CLI-routed path) was spot-tested live against a synthetic
lead — correct schema back, sensible reasoning, correctly flagged the landline
contact issue as a caution. **~34 seconds per lead** — budget for that when
running a full batch (e.g. 12 unqualified leads ≈ 7 minutes).

## Still never executed end to end

- A full multi-lead `node cli.js qualify` batch run (only one single-lead
  spot-test so far, not a real batch)
- Any automated (`--auto`) WhatsApp send or the `listen` daemon — still
  untouched, still behind explicit flags
