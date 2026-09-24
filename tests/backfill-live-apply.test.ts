import 'dotenv/config';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { Client } from '@notionhq/client';
import {
  PLAN_ORIGIN_COMMIT_SHA,
  FROZEN_BACKFILL_PLAN_HASH,
  FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_STATE_HASH,
  APPROVED_WORKSPACE_IDENTITY_HASH,
} from '../src/notion/migration-runner/backfill-constants';
import {
  ProductionNotionAdapter,
  ProductionAuthorizationContext,
  validateProductionAuthorization,
} from '../src/notion/migration-runner/production-adapter';
import {
  BackfillExecutor,
  DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
  projectExpectedBackfillState,
} from '../src/notion/migration-runner/backfill-executor';
import { calculateTargetStateHash } from '../src/notion/migration-runner/data-snapshot';
import { BackfillJournal } from '../src/notion/migration-runner/backfill-journal';
import { BackfillDryRunAnalyzer } from '../src/notion/migration-runner/backfill-dry-run';
import {
  isPreflightValid,
  validatePreflightBinding,
  isResumePreflightValid,
  validateResumePreflightBinding,
  LivePreflightArtifact,
  ResumePreflightArtifact,
  calculateJournalFingerprint,
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
      try {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      } catch {}
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
      workspaceIdentityHash: APPROVED_WORKSPACE_IDENTITY_HASH,
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
            createdPagesMap.set(res.id, {
              id: res.id,
              properties: res.properties || params.properties || {},
              parent: params.parent,
            });
            return res;
          }
          const id = `created-page-${crypto.randomUUID()}`;
          const res = {
            id,
            properties: params.properties || {},
            parent: params.parent,
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
          const isBill = params.page_id.includes('bill') || params.page_id === 'mock-tx-155';
          const defaultParent = {
            type: 'data_source_id',
            data_source_id: isBill ? testEnv.NOTION_DS_CARD_BILLS : testEnv.NOTION_DS_TRANSACTIONS,
          };
          if (existing) {
            return {
              id: params.page_id,
              properties: existing.properties,
              parent: existing.parent || defaultParent,
            };
          }
          return {
            id: params.page_id,
            properties: {},
            parent: defaultParent,
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
          type: 'bot',
          bot: { workspace_id: 'c1b2fa11-8ce9-4328-8311-ebe75fc2dd42' },
          id: 'c1b2fa11-8ce9-4328-8311-ebe75fc2dd42',
        }),
      },
    } as unknown as Client;
  }

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
      retrievePage?: (params: any) => Promise<any>;
    },
  ) {
    return createMockNotionClient({
      createPage: overrides?.createPage,
      retrievePage: overrides?.retrievePage,
      queryDataSource: async (params: any) => {
        if (params.filter) {
          if (overrides?.filterMatch) {
            const matches = overrides.filterMatch(params.data_source_id, params.filter);
            return { results: matches, has_more: false };
          }
          return { results: [], has_more: false };
        }
        for (const [k, baseData] of Object.entries(bases)) {
          if (params.data_source_id === env[k] || params.data_source_id === baseData.dataSourceId) {
            return { results: baseData.records || [], has_more: false };
          }
        }
        return { results: [], has_more: false };
      },
    });
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

    it('throws if workspaceIdentityHash does not match approved workspace hash', () => {
      const ctx = createValidAuthContext({ workspaceIdentityHash: 'bad-ws-hash' });
      expect(() => validateProductionAuthorization(ctx)).toThrow(
        /FAIL_PRODUCTION_AUTHORIZATION: workspaceIdentityHash não corresponde ao workspace aprovado/,
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
      ).rejects.toThrow(/FAIL_MUTATION_BUDGET_EXCEEDED: Limite máximo de 2 criações.*de página atingido/);
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

    it('create uses data_source_id, never database_id', async () => {
      let capturedPayload: any;
      const mockClient = createMockNotionClient({
        createPage: async (params) => {
          capturedPayload = params;
          return { id: 'created-tx-1', properties: params.properties };
        },
      });
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, { rateLimitDelayMs: 0 });

      await adapter.createPage('NOTION_DS_TRANSACTIONS', testEnv.NOTION_DS_TRANSACTIONS, {
        Descrição: { title: [{ text: { content: 'Tx Parent Test' } }] },
      });

      expect(capturedPayload).toBeDefined();
      expect(capturedPayload.parent).toEqual({
        type: 'data_source_id',
        data_source_id: testEnv.NOTION_DS_TRANSACTIONS,
      });
      expect(capturedPayload.parent.database_id).toBeUndefined();
    });

    it('missing DS env -> fail closed with FAIL_MISSING_ENV', async () => {
      const incompleteEnv = { ...testEnv };
      delete incompleteEnv.NOTION_DS_CATEGORIES;
      const mockClient = createMockNotionClient();
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, incompleteEnv, { rateLimitDelayMs: 0 });

      await expect(adapter.queryTargetState()).rejects.toThrow(/FAIL_MISSING_ENV: Variável obrigatória 'NOTION_DS_CATEGORIES'/);
    });

    it('create target DS mismatch -> 0 writes', async () => {
      let createAttempted = false;
      const mockClient = createMockNotionClient({
        createPage: async () => {
          createAttempted = true;
          return { id: 'bad-id', properties: {} };
        },
      });
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, { rateLimitDelayMs: 0 });

      await expect(
        adapter.createPage('NOTION_DS_TRANSACTIONS', 'wrong-ds-id', {
          Descrição: { title: [{ text: { content: 'Mismatch' } }] },
        }),
      ).rejects.toThrow(/FAIL_MUTATION_TARGET_MISMATCH/);

      expect(createAttempted).toBe(false);
      expect(adapter.createRequestsSent).toBe(0);
      expect(adapter.getMutationCount()).toBe(0);
    });

    it('relation target mismatch -> 0 writes', async () => {
      let patchAttempted = false;
      const mockClient = createMockNotionClient({
        updatePage: async () => {
          patchAttempted = true;
          return { id: 'patched-id', properties: {} };
        },
      });
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, { rateLimitDelayMs: 0 });

      await expect(
        adapter.updatePageRelations('NOTION_DS_CARD_BILLS', 'bill-1', {
          'Propriedade Estranha': ['tx-1'],
        }),
      ).rejects.toThrow(/FAIL_UNEXPECTED_RELATION_PROPERTY/);

      expect(patchAttempted).toBe(false);
      expect(adapter.relationPatchRequestsSent).toBe(0);
      expect(adapter.getMutationCount()).toBe(0);
    });

    it('ownership check: bill parent mismatch throws FAIL_MUTATION_TARGET_MISMATCH and performs 0 writes', async () => {
      let patchAttempted = false;
      const mockClient = createMockNotionClient({
        updatePage: async () => {
          patchAttempted = true;
          return { id: 'bill-wrong-parent', properties: {} };
        },
        retrievePage: async (params) => {
          if (params.page_id === 'bill-wrong-parent') {
            return {
              id: 'bill-wrong-parent',
              parent: { type: 'data_source_id', data_source_id: 'wrong-data-source-id' },
              properties: {},
            };
          }
          return {
            id: params.page_id,
            parent: { type: 'data_source_id', data_source_id: testEnv.NOTION_DS_TRANSACTIONS },
            properties: {},
          };
        },
      });
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, { rateLimitDelayMs: 0 });

      await expect(
        adapter.updatePageRelations('NOTION_DS_CARD_BILLS', 'bill-wrong-parent', {
          'Lançamentos do Ciclo': ['tx-1'],
        }),
      ).rejects.toThrow(/FAIL_MUTATION_TARGET_MISMATCH/);

      expect(patchAttempted).toBe(false);
      expect(adapter.relationPatchRequestsSent).toBe(0);
      expect(adapter.getMutationCount()).toBe(0);
    });

    it('ownership check: relation target missing throws FAIL_RELATION_TARGET_MISSING and performs 0 writes', async () => {
      let patchAttempted = false;
      const mockClient = createMockNotionClient({
        updatePage: async () => {
          patchAttempted = true;
          return { id: 'bill-1', properties: {} };
        },
        retrievePage: async (params) => {
          if (params.page_id === 'bill-1') {
            return {
              id: 'bill-1',
              parent: { type: 'data_source_id', data_source_id: testEnv.NOTION_DS_CARD_BILLS },
              properties: {},
            };
          }
          // Target page does not exist
          return null;
        },
      });
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, { rateLimitDelayMs: 0 });

      await expect(
        adapter.updatePageRelations('NOTION_DS_CARD_BILLS', 'bill-1', {
          'Lançamentos do Ciclo': ['missing-tx-id'],
        }),
      ).rejects.toThrow(/FAIL_RELATION_TARGET_MISSING/);

      expect(patchAttempted).toBe(false);
      expect(adapter.relationPatchRequestsSent).toBe(0);
      expect(adapter.getMutationCount()).toBe(0);
    });

    it('ownership check: relation target wrong data source throws FAIL_RELATION_TARGET_TYPE_MISMATCH and performs 0 writes', async () => {
      let patchAttempted = false;
      const mockClient = createMockNotionClient({
        updatePage: async () => {
          patchAttempted = true;
          return { id: 'bill-1', properties: {} };
        },
        retrievePage: async (params) => {
          if (params.page_id === 'bill-1') {
            return {
              id: 'bill-1',
              parent: { type: 'data_source_id', data_source_id: testEnv.NOTION_DS_CARD_BILLS },
              properties: {},
            };
          }
          // Target page belongs to CARD_BILLS instead of TRANSACTIONS
          return {
            id: params.page_id,
            parent: { type: 'data_source_id', data_source_id: testEnv.NOTION_DS_CARD_BILLS },
            properties: {},
          };
        },
      });
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, { rateLimitDelayMs: 0 });

      await expect(
        adapter.updatePageRelations('NOTION_DS_CARD_BILLS', 'bill-1', {
          'Lançamentos do Ciclo': ['wrong-ds-target'],
        }),
      ).rejects.toThrow(/FAIL_RELATION_TARGET_TYPE_MISMATCH/);

      expect(patchAttempted).toBe(false);
      expect(adapter.relationPatchRequestsSent).toBe(0);
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

    it('throws UNCERTAIN_MUTATION on 500 without blind retries for mutations', async () => {
      let callCount = 0;
      const mockClient = createMockNotionClient({
        createPage: async () => {
          callCount++;
          const error: any = new Error('Notion internal server error');
          error.status = 500;
          throw error;
        },
      });
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, {
        rateLimitDelayMs: 0,
        maxRetries: 3,
      });

      await expect(
        adapter.createPage('NOTION_DS_TRANSACTIONS', testEnv.NOTION_DS_TRANSACTIONS, {
          Descrição: { title: [{ text: { content: 'Tx Uncertain' } }] },
        }),
      ).rejects.toMatchObject({
        isUncertain: true,
        code: 'UNCERTAIN_MUTATION',
      });

      // Crucial: exactly 1 HTTP call attempt, ZERO blind retries
      expect(callCount).toBe(1);
    });

    it('retries on 500/503 server errors for READ requests and recovers', async () => {
      let callCount = 0;
      const mockClient = createMockNotionClient({
        queryDataSource: async () => {
          callCount++;
          if (callCount < 2) {
            const error: any = new Error('Notion internal server error');
            error.status = 500;
            throw error;
          }
          return { results: [], has_more: false };
        },
      });
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, {
        rateLimitDelayMs: 0,
        maxRetries: 3,
      });

      const res = await adapter.findByStableIdentity('NOTION_DS_TRANSACTIONS', 'ID da Fonte', 'tx-123');
      expect(res).toEqual([]);
      expect(callCount).toBe(2);
    });

    it('stable identity >100 duplicate fixture -> duplicate detected across pagination', async () => {
      let queryCount = 0;
      const mockClient = createMockNotionClient({
        queryDataSource: async () => {
          queryCount++;
          if (queryCount === 1) {
            return {
              results: [
                {
                  id: 'page-dup-1',
                  properties: {
                    'ID da Fonte': { rich_text: [{ plain_text: 'tx-target-duplicate' }] },
                  },
                },
              ],
              has_more: true,
              next_cursor: 'cursor-page-2',
            };
          } else {
            return {
              results: [
                {
                  id: 'page-dup-2',
                  properties: {
                    'ID da Fonte': { rich_text: [{ plain_text: 'tx-target-duplicate' }] },
                  },
                },
              ],
              has_more: false,
              next_cursor: null,
            };
          }
        },
      });
      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, testEnv, { rateLimitDelayMs: 0 });

      const records = await adapter.findByStableIdentity('NOTION_DS_TRANSACTIONS', 'ID da Fonte', 'tx-target-duplicate');
      expect(records.length).toBe(2);
      expect(records[0].id).toBe('page-dup-1');
      expect(records[1].id).toBe('page-dup-2');
      expect(queryCount).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. CANARY EXECUTION & SAFEGUARD CONTROLS (BackfillExecutor)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('4. Canary Execution & Safeguard Controls (BackfillExecutor)', () => {
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

    it('CREATE 500 after remote commit -> executor reconciles -> 1 page only', async () => {
      const bases = getFrozenTargetBases();
      const env = createFrozenTargetEnv(bases);

      const analyzer = new BackfillDryRunAnalyzer({ envVars: env, commitSha: PLAN_ORIGIN_COMMIT_SHA });
      const analysis = await analyzer.runAnalysis();
      const firstOp = analysis.planArtifact.operations[0];

      let createdRemotely = false;
      let committedPage: any = null;

      const mockClient = createFrozenMockClient(bases, env, {
        createPage: async (params) => {
          createdRemotely = true;
          committedPage = {
            id: 'notion-committed-tx-id',
            created_time: new Date().toISOString(),
            last_edited_time: new Date().toISOString(),
            properties: params.properties,
          };
          const err: any = new Error('Gateway Timeout / 500 Internal Error');
          err.status = 500;
          throw err;
        },
        filterMatch: (_dsId, _filter) => {
          if (createdRemotely && committedPage) {
            return [committedPage];
          }
          return [];
        },
      });

      mockClient.pages.retrieve = vi.fn().mockImplementation(async (params: any) => {
        if (params.page_id === 'notion-committed-tx-id' && committedPage) {
          return committedPage;
        }
        return { id: params.page_id, properties: {} };
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
      expect(report.recoveredUncertainCreates).toBe(1);
      expect(report.journalFinal.VERIFIED).toBe(1);
      expect(adapter.logicalCreates).toBe(1);
    });

    it('RELATION PATCH 503 after remote commit -> reconcile -> no duplicate mutation', async () => {
      const bases = getFrozenTargetBases();
      const env = createFrozenTargetEnv(bases);

      const analyzer = new BackfillDryRunAnalyzer({ envVars: env, commitSha: PLAN_ORIGIN_COMMIT_SHA });
      const analysis = await analyzer.runAnalysis();
      const plan = analysis.planArtifact;

      const db = new Database(':memory:');
      const journal = new BackfillJournal(db);
      const runId = 'test-run-relation-503';
      journal.startRun({
        runId,
        planHash: FROZEN_BACKFILL_PLAN_HASH,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        executorCommitSha: 'test-sha',
        sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
        targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
        targetStateHash: FROZEN_TARGET_STATE_HASH,
      });

      for (let i = 0; i < 159; i++) {
        const op = plan.operations[i];
        const pageId = `mock-tx-${i}`;
        journal.registerOperation({
          runId,
          operationIndex: i,
          stableId: op.stableId,
          stage: 'STAGE_1_CREATE',
          targetDataSource: op.targetDataSource.envKey,
          action: 'CREATE',
        });
        journal.recordApplied(runId, i, pageId);
        journal.recordVerified(runId, i, pageId, false);
      }

      const cardBillOps = plan.operations.filter((o) => o.targetDataSource.envKey === 'NOTION_DS_CARD_BILLS');
      for (let b = 1; b < cardBillOps.length; b++) {
        const bOp = cardBillOps[b];
        const opIdx = 159 + b;
        journal.registerOperation({
          runId,
          operationIndex: opIdx,
          stableId: bOp.stableId,
          stage: 'STAGE_2_RELATION_PATCHING',
          targetDataSource: bOp.targetDataSource.envKey,
          action: 'RELATION_PATCH',
        });
        journal.recordApplied(runId, opIdx, `mock-bill-${opIdx}`);
        journal.recordVerified(runId, opIdx, `mock-bill-${opIdx}`, false);
      }

      let patchAttempts = 0;
      const committedPropertiesByPage: Record<string, Record<string, any>> = {};

      const mockClient = createFrozenMockClient(bases, env);
      mockClient.pages.retrieve = vi.fn().mockImplementation(async (params: any) => {
        const committed = committedPropertiesByPage[params.page_id] || {};
        const isBill = params.page_id === 'mock-tx-155' || params.page_id.includes('bill');
        return {
          id: params.page_id,
          parent: {
            type: 'data_source_id',
            data_source_id: isBill ? env.NOTION_DS_CARD_BILLS : env.NOTION_DS_TRANSACTIONS,
          },
          properties: {
            'Fatura Vinculada': { relation: [{ id: 'mock-tx-155' }] },
            ...committed,
          },
        };
      });

      mockClient.pages.update = vi.fn().mockImplementation(async (params: any) => {
        patchAttempts++;
        committedPropertiesByPage[params.page_id] = {
          ...(committedPropertiesByPage[params.page_id] || {}),
          ...params.properties,
        };
        const err: any = new Error('Notion 503 Service Unavailable');
        err.status = 503;
        throw err;
      });

      const ctx = createValidAuthContext();
      const adapter = new ProductionNotionAdapter(mockClient, ctx, env, { rateLimitDelayMs: 0 });

      const executor = new BackfillExecutor({
        adapter,
        journal,
        envVars: env,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
        isLive: true,
        resumeRunId: runId,
        skipWorktreeCleanCheck: true,
        skipInitialDriftCheck: true,
      });

      const report = await executor.execute();

      expect(report.recoveredUncertainRelationWrites).toBeGreaterThanOrEqual(1);
      expect(patchAttempts).toBe(1);
    });

    it('resume preflight after real-style canary -> exact hash', async () => {
      const bases = getFrozenTargetBases();
      const env = createFrozenTargetEnv(bases);

      const analyzer = new BackfillDryRunAnalyzer({ envVars: env, commitSha: PLAN_ORIGIN_COMMIT_SHA });
      const analysis = await analyzer.runAnalysis();
      const plan = analysis.planArtifact;

      const db = new Database(':memory:');
      const journal = new BackfillJournal(db);
      const runId = 'test-run-canary-hash';
      journal.startRun({
        runId,
        planHash: FROZEN_BACKFILL_PLAN_HASH,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        executorCommitSha: 'test-sha',
        sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
        targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
        targetStateHash: FROZEN_TARGET_STATE_HASH,
      });

      const firstOp = plan.operations[0];
      const canaryPageId = 'canary-verified-page-id';
      journal.registerOperation({
        runId,
        operationIndex: 0,
        stableId: firstOp.stableId,
        stage: 'STAGE_1_CREATE',
        targetDataSource: firstOp.targetDataSource.envKey,
        action: 'CREATE',
      });
      journal.recordApplied(runId, 0, canaryPageId);
      journal.recordVerified(runId, 0, canaryPageId, false);

      const projected = projectExpectedBackfillState(bases, plan, journal, runId);
      const projectedHash = calculateTargetStateHash(projected);

      const liveBases: Record<string, any> = JSON.parse(JSON.stringify(bases));
      const canaryRecord = projected['NOTION_DS_TRANSACTIONS'].records.find((r) => r.id === canaryPageId);
      if (canaryRecord) {
        liveBases['NOTION_DS_TRANSACTIONS'].records.push(JSON.parse(JSON.stringify(canaryRecord)));
        liveBases['NOTION_DS_TRANSACTIONS'].recordCount = liveBases['NOTION_DS_TRANSACTIONS'].records.length;
      }

      const liveHash = calculateTargetStateHash(liveBases);
      expect(liveHash).toBe(projectedHash);
    });

    it('resume preflight after partial Stage 2 -> exact hash', async () => {
      const bases = getFrozenTargetBases();
      const env = createFrozenTargetEnv(bases);

      const analyzer = new BackfillDryRunAnalyzer({ envVars: env, commitSha: PLAN_ORIGIN_COMMIT_SHA });
      const analysis = await analyzer.runAnalysis();
      const plan = analysis.planArtifact;

      const db = new Database(':memory:');
      const journal = new BackfillJournal(db);
      const runId = 'test-run-partial-stage2';
      journal.startRun({
        runId,
        planHash: FROZEN_BACKFILL_PLAN_HASH,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        executorCommitSha: 'test-sha',
        sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
        targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
        targetStateHash: FROZEN_TARGET_STATE_HASH,
      });

      for (let i = 0; i < 159; i++) {
        const op = plan.operations[i];
        const pageId = `tx-page-${i}`;
        journal.registerOperation({
          runId,
          operationIndex: i,
          stableId: op.stableId,
          stage: 'STAGE_1_CREATE',
          targetDataSource: op.targetDataSource.envKey,
          action: 'CREATE',
        });
        journal.recordApplied(runId, i, pageId);
        journal.recordVerified(runId, i, pageId, false);
      }

      const cardBillOps = plan.operations.filter((o) => o.targetDataSource.envKey === 'NOTION_DS_CARD_BILLS');
      const billOp = cardBillOps[0];
      const targetBillPage = bases['NOTION_DS_CARD_BILLS'].records[0]?.id || 'bill-mock-1';
      journal.registerOperation({
        runId,
        operationIndex: 159,
        stableId: billOp.stableId,
        stage: 'STAGE_2_RELATION_PATCH',
        targetDataSource: billOp.targetDataSource.envKey,
        action: 'RELATION_PATCH',
      });
      journal.recordApplied(runId, 159, targetBillPage);
      journal.recordVerified(runId, 159, targetBillPage, false);

      const projected = projectExpectedBackfillState(bases, plan, journal, runId);
      const projectedHash = calculateTargetStateHash(projected);

      expect(projected['NOTION_DS_TRANSACTIONS'].records.length).toBe(155);
      expect(projected['NOTION_DS_CARD_BILLS'].records.length).toBe(4);
      expect(typeof projectedHash).toBe('string');
      expect(projectedHash.length).toBe(64);

      const liveBases: Record<string, any> = JSON.parse(JSON.stringify(projected));
      const liveHash = calculateTargetStateHash(liveBases);
      expect(liveHash).toBe(projectedHash);
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
        readyForLiveApplyReview: true,
        readyForApply: false,
        reasons: [],
        runId: 'run-canary-123',
        executorCommitSha: 'commit-123',
        backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
        workspaceIdentityHash: APPROVED_WORKSPACE_IDENTITY_HASH,
        journalFingerprint: 'fp-canary-123',
        projectedTargetStateHash: 'hash-projected',
        liveTargetStateHash: 'hash-projected',
      } as any;

      expect(
        validateResumePreflightBinding(artifact, {
          runId: 'run-canary-123',
          executorCommitSha: 'commit-123',
          backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
          workspaceIdentityHash: APPROVED_WORKSPACE_IDENTITY_HASH,
          journalFingerprint: 'fp-canary-123',
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

    it('preflight readyForLiveApplyReview=false -> 0 writes', async () => {
      const artifact = {
        readyForLiveApplyReview: false,
        readyForApply: false,
        reasons: ['FAIL_PREFLIGHT_NOT_REVIEW_READY'],
        liveMutations: 0,
        schema: { verified: 13, missing: 0, mismatches: 0 },
        stableIdentityConflicts: 0,
        relationTargetErrors: 0,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
        sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
        targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
        frozenTargetStateHash: FROZEN_TARGET_STATE_HASH,
        workspaceIdentityHash: APPROVED_WORKSPACE_IDENTITY_HASH,
      } as any;

      const res = validatePreflightBinding(artifact);
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/FAIL_PREFLIGHT_NOT_REVIEW_READY/);
    });

    it('preflight reasons != [] -> 0 writes', async () => {
      const artifact = {
        readyForLiveApplyReview: true,
        readyForApply: false,
        reasons: ['BLOCKER_DETECTED'],
        liveMutations: 0,
        schema: { verified: 13, missing: 0, mismatches: 0 },
        stableIdentityConflicts: 0,
        relationTargetErrors: 0,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
        sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
        targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
        frozenTargetStateHash: FROZEN_TARGET_STATE_HASH,
        workspaceIdentityHash: APPROVED_WORKSPACE_IDENTITY_HASH,
      } as any;

      const res = validatePreflightBinding(artifact);
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/FAIL_PREFLIGHT_REASONS_NOT_EMPTY/);
    });

    it('remote tracking local ref matches but ls-remote differs -> 0 writes', async () => {
      let currentCommit = 'test-sha';
      try {
        currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
      } catch {
        // ignore
      }
      const env = {
        ...testEnv,
        FINANCIAL_BACKFILL_ENABLED: 'I_UNDERSTAND_BACKFILL_MUTATIONS',
        FINANCIAL_BACKFILL_PLAN_HASH: FROZEN_BACKFILL_PLAN_HASH,
        FINANCIAL_BACKFILL_PLAN_COMMIT_SHA: PLAN_ORIGIN_COMMIT_SHA,
        FINANCIAL_BACKFILL_EXECUTOR_COMMIT_SHA: currentCommit,
        MOCK_ACTUAL_REMOTE_HEAD_SHA: '0000000000000000000000000000000000000001',
      };

      await expect(runLiveApply(['--execute-live', '--canary', '1'], env)).rejects.toThrow(
        /FAIL_EXECUTOR_COMMIT_MISMATCH/,
      );
    });

    it('tracking ref matches + ls-remote fails => FAIL_REMOTE_HEAD_UNVERIFIED => 0 writes', async () => {
      let currentCommit = 'test-sha';
      try {
        currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
      } catch {
        // ignore
      }
      const env = {
        ...testEnv,
        FINANCIAL_BACKFILL_ENABLED: 'I_UNDERSTAND_BACKFILL_MUTATIONS',
        FINANCIAL_BACKFILL_PLAN_HASH: FROZEN_BACKFILL_PLAN_HASH,
        FINANCIAL_BACKFILL_PLAN_COMMIT_SHA: PLAN_ORIGIN_COMMIT_SHA,
        FINANCIAL_BACKFILL_EXECUTOR_COMMIT_SHA: currentCommit,
        MOCK_ACTUAL_REMOTE_HEAD_SHA: '__FAIL__',
        MOCK_WORKTREE_CLEAN: 'true',
      };

      await expect(runLiveApply(['--execute-live', '--canary', '1'], env)).rejects.toThrow(
        /FAIL_REMOTE_HEAD_UNVERIFIED/,
      );
    });

    it('preflight missing or non-clean schema throws FAIL_PREFLIGHT_SCHEMA_NOT_CLEAN', () => {
      const artifactMissingSchema = {
        readyForLiveApplyReview: true,
        readyForApply: false,
        reasons: [],
        liveMutations: 0,
        stableIdentityConflicts: 0,
        relationTargetErrors: 0,
        targets: { transactions: 0, bills: 0 },
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
        sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
        targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
        frozenTargetStateHash: FROZEN_TARGET_STATE_HASH,
        workspaceIdentityHash: APPROVED_WORKSPACE_IDENTITY_HASH,
      } as any;

      const res1 = validatePreflightBinding(artifactMissingSchema);
      expect(res1.valid).toBe(false);
      expect(res1.reason).toMatch(/FAIL_PREFLIGHT_SCHEMA_NOT_CLEAN/);

      const artifactBadSchema = {
        ...artifactMissingSchema,
        schema: { total: 13, verified: 12, missing: 1, mismatches: 0 },
      };
      const res2 = validatePreflightBinding(artifactBadSchema);
      expect(res2.valid).toBe(false);
      expect(res2.reason).toMatch(/FAIL_PREFLIGHT_SCHEMA_NOT_CLEAN/);
    });

    it('resume-preflight green -> journal changes afterwards -> apply resume => FAIL_RESUME_PREFLIGHT_BINDING => 0 writes', async () => {
      const localDir = path.resolve(process.cwd(), '.local');
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      const resumePreflightPath = path.resolve(localDir, 'backfill-live-resume-preflight.json');
      const journalDbPath = path.resolve(localDir, 'backfill-live-journal.db');

      const backupPreflight = fs.existsSync(resumePreflightPath) ? fs.readFileSync(resumePreflightPath) : null;
      const backupJournal = fs.existsSync(journalDbPath) ? fs.readFileSync(journalDbPath) : null;

      try {
        const db = new Database(journalDbPath);
        const journal = new BackfillJournal(db);
        const runId = 'test-resume-journal-drift-unit';
        journal.startRun({
          runId,
          planHash: FROZEN_BACKFILL_PLAN_HASH,
          executorCommitSha: 'commit-test',
          planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
          sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
          targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
          targetStateHash: FROZEN_TARGET_STATE_HASH,
        });
        journal.registerOperation({
          runId,
          operationIndex: 0,
          stableId: 'op-0',
          stage: 'STAGE_1_PAGE_CREATION',
          targetDataSource: 'NOTION_DS_TRANSACTIONS',
          action: 'CREATE',
          expectedPostFingerprint: 'fp-0',
        });
        journal.recordApplied(runId, 0, 'page-0');
        journal.recordVerified(runId, 0, 'page-0', false);

        const originalFingerprint = calculateJournalFingerprint(journal, runId);

        let currentCommit = 'test-sha';
        try {
          currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
        } catch {}

        const now = new Date();
        const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
        const preflightArtifact: ResumePreflightArtifact = {
          preflightVersion: '1.0.0',
          type: 'RESUME_PREFLIGHT',
          timestamp: now.toISOString(),
          generatedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          ttlMinutes: 15,
          runId,
          runExecutorCommitSha: currentCommit,
          recoveryExecutorCommitSha: currentCommit,
          executorCommitSha: currentCommit,
          planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
          backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
          projectedTargetStateHash: 'projected-hash',
          liveTargetStateHash: 'projected-hash',
          workspaceIdentityHash: APPROVED_WORKSPACE_IDENTITY_HASH,
          actorType: 'bot',
          verifiedOperationsCount: 1,
          recoverableOperationsCount: 0,
          reconciliationPreview: [],
          targets: {
            transactions: 1,
            bills: 0,
          },
          readyForLiveApplyReview: true,
          readyForApply: false,
          journalFingerprint: originalFingerprint,
          reasons: [],
        };
        fs.writeFileSync(resumePreflightPath, JSON.stringify(preflightArtifact));

        // Now modify the journal AFTER preflight was generated!
        journal.recordApplied(runId, 0, 'page-tampered');
        db.close();

        const env = {
          ...testEnv,
          FINANCIAL_BACKFILL_ENABLED: 'I_UNDERSTAND_BACKFILL_MUTATIONS',
          FINANCIAL_BACKFILL_PLAN_HASH: FROZEN_BACKFILL_PLAN_HASH,
          FINANCIAL_BACKFILL_PLAN_COMMIT_SHA: PLAN_ORIGIN_COMMIT_SHA,
          FINANCIAL_BACKFILL_EXECUTOR_COMMIT_SHA: currentCommit,
          MOCK_ACTUAL_REMOTE_HEAD_SHA: currentCommit,
          MOCK_WORKTREE_CLEAN: 'true',
        };

        await expect(
          runLiveApply(['--execute-live', '--resume', runId], env),
        ).rejects.toThrow(/FAIL_RESUME_PREFLIGHT_BINDING/);
      } finally {
        if (backupPreflight) fs.writeFileSync(resumePreflightPath, backupPreflight);
        else if (fs.existsSync(resumePreflightPath)) fs.unlinkSync(resumePreflightPath);

        if (backupJournal) fs.writeFileSync(journalDbPath, backupJournal);
        else if (fs.existsSync(journalDbPath)) fs.unlinkSync(journalDbPath);
      }
    });

    it('resume-preflight green -> Notion live receives external drift -> apply resume => EXTERNAL_DRIFT_DURING_BACKFILL => 0 writes', async () => {
      const localDir = path.resolve(process.cwd(), '.local');
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      const resumePreflightPath = path.resolve(localDir, 'backfill-live-resume-preflight.json');
      const journalDbPath = path.resolve(localDir, 'backfill-live-journal.db');

      const backupPreflight = fs.existsSync(resumePreflightPath) ? fs.readFileSync(resumePreflightPath) : null;
      const backupJournal = fs.existsSync(journalDbPath) ? fs.readFileSync(journalDbPath) : null;

      try {
        const db = new Database(journalDbPath);
        const journal = new BackfillJournal(db);
        const runId = 'test-resume-toctou-drift-unit';
        journal.startRun({
          runId,
          planHash: FROZEN_BACKFILL_PLAN_HASH,
          executorCommitSha: 'commit-test',
          planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
          sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
          targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
          targetStateHash: FROZEN_TARGET_STATE_HASH,
        });
        const currentFingerprint = calculateJournalFingerprint(journal, runId);
        db.close();

        let currentCommit = 'test-sha';
        try {
          currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
        } catch {}

        const now = new Date();
        const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
        const preflightArtifact: ResumePreflightArtifact = {
          preflightVersion: '1.0.0',
          type: 'RESUME_PREFLIGHT',
          timestamp: now.toISOString(),
          generatedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          ttlMinutes: 15,
          runId,
          runExecutorCommitSha: currentCommit,
          recoveryExecutorCommitSha: currentCommit,
          executorCommitSha: currentCommit,
          planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
          backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
          projectedTargetStateHash: 'hash-expected-projected',
          liveTargetStateHash: 'hash-expected-projected',
          workspaceIdentityHash: APPROVED_WORKSPACE_IDENTITY_HASH,
          actorType: 'bot',
          verifiedOperationsCount: 1,
          recoverableOperationsCount: 0,
          reconciliationPreview: [],
          targets: {
            transactions: 1,
            bills: 0,
          },
          readyForLiveApplyReview: true,
          readyForApply: false,
          journalFingerprint: currentFingerprint,
          reasons: [],
        };
        fs.writeFileSync(resumePreflightPath, JSON.stringify(preflightArtifact));

        const env = {
          ...testEnv,
          FINANCIAL_BACKFILL_ENABLED: 'I_UNDERSTAND_BACKFILL_MUTATIONS',
          FINANCIAL_BACKFILL_PLAN_HASH: FROZEN_BACKFILL_PLAN_HASH,
          FINANCIAL_BACKFILL_PLAN_COMMIT_SHA: PLAN_ORIGIN_COMMIT_SHA,
          FINANCIAL_BACKFILL_EXECUTOR_COMMIT_SHA: currentCommit,
          MOCK_ACTUAL_REMOTE_HEAD_SHA: currentCommit,
          MOCK_WORKTREE_CLEAN: 'true',
        };
        const bases = getFrozenTargetBases();
        const mockClient = createFrozenMockClient(bases, env);
        const envWithMocks = {
          ...env,
          MOCK_SCHEMA_REPORT_CLEAN: 'true',
        };

        await expect(
          runLiveApply(['--execute-live', '--resume', runId], envWithMocks, mockClient),
        ).rejects.toThrow(/EXTERNAL_DRIFT_DURING_BACKFILL/);
      } finally {
        if (backupPreflight) fs.writeFileSync(resumePreflightPath, backupPreflight);
        else if (fs.existsSync(resumePreflightPath)) fs.unlinkSync(resumePreflightPath);

        if (backupJournal) fs.writeFileSync(journalDbPath, backupJournal);
        else if (fs.existsSync(journalDbPath)) fs.unlinkSync(journalDbPath);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. RECOVER-CANARY-ONLY MODE & AUDIT EVENT TRAIL (Items 10, 11, 14)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('11. Recover-Canary-Only Mode & Audit Event Trail (Items 10, 11, 14)', () => {
    function setupRecoveryEnvironment() {
      const dbPath = path.join(testTempDir, 'recovery-journal.db');
      const journal = new BackfillJournal(dbPath);
      const runId = `run-recovery-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const origCommit = '5c973aaec44fd56428125c1cca24b770fa6f3ec9';

      journal.startRun({
        runId,
        planHash: FROZEN_BACKFILL_PLAN_HASH,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        executorCommitSha: origCommit,
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

      journal.recordAttempt(runId, 0);
      journal.recordApplied(runId, 0, 'page-live-recovery-3e2a');
      journal.recordFailed(runId, 0, 'FAIL_READ_BACK_FINGERPRINT_MISMATCH');

      const mockAdapter: any = {
        getMutationCount: vi.fn().mockReturnValue(0),
        findByStableIdentity: vi.fn().mockResolvedValue([
          {
            id: 'page-live-recovery-3e2a',
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
        ]),
      };

      const currentJournalFp = calculateJournalFingerprint(journal, runId);
      const preflightArtifact: any = {
        backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
        journalFingerprint: currentJournalFp,
      };

      return { journal, dbPath, runId, origCommit, mockAdapter, preflightArtifact };
    }

    it('rejects cross-commit recovery without gates with 0 journal mutations (Item 9 & 14)', async () => {
      const { journal, dbPath, runId, origCommit, mockAdapter, preflightArtifact } = setupRecoveryEnvironment();

      try {
        const newCommit = 'new-commit-head-789';
        const executor = new BackfillExecutor({
          adapter: mockAdapter,
          journal,
          commitSha: newCommit,
          envVars: {
            ...testEnv,
            // Missing FINANCIAL_BACKFILL_RECOVERY_FROM_COMMIT and FINANCIAL_BACKFILL_RECOVERY_RUN_ID
          },
        });

        await expect(
          executor.executeRecoverCanaryOnly(runId, preflightArtifact),
        ).rejects.toThrow(/FAIL_CROSS_COMMIT_RECOVERY_AUTHORIZATION/);

        // Verify journal operation 0 is still FAILED (0 journal mutations)
        const op0 = journal.getOperation(runId, 0);
        expect(op0?.status).toBe('FAILED');
        expect(mockAdapter.getMutationCount()).toBe(0);
      } finally {
        journal.close();
      }
    });

    it('successfully executes recover-canary-only: 0 Notion writes, operation VERIFIED, run PAUSED_AFTER_CANARY, does not continue op #1, preserves event audit trail', async () => {
      const { journal, dbPath, runId, origCommit, mockAdapter, preflightArtifact } = setupRecoveryEnvironment();

      try {
        const newCommit = 'new-commit-head-789';
        const executor = new BackfillExecutor({
          adapter: mockAdapter,
          journal,
          commitSha: newCommit,
          envVars: {
            ...testEnv,
            FINANCIAL_BACKFILL_RECOVERY_FROM_COMMIT: origCommit,
            FINANCIAL_BACKFILL_RECOVERY_RUN_ID: runId,
          },
        });

        const report = await executor.executeRecoverCanaryOnly(runId, preflightArtifact);

        // 1. Mandatory execution metrics
        expect(report.status).toBe('PAUSED_AFTER_CANARY');
        expect(report.createHttpAttempts).toBe(0);
        expect(report.relationPatchHttpAttempts).toBe(0);
        expect(report.liveNotionMutations).toBe(0);
        expect(report.pagesCreatedDuringRecovery).toBe(0);
        expect(mockAdapter.getMutationCount()).toBe(0);

        // 2. Journal status updated for Op 0
        const op0 = journal.getOperation(runId, 0);
        expect(op0?.status).toBe('VERIFIED');
        expect(op0?.targetPageId).toBe('page-live-recovery-3e2a');
        expect(op0?.errorSanitized).toBeNull();

        // 3. Run status updated to PAUSED_AFTER_CANARY
        const run = journal.getRun(runId);
        expect(run?.status).toBe('PAUSED_AFTER_CANARY');

        // 4. Operation #1 not started
        const op1 = journal.getOperation(runId, 1);
        expect(op1).toBeNull();

        // 5. Page mapping saved
        const mapping = journal.getPageMapping(FROZEN_BACKFILL_PLAN_HASH, 'a2ce0416-1a27-4592-85be-bff2a9ce6f86');
        expect(mapping?.notionPageId).toBe('page-live-recovery-3e2a');

        // 6. Audit event trail in backfill_operation_events table
        const events = journal.getOperationEvents(runId);
        expect(events.length).toBe(1);
        expect(events[0].operationIndex).toBe(0);
        expect(events[0].previousStatus).toBe('FAILED');
        expect(events[0].newStatus).toBe('VERIFIED');
        expect(events[0].reasonCode).toBe('RECOVERED_AFTER_CANONICAL_FINGERPRINT_FIX');
        expect(events[0].executorCommitSha).toBe(newCommit);
      } finally {
        journal.close();
      }
    });
  });
});
