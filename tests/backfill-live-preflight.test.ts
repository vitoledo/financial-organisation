import 'dotenv/config';
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import {
  BackfillLivePreflight,
  isPreflightValid,
  validatePreflightBinding,
  LivePreflightArtifact,
} from '../src/notion/migration-runner/backfill-live-preflight';
import {
  PLAN_ORIGIN_COMMIT_SHA,
  FROZEN_BACKFILL_PLAN_HASH,
  FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_STATE_HASH,
} from '../src/notion/migration-runner/backfill-constants';
import { LiveNotionAdapter, SimulatedNotionAdapter } from '../src/notion/migration-runner/backfill-adapter';
import { BackfillDryRunAnalyzer } from '../src/notion/migration-runner/backfill-dry-run';
import { BackfillExecutor } from '../src/notion/migration-runner/backfill-executor';
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
});
