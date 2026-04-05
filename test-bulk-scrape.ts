import 'dotenv/config';
import { createScraper, ScraperErrorTypes } from './src/index';
import { CompanyTypes, ScraperProgressTypes } from './src/definitions';

function bulkStartDate(): Date {
  const raw = process.env.ISRACARD_BULK_START_DATE;
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }
  const d = new Date();
  d.setMonth(d.getMonth() - 100);
  return d;
}

async function main() {
  const startDate = bulkStartDate();
  const scraper = createScraper({
    companyId: CompanyTypes.isracard,
    startDate,
    showBrowser: false,
    executablePath: process.env.CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    rateLimitOptions: {
      initialDelay: Number(process.env.ISRACARD_RATE_DELAY_MS ?? 3000),
      maxDelay: 120000,
      recycleBrowserOnBlock: process.env.ISRACARD_RECYCLE_BROWSER !== '0',
      maxBrowserRecycles: Number(process.env.ISRACARD_MAX_BROWSER_RECYCLES ?? 2),
    },
  });

  scraper.onProgress((_companyId, payload) => {
    const ts = new Date().toISOString().slice(11, 19);
    if (payload.type === ScraperProgressTypes.ScrapingMonth) {
      console.log(`[${ts}] Scraping month ${payload.monthIndex}/${payload.totalMonths}: ${payload.month}`);
    } else if (payload.type === ScraperProgressTypes.RateLimitRetry) {
      const base = payload.backoffBaseMs != null ? ` (cooldown ${payload.backoffBaseMs}ms)` : '';
      console.log(`[${ts}] RATE LIMITED - retry #${payload.attempt}, waiting ${payload.delay}ms${base}`);
    } else if (payload.type === ScraperProgressTypes.SessionRecycle) {
      console.log(`[${ts}] SESSION RECYCLE - new browser and re-login (${payload.recyclesRemaining} recycles left)`);
    } else {
      console.log(`[${ts}] ${payload.type}`);
    }
  });

  console.log(
    `Starting bulk scrape from ${startDate.toISOString().slice(0, 10)} to present (~100 months if using default window)...\n`,
  );
  const start = Date.now();

  const result = await scraper.scrape({
    id: process.env.ISRACARD_ID!,
    card6Digits: process.env.ISRACARD_CARD6_DIGITS!,
    password: process.env.ISRACARD_PASSWORD!,
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (result.success) {
    console.log(`\nScrape completed in ${elapsed}s`);
    for (const account of result.accounts ?? []) {
      console.log(`  Account ${account.accountNumber}: ${account.txns.length} transactions`);
    }
  } else {
    console.error(`\nScrape failed in ${elapsed}s:`, result.errorType, result.errorMessage);
    if (result.errorType === ScraperErrorTypes.RateLimited) {
      console.error('(Rate limit / automation block — widen spacing or retry later.)');
    }
  }
}

main().catch(console.error);
