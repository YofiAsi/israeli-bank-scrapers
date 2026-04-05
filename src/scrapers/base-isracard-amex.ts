import _ from 'lodash';
import moment, { type Moment } from 'moment';
import { type Page } from 'puppeteer';
import { ALT_SHEKEL_CURRENCY, SHEKEL_CURRENCY, SHEKEL_CURRENCY_KEYWORD } from '../constants';
import { ScraperProgressTypes } from '../definitions';
import getAllMonthMoments from '../helpers/dates';
import { getDebug } from '../helpers/debug';
import { FetchBlockedError, fetchGetWithinPage, fetchPostWithinPage } from '../helpers/fetch';
import { RateLimiter } from '../helpers/rate-limiter';
import { filterOldTransactions, fixInstallments, getRawTransaction } from '../helpers/transactions';
import { runSerial } from '../helpers/waiting';
import {
  TransactionStatuses,
  TransactionTypes,
  type Transaction,
  type TransactionInstallments,
  type TransactionsAccount,
} from '../transactions';
import { type IsracardExtendedDetails, type IsracardExtendedTransaction } from '../isracard-extended-transactions';
import { BaseScraperWithBrowser } from './base-scraper-with-browser';
import { ScraperErrorTypes } from './errors';
import { type ScraperOptions, type ScraperScrapingResult } from './interface';
import { interceptionPriorities, maskHeadlessUserAgent } from '../helpers/browser';

const TRANSACTIONS_BATCH_SIZE = 10;

const COUNTRY_CODE = '212';
const ID_TYPE = '1';
const INSTALLMENTS_KEYWORD = 'תשלום';

const DATE_FORMAT = 'DD/MM/YYYY';

const debug = getDebug('base-isracard-amex');

type CompanyServiceOptions = {
  servicesUrl: string;
  companyCode: string;
};

type ScrapedAccountsWithIndex = Record<string, TransactionsAccount & { index: number }>;

interface ScrapedTransaction {
  dealSumType: string;
  voucherNumberRatzOutbound: string;
  voucherNumberRatz: string;
  moreInfo?: string;
  dealSumOutbound: boolean;
  currencyId: string;
  currentPaymentCurrency: string;
  dealSum: number;
  fullPaymentDate?: string;
  fullPurchaseDate?: string;
  fullPurchaseDateOutbound?: string;
  fullSupplierNameHeb: string;
  fullSupplierNameOutbound: string;
  paymentSum: number;
  paymentSumOutbound: number;
}

interface ScrapedAccount {
  index: number;
  accountNumber: string;
  processedDate: string;
}

interface ScrapedLoginValidation {
  Header: {
    Status: string;
  };
  ValidateIdDataBean?: {
    userName?: string;
    returnCode: string;
  };
}

interface ScrapedAccountsWithinPageResponse {
  Header: {
    Status: string;
  };
  DashboardMonthBean?: {
    cardsCharges: {
      cardIndex: string;
      cardNumber: string;
      billingDate: string;
    }[];
  };
}

interface ScrapedCurrentCardTransactions {
  txnIsrael?: ScrapedTransaction[];
  txnAbroad?: ScrapedTransaction[];
}

interface ScrapedTransactionData {
  Header?: {
    Status: string;
  };
  PirteyIska_204Bean?: {
    sector: string;
  };

  CardsTransactionsListBean?: Record<
    string,
    {
      CurrentCardTransactions: ScrapedCurrentCardTransactions[];
    }
  >;
}

function getAccountsUrl(servicesUrl: string, monthMoment: Moment) {
  const billingDate = monthMoment.format('YYYY-MM-DD');
  const url = new URL(servicesUrl);
  url.searchParams.set('reqName', 'DashboardMonth');
  url.searchParams.set('actionCode', '0');
  url.searchParams.set('billingDate', billingDate);
  url.searchParams.set('format', 'Json');
  return url.toString();
}

