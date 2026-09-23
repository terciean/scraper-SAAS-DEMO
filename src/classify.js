import { config } from './config.js';
import { callModel, modelAvailable } from './llm.js';
import {
  classifyReply as regexOpener,
  classifyPostPitch as regexPostPitch,
  renderOpener,
} from './templates.js';

const OPENER_LABELS = ['confirmed', 'wrong_number', 'opted_out', 'bot_autoresponder', 'needs_review'];
const POST_LABELS = ['meeting_request', 'requested_info', 'referred_decision_maker', 'asking_proof', 'asking_speciality', 'has_agency', 'not_interested', 'bot_autoresponder', 'needs_review'];

// Few-shots are verbatim replies from real outreach, which is why they cover
// things a generic prompt would miss: Afrikaans/Zulu affirmatives, receptionist
// scripts that confirm while asking for your name, and product chatbots.
const OPENER_SYSTEM = `You classify replies to a cold WhatsApp message sent to South African
health, wellness, beauty and aesthetics businesses. The message asked:
"Hi there, is this the right contact for <Brand>?"

Labels:

confirmed          They confirm it is the business, OR they respond as the business
                   (a greeting plus "how can I help?", a receptionist asking for your
                   name, an owner introducing themselves), OR they ask who is messaging
                   or what it is about. All of these mean it is safe to introduce
                   ourselves. Affirmatives may be English, Afrikaans or Zulu:
                   yes, ja, yebo, korrek, sharp, speaking, that's us.
wrong_number       Not this business, they do not know it, it closed, or wrong number.
opted_out          Asks to stop, says not interested, objects to being messaged,
                   threatens to report or block, or is hostile.
bot_autoresponder  An automated agent, chatbot, or out-of-office rather than a person.
                   Tells: offers product help unprompted, says a representative or the
                   team will respond, sends unprompted follow-ups, or reads as a script.
needs_review       Anything else: unclear, off-topic, or a bare greeting with no signal.

Examples:
"Hi \\n\\nYes" -> confirmed
"Hi yes it is, how can i help?" -> confirmed
"Good day. This is Natasha Aitken Aesthetics Clinic for Weightloss. Please may we get your name so we can save you." -> confirmed
"Yes it is. It's Lalla here. How can I assist Tristan?" -> confirmed
"Hello! Yes, you've reached Z U R I. I'm here to help you with our Ayurvedic hair care products or any questions about your hair journey." -> bot_autoresponder
"Thanks for getting in touch! I'll ask a representative to respond." -> bot_autoresponder
"Sorry, wrong number" -> wrong_number
"Not interested thanks" -> opted_out
"Hi" -> needs_review

Reply with the single label word and nothing else.`;

const POST_SYSTEM = `You classify replies that arrive AFTER a sales pitch was sent on WhatsApp.
The pitch introduced Tristan Lindsay of Impact Innovations Media, cited R5 million in
Facebook ad sales for a similar health/wellness business, and asked for a quick conversation.

Labels:

meeting_request    Open to talking, proposes or accepts a time, asks for a call.
requested_info     Requests a summary, background, breakdown, criteria or more details
                   before deciding whether to speak.
referred_decision_maker  Says to contact an owner, boss, director or manager, provides
                   their details, or says the message will be forwarded to them.
asking_proof       Wants to know which businesses or clients we worked with, or wants
                   results, examples or case studies.
asking_speciality  Asks what services we actually provide (Facebook ads? SEO? social?).
has_agency         Already has an agency, marketing company or in-house team.
not_interested     Declines, asks to stop, or is hostile.
bot_autoresponder  An automated agent or out-of-office rather than a person.
needs_review       Anything else.

Examples:
"Hi can we maybe chat on Monday ?" -> meeting_request
"Yes we can talk" -> meeting_request
"Can you give me a short summary or background first?" -> requested_info
"You can speak directly with the owner. Here is her email." -> referred_decision_maker
"I am sharing this with my boss and will revert" -> referred_decision_maker
"Thank you so much for reaching out. May I ask which business you worked with?" -> asking_proof
"I'm not familiar with these brands. May I ask what you specialize in? Seo, above the line marketing, social media?" -> asking_speciality
"We are currently working with a marketing company, but let me chat to the team and get back to you" -> has_agency

Reply with the single label word and nothing else.`;

export function classifierMode() {
  const spec = config.models?.classifyReply;
  return modelAvailable(spec) ? `${spec?.provider ?? 'claude'}:${spec?.model ?? 'claude-haiku-4-5-20251001'}` : 'regex';
}

async function askModel(system, userContent, labels) {
  const spec = config.models?.classifyReply;
  if (!modelAvailable(spec)) return null;

  const out = await callModel(spec, {
    system,
    prompt: userContent,
    jsonSchema: {
      type: 'object',
      properties: { label: { type: 'string', enum: labels } },
      required: ['label'],
      additionalProperties: false,
    },
  });

  return out?.label ?? null;
}

/**
 * Classify a reply to the opener. Falls back to the regex matcher on missing
 * key, API error, or unparseable output -- a classifier outage must never stop
 * the listener from recording the reply.
 */
export async function classifyInbound(text, lead) {
  if (!modelAvailable(config.models?.classifyReply)) return { label: regexOpener(text), via: 'regex' };
  try {
    const label = await askModel(
      OPENER_SYSTEM,
      `We sent: ${JSON.stringify(renderOpener(lead))}\nThey replied: ${JSON.stringify(text)}\n\nLabel:`,
      OPENER_LABELS,
    );
    return label
      ? { label, via: classifierMode() }
      : { label: regexOpener(text), via: 'regex (unparsed model output)' };
  } catch (err) {
    return { label: regexOpener(text), via: `regex (${err.message.slice(0, 60)})` };
  }
}

/** Classify a reply that arrives after the pitch. Same fallback contract. */
export async function classifyAfterPitch(text) {
  if (!modelAvailable(config.models?.classifyReply)) return { label: regexPostPitch(text), via: 'regex' };
  try {
    const label = await askModel(
      POST_SYSTEM,
      `They replied: ${JSON.stringify(text)}\n\nLabel:`,
      POST_LABELS,
    );
    return label
      ? { label, via: classifierMode() }
      : { label: regexPostPitch(text), via: 'regex (unparsed model output)' };
  } catch (err) {
    return { label: regexPostPitch(text), via: `regex (${err.message.slice(0, 60)})` };
  }
}
