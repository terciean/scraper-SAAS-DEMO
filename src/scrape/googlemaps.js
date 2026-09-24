import { chromium } from 'playwright';
import { join } from 'node:path';
import { config, ROOT } from '../config.js';
import { normalisePhone } from '../phone.js';
import { upsertLead } from '../db.js';
import { checkExcluded } from '../exclusions.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const rand = ([lo, hi]) => lo + Math.random() * (hi - lo);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dismissConsent(page) {
  // Google's EU/ZA consent interstitial blocks the feed until accepted.
  for (const sel of ['button[aria-label*="Accept all"]', 'button[aria-label*="Reject all"]', 'form[action*="consent"] button']) {
    const btn = page.locator(sel).first();
    if (await btn.count() && await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return;
    }
  }
}

async function collectPlaceUrls(page, query, max) {
  await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await dismissConsent(page);

  const feed = page.locator('div[role="feed"]');
  await feed.waitFor({ timeout: 30_000 }).catch(() => {});

  const urls = new Set();
  let stagnant = 0;

  while (urls.size < max && stagnant < 4) {
    const before = urls.size;

    for (const href of await page.locator('a[href*="/maps/place/"]').evaluateAll((els) => els.map((e) => e.href))) {
      urls.add(href.split('?')[0]);
    }

    if (urls.size === before) stagnant += 1;
    else stagnant = 0;

    // The feed is virtualised; scrolling the container is what loads the next page of results.
    await feed.evaluate((el) => el.scrollTo(0, el.scrollHeight)).catch(() => {});
    await sleep(rand([900, 1900]));

    const end = await page.getByText(/reached the end of the list/i).count().catch(() => 0);
    if (end) break;
  }

  return [...urls].slice(0, max);
}

async function extractPlace(page, url) {
  await page.goto(`${url}?hl=en`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.locator('h1').first().waitFor({ timeout: 20_000 }).catch(() => {});

  return page.evaluate(() => {
    const txt = (sel) => document.querySelector(sel)?.textContent?.trim() || null;

    // Phone lives in the attribute, not the label: data-item-id="phone:tel:+27112345678"
    const phoneEl = document.querySelector('button[data-item-id^="phone:tel:"]');
    const phone = phoneEl?.getAttribute('data-item-id')?.replace('phone:tel:', '') || null;

    const addrEl = document.querySelector('button[data-item-id="address"]');
    const address = addrEl?.getAttribute('aria-label')?.replace(/^Address:\s*/i, '') || null;

    const site = document.querySelector('a[data-item-id="authority"]')?.href || null;

    const ratingRaw = document.querySelector('div.F7nice span[aria-hidden="true"]')?.textContent?.trim();
    const reviewsRaw = document.querySelector('div.F7nice span[aria-label*="review"]')?.textContent?.trim();

    return {
      brand_name: txt('h1'),
      phone,
      address,
      website: site,
      category: txt('button[jsaction*="category"]'),
      rating: ratingRaw ? parseFloat(ratingRaw.replace(',', '.')) : null,
      reviews: reviewsRaw ? parseInt(reviewsRaw.replace(/\D/g, ''), 10) || null : null,
    };
  });
}

// Queries are the niche x city cross-product, interleaved so a single run spreads
// across cities instead of exhausting one before moving on.
export function buildQueries({ niches, cities, queries }) {
  if (queries?.length) return queries;
  const out = [];
  for (let c = 0; c < cities.length; c += 1) {
    for (let n = 0; n < niches.length; n += 1) {
      out.push(`${niches[(n + c) % niches.length]} in ${cities[c]}`);
    }
  }
  return out;
}

export async function scrape({ queries, target, maxPerQuery, headless, brokerId } = {}) {
  const cfg = config.scrape;
  queries ??= buildQueries(cfg);
  target ??= cfg.dailyTarget;
  maxPerQuery ??= cfg.maxPerQuery;
  headless ??= cfg.headless;

  const browser = await chromium.launchPersistentContext(join(ROOT, 'data', 'browser-profile'), {
    headless,
    userAgent: UA,
    viewport: { width: 1366, height: 900 },
    locale: 'en-ZA',
  });

  const page = await browser.newPage();
  const stats = { seen: 0, added: 0, duplicates: 0, noPhone: 0, failed: 0, excluded: 0 };

  try {
    for (const query of queries) {
      if (stats.added >= target) break;
      console.log(`\n[query] ${query}`);

      let urls = [];
      try {
        urls = await collectPlaceUrls(page, query, maxPerQuery);
      } catch (err) {
        console.log(`  ! feed failed: ${err.message}`);
        continue;
      }
      console.log(`  ${urls.length} places in feed`);

      for (const url of urls) {
        if (stats.added >= target) break;
        stats.seen += 1;

        let place;
        try {
          place = await extractPlace(page, url);
        } catch (err) {
          stats.failed += 1;
          continue;
        }

        const phone = normalisePhone(place.phone);
        if (!place.brand_name || (cfg.requirePhone && !phone)) {
          stats.noPhone += 1;
          continue;
        }

        const gate = checkExcluded({ brand_name: place.brand_name, phone, website: place.website });
        if (gate.excluded) {
          stats.excluded += 1;
          console.log(`  - ${place.brand_name} skipped: ${gate.reason}`);
          continue;
        }

        const { inserted } = upsertLead({ ...place, phone, source_query: query, assigned_broker_id: brokerId ?? null });
        if (inserted) {
          stats.added += 1;
          console.log(`  + ${place.brand_name} — ${phone}  (${stats.added}/${target})`);
        } else {
          stats.duplicates += 1;
        }

        await sleep(rand(cfg.delayMsBetweenCards));
      }
    }
  } finally {
    await browser.close();
  }

  // `queriesExhausted` distinguishes "reached the target early" from "ran the
  // full query list and still came up short" -- callers need this to tell the
  // user why: not a bug, just genuinely nothing more to find right now.
  return { ...stats, target, metTarget: stats.added >= target, queriesExhausted: stats.added < target };
}
