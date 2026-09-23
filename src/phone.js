// The /max build carries the metadata getType() needs. The core build returns
// UNKNOWN for every South African number, which silently marked landlines as
// usable -- most Maps listings are landlines and are never on WhatsApp.
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { config } from './config.js';

// Google Maps renders numbers as "011 234 5678", "+27 21 555 0100", "(021) 555-0100".
// We store one canonical E.164 form so dedupe actually works across queries.
export function normalisePhone(raw, country = config.defaultCountry) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^\d+]/g, '');
  if (cleaned.replace(/\D/g, '').length < 7) return null;

  const parsed = parsePhoneNumberFromString(cleaned, country);
  if (!parsed || !parsed.isValid()) return null;

  return parsed.number; // +27112345678
}

// whatsapp-web.js addresses individuals as <countrycode><number>@c.us, no plus.
export function toWhatsAppId(e164) {
  return `${e164.replace(/^\+/, '')}@c.us`;
}

export function fromWhatsAppId(id) {
  return `+${String(id).split('@')[0]}`;
}

/**
 * MOBILE | FIXED_LINE_OR_MOBILE | FIXED_LINE | UAN | TOLL_FREE | UNKNOWN
 * SA share-call (086) reports as UAN; Cape Town/JHB landlines as FIXED_LINE.
 */
export function phoneType(e164, country = config.defaultCountry) {
  const p = parsePhoneNumberFromString(String(e164 ?? ''), country);
  return p?.getType() ?? 'UNKNOWN';
}

// Only mobiles are reliably on WhatsApp. FIXED_LINE_OR_MOBILE is ambiguous in
// SA metadata and does sometimes work, so it is allowed but flagged.
export function whatsAppLikelihood(e164) {
  const t = phoneType(e164);
  if (t === 'MOBILE') return 'yes';
  if (t === 'FIXED_LINE_OR_MOBILE' || t === 'UNKNOWN') return 'maybe';
  return 'no';
}

/** The number to actually message: a WhatsApp found on the site beats the Maps listing. */
export function bestPhone(lead) {
  return lead.whatsapp_phone || lead.phone;
}
