import { config } from './config.js';

// Maps listings carry legal/branch cruft that reads wrong in a first message:
// "Vital Health Foods (Pty) Ltd - Sandton Branch" -> "Vital Health Foods"
export function cleanBrandName(raw) {
  let n = String(raw || '').trim();
  // "- Sandton Branch", "- Branch", "- Canal Walk Store": allow a location name
  // between the dash and the branch keyword. The dash must be surrounded by
  // spaces, or a hyphenated name loses its tail ("Derma-Lab ... Shop" -> "Derma").
  n = n.replace(/\s+[-–|]\s+(?:[\w&']+\s+){0,3}(branch|store|shop|outlet|head office|hq)\s*$/i, '');
  n = n.replace(/\s*\((pty)?\s*ltd\.?\)\s*/gi, ' ');
  n = n.replace(/\s*\b(pty\.?\s*ltd\.?|cc|inc\.?|ltd\.?)\b\.?\s*$/gi, '');
  n = n.replace(/\s*\([^)]*\)\s*$/, '');
  n = n.replace(/\s{2,}/g, ' ').trim();

  // Branch locations ride along on Maps names: "Wellness Warehouse Somerset Mall".
  const LOC = /\s+[A-Z][\w&']*\s+(Mall|Centre|Center|Walk|Waterfront|Square|Plaza|Crossing|Junction|Gateway|Arcade|City|Park|Village|Lifestyle)$/;
  if (LOC.test(n) && n.split(/\s+/).length >= 3) {
    const kept = n.replace(LOC, '').trim();
    const standsAlone = kept.split(/\s+/).length >= 2
      || (kept.length >= 4 && !/^(the|a|an|my|our|its)$/i.test(kept));
    if (standsAlone) n = kept;
  }

  return n.replace(/[,\-–|]+$/, '').trim() || String(raw || '').trim();
}

export function renderOpener(lead) {
  return config.templates.opener.replace(/\{\{\s*brand_name\s*\}\}/g, cleanBrandName(lead.brand_name));
}

const CLINIC_WORDS = /\b(clinic|aesthetic|medical|doctor|dr\.?|practice|therapy|therapist|coach|coaching|nutritionist|dietitian|physio|chiropr|spa|salon|treatment|wellness cent(?:re|er))\b/i;
const PRODUCT_WORDS = /\b(shop|store|e-?commerce|supplement|product|skincare|cosmetic|nutrition|botanical|herbal|vitamin|brand|manufacturer)\b/i;

/**
 * Stable pitch routing. Qualification supplies the preferred business_type,
 * while these deterministic fallbacks keep unqualified imports usable.
 */
export function selectPitchVariant(lead = {}) {
  if (lead.business_type === 'ecommerce_product') return 'product';
  if (lead.business_type === 'clinic_service') return 'clinic';
  if (lead.business_type === 'retailer_wholesaler') return 'routing';
  if (lead.business_type === 'other_service') return 'routing';

  const evidence = `${lead.brand_name ?? ''} ${lead.category ?? ''}`;
  if (CLINIC_WORDS.test(evidence)) return 'clinic';
  if (lead.has_ecommerce || ['shopify', 'woocommerce'].includes(lead.platform) || PRODUCT_WORDS.test(evidence)) return 'product';
  return 'routing';
}

// Personalise when a reply reveals a first name and select copy that matches
// the lead's selling model. No bespoke observation is required.
export function renderPitch({ contactName = null, ...lead } = {}) {
  const t = config.templates;
  const variant = selectPitchVariant(lead);
  const suffix = variant[0].toUpperCase() + variant.slice(1);
  const template = contactName
    ? (t[`pitch${suffix}Named`] ?? t.pitchNamed)
    : (t[`pitch${suffix}`] ?? t.pitch);
  return contactName ? template.replace(/\{\{\s*name\s*\}\}/g, contactName) : template;
}

const NOT_NAMES = new Set([
  'hi', 'hello', 'hey', 'good', 'day', 'morning', 'afternoon', 'evening', 'yes', 'no',
  'thanks', 'thank', 'you', 'this', 'that', 'here', 'there', 'how', 'can', 'may', 'we',
  'am', 'is', 'it', 'the', 'and', 'our', 'speaking', 'sure', 'please', 'sorry', 'ok',
  'okay', 'welcome', 'regards', 'team', 'clinic', 'wellness', 'health', 'beauty', 'skin',
  'aesthetics', 'sir', 'madam', 'maam', 'still', 'just', 'interested', 'looking',
  'reaching', 'contacting', 'enquiry',
]);

// Apostrophes may be straight or curly depending on the sender's keyboard.
const NAME_RE = [
  /my name is\s+([A-Z][a-z]{1,15})/,
  /\bit['’]?s\s+([A-Z][a-z]{1,15})\s+here\b/,
  /\bthis is\s+([A-Z][a-z]{1,15})\s+(?:here|speaking)\b/,
  /\byou['’]?re (?:speaking|chatting) (?:to|with)\s+([A-Z][a-z]{1,15})/,
  /\b(?:i['’]?m|i am)\s+([A-Z][a-z]{1,15})\b/,
  /^\s*([A-Z][a-z]{1,15})\s+here\b/,
  /\bregards,?\s+([A-Z][a-z]{1,15})\b/,
];

// The prefix must match case-insensitively (replies start sentences) but the
// captured word must still look like a name, so the capture is re-checked.
function matchName(text, re) {
  const m = text.match(new RegExp(re.source, 'i'));
  if (!m || !m[1]) return null;
  return /^[A-Z][a-z]{1,15}$/.test(m[1]) ? m[1] : null;
}

/**
 * Pull a contact's first name out of their reply, e.g.
 *   "Hi yes ... my name is Diana are you interested"  -> "Diana"
 *   "Yes it is. It's Lalla here. How can I assist"    -> "Lalla"
 * Returns null rather than risk addressing someone by a word that isn't a name.
 */
export function extractContactName(text) {
  const t = String(text || '');
  for (const re of NAME_RE) {
    const name = matchName(t, re);
    if (name && !NOT_NAMES.has(name.toLowerCase())) return name;
  }
  return null;
}

const OPT_OUT = /\b(stop|unsubscribe|remove me|take me off|not interested|no thanks|no thank you|don'?t (message|contact|whatsapp)|leave me alone|spam|report(ing)? you|fuck off|voetsek)\b/i;
const WRONG = /\b(wrong (number|person)|you'?ve got the wrong|not (us|me|them|that one)|never heard of|doesn'?t exist|no such|closed down|out of business)\b/i;
const CONFIRM = /\b(yes|yeah|yep|yup|ya|ja|yebo|correct|that'?s (right|us|correct|me)|it is|this is|speaking|sure|indeed|affirmative|confirmed?|how can i (help|assist)|how may i (help|assist)|how can we help)\b/i;
const WHO = /\b(who (is|are) (this|you|u)|who am i (speaking|chatting) (to|with)|what'?s this (about|regarding)|whats this (about|regarding))\b/i;

// Automated agents burn sends and never convert. Zuri Ayurveda in the history
// answered like a product assistant, followed up unprompted an hour later, then
// said "I'll ask a representative".
const BOT = /(i['’]?ll ask a representative|a representative will|someone will be with|this is an automated|auto-?reply|out of office|away from (?:my|the) (?:desk|phone)|our team will get back|i['’]?m here to help you with our|any questions you have about your|just checking in to see if you)/i;

// Post-pitch signals.
const MEETING = /\b(can we (maybe )?(chat|talk|speak)|we can talk|happy to (chat|talk)|give me a call|call me|book|schedule|what time|monday|tuesday|wednesday|thursday|friday|available|works for me|sounds good|yes please|interested)\b/i;
const PROOF = /\b(which business|what business|who (have|did) you work(ed)? with|which (brands?|clients?|compan(y|ies))|examples?|case stud|portfolio|proof|results|not familiar with these)\b/i;
const HAS_AGENCY = /\b(already (working|work) with|currently (working|using)|we have (a|an) (agency|marketing)|in-?house (team|marketing)|another (agency|company)|we do (our|it) (own|in-?house))\b/i;
const SPECIALITY = /(what do you speciali[sz]e|what exactly do you do|above the line|what services|\bseo\b)/i;
const INFO = /\b(short )?(summary|background|breakdown|information|info)|how (does|would) (it|this) work|what (gets|will be) discussed|what (are|is) (your|the) criteria|send (me|us) (more|some|the) (info|information|details)|tell me more\b/i;
const REFERRAL = /\b(speak|talk|email|contact|reach out) (directly )?(to|with) (the |our |my )?(owner|boss|director|manager|marketing)|\b(owner|boss|director|manager)['’]?s? (email|number|contact)|\b(i['’]?ll|i will|i am|i['’]?m) (shar(?:e|ed|ing)|forward(?:ed|ing)?|send(?:ing)?|pass(?:ed|ing)?) (this|it|your (message|details))\b/i;

/**
 * Classify a reply to the OPENER.
 * confirmed | wrong_number | opted_out | bot_autoresponder | needs_review
 */
export function classifyReply(text) {
  const t = String(text || '').trim();
  if (!t) return 'needs_review';
  if (OPT_OUT.test(t)) return 'opted_out';
  if (WRONG.test(t)) return 'wrong_number';
  if (BOT.test(t)) return 'bot_autoresponder';
  if (CONFIRM.test(t) || WHO.test(t)) return 'confirmed';
  return 'needs_review';
}

/**
 * Classify a reply that arrives AFTER the pitch. These are the money replies,
 * so none of them are auto-answered -- they route to the approval queue.
 * Speciality is checked before proof: "not familiar with these brands, what do
 * you specialise in?" is really a speciality question.
 */
export function classifyPostPitch(text) {
  const t = String(text || '').trim();
  if (!t) return 'needs_review';
  if (OPT_OUT.test(t)) return 'not_interested';
  if (BOT.test(t)) return 'bot_autoresponder';
  if (REFERRAL.test(t)) return 'referred_decision_maker';
  if (INFO.test(t)) return 'requested_info';
  if (SPECIALITY.test(t)) return 'asking_speciality';
  if (PROOF.test(t)) return 'asking_proof';
  if (HAS_AGENCY.test(t)) return 'has_agency';
  if (MEETING.test(t)) return 'meeting_request';
  return 'needs_review';
}

/** Suggested reply for a post-pitch stage, drawn from what actually worked. */
export function suggestReply(stage, { contactName = null } = {}) {
  const roster = (config.proof?.clients ?? []).join('\n');
  switch (stage) {
    case 'meeting_request':
      return contactName
        ? `Great ${contactName}. Would you be available for a quick call with Jaden, our strategy lead, later today—or would tomorrow suit you better?`
        : 'Great. Would you be available for a quick call with Jaden, our strategy lead, later today—or would tomorrow suit you better?';
    case 'requested_info':
      return 'Absolutely. We help health and wellness businesses acquire customers through Facebook advertising. We first review the offer, margins and current acquisition setup, then map out whether paid ads can work profitably. If it looks like a fit, Jaden can walk you through the strategy and relevant results on a short call. I can send the criteria and examples here first.';
    case 'referred_decision_maker':
      return 'Thank you — please send me their best email or WhatsApp contact, or feel free to introduce us here.';
    case 'asking_proof':
      return `No problem, in your industry we have:\n\n${roster}`;
    case 'asking_speciality':
      return 'For these brands we mainly specialize in Facebook ads and website management.';
    case 'has_agency':
      return 'Sure thing, we also offer website and social media management services, looking forward to hearing from you 😊';
    default:
      return null;
  }
}
