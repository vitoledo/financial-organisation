import { PierreTransaction, PierreAccount } from './types';

// ---------------------------------------------------------------------------
// Normalized domain types (what we store in SQLite)
// ---------------------------------------------------------------------------

export type TransactionDirection = 'INCOME' | 'EXPENSE' | 'TRANSFER';

export interface NormalizedTransaction {
  id: string;
  accountId: string;
  date: string;
  description: string;
  amount: number;           // Normalized: positive = income, negative = expense
  originalAmount: number;   // Raw value from Pierre
  direction: TransactionDirection;
  categoryPierre: string;
  accountName: string;
  accountType: 'BANK' | 'CREDIT';
  status: string;
  rawJson: string;
}

export interface NormalizedAccount {
  id: string;
  name: string;
  type: 'BANK' | 'CREDIT';
  subtype: string;
  connectorName: string | null;
  closingBalance: number | null;
  creditLimit: number | null;
  availableCredit: number | null;
  rawJson: string;
}

// ---------------------------------------------------------------------------
// Categories that indicate internal money movement, not real spending
// ---------------------------------------------------------------------------

const TRANSFER_CATEGORIES = new Set([
  'Pagamento de cartão de crédito',
  'Transferências',
  'Transferência',
  'Resgate',
  'Aplicação',
]);

// ---------------------------------------------------------------------------
// Account filtering — IDs/names to exclude
// ---------------------------------------------------------------------------

const EXCLUDED_ACCOUNT_NAMES = new Set([
  'Carteira',
  'Carteira Pierre',
]);

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

export function shouldExcludeAccount(account: PierreAccount): boolean {
  if (EXCLUDED_ACCOUNT_NAMES.has(account.name)) return true;
  if (account.customName && EXCLUDED_ACCOUNT_NAMES.has(account.customName)) return true;
  return false;
}

export function normalizeAccount(account: PierreAccount): NormalizedAccount {
  return {
    id: account.id,
    name: account.connectorName
      ? `${account.connectorName} ${account.subtype === 'CREDIT_CARD' ? 'Cartão' : 'Conta'}`
      : account.name,
    type: account.type,
    subtype: account.subtype,
    connectorName: account.connectorName,
    closingBalance: account.bankData?.closingBalance ?? null,
    creditLimit: account.creditData?.creditLimit ?? null,
    availableCredit: account.creditData?.availableCreditLimit ?? null,
    rawJson: JSON.stringify(account),
  };
}

/**
 * Classify the direction of a transaction and normalize its sign.
 *
 * Rules:
 * - Transfer categories → TRANSFER (sign untouched, excluded from totals)
 * - Bank account: positive amount = INCOME, negative = EXPENSE
 * - Credit card: Pierre reports purchases as positive amounts in a CREDIT
 *   account, but for us a purchase is an expense (money going out).
 *   So we invert: positive → negative (EXPENSE), negative → positive (INCOME,
 *   e.g. a refund or payment received).
 */
export function normalizeTransaction(tx: PierreTransaction): NormalizedTransaction {
  const isTransfer = TRANSFER_CATEGORIES.has(tx.category);

  let amount = tx.amount;
  let direction: TransactionDirection;

  if (isTransfer) {
    direction = 'TRANSFER';
    // Keep original sign for transfers — they cancel out
  } else if (tx.account_type === 'CREDIT') {
    // Credit card: invert sign (purchase positive → expense negative)
    amount = -tx.amount;
    direction = amount >= 0 ? 'INCOME' : 'EXPENSE';
  } else {
    // Bank account: sign is already correct
    direction = amount >= 0 ? 'INCOME' : 'EXPENSE';
  }

  return {
    id: tx.id,
    accountId: tx.account_id,
    date: tx.date,
    description: tx.description,
    amount,
    originalAmount: tx.amount,
    direction,
    categoryPierre: tx.category,
    accountName: tx.account_name,
    accountType: tx.account_type,
    status: tx.status,
    rawJson: JSON.stringify(tx),
  };
}

export function isTransferCategory(category: string): boolean {
  return TRANSFER_CATEGORIES.has(category);
}
