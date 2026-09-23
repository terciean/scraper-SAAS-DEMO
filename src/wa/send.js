import { config } from '../config.js';
import { db, logMessage, setStatus, sentToday, firstSendDate } from '../db.js';
import { renderOpener } from '../templates.js';
import { toWhatsAppId } from '../phone.js';
import { markContacted } from '../exclusions.js';
import { createClient, startClient } from './client.js';

const rand = ([lo, hi]) => lo + Math.random() * (hi - lo);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ramp the cap over the first weeks. A brand-new number that fires 60 cold
// messages on day one is the single most reliable way to get banned.
export function todaysCap() {
  const { dailyCap, warmup } = config.send;
  if (!warmup?.enabled) return dailyCap;

  const first = firstSendDate();
  if (!first) return Math.min(warmup.startCap, dailyCap);

  const days = Math.floor((Date.now() - new Date(`${first}T00:00:00`)) / 86_400_000);
  return Math.min(dailyCap, warmup.startCap + warmup.incrementPerDay * days);
}

/**
 * Circuit breaker. Bans follow from recipients reacting badly, not from volume
 * alone -- opt-outs and wrong numbers are the signals that precede a block or a
 * report. This halts the run before the account pays for a bad lead batch.
 */
export function safetyCheck() {
  const s = config.send.safety;
  if (!s?.enabled) return { ok: true };

  const today = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'opted_out')    AS optouts,
      COUNT(*) FILTER (WHERE status = 'wrong_number') AS wrong
    FROM leads WHERE date(opener_sent_at) = date('now','localtime')
  `).get();

  if (today.optouts >= s.maxOptOutsPerDay) {
    return { ok: false, why: `${today.optouts} opt-out(s) today (limit ${s.maxOptOutsPerDay}). Stopping to protect the number.` };
  }
  if (today.wrong >= s.maxWrongNumbersPerDay) {
    return { ok: false, why: `${today.wrong} wrong number(s) today (limit ${s.maxWrongNumbersPerDay}). Lead data looks bad -- stopping.` };
  }

  // Rolling quality check over the most recent sends.
  const recent = db.prepare(`
    SELECT status FROM leads
    WHERE opener_sent_at IS NOT NULL
    ORDER BY opener_sent_at DESC LIMIT ?
  `).all(s.rollingWindow);

  if (recent.length >= s.rollingWindow) {
    const bad = recent.filter((r) => ['opted_out', 'wrong_number', 'no_whatsapp'].includes(r.status)).length;
    const rate = bad / recent.length;
    if (rate > s.maxNegativeRate) {
      return {
        ok: false,
        why: `${Math.round(rate * 100)}% of the last ${recent.length} sends went bad (limit ${Math.round(s.maxNegativeRate * 100)}%). Fix lead quality before sending more.`,
      };
    }
  }

  return { ok: true };
}

export function inSendWindow(now = new Date()) {
  const { sendWindow, sendDays } = config.send;
  if (sendDays?.length && !sendDays.includes(now.getDay())) {
    return { ok: false, why: `${now.toDateString()} is not a configured send day` };
  }
  const h = now.getHours();
  if (h < sendWindow.startHour || h >= sendWindow.endHour) {
    return { ok: false, why: `outside send window ${sendWindow.startHour}:00-${sendWindow.endHour}:00 (now ${h}:00)` };
  }
  return { ok: true };
}

export async function runSend({ dryRun = false, limit = null, force = false } = {}) {
  const win = inSendWindow();
  if (!win.ok && !force && !dryRun) {
    console.log(`[send] halted: ${win.why}. Use --force to override.`);
    return;
  }

  const safe = safetyCheck();
  if (!safe.ok && !dryRun) {
    console.log(`\n[send] HALTED BY SAFETY CHECK: ${safe.why}`);
    console.log('       Review with `node cli.js review`, then re-run.');
    console.log('       Override only if you know why: set send.safety.enabled=false in config.json\n');
    return;
  }

  const cap = todaysCap();
  const already = sentToday();
  let budget = Math.max(0, cap - already);
  if (limit !== null) budget = Math.min(budget, limit);

  console.log(`[send] cap today ${cap}, already sent ${already}, budget ${budget}`);
  if (budget === 0) return;

  // Only message leads the qualification pass cleared. The brief is explicit
  // that unverified leads belong in Verification, not in outreach.
  const onlyTier = config.send.onlyTier;
  // Saved contacts flag as spam far less than cold numbers, so by default only
  // leads that have been through `cli.js contacts` are eligible.
  const needContact = config.send.safety?.requireContactsExported;
  const contactClause = needContact ? 'AND contact_exported_at IS NOT NULL' : '';

  const leads = onlyTier
    ? db.prepare(`SELECT * FROM leads WHERE status = 'new' AND tier = ? ${contactClause} ORDER BY id LIMIT ?`).all(onlyTier, budget)
    : db.prepare(`SELECT * FROM leads WHERE status = 'new' ${contactClause} ORDER BY id LIMIT ?`).all(budget);

  if (!leads.length) {
    const d = db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE tier IS NULL)                                    AS unqualified,
        COUNT(*) FILTER (WHERE tier = ? AND contact_exported_at IS NULL)        AS unsaved
      FROM leads WHERE status = 'new'
    `).get(onlyTier);

    console.log(`[send] nothing eligible to send.`);
    if (d.unqualified) console.log(`       ${d.unqualified} lead(s) not qualified yet   -> node cli.js pipeline`);
    if (d.unsaved)     console.log(`       ${d.unsaved} qualified lead(s) not saved as contacts -> node cli.js contacts, then import the .vcf`);
    return;
  }

  if (dryRun) {
    for (const lead of leads) console.log(`  -> ${lead.phone}  ${renderOpener(lead)}`);
    console.log(`\n[dry-run] ${leads.length} openers previewed, nothing sent.`);
    return;
  }

  const client = createClient();
  let sent = 0;

  await startClient(client, {
    onReady: async () => {
      for (const lead of leads) {
        if (!inSendWindow().ok && !force) {
          console.log('[send] send window closed mid-run, stopping.');
          break;
        }

        const waId = toWhatsAppId(lead.phone);

        try {
          const registered = await client.isRegisteredUser(waId);
          if (!registered) {
            setStatus(lead.id, 'no_whatsapp');
            console.log(`  x ${lead.brand_name} — ${lead.phone} not on WhatsApp`);
            continue;
          }

          const body = renderOpener(lead);
          await client.sendMessage(waId, body);

          setStatus(lead.id, 'opener_sent', { opener_sent_at: new Date().toISOString() });
          markContacted(lead);
          logMessage(lead.id, 'out', body);
          sent += 1;
          console.log(`  > ${lead.brand_name} — ${lead.phone}  (${sent}/${leads.length})`);
        } catch (err) {
          setStatus(lead.id, 'send_failed', { notes: err.message });
          console.log(`  ! ${lead.brand_name} — ${err.message}`);
        }

        const waitMs = rand(config.send.intervalSecondsBetweenMessages) * 1000;
        console.log(`    next in ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
      }

      console.log(`\n[send] done: ${sent} openers sent.`);
      await client.destroy();
      process.exit(0);
    },
  });
}
