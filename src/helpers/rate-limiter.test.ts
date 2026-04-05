import { FetchBlockedError } from './fetch';
import { DEFAULT_BLOCKED_RETRY_DELAYS_MS, RateLimiter } from './rate-limiter';
import * as waiting from './waiting';

jest.mock('./waiting', () => ({
  ...jest.requireActual('./waiting'),
  sleep: jest.fn(() => Promise.resolve()),
}));

const sleepMock = waiting.sleep as jest.MockedFunction<typeof waiting.sleep>;

describe('RateLimiter', () => {
  beforeEach(() => {
    sleepMock.mockClear();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns on first successful call without sleeping', async () => {
    const limiter = new RateLimiter({ blockedRetryDelaysMs: [100, 200], maxRetries: 2 });
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(limiter.executeWithRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it('sleeps fixed delays per block then succeeds', async () => {
    const limiter = new RateLimiter({ blockedRetryDelaysMs: [1000, 2000], maxRetries: 2 });
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new FetchBlockedError(429, '{}', 'http://x'))
      .mockResolvedValueOnce('done');
    await expect(limiter.executeWithRetry(fn)).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepMock.mock.calls.map(a => Number(a[0]))).toEqual([1000]);
    expect(limiter.delay).toBeGreaterThan(1000);
  });

  it('throws after last configured wait is exhausted', async () => {
    const limiter = new RateLimiter({ blockedRetryDelaysMs: [10, 20], maxRetries: 2 });
    const err = new FetchBlockedError(429, '{}', 'http://x');
    const fn = jest.fn().mockRejectedValue(err);
    await expect(limiter.executeWithRetry(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepMock.mock.calls.map(a => Number(a[0]))).toEqual([10, 20]);
  });

  it('default block delays are 5,7,11 minutes with three waits then fail', async () => {
    expect(DEFAULT_BLOCKED_RETRY_DELAYS_MS).toEqual([300_000, 420_000, 660_000]);
    const limiter = new RateLimiter();
    const err = new FetchBlockedError(429, '{}', 'http://x');
    const fn = jest.fn().mockRejectedValue(err);
    await expect(limiter.executeWithRetry(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleepMock.mock.calls.map(a => Number(a[0]))).toEqual([300_000, 420_000, 660_000]);
  });

  it('uses explicit sleeps without applying maxDelay cap to block waits', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const limiter = new RateLimiter({
      blockedRetryDelaysMs: [50_000, 60_000],
      maxRetries: 2,
      maxDelay: 1000,
      initialDelay: 500,
      adaptiveIncrease: 2,
    });
    const err = new FetchBlockedError(429, '{}', 'http://x');
    const fn = jest.fn().mockRejectedValue(err);
    await expect(limiter.executeWithRetry(fn)).rejects.toBe(err);
    expect(sleepMock.mock.calls.map(a => Number(a[0]))).toEqual([50_000, 60_000]);
    expect(limiter.delay).toBeLessThanOrEqual(1000);
  });

  it('rethrows non-block errors immediately', async () => {
    const limiter = new RateLimiter({ blockedRetryDelaysMs: [1], maxRetries: 1 });
    const fn = jest.fn().mockRejectedValue(new Error('other'));
    await expect(limiter.executeWithRetry(fn)).rejects.toThrow('other');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it('waits between requests using sleep', async () => {
    const limiter = new RateLimiter({ initialDelay: 1000 });
    await limiter.waitBetweenRequests();
    expect(sleepMock).toHaveBeenCalledTimes(1);
  });
});
