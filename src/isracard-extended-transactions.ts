import { type Transaction } from './transactions';

export interface IsracardExtendedDetails {
  country?: string;
  walletType?: string;
  originalCurrencyName?: string;
  originalAmountFormatted?: string;
  estimatedNisAmountFormatted?: string;
  executionTime?: string;
  branchCategory?: string;
  executionMethod?: string;
  rawDetails?: unknown;
}

export interface IsracardExtendedTransaction extends Transaction {
  extendedDetails?: IsracardExtendedDetails;
}