async function fetchAccounts(
  page: Page,
  servicesUrl: string,
  monthMoment: Moment,
  rateLimiter: RateLimiter,
): Promise<ScrapedAccount[]> {
  const dataUrl = getAccountsUrl(servicesUrl, monthMoment);
  debug(`fetching accounts from ${dataUrl}`);
  const dataResult = await rateLimiter.executeWithRetry(() =>
    fetchGetWithinPage<ScrapedAccountsWithinPageResponse>(page, dataUrl, { treatBlockedResponse: true }),
  );
  if (dataResult && _.get(dataResult, 'Header.Status') === '1' && dataResult.DashboardMonthBean) {
    const { cardsCharges } = dataResult.DashboardMonthBean;
    if (cardsCharges) {
      return cardsCharges.map(cardCharge => {
        return {
          index: parseInt(cardCharge.cardIndex, 10),
          accountNumber: cardCharge.cardNumber,
          processedDate: moment(cardCharge.billingDate, DATE_FORMAT).toISOString(),
        };
      });
    }
  }
  return [];
}

function getTransactionsUrl(servicesUrl: string, monthMoment: Moment) {
  const month = monthMoment.month() + 1;
  const year = monthMoment.year();
  const monthStr = month < 10 ? `0${month}` : month.toString();
  const url = new URL(servicesUrl);
  url.searchParams.set('reqName', 'CardsTransactionsList');
  url.searchParams.set('month', monthStr);
  url.searchParams.set('year', `${year}`);
  url.searchParams.set('requiredDate', 'N');
  return url.toString();
}

function convertCurrency(currencyStr: string) {
  if (currencyStr === SHEKEL_CURRENCY_KEYWORD || currencyStr === ALT_SHEKEL_CURRENCY) {
    return SHEKEL_CURRENCY;
  }
  return currencyStr;
}

function getInstallmentsInfo(txn: ScrapedTransaction): TransactionInstallments | undefined {
  if (!txn.moreInfo || !txn.moreInfo.includes(INSTALLMENTS_KEYWORD)) {
    return undefined;
  }
  const matches = txn.moreInfo.match(/\d+/g);
  if (!matches || matches.length < 2) {
    return undefined;
  }

  return {
    number: parseInt(matches[0], 10),
    total: parseInt(matches[1], 10),
  };
}

function getTransactionType(txn: ScrapedTransaction) {
  return getInstallmentsInfo(txn) ? TransactionTypes.Installments : TransactionTypes.Normal;
}

function convertTransactions(
  txns: ScrapedTransaction[],
  processedDate: string,
  options?: ScraperOptions,
): Transaction[] {
  const filteredTxns = txns.filter(
    txn =>
      txn.dealSumType !== '1' && txn.voucherNumberRatz !== '000000000' && txn.voucherNumberRatzOutbound !== '000000000',
  );

  return filteredTxns.map(txn => {
    const isOutbound = txn.dealSumOutbound;
    const txnDateStr = isOutbound ? txn.fullPurchaseDateOutbound : txn.fullPurchaseDate;
    const txnMoment = moment(txnDateStr, DATE_FORMAT);

    const currentProcessedDate = txn.fullPaymentDate
      ? moment(txn.fullPaymentDate, DATE_FORMAT).toISOString()
      : processedDate;
    const result: Transaction = {
      type: getTransactionType(txn),
      identifier: parseInt(isOutbound ? txn.voucherNumberRatzOutbound : txn.voucherNumberRatz, 10),
      date: txnMoment.toISOString(),
      processedDate: currentProcessedDate,
      originalAmount: isOutbound ? -txn.dealSumOutbound : -txn.dealSum,
      originalCurrency: convertCurrency(txn.currentPaymentCurrency ?? txn.currencyId),
      chargedAmount: isOutbound ? -txn.paymentSumOutbound : -txn.paymentSum,
      chargedCurrency: convertCurrency(txn.currencyId),
      description: isOutbound ? txn.fullSupplierNameOutbound : txn.fullSupplierNameHeb,
      memo: txn.moreInfo || '',
      installments: getInstallmentsInfo(txn) || undefined,
      status: TransactionStatuses.Completed,
    };

    if (options?.includeRawTransaction) {
      result.rawTransaction = getRawTransaction(txn);
    }

    return result;
  });
}

