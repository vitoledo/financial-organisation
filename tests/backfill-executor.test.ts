import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  PLAN_ORIGIN_COMMIT_SHA,
  FROZEN_BACKFILL_PLAN_HASH,
  FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_STATE_HASH,
} from '../src/notion/migration-runner/backfill-constants';
import { BackfillDryRunAnalyzer } from '../src/notion/migration-runner/backfill-dry-run';
import { BackfillJournal } from '../src/notion/migration-runner/backfill-journal';
import {
  SimulatedNotionAdapter,
  LiveNotionAdapter,
} from '../src/notion/migration-runner/backfill-adapter';
import {
  BackfillExecutor,
  BackfillExecutorOptions,
} from '../src/notion/migration-runner/backfill-executor';
import {
  moneyToMinorUnits,
  minorUnitsToMoney,
  serializePayloadForNotion,
} from '../src/notion/migration-runner/backfill-serializer';

describe('Phase 2B: BackfillExecutor & Simulation Engine', () => {
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
  };

  function getFrozenTargetBases() {
    const analyzer = new BackfillDryRunAnalyzer({ envVars: testEnv });
    const targetSession = analyzer.prepareValidatedTargetSnapshot();
    const bases = JSON.parse(JSON.stringify(targetSession.payload.bases));
    targetSession.cleanup();
    return bases;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. BASELINE REPRODUCIBILITY & CRYPTOGRAPHIC BINDINGS
  // ─────────────────────────────────────────────────────────────────────────────
  describe('1. Baseline Reproducibility & Cryptographic Bindings', () => {
    it('strictly reproduces BackfillPlanHash == 948adff9... when passing PLAN_ORIGIN_COMMIT_SHA', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journalDb = new Database(':memory:');
      const journal = new BackfillJournal(journalDb);

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
      });

      const preflight = await executor.preflight();
      expect(preflight.reproducedPlanHash).toBe(FROZEN_BACKFILL_PLAN_HASH);
      expect(preflight.targetStateHash).toBe(FROZEN_TARGET_STATE_HASH);
      expect(preflight.sourceSnapshotHash).toBe(FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256);
      expect(preflight.targetSnapshotHash).toBe(FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256);
      const nonWorktreeBlockers = preflight.planArtifact.readiness.blockers.filter(
        (b) => !b.startsWith('WORKTREE_DIRTY') && !b.startsWith('HEAD_NOT_IN_SYNC'),
      );
      expect(nonWorktreeBlockers).toHaveLength(0);
      expect(preflight.planArtifact.readiness.checks.schemaConformant13Of13).toBe(true);
      expect(preflight.planArtifact.readiness.checks.missingPropertiesZero).toBe(true);
      expect(preflight.planArtifact.readiness.checks.structuralMismatchesZero).toBe(true);
      expect(preflight.planArtifact.readiness.checks.targetLiveDriftZero).toBe(true);
      expect(preflight.planArtifact.readiness.checks.planHashReproducible).toBe(true);
      expect(preflight.planArtifact.summary.executableCreateCount).toBe(159);
      expect(preflight.planArtifact.summary.executableUpdateCount).toBe(0);
    });

    it('fails with FAIL_FROZEN_PLAN_MISMATCH if planOriginCommitSha differs from frozen commit', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journal = new BackfillJournal(new Database(':memory:'));

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: '0000000000000000000000000000000000000000',
        skipWorktreeCleanCheck: true,
      });

      await expect(executor.preflight()).rejects.toThrow(/FAIL_FROZEN_PLAN_MISMATCH/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. FULL END-TO-END SIMULATION EXECUTION
  // ─────────────────────────────────────────────────────────────────────────────
  describe('2. Full End-to-End Simulation Execution', () => {
    it('executes full simulation from frozen snapshot: 159 creates, 4 relation patch groups, 0 errors', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journalDb = new Database(':memory:');
      const journal = new BackfillJournal(journalDb);

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
      });

      const report = await executor.execute();

      expect(report.status).toBe('COMPLETED');
      expect(report.planOriginCommitSha).toBe(PLAN_ORIGIN_COMMIT_SHA);
      expect(report.reproducedBackfillPlanHash).toBe(FROZEN_BACKFILL_PLAN_HASH);
      expect(report.semanticCreates).toBe(159);
      expect(report.actualSimulatedCreateWrites).toBe(159);
      expect(report.existingPageCreateNoOps).toBe(0);
      expect(report.logicalRelationReferences).toBe(320);
      expect(report.canonicalRelationPatchGroups).toBe(4);
      expect(report.actualSimulatedRelationWrites).toBe(4);
      expect(report.writeRequestsSent).toBe(163);
      expect(report.retries).toBe(0);
      expect(report.recoveredUncertainCreates).toBe(0);
      expect(report.recoveredUncertainRelationWrites).toBe(0);

      // Journal counts: 159 Stage 1 + 4 Stage 2 = 163 VERIFIED
      expect(report.journalFinal.VERIFIED).toBe(163);
      expect(report.journalFinal.PENDING).toBe(0);
      expect(report.journalFinal.FAILED).toBe(0);

      // Authorization flags
      expect(report.readyForLiveApplyReview).toBe(true);
      expect(report.readyForApply).toBe(false);
      expect(report.liveNotionMutations).toBe(0);

      // Verify simulation backend state:
      // Transactions should have 155 new records
      const txMatches = await adapter.findByStableIdentity('NOTION_DS_TRANSACTIONS', 'Fonte', 'Pierre');
      expect(txMatches.length).toBe(155);

      // Faturas should have 4 new records
      const billMatches = await adapter.findByStableIdentity('NOTION_DS_CARD_BILLS', 'Fonte', 'Pierre');
      expect(billMatches.length).toBe(4);

      // Verify dual relation synchronization on the 20 purchases
      let purchasesWithLinkedBill = 0;
      for (const tx of txMatches) {
        const linked = tx.properties['Fatura Vinculada']?.relation || [];
        if (linked.length > 0) {
          purchasesWithLinkedBill++;
        }
      }
      expect(purchasesWithLinkedBill).toBe(20);

      // Verify payment allocations: 15 payments linked in bills
      let totalAllocatedPayments = 0;
      for (const bill of billMatches) {
        const payments = bill.properties['Transações de Pagamento']?.relation || [];
        totalAllocatedPayments += payments.length;
      }
      expect(totalAllocatedPayments).toBe(15);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. MAXIMUM IDEMPOTENCY TEST (Section 30)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('3. Maximum Idempotency Test (Section 30)', () => {
    it('running the frozen plan a second time produces 0 new pages, 0 relation writes, and 100% NO_OP_VERIFIED', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);

      // Run 1: Initial complete execution
      const journal1 = new BackfillJournal(new Database(':memory:'));
      const executor1 = new BackfillExecutor({
        adapter,
        journal: journal1,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
      });
      const rep1 = await executor1.execute();
      expect(rep1.status).toBe('COMPLETED');
      expect(rep1.actualSimulatedCreateWrites).toBe(159);
      expect(rep1.actualSimulatedRelationWrites).toBe(4);

      // Run 2: Fresh journal against the already populated backend
      const journal2 = new BackfillJournal(new Database(':memory:'));
      const executor2 = new BackfillExecutor({
        adapter,
        journal: journal2,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
        skipInitialDriftCheck: true,
      });

      const rep2 = await executor2.execute();

      expect(rep2.status).toBe('COMPLETED');
      expect(rep2.semanticCreates).toBe(159);
      expect(rep2.actualSimulatedCreateWrites).toBe(0); // Strictly zero new pages created!
      expect(rep2.existingPageCreateNoOps).toBe(159); // All 159 recognized as NO_OP_VERIFIED!
      expect(rep2.canonicalRelationPatchGroups).toBe(4);
      expect(rep2.actualSimulatedRelationWrites).toBe(0); // Strictly zero relation updates!
      expect(rep2.writeRequestsSent).toBe(0); // Zero write requests sent!
      expect(rep2.journalFinal.NO_OP_VERIFIED).toBe(163); // 159 creates + 4 patches = 163 NO_OP_VERIFIED
      expect(rep2.journalFinal.VERIFIED).toBe(0);
      expect(rep2.journalFinal.FAILED).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. MANDATORY CRASH / RESTART SCENARIOS (Section 29)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('4. Mandatory Crash / Restart Scenarios (Section 29)', () => {
    it('Crash Scenario 1: crash after CREATE #1 -> resume executes steps 2..159 with 0 duplicate pages', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journalDb = new Database(':memory:');
      const journal = new BackfillJournal(journalDb);

      // Fault: crash after 1st page creation
      let createCounter = 0;
      const originalCreate = adapter.createPage.bind(adapter);
      adapter.createPage = async (...args) => {
        createCounter++;
        const res = await originalCreate(...args);
        if (createCounter === 1) {
          throw new Error('SIMULATED_CRASH_AFTER_CREATE_1');
        }
        return res;
      };

      const executor1 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
        maxRetries: 1,
      });

      await expect(executor1.execute()).rejects.toThrow(/SIMULATED_CRASH_AFTER_CREATE_1/);

      // Restore adapter normal function
      adapter.createPage = originalCreate;

      // Reinstantiate executor with same journal and preserved adapter
      const executor2 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
      });

      const rep = await executor2.execute();
      expect(rep.status).toBe('COMPLETED');
      expect(rep.journalFinal.VERIFIED + rep.journalFinal.NO_OP_VERIFIED).toBe(163);
      expect(rep.journalFinal.FAILED).toBe(0);
      expect(rep.journalFinal.PENDING).toBe(0);

      const allPages = (await adapter.queryTargetState())['NOTION_DS_TRANSACTIONS'].records;
      expect(allPages.length).toBe(155); // Strictly zero duplicates!
    });

    it('Crash Scenario 2: crash mid Stage 1 (after CREATE #80) -> resume completes without duplicates', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journalDb = new Database(':memory:');
      const journal = new BackfillJournal(journalDb);

      let createCounter = 0;
      const originalCreate = adapter.createPage.bind(adapter);
      adapter.createPage = async (...args) => {
        createCounter++;
        if (createCounter === 81) {
          throw new Error('SIMULATED_CRASH_AT_OP_80');
        }
        return originalCreate(...args);
      };

      const executor1 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
        maxRetries: 1,
      });

      await expect(executor1.execute()).rejects.toThrow(/SIMULATED_CRASH_AT_OP_80/);

      adapter.createPage = originalCreate;

      // Reinstantiate
      const executor2 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
      });

      const rep = await executor2.execute();
      expect(rep.status).toBe('COMPLETED');
      expect(rep.journalFinal.VERIFIED).toBe(163);
      expect(rep.actualSimulatedCreateWrites).toBe(79); // Exactly 159 - 80 = 79 creates on resume
    });

    it('Crash Scenario 3: crash after CREATE #159 before Stage 2 -> resume completes Stage 2 cleanly', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journalDb = new Database(':memory:');
      const journal = new BackfillJournal(journalDb);

      let createCounter = 0;
      const originalCreate = adapter.createPage.bind(adapter);
      adapter.createPage = async (...args) => {
        createCounter++;
        const res = await originalCreate(...args);
        if (createCounter === 159) {
          throw new Error('SIMULATED_CRASH_AFTER_CREATE_159');
        }
        return res;
      };

      const executor1 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
        maxRetries: 1,
      });

      await expect(executor1.execute()).rejects.toThrow(/SIMULATED_CRASH_AFTER_CREATE_159/);

      adapter.createPage = originalCreate;

      const executor2 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
      });

      const rep = await executor2.execute();
      expect(rep.status).toBe('COMPLETED');
      expect(rep.actualSimulatedCreateWrites).toBe(0); // All 159 already verified
      expect(rep.actualSimulatedRelationWrites).toBe(4); // Only Stage 2 relation writes
    });

    it('Crash Scenario 4: crash at start of Stage 2 (before bill #1 patch) -> resume completes all 4 patches', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journalDb = new Database(':memory:');
      const journal = new BackfillJournal(journalDb);

      let updateCounter = 0;
      const originalUpdate = adapter.updatePageRelations.bind(adapter);
      adapter.updatePageRelations = async (...args) => {
        updateCounter++;
        if (updateCounter === 1) {
          throw new Error('SIMULATED_CRASH_START_STAGE_2');
        }
        return originalUpdate(...args);
      };

      const executor1 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
        maxRetries: 1,
      });

      await expect(executor1.execute()).rejects.toThrow(/SIMULATED_CRASH_START_STAGE_2/);

      adapter.updatePageRelations = originalUpdate;

      const executor2 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
      });

      const rep = await executor2.execute();
      expect(rep.status).toBe('COMPLETED');
      expect(rep.actualSimulatedRelationWrites).toBe(4);
    });

    it('Crash Scenario 5: crash mid Stage 2 (after bill #2 patch) -> resume completes remaining 2 patches', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journalDb = new Database(':memory:');
      const journal = new BackfillJournal(journalDb);

      let updateCounter = 0;
      const originalUpdate = adapter.updatePageRelations.bind(adapter);
      adapter.updatePageRelations = async (...args) => {
        updateCounter++;
        const res = await originalUpdate(...args);
        if (updateCounter === 2) {
          throw new Error('SIMULATED_CRASH_AFTER_BILL_2');
        }
        return res;
      };

      const executor1 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
        maxRetries: 1,
      });

      await expect(executor1.execute()).rejects.toThrow(/SIMULATED_CRASH_AFTER_BILL_2/);

      adapter.updatePageRelations = originalUpdate;

      const executor2 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
      });

      const rep = await executor2.execute();
      expect(rep.status).toBe('COMPLETED');
      expect(rep.actualSimulatedRelationWrites).toBe(2); // Exactly remaining 2 patches!
    });

    it('Crash Scenario 6: uncertain write in Stage 1 (timeout after POST) -> reconciles via stable identity without duplicating', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journalDb = new Database(':memory:');
      const journal = new BackfillJournal(journalDb);

      // Inject uncertain write on next create (page written, but ETIMEDOUT thrown)
      adapter.setFaults({
        uncertainWriteNextCreate: new Error('connect ETIMEDOUT'),
      });

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
      });

      const rep = await executor.execute();
      expect(rep.status).toBe('COMPLETED');
      expect(rep.recoveredUncertainCreates).toBe(1); // Successfully recovered!
      expect(rep.actualSimulatedCreateWrites).toBe(159);
    });

    it('Crash Scenario 7: APPLIED before VERIFIED (crash before read-back check) -> resume recovers and verifies', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journalDb = new Database(':memory:');
      const journal = new BackfillJournal(journalDb);

      let fetchCounter = 0;
      const originalFetch = adapter.fetchPage.bind(adapter);
      adapter.fetchPage = async (...args) => {
        fetchCounter++;
        if (fetchCounter === 1) {
          // Crash during read-back of page #1 (journal has APPLIED, not yet VERIFIED)
          throw new Error('SIMULATED_CRASH_DURING_READ_BACK');
        }
        return originalFetch(...args);
      };

      const executor1 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
        maxRetries: 1,
      });

      await expect(executor1.execute()).rejects.toThrow(/SIMULATED_CRASH_DURING_READ_BACK/);

      adapter.fetchPage = originalFetch;

      const executor2 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
      });

      const rep = await executor2.execute();
      expect(rep.status).toBe('COMPLETED');
      expect(rep.journalFinal.VERIFIED).toBe(163);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. NEGATIVE TESTS SUITE (Section 31)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('5. Negative Tests Suite (Section 31)', () => {
    it('initial target drift -> aborts with TARGET_DRIFT_DETECTED and executes 0 writes', async () => {
      const bases = getFrozenTargetBases();
      // Mutate target state by adding an unexpected row
      bases['NOTION_DS_ACCOUNTS'].records.push({
        id: 'external-unexpected-account',
        createdTime: '2026-09-01T00:00:00.000Z',
        lastEditedTime: '2026-09-01T00:00:00.000Z',
        archived: false,
        url: 'https://notion.so/external',
        properties: {
          'Nome da Conta': { title: [{ text: { content: 'Conta Externa Desconhecida' } }] },
        },
      });

      const adapter = new SimulatedNotionAdapter(bases);
      const journal = new BackfillJournal(new Database(':memory:'));

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
      });

      await expect(executor.execute()).rejects.toThrow(/TARGET_DRIFT_DETECTED/);

      // Verify zero writes executed
      const state = await adapter.queryTargetState();
      expect(state['NOTION_DS_TRANSACTIONS'].records).toHaveLength(0);
      expect(state['NOTION_DS_CARD_BILLS'].records).toHaveLength(0);
    });

    it('duplicate stable identity in target base -> aborts with FAIL_DUPLICATE_STABLE_ID', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);

      // Pre-seed two pages with the same stableId
      const targetTxStableId = 'a2ce0416-1a27-4592-85be-bff2a9ce6f86';
      await adapter.createPage('NOTION_DS_TRANSACTIONS', 'ds-tx', {
        'ID da Fonte': { rich_text: [{ text: { content: targetTxStableId } }] },
        Descrição: { title: [{ text: { content: 'Page 1' } }] },
      });
      await adapter.createPage('NOTION_DS_TRANSACTIONS', 'ds-tx', {
        'ID da Fonte': { rich_text: [{ text: { content: targetTxStableId } }] },
        Descrição: { title: [{ text: { content: 'Page 2' } }] },
      });

      const journal = new BackfillJournal(new Database(':memory:'));
      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
        skipInitialDriftCheck: true,
      });

      await expect(executor.execute()).rejects.toThrow(/FAIL_DUPLICATE_STABLE_ID/);
    });

    it('conflicting existing page with same stableId -> aborts with FAIL_CONFLICTING_EXISTING_PAGE', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);

      // Pre-seed one page with same stableId but differing amount/description
      const targetTxStableId = 'a2ce0416-1a27-4592-85be-bff2a9ce6f86';
      await adapter.createPage('NOTION_DS_TRANSACTIONS', 'ds-tx', {
        'ID da Fonte': { rich_text: [{ text: { content: targetTxStableId } }] },
        Descrição: { title: [{ text: { content: 'Conflito Deliberado de Descrição' } }] },
        Valor: { number: 999999.99 },
      });

      const journal = new BackfillJournal(new Database(':memory:'));
      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
        skipInitialDriftCheck: true,
      });

      await expect(executor.execute()).rejects.toThrow(/FAIL_CONFLICTING_EXISTING_PAGE/);
    });

    it('unexpected extra relation on card bill -> aborts with FAIL_RELATION_CONFLICT', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journal = new BackfillJournal(new Database(':memory:'));

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
      });

      // Intercept fetchPage during Stage 2 (after all 159 Stage 1 creations and read-backs)
      let fetchCount = 0;
      const originalFetch = adapter.fetchPage.bind(adapter);
      adapter.fetchPage = async (pageId: string) => {
        fetchCount++;
        const res = await originalFetch(pageId);
        if (res && fetchCount > 159) {
          const isBill = (adapter as any).bases.get('NOTION_DS_CARD_BILLS')?.has(pageId);
          if (isBill) {
            res.properties['Lançamentos do Ciclo'] = {
              type: 'relation',
              relation: [{ id: 'sim-page-unexpected-foreign-id' }],
            };
          }
        }
        return res;
      };

      await expect(executor.execute()).rejects.toThrow(/FAIL_RELATION_CONFLICT/);
    });

    it('LiveNotionAdapter createPage / updatePageRelations strictly throws REAL_DML_DISABLED_PHASE_2B', async () => {
      const liveAdapter = new LiveNotionAdapter();

      await expect(
        liveAdapter.createPage('NOTION_DS_TRANSACTIONS', 'ds-id', { Descrição: 'Test' }),
      ).rejects.toThrow(/REAL_DML_DISABLED_PHASE_2B/);

      await expect(
        liveAdapter.updatePageRelations('NOTION_DS_CARD_BILLS', 'page-id', {}),
      ).rejects.toThrow(/REAL_DML_DISABLED_PHASE_2B/);
    });

    it('money with unsupported precision (> 2 decimal places) throws FAIL_UNSUPPORTED_MONEY_PRECISION', () => {
      expect(() => moneyToMinorUnits(12.345, 'BRL')).toThrow(/FAIL_UNSUPPORTED_MONEY_PRECISION/);
      expect(() => moneyToMinorUnits('12.3456', 'BRL')).toThrow(/FAIL_UNSUPPORTED_MONEY_PRECISION/);

      // Clean 2 decimals works
      expect(moneyToMinorUnits(12.34, 'BRL')).toBe(1234);
      expect(minorUnitsToMoney(1234, 'BRL')).toBe(12.34);
    });

    it('unknown property in TARGET_CONTRACT throws FAIL_UNKNOWN_PROPERTY', () => {
      expect(() =>
        serializePayloadForNotion('NOTION_DS_TRANSACTIONS', {
          Descrição: 'Compra teste',
          PropriedadeInexistenteNoSchema: 'Valor proibido',
        }),
      ).toThrow(/FAIL_UNKNOWN_PROPERTY/);
    });

    it('validation error (status 400) does not trigger blind retries', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);

      // Inject 400 validation error
      let calls = 0;
      adapter.createPage = async () => {
        calls++;
        const err: any = new Error('validation_error: body failed schema check');
        err.status = 400;
        throw err;
      };

      const journal = new BackfillJournal(new Database(':memory:'));
      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        skipWorktreeCleanCheck: true,
        maxRetries: 5,
      });

      await expect(executor.execute()).rejects.toThrow(/validation_error/);
      expect(calls).toBe(1); // Zero blind retries on validation_error!
    });
  });
});
