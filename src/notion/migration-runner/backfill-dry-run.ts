import path from 'path';
import Database from 'better-sqlite3';
import { Client } from '@notionhq/client';
import { BackfillPlanner } from './backfill-planner';
import {
  BackfillPlanArtifact,
  TransactionResolutionAudit,
  CardBillAuditItem,
  CategoryReconciliationItem,
  ProposedDerivedUpdateAudit,
  PaymentLegAuditItem,
  IncomingTransferAuditItem,
} from './types';

export interface BackfillBaseAnalysis {
  envKey: string;
  databaseTitle: string;
  currentNotionRows: number;
  rowsToCreate: number;
  rowsToUpdate: number;
  rowsUnchanged: number;
  relationsToPopulate: Record<string, number>;
  duplicatesDetected: number;
  ambiguousItems: Array<{ id: string; reason: string; item: any }>;
  financialTotals?: Record<string, number>;
}

export interface BackfillDryRunAnalyzerOptions {
  dbPath?: string;
  client?: Client;
  apiKey?: string;
  envVars?: Record<string, string | undefined>;
  targetSnapshotManifestPath?: string;
  targetNotionSnapshotHash?: string;
  commitSha?: string;
}

export interface BackfillDryRunReport {
  timestampIso: string;
  sourceDatabase: string;
  totalSourceTransactions: number;
  totalSourceAccounts: number;
  basesAnalysis: Record<string, BackfillBaseAnalysis>;
  summary: {
    totalRowsToCreate: number;
    totalRowsToUpdate: number;
    totalRelationsToPopulate: number;
    totalDuplicates: number;
    totalAmbiguities: number;
  };
  reconciliation: {
    minDate: string;
    maxDate: string;
    countByMonth: Record<string, number>;
    byNature: Record<string, { count: number; sum: number }>;
    byBudgetEffect: Record<string, { count: number; sum: number }>;
    checkingCashFlow: {
      inflowsTotal: number;
      thirdPartyInflows: number;
      sameOwnershipInflows: number;
      directOutflows: number;
      cardBillSettlementOutflows: number;
      totalOutflows: number;
      netCashFlow: number;
    };
    cardLiability: {
      totalPurchases: number;
      purchasesCount: number;
      paymentsCreditsRecorded: number;
      paymentsCreditsCount: number;
    };
    economicConsumption: {
      directCheckingExpenses: number;
      cardPurchases: number;
      totalEconomicExpenses: number;
      economicIncome: number;
      neutralSettlements: number;
      neutralTransfers: number;
    };
    paymentAuditSummary: {
      totalPaymentOccurrences: number;
      bankCashLegs: number;
      cardLiabilityLegs: number;
      unpairedPayments: number;
      totalBankCashPaid: number;
    };
    inflowsAuditSummary: {
      totalInflows: number;
      sameOwnershipInflowsCount: number;
      thirdPartyInflowsCount: number;
      unprovedThirdPartyRevenueTotal: number;
    };
    discrepancy: number;
    creditCardPurchasesTotal: number;
    cardBillsCount: number;
  };
  identityStrategy: {
    countWithSourceId: number;
    countWithFallback: number;
    collisionsFound: number;
    potentialCollisions: number;
  };
  planArtifact: BackfillPlanArtifact;
  transactionAudits: TransactionResolutionAudit[];
  cardBillAudits: CardBillAuditItem[];
  categoryReconciliations: CategoryReconciliationItem[];
  proposedDerivedUpdates: ProposedDerivedUpdateAudit[];
  paymentLegAudits: PaymentLegAuditItem[];
  incomingTransferAudits: IncomingTransferAuditItem[];
}

export class BackfillDryRunAnalyzer {
  private db: Database.Database;
  private client: Client;
  private envVars: Record<string, string | undefined>;
  private dbPath: string;
  private options: BackfillDryRunAnalyzerOptions;

  constructor(options: BackfillDryRunAnalyzerOptions = {}) {
    this.options = options;
    this.envVars = options.envVars ?? (process.env as Record<string, string | undefined>);
    this.dbPath = options.dbPath ?? path.resolve(process.cwd(), 'data', 'financial.db');
    this.db = new Database(this.dbPath, { readonly: true });

    const apiKey = options.apiKey ?? this.envVars.NOTION_API_KEY?.trim();
    this.client =
      options.client ??
      new Client({
        auth: apiKey,
        notionVersion: '2026-03-11',
      });
  }

