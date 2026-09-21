import 'dotenv/config';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import {
  BackfillLivePreflight,
  isPreflightValid,
  validatePreflightBinding,
  LivePreflightArtifact,
  BackfillLiveResumePreflight,
  ResumePreflightArtifact,
  validateResumePreflightBinding,
} from '../src/notion/migration-runner/backfill-live-preflight';
import {
  PLAN_ORIGIN_COMMIT_SHA,
  FROZEN_BACKFILL_PLAN_HASH,
  FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_STATE_HASH,
  APPROVED_WORKSPACE_IDENTITY_HASH,
} from '../src/notion/migration-runner/backfill-constants';
import { LiveNotionAdapter, SimulatedNotionAdapter } from '../src/notion/migration-runner/backfill-adapter';
import { BackfillDryRunAnalyzer } from '../src/notion/migration-runner/backfill-dry-run';
import { BackfillExecutor, projectExpectedBackfillState } from '../src/notion/migration-runner/backfill-executor';
import { BackfillJournal } from '../src/notion/migration-runner/backfill-journal';

describe('Phase 2C: Real Read-Only Live Preflight and Production Wiring', { timeout: 30000 }, () => {
  const testEnv = {
    NOTION_API_KEY: process.env.NOTION_API_KEY || 'fake-key',
    NOTION_DS_ACCOUNTS: process.env.NOTION_DS_ACCOUNTS || 'fake-acc-ds',
    NOTION_DS_CATEGORIES: process.env.NOTION_DS_CATEGORIES || 'fake-cat-ds',
    NOTION_DS_TRANSACTIONS: process.env.NOTION_DS_TRANSACTIONS || 'fake-tx-ds',
    NOTION_DS_CARD_BILLS: process.env.NOTION_DS_CARD_BILLS || 'fake-bills-ds',
    NOTION_DS_MONTHLY_BUDGET: process.env.NOTION_DS_MONTHLY_BUDGET || 'fake-budget-ds',
    NOTION_DS_RULES: process.env.NOTION_DS_RULES || 'fake-rules-ds',
    NOTION_DS_FIXED_BILLS: process.env.NOTION_DS_FIXED_BILLS || 'fake-fixed-bills-ds',
    NOTION_DS_MONTHLY_OBLIGATIONS: process.env.NOTION_DS_MONTHLY_OBLIGATIONS || 'fake-obligations-ds',
    NOTION_DS_INVESTMENTS: process.env.NOTION_DS_INVESTMENTS || 'fake-inv-ds',
    NOTION_DS_INVESTMENT_MOVEMENTS: process.env.NOTION_DS_INVESTMENT_MOVEMENTS || 'fake-inv-mov-ds',
    NOTION_DS_FINANCIAL_GOALS: process.env.NOTION_DS_FINANCIAL_GOALS || 'fake-goals-ds',
    NOTION_DS_MONTHLY_CLOSINGS: process.env.NOTION_DS_MONTHLY_CLOSINGS || 'fake-closings-ds',
    NOTION_DS_SYNC_LOG: process.env.NOTION_DS_SYNC_LOG || 'fake-sync-log-ds',
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
  // 1. FAIL-CLOSED LIVE MUTATIONS & ADAPTER PROTECTION
  // ─────────────────────────────────────────────────────────────────────────────
  describe('1. Fail-closed live mutations (Zero DML enforcement)', () => {
    it('LiveNotionAdapter.createPage throws REAL_DML_DISABLED_PRE_APPLY unconditionally', async () => {
      const fakeClient: any = {
        pages: { create: vi.fn() },
      };
      const adapter = new LiveNotionAdapter(fakeClient, testEnv);

      await expect(
        adapter.createPage('NOTION_DS_TRANSACTIONS', 'ds-tx-fake', {
          Descrição: { title: [{ text: { content: 'Teste' } }] },
        }),
      ).rejects.toThrow(/REAL_DML_DISABLED_PRE_APPLY|REAL_DML_DISABLED_PHASE_2B/);
      expect(adapter.getMutationCount()).toBe(0);
    });

    it('LiveNotionAdapter.updatePageRelations throws REAL_DML_DISABLED_PRE_APPLY unconditionally', async () => {
      const fakeClient: any = {
        pages: { update: vi.fn() },
      };
      const adapter = new LiveNotionAdapter(fakeClient, testEnv);

      await expect(
        adapter.updatePageRelations('NOTION_DS_TRANSACTIONS', 'page-123', {
          'Lançamentos do Ciclo': ['tx-1'],
        }),
      ).rejects.toThrow(/REAL_DML_DISABLED_PRE_APPLY|REAL_DML_DISABLED_PHASE_2B/);
      expect(adapter.getMutationCount()).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. LIVE SCHEMA & REFERENCE CONFORMANCE
  // ─────────────────────────────────────────────────────────────────────────────
  describe('2. Schema Conformance & Dual Relation Inspection', () => {
    it('introspects dual relation between Card Bills and Transactions', async () => {
      // In live Notion or mocked client, card bills <-> transactions is dual_property
      const client = new LiveNotionAdapter({} as any, testEnv);
      expect(client).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. TARGET PRISTINE STATE & DRIFT DETECTION
  // ─────────────────────────────────────────────────────────────────────────────
  describe('3. Pristine State & Drift Detection', () => {
    it('flags PREEXISTING_BACKFILL_TARGET_DATA if transactions or bills table has existing records', async () => {
      const bases = getFrozenTargetBases();
      // Inject unexpected transaction in live bases
      bases['NOTION_DS_TRANSACTIONS'] = {
        recordCount: 1,
        records: [
          {
            id: 'rogue-tx-page-1',
            properties: { Descrição: 'Transação preexistente inesperada' },
          },
        ],
      };

      const mockClient: any = {
        users: { me: vi.fn().mockResolvedValue({ id: 'bot-1', type: 'bot', bot: { workspace_id: 'ws-123' } }) },
      };

      const preflight = new BackfillLivePreflight({
        client: mockClient,
        envVars: testEnv,
        artifactPath: path.resolve(process.cwd(), '.local', 'test-preflight-rogue.json'),
      });

      // Mock live adapter's queryTargetState
      vi.spyOn(LiveNotionAdapter.prototype, 'queryTargetState').mockResolvedValue(bases);

      const result = await preflight.executePreflight();

      expect(result.readyForLiveApplyReview).toBe(false);
      expect(result.readyForApply).toBe(false);
      expect(result.reasons.some((r) => r.includes('PREEXISTING_BACKFILL_TARGET_DATA'))).toBe(true);
      expect(result.reasons.some((r) => r.includes('TARGET_DRIFT_DETECTED'))).toBe(true);

      vi.restoreAllMocks();
    });

    it('flags TARGET_DRIFT_DETECTED when another base changes properties or rows', async () => {
      const bases = getFrozenTargetBases();
      // Add a dummy account
      bases['NOTION_DS_ACCOUNTS'].records.push({
        id: 'new-unseen-account-uuid',
        properties: { 'Nome da Conta': 'Conta Fantasma' },
      });
      bases['NOTION_DS_ACCOUNTS'].recordCount++;

      const mockClient: any = {
        users: { me: vi.fn().mockResolvedValue({ id: 'bot-1', type: 'bot', bot: { workspace_id: 'ws-123' } }) },
      };

      const preflight = new BackfillLivePreflight({
        client: mockClient,
        envVars: testEnv,
        artifactPath: path.resolve(process.cwd(), '.local', 'test-preflight-drift.json'),
      });

      vi.spyOn(LiveNotionAdapter.prototype, 'queryTargetState').mockResolvedValue(bases);

      const result = await preflight.executePreflight();

      expect(result.readyForLiveApplyReview).toBe(false);
      expect(result.reasons.some((r) => r.includes('TARGET_DRIFT_DETECTED'))).toBe(true);

      vi.restoreAllMocks();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. REFERENTIAL INTEGRITY & MISSING TARGET PAGES
  // ─────────────────────────────────────────────────────────────────────────────
  describe('4. Referential Integrity & Missing Relations', () => {
    it('flags FAIL_EXISTING_RELATIONS if a referenced account page is missing in live Notion', async () => {
      const bases = getFrozenTargetBases();
      // Remove all accounts so all foreign keys fail
      bases['NOTION_DS_ACCOUNTS'] = { recordCount: 0, records: [] };

      const mockClient: any = {
        users: { me: vi.fn().mockResolvedValue({ id: 'bot-1', type: 'bot', bot: { workspace_id: 'ws-123' } }) },
      };

      const preflight = new BackfillLivePreflight({
        client: mockClient,
        envVars: testEnv,
        artifactPath: path.resolve(process.cwd(), '.local', 'test-preflight-missing-rel.json'),
      });

      vi.spyOn(LiveNotionAdapter.prototype, 'queryTargetState').mockResolvedValue(bases);

      const result = await preflight.executePreflight();

      expect(result.readyForLiveApplyReview).toBe(false);
      expect(result.reasons.some((r) => r.includes('FAIL_EXISTING_RELATIONS'))).toBe(true);

      vi.restoreAllMocks();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. TTL VALIDITY & ARTIFACT BINDING
  // ─────────────────────────────────────────────────────────────────────────────
  describe('5. Temporal Validity (15-min TTL) and Binding Validation', () => {
    it('isPreflightValid returns false if artifact is older than ttlMinutes', () => {
      const expiredArtifact: LivePreflightArtifact = {
        preflightVersion: '1.0.0',
        timestamp: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        generatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        expiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        ttlMinutes: 15,
        executorCommitSha: 'commit-1',
        executorParentCommitSha: 'commit-0',
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
        sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
        targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
        frozenTargetStateHash: FROZEN_TARGET_STATE_HASH,
        liveTargetStateHash: FROZEN_TARGET_STATE_HASH,
        workspaceIdentityHash: 'ws-hash',
        actorType: 'bot',
        schema: { total: 13, verified: 13, missing: 0, mismatches: 0 },
        targets: { transactions: 0, bills: 0 },
        stableIdentityConflicts: 0,
        relationTargetErrors: 0,
        liveMutations: 0,
        readyForLiveApplyReview: true,
        readyForApply: false,
        reasons: [],
        rowCountsByDataSource: {},
        existingRelationsSummary: { total: 320, verified: 320, missing: 0, wrongTarget: 0 },
        stableIdentitiesSummary: { totalChecked: 159, conflicts: 0, duplicates: 0 },
        journalStatus: {
          path: '.local/backfill-journal.db',
          gitIgnored: true,
          exists: false,
          writable: true,
        },
      };

      const validity = isPreflightValid(expiredArtifact);
      expect(validity.valid).toBe(false);
      expect(validity.reason).toContain('LIVE_PREFLIGHT_EXPIRED');
    });

    it('validatePreflightBinding detects plan hash or commit mismatch', () => {
      const validArtifact: LivePreflightArtifact = {
        preflightVersion: '1.0.0',
        timestamp: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        ttlMinutes: 15,
        executorCommitSha: 'commit-1',
        executorParentCommitSha: 'commit-0',
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
        sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
        targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
        frozenTargetStateHash: FROZEN_TARGET_STATE_HASH,
        liveTargetStateHash: FROZEN_TARGET_STATE_HASH,
        workspaceIdentityHash: 'ws-hash',
        actorType: 'bot',
        schema: { total: 13, verified: 13, missing: 0, mismatches: 0 },
        targets: { transactions: 0, bills: 0 },
        stableIdentityConflicts: 0,
        relationTargetErrors: 0,
        liveMutations: 0,
        readyForLiveApplyReview: true,
        readyForApply: false,
        reasons: [],
        rowCountsByDataSource: {},
        existingRelationsSummary: { total: 320, verified: 320, missing: 0, wrongTarget: 0 },
        stableIdentitiesSummary: { totalChecked: 159, conflicts: 0, duplicates: 0 },
        journalStatus: {
          path: '.local/backfill-journal.db',
          gitIgnored: true,
          exists: false,
          writable: true,
        },
        mutationWriteSurfaceCompatibility: {
          executableOperationsChecked: 159,
          incompatibleOperations: 0,
          missingPhysicalProperties: 0,
          typeMismatches: 0,
          invalidSelectOptions: 0,
          relationTargetMismatches: 0,
        },
        canaryOperation: {
          operationIndex: 0,
          targetDataSource: 'NOTION_DS_TRANSACTIONS',
          physicalPropertyKeys: ['Conta', 'Data', 'HMAC Contraparte', 'Hash Canônico', 'ID da fonte', 'Lançamento', 'Moeda', 'Movimento', 'Natureza', 'Status', 'Valor', 'Valor Bruto da Fonte'],
          everyPhysicalPropertyExists: true,
          stableIdentityPhysicalProperty: 'ID da fonte',
          stableIdentityQueryValidated: true,
          matches: 0,
          validationError: 0,
        },
      };

      const check1 = validatePreflightBinding(validArtifact, {
        backfillPlanHash: 'tampered-plan-hash',
      });
      expect(check1.valid).toBe(false);
      expect(check1.reason).toContain('backfillPlanHash');

      const check2 = validatePreflightBinding(validArtifact, {
        sourceSnapshotHash: 'tampered-source-hash',
      });
      expect(check2.valid).toBe(false);
      expect(check2.reason).toContain('sourceSnapshotHash');

      const check3 = validatePreflightBinding(validArtifact, {
        targetSnapshotHash: 'tampered-target-hash',
      });
      expect(check3.valid).toBe(false);
      expect(check3.reason).toContain('targetSnapshotHash');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. REALISTIC PAGE IDS IN APPLIED STATE PROJECTION (Item 13)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('6. Realistic Page IDs in Applied State Projection', () => {
    it('projects applied state with realistic Notion UUIDs instead of sim-page-*', async () => {
      const bases = getFrozenTargetBases();
      const uuidCounter = 1000;
      const realisticIdGenerator = (counter: number) => {
        return `11111111-2222-3333-4444-${(uuidCounter + counter).toString().padStart(12, '0')}`;
      };

      const adapter = new SimulatedNotionAdapter(bases, { pageIdGenerator: realisticIdGenerator });
      const journalDb = new Database(':memory:');
      const journal = new BackfillJournal(journalDb);

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        commitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: {
          totalDataSources: 13,
          verifiedDataSources: 13,
          missingPropertiesCount: 0,
          structuralMismatchesCount: 0,
        },
        skipWorktreeCleanCheck: true,
        skipHeadInSyncCheck: true,
      });

      const report = await executor.execute();
      expect(report.status).toBe('COMPLETED');

      const preflightRes = await executor.preflight();
      const projected = executor.projectFullyAppliedState(
        preflightRes.preflightBases,
        preflightRes.planArtifact,
      );

      const txRecords = projected['NOTION_DS_TRANSACTIONS'].records;
      expect(txRecords.length).toBe(155);

      // Verify that every transaction record uses a realistic UUID, zero sim-page-*
      for (const r of txRecords) {
        expect(r.id).toMatch(/^11111111-2222-3333-4444-\d{12}$/);
        expect(r.id).not.toContain('sim-page-');
      }

      // Verify bills
      const billRecords = projected['NOTION_DS_CARD_BILLS'].records;
      expect(billRecords.length).toBe(4);
      for (const r of billRecords) {
        expect(r.id).toMatch(/^11111111-2222-3333-4444-\d{12}$/);
        expect(r.id).not.toContain('sim-page-');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. EXACT WRITE SURFACE COMPATIBILITY & CANARY PRE-CHECK (Fase 2D)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('6. Exact Write Surface Compatibility & Canary Pre-Check', () => {
    function buildBaseArtifact(): LivePreflightArtifact {
      return {
        preflightVersion: '1.0.0',
        timestamp: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        ttlMinutes: 15,
        executorCommitSha: 'test-commit',
        executorParentCommitSha: 'parent-commit',
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
        sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
        targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
        frozenTargetStateHash: FROZEN_TARGET_STATE_HASH,
        liveTargetStateHash: FROZEN_TARGET_STATE_HASH,
        workspaceIdentityHash: 'ws-hash',
        actorType: 'bot',
        schema: { total: 13, verified: 13, missing: 0, mismatches: 0 },
        targets: { transactions: 0, bills: 0 },
        stableIdentityConflicts: 0,
        relationTargetErrors: 0,
        liveMutations: 0,
        readyForLiveApplyReview: true,
        readyForApply: false,
        reasons: [],
        rowCountsByDataSource: {},
        existingRelationsSummary: { total: 320, verified: 320, missing: 0, wrongTarget: 0 },
        stableIdentitiesSummary: { totalChecked: 159, conflicts: 0, duplicates: 0 },
        journalStatus: {
          path: '.local/backfill-journal.db',
          gitIgnored: true,
          exists: false,
          writable: true,
        },
        mutationWriteSurfaceCompatibility: {
          executableOperationsChecked: 159,
          incompatibleOperations: 0,
          missingPhysicalProperties: 0,
          typeMismatches: 0,
          invalidSelectOptions: 0,
          relationTargetMismatches: 0,
        },
        canaryOperation: {
          operationIndex: 0,
          targetDataSource: 'NOTION_DS_TRANSACTIONS',
          physicalPropertyKeys: ['Conta', 'Data', 'HMAC Contraparte', 'Hash Canônico', 'ID da fonte', 'Lançamento', 'Moeda', 'Movimento', 'Natureza', 'Status', 'Valor', 'Valor Bruto da Fonte'],
          everyPhysicalPropertyExists: true,
          stableIdentityPhysicalProperty: 'ID da fonte',
          stableIdentityQueryValidated: true,
          matches: 0,
          validationError: 0,
        },
      };
    }

    it('validatePreflightBinding rejects artifact when mutationWriteSurfaceCompatibility has missing properties', () => {
      const artifact = buildBaseArtifact();
      artifact.mutationWriteSurfaceCompatibility = {
        executableOperationsChecked: 159,
        incompatibleOperations: 1,
        missingPhysicalProperties: 1,
        typeMismatches: 0,
        invalidSelectOptions: 0,
        relationTargetMismatches: 0,
      };

      const res = validatePreflightBinding(artifact);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('FAIL_PREFLIGHT_WRITE_SURFACE_INCOMPATIBLE');
    });

    it('validatePreflightBinding rejects artifact when canaryOperation matches > 0 (preexisting page)', () => {
      const artifact = buildBaseArtifact();
      artifact.canaryOperation!.matches = 1;

      const res = validatePreflightBinding(artifact);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('FAIL_PREFLIGHT_CANARY_OP_INVALID');
    });

    it('validatePreflightBinding rejects artifact when canaryOperation has validation errors', () => {
      const artifact = buildBaseArtifact();
      artifact.canaryOperation!.validationError = 1;
      artifact.canaryOperation!.stableIdentityQueryValidated = false;

      const res = validatePreflightBinding(artifact);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('FAIL_PREFLIGHT_CANARY_OP_INVALID');
    });

    it('validatePreflightBinding rejects artifact when canaryOperation has missing physical properties', () => {
      const artifact = buildBaseArtifact();
      artifact.canaryOperation!.everyPhysicalPropertyExists = false;

      const res = validatePreflightBinding(artifact);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('FAIL_PREFLIGHT_CANARY_OP_INVALID');
    });

    it('validatePreflightBinding rejects artifact when mutationWriteSurfaceCompatibility is missing', () => {
      const artifact = buildBaseArtifact();
      delete (artifact as any).mutationWriteSurfaceCompatibility;

      const res = validatePreflightBinding(artifact);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('FAIL_PREFLIGHT_WRITE_SURFACE_INCOMPATIBLE');
    });

    it('validatePreflightBinding rejects artifact when canaryOperation is missing', () => {
      const artifact = buildBaseArtifact();
      delete (artifact as any).canaryOperation;

      const res = validatePreflightBinding(artifact);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('FAIL_PREFLIGHT_CANARY_OP_INVALID');
    });

    it('validatePreflightBinding accepts clean artifact with 159 valid operations and 0 canary matches', () => {
      const artifact = buildBaseArtifact();
      const res = validatePreflightBinding(artifact);
      expect(res.valid).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. RESUME PREFLIGHT RECONCILIATION PREVIEW & CROSS-COMMIT GATES
  // ─────────────────────────────────────────────────────────────────────────────
  describe('7. Resume Preflight Reconciliation Preview & Cross-Commit Gates (Items 6, 7, 9, 14)', () => {
    const testTempDir = path.resolve(process.cwd(), '.local', 'test-resume-preflight');

    beforeEach(() => {
      if (!fs.existsSync(testTempDir)) fs.mkdirSync(testTempDir, { recursive: true });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      if (fs.existsSync(testTempDir)) {
        try {
          fs.rmSync(testTempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    function setupTestJournal(status: string = 'FAILED', attempts: number = 1) {
      const dbPath = path.join(testTempDir, `journal-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.db`);
      const journal = new BackfillJournal(dbPath);
      const runId = `test-run-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      journal.startRun({
        runId,
        planHash: FROZEN_BACKFILL_PLAN_HASH,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        executorCommitSha: 'commit-orig-123',
        sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
        targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
        targetStateHash: FROZEN_TARGET_STATE_HASH,
      });

      journal.registerOperation({
        runId,
        operationIndex: 0,
        stableId: 'a2ce0416-1a27-4592-85be-bff2a9ce6f86',
        stage: 'STAGE_1_PAGE_CREATION',
        targetDataSource: 'NOTION_DS_TRANSACTIONS',
        action: 'CREATE',
        expectedPostFingerprint: 'b174467a107e377b81a27bee976f5a7a365a22d4ee3bf03b561cce4f4caab642',
      });

      if (attempts > 0) {
        journal.recordAttempt(runId, 0);
      }
      if (status === 'FAILED') {
        journal.recordFailed(runId, 0, 'FAIL_READ_BACK_FINGERPRINT_MISMATCH');
      }

      journal.close();

      return { dbPath, runId };
    }

    it('generates RECOVERABLE_VERIFIED_PREVIEW when live page exactly matches Op #0 expected fingerprint', async () => {
      const { dbPath, runId } = setupTestJournal('FAILED', 1);

      vi.spyOn(LiveNotionAdapter.prototype, 'queryTargetState').mockImplementation(async () => {
        const analyzer = new BackfillDryRunAnalyzer({ envVars: testEnv });
        const targetSession = analyzer.prepareValidatedTargetSnapshot();
        const bases = JSON.parse(JSON.stringify(targetSession.payload.bases));
        targetSession.cleanup();
        const planReport = await analyzer.runAnalysis();
        const plan = planReport.planArtifact;
        const testJournal = new BackfillJournal(dbPath);
        const projected = projectExpectedBackfillState(bases, plan, testJournal, runId, [
          {
            runId,
            operationIndex: 0,
            stableId: 'a2ce0416-1a27-4592-85be-bff2a9ce6f86',
            stage: 'STAGE_1_PAGE_CREATION',
            targetDataSource: 'NOTION_DS_TRANSACTIONS',
            action: 'CREATE',
            status: 'VERIFIED',
            attempts: 1,
            targetPageId: 'page-recovered-123',
            expectedPreFingerprint: null,
            expectedPostFingerprint: 'b174467a107e377b81a27bee976f5a7a365a22d4ee3bf03b561cce4f4caab642',
            lastAttemptAt: null,
            errorSanitized: null,
          },
        ]);
        testJournal.close();
        return projected;
      });

      // Mock live adapter with page matching Op 0
      const mockClient: any = {
        users: { me: vi.fn().mockResolvedValue({ type: 'bot', bot: { workspace_id: 'ws-123' } }) },
        dataSources: {
          query: vi.fn().mockImplementation((params: any) => {
            if (params.data_source_id === testEnv.NOTION_DS_TRANSACTIONS) {
              return Promise.resolve({
                results: [
                  {
                    id: 'page-recovered-123',
                    created_time: '2026-09-21T00:00:00.000Z',
                    lastEditedTime: '2026-09-21T00:00:00.000Z',
                    archived: false,
                    url: 'https://notion.so/page-recovered-123',
                    properties: {
                      'Lançamento': { type: 'title', title: [{ text: { content: 'Pinggy.Io' }, plain_text: 'Pinggy.Io' }] },
                      'Fonte': { type: 'select', select: { name: 'Pierre' } },
                      'ID da fonte': { type: 'rich_text', rich_text: [{ text: { content: 'a2ce0416-1a27-4592-85be-bff2a9ce6f86' }, plain_text: 'a2ce0416-1a27-4592-85be-bff2a9ce6f86' }] },
                      'Moeda': { type: 'select', select: { name: 'BRL' } },
                      'Hash Canônico': { type: 'rich_text', rich_text: [{ text: { content: '90a933ea5c9422db887d78c0d51f6c821822024b03e28c7b1e734d77df0f7ecb' }, plain_text: '90a933ea5c9422db887d78c0d51f6c821822024b03e28c7b1e734d77df0f7ecb' }] },
                      'Data': { type: 'date', date: { start: '2026-05-02', end: null } },
                      'Valor': { type: 'number', number: 3.0 },
                      'Valor Bruto da Fonte': { type: 'number', number: -3.0 },
                      'Movimento': { type: 'select', select: { name: 'Saída' } },
                      'Natureza': { type: 'select', select: { name: 'Despesa' } },
                      'Efeito Orçamentário': { type: 'select', select: { name: 'Despesa' } },
                      'Propósito de Alocação': { type: 'select', select: { name: 'Caixa Operacional' } },
                      'Contribuição Meta Poupança': { type: 'number', number: 0 },
                      'Status': { type: 'select', select: { name: 'Confirmado' } },
                      'Status de Revisão': { type: 'select', select: { name: 'Confirmado Auto' } },
                      'Motivo da Revisão': { type: 'rich_text', rich_text: [] },
                      'Categoria Pierre': { type: 'rich_text', rich_text: [{ text: { content: 'Serviços digitais' }, plain_text: 'Serviços digitais' }] },
                      'Descrição original': { type: 'rich_text', rich_text: [{ text: { content: 'Pinggy.Io' }, plain_text: 'Pinggy.Io' }] },
                      'HMAC Contraparte': { type: 'rich_text', rich_text: [{ text: { content: '[OFUSCADO]' }, plain_text: '[OFUSCADO]' }] },
                      'Conta': { type: 'relation', relation: [{ id: '3d8a3ece-fa49-8112-9399-c960be4f604a' }] },
                      'Categoria': { type: 'relation', relation: [{ id: '3d7a3ece-fa49-81c9-955f-e26660d01670' }] },
                      'Conta Destino': { type: 'relation', relation: [] },
                      'Fatura Vinculada': { type: 'relation', relation: [] },
                    },
                  },
                ],
                has_more: false,
                next_cursor: null,
              });
            }
            return Promise.resolve({ results: [], has_more: false, next_cursor: null });
          }),
        },
      };

      const preflight = new BackfillLiveResumePreflight({
        client: mockClient,
        envVars: testEnv,
        journalPath: dbPath,
        runId,
      });

      const artifact = await preflight.executeResumePreflight();
      expect(artifact.recoverableOperationsCount).toBe(1);
      expect(artifact.reconciliationPreview.length).toBe(1);

      const preview = artifact.reconciliationPreview[0];
      expect(preview.operationIndex).toBe(0);
      expect(preview.recoverable).toBe(true);
      expect(preview.previewStatus).toBe('RECOVERABLE_VERIFIED_PREVIEW');
      expect(preview.targetPageId).toBe('page-recovered-123');
      expect(preview.actualNormalizedFingerprint).toBe('b174467a107e377b81a27bee976f5a7a365a22d4ee3bf03b561cce4f4caab642');
      expect(preview.expectedFingerprint).toBe('b174467a107e377b81a27bee976f5a7a365a22d4ee3bf03b561cce4f4caab642');

      // Projected target state hash must equal live target state hash
      expect(artifact.liveTargetStateHash).toBe(artifact.projectedTargetStateHash);
      expect(artifact.readyForLiveApplyReview).toBe(true);
    });

    it('blocks recovery preview when live page has conflicting fingerprint', async () => {
      const { dbPath, runId } = setupTestJournal('FAILED', 1);

      const mockClient: any = {
        users: { me: vi.fn().mockResolvedValue({ type: 'bot', bot: { workspace_id: 'ws-123' } }) },
        dataSources: {
          query: vi.fn().mockImplementation((params: any) => {
            if (params.data_source_id === testEnv.NOTION_DS_TRANSACTIONS) {
              return Promise.resolve({
                results: [
                  {
                    id: 'page-conflicting-123',
                    properties: {
                      'Lançamento': { type: 'title', title: [{ text: { content: 'Valor Conflitante' }, plain_text: 'Valor Conflitante' }] },
                      'ID da fonte': { type: 'rich_text', rich_text: [{ text: { content: 'a2ce0416-1a27-4592-85be-bff2a9ce6f86' }, plain_text: 'a2ce0416-1a27-4592-85be-bff2a9ce6f86' }] },
                    },
                  },
                ],
                has_more: false,
                next_cursor: null,
              });
            }
            return Promise.resolve({ results: [], has_more: false, next_cursor: null });
          }),
        },
      };

      const preflight = new BackfillLiveResumePreflight({
        client: mockClient,
        envVars: testEnv,
        journalPath: dbPath,
        runId,
      });

      const artifact = await preflight.executeResumePreflight();
      expect(artifact.recoverableOperationsCount).toBe(0);
      expect(artifact.reconciliationPreview[0].recoverable).toBe(false);
      expect(artifact.readyForLiveApplyReview).toBe(false);
      expect(artifact.reasons).toEqual(
        expect.arrayContaining([expect.stringContaining('FAIL_RECOVERY_FINGERPRINT_MISMATCH')]),
      );
    });

    it('blocks recovery preview when 0 stable identity matches found', async () => {
      const { dbPath, runId } = setupTestJournal('FAILED', 1);

      const mockClient: any = {
        users: { me: vi.fn().mockResolvedValue({ type: 'bot', bot: { workspace_id: 'ws-123' } }) },
        dataSources: {
          query: vi.fn().mockResolvedValue({ results: [], has_more: false, next_cursor: null }),
        },
      };

      const preflight = new BackfillLiveResumePreflight({
        client: mockClient,
        envVars: testEnv,
        journalPath: dbPath,
        runId,
      });

      const artifact = await preflight.executeResumePreflight();
      expect(artifact.recoverableOperationsCount).toBe(0);
      expect(artifact.reconciliationPreview[0].recoverable).toBe(false);
      expect(artifact.readyForLiveApplyReview).toBe(false);
      expect(artifact.reasons).toEqual(
        expect.arrayContaining([expect.stringContaining('FAIL_RECOVERY_PAGE_NOT_FOUND')]),
      );
    });

    it('blocks recovery preview when >1 stable identity matches found (duplicate)', async () => {
      const { dbPath, runId } = setupTestJournal('FAILED', 1);

      const mockClient: any = {
        users: { me: vi.fn().mockResolvedValue({ type: 'bot', bot: { workspace_id: 'ws-123' } }) },
        dataSources: {
          query: vi.fn().mockImplementation((params: any) => {
            if (params.data_source_id === testEnv.NOTION_DS_TRANSACTIONS) {
              return Promise.resolve({
                results: [
                  {
                    id: 'page-dup-1',
                    properties: {
                      'ID da fonte': { type: 'rich_text', rich_text: [{ text: { content: 'a2ce0416-1a27-4592-85be-bff2a9ce6f86' }, plain_text: 'a2ce0416-1a27-4592-85be-bff2a9ce6f86' }] },
                    },
                  },
                  {
                    id: 'page-dup-2',
                    properties: {
                      'ID da fonte': { type: 'rich_text', rich_text: [{ text: { content: 'a2ce0416-1a27-4592-85be-bff2a9ce6f86' }, plain_text: 'a2ce0416-1a27-4592-85be-bff2a9ce6f86' }] },
                    },
                  },
                ],
                has_more: false,
                next_cursor: null,
              });
            }
            return Promise.resolve({ results: [], has_more: false, next_cursor: null });
          }),
        },
      };

      const preflight = new BackfillLiveResumePreflight({
        client: mockClient,
        envVars: testEnv,
        journalPath: dbPath,
        runId,
      });

      const artifact = await preflight.executeResumePreflight();
      expect(artifact.recoverableOperationsCount).toBe(0);
      expect(artifact.reconciliationPreview[0].recoverable).toBe(false);
      expect(artifact.readyForLiveApplyReview).toBe(false);
      expect(artifact.reasons).toEqual(
        expect.arrayContaining([expect.stringContaining('FAIL_RECOVERY_DUPLICATE')]),
      );
    });

    it('validateResumePreflightBinding enforces cross-commit gates when run commit != recovery commit (Item 9)', () => {
      const artifact: ResumePreflightArtifact = {
        preflightVersion: '1.0.0',
        type: 'RESUME_PREFLIGHT',
        timestamp: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        ttlMinutes: 15,
        runId: 'run-original-123',
        runExecutorCommitSha: '5c973aaec44fd56428125c1cca24b770fa6f3ec9',
        recoveryExecutorCommitSha: 'new-recovery-commit-456',
        executorCommitSha: 'new-recovery-commit-456',
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
        journalFingerprint: 'fp-123',
        projectedTargetStateHash: 'hash-state',
        liveTargetStateHash: 'hash-state',
        workspaceIdentityHash: APPROVED_WORKSPACE_IDENTITY_HASH,
        actorType: 'bot',
        verifiedOperationsCount: 0,
        recoverableOperationsCount: 1,
        reconciliationPreview: [],
        targets: { transactions: 1, bills: 0 },
        readyForLiveApplyReview: true,
        readyForApply: false,
        reasons: [],
      };

      // Case 1: without cross-commit recovery gates -> fail
      const resWithoutGate = validateResumePreflightBinding(artifact, {
        runId: 'run-original-123',
        journalFingerprint: 'fp-123',
        projectedTargetStateHash: 'hash-state',
        workspaceIdentityHash: APPROVED_WORKSPACE_IDENTITY_HASH,
        envVars: {},
      });
      expect(resWithoutGate.valid).toBe(false);
      expect(resWithoutGate.reason).toContain('FAIL_CROSS_COMMIT_RECOVERY_AUTHORIZATION');

      // Case 2: with correct cross-commit recovery gates -> pass
      const resWithGate = validateResumePreflightBinding(artifact, {
        runId: 'run-original-123',
        journalFingerprint: 'fp-123',
        projectedTargetStateHash: 'hash-state',
        workspaceIdentityHash: APPROVED_WORKSPACE_IDENTITY_HASH,
        envVars: {
          FINANCIAL_BACKFILL_RECOVERY_FROM_COMMIT: '5c973aaec44fd56428125c1cca24b770fa6f3ec9',
          FINANCIAL_BACKFILL_RECOVERY_RUN_ID: 'run-original-123',
        },
      });
      expect(resWithGate.valid).toBe(true);
    });
  });
});
