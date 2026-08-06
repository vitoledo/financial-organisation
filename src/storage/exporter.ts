import fs from 'fs';
import path from 'path';
import { Repository } from './repository';

export interface FinancialSummary {
  exportedAt: string;
  netWorth: {
    totalAccountsBalance: number;
    externalInvestmentsMarketValue: number;
    pierreInvestmentsMarketValue: number;
    totalNetWorth: number;
    /**
     * True when at least one holding had no usable quote and its cost basis was
     * substituted into the totals above. The per-asset `marketValue` stays null
     * in that case — an agent must be able to tell a priced position from an
     * unpriced one instead of reading cost basis as if it were a quote.
     */
    usesCostBasisFallback: boolean;
    unpricedAssets: string[];
  };
  accounts: Array<{
    name: string;
    type: string;
    subtype: string;
    closingBalance: number | null;
  }>;
  investments: Array<{
    id: string;
    assetName: string;
    assetType: string;
    origin: string;
    pricingMethod: string;
    quantity: number | null;
    costBasis: number | null;
    marketValue: number | null;
    pricingStatus: string | null;
    notes: string | null;
  }>;
  openInstallments: Array<{
    purchaseDescription: string | null;
    installment: string;
    amount: number;
    dueDate: string | null;
    accountName: string | null;
  }>;
  recentTransactions: Array<{
    date: string;
    description: string;
    category: string | null;
    group: string | null;
    direction: string;
    amount: number;
    accountName: string | null;
  }>;
}

export function buildFinancialSummary(repo: Repository): FinancialSummary {
  const accounts = repo.getAllAccounts();
  const investments = repo.getAllInvestments();
  const installments = repo.getUnpaidInstallments();
  const allTxs = repo.getAllTransactions();

  // Last 90 days filter for recent transactions
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const minDate = ninetyDaysAgo.toISOString().split('T')[0];

  const recentTransactions = allTxs
    .filter((tx) => tx.date >= minDate)
    .map((tx) => ({
      date: tx.date,
      description: tx.description,
      category: tx.category_mapped || tx.category_pierre,
      group: tx.category_group,
      direction: tx.direction,
      amount: tx.amount,
      accountName: tx.account_name,
    }));

  const totalAccountsBalance = accounts
    .filter((acc) => acc.subtype === 'CHECKING_ACCOUNT' || acc.subtype === 'SAVINGS')
    .reduce((acc, current) => acc + (current.closing_balance ?? 0), 0);

  // Aggregates fall back to cost basis so a single unpriced asset does not
  // silently shrink the net worth to zero — but the substitution is declared
  // via usesCostBasisFallback / unpricedAssets rather than hidden.
  const valueForTotals = (inv: (typeof investments)[number]): number =>
    inv.market_value ?? inv.manual_value ?? inv.cost_basis ?? 0;

  const isPriced = (inv: (typeof investments)[number]): boolean =>
    inv.market_value !== null || inv.manual_value !== null;

  const externalInvestmentsMarketValue = investments
    .filter((inv) => inv.origin === 'EXTERNAL')
    .reduce((acc, current) => acc + valueForTotals(current), 0);

  const pierreInvestmentsMarketValue = investments
    .filter((inv) => inv.origin === 'PIERRE')
    .reduce((acc, current) => acc + valueForTotals(current), 0);

  const unpricedAssets = investments.filter((inv) => !isPriced(inv)).map((inv) => inv.asset_name);

  return {
    exportedAt: new Date().toISOString(),
    netWorth: {
      totalAccountsBalance,
      externalInvestmentsMarketValue,
      pierreInvestmentsMarketValue,
      totalNetWorth: totalAccountsBalance + externalInvestmentsMarketValue,
      usesCostBasisFallback: unpricedAssets.length > 0,
      unpricedAssets,
    },
    accounts: accounts.map((acc) => ({
      name: acc.name,
      type: acc.type,
      subtype: acc.subtype,
      closingBalance: acc.closing_balance,
    })),
    investments: investments.map((inv) => ({
      id: inv.id,
      assetName: inv.asset_name,
      assetType: inv.asset_type,
      origin: inv.origin,
      pricingMethod: inv.pricing_method,
      quantity: inv.quantity,
      costBasis: inv.cost_basis,
      // Deliberately NOT falling back to cost_basis: an unpriced holding
      // reports null, and pricingStatus says why. Cost basis is right there in
      // its own field if a consumer wants to use it as a proxy knowingly.
      marketValue: inv.market_value ?? inv.manual_value,
      pricingStatus: inv.pricing_status,
      notes: inv.notes,
    })),
    openInstallments: installments.map((inst) => ({
      purchaseDescription: inst.purchase_description,
      installment: `${inst.installment_number}/${inst.total_installments}`,
      amount: inst.amount,
      dueDate: inst.due_date,
      accountName: inst.account_name,
    })),
    recentTransactions,
  };
}

export function writeFinancialSummary(summary: FinancialSummary, filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const json = JSON.stringify(summary, null, 2);
  fs.writeFileSync(filePath, json, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Mode/chmod may not be supported on all OS platforms (e.g. Windows ACLs)
  }
}
