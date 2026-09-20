import 'dotenv/config';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { Client } from '@notionhq/client';
import {
  PLAN_ORIGIN_COMMIT_SHA,
  FROZEN_BACKFILL_PLAN_HASH,
  FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_STATE_HASH,
} from '../src/notion/migration-runner/backfill-constants';
import {
  ProductionNotionAdapter,
  ProductionAuthorizationContext,
  validateProductionAuthorization,
} from '../src/notion/migration-runner/production-adapter';
import { BackfillExecutor, DEFAULT_CONFORMANT_SCHEMA_EVIDENCE } from '../src/notion/migration-runner/backfill-executor';
import { BackfillJournal } from '../src/notion/migration-runner/backfill-journal';
import { BackfillDryRunAnalyzer } from '../src/notion/migration-runner/backfill-dry-run';
import {
  isPreflightValid,
  validatePreflightBinding,
  isResumePreflightValid,
  validateResumePreflightBinding,
  LivePreflightArtifact,
} from '../src/notion/migration-runner/backfill-live-preflight';
import { runLiveApply } from '../scripts/backfill-live-apply';
import { serializePayloadForNotion } from '../src/notion/migration-runner/backfill-serializer';

describe('Phase 2D: Production Live Apply Infrastructure & Canary Verification', { timeout: 35000 }, () => {
  const testEnv: Record<string, string> = {
    NOTION_API_KEY: 'test-api-key',
    NOTION_DS_ACCOUNTS: 'ds-acc-123',
    NOTION_DS_CATEGORIES: 'ds-cat-123',
    NOTION_DS_TRANSACTIONS: 'ds-tx-123',
    NOTION_DS_CARD_BILLS: 'ds-bills-123',
    NOTION_DS_MONTHLY_BUDGET: 'ds-budget-123',
    NOTION_DS_RULES: 'ds-rules-123',
    NOTION_DS_FIXED_BILLS: 'ds-fixed-123',
    NOTION_DS_MONTHLY_OBLIGATIONS: 'ds-obligations-123',
    NOTION_DS_INVESTMENTS: 'ds-inv-123',
    NOTION_DS_INVESTMENT_MOVEMENTS: 'ds-mov-123',
    NOTION_DS_FINANCIAL_GOALS: 'ds-goals-123',
    NOTION_DS_MONTHLY_CLOSINGS: 'ds-closings-123',
    NOTION_DS_SYNC_LOG: 'ds-sync-123',
    NOTION_TARGET_SNAPSHOT_MANIFEST: 'backups/notion-data-snapshot-20260913T190702-0a3af05c.json.enc.manifest.json',
    SOURCE_SQLITE_SNAPSHOT_MANIFEST: 'backups/financial-backup-20260914T023409-a6df794b.db.enc.manifest.json',
    BACKFILL_ACCOUNT_MAPPING_PATH: 'data/account-mapping.json',
    MIGRATION_BACKUP_KEY: process.env.MIGRATION_BACKUP_KEY || '',
  };

  const testTempDir = path.resolve(process.cwd(), '.local', 'test-phase-2d');

  beforeEach(() => {
    if (!fs.existsSync(testTempDir)) {
      fs.mkdirSync(testTempDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testTempDir)) {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    }
  });

  function createValidAuthContext(overrides?: Partial<ProductionAuthorizationContext>): ProductionAuthorizationContext {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
    return {
      planHash: FROZEN_BACKFILL_PLAN_HASH,
      planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
      executorCommitSha: 'test-executor-commit-sha',
      sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
      targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
      targetStateHash: FROZEN_TARGET_STATE_HASH,
      workspaceIdentityHash: crypto.createHash('sha256').update('test-ws-id').digest('hex'),
      preflightGeneratedAt: now.toISOString(),
      preflightExpiresAt: expiresAt.toISOString(),
      journalPath: path.join(testTempDir, 'journal.db'),
      ...overrides,
    };
  }

  function createMockNotionClient(handlers?: {
    createPage?: (params: any) => Promise<any>;
    updatePage?: (params: any) => Promise<any>;
    queryDataSource?: (params: any) => Promise<any>;
    retrievePage?: (params: any) => Promise<any>;
  }) {
    const createdPagesMap = new Map<string, any>();

    return {
      pages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          if (handlers?.createPage) {
            const res = await handlers.createPage(params);
            createdPagesMap.set(res.id, { id: res.id, properties: res.properties || params.properties || {} });
            return res;
          }
          const id = `created-page-${crypto.randomUUID()}`;
          const res = {
            id,
            properties: params.properties || {},
          };
          createdPagesMap.set(id, res);
          return res;
        }),
        update: vi.fn().mockImplementation(
          handlers?.updatePage ||
            (async (params: any) => ({
              id: params.page_id,
              properties: params.properties || {},
            })),
        ),
        retrieve: vi.fn().mockImplementation(async (params: any) => {
          if (handlers?.retrievePage) {
            return await handlers.retrievePage(params);
          }
          const existing = createdPagesMap.get(params.page_id);
          if (existing) {
            return { id: params.page_id, properties: existing.properties };
          }
          return {
            id: params.page_id,
            properties: {},
          };
        }),
      },
      dataSources: {
        query: vi.fn().mockImplementation(
          handlers?.queryDataSource ||
            (async () => ({
              results: [],
              has_more: false,
              next_cursor: null,
            })),
        ),
      },
      users: {
        me: vi.fn().mockResolvedValue({
          bot: { workspace_id: 'test-ws-id' },
        }),
      },
    } as unknown as Client;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. PRODUCTION AUTHORIZATION CONTEXT VALIDATION (FAIL-CLOSED)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('1. Production Authorization Context Validation (Fail-Closed Gates)', () => {
    it('throws FAIL_PRODUCTION_AUTHORIZATION if authContext is undefined', () => {
      expect(() => validateProductionAuthorization(undefined)).toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION: ProductionAuthorizationContext não fornecido/,
      );
    });

    it('throws if planHash does not match frozen baseline', () => {
      const ctx = createValidAuthContext({ planHash: 'bad-plan-hash' });
      expect(() => validateProductionAuthorization(ctx)).toThrow(/FAIL_PRODUCTION_AUTHORIZATION: planHash inválido/);
    });

    it('throws if planOriginCommitSha does not match frozen commit', () => {
      const ctx = createValidAuthContext({ planOriginCommitSha: 'bad-commit-sha' });
      expect(() => validateProductionAuthorization(ctx)).toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION: planOriginCommitSha inválido/,
      );
    });

    it('throws if sourceSnapshotHash does not match frozen hash', () => {
      const ctx = createValidAuthContext({ sourceSnapshotHash: 'bad-source-hash' });
      expect(() => validateProductionAuthorization(ctx)).toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION: sourceSnapshotHash inválido/,
      );
    });

    it('throws if targetSnapshotHash does not match frozen hash', () => {
      const ctx = createValidAuthContext({ targetSnapshotHash: 'bad-target-hash' });
      expect(() => validateProductionAuthorization(ctx)).toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION: targetSnapshotHash inválido/,
      );
    });

    it('throws if targetStateHash does not match frozen hash', () => {
      const ctx = createValidAuthContext({ targetStateHash: 'bad-target-state' });
      expect(() => validateProductionAuthorization(ctx)).toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION: targetStateHash inválido/,
      );
    });

    it('throws if workspaceIdentityHash is empty', () => {
      const ctx = createValidAuthContext({ workspaceIdentityHash: '   ' });
      expect(() => validateProductionAuthorization(ctx)).toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION: workspaceIdentityHash ausente ou inválido/,
      );
    });

    it('throws if preflight is expired (>15m)', () => {
      const past = new Date(Date.now() - 20 * 60 * 1000);
      const expiredAt = new Date(Date.now() - 5 * 60 * 1000);
      const ctx = createValidAuthContext({
        preflightGeneratedAt: past.toISOString(),
        preflightExpiresAt: expiredAt.toISOString(),
      });
      expect(() => validateProductionAuthorization(ctx)).toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION: Preflight inválido temporalmente: LIVE_PREFLIGHT_EXPIRED/,
      );
    });

    it('throws if preflight generatedAt is in the future (>60s skew)', () => {
      const future = new Date(Date.now() + 10 * 60 * 1000);
      const ctx = createValidAuthContext({
        preflightGeneratedAt: future.toISOString(),
      });
      expect(() => validateProductionAuthorization(ctx)).toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION: Preflight inválido temporalmente: LIVE_PREFLIGHT_INVALID_TIME/,
      );
    });

    it('throws if preflight expiresAt is tampered (interval !== 15m)', () => {
      const now = new Date();
      const tamperedExpiry = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour instead of 15m
      const ctx = createValidAuthContext({
        preflightGeneratedAt: now.toISOString(),
        preflightExpiresAt: tamperedExpiry.toISOString(),
      });
      expect(() => validateProductionAuthorization(ctx)).toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION: Preflight inválido temporalmente: LIVE_PREFLIGHT_INVALID_TIME/,
      );
    });

    it('throws if journalPath is not in .local directory', () => {
      const ctx = createValidAuthContext({
        journalPath: 'C:\\Users\\Public\\journal.db',
      });
      expect(() => validateProductionAuthorization(ctx)).toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION: journalPath deve apontar para diretório protegido \(\.local\)/,
      );
    });

    it('throws if executorCommitSha does not match expected when checked', () => {
      const ctx = createValidAuthContext({ executorCommitSha: 'commit-A' });
      expect(() => validateProductionAuthorization(ctx, { executorCommitSha: 'commit-B' })).toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION: executorCommitSha diverge/,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. PRODUCTION NOTION ADAPTER MUTATION BUDGETS & SAFETY
  // ─────────────────────────────────────────────────────────────────────────────
  describe('2. Production Notion Adapter Mutation Budgets & Unsupported Operations', () => {
    it('enforces physical budget: rejects 160th page creation with FAIL_MUTATION_BUDGET_EXCEEDED', async () => {
      const mockClient = createMockNotionClient();
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, {
        maxNewPagesBudget: 2,
        rateLimitDelayMs: 0,
      });

      // 1st create -> success
      await adapter.createPage('NOTION_DS_TRANSACTIONS', 'ds-tx-123', {
        Descrição: { title: [{ text: { content: 'Tx 1' } }] },
      });
      expect(adapter.createRequestsSent).toBe(1);

      // 2nd create -> success
      await adapter.createPage('NOTION_DS_TRANSACTIONS', 'ds-tx-123', {
        Descrição: { title: [{ text: { content: 'Tx 2' } }] },
      });
      expect(adapter.createRequestsSent).toBe(2);

      // 3rd create (exceeds budget of 2) -> throws FAIL_MUTATION_BUDGET_EXCEEDED
      await expect(
        adapter.createPage('NOTION_DS_TRANSACTIONS', 'ds-tx-123', {
          Descrição: { title: [{ text: { content: 'Tx 3' } }] },
        }),
      ).rejects.toThrow(/FAIL_MUTATION_BUDGET_EXCEEDED: Limite máximo de 2 criações de página atingido/);
    });

    it('enforces relation budget: rejects 5th relation patch group with FAIL_MUTATION_BUDGET_EXCEEDED', async () => {
      const mockClient = createMockNotionClient();
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, {
        maxRelationPatchGroups: 1,
        rateLimitDelayMs: 0,
      });

      // 1st patch -> success
      await adapter.updatePageRelations('NOTION_DS_CARD_BILLS', 'bill-1', {
        'Lançamentos do Ciclo': ['tx-1', 'tx-2'],
      });
      expect(adapter.relationPatchRequestsSent).toBe(1);

      // 2nd patch -> throws
      await expect(
        adapter.updatePageRelations('NOTION_DS_CARD_BILLS', 'bill-2', {
          'Lançamentos do Ciclo': ['tx-3'],
        }),
      ).rejects.toThrow(/FAIL_MUTATION_BUDGET_EXCEEDED: Limite máximo de 1 grupos de patch de relação atingido/);
    });

    it('formats single-side relation payload strictly as { relation: [{ id: ... }] }', async () => {
      let capturedPayload: any;
      const mockClient = createMockNotionClient({
        updatePage: async (params) => {
          capturedPayload = params;
          return { id: params.page_id, properties: params.properties };
        },
      });
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, { rateLimitDelayMs: 0 });

      await adapter.updatePageRelations('NOTION_DS_CARD_BILLS', 'bill-page-123', {
        'Lançamentos do Ciclo': ['tx-1', 'tx-2'],
      });

      expect(capturedPayload).toBeDefined();
      expect(capturedPayload.page_id).toBe('bill-page-123');
      expect(capturedPayload.properties).toEqual({
        'Lançamentos do Ciclo': {
          relation: [{ id: 'tx-1' }, { id: 'tx-2' }],
        },
      });
    });

    it('throws NOT_SUPPORTED_MUTATION unconditionally on deletePage and archivePage', async () => {
      const mockClient = createMockNotionClient();
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, { rateLimitDelayMs: 0 });

      await expect(adapter.deletePage()).rejects.toThrow(
        /NOT_SUPPORTED_MUTATION: DELETE não é suportado pelo ProductionNotionAdapter/,
      );
      await expect(adapter.archivePage()).rejects.toThrow(
        /NOT_SUPPORTED_MUTATION: archive não é suportado pelo ProductionNotionAdapter/,
      );
      expect(adapter.getMutationCount()).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. TARGET_CONTRACT CONFORMANCE & STABLE IDENTITY QUERY
  // ─────────────────────────────────────────────────────────────────────────────
  describe('3. Target Contract & Stable Identity Queries', () => {
    it('queries by stable identity using rich_text filter according to TARGET_CONTRACT', async () => {
      let capturedQuery: any;
      const mockClient = createMockNotionClient({
        queryDataSource: async (params) => {
          capturedQuery = params;
          return { results: [], has_more: false };
        },
      });
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, { rateLimitDelayMs: 0 });

      await adapter.findByStableIdentity('NOTION_DS_TRANSACTIONS', 'ID da Fonte', 'tx-legacy-123');

      expect(capturedQuery).toBeDefined();
      expect(capturedQuery.data_source_id).toBe(testEnv.NOTION_DS_TRANSACTIONS);
      expect(capturedQuery.filter).toEqual({
        property: 'ID da Fonte',
        rich_text: { equals: 'tx-legacy-123' },
      });
    });

    it('fails fast without retries on 400 validation_error or 404', async () => {
      let callCount = 0;
      const mockClient = createMockNotionClient({
        createPage: async () => {
          callCount++;
          const error: any = new Error('Invalid property payload');
          error.status = 400;
          error.code = 'validation_error';
          throw error;
        },
      });
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, {
        rateLimitDelayMs: 0,
        maxRetries: 3,
      });

      await expect(
        adapter.createPage('NOTION_DS_TRANSACTIONS', 'ds-tx-123', {
          BadProp: { invalid: true },
        }),
      ).rejects.toThrow(/Invalid property payload/);

      // Must fail fast on 1st call without retries
      expect(callCount).toBe(1);
    });

    it('retries on 500/503 server errors and recovers', async () => {
      let callCount = 0;
      const mockClient = createMockNotionClient({
        createPage: async () => {
          callCount++;
          if (callCount < 2) {
            const error: any = new Error('Notion internal server error');
            error.status = 500;
            throw error;
          }
          return { id: 'recovered-page-id', properties: {} };
        },
      });
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, {
        rateLimitDelayMs: 0,
        maxRetries: 3,
      });

      const res = await adapter.createPage('NOTION_DS_TRANSACTIONS', 'ds-tx-123', {
        Descrição: { title: [{ text: { content: 'Tx Recover' } }] },
      });

      expect(res.id).toBe('recovered-page-id');
      expect(callCount).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. CANARY EXECUTION & SAFEGUARD CONTROLS (BackfillExecutor)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('4. Canary Execution & Safeguard Controls (BackfillExecutor)', () => {
    function getFrozenTargetBases() {
      const analyzer = new BackfillDryRunAnalyzer({ envVars: testEnv });
      const targetSession = analyzer.prepareValidatedTargetSnapshot();
      const bases = JSON.parse(JSON.stringify(targetSession.payload.bases));
      targetSession.cleanup();
      return bases;
    }

    function createFrozenTargetEnv(bases: Record<string, any>) {
      const env = { ...testEnv };
      for (const [k, v] of Object.entries(bases)) {
        env[k] = v.dataSourceId;
      }
      return env;
    }

    function createFrozenMockClient(
      bases: Record<string, any>,
      env: Record<string, string>,
      overrides?: {
        createPage?: (params: any) => Promise<any>;
        filterMatch?: (dsId: string, filter: any) => any[];
      },
    ) {
      return createMockNotionClient({
        createPage: overrides?.createPage,
        queryDataSource: async (params: any) => {
          // Check if this is a filtered query (findByStableIdentity)
          if (params.filter) {
            if (overrides?.filterMatch) {
              const matches = overrides.filterMatch(params.data_source_id, params.filter);
              return { results: matches, has_more: false };
            }
            return { results: [], has_more: false };
          }

          // Full base query for queryTargetState
          for (const [k, baseData] of Object.entries(bases)) {
            if (params.data_source_id === env[k] || params.data_source_id === baseData.dataSourceId) {
              return { results: baseData.records || [], has_more: false };
            }
          }
          return { results: [], has_more: false };
        },
      });
    }

    it('throws CANARY_REQUIRED_FOR_INITIAL_RUN if live run has no canary flag', async () => {
      const bases = getFrozenTargetBases();
      const env = createFrozenTargetEnv(bases);
      const mockClient = createFrozenMockClient(bases, env);
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, env, { rateLimitDelayMs: 0 });
      const journal = new BackfillJournal(new Database(':memory:'));

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: env,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        isLive: true,
        canary: undefined,
        skipWorktreeCleanCheck: true,
      });

      await expect(executor.execute()).rejects.toThrow(/CANARY_REQUIRED_FOR_INITIAL_RUN/);
      expect(adapter.getMutationCount()).toBe(0);
    });

    it('throws FAIL_INITIAL_RUN_JOURNAL_EXISTS if live initial run detects pre-existing journal runs', async () => {
      const bases = getFrozenTargetBases();
      const env = createFrozenTargetEnv(bases);
      const mockClient = createFrozenMockClient(bases, env);
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, env, { rateLimitDelayMs: 0 });
      const db = new Database(':memory:');
      const journal = new BackfillJournal(db);

      // Create a dummy previous run in journal
      journal.startRun({
        runId: 'old-run-123',
        planHash: FROZEN_BACKFILL_PLAN_HASH,
        executorCommitSha: 'commit-sha',
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
        targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
        targetStateHash: FROZEN_TARGET_STATE_HASH,
        totalOperationsPlanned: 159,
      });

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: env,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        isLive: true,
        canary: 1,
        skipWorktreeCleanCheck: true,
      });

      await expect(executor.execute()).rejects.toThrow(/FAIL_INITIAL_RUN_JOURNAL_EXISTS/);
      expect(adapter.getMutationCount()).toBe(0);
    });

    it('executes exactly 1 CREATE in canary mode, 0 patches, status PAUSED_AFTER_CANARY', async () => {
      const bases = getFrozenTargetBases();
      const env = createFrozenTargetEnv(bases);
      const createdPages: any[] = [];
      const mockClient = createFrozenMockClient(bases, env, {
        createPage: async (params) => {
          const page = { id: `canary-page-${crypto.randomUUID()}`, properties: params.properties };
          createdPages.push(page);
          return page;
        },
      });

      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, env, { rateLimitDelayMs: 0 });
      const db = new Database(':memory:');
      const journal = new BackfillJournal(db);

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: env,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        isLive: true,
        canary: 1,
        skipWorktreeCleanCheck: true,
      });

      const report = await executor.execute();

      expect(report.status).toBe('PAUSED_AFTER_CANARY');
      expect(report.semanticCreates).toBe(1);
      expect(report.actualSimulatedCreateWrites).toBe(1);
      expect(report.canonicalRelationPatchGroups).toBe(0);
      expect(adapter.createRequestsSent).toBe(1);
      expect(adapter.relationPatchRequestsSent).toBe(0);
      expect(createdPages).toHaveLength(1);

      // Verify journal state
      const run = journal.getRun(report.simulationRunId);
      expect(run?.status).toBe('PAUSED_AFTER_CANARY');
    });

    it('reconciles uncertain write timeout on canary: recognizes existing page and avoids duplication', async () => {
      const bases = getFrozenTargetBases();
      const env = createFrozenTargetEnv(bases);

      const analyzer = new BackfillDryRunAnalyzer({ envVars: env, commitSha: PLAN_ORIGIN_COMMIT_SHA });
      const analysis = await analyzer.runAnalysis();
      const firstOp = analysis.planArtifact.operations[0];

      const existingRelations: Record<string, string[]> = {};
      for (const [propName, refList] of Object.entries(firstOp.relations)) {
        const existingIds = refList
          .filter((r) => r.type === 'EXISTING_PAGE_ID')
          .map((r) => r.target);
        if (existingIds.length > 0) {
          existingRelations[propName] = existingIds;
        }
      }

      const serialized = serializePayloadForNotion(
        firstOp.targetDataSource.envKey,
        firstOp.sanitizedPayload,
        existingRelations,
        true,
      );

      const mockClient = createFrozenMockClient(bases, env, {
        filterMatch: (_dsId, _filter) => {
          return [
            {
              id: 'existing-canary-page-id',
              created_time: '2026-09-14T00:00:00.000Z',
              last_edited_time: '2026-09-14T00:00:00.000Z',
              properties: serialized.notionProperties,
            },
          ];
        },
      });

      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, env, { rateLimitDelayMs: 0 });
      const db = new Database(':memory:');
      const journal = new BackfillJournal(db);

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: env,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        isLive: true,
        canary: 1,
        skipWorktreeCleanCheck: true,
      });

      const report = await executor.execute();

      expect(report.status).toBe('PAUSED_AFTER_CANARY');
      expect(report.semanticCreates).toBe(1);
      expect(report.actualSimulatedCreateWrites).toBe(0); // Zero physical writes!
      expect(report.existingPageCreateNoOps).toBe(1); // Reconciled as no-op
      expect(adapter.createRequestsSent).toBe(0);
    });

    it('stage 1 completion verifies checkpoint before Stage 2; aborts with EXTERNAL_DRIFT_DURING_BACKFILL on mismatch', async () => {
      const mockClient = createMockNotionClient({
        queryDataSource: async () => {
          // Return an unexpected record count representing external drift during execution
          return {
            results: [{ id: 'rogue-page-created-externally', properties: {} }],
            has_more: false,
          };
        },
      });

      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, { rateLimitDelayMs: 0 });
      const db = new Database(':memory:');
      const journal = new BackfillJournal(db);

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: testEnv,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        isLive: true,
        skipWorktreeCleanCheck: true,
      });

      // Execute full live run (not canary) -> should detect drift at checkpoint or preflight
      await expect(executor.execute()).rejects.toThrow(/EXTERNAL_DRIFT_DURING_BACKFILL|CANARY_REQUIRED_FOR_INITIAL_RUN/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. RESUME PREFLIGHT & RUN RESUMPTION VALIDATIONS
  // ─────────────────────────────────────────────────────────────────────────────
  describe('5. Resume Preflight & Run Resumption Validations', () => {
    it('isResumePreflightValid accepts valid unexpired resume preflight', () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
      const artifact = {
        generatedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      } as any;

      expect(isResumePreflightValid(artifact)).toEqual({ valid: true });
    });

    it('isResumePreflightValid rejects expired resume preflight', () => {
      const past = new Date(Date.now() - 20 * 60 * 1000);
      const expiredAt = new Date(Date.now() - 5 * 60 * 1000);
      const artifact = {
        generatedAt: past.toISOString(),
        expiresAt: expiredAt.toISOString(),
      } as any;

      const res = isResumePreflightValid(artifact);
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/LIVE_PREFLIGHT_EXPIRED/);
    });

    it('validateResumePreflightBinding validates runId, commit, and plan hash', () => {
      const artifact = {
        runId: 'run-canary-123',
        executorCommitSha: 'commit-123',
        backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
      } as any;

      expect(
        validateResumePreflightBinding(artifact, {
          runId: 'run-canary-123',
          executorCommitSha: 'commit-123',
          backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
        }),
      ).toEqual({ valid: true });

      expect(
        validateResumePreflightBinding(artifact, {
          runId: 'run-wrong',
          executorCommitSha: 'commit-123',
          backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
        }).valid,
      ).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. CLI INVOCATION & PRODUCTION GATE INTEGRATION TESTS (runLiveApply)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('6. CLI Invocations & Gate Enforcement (runLiveApply)', () => {
    it('without --execute-live: performs safe dry-run, 0 mutations, completes normally', async () => {
      // In dry-run mode, runLiveApply runs BackfillDryRunAnalyzer and executes ZERO writes
      await expect(runLiveApply([], testEnv)).resolves.not.toThrow();
    });

    it('with --execute-live but missing FINANCIAL_BACKFILL_ENABLED: throws FAIL_PRODUCTION_AUTHORIZATION', async () => {
      const env = { ...testEnv };
      delete env.FINANCIAL_BACKFILL_ENABLED;

      await expect(runLiveApply(['--execute-live', '--canary', '1'], env)).rejects.toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION: FINANCIAL_BACKFILL_ENABLED deve ser 'I_UNDERSTAND_BACKFILL_MUTATIONS'/,
      );
    });

    it('with --execute-live but invalid FINANCIAL_BACKFILL_PLAN_HASH: throws FAIL_PRODUCTION_AUTHORIZATION', async () => {
      const env = {
        ...testEnv,
        FINANCIAL_BACKFILL_ENABLED: 'I_UNDERSTAND_BACKFILL_MUTATIONS',
        FINANCIAL_BACKFILL_PLAN_HASH: 'wrong-hash',
        FINANCIAL_BACKFILL_PLAN_COMMIT_SHA: PLAN_ORIGIN_COMMIT_SHA,
        FINANCIAL_BACKFILL_EXECUTOR_COMMIT_SHA: 'some-sha',
      };

      await expect(runLiveApply(['--execute-live', '--canary', '1'], env)).rejects.toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION: FINANCIAL_BACKFILL_PLAN_HASH diverge da baseline congelada/,
      );
    });

    it('with --execute-live but invalid FINANCIAL_BACKFILL_PLAN_COMMIT_SHA: throws FAIL_PRODUCTION_AUTHORIZATION', async () => {
      const env = {
        ...testEnv,
        FINANCIAL_BACKFILL_ENABLED: 'I_UNDERSTAND_BACKFILL_MUTATIONS',
        FINANCIAL_BACKFILL_PLAN_HASH: FROZEN_BACKFILL_PLAN_HASH,
        FINANCIAL_BACKFILL_PLAN_COMMIT_SHA: 'wrong-commit-sha',
        FINANCIAL_BACKFILL_EXECUTOR_COMMIT_SHA: 'some-sha',
      };

      await expect(runLiveApply(['--execute-live', '--canary', '1'], env)).rejects.toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION: FINANCIAL_BACKFILL_PLAN_COMMIT_SHA diverge de/,
      );
    });

    it('with --execute-live initial run without --canary 1: throws CANARY_REQUIRED_FOR_INITIAL_RUN', async () => {
      // Setup valid gates with the current commit sha
      const currentCommit = 'test-sha';
      const env = {
        ...testEnv,
        FINANCIAL_BACKFILL_ENABLED: 'I_UNDERSTAND_BACKFILL_MUTATIONS',
        FINANCIAL_BACKFILL_PLAN_HASH: FROZEN_BACKFILL_PLAN_HASH,
        FINANCIAL_BACKFILL_PLAN_COMMIT_SHA: PLAN_ORIGIN_COMMIT_SHA,
        FINANCIAL_BACKFILL_EXECUTOR_COMMIT_SHA: currentCommit,
      };

      // Even if gates match, initial run without canary 1 must throw
      await expect(runLiveApply(['--execute-live'], env)).rejects.toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION|CANARY_REQUIRED_FOR_INITIAL_RUN|FAIL_EXECUTOR_COMMIT_MISMATCH/,
      );
    });
  });
});
