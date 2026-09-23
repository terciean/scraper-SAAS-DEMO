import { config } from '../config.js';
import '../migrate.js';
import { db, logMessage, setStatus, leadByPhone } from '../db.js';
import { renderPitch, extractContactName, suggestReply } from '../templates.js';
import { classifyInbound, classifyAfterPitch, classifierMode } from '../classify.js';
import { fromWhatsAppId, toWhatsAppId } from '../phone.js';
import { markContacted } from '../exclusions.js';
import { createClient, startClient } from './client.js';

const rand = ([lo, hi]) => lo + Math.random() * (hi - lo);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const now = () => new Date().toISOString();

async function sendPitch(client, chatId, lead, contactName) {
  const body = renderPitch({ ...lead, contactName });
  // Typing immediately after their reply reads as a bot; wait a beat.
  await sleep(rand(config.send.pitchDelaySeconds) * 1000);
  try {
    const chat = await client.getChatById(chatId);
    await chat.sendStateTyping();
    await sleep(Math.min(body.length * 30, 9000));
  } catch { /* typing state is cosmetic */ }

  await client.sendMessage(chatId, body);
  setStatus(lead.id, 'pitch_sent', { pitch_sent_at: now() });
  markContacted(lead);
  logMessage(lead.id, 'out', body);
  return body;
}

async function handle(msg, client, { autoPitch }) {
  if (msg.fromMe) return;
  if (msg.from.endsWith('@g.us') || msg.from === 'status@broadcast') return;

  const phone = fromWhatsAppId(msg.from);
  const lead = leadByPhone(phone);
  if (!lead) return; // not one of ours -- never auto-reply to strangers

  const text = msg.body || '';
  logMessage(lead.id, 'in', text);

  const inboundCount = (lead.inbound_count ?? 0) + 1;
  const name = lead.contact_name ?? extractContactName(text);

  setStatus(lead.id, lead.status, {
    last_inbound_at: now(),
    last_inbound: text,
    inbound_count: inboundCount,
    contact_name: name,
  });

  console.log(`\n[in] ${lead.brand_name} (${phone}): ${JSON.stringify(text.slice(0, 140))}`);
  if (name && !lead.contact_name) console.log(`     contact name: ${name}`);

  // ---- already pitched: this is a live conversation ----
  if (lead.status === 'pitch_sent' || lead.status === 'replied') {
    const { label: stage, via } = await classifyAfterPitch(text);
    const draft = suggestReply(stage, { contactName: name });

    setStatus(lead.id, 'replied', {
      last_inbound_at: now(),
      last_inbound: text,
      inbound_count: inboundCount,
      contact_name: name,
      stage,
      suggested_reply: draft,
    });

    console.log(`     -> ${stage}  [${via}]`);
    if (draft) {
      console.log(`     draft ready: ${JSON.stringify(draft.slice(0, 90))}`);
      if (config.send.autoReplyPostPitch) {
        await sleep(rand(config.send.pitchDelaySeconds) * 1000);
        await client.sendMessage(msg.from, draft);
        logMessage(lead.id, 'out', draft);
        setStatus(lead.id, 'replied', { suggested_reply: null });
        console.log('     -> draft auto-sent');
      } else {
        console.log('     approve with:  node cli.js reply --id=' + lead.id);
      }
    } else {
      console.log('     needs a human reply');
    }
    return;
  }

  if (lead.status !== 'opener_sent') {
    console.log(`     -> status is ${lead.status}, ignoring`);
    return;
  }

  // ---- reply to the opener ----
  const { label: verdict, via } = await classifyInbound(text, lead);
  console.log(`     -> ${verdict}  [${via}]`);

  // A second unprompted inbound before we have replied is the autoresponder
  // tell -- Zuri Ayurveda did exactly this an hour after its first message.
  if (verdict !== 'confirmed' || inboundCount > 1) {
    if (inboundCount > 1 && verdict === 'confirmed') {
      setStatus(lead.id, 'bot_autoresponder', {
        notes: 'second unprompted inbound before any reply',
        inbound_count: inboundCount,
      });
      console.log('     -> reclassified bot_autoresponder (unprompted follow-up)');
      return;
    }
    setStatus(lead.id, verdict, {
      last_inbound_at: now(), last_inbound: text, contact_name: name, inbound_count: inboundCount,
    });
    return;
  }

  setStatus(lead.id, 'confirmed', {
    confirmed_at: now(), last_inbound_at: now(), last_inbound: text,
    contact_name: name, inbound_count: inboundCount,
  });

  if (!autoPitch) {
    console.log('     -> confirmed. Queued (node cli.js pitch) .');
    return;
  }

  try {
    await sendPitch(client, msg.from, lead, name);
    console.log(`     -> pitch sent${name ? ` (addressed to ${name})` : ''}`);
  } catch (err) {
    setStatus(lead.id, 'pitch_failed', { notes: err.message });
    console.log(`     ! pitch failed: ${err.message}`);
  }
}

export async function runListen({ autoPitch = true } = {}) {
  console.log(`[listen] auto-pitch on confirmation: ${autoPitch ? 'ON' : 'OFF (approval queue)'}`);
  console.log(`[listen] post-pitch auto-reply: ${config.send.autoReplyPostPitch ? 'ON' : 'OFF (drafts queued for approval)'}`);
  console.log(`[listen] reply classifier: ${classifierMode()}`);

  const client = createClient();
  await startClient(client, {
    onReady: () => console.log('[listen] watching for replies. Ctrl+C to stop.'),
    onMessage: (msg, c) => handle(msg, c, { autoPitch })
      .catch((e) => console.error('[listen] handler error:', e.message)),
  });
}

/**
 * Pitch everyone sitting in `confirmed` -- the approval path, and the catch-up
 * for anyone who confirmed while the listener was offline.
 */
export async function runPitchQueue() {
  const pending = db.prepare("SELECT * FROM leads WHERE status = 'confirmed' ORDER BY confirmed_at").all();
  if (!pending.length) {
    console.log('[pitch] nobody waiting in confirmed.');
    return;
  }
  console.log(`[pitch] ${pending.length} confirmed lead(s) awaiting the pitch`);

  const client = createClient();
  await startClient(client, {
    onReady: async () => {
      for (const lead of pending) {
        try {
          await sendPitch(client, toWhatsAppId(lead.phone), lead, lead.contact_name);
          console.log(`  > pitched ${lead.brand_name}${lead.contact_name ? ` (${lead.contact_name})` : ''}`);
        } catch (err) {
          setStatus(lead.id, 'pitch_failed', { notes: err.message });
          console.log(`  ! ${lead.brand_name}: ${err.message}`);
        }
        await sleep(rand(config.send.intervalSecondsBetweenMessages) * 1000);
      }
      await client.destroy();
      process.exit(0);
    },
  });
}

/** Send an approved draft reply to one lead. */
export async function runSendReply(leadId, overrideText = null) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) return console.log(`[reply] no lead ${leadId}`);

  const body = overrideText ?? lead.suggested_reply;
  if (!body) return console.log(`[reply] lead ${leadId} has no drafted reply. Pass --text="..."`);

  console.log(`[reply] to ${lead.brand_name}: ${JSON.stringify(body)}`);

  const client = createClient();
  await startClient(client, {
    onReady: async () => {
      try {
        await client.sendMessage(toWhatsAppId(lead.phone), body);
        logMessage(lead.id, 'out', body);
        setStatus(lead.id, 'replied', { suggested_reply: null });
        console.log('[reply] sent');
      } catch (err) {
        console.log(`[reply] failed: ${err.message}`);
      }
      await client.destroy();
      process.exit(0);
    },
  });
}
