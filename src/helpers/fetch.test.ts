import { type Page } from 'puppeteer';
import { FetchBlockedError, fetchGetWithinPage } from './fetch';

describe('fetchGetWithinPage', () => {
  it('throws FetchBlockedError on HTTP 429 when treatBlockedResponse is true', async () => {
    const page = {
      evaluate: jest.fn().mockResolvedValue(['', 429]),
    } as unknown as Page;
    await expect(fetchGetWithinPage(page, 'https://example.com/api', { treatBlockedResponse: true })).rejects.toThrow(
      FetchBlockedError,
    );
  });

  it('parses JSON on 429 when treatBlockedResponse is false', async () => {
    const page = {
      evaluate: jest.fn().mockResolvedValue(['{"ok":true}', 429]),
    } as unknown as Page;
    await expect(fetchGetWithinPage(page, 'https://example.com/api')).resolves.toEqual({ ok: true });
  });

  it('throws FetchBlockedError when body contains AUTOMATION_BLOCKED with HTTP 200', async () => {
    const body = JSON.stringify({ error_code: 'AUTOMATION_BLOCKED' });
    const page = {
      evaluate: jest.fn().mockResolvedValue([body, 200]),
    } as unknown as Page;
    await expect(fetchGetWithinPage(page, 'https://example.com/api', { treatBlockedResponse: true })).rejects.toThrow(
      FetchBlockedError,
    );
  });
});
