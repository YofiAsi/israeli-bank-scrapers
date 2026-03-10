import dotenv from 'dotenv';
import puppeteer from 'puppeteer';
import IsracardScraper from '../scrapers/isracard';
import { getTestsConfig } from './tests-utils';
import { type IsracardExtendedTransaction } from '../isracard-extended-transactions';

dotenv.config();

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

function getEnvOrThrow(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

async function main() {
  const id = getEnvOrThrow('ISRACARD_ID');
  const card6Digits = getEnvOrThrow('ISRACARD_CARD6_DIGITS');
  const password = getEnvOrThrow('ISRACARD_PASSWORD');

  const testsConfig = getTestsConfig();

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: CHROMIUM_PATH,
      args: BROWSER_ARGS,
    });

    const options = {
      ...testsConfig.options,
      companyId: 'isracard',
      additionalTransactionInformation: true,
      includeRawTransaction: true,
      browser,
      skipCloseBrowser: true,
    };

    const scraper = new IsracardScraper(options);
    const result = await scraper.scrape({ id, password, card6Digits });

    if (!result.success || !result.accounts || result.accounts.length === 0) {
      // eslint-disable-next-line no-console
      console.error('Scrape failed or returned no accounts', {
        success: result.success,
        errorType: result.errorType,
        errorMessage: result.errorMessage,
      });
      return;
    }

    const accounts = result.accounts;
    const allTxns = accounts.flatMap(account => account.txns as IsracardExtendedTransaction[]);

    const sampleTxns = allTxns.slice(0, 10);

    // eslint-disable-next-line no-console
    console.dir(
      sampleTxns.map(txn => ({
        identifier: txn.identifier,
        date: txn.date,
        processedDate: txn.processedDate,
        description: txn.description,
        extendedDetails: txn.extendedDetails,
      })),
      { depth: null },
    );
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

main().catch(e => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

