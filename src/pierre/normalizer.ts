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
  automaticallyInvestedBalance: number | null;
  reservedTotal: number | null;
  rawJson: string;
}

export interface NormalizedInvestment {
  id: string;
  assetName: string;
  assetType: string;
  /**
   * Net-worth semantics, not provenance: PIERRE means the money is already
   * inside some account's closingBalance (so the holding is detail only, and
   * adding it again would double count), EXTERNAL means it stands on its own
   * and must be added. A Pierre reserve proven to sit OUTSIDE its account
   * balance is therefore recorded as EXTERNAL — see detectReservePlacement.
   */
  origin: 'PIERRE' | 'EXTERNAL';
  pricingMethod: 'PIERRE' | 'GOOGLEFINANCE' | 'CDI' | 'MANUAL';
  tickerOrRate: string | null;
  quantity: number | null;
  costBasis: number | null;
  startDate: string | null;
  manualValue: number | null;
  marketValue: number | null;
  marketValueAt: string | null;
  pricingStatus: string | null;
  linkedAccountId: string | null;
  notes: string | null;
  source: 'PIERRE_RESERVED' | 'CONFIG_TAB';
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
// Reserves (caixinhas) — is the money inside closingBalance, or beside it?
// ---------------------------------------------------------------------------

/** Cent-level slack, so float noise never trips the placement check. */
const RESERVE_TOLERANCE = 0.01;

/**
 * Total held in reserves, using the same precedence as
 * extractReservedInvestments so both always describe the same money:
 * itemised reservedBalances when present, otherwise the aggregate
 * automaticallyInvestedBalance.
 *
 * Only BRL is summed — a reserve can report several availableAmounts, one per
 * currency, and adding those at face value would invent money.
 */
export function sumReservedBalances(account: PierreAccount): number {
  const bankData = account.bankData;
  if (!bankData) return 0;

  const reserves = bankData.reservedBalances ?? [];
  if (reserves.length > 0) {
    return reserves.reduce((total, reserve) => {
      const amounts = reserve.availableAmounts ?? [];
      const entry = amounts.find((a) => a.currencyCode === 'BRL') ?? amounts[0];
      return total + (entry?.amount ?? 0);
    }, 0);
  }

  return bankData.automaticallyInvestedBalance ?? 0;
}

export type ReservePlacement = 'INSIDE_BALANCE' | 'OUTSIDE_BALANCE';

/**
 * Decide whether a reserve is already counted inside closingBalance.
 *
 * A single snapshot cannot distinguish the two conventions in general: both
 * "balance includes the reserve" and "balance excludes it" produce consistent
 * numbers. There is exactly one provable case — a reserve LARGER than the
 * balance cannot be a part of it, so the balance must exclude it.
 *
 * That one-sided test is worth having because it fires precisely where the
 * error would be worst: a large caixinha against little free cash, which is
 * what an emergency fund looks like. When it does not fire we keep the
 * conservative default (INSIDE), because over-counting a balance is the
 * failure that silently inflates net worth — and the Saldo tab prints a
 * reconciliation line so a human can settle the ambiguous case in seconds.
 */
export function detectReservePlacement(
  closingBalance: number | null,
  reservedTotal: number,
): ReservePlacement {
  if (reservedTotal <= 0) return 'INSIDE_BALANCE';
  return reservedTotal > (closingBalance ?? 0) + RESERVE_TOLERANCE
    ? 'OUTSIDE_BALANCE'
    : 'INSIDE_BALANCE';
}

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
    automaticallyInvestedBalance: account.bankData?.automaticallyInvestedBalance ?? null,
    reservedTotal: account.bankData ? sumReservedBalances(account) : null,
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

/**
 * Extract reserved investments (caixinhas / automatic investments) from a Pierre account.
 */
export function extractReservedInvestments(account: PierreAccount): NormalizedInvestment[] {
  const results: NormalizedInvestment[] = [];
  const bankData = account.bankData;
  if (!bankData) return results;

  const accountName = account.connectorName
    ? `${account.connectorName} ${account.subtype === 'CREDIT_CARD' ? 'Cartão' : 'Conta'}`
    : account.name;

  // Where the reserve sits decides whether these rows are detail (already in
  // the balance) or standalone value (must be added to net worth).
  const placement = detectReservePlacement(bankData.closingBalance ?? null, sumReservedBalances(account));
  const origin: NormalizedInvestment['origin'] =
    placement === 'OUTSIDE_BALANCE' ? 'EXTERNAL' : 'PIERRE';
  const placementNote =
    placement === 'OUTSIDE_BALANCE'
      ? ' — FORA do saldo da conta, somada ao patrimônio'
      : ' — já incluída no saldo da conta';

  if (bankData.reservedBalances && bankData.reservedBalances.length > 0) {
    bankData.reservedBalances.forEach((res, idx) => {
      // A reserve can carry several availableAmounts, one per currency. Only
      // BRL belongs in a BRL net worth; picking [0] blindly would mix
      // currencies at face value. Fall back to the first entry when no
      // currency is reported at all.
      const amounts = res.availableAmounts ?? [];
      const entry = amounts.find((a) => a.currencyCode === 'BRL') ?? amounts[0];
      const amount = entry?.amount ?? 0;
      const rem = entry?.remuneration;
      const rateInfo = rem?.postFixedIndexerPercentage
        ? `${rem.postFixedIndexerPercentage}% ${rem.indexer || 'CDI'}`
        : (rem?.indexer ?? null);

      results.push({
        id: `pierre:${account.id}:${res.identification || idx}`,
        assetName: `${accountName} - ${res.identification || 'Caixinha'}`,
        assetType: 'Renda Fixa',
        origin,
        pricingMethod: 'PIERRE',
        tickerOrRate: rateInfo,
        quantity: 1,
        costBasis: amount,
        startDate: null,
        manualValue: null,
        marketValue: amount,
        marketValueAt: new Date().toISOString(),
        pricingStatus: 'OK',
        linkedAccountId: account.id,
        notes: `Reserva automática Pierre (${accountName})${placementNote}`,
        source: 'PIERRE_RESERVED',
      });
    });
  } else if (bankData.automaticallyInvestedBalance && bankData.automaticallyInvestedBalance > 0) {
    const amount = bankData.automaticallyInvestedBalance;
    results.push({
      id: `pierre:${account.id}:auto`,
      assetName: `${accountName} - Saldo Automático Investido`,
      assetType: 'Renda Fixa',
      origin,
      pricingMethod: 'PIERRE',
      tickerOrRate: null,
      quantity: 1,
      costBasis: amount,
      startDate: null,
      manualValue: null,
      marketValue: amount,
      marketValueAt: new Date().toISOString(),
      pricingStatus: 'OK',
      linkedAccountId: account.id,
      notes: `Caixinha/Aplicação automática (${accountName})${placementNote}`,
      source: 'PIERRE_RESERVED',
    });
  }

  return results;
}

