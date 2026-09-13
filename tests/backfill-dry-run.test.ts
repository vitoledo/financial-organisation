import { describe, it, expect } from 'vitest';
import { BackfillDryRunAnalyzer } from '../src/notion/migration-runner/backfill-dry-run';
import { BackfillPlanner } from '../src/notion/migration-runner/backfill-planner';

describe('BackfillDryRunAnalyzer & BackfillPlanner', () => {
  const fakeClient: any = {
    dataSources: {
      query: async (args: { data_source_id: string }) => {
        return {
          results: [
            {
              id: '3d8a3ece-fa49-8112-9399-c960be4f604a',
              properties: {
                Conta: { title: [{ plain_text: 'Nubank Cartão' }] },
                Tipo: { select: { name: 'Cartão de crédito' } },
                'Limite contratado': { number: 2400 },
                'Limite personalizado': { number: 400 },
                'Limite disponível': { number: 261.35 },
              },
            },
            {
              id: '3d8a3ece-fa49-81cd-9951-c9e484acd9ce',
              properties: {
                Conta: { title: [{ plain_text: 'Nubank Conta' }] },
                Tipo: { select: { name: 'Conta corrente' } },
              },
            },
            {
              id: '3d8a3ece-fa49-81fe-91b0-e104783a85f4',
              properties: {
                Conta: { title: [{ plain_text: 'Mercado Pago' }] },
                Tipo: { select: { name: 'Conta corrente' } },
              },
            },
          ],
          has_more: false,
        };
      },
    },
  };

  const testEnv = {
    NOTION_API_KEY: '',
    NOTION_DS_ACCOUNTS: 'fake-acc-ds',
    NOTION_DS_CATEGORIES: 'fake-cat-ds',
    NOTION_DS_TRANSACTIONS: 'fake-tx-ds',
    NOTION_DS_CARD_BILLS: 'fake-bills-ds',
    NOTION_DS_MONTHLY_BUDGET: 'fake-budget-ds',
    NOTION_TARGET_SNAPSHOT_MANIFEST: 'backups/notion-data-snapshot-20260913T190702-0a3af05c.json.enc.manifest.json',
  };

  it('resolves 155/155 transactions deterministically via SOURCE_ACCOUNT_ID with 0 UNRESOLVED', async () => {
    const analyzer = new BackfillDryRunAnalyzer({
      client: fakeClient,
      envVars: testEnv,
    });

    const report = await analyzer.runAnalysis();

    expect(report.totalSourceTransactions).toBe(155);
    expect(report.totalSourceAccounts).toBe(2);

    const unresolved = report.transactionAudits.filter((t) => t.resolutionMethod === 'UNRESOLVED');
    expect(unresolved).toHaveLength(0);

    const nubankConta = report.transactionAudits.filter((t) => t.resolvedAccountName === 'Nubank Conta');
    expect(nubankConta).toHaveLength(109);
    expect(nubankConta.every((t) => t.resolutionMethod === 'SOURCE_ACCOUNT_ID')).toBe(true);
    expect(nubankConta.every((t) => t.confidenceStatus === 'VERY_HIGH')).toBe(true);

    const nubankCartao = report.transactionAudits.filter((t) => t.resolvedAccountName === 'Nubank Cartão');
    expect(nubankCartao).toHaveLength(46);
    expect(nubankCartao.every((t) => t.resolutionMethod === 'SOURCE_ACCOUNT_ID')).toBe(true);
    expect(nubankCartao.every((t) => t.confidenceStatus === 'VERY_HIGH')).toBe(true);
  });

  it('audits card bills with approximate quality, null official value, and no duplicate purchases', async () => {
    const analyzer = new BackfillDryRunAnalyzer({
      client: fakeClient,
      envVars: testEnv,
    });

    const report = await analyzer.runAnalysis();

    expect(report.cardBillAudits).toHaveLength(4);
    expect(report.cardBillAudits.every((b) => b.valorOficial === null)).toBe(true);
    expect(report.cardBillAudits.filter((b) => b.qualidade === 'UPSTREAM_APPROXIMATE')).toHaveLength(3);
    expect(report.cardBillAudits.filter((b) => b.qualidade === 'DERIVED')).toHaveLength(1);

    const totalPurchasesAcrossBills = report.cardBillAudits.reduce((acc, b) => acc + b.somaCompras, 0);
    expect(Math.round(totalPurchasesAcrossBills * 100) / 100).toBe(649.79);

    const totalPurchasesCount = report.cardBillAudits.reduce((acc, b) => acc + b.nCompras, 0);
    expect(totalPurchasesCount).toBe(20);
  });

  it('suspends derived updates under OUT_OF_SCOPE_NOT_EXECUTED', async () => {
    const analyzer = new BackfillDryRunAnalyzer({
      client: fakeClient,
      envVars: testEnv,
    });

    const report = await analyzer.runAnalysis();

    expect(report.proposedDerivedUpdates).toHaveLength(2);
    expect(report.summary.totalRowsToUpdate).toBe(0); // zero executable updates!
    expect(
      report.proposedDerivedUpdates.every((u) => u.status === 'OUT_OF_SCOPE_NOT_EXECUTED'),
    ).toBe(true);
  });

  it('reconciles 17 category pairs without silent generic defaults', async () => {
    const analyzer = new BackfillDryRunAnalyzer({
      client: fakeClient,
      envVars: testEnv,
    });

    const report = await analyzer.runAnalysis();

    expect(report.categoryReconciliations).toHaveLength(17);
    const totalCategorizedTxs = report.categoryReconciliations.reduce((acc, c) => acc + c.quantidade, 0);
    expect(totalCategorizedTxs).toBe(106); // 155 minus 36 pending third-party inflows minus 13 third-party transfers pending review
  });

  it('guarantees deterministic reproducibility of backfillPlanHash', () => {
    const sampleNotionAccounts = [
      {
        id: '3d8a3ece-fa49-8112-9399-c960be4f604a',
        name: 'Nubank Cartão',
        type: 'Cartão de crédito',
        creditLimit: 2400,
        customLimit: 400,
        availableLimit: 261.35,
      },
      {
        id: '3d8a3ece-fa49-81cd-9951-c9e484acd9ce',
        name: 'Nubank Conta',
        type: 'Conta corrente',
      },
    ];
    const sampleNotionCategories = [
      { id: 'cat-1', name: 'Alimentação' },
      { id: 'cat-2', name: 'Moradia' },
      { id: 'cat-3', name: 'Transporte' },
      { id: 'cat-4', name: 'Lazer' },
      { id: 'cat-5', name: 'Saúde' },
      { id: 'cat-6', name: 'Educação' },
      { id: 'cat-7', name: 'Assinaturas & Serviços' },
      { id: 'cat-8', name: 'Cuidados Pessoais' },
      { id: 'cat-9', name: 'Vestuário' },
      { id: 'cat-10', name: 'Compras & Variados' },
      { id: 'cat-11', name: 'Presentes & Doações' },
      { id: 'cat-12', name: 'Taxas & Tarifas' },
      { id: 'cat-13', name: 'Impostos' },
      { id: 'cat-14', name: 'Pagamento de Fatura' },
      { id: 'cat-15', name: 'Transferência Interna' },
      { id: 'cat-16', name: 'Receita' },
      { id: 'cat-17', name: 'Rendimento' },
      { id: 'cat-18', name: 'Outros' },
    ];
    const planner = new BackfillPlanner({ envVars: testEnv });
    const run1 = planner.generateArtifact({
      notionAccounts: sampleNotionAccounts,
      notionCategories: sampleNotionCategories,
    });
    const run2 = planner.generateArtifact({
      notionAccounts: sampleNotionAccounts,
      notionCategories: sampleNotionCategories,
    });

    expect(run1.artifact.backfillPlanHash).toBe(run2.artifact.backfillPlanHash);
    expect(run1.artifact.operations).toEqual(run2.artifact.operations);
    expect(run1.artifact.summary.executableCreateCount).toBe(159);
    expect(run1.artifact.summary.executableUpdateCount).toBe(0);
    expect(run1.artifact.summary.proposedReviewCount).toBe(0);
  });

  it('evaluates READY_FOR_EXECUTOR_IMPLEMENTATION and readyForApply as false due to unverified offline state', async () => {
    const analyzer = new BackfillDryRunAnalyzer({
      client: fakeClient,
      envVars: testEnv,
    });

    const report = await analyzer.runAnalysis();

    expect(report.planArtifact.readiness.readyForExecutorImplementation).toBe(false);
    expect(report.planArtifact.readiness.readyForApply).toBe(false);
    expect(report.planArtifact.readiness.pendingEconomicClassificationCount).toBe(36);
    expect(report.planArtifact.readiness.blockers.length).toBeGreaterThan(0);
  });

  it('reconciles decoupled checking cash flow, credit card liability, and economic consumption', async () => {
    const analyzer = new BackfillDryRunAnalyzer({
      client: fakeClient,
      envVars: testEnv,
    });

    const report = await analyzer.runAnalysis();
    const r = report.reconciliation;

    // Physical checking cash flow
    expect(r.checkingCashFlow.directOutflows).toBe(2062.71);
    expect(r.checkingCashFlow.outgoingInternalTransfers).toBe(115.0);
    expect(r.checkingCashFlow.cardBillSettlementOutflows).toBe(280.46);
    expect(r.checkingCashFlow.totalOutflows).toBe(2458.17);

    // Credit card liability
    expect(r.cardLiability.totalPurchases).toBe(649.79);
    expect(r.cardLiability.purchasesCount).toBe(20);

    // Decoupled economic consumption: Direct checking (2062.71) + Card purchases (649.79) = R$ 2.712,50
    expect(r.economicConsumption.directCheckingExpenses).toBe(2062.71);
    expect(r.economicConsumption.cardPurchases).toBe(649.79);
    expect(r.economicConsumption.totalEconomicExpenses).toBe(2712.5);
    expect(r.economicConsumption.pendingThirdPartyInflows).toBe(2294.39);
    expect(r.discrepancy).toBe(0);

    // Payment event allocations: 15 events, 0 unresolved
    expect(report.paymentEventAllocations).toHaveLength(15);
    expect(
      report.paymentEventAllocations.every((a) => a.method !== 'UNRESOLVED_PAYMENT_ALLOCATION'),
    ).toBe(true);

    // Dynamic checks
    expect(report.planArtifact.readiness.checks.unresolvedPaymentAllocationsZero).toBe(true);
    expect(report.planArtifact.readiness.checks.financialDiscrepancyZero).toBe(true);
  });
});
