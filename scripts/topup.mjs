import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { countWorkable } from '../src/leadFilters.js';
import { scrape } from '../src/scrape/googlemaps.js';
import { runPipeline } from '../src/pipeline.js';
import { qualifierAvailable } from '../src/qualify.js';

const target = Number(process.argv[2] ?? 30);

const before = countWorkable(db);
const shortfall = target - before;
console.log(`workable now: ${before}, target: ${target}, shortfall: ${shortfall}`);

if (shortfall <= 0) {
  console.log('already at or above target, nothing to do');
  process.exit(0);
}

const s = await scrape({ target: shortfall });
console.log(`[scrape] added ${s.added}, excluded ${s.excluded}, duplicates ${s.duplicates}, no phone ${s.noPhone}, failed ${s.failed}, seen ${s.seen}`);

if (s.added > 0) {
  console.log('\nenriching + qualifying...\n');
  await runPipeline({ limit: s.added, qualify: qualifierAvailable() });
}

const after = countWorkable(db);
console.log(`\nworkable before: ${before} -> after: ${after} (gained ${after - before})`);
if (after < target) {
  console.log(`⚠ short of target by ${target - after} -- queries may be running dry for the current niches/cities`);
}
