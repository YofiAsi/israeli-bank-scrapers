export enum ScraperErrorTypes {
  TwoFactorRetrieverMissing = 'TWO_FACTOR_RETRIEVER_MISSING',
  InvalidPassword = 'INVALID_PASSWORD',
  ChangePassword = 'CHANGE_PASSWORD',
  Timeout = 'TIMEOUT',
  AccountBlocked = 'ACCOUNT_BLOCKED',
  AutomationBlocked = 'AUTOMATION_BLOCKED',
  Generic = 'GENERIC',
  General = 'GENERAL_ERROR',
}

export class AutomationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationBlockedError';
    Object.setPrototypeOf(this, AutomationBlockedError.prototype);
  }
}

export function isAutomationBlockedError(e: unknown): e is AutomationBlockedError {
  return e instanceof AutomationBlockedError || (e instanceof Error && e.name === 'AutomationBlockedError');
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

export function createAutomationBlockedError(errorMessage: string): ErrorResult {
  return createErrorResult(ScraperErrorTypes.AutomationBlocked, errorMessage);
}
