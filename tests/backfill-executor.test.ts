import 'dotenv/config';
import { describe, it, expect } from 'vitest';
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
  DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
} from '../src/notion/migration-runner/backfill-executor';
import {
  moneyToMinorUnits,
  minorUnitsToMoney,
  serializePayloadForNotion,
} from '../src/notion/migration-runner/backfill-serializer';

describe('Phase 2B.1: BackfillExecutor Hardened Engine & Idempotency', { timeout: 20000 }, () => {
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
    MIGRATION_BACKUP_KEY: process.env.MIGRATION_BACKUP_KEY,
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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
      });

      await expect(executor.preflight()).rejects.toThrow(/FAIL_FROZEN_PLAN_MISMATCH/);
    });

    it('fails with FAIL_SCHEMA_EVIDENCE_MISSING when schemaEvidence is omitted', async () => {
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

      await expect(executor.preflight()).rejects.toThrow(/FAIL_SCHEMA_EVIDENCE_MISSING/);
    });

    it('fails with FAIL_SCHEMA_NON_CONFORMANT when schema evidence has missing properties or structural mismatches', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journal = new BackfillJournal(new Database(':memory:'));

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: {
          totalDataSources: 13,
          verifiedDataSources: 12,
          missingPropertiesCount: 1,
          structuralMismatchesCount: 0,
        },
        skipWorktreeCleanCheck: true,
      });

      await expect(executor.preflight()).rejects.toThrow(/FAIL_SCHEMA_NON_CONFORMANT/);
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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
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
      const txMatches = await adapter.findByStableIdentity('NOTION_DS_TRANSACTIONS', 'Fonte', 'Pierre');
      expect(txMatches.length).toBe(155);

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
  // 3. MAXIMUM IDEMPOTENCY TEST WITHOUT DRIFT BYPASS (Item 9)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('3. Maximum Idempotency Test without skipInitialDriftCheck (Item 9)', () => {
    it('running the frozen plan a second time recognizes State B, produces 0 writes, and 100% NO_OP_VERIFIED', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);

      // Run 1: Initial complete execution
      const journal1 = new BackfillJournal(new Database(':memory:'));
      const executor1 = new BackfillExecutor({
        adapter,
        journal: journal1,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
      });
      const rep1 = await executor1.execute();
      expect(rep1.status).toBe('COMPLETED');
      expect(rep1.actualSimulatedCreateWrites).toBe(159);
      expect(rep1.actualSimulatedRelationWrites).toBe(4);

      // Run 2: Fresh journal against already populated backend (skipInitialDriftCheck is FALSE / NOT set)
      const journal2 = new BackfillJournal(new Database(':memory:'));
      const executor2 = new BackfillExecutor({
        adapter,
        journal: journal2,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
        skipInitialDriftCheck: false,
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
      expect(rep2.readyForLiveApplyReview).toBe(true);
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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
        maxRetries: 1,
      });

      await expect(executor1.execute()).rejects.toThrow(/SIMULATED_CRASH_AFTER_CREATE_1/);

      adapter.createPage = originalCreate;

      const executor2 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
      });

      const rep = await executor2.execute();
      expect(rep.status).toBe('COMPLETED');
      expect(rep.journalFinal.VERIFIED + rep.journalFinal.NO_OP_VERIFIED).toBe(163);
      expect(rep.journalFinal.FAILED).toBe(0);

      const allPages = (await adapter.queryTargetState())['NOTION_DS_TRANSACTIONS'].records;
      expect(allPages.length).toBe(155);
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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
        maxRetries: 1,
      });

      await expect(executor1.execute()).rejects.toThrow(/SIMULATED_CRASH_AT_OP_80/);

      adapter.createPage = originalCreate;

      const executor2 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
      });

      const rep = await executor2.execute();
      expect(rep.status).toBe('COMPLETED');
      expect(rep.journalFinal.VERIFIED).toBe(163);
      expect(rep.actualSimulatedCreateWrites).toBe(79);
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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
      });

      const rep = await executor2.execute();
      expect(rep.status).toBe('COMPLETED');
      expect(rep.actualSimulatedCreateWrites).toBe(0);
      expect(rep.actualSimulatedRelationWrites).toBe(4);
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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
      });

      const rep = await executor2.execute();
      expect(rep.status).toBe('COMPLETED');
      expect(rep.actualSimulatedRelationWrites).toBe(2);
    });

    it('Crash Scenario 6: uncertain write in Stage 1 (timeout after POST) -> reconciles via stable identity without duplicating', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journalDb = new Database(':memory:');
      const journal = new BackfillJournal(journalDb);

      adapter.setFaults({
        uncertainWriteNextCreate: new Error('connect ETIMEDOUT'),
      });

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
      });

      const rep = await executor.execute();
      expect(rep.status).toBe('COMPLETED');
      expect(rep.recoveredUncertainCreates).toBe(1);
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
          throw new Error('SIMULATED_CRASH_DURING_READ_BACK');
        }
        return originalFetch(...args);
      };

      const executor1 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
      });

      const rep = await executor2.execute();
      expect(rep.status).toBe('COMPLETED');
      expect(rep.journalFinal.VERIFIED).toBe(163);
    });

    it('Crash Scenario 8: uncertain write in Stage 2 (timeout during relation update) -> reconciles without re-issuing mutation', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journalDb = new Database(':memory:');
      const journal = new BackfillJournal(journalDb);

      adapter.setFaults({
        uncertainWriteNextUpdate: new Error('connect ETIMEDOUT'),
      });

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
      });

      const rep = await executor.execute();
      expect(rep.status).toBe('COMPLETED');
      expect(rep.recoveredUncertainRelationWrites).toBe(1);
      expect(rep.journalFinal.VERIFIED).toBe(163);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. JOURNAL & INTEGRITY NEGATIVE TESTS
  // ─────────────────────────────────────────────────────────────────────────────
  describe('5. Journal & Integrity Negative Tests', () => {
    it('initial target drift -> aborts with TARGET_DRIFT_DETECTED and executes 0 writes', async () => {
      const bases = getFrozenTargetBases();
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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
      });

      await expect(executor.execute()).rejects.toThrow(/TARGET_DRIFT_DETECTED/);

      const state = await adapter.queryTargetState();
      expect(state['NOTION_DS_TRANSACTIONS'].records).toHaveLength(0);
      expect(state['NOTION_DS_CARD_BILLS'].records).toHaveLength(0);
    });

    it('fails with FAIL_JOURNAL_BINDING_MISMATCH if journal metadata diverges on resume', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journal = new BackfillJournal(new Database(':memory:'));

      // Seed an in-progress run with wrong sourceSnapshotHash
      journal.startRun({
        runId: 'corrupted-run',
        planHash: FROZEN_BACKFILL_PLAN_HASH,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        executorCommitSha: '0'.repeat(40),
        sourceSnapshotHash: 'wrong_source_hash',
        targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
        targetStateHash: FROZEN_TARGET_STATE_HASH,
      });

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
      });

      await expect(executor.execute()).rejects.toThrow(/FAIL_JOURNAL_BINDING_MISMATCH/);
    });

    it('fails with FAIL_PAGE_MAPPING_CONFLICT if attempting to remap same stableId to different Notion page ID', () => {
      const journal = new BackfillJournal(new Database(':memory:'));
      journal.savePageMapping(FROZEN_BACKFILL_PLAN_HASH, 'tx-123', 'notion-page-A', 'NOTION_DS_TRANSACTIONS');

      // Idempotent same mapping no-ops cleanly
      expect(() => {
        journal.savePageMapping(FROZEN_BACKFILL_PLAN_HASH, 'tx-123', 'notion-page-A', 'NOTION_DS_TRANSACTIONS');
      }).not.toThrow();

      // Conflicting mapping throws FAIL_PAGE_MAPPING_CONFLICT
      expect(() => {
        journal.savePageMapping(FROZEN_BACKFILL_PLAN_HASH, 'tx-123', 'notion-page-B', 'NOTION_DS_TRANSACTIONS');
      }).toThrow(/FAIL_PAGE_MAPPING_CONFLICT/);
    });

    it('fails with FAIL_RELATION_TARGET_MISSING if EXISTING_PAGE_ID relation references non-existent page', async () => {
      const bases = getFrozenTargetBases();
      // Remove Nubank Conta account from target base
      bases['NOTION_DS_ACCOUNTS'].records = [];

      const adapter = new SimulatedNotionAdapter(bases);
      const journal = new BackfillJournal(new Database(':memory:'));

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
        skipInitialDriftCheck: true,
      });

      await expect(executor.execute()).rejects.toThrow(/FAIL_RELATION_TARGET_MISSING/);
    });

    it('fails with EXTERNAL_DRIFT_DURING_BACKFILL if target state was externally modified during resume', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);
      const journal = new BackfillJournal(new Database(':memory:'));

      // Crash after CREATE #5
      let createCount = 0;
      const originalCreate = adapter.createPage.bind(adapter);
      adapter.createPage = async (...args) => {
        createCount++;
        const res = await originalCreate(...args);
        if (createCount === 5) {
          throw new Error('CRASH_AFTER_5');
        }
        return res;
      };

      const executor1 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
        maxRetries: 1,
      });

      await expect(executor1.execute()).rejects.toThrow(/CRASH_AFTER_5/);
      adapter.createPage = originalCreate;

      // Simulate external drift: external actor adds a page to Contas while run is paused
      const currentState = await adapter.queryTargetState();
      (adapter as any).bases.get('NOTION_DS_ACCOUNTS').set('rogue-page', {
        id: 'rogue-page',
        createdTime: new Date().toISOString(),
        lastEditedTime: new Date().toISOString(),
        archived: false,
        url: 'https://notion.so/rogue',
        properties: { 'Nome da Conta': { title: [{ text: { content: 'Rogue Account' } }] } },
      });

      const executor2 = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
      });

      await expect(executor2.execute()).rejects.toThrow(/EXTERNAL_DRIFT_DURING_BACKFILL/);
    });

    it('duplicate stable identity in target base -> aborts with FAIL_DUPLICATE_STABLE_ID', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);

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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
        skipInitialDriftCheck: true,
      });

      await expect(executor.execute()).rejects.toThrow(/FAIL_DUPLICATE_STABLE_ID/);
    });

    it('conflicting existing page with same stableId -> aborts with FAIL_CONFLICTING_EXISTING_PAGE', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);

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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
      });

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
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. RETRY POLICY & NETWORK ERROR HANDLING (Item 10)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('6. Retry Policy & Network Error Handling (Item 10)', () => {
    it('429 status respects Retry-After header and succeeds on next retry', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);

      adapter.setFaults({
        failStatusCodes: [429],
        retryAfterSeconds: 0.01,
      });

      const journal = new BackfillJournal(new Database(':memory:'));
      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
        maxRetries: 3,
        retryBaseDelayMs: 5,
      });

      const report = await executor.execute();
      expect(report.status).toBe('COMPLETED');
      expect(report.retries).toBe(1);
      expect(report.actualSimulatedCreateWrites).toBe(159);
    });

    it('500 status retries with exponential backoff and succeeds on retry', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);

      adapter.setFaults({
        failStatusCodes: [500],
      });

      const journal = new BackfillJournal(new Database(':memory:'));
      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
        maxRetries: 3,
        retryBaseDelayMs: 5,
      });

      const report = await executor.execute();
      expect(report.status).toBe('COMPLETED');
      expect(report.retries).toBe(1);
    });

    it('503 status exhausts retries and fails run', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);

      adapter.setFaults({
        failStatusCodes: [503, 503, 503, 503],
      });

      const journal = new BackfillJournal(new Database(':memory:'));
      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
        maxRetries: 2,
        retryBaseDelayMs: 5,
      });

      await expect(executor.execute()).rejects.toThrow(/Simulated Notion API error 503/);
    });

    it('401/403 status fails fast in 1 attempt without blind retries', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);

      let calls = 0;
      adapter.createPage = async () => {
        calls++;
        const err: any = new Error('Unauthorized');
        err.status = 401;
        throw err;
      };

      const journal = new BackfillJournal(new Database(':memory:'));
      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
        maxRetries: 5,
      });

      await expect(executor.execute()).rejects.toThrow(/Unauthorized/);
      expect(calls).toBe(1);
    });

    it('validation error (status 400) does not trigger blind retries', async () => {
      const bases = getFrozenTargetBases();
      const adapter = new SimulatedNotionAdapter(bases);

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
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        skipWorktreeCleanCheck: true,
        maxRetries: 5,
      });

      await expect(executor.execute()).rejects.toThrow(/validation_error/);
      expect(calls).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. LIVE NOTION ADAPTER FAIL-CLOSED & PAGINATION (Items 6, 7)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('7. LiveNotionAdapter Fail-Closed & Pagination', () => {
    it('LiveNotionAdapter mutations strictly throw REAL_DML_DISABLED_PHASE_2B', async () => {
      const liveAdapter = new LiveNotionAdapter();

      await expect(
        liveAdapter.createPage('NOTION_DS_TRANSACTIONS', 'ds-id', { Descrição: 'Test' }),
      ).rejects.toThrow(/REAL_DML_DISABLED_PHASE_2B/);

      await expect(
        liveAdapter.updatePageRelations('NOTION_DS_CARD_BILLS', 'page-id', {}),
      ).rejects.toThrow(/REAL_DML_DISABLED_PHASE_2B/);
    });

    it('LiveNotionAdapter throws FAIL_NOTION_AUTH on 401/403', async () => {
      const fakeClient: any = {
        dataSources: {
          query: async () => {
            const err: any = new Error('API token invalid');
            err.status = 401;
            throw err;
          },
        },
      };

      const adapter = new LiveNotionAdapter(fakeClient, testEnv);
      await expect(
        adapter.findByStableIdentity('NOTION_DS_TRANSACTIONS', 'ID da Fonte', 'test-123'),
      ).rejects.toThrow(/FAIL_NOTION_AUTH/);
    });

    it('LiveNotionAdapter throws FAIL_NOTION_VALIDATION on 400', async () => {
      const fakeClient: any = {
        dataSources: {
          query: async () => {
            const err: any = new Error('validation_error: invalid property filter');
            err.status = 400;
            throw err;
          },
        },
      };

      const adapter = new LiveNotionAdapter(fakeClient, testEnv);
      await expect(
        adapter.findByStableIdentity('NOTION_DS_TRANSACTIONS', 'ID da Fonte', 'test-123'),
      ).rejects.toThrow(/FAIL_NOTION_VALIDATION/);
    });

    it('LiveNotionAdapter throws READ_UNCERTAIN on network failure', async () => {
      const fakeClient: any = {
        dataSources: {
          query: async () => {
            const err: any = new Error('connect ECONNRESET');
            err.code = 'ECONNRESET';
            throw err;
          },
        },
      };

      const adapter = new LiveNotionAdapter(fakeClient, testEnv);
      await expect(
        adapter.findByStableIdentity('NOTION_DS_TRANSACTIONS', 'ID da Fonte', 'test-123'),
      ).rejects.toThrow(/READ_UNCERTAIN/);
    });

    it('LiveNotionAdapter paginates properly when database contains >100 rows', async () => {
      let queryCallCount = 0;
      const fakeClient: any = {
        dataSources: {
          query: async (args: any) => {
            queryCallCount++;
            if (!args.start_cursor) {
              return {
                results: Array.from({ length: 100 }, (_, i) => ({
                  id: `page-batch1-${i}`,
                  properties: { 'Nome da Conta': { title: [{ text: { content: `Acc ${i}` } }] } },
                })),
                has_more: true,
                next_cursor: 'cursor-batch-2',
              };
            } else {
              return {
                results: Array.from({ length: 25 }, (_, i) => ({
                  id: `page-batch2-${i}`,
                  properties: { 'Nome da Conta': { title: [{ text: { content: `Acc 100+${i}` } }] } },
                })),
                has_more: false,
                next_cursor: null,
              };
            }
          },
        },
      };

      const envWithAllBases: Record<string, string> = { NOTION_API_KEY: 'test-key' };
      for (const k of [
        'NOTION_DS_ACCOUNTS',
        'NOTION_DS_CATEGORIES',
        'NOTION_DS_TRANSACTIONS',
        'NOTION_DS_RULES',
        'NOTION_DS_FIXED_BILLS',
        'NOTION_DS_MONTHLY_OBLIGATIONS',
        'NOTION_DS_INVESTMENTS',
        'NOTION_DS_INVESTMENT_MOVEMENTS',
        'NOTION_DS_MONTHLY_BUDGET',
        'NOTION_DS_FINANCIAL_GOALS',
        'NOTION_DS_MONTHLY_CLOSINGS',
        'NOTION_DS_SYNC_LOG',
        'NOTION_DS_CARD_BILLS',
      ]) {
        envWithAllBases[k] = `ds-${k}`;
      }

      const adapter = new LiveNotionAdapter(fakeClient, envWithAllBases);
      const state = await adapter.queryTargetState();
      expect(state['NOTION_DS_ACCOUNTS'].records).toHaveLength(125);
      expect(queryCallCount).toBeGreaterThanOrEqual(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. SERIALIZER & PRECISION UNIT TESTS
  // ─────────────────────────────────────────────────────────────────────────────
  describe('8. Serializer & Precision Unit Tests', () => {
    it('money with unsupported precision (> 2 decimal places) throws FAIL_UNSUPPORTED_MONEY_PRECISION', () => {
      expect(() => moneyToMinorUnits(12.345, 'BRL')).toThrow(/FAIL_UNSUPPORTED_MONEY_PRECISION/);
      expect(() => moneyToMinorUnits('12.3456', 'BRL')).toThrow(/FAIL_UNSUPPORTED_MONEY_PRECISION/);

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
  });
});