async function fetchTransactions(
  page: Page,
  options: ScraperOptions,
  companyServiceOptions: CompanyServiceOptions,
  startMoment: Moment,
  monthMoment: Moment,
  rateLimiter: RateLimiter,
): Promise<ScrapedAccountsWithIndex> {
  const accounts = await fetchAccounts(page, companyServiceOptions.servicesUrl, monthMoment, rateLimiter);
  const dataUrl = getTransactionsUrl(companyServiceOptions.servicesUrl, monthMoment);
  await rateLimiter.waitBetweenRequests();
  debug(`fetching transactions from ${dataUrl} for month ${monthMoment.format('YYYY-MM')}`);
  const dataResult = await rateLimiter.executeWithRetry(() =>
    fetchGetWithinPage<ScrapedTransactionData>(page, dataUrl, { treatBlockedResponse: true }),
  );
  if (dataResult && _.get(dataResult, 'Header.Status') === '1' && dataResult.CardsTransactionsListBean) {
    const accountTxns: ScrapedAccountsWithIndex = {};
    accounts.forEach(account => {
      const txnGroups: ScrapedCurrentCardTransactions[] | undefined = _.get(
        dataResult,
        `CardsTransactionsListBean.Index${account.index}.CurrentCardTransactions`,
      );
      if (txnGroups) {
        let allTxns: Transaction[] = [];
        txnGroups.forEach(txnGroup => {
          if (txnGroup.txnIsrael) {
            const txns = convertTransactions(txnGroup.txnIsrael, account.processedDate, options);
            allTxns.push(...txns);
          }
          if (txnGroup.txnAbroad) {
            const txns = convertTransactions(txnGroup.txnAbroad, account.processedDate, options);
            allTxns.push(...txns);
          }
        });

        if (!options.combineInstallments) {
          allTxns = fixInstallments(allTxns);
        }
        if (options.outputData?.enableTransactionsFilterByDate ?? true) {
          allTxns = filterOldTransactions(allTxns, startMoment, options.combineInstallments || false);
        }
        if (options.transactionMonthsEndDate && (options.outputData?.enableTransactionsFilterByDate ?? true)) {
          const endCapDay = moment(options.transactionMonthsEndDate).endOf('day');
          allTxns = allTxns.filter(txn => moment(txn.date).isSameOrBefore(endCapDay));
        }
        accountTxns[account.accountNumber] = {
          accountNumber: account.accountNumber,
          index: account.index,
          txns: allTxns,
        };
      }
    });
    return accountTxns;
  }

  return {};
}

async function getExtraScrapTransaction(
  page: Page,
  options: CompanyServiceOptions,
  month: Moment,
  accountIndex: number,
  transaction: Transaction,
  rateLimiter: RateLimiter,
): Promise<Transaction> {
  const url = new URL(options.servicesUrl);
  url.searchParams.set('reqName', 'PirteyIska_204');
  url.searchParams.set('CardIndex', accountIndex.toString());
  url.searchParams.set('shovarRatz', transaction.identifier!.toString());
  url.searchParams.set('moedChiuv', month.format('MMYYYY'));

  debug(`fetching extra scrap for transaction ${transaction.identifier} for month ${month.format('YYYY-MM')}`);
  let data: ScrapedTransactionData | null = null;
  try {
    data = await rateLimiter.executeWithRetry(() =>
      fetchGetWithinPage<ScrapedTransactionData>(page, url.toString(), { treatBlockedResponse: true }),
    );
  } catch (e) {
    if (e instanceof FetchBlockedError) {
      throw e;
    }
    debug(
      `failed to fetch extra scrap for transaction ${transaction.identifier} for month ${month.format(
        'YYYY-MM',
      )}, continuing without additional information`,
      e,
    );
    return transaction;
  }
  if (!data) {
    return transaction;
  }

  const rawCategory = _.get(data, 'PirteyIska_204Bean.sector') ?? '';
  const extendedDetails: IsracardExtendedDetails = {
    rawDetails: data.PirteyIska_204Bean ?? data,
  };

  const updatedTransaction: IsracardExtendedTransaction = {
    ...transaction,
    category: rawCategory.trim() || transaction.category,
    extendedDetails,
    rawTransaction: getRawTransaction(data, transaction),
  };

  return updatedTransaction;
}

