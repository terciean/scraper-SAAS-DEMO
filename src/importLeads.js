import { normalisePhone } from './phone.js';
import { upsertLead } from './db.js';
import { checkExcluded } from './exclusions.js';

/**
 * Format: one lead per line, comma-separated.
 *
 *   Business Name, Phone, Category (optional), Website (optional)
 *
 * Fields after the name are order-independent -- a phone-shaped token is
 * read as the phone, a domain-shaped token as the website, anything else
 * left over as the category. Blank lines and lines starting with # are
 * skipped. A line with no name or no parseable phone is reported invalid,
 * not silently dropped.
 */
export function parseLeadLine(line) {
  const parts = line.split(/\s*[,\t|]\s*/).filter(Boolean);
  const name = parts.shift();
  if (!name) return { error: 'no business name' };

  let phone = null, website = null, category = null;
  for (const p of parts) {
    if (!phone && /^\+?[\d\s()-]{7,}$/.test(p)) phone = p;
    else if (!website && /\./.test(p) && !/\s/.test(p)) website = p;
    else if (!category) category = p;
  }

  if (!phone) return { error: 'no phone number found', name };

  const normalised = normalisePhone(phone);
  if (!normalised) return { error: `phone "${phone}" doesn't parse as a valid number`, name };

  return { brand_name: name, phone: normalised, category, website };
}

/**
 * Import pasted lead text. Runs every line through the exact same gates the
 * scraper uses -- chain filter, exclusion list, phone dedupe -- so a pasted
 * lead can never bypass protections a scraped one goes through.
 */
export function importPastedLeads(text) {
  const result = { added: 0, duplicates: 0, excluded: 0, invalid: 0, invalidLines: [], addedNames: [] };

  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const parsed = parseLeadLine(line);
    if (parsed.error) {
      result.invalid += 1;
      result.invalidLines.push({ line: line.slice(0, 80), reason: parsed.error });
      continue;
    }

    const gate = checkExcluded({ brand_name: parsed.brand_name, phone: parsed.phone, website: parsed.website });
    if (gate.excluded) {
      result.excluded += 1;
      continue;
    }

    const { inserted } = upsertLead({ ...parsed, source: 'manual_paste' });
    if (inserted) {
      result.added += 1;
      result.addedNames.push(parsed.brand_name);
    } else {
      result.duplicates += 1;
    }
  }

  return result;
}
