export { CompanyTypes, SCRAPERS, ScraperProgressTypes } from './definitions';
export { default as createScraper } from './scrapers/factory';
export { FetchBlockedError, type FetchWithinPageOptions } from './helpers/fetch';
export { DEFAULT_BLOCKED_RETRY_DELAYS_MS } from './helpers/rate-limiter';
export { ScraperErrorTypes, createRateLimitedError } from './scrapers/errors';

// Note: the typo ScaperScrapingResult & ScraperLoginResult (sic) are exported here for backward compatibility
export {
  ScraperLoginResult as ScaperLoginResult,
  ScraperScrapingResult as ScaperScrapingResult,
  Scraper,
  ScraperCredentials,
  ScraperLoginResult,
  ScraperOptions,
  ScraperRateLimitOptions,
  ScraperScrapingResult,
} from './scrapers/interface';

export { default as OneZeroScraper } from './scrapers/one-zero';

export function getPuppeteerConfig() {
  return { chromiumRevision: '1250580' }; // https://github.com/puppeteer/puppeteer/releases/tag/puppeteer-core-v22.5.0
}