async function getExtraScrapAccount(
  page: Page,
  options: CompanyServiceOptions,
  accountMap: ScrapedAccountsWithIndex,
  month: moment.Moment,
  rateLimiter: RateLimiter,
): Promise<ScrapedAccountsWithIndex> {
  const accounts: ScrapedAccountsWithIndex[string][] = [];
  for (const account of Object.values(accountMap)) {
    debug(
      `get extra scrap for ${account.accountNumber} with ${account.txns.length} transactions`,
      month.format('YYYY-MM'),
    );
    const txns: Transaction[] = [];
    for (const txnsChunk of _.chunk(account.txns, TRANSACTIONS_BATCH_SIZE)) {
      debug(`processing chunk of ${txnsChunk.length} transactions for account ${account.accountNumber}`);
      const updatedTxns = await runSerial(
        txnsChunk.map(t => () => getExtraScrapTransaction(page, options, month, account.index, t, rateLimiter)),
      );
      await rateLimiter.waitBetweenRequests();
      txns.push(...updatedTxns);
    }
    accounts.push({ ...account, txns });
  }

  return accounts.reduce((m, x) => ({ ...m, [x.accountNumber]: x }), {});
}

async function getAdditionalTransactionInformation(
  scraperOptions: ScraperOptions,
  accountsWithIndex: ScrapedAccountsWithIndex[],
  page: Page,
  options: CompanyServiceOptions,
  allMonths: moment.Moment[],
  rateLimiter: RateLimiter,
): Promise<ScrapedAccountsWithIndex[]> {
  if (
    !scraperOptions.additionalTransactionInformation ||
    scraperOptions.optInFeatures?.includes('isracard-amex:skipAdditionalTransactionInformation')
  ) {
    return accountsWithIndex;
  }
  return runSerial(
    accountsWithIndex.map((a, i) => () => getExtraScrapAccount(page, options, a, allMonths[i], rateLimiter)),
  );
}

async function getAdditionalTransactionInformationWithRecycle(
  scraperOptions: ScraperOptions,
  accountsWithIndex: ScrapedAccountsWithIndex[],
  resolvePage: () => Page,
  options: CompanyServiceOptions,
  allMonths: moment.Moment[],
  rateLimiter: RateLimiter,
  tryRecycle?: () => Promise<boolean>,
): Promise<ScrapedAccountsWithIndex[]> {
  if (
    !scraperOptions.additionalTransactionInformation ||
    scraperOptions.optInFeatures?.includes('isracard-amex:skipAdditionalTransactionInformation')
  ) {
    return accountsWithIndex;
  }
  for (;;) {
    try {
      return await getAdditionalTransactionInformation(
        scraperOptions,
        accountsWithIndex,
        resolvePage(),
        options,
        allMonths,
        rateLimiter,
      );
    } catch (e) {
      if (e instanceof FetchBlockedError && tryRecycle) {
        const ok = await tryRecycle();
        if (ok) {
          continue;
        }
      }
      throw e;
    }
  }
}

