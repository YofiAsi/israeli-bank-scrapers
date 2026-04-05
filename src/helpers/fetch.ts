import nodeFetch from 'node-fetch';
import { type Page } from 'puppeteer';

export class FetchBlockedError extends Error {
  constructor(
    public statusCode: number,
    public responseBody: string,
    url: string,
  ) {
    super(`Request blocked with status ${statusCode} for URL: ${url}`);
    this.name = 'FetchBlockedError';
  }
}

export type FetchWithinPageOptions = {
  ignoreErrors?: boolean;
  treatBlockedResponse?: boolean;
};

function normalizeWithinPageOptions(options?: boolean | FetchWithinPageOptions): {
  ignoreErrors: boolean;
  treatBlockedResponse: boolean;
} {
  if (typeof options === 'boolean') {
    return { ignoreErrors: options, treatBlockedResponse: false };
  }
  return {
    ignoreErrors: options?.ignoreErrors ?? false,
    treatBlockedResponse: options?.treatBlockedResponse ?? false,
  };
}

function throwIfBlockedHttpStatus(
  status: number,
  body: string | null,
  url: string,
  treatBlockedResponse: boolean,
): void {
  if (!treatBlockedResponse) {
    return;
  }
  if (status === 422 || status === 429) {
    throw new FetchBlockedError(status, body ?? '', url);
  }
}

function throwIfAutomationBlockedBody(body: string | null, url: string, treatBlockedResponse: boolean): void {
  if (!treatBlockedResponse || body === null) {
    return;
  }
  if (body.includes('AUTOMATION_BLOCKED')) {
    throw new FetchBlockedError(429, body, url);
  }
}

const JSON_CONTENT_TYPE = 'application/json';

function getJsonHeaders() {
  return {
    Accept: JSON_CONTENT_TYPE,
    'Content-Type': JSON_CONTENT_TYPE,
  };
}

export async function fetchGet<TResult>(url: string, extraHeaders: Record<string, any>): Promise<TResult> {
  let headers = getJsonHeaders();
  if (extraHeaders) {
    headers = Object.assign(headers, extraHeaders);
  }
  const request = {
    method: 'GET',
    headers,
  };
  const fetchResult = await nodeFetch(url, request);

  if (fetchResult.status !== 200) {
    throw new Error(`sending a request to the institute server returned with status code ${fetchResult.status}`);
  }

  return fetchResult.json();
}

export async function fetchPost<TResult = any>(
  url: string,
  data: Record<string, any>,
  extraHeaders: Record<string, any> = {},
): Promise<TResult> {
  const request = {
    method: 'POST',
    headers: { ...getJsonHeaders(), ...extraHeaders },
    body: JSON.stringify(data),
  };
  const result = await nodeFetch(url, request);
  return result.json();
}

export async function fetchGraphql<TResult>(
  url: string,
  query: string,
  variables: Record<string, unknown> = {},
  extraHeaders: Record<string, any> = {},
): Promise<TResult> {
  const result = await fetchPost(url, { operationName: null, query, variables }, extraHeaders);
  if (result.errors?.length) {
    throw new Error(result.errors[0].message);
  }
  return result.data as Promise<TResult>;
}

export async function fetchGetWithinPage<TResult>(
  page: Page,
  url: string,
  options?: boolean | FetchWithinPageOptions,
): Promise<TResult | null> {
  const { ignoreErrors, treatBlockedResponse } = normalizeWithinPageOptions(options);
  const [result, status] = await page.evaluate(async innerUrl => {
    let response: Response | undefined;
    try {
      response = await fetch(innerUrl, { credentials: 'include' });
      if (response.status === 204) {
        return [null, response.status] as const;
      }
      return [await response.text(), response.status] as const;
    } catch (e) {
      throw new Error(
        `fetchGetWithinPage error: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}, url: ${innerUrl}, status: ${response?.status}`,
      );
    }
  }, url);
  throwIfBlockedHttpStatus(status, result, url, treatBlockedResponse);
  throwIfAutomationBlockedBody(result, url, treatBlockedResponse);
  if (result !== null) {
    try {
      return JSON.parse(result);
    } catch (e) {
      if (!ignoreErrors) {
        throw new Error(
          `fetchGetWithinPage parse error: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}, url: ${url}, result: ${result}, status: ${status}`,
        );
      }
    }
  }
  return null;
}

export async function fetchPostWithinPage<TResult>(
  page: Page,
  url: string,
  data: Record<string, any>,
  extraHeaders: Record<string, any> = {},
  options?: boolean | FetchWithinPageOptions,
): Promise<TResult | null> {
  const { ignoreErrors, treatBlockedResponse } = normalizeWithinPageOptions(options);
  const [result, status] = await page.evaluate(
    async (innerUrl: string, innerData: Record<string, any>, innerExtraHeaders: Record<string, any>) => {
      const response = await fetch(innerUrl, {
        method: 'POST',
        body: JSON.stringify(innerData),
        credentials: 'include',
        // eslint-disable-next-line prefer-object-spread
        headers: Object.assign(
          { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          innerExtraHeaders,
        ),
      });
      if (response.status === 204) {
        return [null, response.status] as const;
      }
      return [await response.text(), response.status] as const;
    },
    url,
    data,
    extraHeaders,
  );

  throwIfBlockedHttpStatus(status, result, url, treatBlockedResponse);
  throwIfAutomationBlockedBody(result, url, treatBlockedResponse);

  try {
    if (result !== null) {
      return JSON.parse(result);
    }
  } catch (e) {
    if (!ignoreErrors) {
      throw new Error(
        `fetchPostWithinPage parse error: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}, url: ${url}, data: ${JSON.stringify(data)}, extraHeaders: ${JSON.stringify(extraHeaders)}, result: ${result}`,
      );
    }
  }
  return null;
}
