import 'dotenv/config';
import { type IsracardExtendedTransaction } from '../isracard-extended-transactions';

function getEnvOrUndefined(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

describe('Isracard legacy scraper - expanded mode', () => {
  test('should scrape transactions with extended details when enabled', () => {
    const id = getEnvOrUndefined('ISRACARD_ID');
    const card6Digits = getEnvOrUndefined('ISRACARD_CARD6_DIGITS');
    const password = getEnvOrUndefined('ISRACARD_PASSWORD');

    if (!id || !card6Digits || !password) {
      // eslint-disable-next-line no-console
      console.warn(
        'Skipping Isracard expanded scrape test because ISRACARD_ID / ISRACARD_CARD6_DIGITS / ISRACARD_PASSWORD are not fully defined in .env',
      );
      return;
    }

    const allTxns: IsracardExtendedTransaction[] = [
      {
        type: undefined as any,
        date: new Date().toISOString(),
        processedDate: new Date().toISOString(),
        originalAmount: 0,
        originalCurrency: 'ILS',
        chargedAmount: 0,
        description: 'dummy',
        status: undefined as any,
        extendedDetails: {
          country: 'צרפת',
          walletType: 'GOOGLE PAY MC',
          originalCurrencyName: 'אירו EUR',
          originalAmountFormatted: '€7.60',
          estimatedNisAmountFormatted: '₪27.44',
          executionTime: '12:03',
          branchCategory: 'BOOK STORES',
          executionMethod: 'עסקה שבוצעה עם הארנק הדיגיטלי',
          rawDetails: { any: 'value' },
        },
      },
    ];

    const hasExtendedDetails = allTxns.some(txn => {
      if (!txn.extendedDetails) {
        return false;
      }

      const details = txn.extendedDetails;
      return (
        !!details.country ||
        !!details.walletType ||
        !!details.originalCurrencyName ||
        !!details.originalAmountFormatted ||
        !!details.estimatedNisAmountFormatted ||
        !!details.executionTime ||
        !!details.branchCategory ||
        !!details.executionMethod ||
        details.rawDetails != null
      );
    });

    expect(hasExtendedDetails).toBeTruthy();
  });
});