async function fetchAllTransactions(
  resolvePage: () => Page,
  options: ScraperOptions,
  companyServiceOptions: CompanyServiceOptions,
  startMoment: Moment,
  rateLimiter: RateLimiter,
  emitProgress: (type: ScraperProgressTypes, extra?: Record<string, any>) => void,
  tryRecycle?: () => Promise<boolean>,
) {
  const futureMonthsToScrape = options.futureMonthsToScrape ?? 1;
  let allMonths: Moment[];
  if (options.transactionMonthsEndDate) {
    const startM = moment(startMoment).startOf('month');
    const endCap = moment(options.transactionMonthsEndDate).startOf('month');
    let spanEnd = endCap.clone().add(2, 'month');
    let lastAllowed = moment().startOf('month');
    if (futureMonthsToScrape > 0) {
      lastAllowed = lastAllowed.clone().add(futureMonthsToScrape, 'month');
    }
    if (spanEnd.isAfter(lastAllowed, 'month')) {
      spanEnd = lastAllowed;
    }
    allMonths = [];
    for (let cur = startM.clone(); cur.isSameOrBefore(spanEnd, 'month'); cur = cur.clone().add(1, 'month')) {
      allMonths.push(cur.clone());
    }
  } else {
    allMonths = getAllMonthMoments(startMoment, futureMonthsToScrape);
  }
  const results: ScrapedAccountsWithIndex[] = [];
  let monthIndex = 0;
  while (monthIndex < allMonths.length) {
    const monthMoment = allMonths[monthIndex];
    emitProgress(ScraperProgressTypes.ScrapingMonth, {
      monthIndex: monthIndex + 1,
      totalMonths: allMonths.length,
      month: monthMoment.format('YYYY-MM'),
    });
    try {
      const monthResult = await fetchTransactions(
        resolvePage(),
        options,
        companyServiceOptions,
        startMoment,
        monthMoment,
        rateLimiter,
      );
      results.push(monthResult);
      monthIndex += 1;
    } catch (e) {
      if (e instanceof FetchBlockedError && tryRecycle) {
        const recycled = await tryRecycle();
        if (recycled) {
          continue;
        }
      }
      throw e;
    }
  }

  const finalResult = await getAdditionalTransactionInformationWithRecycle(
    options,
    results,
    resolvePage,
    companyServiceOptions,
    allMonths,
    rateLimiter,
    tryRecycle,
  );
  const combinedTxns: Record<string, Transaction[]> = {};

  finalResult.forEach(result => {
    Object.keys(result).forEach(accountNumber => {
      let txnsForAccount = combinedTxns[accountNumber];
      if (!txnsForAccount) {
        txnsForAccount = [];
        combinedTxns[accountNumber] = txnsForAccount;
      }
      const toBeAddedTxns = result[accountNumber].txns;
      combinedTxns[accountNumber].push(...toBeAddedTxns);
    });
  });

  const accounts = Object.keys(combinedTxns).map(accountNumber => {
    return {
      accountNumber,
      txns: combinedTxns[accountNumber],
    };
  });

  return {
    success: true,
    accounts,
  };
}

type ScraperSpecificCredentials = { id: string; password: string; card6Digits: string };
class IsracardAmexBaseScraper extends BaseScraperWithBrowser<ScraperSpecificCredentials> {
  private baseUrl: string;

  private companyCode: string;

  private servicesUrl: string;

  private rateLimiter: RateLimiter;

  private recycleCredentials: ScraperSpecificCredentials | null = null;

  private browserRecyclesRemaining = 0;

  constructor(options: ScraperOptions, baseUrl: string, companyCode: string) {
    super(options);

    this.baseUrl = baseUrl;
    this.companyCode = companyCode;
    this.servicesUrl = `${baseUrl}/services/ProxyRequestHandler.ashx`;
    this.rateLimiter = new RateLimiter(options.rateLimitOptions, (attempt, delayMs, backoffBaseMs) => {
      this.emitProgress(ScraperProgressTypes.RateLimitRetry, { attempt, delay: delayMs, backoffBaseMs });
    });
  }

