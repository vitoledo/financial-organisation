import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
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
    SOURCE_SQLITE_SNAPSHOT_MANIFEST: 'backups/financial-backup-20260914T023409-a6df794b.db.enc.manifest.json',
    BACKFILL_ACCOUNT_MAPPING_PATH: 'data/account-mapping.json',
    MIGRATION_BACKUP_KEY: 'a70161f1e03d46710d676c2f4edaa496a9cb8c0ec2ef449e13284ad67513d05f',
    COUNTERPARTY_HMAC_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
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

  it('suspends derived updates with zero updates to execute (Phase 2A.5 clean state)', async () => {
    const analyzer = new BackfillDryRunAnalyzer({
      client: fakeClient,
      envVars: testEnv,
    });

    const report = await analyzer.runAnalysis();

    expect(report.proposedDerivedUpdates).toHaveLength(0);
    expect(report.summary.totalRowsToUpdate).toBe(0); // strictly zero executable updates!
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
    expect(report.planArtifact.readiness.pendingEconomicClassificationCount).toBe(49);
    expect(report.planArtifact.readiness.pendingCategoryReviewCount).toBe(13);
    expect(report.planArtifact.readiness.checks.unresolvedCategoryErrorsZero).toBe(true);
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
    expect(r.checkingCashFlow.directOutflows).toBe(1899.12);
    expect(r.checkingCashFlow.pendingOutflows).toBe(163.59);
    expect(r.checkingCashFlow.outgoingInternalTransfers).toBe(115.0);
    expect(r.checkingCashFlow.cardBillSettlementOutflows).toBe(280.46);
    expect(r.checkingCashFlow.totalOutflows).toBe(2458.17);

    // Credit card liability
    expect(r.cardLiability.totalPurchases).toBe(649.79);
    expect(r.cardLiability.purchasesCount).toBe(20);

    // Decoupled economic consumption: Direct checking (1899.12) + Card purchases (649.79) = R$ 2.548,91
    expect(r.economicConsumption.directCheckingExpenses).toBe(1899.12);
    expect(r.economicConsumption.cardPurchases).toBe(649.79);
    expect(r.economicConsumption.totalEconomicExpenses).toBe(2548.91);
    expect(r.economicConsumption.confirmedEconomicExpenses).toBe(2548.91);
    expect(r.economicConsumption.pendingEconomicOutflows).toBe(163.59);
    expect(r.economicConsumption.physicalCashOutflows).toBe(2458.17);
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

  it('throws FAIL_CLOSED_TARGET_SNAPSHOT when NOTION_TARGET_SNAPSHOT_MANIFEST is missing', async () => {
    const envWithoutTarget = { ...testEnv, NOTION_TARGET_SNAPSHOT_MANIFEST: '' };
    const analyzer = new BackfillDryRunAnalyzer({
      client: fakeClient,
      envVars: envWithoutTarget,
    });

    await expect(analyzer.runAnalysis()).rejects.toThrow(/FAIL_CLOSED_TARGET_SNAPSHOT/);
  });

  it('throws FAIL_CLOSED_SOURCE_SNAPSHOT when SOURCE_SQLITE_SNAPSHOT_MANIFEST is missing', async () => {
    const envWithoutSource = { ...testEnv, SOURCE_SQLITE_SNAPSHOT_MANIFEST: '' };
    const analyzer = new BackfillDryRunAnalyzer({
      client: fakeClient,
      envVars: envWithoutSource,
    });

    await expect(analyzer.runAnalysis()).rejects.toThrow(/FAIL_CLOSED_SOURCE_SNAPSHOT/);
  });

  it('throws FAIL_CLOSED_SOURCE_SNAPSHOT when SOURCE_SQLITE_SNAPSHOT_MANIFEST points to non-existent file', async () => {
    const envWithMissingSource = { ...testEnv, SOURCE_SQLITE_SNAPSHOT_MANIFEST: 'backups/non-existent.json' };
    const analyzer = new BackfillDryRunAnalyzer({
      client: fakeClient,
      envVars: envWithMissingSource,
    });

    await expect(analyzer.runAnalysis()).rejects.toThrow(/FAIL_CLOSED_SOURCE_SNAPSHOT/);
  });

  it('guarantees source isolation: mutating a copy of SQLite DB and passing as dbPath does not alter dry-run report because it strictly reads the snapshot', async () => {
    const analyzer = new BackfillDryRunAnalyzer({
      client: fakeClient,
      envVars: testEnv,
    });
    const baselineReport = await analyzer.runAnalysis();

    // Create copy in tempDir, mutate only copy B, point options.dbPath to it
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-dryrun-isolation-'));
    const copyDbPath = path.join(tempDir, 'financial-copy.db');
    fs.copyFileSync(path.resolve(process.cwd(), 'data', 'financial.db'), copyDbPath);

    const copyDb = new Database(copyDbPath);
    const existingAcc = (copyDb.prepare('SELECT id FROM accounts LIMIT 1').get() as any)?.id;
    const tempTxId = 'drift-test-temp-tx-' + Date.now();
    try {
      copyDb
        .prepare(
          "INSERT INTO transactions (id, account_id, date, amount, original_amount, direction, description, account_type) VALUES (?, ?, '2026-09-01', -100.0, -100.0, 'OUTFLOW', 'Drift test tx', 'BANK')",
        )
        .run(tempTxId, existingAcc);
      copyDb.close();

      // Pass dbPath pointing to the mutated copy B
      const driftedAnalyzer = new BackfillDryRunAnalyzer({
        client: fakeClient,
        envVars: testEnv,
        dbPath: copyDbPath,
      });
      const driftedReport = await driftedAnalyzer.runAnalysis();

      expect(driftedReport.totalSourceTransactions).toBe(155);
      expect(driftedReport.planArtifact.backfillPlanHash).toBe(baselineReport.planArtifact.backfillPlanHash);
      expect(driftedReport.totalSourceTransactions).toBe(baselineReport.totalSourceTransactions);
    } finally {
      try {
        if (fs.existsSync(copyDbPath)) fs.unlinkSync(copyDbPath);
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('certifies data/financial.db is never mutated or written to during test runs', async () => {
    const liveDbPath = path.resolve(process.cwd(), 'data', 'financial.db');
    if (!fs.existsSync(liveDbPath)) return;
    const initialStats = fs.statSync(liveDbPath);
    const initialHash = crypto.createHash('sha256').update(fs.readFileSync(liveDbPath)).digest('hex');

    // Run analyzer
    const analyzer = new BackfillDryRunAnalyzer({
      client: fakeClient,
      envVars: testEnv,
    });
    await analyzer.runAnalysis();

    const currentStats = fs.statSync(liveDbPath);
    const currentHash = crypto.createHash('sha256').update(fs.readFileSync(liveDbPath)).digest('hex');

    expect(currentStats.mtimeMs).toBe(initialStats.mtimeMs);
    expect(currentHash).toBe(initialHash);
  });

  it('detects target live drift when live Notion differs from frozen snapshot (negative proof)', async () => {
    const analyzer = new BackfillDryRunAnalyzer({
      client: fakeClient,
      envVars: testEnv,
    });
    // Decrypt snapshot to get canonical baseline bases
    const targetSession = analyzer.prepareValidatedTargetSnapshot();
    const baselineBases = targetSession.payload.bases;
    targetSession.cleanup();

    // 1. When liveBases matches frozen snapshot exactly:
    const matchedAnalyzer = new BackfillDryRunAnalyzer({
      client: fakeClient,
      envVars: testEnv,
      liveBases: baselineBases,
    });
    const matchedReport = await matchedAnalyzer.runAnalysis();
    expect(matchedReport.targetDriftReport).toBeDefined();
    expect(matchedReport.targetDriftReport?.driftDetected).toBe(false);
    expect(matchedReport.targetDriftReport?.differences).toHaveLength(0);
    expect(matchedReport.planArtifact.readiness.checks.targetLiveDriftZero).toBe(true);

    // 2. When liveBases B has drift (e.g. modified property):
    const driftedBases = JSON.parse(JSON.stringify(baselineBases));
    const firstBaseKey = Object.keys(driftedBases)[0];
    driftedBases[firstBaseKey].records[0].properties['MockDriftProp'] = 'DriftValue';

    const driftedAnalyzer = new BackfillDryRunAnalyzer({
      client: fakeClient,
      envVars: testEnv,
      liveBases: driftedBases,
    });
    const driftedReport = await driftedAnalyzer.runAnalysis();

    expect(driftedReport.targetDriftReport).toBeDefined();
    expect(driftedReport.targetDriftReport?.driftDetected).toBe(true);
    expect(driftedReport.targetDriftReport?.differences.length).toBeGreaterThan(0);
    expect(driftedReport.planArtifact.readiness.checks.targetLiveDriftZero).toBe(false);
    expect(driftedReport.planArtifact.readiness.blockers).toContain(
      'TARGET_DRIFT_DETECTED: Divergência detectada entre o estado live do Notion e o snapshot congelado.',
    );

    // CRITICAL: Operations must still be produced strictly from snapshot A!
    expect(driftedReport.planArtifact.operations).toEqual(matchedReport.planArtifact.operations);
    expect(driftedReport.planArtifact.backfillPlanHash).toBe(matchedReport.planArtifact.backfillPlanHash);
    expect(driftedReport.planArtifact.summary.totalOperations).toBe(159);
    expect(driftedReport.summary.totalRowsToCreate).toBe(159);
  });

  describe('Hotfix Fase 2A.7 - Fail-Safe Cleanup & Memory-Only Target Snapshot', () => {
    function getTempDirsWithPrefix(prefix: string): string[] {
      try {
        return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(prefix));
      } catch {
        return [];
      }
    }

    beforeEach(() => {
      // Purge any stale directories from prior interrupted test runs
      for (const prefix of ['fin-target-snapshot-', 'fin-source-snapshot-']) {
        try {
          const stale = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(prefix));
          for (const item of stale) {
            try {
              fs.rmSync(path.join(os.tmpdir(), item), { recursive: true, force: true });
            } catch {}
          }
        } catch {}
      }
    });

    it('zero target snapshot plaintext on disk: prepareValidatedTargetSnapshot operates 100% in-memory without tempDir', () => {
      const beforeTargetDirs = getTempDirsWithPrefix('fin-target-snapshot-');
      const analyzer = new BackfillDryRunAnalyzer({
        client: fakeClient,
        envVars: testEnv,
      });

      const session = analyzer.prepareValidatedTargetSnapshot();

      const afterTargetDirs = getTempDirsWithPrefix('fin-target-snapshot-');
      expect(afterTargetDirs).toEqual(beforeTargetDirs);
      expect(afterTargetDirs).toHaveLength(0); // Strictly zero fin-target-snapshot-* directories created!

      expect(session.payload.snapshotType).toBe('NOTION_LIVE_DATA_SNAPSHOT');
      expect(session.payload.totalBases).toBe(13);
      expect(session.frozenTargetStateHash).toMatch(/^[a-f0-9]{64}$/);
      expect(session.notionAccounts.length).toBeGreaterThan(0);
      expect(session.notionCategories.length).toBeGreaterThan(0);

      session.cleanup();
    });

    it('target snapshot válido + source manifest ausente => nenhuma pasta/arquivo target plaintext criado', async () => {
      const beforeTargetDirs = getTempDirsWithPrefix('fin-target-snapshot-');
      const beforeSourceDirs = getTempDirsWithPrefix('fin-source-snapshot-');

      const envMissingSource = { ...testEnv, SOURCE_SQLITE_SNAPSHOT_MANIFEST: '' };
      const analyzer = new BackfillDryRunAnalyzer({
        client: fakeClient,
        envVars: envMissingSource,
      });

      await expect(analyzer.runAnalysis()).rejects.toThrow(/FAIL_CLOSED_SOURCE_SNAPSHOT/);

      const afterTargetDirs = getTempDirsWithPrefix('fin-target-snapshot-');
      const afterSourceDirs = getTempDirsWithPrefix('fin-source-snapshot-');

      expect(afterTargetDirs).toEqual(beforeTargetDirs);
      expect(afterTargetDirs).toHaveLength(0);
      expect(afterSourceDirs).toEqual(beforeSourceDirs);
    });

    it('target snapshot válido + source key inválida => nenhum plaintext target residual', async () => {
      const beforeTargetDirs = getTempDirsWithPrefix('fin-target-snapshot-');
      const beforeSourceDirs = getTempDirsWithPrefix('fin-source-snapshot-');

      const envInvalidKey = { ...testEnv, MIGRATION_BACKUP_KEY: 'invalid-non-32-byte-key' };
      const analyzer = new BackfillDryRunAnalyzer({
        client: fakeClient,
        envVars: envInvalidKey,
      });

      await expect(analyzer.runAnalysis()).rejects.toThrow(/FAIL_CLOSED_TARGET_SNAPSHOT_KEY/);

      const afterTargetDirs = getTempDirsWithPrefix('fin-target-snapshot-');
      const afterSourceDirs = getTempDirsWithPrefix('fin-source-snapshot-');

      expect(afterTargetDirs).toEqual(beforeTargetDirs);
      expect(afterTargetDirs).toHaveLength(0);
      expect(afterSourceDirs).toEqual(beforeSourceDirs);
    });

    it('source snapshot restaurado + erro posterior deliberado => restored-source.db removido no finally', async () => {
      const beforeSourceDirs = getTempDirsWithPrefix('fin-source-snapshot-');

      const analyzer = new BackfillDryRunAnalyzer({
        client: fakeClient,
        envVars: testEnv,
        _deliberateErrorAfterRestore: true,
      });

      await expect(analyzer.runAnalysis()).rejects.toThrow(/DELIBERATE_TEST_ERROR_AFTER_RESTORE/);

      const afterSourceDirs = getTempDirsWithPrefix('fin-source-snapshot-');
      // The finally block must have cleanly unlinked restored-source.db and removed fin-source-snapshot-*
      expect(afterSourceDirs).toEqual(beforeSourceDirs);
    });
  });
});
