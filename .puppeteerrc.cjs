// whatsapp-web.js pulls in Puppeteer as a dependency, and Puppeteer's own
// postinstall tries to download a full Chrome build of its own even though
// this project never launches it un-configured -- src/wa/client.js points
// Puppeteer at a real, already-installed system Chrome (executablePath), and
// the scraper/enrichment fallback separately drive Playwright's own Chromium
// (see README: run `npx playwright install chromium` once after
// `npm install`).
//
// Without this, `npm install` on a fresh machine can fail outright (or just
// take several extra minutes) downloading a Chrome build this project
// doesn't use. The automated `--auto` send/listen path still works as long
// as Chrome is installed system-wide (see CHROME_PATHS in src/wa/client.js);
// if it can't find one, install Google Chrome or add its path there.
module.exports = {
  skipDownload: true,
};