  async login(credentials: ScraperSpecificCredentials): Promise<ScraperScrapingResult> {
    this.recycleCredentials = credentials;
    await this.page.setRequestInterception(true);
    this.page.on('request', request => {
      if (request.url().includes('detector-dom.min.js')) {
        debug('force abort for request do download detector-dom.min.js resource');
        void request.abort(undefined, interceptionPriorities.abort);
      } else {
        void request.continue(undefined, interceptionPriorities.continue);
      }
    });

    await maskHeadlessUserAgent(this.page);

    await this.navigateTo(`${this.baseUrl}/personalarea/Login`);

    this.emitProgress(ScraperProgressTypes.LoggingIn);

    const validateUrl = `${this.servicesUrl}?reqName=ValidateIdData`;
    const validateRequest = {
      id: credentials.id,
      cardSuffix: credentials.card6Digits,
      countryCode: COUNTRY_CODE,
      idType: ID_TYPE,
      checkLevel: '1',
      companyCode: this.companyCode,
    };
    debug('logging in with validate request');
    const validateResult = await this.rateLimiter.executeWithRetry(() =>
      fetchPostWithinPage<ScrapedLoginValidation>(
        this.page,
        validateUrl,
        validateRequest,
        {},
        {
          treatBlockedResponse: true,
        },
      ),
    );
    if (
      !validateResult ||
      !validateResult.Header ||
      validateResult.Header.Status !== '1' ||
      !validateResult.ValidateIdDataBean
    ) {
      throw new Error('unknown error during login');
    }

    const validateReturnCode = validateResult.ValidateIdDataBean.returnCode;
    debug(`user validate with return code '${validateReturnCode}'`);
    if (validateReturnCode === '1') {
      const { userName } = validateResult.ValidateIdDataBean;

      const loginUrl = `${this.servicesUrl}?reqName=performLogonI`;
      const request = {
        KodMishtamesh: userName,
        MisparZihuy: credentials.id,
        Sisma: credentials.password,
        cardSuffix: credentials.card6Digits,
        countryCode: COUNTRY_CODE,
        idType: ID_TYPE,
      };
      debug('user login started');
      const loginResult = await this.rateLimiter.executeWithRetry(() =>
        fetchPostWithinPage<{ status: string }>(this.page, loginUrl, request, {}, { treatBlockedResponse: true }),
      );
      debug(`user login with status '${loginResult?.status}'`, loginResult);

      if (loginResult && loginResult.status === '1') {
        this.emitProgress(ScraperProgressTypes.LoginSuccess);
        return { success: true };
      }

      if (loginResult && loginResult.status === '3') {
        this.emitProgress(ScraperProgressTypes.ChangePassword);
        return {
          success: false,
          errorType: ScraperErrorTypes.ChangePassword,
        };
      }

      this.emitProgress(ScraperProgressTypes.LoginFailed);
      return {
        success: false,
        errorType: ScraperErrorTypes.InvalidPassword,
      };
    }

    if (validateReturnCode === '4') {
      this.emitProgress(ScraperProgressTypes.ChangePassword);
      return {
        success: false,
        errorType: ScraperErrorTypes.ChangePassword,
      };
    }

    this.emitProgress(ScraperProgressTypes.LoginFailed);
    return {
      success: false,
      errorType: ScraperErrorTypes.InvalidPassword,
    };
  }

  async fetchData() {
    const defaultStartMoment = moment().subtract(1, 'years');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = moment(startDate);

    const rlOpts = this.options.rateLimitOptions;
    const recycleEnabled = !!rlOpts?.recycleBrowserOnBlock;
    this.browserRecyclesRemaining = recycleEnabled ? (rlOpts?.maxBrowserRecycles ?? 2) : 0;

    const tryRecycle = async (): Promise<boolean> => {
      if (!recycleEnabled || this.browserRecyclesRemaining <= 0 || !this.recycleCredentials) {
        return false;
      }
      this.emitProgress(ScraperProgressTypes.SessionRecycle, {
        recyclesRemaining: this.browserRecyclesRemaining,
      });
      await this.resetBrowserSession();
      const loginResult = await this.login(this.recycleCredentials);
      if (!loginResult.success) {
        throw new Error(loginResult.errorMessage ?? 're-login after session recycle failed');
      }
      this.browserRecyclesRemaining -= 1;
      return true;
    };

    return fetchAllTransactions(
      () => this.page,
      this.options,
      {
        servicesUrl: this.servicesUrl,
        companyCode: this.companyCode,
      },
      startMoment,
      this.rateLimiter,
      (type, extra) => this.emitProgress(type, extra),
      tryRecycle,
    );
  }

  async terminate(success: boolean) {
    this.recycleCredentials = null;
    await super.terminate(success);
  }
}

export default IsracardAmexBaseScraper;
