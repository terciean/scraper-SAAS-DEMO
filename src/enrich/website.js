const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function get(url, timeoutMs = 20_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
    });
    if (!res.ok) return { ok: false, status: res.status, html: '', url };
    return { ok: true, status: res.status, html: await res.text(), url: res.url };
  } catch (err) {
    return { ok: false, status: 0, html: '', url, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function detectPlatform(html) {
  const h = html.toLowerCase();
  if (h.includes('cdn.shopify.com') || h.includes('shopify.theme')) return 'shopify';
  if (h.includes('woocommerce') || h.includes('wp-content/plugins/woocommerce')) return 'woocommerce';
  if (h.includes('static.parastorage.com') || h.includes('wix.com')) return 'wix';
  if (h.includes('squarespace.com') || h.includes('static1.squarespace')) return 'squarespace';
  if (h.includes('wp-content')) return 'wordpress';
  return 'unknown';
}

// Rand amounts. Reject values outside a sane retail band so phone numbers,
// years and VAT numbers don't get read as prices.
function extractPrices(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const out = [];
  for (const m of text.matchAll(/R\s?(\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{2})?)\b/g)) {
    const v = parseFloat(m[1].replace(/[ ,](?=\d{3})/g, '').replace(',', '.'));
    if (Number.isFinite(v) && v >= 20 && v <= 100_000) out.push(v);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// Tracking and widget endpoints share the social domains -- facebook.com/tr is
// the Meta Pixel, not a page. Keep only things that look like real profiles.
const SOCIAL_JUNK = /\/(tr|plugins|sharer|share|dialog|v\d+\.\d+|embed|intent|login|privacy|policies|help|home|profile\.php)\b/i;

export function extractSocials(html) {
  const grab = (re) => {
    for (const m of html.matchAll(new RegExp(re.source, 'gi'))) {
      const url = m[0].replace(/["'<>]/g, '');
      if (!SOCIAL_JUNK.test(new URL(url).pathname)) return url;
    }
    return null;
  };
  return {
    instagram: grab(/https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.]+/),
    facebook:  grab(/https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9_.-]+/),
    linkedin:  grab(/https?:\/\/(?:www\.|[a-z]{2}\.)?linkedin\.com\/company\/[A-Za-z0-9_.%-]+\/?/),
    tiktok:    grab(/https?:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9_.]+/),
  };
}

function extractWhatsApp(html) {
  const m = html.match(/https?:\/\/(?:api\.whatsapp\.com\/send\?phone=|wa\.me\/)(\d{7,15})/i);
  return m ? `+${m[1]}` : null;
}

function visibleText(html, cap = 5000) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

function findAboutUrl(html, base) {
  const re = /href=["']([^"']*(?:about|our-story|story|founder|team|who-we-are)[^"']*)["']/i;
  const m = html.match(re);
  if (!m) return null;
  try { return new URL(m[1], base).href; } catch { return null; }
}

/**
 * Fetch a lead's website and pull the evidence the qualification step needs.
 * Returns signals only -- no judgement. Never throws.
 */
// Try https first, then the www/non-www variant -- many listed URLs are stale
// http:// entries whose host only answers on one of the two.
function variants(raw) {
  const bare = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const host = bare.split('/')[0];
  const rest = bare.slice(host.length);
  const alt = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  return [...new Set([`https://${host}${rest}`, `https://${alt}${rest}`, `http://${host}${rest}`])];
}

export async function enrichWebsite(websiteUrl, { page = null } = {}) {
  let home = null;
  for (const candidate of variants(websiteUrl)) {
    home = await get(candidate);
    if (home.ok) break;
  }

  // Bot-blocked (403/503) or TLS-fussy hosts: retry through a real browser.
  if (!home.ok && page) {
    try {
      await page.goto(variants(websiteUrl)[0], { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1500);
      home = { ok: true, status: 200, html: await page.content(), url: page.url() };
    } catch { /* fall through to the error return below */ }
  }

  if (!home.ok) {
    return { error: home.error ?? `http ${home.status}`, enriched_at: new Date().toISOString() };
  }

  const html = home.html;
  const prices = extractPrices(html);
  const h = html.toLowerCase();

  // Pull the About page too -- founder/owner names almost never live on the home page.
  const aboutUrl = findAboutUrl(html, home.url);
  let aboutText = '';
  if (aboutUrl && aboutUrl !== home.url) {
    const about = await get(aboutUrl, 15_000);
    if (about.ok) aboutText = visibleText(about.html, 3500);
  }

  return {
    final_url: home.url,
    domain: new URL(home.url).hostname.replace(/^www\./, ''),
    platform: detectPlatform(html),
    has_meta_pixel: /connect\.facebook\.net|fbq\(|facebook-jssdk|_fbp/i.test(html) ? 1 : 0,
    has_google_ads: /googletagmanager|gtag\(|google-analytics/i.test(html) ? 1 : 0,
    has_ecommerce: /add to cart|add-to-cart|\/cart|checkout|shop now|buy now/i.test(h) ? 1 : 0,
    has_subscription: /subscribe (?:and|&) save|subscription|auto-?renew|monthly plan/i.test(h) ? 1 : 0,
    has_bundles: /bundle|combo|value pack|starter kit|gift set/i.test(h) ? 1 : 0,
    price_min: prices.length ? prices[0] : null,
    price_max: prices.length ? prices[prices.length - 1] : null,
    price_samples: prices.slice(0, 40),
    socials: extractSocials(html),
    whatsapp_link: extractWhatsApp(html),
    about_url: aboutUrl,
    home_text: visibleText(html),
    about_text: aboutText,
    enriched_at: new Date().toISOString(),
  };
}
