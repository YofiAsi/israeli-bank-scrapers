export enum ScraperErrorTypes {
  TwoFactorRetrieverMissing = 'TWO_FACTOR_RETRIEVER_MISSING',
  InvalidPassword = 'INVALID_PASSWORD',
  ChangePassword = 'CHANGE_PASSWORD',
  Timeout = 'TIMEOUT',
  AccountBlocked = 'ACCOUNT_BLOCKED',
  RateLimited = 'RATE_LIMITED',
  Generic = 'GENERIC',
  General = 'GENERAL_ERROR',
}

export type ErrorResult = {
  success: false;
  errorType: ScraperErrorTypes;
  errorMessage: string;
};

function createErrorResult(errorType: ScraperErrorTypes, errorMessage: string): ErrorResult {
  return {
    success: false,
    errorType,
    errorMessage,
  };
}

export function createTimeoutError(errorMessage: string): ErrorResult {
  return createErrorResult(ScraperErrorTypes.Timeout, errorMessage);
}

export function createGenericError(errorMessage: string): ErrorResult {
  return createErrorResult(ScraperErrorTypes.Generic, errorMessage);
}

export function createRateLimitedError(errorMessage: string): ErrorResult {
  return createErrorResult(ScraperErrorTypes.RateLimited, errorMessage);
}
