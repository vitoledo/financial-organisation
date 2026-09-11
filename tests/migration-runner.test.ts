import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import {
  MigrationRunner,
  SchemaPlanner,
  BackfillPlanner,
  PreflightValidator,
  FinancialBackupManager,
  computePlanHash,
  verifyPlanHash,
  canonicalizeJson,
} from '../src/notion/migration-runner';
import {
  PERCENTAGE_CONVENTION,
  ratioToPercentage,
  percentageToRatio,
} from '../src/domain/schema-contract';
import {
  REAL_DATA_SOURCE_IDS,
  LIVE_NOTION_FIXTURES,
} from './contract-live-schema-fixtures.test';

describe('Notion Migration Runner (Phase 1 Dry-Run & Planning)', () => {
  let tempDir: string;
  let testDbPath: string;
  let testBackupDir: string;
  const validStrongBackupKey = 'super-secret-migration-backup-key-32-chars-long-2026';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-migration-runner-test-'));
    testDbPath = path.join(tempDir, 'financial.db');
    testBackupDir = path.join(tempDir, 'test-backups');

    // Initialize a valid SQLite database with a sample table and data
    const db = new Database(testDbPath);
    db.exec(`
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        amount REAL NOT NULL,
        description TEXT NOT NULL
      );
      INSERT INTO transactions (id, amount, description) VALUES ('tx-1', 150.50, 'Mercado');
      INSERT INTO transactions (id, amount, description) VALUES ('tx-2', 45.00, 'Café');
    `);
    db.close();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  describe('1. Dry-Run Safety & Execution Gate', () => {
    it('defaults unconditionally to dry-run mode when no mode is specified', () => {
      const runner = new MigrationRunner({
        dbPath: testDbPath,
        backupDir: testBackupDir,
        backupKey: validStrongBackupKey,
      });
      // @ts-expect-error private field access for test verification
      expect(runner.mode).toBe('dry-run');
    });

    it('produces a dry-run report with mutationsExecuted === 0 and does not perform any mutations', async () => {
      const runner = new MigrationRunner({
        mode: 'dry-run',
        dbPath: testDbPath,
        backupDir: testBackupDir,
        backupKey: validStrongBackupKey,
        worktreeStatusOverride: 'WORKTREE_CLEAN',
      });

      const report = await runner.runDryRun();

      expect(report.mode).toBe('dry-run');
      expect(report.mutationsExecuted).toBe(0);
      expect(report.plan).toBeDefined();
      expect(report.plan.planHash).toMatch(/^[a-f0-9]{64}$/);
      expect(report.backup.verifiedRestoration).toBe(true);
      expect(fs.existsSync(report.backup.manifestPath)).toBe(true);
    });

    it('working tree dirty blocks readiness with WORKTREE_DIRTY', async () => {
      const runner = new MigrationRunner({
        mode: 'dry-run',
        dbPath: testDbPath,
        backupDir: testBackupDir,
        backupKey: validStrongBackupKey,
        worktreeStatusOverride: 'WORKTREE_DIRTY',
        mockDirtyFiles: ['M src/domain/schema-contract.ts'],
      });

      const report = await runner.runDryRun();
      expect(report.readiness.worktreeStatus).toBe('WORKTREE_DIRTY');
      expect(report.readiness.dryRunValid).toBe(false);
      expect(report.readiness.applyReady).toBe(false);
      expect(report.readiness.reasons.some((r) => r.includes('WORKTREE_DIRTY'))).toBe(true);
      expect(report.readiness.dirtyFiles).toContain('M src/domain/schema-contract.ts');
    });

    it('unexpected schema mismatch blocks applyReady', async () => {
      // Create a corrupted live snapshot where NOTION_DS_CATEGORIES['Natureza padrão'] is rich_text instead of select
      const corruptedSnapshot: Record<string, Record<string, any>> = JSON.parse(
        JSON.stringify(LIVE_NOTION_FIXTURES),
      );
      corruptedSnapshot.NOTION_DS_CATEGORIES['Natureza padrão'] = {
        name: 'Natureza padrão',
        type: 'rich_text',
      };

      const runner = new MigrationRunner({
        mode: 'dry-run',
        dbPath: testDbPath,
        backupDir: testBackupDir,
        backupKey: validStrongBackupKey,
        worktreeStatusOverride: 'WORKTREE_CLEAN',
        liveSnapshotOverride: corruptedSnapshot,
        envVars: {
          ...REAL_DATA_SOURCE_IDS,
          NOTION_PARENT_PAGE_ID: '00000000-0000-0000-0000-000000000001',
        },
      });

      const report = await runner.runDryRun();
      expect(report.readiness.schemaConformance?.isConformant).toBe(false);
      expect(report.readiness.schemaConformance?.typeMismatches).toBeGreaterThanOrEqual(1);
      expect(report.readiness.applyReady).toBe(false);
      expect(report.readiness.reasons.some((r) => r.includes('SCHEMA_NON_CONFORMANT'))).toBe(true);
    });

    it('blocks apply execution if planHash is missing', async () => {
      const runner = new MigrationRunner({
        mode: 'apply',
        dbPath: testDbPath,
        backupDir: testBackupDir,
        backupKey: validStrongBackupKey,
        worktreeStatusOverride: 'WORKTREE_CLEAN',
      });

      await expect(runner.execute()).rejects.toThrow(/--plan-hash/);
    });

    it('blocks apply execution if planHash does not match computed hash', async () => {
      const runner = new MigrationRunner({
        mode: 'apply',
        dbPath: testDbPath,
        backupDir: testBackupDir,
        backupKey: validStrongBackupKey,
        worktreeStatusOverride: 'WORKTREE_CLEAN',
        envVars: {
          NOTION_PARENT_PAGE_ID: 'parent-page-uuid',
        },
      });

      const bogusHash = '0000000000000000000000000000000000000000000000000000000000000000';
      await expect(runner.execute(bogusHash)).rejects.toThrow();
    });

    it('parent ausente implica applyReady = false', async () => {
      const envWithoutParent: Record<string, string | undefined> = {
        ...process.env,
        NOTION_PARENT_PAGE_ID: undefined,
        NOTION_WORKSPACE_PAGE_ID: undefined,
      };
      const runner = new MigrationRunner({
        mode: 'dry-run',
        dbPath: testDbPath,
        backupDir: testBackupDir,
        backupKey: validStrongBackupKey,
        worktreeStatusOverride: 'WORKTREE_CLEAN',
        envVars: envWithoutParent,
      });

      const report = await runner.runDryRun();
      expect(report.readiness.dryRunValid).toBe(true);
      expect(report.readiness.applyReady).toBe(false);
      expect(report.readiness.reasons.some((r) => r.includes('NOTION_PARENT_PAGE_ID'))).toBe(true);
    });

    it('blocks apply execution with safeguard gate even when correct planHash and parent page are provided', async () => {
      const mockEnv: Record<string, string> = {
        NOTION_DS_ACCOUNTS: 'a1111111-1111-1111-1111-111111111111',
        NOTION_DS_TRANSACTIONS: 'a2222222-2222-2222-2222-222222222222',
        NOTION_DS_CATEGORIES: 'a3333333-3333-3333-3333-333333333333',
        NOTION_DS_RULES: 'a4444444-4444-4444-4444-444444444444',
        NOTION_DS_FIXED_BILLS: 'a5555555-5555-5555-5555-555555555555',
        NOTION_DS_MONTHLY_OBLIGATIONS: 'a6666666-6666-6666-6666-666666666666',
        NOTION_DS_INVESTMENTS: 'a7777777-7777-7777-7777-777777777777',
        NOTION_DS_INVESTMENT_MOVEMENTS: 'a8888888-8888-8888-8888-888888888888',
        NOTION_DS_MONTHLY_BUDGET: 'a9999999-9999-9999-9999-999999999999',
        NOTION_DS_FINANCIAL_GOALS: 'baaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        NOTION_DS_MONTHLY_CLOSINGS: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        NOTION_DS_SYNC_LOG: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        NOTION_PARENT_PAGE_ID: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      };

      const runnerDry = new MigrationRunner({
        mode: 'dry-run',
        dbPath: testDbPath,
        backupDir: testBackupDir,
        backupKey: validStrongBackupKey,
        worktreeStatusOverride: 'WORKTREE_CLEAN',
        envVars: mockEnv,
      });
      const dryReport = await runnerDry.runDryRun();
      const validHash = dryReport.plan.planHash;

      const runnerApply = new MigrationRunner({
        mode: 'apply',
        dbPath: testDbPath,
        backupDir: testBackupDir,
        backupKey: validStrongBackupKey,
        worktreeStatusOverride: 'WORKTREE_CLEAN',
        envVars: mockEnv,
      });

      await expect(runnerApply.execute(validHash)).rejects.toThrow();
    });
  });

  describe('2. Deterministic Plan Hashing & inputFingerprint', () => {
    it('generates identical planHash across multiple calls on the same plan and fingerprint', () => {
      const planner = new SchemaPlanner();
      const backfillPlanner = new BackfillPlanner();

      const fingerprint = {
        commitSha: 'commit-1234567890',
        notionApiVersion: '2026-03-11',
        parentPageId: 'page-abc',
        dataSourceIds: { NOTION_DS_ACCOUNTS: 'id-1' },
        liveSnapshotSha256: 'snapshot-hash-111',
      };

      const planA = {
        inputFingerprint: fingerprint,
        schemaPlan: planner.generatePlan(),
        backfillPlan: backfillPlanner.generatePlan(),
      };
      const planB = {
        inputFingerprint: fingerprint,
        schemaPlan: planner.generatePlan(),
        backfillPlan: backfillPlanner.generatePlan(),
      };

      const hashA = computePlanHash(planA);
      const hashB = computePlanHash(planB);

      expect(hashA).toBe(hashB);
      expect(verifyPlanHash(planA as any, hashA)).toBe(true);
    });

    it('mudança no live snapshot altera planHash', () => {
      const planner = new SchemaPlanner();
      const backfillPlanner = new BackfillPlanner();

      const fingerprintA = {
        commitSha: 'commit-1234567890',
        notionApiVersion: '2026-03-11',
        parentPageId: 'page-abc',
        dataSourceIds: { NOTION_DS_ACCOUNTS: 'id-1' },
        liveSnapshotSha256: 'snapshot-hash-AAA',
      };

      const fingerprintB = {
        commitSha: 'commit-1234567890',
        notionApiVersion: '2026-03-11',
        parentPageId: 'page-abc',
        dataSourceIds: { NOTION_DS_ACCOUNTS: 'id-1' },
        liveSnapshotSha256: 'snapshot-hash-BBB', // Changed snapshot
      };

      const planA = {
        inputFingerprint: fingerprintA,
        schemaPlan: planner.generatePlan(),
        backfillPlan: backfillPlanner.generatePlan(),
      };
      const planB = {
        inputFingerprint: fingerprintB,
        schemaPlan: planner.generatePlan(),
        backfillPlan: backfillPlanner.generatePlan(),
      };

      const hashA = computePlanHash(planA);
      const hashB = computePlanHash(planB);

      expect(hashA).not.toBe(hashB);
    });

    it('canonicalizes JSON with sorted keys independent of insertion order', () => {
      const obj1 = { b: 2, a: 1, c: { z: 26, y: 25 } };
      const obj2 = { c: { y: 25, z: 26 }, a: 1, b: 2 };

      expect(canonicalizeJson(obj1)).toBe(canonicalizeJson(obj2));
    });
  });

  describe('3. Schema Plan DDL Generation (54 Steps & Precise Modeling)', () => {
    it('generates exactly 54 deterministic schema steps with 50 CREATE_PROPERTY', () => {
      const planner = new SchemaPlanner();
      const plan = planner.generatePlan();

      expect(plan.summary.totalSteps).toBe(54);
      expect(plan.steps.length).toBe(54);

      expect(plan.summary.alterOptionsCount).toBe(1);
      expect(plan.summary.createPropertyCount).toBe(50);
      expect(plan.summary.createDatabaseCount).toBe(1);
      expect(plan.summary.resolveDataSourceCount).toBe(1);
      expect(plan.summary.dualRelationCount).toBe(1);
    });

    it('não existe CREATE_PROPERTY de Fatura Vinculada', () => {
      const planner = new SchemaPlanner();
      const plan = planner.generatePlan();

      const createPropSteps = plan.steps.filter((s) => s.operation === 'CREATE_PROPERTY');
      const faturaVinculadaCreateStep = createPropSteps.find(
        (s) =>
          s.targetDataSource.envKey === 'NOTION_DS_TRANSACTIONS' &&
          s.property === 'Fatura Vinculada',
      );

      expect(faturaVinculadaCreateStep).toBeUndefined();
    });

    it('existe exatamente uma relation dual Fatura Vinculada <-> Lançamentos do Ciclo', () => {
      const planner = new SchemaPlanner();
      const plan = planner.generatePlan();

      const dualRelationSteps = plan.steps.filter((s) => s.operation === 'CREATE_DUAL_RELATION');
      expect(dualRelationSteps.length).toBe(1);

      const dualStep = dualRelationSteps[0];
      expect(dualStep.targetDataSource.envKey).toBe('NOTION_DS_TRANSACTIONS');
      expect(dualStep.property).toBe('Fatura Vinculada');

      const relDef = dualStep.sanitizedPayload['Fatura Vinculada'].relation;
      expect(relDef.type).toBe('dual_property');
      expect(relDef.dual_property.synced_property_name).toBe('Lançamentos do Ciclo');
    });

    it('ALTER de Obrigações usa select e preserva IDs das opções existentes', () => {
      const liveSnapshotWithIds = {
        NOTION_DS_MONTHLY_OBLIGATIONS: {
          Status: {
            name: 'Status',
            type: 'select',
            selectOptions: [
              { id: 'opt-prevista-id', name: 'Prevista', color: 'gray' },
              { id: 'opt-pendente-id', name: 'Pendente', color: 'yellow' },
              { id: 'opt-paga-id', name: 'Paga', color: 'green' },
              { id: 'opt-atrasada-id', name: 'Atrasada', color: 'red' },
              { id: 'opt-dispensada-id', name: 'Dispensada', color: 'default' },
            ],
          },
        },
      };

      const planner = new SchemaPlanner({ liveSnapshot: liveSnapshotWithIds });
      const plan = planner.generatePlan();

      const step1 = plan.steps[0];
      expect(step1.stepNumber).toBe(1);
      expect(step1.operation).toBe('ALTER_SELECT_OPTIONS');
      expect(step1.targetDataSource.envKey).toBe('NOTION_DS_MONTHLY_OBLIGATIONS');
      expect(step1.property).toBe('Status');

      // Verify it uses 'select', NOT 'status'
      expect(step1.sanitizedPayload.Status.select).toBeDefined();
      expect(step1.sanitizedPayload.Status.status).toBeUndefined();

      const options = step1.sanitizedPayload.Status.select.options;
      expect(options.length).toBe(7);

      // Verify existing IDs are preserved without color
      expect(options[0]).toEqual({ id: 'opt-prevista-id', name: 'Prevista' });
      expect(options[1]).toEqual({ id: 'opt-pendente-id', name: 'Pendente' });
      expect(options[2]).toEqual({ id: 'opt-paga-id', name: 'Paga' });
      expect(options[3]).toEqual({ id: 'opt-atrasada-id', name: 'Atrasada' });
      expect(options[4]).toEqual({ id: 'opt-dispensada-id', name: 'Dispensada' });

      // Verify new options are appended without IDs and without color
      expect(options[5]).toEqual({ name: 'Revisão Necessária' });
      expect(options[6]).toEqual({ name: 'Cancelada' });

      // Verify no color property on any option
      for (const opt of options) {
        expect(opt.color).toBeUndefined();
      }
    });

    it('database resolution step explicitly retrieves /v1/databases/:id', () => {
      const planner = new SchemaPlanner();
      const plan = planner.generatePlan();
      const resolveStep = plan.steps.find((s) => s.operation === 'RESOLVE_DATA_SOURCE_ID');
      expect(resolveStep).toBeDefined();
      expect(resolveStep!.sanitizedPayload.method).toBe('GET');
      expect(resolveStep!.sanitizedPayload.endpoint).toBe('/v1/databases/{database.id}');
      expect(resolveStep!.sanitizedPayload.extractionPath).toBe('database.data_sources[0].id');
      expect(resolveStep!.metadata?.httpMethod).toBe('GET');
      expect(resolveStep!.precondition).toContain('GET /v1/databases/{database.id}');
    });

    it('verifies single percentage convention SCALE_0_TO_100_NUMBER and round-trip conversion', () => {
      expect(PERCENTAGE_CONVENTION).toBe('SCALE_0_TO_100_NUMBER');
      expect(ratioToPercentage(0.5)).toBe(50);
      expect(ratioToPercentage(1.0)).toBe(100);
      expect(ratioToPercentage(0)).toBe(0);
      expect(percentageToRatio(50)).toBe(0.5);
      expect(percentageToRatio(100)).toBe(1.0);
      expect(percentageToRatio(0)).toBe(0);

      const testRatios = [0.01, 0.25, 0.333, 0.5, 0.75, 1.0];
      for (const r of testRatios) {
        expect(percentageToRatio(ratioToPercentage(r))).toBeCloseTo(r, 6);
      }
    });

    it('CREATE_DATABASE possui initial_data_source e não possui properties no nível superior', () => {
      const planner = new SchemaPlanner({ parentPageId: 'my-parent-page-id' });
      const plan = planner.generatePlan();

      const createDbStep = plan.steps.find((s) => s.operation === 'CREATE_DATABASE')!;
      expect(createDbStep).toBeDefined();

      const payload = createDbStep.sanitizedPayload;
      expect(payload.parent).toEqual({ type: 'page_id', page_id: 'my-parent-page-id' });
      expect(payload.title).toEqual([
        { type: 'text', text: { content: 'Faturas / Ciclos de Cartão' } },
      ]);
      expect(payload.initial_data_source).toBeDefined();
      expect(payload.initial_data_source.properties).toBeDefined();
      expect(payload.properties).toBeUndefined(); // Strictly no properties at root
    });

    it('applies explicit numberFormat (real for currency, number for days/counts, percent for rates)', () => {
      const planner = new SchemaPlanner();
      const plan = planner.generatePlan();

      // Find 'Limite Operacional Usado' (monetary -> real)
      const limitStep = plan.steps.find((s) => s.property === 'Limite Operacional Usado')!;
      expect(limitStep.sanitizedPayload['Limite Operacional Usado'].number.format).toBe('real');

      // Find 'Dia de Fechamento' (day -> number)
      const dayStep = plan.steps.find((s) => s.property === 'Dia de Fechamento')!;
      expect(dayStep.sanitizedPayload['Dia de Fechamento'].number.format).toBe('number');

      // Find 'Duração (s)' (duration -> number)
      const durationStep = plan.steps.find((s) => s.property === 'Duração (s)')!;
      expect(durationStep.sanitizedPayload['Duração (s)'].number.format).toBe('number');
    });
  });

  describe('4. Backfill Plan Generation', () => {
    it('generates 5 distinct idempotent checkpointed backfill pipelines without invented fields', () => {
      const backfillPlanner = new BackfillPlanner();
      const plan = backfillPlanner.generatePlan();

      expect(plan.totalPipelines).toBe(5);

      const txPipeline = plan.pipelines.find((p) => p.id === 'PIPELINE_2_TRANSACTIONS')!;
      expect(txPipeline).toBeDefined();

      // BudgetEffect only INCOME | EXPENSE | REVERSAL | NEUTRAL; no EQUITY_TRANSFER
      expect(txPipeline.transformStrategy).toContain('INCOME');
      expect(txPipeline.transformStrategy).toContain('EXPENSE');
      expect(txPipeline.transformStrategy).toContain('REVERSAL');
      expect(txPipeline.transformStrategy).toContain('NEUTRAL');
      expect(txPipeline.transformStrategy).not.toContain('EQUITY_TRANSFER');

      // No invented Identity Quality or Impacto Caixa in Transações
      expect(txPipeline.description).not.toContain('Identity Quality');
      expect(txPipeline.description).not.toContain('Impacto Caixa');
      expect(txPipeline.description).not.toContain('Mês Orçamentário');

      // Card bills pipeline PERIOD_FALLBACK
      const cardPipeline = plan.pipelines.find((p) => p.id === 'PIPELINE_5_CARD_BILLS')!;
      expect(cardPipeline.transformStrategy).toContain(
        'source:account:periodStart:periodEnd:currency',
      );
      expect(cardPipeline.transformStrategy).toContain('Aberta em Curso');
      expect(cardPipeline.transformStrategy).toContain('Fechada a Vencer');
    });
  });

  describe('5. Encrypted Backup Module (Strict Security, VACUUM INTO/Backup API, Manifest Sidecar)', () => {
    it('DB ausente falha por padrão (allowEmptyDbForBackup = false)', async () => {
      const missingDbPath = path.join(tempDir, 'does-not-exist.db');
      const backupManager = new FinancialBackupManager({
        dbPath: missingDbPath,
        backupDir: testBackupDir,
        key: validStrongBackupKey,
        allowEmptyDbForBackup: false,
      });

      await expect(backupManager.createEncryptedBackup()).rejects.toThrow(/não encontrado/);
    });

    it('nenhum backup de DB real funciona sem chave ou com chave fraca (< 32 chars)', async () => {
      const backupManagerNoKey = new FinancialBackupManager({
        dbPath: testDbPath,
        backupDir: testBackupDir,
        key: undefined,
      });
      await expect(backupManagerNoKey.createEncryptedBackup()).rejects.toThrow(
        /Chave de backup ausente/,
      );

      const backupManagerWeakKey = new FinancialBackupManager({
        dbPath: testDbPath,
        backupDir: testBackupDir,
        key: 'short-key-1234',
      });
      await expect(backupManagerWeakKey.createEncryptedBackup()).rejects.toThrow(/Chave MIGRATION_BACKUP_KEY fraca/);

      const lowEntropyKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 32 chars but only 1 unique char
      const backupManagerLowEntropy = new FinancialBackupManager({
        dbPath: testDbPath,
        backupDir: testBackupDir,
        key: lowEntropyKey,
      });
      await expect(backupManagerLowEntropy.createEncryptedBackup()).rejects.toThrow(/entropia insuficiente/);
    });

    it('creates an encrypted backup file and sidecar manifest with localDatabaseScope, proving SQLite integrity', async () => {
      const hexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const backupManager = new FinancialBackupManager({
        dbPath: testDbPath,
        backupDir: testBackupDir,
        key: hexKey,
      });

      const result = await backupManager.createEncryptedBackup();

      expect(result.verifiedRestoration).toBe(true);
      expect(fs.existsSync(result.backupPath)).toBe(true);
      expect(fs.existsSync(result.manifestPath)).toBe(true);
      expect(result.originalSize).toBeGreaterThan(0);
      expect(result.encryptedSize).toBeGreaterThan(result.originalSize);
      expect(result.encryptedHashSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.originalDbSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.localDatabaseScope).toBe('LOCAL_FINANCIAL_DB_ONLY');
      expect(result.notionWorkspaceReconciliationNote).toContain('covers only the local database');

      // Verify sidecar manifest content
      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
      expect(manifest.format).toBe('FIN_ENC_V1');
      expect(manifest.algorithm).toBe('aes-256-gcm');
      expect(manifest.encryptedFileSha256).toBe(result.encryptedHashSha256);
      expect(manifest.originalDbSha256).toBe(result.originalDbSha256);
      expect(manifest.verifiedRestoration).toBe(true);
      expect(manifest.localDatabaseScope).toBe('LOCAL_FINANCIAL_DB_ONLY');
      expect(manifest.notionWorkspaceReconciliationNote).toContain('covers only the local database');
    });

    it('fails integrity test and throws error if backup file ciphertext is corrupted', async () => {
      const backupManager = new FinancialBackupManager({
        dbPath: testDbPath,
        backupDir: testBackupDir,
        key: validStrongBackupKey,
      });

      const result = await backupManager.createEncryptedBackup();

      // Corrupt ciphertext
      const corruptedBytes = Buffer.from(fs.readFileSync(result.backupPath));
      corruptedBytes[corruptedBytes.length - 10] ^= 0xff;
      fs.writeFileSync(result.backupPath, corruptedBytes);

      const restoreDest = path.join(tempDir, 'should-fail-restore.db');
      await expect(backupManager.restoreBackup(result.backupPath, restoreDest)).rejects.toThrow();
    });

    it('can restore backup to a new file and recover original database contents', async () => {
      const backupManager = new FinancialBackupManager({
        dbPath: testDbPath,
        backupDir: testBackupDir,
        key: validStrongBackupKey,
      });

      const result = await backupManager.createEncryptedBackup();

      const restoredDbPath = path.join(tempDir, 'restored-financial.db');
      await backupManager.restoreBackup(result.backupPath, restoredDbPath);

      expect(fs.existsSync(restoredDbPath)).toBe(true);

      const restoredDb = new Database(restoredDbPath, { readonly: true });
      const rows = restoredDb.prepare('SELECT * FROM transactions ORDER BY id ASC').all();
      restoredDb.close();

      expect(rows).toEqual([
        { id: 'tx-1', amount: 150.5, description: 'Mercado' },
        { id: 'tx-2', amount: 45.0, description: 'Café' },
      ]);
    });
  });

  describe('6. Preflight Read-Only Validation', () => {
    it('reports permissions as UNVERIFIED_UNTIL_APPLY and populates liveSnapshot directly', async () => {
      const calls: string[] = [];
      const mockClient: any = {
        dataSources: {
          retrieve: async (params: any) => {
            calls.push(`dataSources.retrieve:${params.data_source_id}`);
            return {
              properties: {
                Status: {
                  type: 'select',
                  select: {
                    options: [
                      { id: 'id-1', name: 'Prevista', color: 'gray' },
                      { id: 'id-2', name: 'Pendente', color: 'yellow' },
                    ],
                  },
                },
              },
            };
          },
        },
        pages: {
          retrieve: async (params: any) => {
            calls.push(`pages.retrieve:${params.page_id}`);
            return { id: params.page_id };
          },
        },
      };

      const mockEnv: Record<string, string> = {
        NOTION_DS_ACCOUNTS: 'a1111111-1111-1111-1111-111111111111',
        NOTION_DS_TRANSACTIONS: 'a2222222-2222-2222-2222-222222222222',
        NOTION_DS_CATEGORIES: 'a3333333-3333-3333-3333-333333333333',
        NOTION_DS_RULES: 'a4444444-4444-4444-4444-444444444444',
        NOTION_DS_FIXED_BILLS: 'a5555555-5555-5555-5555-555555555555',
        NOTION_DS_MONTHLY_OBLIGATIONS: 'a6666666-6666-6666-6666-666666666666',
        NOTION_DS_INVESTMENTS: 'a7777777-7777-7777-7777-777777777777',
        NOTION_DS_INVESTMENT_MOVEMENTS: 'a8888888-8888-8888-8888-888888888888',
        NOTION_DS_MONTHLY_BUDGET: 'a9999999-9999-9999-9999-999999999999',
        NOTION_DS_FINANCIAL_GOALS: 'baaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        NOTION_DS_MONTHLY_CLOSINGS: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        NOTION_DS_SYNC_LOG: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        NOTION_PARENT_PAGE_ID: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      };

      const validator = new PreflightValidator(mockClient);
      const preflight = await validator.runPreflight(mockEnv);

      expect(preflight.permissions).toBe('UNVERIFIED_UNTIL_APPLY');
      expect(preflight.apiVersion).toBe('2026-03-11');
      expect(preflight.valid).toBe(true);
      expect(preflight.dataSources.filter((d) => d.status === 'VERIFIED').length).toBe(12);

      // Verify liveSnapshot is populated and has SHA-256
      expect(Object.keys(preflight.liveSnapshot).length).toBe(12);
      expect(preflight.liveSnapshotSha256).toMatch(/^[a-f0-9]{64}$/);

      // Verify ONLY retrieve calls were made (strictly read-only)
      expect(
        calls.every((c) => c.startsWith('dataSources.retrieve') || c.startsWith('pages.retrieve')),
      ).toBe(true);
      expect(
        calls.some((c) => c.includes('update') || c.includes('create') || c.includes('delete')),
      ).toBe(false);
    });
  });
});
