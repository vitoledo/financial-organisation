// =============================================================================
// Pierre API response types — modeled from real Phase 0 JSON samples
// =============================================================================

// ---------------------------------------------------------------------------
// Accounts (GET /get-accounts)
// ---------------------------------------------------------------------------

export interface PierreReservedBalance {
  identification: string;
  availableAmounts: Array<{
    amount: number;
    currencyCode: string;
    remuneration?: {
      indexer: string;
      rateType: string;
      calculation: string;
      ratePeriodicity: string;
      postFixedIndexerPercentage: number;
    };
  }>;
}

export interface PierreBankData {
  closingBalance: number;
  transferNumber: string;
  reservedBalances: PierreReservedBalance[];
  hasReservedBalance: boolean;
  overdraftUsedLimit: number;
  overdraftContractedLimit: number;
  unarrangedOverdraftAmount: number;
  automaticallyInvestedBalance: number;
}

export interface PierreDisaggregatedCreditLimit {
  lineName: string;
  usedAmount: number;
  limitAmount: number;
  availableAmount: number;
  isLimitFlexible: boolean;
  consolidationType: string;
  creditLineLimitType: string;
  identificationNumber: string;
  customizedLimitAmount: number;
  lineNameAdditionalInfo?: string;
  usedAmountCurrencyCode: string;
  limitAmountCurrencyCode: string;
  availableAmountCurrencyCode: string;
  customizedLimitAmountCurrencyCode: string;
}

export interface PierreCreditData {
  brand: string;
  level: string;
  status: string;
  holderType: string | null;
  creditLimit: number;
  balanceDueDate: string;
  minimumPayment: number;
  additionalCards: Array<{ number: string }>;
  isLimitFlexible: boolean;
  balanceCloseDate: string | null;
  brandAdditionalInfo: string;
  availableCreditLimit: number;
  balanceForeignCurrency: string | null;
  disaggregatedCreditLimits: PierreDisaggregatedCreditLimit[];
}

export interface PierreAccount {
  id: string;
  itemId: string;
  name: string;
  type: 'BANK' | 'CREDIT';
  subtype: 'CHECKING_ACCOUNT' | 'CREDIT_CARD' | 'SAVINGS';
  number: string;
  currencyCode: string;
  balance: string;
  creditData: PierreCreditData | null;
  bankData: PierreBankData | null;
  marketingName: string | null;
  taxNumber: string | null;
  owner: string;
  customName: string | null;
  userId: string;
  createdAt: string;
  updatedAt: string;
  connectorName: string | null;
  connectorImageUrl: string | null;
  itemLastUpdatedAt: string | null;
  itemIsActive: boolean;
}

export interface PierreAccountsResponse {
  success: boolean;
  data: PierreAccount[];
  count: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Transactions (GET /get-transactions)
// ---------------------------------------------------------------------------

export interface PierreCreditCardData {
  purchaseDate: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  totalAmount: number | null;
  billId: string | null;
  isFullInstallmentTransaction: boolean;
  isIndividualInstallment: boolean;
}

export interface PierreTransaction {
  id: string;
  account_id: string;
  description: string;
  category: string;
  original_category: string;
  tr_confidence: number | null;
  tr_reasoning: string | null;
  currency_code: string;
  amount: number;
  amount_in_account_currency: number | null;
  date: string;
  installment_due_date: string | null;
  type: 'DEBIT' | 'CREDIT';
  status: 'POSTED' | 'PENDING';
  payment_data: unknown;
  credit_card_data: PierreCreditCardData | null;
  merchant: string | null;
  account_name: string;
  account_type: 'BANK' | 'CREDIT';
  account_subtype: string;
  account_item_id: string;
  connector_name: string;
  connector_image_url: string;
  account_credit_data?: PierreCreditData;
}

export interface PierreTransactionsResponse {
  success: boolean;
  data: PierreTransaction[];
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Balance (GET /get-balance)
// ---------------------------------------------------------------------------

export interface PierreBalanceAccount {
  id: string;
  name: string;
  balance: number;
  account_type: string;
  account_subtype: string;
}

export interface PierreBalanceResponse {
  success: boolean;
  data: {
    total_balance: number;
    accounts: PierreBalanceAccount[];
  };
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Bill Summary (GET /get-bill-summary)
// ---------------------------------------------------------------------------

export interface PierreBillAccount {
  transactionCount: number;
  totalAmount: number;
  isOfficialBillAmount: boolean;
  account_id: string;
  account_name: string;
  currency_code: string;
  credit_limit: number;
  available_credit_limit: number;
  used_credit_limit: number;
  current_bill_amount: number;
  balance_close_date: string | null;
  balance_due_date: string;
  minimum_payment: number;
  closing_day: number | null;
  period_start: string;
  period_end: string;
  calculated_bill_amount: number;
  transactions: PierreTransaction[];
}

export interface PierreBillSummaryResponse {
  success: boolean;
  data: {
    totalTransactions: number;
    totalAmount: number;
    isOfficialBillAmount: boolean;
    accounts: PierreBillAccount[];
    generatedAt: string;
    userId: string;
  };
  recommendations: string;
  transactionsInfo: string;
  notice: string;
  guidance: string;
  filters: {
    accountId: string | null;
    startDate: string | null;
    endDate: string | null;
  };
  timestamp: string;
  totalTransactions: number;
  totalAmount: number;
}

// ---------------------------------------------------------------------------
// Installments (GET /get-installments)
// ---------------------------------------------------------------------------

export interface PierreInstallment {
  installmentNumber: number;
  totalInstallments: number;
  amount: number;
  dueDate: string;
  isPaid: boolean;
  isProjected: boolean;
  status?: 'POSTED' | 'PENDING';
  billId?: string | null;
}

export interface PierrePurchase {
  description: string;
  totalAmount: number;
  installmentsPaid: number;
  installmentsRemaining: number;
  amountPaid: number;
  amountRemaining: number;
  hasPartialSyncData: boolean;
  installmentsInDb: number;
  firstInstallmentInDb: number;
  lastInstallmentInDb: number;
  installments: PierreInstallment[];
}

export interface PierrePurchasesByCard {
  accountId: string;
  accountName: string;
  purchases: PierrePurchase[];
}

export interface PierreInstallmentsSummary {
  totalAmount: number;
  totalInstallments: number;
  totalInstallmentsRemaining: number;
  totalAmountRemaining: number;
  totalPurchases: number;
  installmentDistribution: unknown[];
}

export interface PierreInstallmentsResponse {
  success: boolean;
  data: {
    summary: PierreInstallmentsSummary;
    purchasesByCard: PierrePurchasesByCard[];
    purchases: PierrePurchase[];
    instructions: unknown;
  };
  summary: PierreInstallmentsSummary;
  purchases: PierrePurchase[];
  dateRange: {
    startDate: string;
    endDate: string;
  };
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Manual Update (POST /manual-update)
// ---------------------------------------------------------------------------

export interface PierreManualUpdateResponse {
  success: boolean;
  message?: string;
  timestamp?: string;
}