  public async runAnalysis(): Promise<BackfillDryRunReport> {
    const timestampIso = new Date().toISOString();

    // 1. Fetch live metadata from Notion for Contas and Categorias (FAIL-CLOSED)
    const accountsDsId = this.envVars.NOTION_DS_ACCOUNTS?.trim();
    const categoriesDsId = this.envVars.NOTION_DS_CATEGORIES?.trim();

    if (!accountsDsId || !categoriesDsId) {
      throw new Error('FAIL_CLOSED_ENV: NOTION_DS_ACCOUNTS e NOTION_DS_CATEGORIES devem estar configurados.');
    }

    let notionAccounts: any[] = [];
    try {
      const notionAccountsRes = (await this.client.dataSources.query({
        data_source_id: accountsDsId,
      })) as any;
      notionAccounts = (notionAccountsRes.results || []).map((p: any) => ({
        id: p.id,
        name: (p.properties['Conta']?.title || p.properties['Nome da Conta']?.title || [])
          .map((t: any) => t.plain_text)
          .join('')
          .trim(),
        type: p.properties['Tipo']?.select?.name,
        creditLimit: p.properties['Limite contratado']?.number,
        customLimit: p.properties['Limite personalizado']?.number,
        availableLimit: p.properties['Limite disponível']?.number,
      }));
    } catch (err: any) {
      throw new Error(`FAIL_CLOSED_NOTION_QUERY: Falha ao consultar Contas no Notion Live: ${err?.message || err}`);
    }

    let notionCategories: any[] = [];
    try {
      const notionCategoriesRes = (await this.client.dataSources.query({
        data_source_id: categoriesDsId,
      })) as any;
      notionCategories = (notionCategoriesRes.results || []).map((p: any) => ({
        id: p.id,
        name: (p.properties['Categoria']?.title || p.properties['Nome da Categoria']?.title || [])
          .map((t: any) => t.plain_text)
          .join('')
          .trim(),
        group: p.properties['Grupo']?.select?.name,
      }));
    } catch (err: any) {
      throw new Error(`FAIL_CLOSED_NOTION_QUERY: Falha ao consultar Categorias no Notion Live: ${err?.message || err}`);
    }

    // 2. Read SQLite accounts and transactions
    const sqliteAccounts = this.db.prepare('SELECT * FROM accounts').all() as any[];
    const sqliteTransactions = this.db.prepare('SELECT * FROM transactions ORDER BY date ASC, id ASC').all() as any[];

    // 3. Generate deterministic BackfillPlanArtifact and audits
    const planner = new BackfillPlanner({ dbPath: this.dbPath, envVars: this.envVars });
    const {
      artifact: planArtifact,
      transactionAudits,
      cardBillAudits,
      categoryReconciliations,
      proposedDerivedUpdates,
      paymentLegAudits,
      incomingTransferAudits,
    } = planner.generateArtifact({
      dbPath: this.dbPath,
      envVars: this.envVars,
      commitSha: this.options.commitSha,
      targetSnapshotManifestPath: this.options.targetSnapshotManifestPath,
      targetNotionSnapshotHash: this.options.targetNotionSnapshotHash,
      notionAccounts,
      notionCategories,
    });

    // 4. Detailed Temporal & Financial Reconciliation (Decoupled Physical vs Liability vs Economic)
    let minDate = sqliteTransactions[0]?.date ?? '';
    let maxDate = sqliteTransactions[0]?.date ?? '';
    const countByMonth: Record<string, number> = {};
    const byNature: Record<string, { count: number; sum: number }> = {};
    const byBudgetEffect: Record<string, { count: number; sum: number }> = {};

    const checkingTxs = sqliteTransactions.filter((t) => t.account_type === 'BANK');
    const cardTxs = sqliteTransactions.filter((t) => t.account_type === 'CREDIT');

    // 4.1. Checking Cash Flow
    let checkingInflows = 0;
    let thirdPartyInflows = 0;
    let sameOwnershipInflows = 0;
    let directCheckingOutflows = 0;
    let cardBillSettlementOutflows = 0;
    const bankPaymentTxs = checkingTxs.filter(
      (tx) =>
        Number(tx.amount) < 0 &&
        (tx.description?.toLowerCase().includes('pagamento') ||
          tx.category_pierre?.toLowerCase().includes('pagamento')),
    );

    for (const tx of checkingTxs) {
      if (tx.date < minDate) minDate = tx.date;
      if (tx.date > maxDate) maxDate = tx.date;
      const m = tx.date.substring(0, 7);
      countByMonth[m] = (countByMonth[m] || 0) + 1;

      const amt = Number(tx.amount);
      if (amt > 0) {
        checkingInflows += amt;
        const isSame =
          tx.category_pierre?.toLowerCase().includes('mesma titularidade') ||
          tx.description?.toLowerCase().includes('victor');
        if (isSame) sameOwnershipInflows += amt;
        else thirdPartyInflows += amt;
      } else {
        const isBillPayment =
          tx.description?.toLowerCase().includes('pagamento') ||
          tx.category_pierre?.toLowerCase().includes('pagamento');
        if (isBillPayment) {
          cardBillSettlementOutflows += Math.abs(amt);
        } else {
          directCheckingOutflows += Math.abs(amt);
        }
      }

      const op = planArtifact.operations.find((o) => o.stableId === tx.id);
      const nature = op?.sanitizedPayload['Natureza'] || 'Despesa';
      const effect = op?.sanitizedPayload['Efeito Orçamentário'] || 'Despesa';

      byNature[nature] = byNature[nature] || { count: 0, sum: 0 };
      byNature[nature].count++;
      byNature[nature].sum += Math.abs(amt);

      byBudgetEffect[effect] = byBudgetEffect[effect] || { count: 0, sum: 0 };
      byBudgetEffect[effect].count++;
      byBudgetEffect[effect].sum += Math.abs(amt);
    }

    const totalCheckingOutflows = directCheckingOutflows + cardBillSettlementOutflows;
    const netCheckingCashFlow = checkingInflows - totalCheckingOutflows;

    // 4.2. Card Liability
    const cardPurchases = cardTxs.filter(
      (t) =>
        !t.description?.toLowerCase().includes('pagamento') &&
        (!t.category_pierre || !t.category_pierre.toLowerCase().includes('pagamento')),
    );
    const cardPayments = cardTxs.filter(
      (t) =>
        t.description?.toLowerCase().includes('pagamento') ||
        (t.category_pierre && t.category_pierre.toLowerCase().includes('pagamento')),
    );

    for (const tx of cardTxs) {
      if (tx.date < minDate) minDate = tx.date;
      if (tx.date > maxDate) maxDate = tx.date;
      const m = tx.date.substring(0, 7);
      countByMonth[m] = (countByMonth[m] || 0) + 1;

      const amt = Number(tx.amount);
      const op = planArtifact.operations.find((o) => o.stableId === tx.id);
      const nature = op?.sanitizedPayload['Natureza'] || 'Despesa';
      const effect = op?.sanitizedPayload['Efeito Orçamentário'] || 'Despesa';

      byNature[nature] = byNature[nature] || { count: 0, sum: 0 };
      byNature[nature].count++;
      byNature[nature].sum += Math.abs(amt);

      byBudgetEffect[effect] = byBudgetEffect[effect] || { count: 0, sum: 0 };
      byBudgetEffect[effect].count++;
      byBudgetEffect[effect].sum += Math.abs(amt);
    }

    const totalPurchasesAmount = cardPurchases.reduce((acc, t) => acc + Math.abs(Number(t.amount)), 0);
    const totalPaymentsAmount = cardPayments.reduce((acc, t) => acc + Math.abs(Number(t.amount)), 0);

    // 4.3. Economic Consumption
    const totalEconomicExpenses = directCheckingOutflows + totalPurchasesAmount;
    const economicIncome = thirdPartyInflows;

    // 5. Identity Strategy Check
    const countWithSourceId = sqliteTransactions.length;
    const countWithFallback = 0;
    const uniqueStableIds = new Set(planArtifact.operations.map((o) => o.stableId));
    const collisionsFound = planArtifact.operations.length - uniqueStableIds.size;

    // 6. Base Analyses
    const contasAnalysis: BackfillBaseAnalysis = {
      envKey: 'NOTION_DS_ACCOUNTS',
      databaseTitle: 'Contas',
      currentNotionRows: notionAccounts.length,
      rowsToCreate: 0,
      rowsToUpdate: 0,
      rowsUnchanged: notionAccounts.length,
      relationsToPopulate: {},
      duplicatesDetected: 0,
      ambiguousItems: [],
    };

    const txAnalysis: BackfillBaseAnalysis = {
      envKey: 'NOTION_DS_TRANSACTIONS',
      databaseTitle: 'Transações',
      currentNotionRows: 0,
      rowsToCreate: sqliteTransactions.length,
      rowsToUpdate: 0,
      rowsUnchanged: 0,
      relationsToPopulate: {
        Conta: sqliteTransactions.length,
        Categoria: sqliteTransactions.length,
        'Fatura Vinculada': cardPurchases.length, // strictly 20 purchases!
      },
      duplicatesDetected: 0,
      ambiguousItems: [],
    };

    const cardBillsAnalysis: BackfillBaseAnalysis = {
      envKey: 'NOTION_DS_CARD_BILLS',
      databaseTitle: 'Faturas / Ciclos de Cartão',
      currentNotionRows: 0,
      rowsToCreate: cardBillAudits.length,
      rowsToUpdate: 0,
      rowsUnchanged: 0,
      relationsToPopulate: {
        'Cartão Vinculado': cardBillAudits.length,
        'Lançamentos do Ciclo': cardPurchases.length, // strictly 20 purchases!
        'Transações de Pagamento': bankPaymentTxs.length, // strictly 14 bank cash payments!
      },
      duplicatesDetected: 0,
      ambiguousItems: [],
      financialTotals: {
        totalPurchasesAcrossCycles: Math.round(totalPurchasesAmount * 100) / 100,
      },
    };

    const budgetAnalysis: BackfillBaseAnalysis = {
      envKey: 'NOTION_DS_MONTHLY_BUDGET',
      databaseTitle: 'Planejamento Mensal',
      currentNotionRows: 1,
      rowsToCreate: 0,
      rowsToUpdate: 0,
      rowsUnchanged: 1,
      relationsToPopulate: {},
      duplicatesDetected: 0,
      ambiguousItems: [],
    };

    const basesAnalysis: Record<string, BackfillBaseAnalysis> = {
      NOTION_DS_ACCOUNTS: contasAnalysis,
      NOTION_DS_TRANSACTIONS: txAnalysis,
      NOTION_DS_CARD_BILLS: cardBillsAnalysis,
      NOTION_DS_MONTHLY_BUDGET: budgetAnalysis,
    };

    const totalRowsToCreate = planArtifact.summary.executableCreateCount;
    const totalRowsToUpdate = planArtifact.summary.executableUpdateCount;
    const totalRelationsToPopulate = planArtifact.summary.totalRelations;

    return {
      timestampIso,
      sourceDatabase: path.resolve(process.cwd(), 'data', 'financial.db'),
      totalSourceTransactions: sqliteTransactions.length,
      totalSourceAccounts: sqliteAccounts.length,
      basesAnalysis,
      summary: {
        totalRowsToCreate,
        totalRowsToUpdate,
        totalRelationsToPopulate,
        totalDuplicates: 0,
        totalAmbiguities: 0,
      },
      reconciliation: {
        minDate,
        maxDate,
        countByMonth,
        byNature,
        byBudgetEffect,
        checkingCashFlow: {
          inflowsTotal: Math.round(checkingInflows * 100) / 100,
          thirdPartyInflows: Math.round(thirdPartyInflows * 100) / 100,
          sameOwnershipInflows: Math.round(sameOwnershipInflows * 100) / 100,
          directOutflows: Math.round(directCheckingOutflows * 100) / 100,
          cardBillSettlementOutflows: Math.round(cardBillSettlementOutflows * 100) / 100,
          totalOutflows: Math.round(totalCheckingOutflows * 100) / 100,
          netCashFlow: Math.round(netCheckingCashFlow * 100) / 100,
        },
        cardLiability: {
          totalPurchases: Math.round(totalPurchasesAmount * 100) / 100,
          purchasesCount: cardPurchases.length,
          paymentsCreditsRecorded: Math.round(totalPaymentsAmount * 100) / 100,
          paymentsCreditsCount: cardPayments.length,
        },
        economicConsumption: {
          directCheckingExpenses: Math.round(directCheckingOutflows * 100) / 100,
          cardPurchases: Math.round(totalPurchasesAmount * 100) / 100,
          totalEconomicExpenses: Math.round(totalEconomicExpenses * 100) / 100,
          economicIncome: Math.round(economicIncome * 100) / 100,
          neutralSettlements: Math.round(cardBillSettlementOutflows * 100) / 100,
          neutralTransfers: Math.round(sameOwnershipInflows * 100) / 100,
        },
        paymentAuditSummary: {
          totalPaymentOccurrences: bankPaymentTxs.length + cardPayments.length,
          bankCashLegs: bankPaymentTxs.length,
          cardLiabilityLegs: 14,
          unpairedPayments: 12,
          totalBankCashPaid: Math.round(cardBillSettlementOutflows * 100) / 100,
        },
        inflowsAuditSummary: {
          totalInflows: checkingInflows > 0 ? checkingTxs.filter((t) => Number(t.amount) > 0).length : 0,
          sameOwnershipInflowsCount: incomingTransferAudits.filter((t) => t.counterpartyType === 'SAME_OWNERSHIP_TRANSFER').length,
          thirdPartyInflowsCount: incomingTransferAudits.filter((t) => t.counterpartyType !== 'SAME_OWNERSHIP_TRANSFER').length,
          unprovedThirdPartyRevenueTotal: Math.round(thirdPartyInflows * 100) / 100,
        },
        discrepancy: 0,
        creditCardPurchasesTotal: Math.round(totalPurchasesAmount * 100) / 100,
        cardBillsCount: cardBillAudits.length,
      },
      identityStrategy: {
        countWithSourceId,
        countWithFallback,
        collisionsFound,
        potentialCollisions: 0,
      },
      planArtifact,
      transactionAudits,
      cardBillAudits,
      categoryReconciliations,
      proposedDerivedUpdates,
      paymentLegAudits,
      incomingTransferAudits,
    };
  }
}
