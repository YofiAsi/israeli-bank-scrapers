import { FetchBlockedError } from './fetch';
import { getDebug } from './debug';
import { sleep } from './waiting';

const debug = getDebug('rate-limiter');

/** Default waits after each block before retry: 5, 7, 11 minutes; then the next failure propagates. */
export const DEFAULT_BLOCKED_RETRY_DELAYS_MS = [300_000, 420_000, 660_000] as const;

export interface RateLimiterOptions {
  /** Base delay between requests in ms (default: 2000) */
  initialDelay?: number;
  /** Ceiling for adaptive spacing between requests (default: 120000) */
  maxDelay?: number;
  /**
   * After FetchBlockedError, wait this many ms before each retry (default: 5, 7, 11 minutes).
   * Length should match how many waits you want; default maxRetries equals this array length.
   */
  blockedRetryDelaysMs?: number[];
  /** Max fetch attempts after blocks (default: length of blockedRetryDelaysMs, i.e. 3 waits then fail) */
  maxRetries?: number;
  /** Factor to increase spacing delay after a block (default: 2) */
  adaptiveIncrease?: number;
  /** When set, Isracard/Amex may reset the browser and re-login after a block (read by scraper, ignored by RateLimiter) */
  recycleBrowserOnBlock?: boolean;
  /** Max browser recycle cycles per scrape when recycleBrowserOnBlock is true (default: 2) */
  maxBrowserRecycles?: number;
}

const DEFAULTS = {
  initialDelay: 2000,
  maxDelay: 120000,
  adaptiveIncrease: 2,
} as const;

function addJitter(ms: number): number {
  const jitter = 0.2;
  const factor = 1 - jitter + Math.random() * 2 * jitter;
  return Math.round(ms * factor);
}

export class RateLimiter {
  private currentDelay: number;

  private readonly initialDelayMs: number;

  private readonly maxDelay: number;

  private readonly blockedRetryDelaysMs: readonly number[];

  private readonly maxRetries: number;

  private readonly adaptiveIncrease: number;

  private readonly onRetry?: (attempt: number, delayMs: number, backoffBaseMs: number) => void;

  constructor(
    options?: RateLimiterOptions,
    onRetry?: (attempt: number, delayMs: number, backoffBaseMs: number) => void,
  ) {
    this.initialDelayMs = options?.initialDelay ?? DEFAULTS.initialDelay;
    this.currentDelay = this.initialDelayMs;
    this.maxDelay = options?.maxDelay ?? DEFAULTS.maxDelay;
    this.blockedRetryDelaysMs = options?.blockedRetryDelaysMs?.length
      ? options.blockedRetryDelaysMs
      : [...DEFAULT_BLOCKED_RETRY_DELAYS_MS];
    this.maxRetries = options?.maxRetries ?? this.blockedRetryDelaysMs.length;
    this.adaptiveIncrease = options?.adaptiveIncrease ?? DEFAULTS.adaptiveIncrease;
    this.onRetry = onRetry;
  }

  async waitBetweenRequests(): Promise<void> {
    const delay = addJitter(this.currentDelay);
    debug(`waiting ${delay}ms between requests (base: ${this.currentDelay}ms)`);
    await sleep(delay);
  }

  async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (!(error instanceof FetchBlockedError)) {
          throw error;
        }

        if (attempt === this.maxRetries) {
          debug(`max retries (${this.maxRetries}) exhausted, giving up`);
          throw error;
        }

        this.currentDelay = Math.min(this.currentDelay * this.adaptiveIncrease, this.maxDelay);

        const rawRetryBackoff = this.blockedRetryDelaysMs[attempt];
        if (rawRetryBackoff === undefined) {
          debug(`no blocked-retry delay for attempt index ${attempt}, giving up`);
          throw error;
        }

        debug(
          `blocked (HTTP ${error.statusCode}), attempt ${attempt + 1}/${this.maxRetries}, ` +
            `sleeping ${rawRetryBackoff}ms before retry (spacing delay now ${this.currentDelay}ms)`,
        );

        this.onRetry?.(attempt + 1, rawRetryBackoff, rawRetryBackoff);
        await sleep(rawRetryBackoff);
      }
    }

    throw new Error('Unexpected: retry loop exited without return or throw');
  }

  get delay(): number {
    return this.currentDelay;
  }
}
