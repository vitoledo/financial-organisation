import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import {
  MigrationRunner,
  TestableMigrationRunner,
  SchemaPlanner,
  BackfillPlanner,
  PreflightValidator,
  FinancialBackupManager,
  MigrationJournal,
  SchemaApplyExecutor,
  computePlanHash,
  verifyPlanHash,
  canonicalizeJson,
  StepStructuralVerifier,
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
  const validStrongBackupKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

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
      // @ts-expect-error protected field access for test verification
      expect(runner.mode).toBe('dry-run');
    });

    it('produces a dry-run report with mutationsExecuted === 0 and does not perform any mutations', async () => {
      const runner = new TestableMigrationRunner(
        {
          mode: 'dry-run',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
        },
      );

      const report = await runner.runDryRun();

      expect(report.mode).toBe('dry-run');
      expect(report.mutationsExecuted).toBe(0);
      expect(report.plan).toBeDefined();
      expect(report.plan.planHash).toMatch(/^[a-f0-9]{64}$/);
      expect(report.backup.verifiedRestoration).toBe(true);
      expect(fs.existsSync(report.backup.manifestPath)).toBe(true);
    });

    it('working tree dirty blocks readiness with WORKTREE_DIRTY', async () => {
      const runner = new TestableMigrationRunner(
        {
          mode: 'dry-run',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
        },
        {
          worktreeStatusOverride: 'WORKTREE_DIRTY',
          mockDirtyFiles: ['M src/domain/schema-contract.ts'],
        },
      );

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

      const runner = new TestableMigrationRunner(
        {
          mode: 'dry-run',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_PARENT_PAGE_ID: '00000000-0000-0000-0000-000000000001',
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          liveSnapshotOverride: corruptedSnapshot,
        },
      );

      const report = await runner.runDryRun();
      expect(report.readiness.schemaConformance?.isConformant).toBe(false);
      expect(report.readiness.schemaConformance?.typeMismatches).toBeGreaterThanOrEqual(1);
      expect(report.readiness.applyReady).toBe(false);
      expect(report.readiness.reasons.some((r) => r.includes('SCHEMA_NON_CONFORMANT'))).toBe(true);
    });

    it('blocks apply execution if planHash is missing', async () => {
      const runner = new TestableMigrationRunner(
        {
          mode: 'apply',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
        },
      );

      await expect(runner.execute()).rejects.toThrow(/--plan-hash/);
    });

    it('blocks apply execution if planHash does not match computed hash', async () => {
      const runner = new TestableMigrationRunner(
        {
          mode: 'apply',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          envVars: {
            NOTION_PARENT_PAGE_ID: 'parent-page-uuid',
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
        },
      );

      const bogusHash = '0000000000000000000000000000000000000000000000000000000000000000';
      await expect(runner.execute(bogusHash)).rejects.toThrow();
    });

    it('parent ausente implica applyReady = false', async () => {
      const envWithoutParent: Record<string, string | undefined> = {
        ...process.env,
        NOTION_PARENT_PAGE_ID: undefined,
        NOTION_WORKSPACE_PAGE_ID: undefined,
      };
      const runner = new TestableMigrationRunner(
        {
          mode: 'dry-run',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          envVars: envWithoutParent,
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
        },
      );

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

      const runnerDry = new TestableMigrationRunner(
        {
          mode: 'dry-run',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          envVars: mockEnv,
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
        },
      );
      const dryReport = await runnerDry.runDryRun();
      const validHash = dryReport.plan.planHash;

      const runnerApply = new TestableMigrationRunner(
        {
          mode: 'apply',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          envVars: mockEnv,
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
        },
      );

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

    it('nenhum backup de DB real funciona sem chave ou com chave que não decodifica para exatamente 32 bytes', async () => {
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
      await expect(backupManagerWeakKey.createEncryptedBackup()).rejects.toThrow(/Chave MIGRATION_BACKUP_KEY inválida/);

      const freeTextPassphrase = 'minha-frase-secreta-de-mais-de-trinta-e-dois-caracteres-longa';
      const backupManagerPassphrase = new FinancialBackupManager({
        dbPath: testDbPath,
        backupDir: testBackupDir,
        key: freeTextPassphrase,
      });
      await expect(backupManagerPassphrase.createEncryptedBackup()).rejects.toThrow(/Chave MIGRATION_BACKUP_KEY inválida/);

      const invalidLengthHex = '0123456789abcdef'; // only 16 hex chars (8 bytes, not 32)
      const backupManagerInvalidHex = new FinancialBackupManager({
        dbPath: testDbPath,
        backupDir: testBackupDir,
        key: invalidLengthHex,
      });
      await expect(backupManagerInvalidHex.createEncryptedBackup()).rejects.toThrow(/Chave MIGRATION_BACKUP_KEY inválida/);
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

  describe('7. MigrationJournal SQLite Persistence & Crash Recovery', () => {
    it('creates _migration_runs and _migration_journal tables and handles run lifecycle', () => {
      const journal = new MigrationJournal(testDbPath);
      const planHash = '1111111111111111111111111111111111111111111111111111111111111111';
      const runId = 'run_test_01';

      journal.startRun({
        runId,
        planHash,
        commitSha: 'commit_sha_123',
        gitBranch: 'feat/test',
      });

      let run = journal.getRun(runId);
      expect(run).toBeDefined();
      expect(run!.status).toBe('IN_PROGRESS');
      expect(run!.gitBranch).toBe('feat/test');

      journal.completeRun(runId);
      run = journal.getRun(runId);
      expect(run!.status).toBe('COMPLETED');
      expect(run!.completedAt).toBeDefined();

      const failedRunId = 'run_test_02';
      journal.startRun({
        runId: failedRunId,
        planHash,
        commitSha: 'commit_sha_123',
        gitBranch: 'feat/test',
      });
      journal.failRun(failedRunId, 'Erro simulado de timeout');
      const failedRun = journal.getRun(failedRunId);
      expect(failedRun!.status).toBe('FAILED');
      expect(failedRun!.errorSanitized).toBe('Erro simulado de timeout');
    });

    it('tracks step lifecycle transitions: PENDING -> APPLIED -> VERIFIED and NO_OP_VERIFIED', () => {
      const journal = new MigrationJournal(testDbPath);
      const planHash = '2222222222222222222222222222222222222222222222222222222222222222';

      // Record Step 1 PENDING
      journal.recordStepPending({
        planHash,
        stepNumber: 1,
        operation: 'ALTER_SELECT_OPTIONS',
        targetDataSource: 'Obrigações Mensais',
        propertyName: 'Status',
      });

      let step1 = journal.getStepStatus(planHash, 1);
      expect(step1?.status).toBe('PENDING');

      // Record Step 1 APPLIED
      journal.recordStepApplied(planHash, 1, undefined, { optionsCount: 7 });
      step1 = journal.getStepStatus(planHash, 1);
      expect(step1?.status).toBe('APPLIED');

      // Record Step 1 VERIFIED
      journal.recordStepVerified(planHash, 1, undefined, { verified: true });
      step1 = journal.getStepStatus(planHash, 1);
      expect(step1?.status).toBe('VERIFIED');
      expect(step1?.completedAt).toBeDefined();

      // Record Step 2 as NO_OP_VERIFIED
      journal.recordStepNoOp(planHash, 2, {
        operation: 'CREATE_PROPERTY',
        targetDataSource: 'Contas',
        propertyName: 'Limite Operacional Usado',
        existingId: 'prop_existing_123',
      });

      const step2 = journal.getStepStatus(planHash, 2);
      // Anti-regression: re-recording pending on a VERIFIED step does NOT revert it to PENDING
      journal.recordStepPending({
        planHash,
        stepNumber: 1,
        operation: 'ALTER_SELECT_OPTIONS',
        targetDataSource: 'Obrigações Mensais',
        propertyName: 'Status',
      });
      step1 = journal.getStepStatus(planHash, 1);
      expect(step1?.status).toBe('VERIFIED');
      expect(step1?.attempts).toBe(2);

      // Explicit revalidation failure is required to mark it FAILED
      journal.recordRevalidationFailed(planHash, 1, 'Simulated live drift failure');
      step1 = journal.getStepStatus(planHash, 1);
      expect(step1?.status).toBe('FAILED');
      expect(step1?.errorSanitized).toBe('Simulated live drift failure');

      // Once failed, a subsequent pending call can transition it back to PENDING
      journal.recordStepPending({
        planHash,
        stepNumber: 1,
        operation: 'ALTER_SELECT_OPTIONS',
        targetDataSource: 'Obrigações Mensais',
        propertyName: 'Status',
      });
      step1 = journal.getStepStatus(planHash, 1);
      expect(step1?.status).toBe('PENDING');
      expect(step1?.attempts).toBe(3);
    });

    it('stores and retrieves createdDatabaseId and resolvedDataSourceId', () => {
      const journal = new MigrationJournal(testDbPath);
      const planHash = '3333333333333333333333333333333333333333333333333333333333333333';

      // Step 52: CREATE_DATABASE
      journal.recordStepPending({
        planHash,
        stepNumber: 52,
        operation: 'CREATE_DATABASE',
        targetDataSource: 'Faturas / Ciclos de Cartão',
      });
      journal.recordStepVerified(planHash, 52, 'database_faturas_uuid_123');
      expect(journal.getCreatedDatabaseId(planHash)).toBe('database_faturas_uuid_123');

      // Step 53: RESOLVE_DATA_SOURCE_ID
      journal.recordStepPending({
        planHash,
        stepNumber: 53,
        operation: 'RESOLVE_DATA_SOURCE_ID',
        targetDataSource: 'Faturas / Ciclos de Cartão',
      });
      journal.recordStepVerified(planHash, 53, 'data_source_faturas_uuid_456');
      expect(journal.getResolvedDataSourceId(planHash)).toBe('data_source_faturas_uuid_456');
    });
  });

  function createMockCardBillsProperties(options: {
    includeDualRelation?: boolean;
    overrideProps?: Record<string, any>;
    omitProps?: string[];
    extraProps?: Record<string, any>;
  } = {}) {
    const base: Record<string, any> = {
      'Fatura / Ciclo': { id: 'p_title', type: 'title', title: {} },
      'Fonte': { id: 'p_fonte', type: 'select', select: { options: [{ name: 'Pierre' }, { name: 'Manual' }, { name: 'Migração' }, { name: 'Outra' }] } },
      'ID da Fatura na Fonte': { id: 'p_src_id', type: 'rich_text', rich_text: {} },
      'ID Estável da Fatura': { id: 'p_stable_id', type: 'rich_text', rich_text: {} },
      'Qualidade da Identidade': { id: 'p_ident_qual', type: 'select', select: { options: [{ name: 'SOURCE_ID' }, { name: 'PERIOD_FALLBACK' }] } },
      'Cartão Vinculado': { id: 'p_card', type: 'relation', relation: { data_source_id: REAL_DATA_SOURCE_IDS.NOTION_DS_ACCOUNTS, type: 'single_property' } },
      'Moeda': { id: 'p_curr', type: 'select', select: { options: [{ name: 'BRL' }, { name: 'USD' }, { name: 'EUR' }] } },
      'Início do Período': { id: 'p_start', type: 'date', date: {} },
      'Fim do Período': { id: 'p_end', type: 'date', date: {} },
      'Data de Fechamento': { id: 'p_close', type: 'date', date: {} },
      'Data de Vencimento': { id: 'p_due', type: 'date', date: {} },
      'Tipo de Ciclo': { id: 'p_cycle_type', type: 'select', select: { options: [{ name: 'Ciclo Real Banco' }, { name: 'Ciclo Configurado' }, { name: 'Ciclo Estimado' }] } },
      'Origem / Qualidade dos Dados': { id: 'p_val_qual', type: 'select', select: { options: [{ name: 'UPSTREAM_OFFICIAL' }, { name: 'UPSTREAM_APPROXIMATE' }, { name: 'DERIVED' }, { name: 'MANUAL' }] } },
      'Status da Fatura': { id: 'p_status', type: 'select', select: { options: [{ name: 'Aberta em Curso' }, { name: 'Fechada a Vencer' }, { name: 'Vencida' }, { name: 'Paga Integralmente' }, { name: 'Paga Parcialmente' }] } },
      'Valor da Fatura Fechada (Oficial)': { id: 'p_val_ofic', type: 'number', number: { format: 'real' } },
      'Valor Estimado da Fatura Aberta': { id: 'p_val_est', type: 'number', number: { format: 'real' } },
      'Total de Compras no Ciclo': { id: 'p_tot_comp', type: 'number', number: { format: 'real' } },
      'Componentes Adicionais da Fatura': { id: 'p_comp_adic', type: 'number', number: { format: 'real' } },
      'Divergência Não Explicada': { id: 'p_div_nao_exp', type: 'number', number: { format: 'real' } },
      'Valor Pago': { id: 'p_val_pago', type: 'number', number: { format: 'real' } },
      'Data de Liquidação': { id: 'p_data_liq', type: 'date', date: {} },
      'Transações de Pagamento': { id: 'p_tx_pag', type: 'relation', relation: { data_source_id: REAL_DATA_SOURCE_IDS.NOTION_DS_TRANSACTIONS, type: 'single_property' } },
    };

    if (options.includeDualRelation) {
      base['Lançamentos do Ciclo'] = {
        id: 'p_dual_ciclo',
        type: 'relation',
        relation: {
          data_source_id: REAL_DATA_SOURCE_IDS.NOTION_DS_TRANSACTIONS,
          type: 'dual_property',
          dual_property: { synced_property_name: 'Fatura Vinculada' },
        },
      };
    }

    if (options.overrideProps) {
      Object.assign(base, options.overrideProps);
    }

    if (options.extraProps) {
      Object.assign(base, options.extraProps);
    }

    if (options.omitProps) {
      for (const p of options.omitProps) {
        delete base[p];
      }
    }

    return base;
  }

  class StatefulNotionFake {
    public writeCallsCount = 0;
    public writeCallsByProperty: Record<string, number> = {};
    public dataSourcesMap: Map<string, any> = new Map();
    public databasesMap: Map<string, any> = new Map();

    constructor(initialFixtures: Record<string, Record<string, any>>) {
      for (const [envKey, dsId] of Object.entries(REAL_DATA_SOURCE_IDS)) {
        const rawProps = JSON.parse(JSON.stringify(initialFixtures[envKey] || {}));
        const props: Record<string, any> = {};
        for (const [pName, pDef] of Object.entries(rawProps)) {
          const def: any = { ...pDef };
          if (def.type === 'select') {
            const rawOpts = def.select?.options || def.selectOptions || [];
            def.select = {
              options: rawOpts.map((o: any, idx: number) => ({
                id: o.id || `opt_${idx}`,
                name: typeof o === 'string' ? o : o.name,
              })),
            };
          }
          props[pName] = def;
        }
        this.dataSourcesMap.set(dsId, {
          id: dsId,
          properties: props,
        });
      }
    }

    public dataSources = {
      retrieve: async ({ data_source_id }: { data_source_id: string }) => {
        const ds = this.dataSourcesMap.get(data_source_id);
        if (!ds) throw new Error(`Data Source '${data_source_id}' not found`);
        return JSON.parse(JSON.stringify(ds));
      },
      update: async ({ data_source_id, properties }: { data_source_id: string; properties: any }) => {
        this.writeCallsCount++;
        const ds = this.dataSourcesMap.get(data_source_id);
        if (!ds) throw new Error(`Data Source '${data_source_id}' not found`);

        for (const [propName, propDef] of Object.entries(properties)) {
          this.writeCallsByProperty[propName] = (this.writeCallsByProperty[propName] || 0) + 1;

          if ((propDef as any).select?.options) {
            ds.properties[propName] = {
              id: `prop_${propName}_id`,
              name: propName,
              type: 'select',
              select: {
                options: (propDef as any).select.options.map((o: any, idx: number) => ({
                  id: o.id || `opt_${idx}`,
                  name: o.name,
                })),
              },
            };
          } else if ((propDef as any).relation) {
            ds.properties[propName] = {
              id: `prop_${propName}_id`,
              name: propName,
              type: 'relation',
              relation: {
                data_source_id: (propDef as any).relation.data_source_id,
                type: (propDef as any).relation.type,
                dual_property: (propDef as any).relation.dual_property,
              },
            };
            const targetDsId = (propDef as any).relation.data_source_id;
            const targetDs = this.dataSourcesMap.get(targetDsId);
            const syncProp = (propDef as any).relation.dual_property?.synced_property_name;
            if (targetDs && syncProp) {
              targetDs.properties[syncProp] = {
                id: `prop_${syncProp}_id`,
                name: syncProp,
                type: 'relation',
                relation: {
                  data_source_id,
                  type: 'dual_property',
                  dual_property: { synced_property_name: propName },
                },
              };
            }
          } else if ((propDef as any).number) {
            ds.properties[propName] = {
              id: `prop_${propName}_id`,
              name: propName,
              type: 'number',
              number: (propDef as any).number,
            };
          } else if ((propDef as any).rich_text) {
            ds.properties[propName] = {
              id: `prop_${propName}_id`,
              name: propName,
              type: 'rich_text',
              rich_text: {},
            };
          } else {
            const pType = Object.keys(propDef as any)[0] || 'rich_text';
            ds.properties[propName] = {
              id: `prop_${propName}_id`,
              name: propName,
              type: pType,
              [pType]: (propDef as any)[pType],
            };
          }
        }

        return JSON.parse(JSON.stringify(ds));
      },
    };

    public databases = {
      retrieve: async ({ database_id }: { database_id: string }) => {
        const db = this.databasesMap.get(database_id);
        if (!db) throw new Error(`Database '${database_id}' not found`);
        return JSON.parse(JSON.stringify(db));
      },
      create: async (params: any) => {
        this.writeCallsCount++;
        const dbId = 'mock-db-id';
        const dsId = 'mock-ds-id';
        const newDb = {
          id: dbId,
          parent: params.parent,
          title: params.title,
          description: params.description,
          archived: false,
          data_sources: [{ id: dsId }],
        };
        this.databasesMap.set(dbId, newDb);
        const initialProps = params.initial_data_source?.properties || {};
        const simulatedProps: Record<string, any> = {};
        for (const [pName, pDef] of Object.entries(initialProps)) {
          const pType = Object.keys(pDef as any)[0] || 'rich_text';
          simulatedProps[pName] = {
            id: `prop_${pName}_id`,
            name: pName,
            type: pType,
            [pType]: (pDef as any)[pType],
          };
        }
        this.dataSourcesMap.set(dsId, { id: dsId, properties: simulatedProps });
        return newDb;
      },
    };

    public pages = {
      retrieve: async ({ page_id }: { page_id: string }) => {
        return { id: page_id, archived: false };
      },
    };

    public search = async () => ({ results: [] });
  }

  describe('8. SchemaApplyExecutor DDL Operations & Idempotency', () => {
    it('strictly blocks execution when allowRealMutations is false', async () => {
      const journal = new MigrationJournal(testDbPath);
      const planner = new SchemaPlanner();
      const backfillPlanner = new BackfillPlanner();
      const plan = {
        version: '1.0.0',
        planHash: 'hash_test_safeguard',
        inputFingerprint: {
          commitSha: 'sha',
          notionApiVersion: '2026-03-11',
          parentPageId: 'page',
          dataSourceIds: {},
          liveSnapshotSha256: 'snap',
        },
        schemaPlan: planner.generatePlan(),
        backfillPlan: backfillPlanner.generatePlan(),
      };

      const mockClient: any = {};
      const executor = new SchemaApplyExecutor({
        client: mockClient,
        journal,
        plan: plan as any,
        allowRealMutations: false, // Physical gate closed
      });

      await expect(
        executor.executeDdlPlan('run_blocked', 'commit_sha', 'main'),
      ).rejects.toThrow(/MUTAÇÕES REAIS BLOQUEADAS/);
    });

    it('executes ALTER_SELECT_OPTIONS preserving existing IDs without color, and is idempotent', async () => {
      const journal = new MigrationJournal(testDbPath);
      let updatePayload: any = null;
      let retrieveCount = 0;

      const mockClient: any = {
        dataSources: {
          retrieve: async () => {
            retrieveCount++;
            if (updatePayload) {
              // Return updated state on post-verification
              return {
                properties: {
                  Status: {
                    type: 'select',
                    select: {
                      options: [
                        { id: 'opt-prev-id', name: 'Prevista' },
                        { id: 'opt-pend-id', name: 'Pendente' },
                        { id: 'opt-paga-id', name: 'Paga' },
                        { id: 'opt-atra-id', name: 'Atrasada' },
                        { id: 'opt-disp-id', name: 'Dispensada' },
                        { id: 'opt-revi-id', name: 'Revisão Necessária' },
                        { id: 'opt-canc-id', name: 'Cancelada' },
                      ],
                    },
                  },
                },
              };
            }
            // Return initial state
            return {
              properties: {
                Status: {
                  type: 'select',
                  select: {
                    options: [
                      { id: 'opt-prev-id', name: 'Prevista', color: 'gray' },
                      { id: 'opt-pend-id', name: 'Pendente', color: 'yellow' },
                      { id: 'opt-paga-id', name: 'Paga', color: 'green' },
                      { id: 'opt-atra-id', name: 'Atrasada', color: 'red' },
                      { id: 'opt-disp-id', name: 'Dispensada', color: 'default' },
                    ],
                  },
                },
              },
            };
          },
          update: async (params: any) => {
            updatePayload = params;
            return { id: params.data_source_id };
          },
        },
      };

      const singleStepPlan: any = {
        version: '1.0.0',
        planHash: 'hash_test_alter_options',
        schemaPlan: {
          steps: [
            {
              stepNumber: 1,
              operation: 'ALTER_SELECT_OPTIONS',
              targetDataSource: { name: 'Obrigações Mensais', envKey: 'NOTION_DS_MONTHLY_OBLIGATIONS', id: 'ds-obrigacoes' },
              property: 'Status',
              risk: 'SAFE_MUTATION',
              precondition: 'Status select existe',
              rollback: 'PLANNED_MANUAL',
              sanitizedPayload: {},
            },
          ],
        },
        backfillPlan: { totalPipelines: 0, pipelines: [] },
      };

      const executor = new SchemaApplyExecutor({
        client: mockClient,
        journal,
        plan: singleStepPlan,
        allowRealMutations: true,
      });

      const result = await executor.executeDdlPlan('run_alter_01', 'commit_sha', 'main');
      expect(result.verifiedCount).toBe(1);
      expect(updatePayload).toBeDefined();

      const sentOptions = updatePayload.properties.Status.select.options;
      expect(sentOptions.length).toBe(7);
      expect(sentOptions[0]).toEqual({ id: 'opt-prev-id', name: 'Prevista' });
      expect(sentOptions[5]).toEqual({ name: 'Revisão Necessária' });
      expect(sentOptions[6]).toEqual({ name: 'Cancelada' });
      expect(sentOptions.every((o: any) => o.color === undefined)).toBe(true);

      // Verify idempotency on second run: should record NO_OP_VERIFIED without calling update
      updatePayload = null; // reset
      const rerunExecutor = new SchemaApplyExecutor({
        client: mockClient,
        journal,
        plan: singleStepPlan,
        allowRealMutations: true,
      });
      const rerunResult = await rerunExecutor.executeDdlPlan('run_alter_02', 'commit_sha', 'main');
      expect(rerunResult.noOpCount + rerunResult.verifiedCount).toBe(1);
    });

    it('creates CREATE_PROPERTY and handles idempotency when property already exists with compatible type', async () => {
      const journal = new MigrationJournal(testDbPath);
      let propertyCreated = false;

      const mockClient: any = {
        dataSources: {
          retrieve: async () => {
            if (propertyCreated) {
              return {
                properties: {
                  'Limite Operacional Usado': {
                    id: 'prop-limite-id',
                    type: 'number',
                    number: { format: 'real' },
                  },
                },
              };
            }
            return { properties: {} };
          },
          update: async () => {
            propertyCreated = true;
            return { id: 'ds-accounts' };
          },
        },
      };

      const plan: any = {
        version: '1.0.0',
        planHash: 'hash_test_create_prop',
        schemaPlan: {
          steps: [
            {
              stepNumber: 2,
              operation: 'CREATE_PROPERTY',
              targetDataSource: { name: 'Contas', envKey: 'NOTION_DS_ACCOUNTS', id: 'ds-accounts' },
              property: 'Limite Operacional Usado',
              risk: 'SAFE_MUTATION',
              precondition: 'none',
              rollback: 'PLANNED_MANUAL',
              sanitizedPayload: {
                'Limite Operacional Usado': { number: { format: 'real' } },
              },
            },
          ],
        },
        backfillPlan: { totalPipelines: 0, pipelines: [] },
      };

      const executor = new SchemaApplyExecutor({
        client: mockClient,
        journal,
        plan,
        allowRealMutations: true,
      });

      const result = await executor.executeDdlPlan('run_prop_01', 'commit_sha', 'main');
      expect(result.verifiedCount).toBe(1);
      expect(result.stepResults[0].status).toBe('VERIFIED');
      expect(result.stepResults[0].createdId).toBe('prop-limite-id');

      // Crash Resumption: second run with original journal re-verifies live
      const resumeResult = await executor.executeDdlPlan('run_prop_02', 'commit_sha', 'main');
      expect(resumeResult.stepResults[0].status).toBe('VERIFIED');

      // Idempotency: when step executes against live Notion where property already exists physically with compatible type -> NO_OP_VERIFIED
      const freshJournal = new MigrationJournal(path.join(tempDir, 'fresh-prop-journal.db'));
      const freshExecutor = new SchemaApplyExecutor({
        client: mockClient,
        journal: freshJournal,
        plan,
        allowRealMutations: true,
      });
      const rerunResult = await freshExecutor.executeDdlPlan('run_prop_03', 'commit_sha', 'main');
      expect(rerunResult.stepResults[0].status).toBe('NO_OP_VERIFIED');
    });

    it('CREATE_DATABASE reconciles existing database by migration marker to prevent duplication on retry', async () => {
      const journal = new MigrationJournal(testDbPath);
      const planHash = 'hash_test_reconciliation_marker';

      const mockClient: any = {
        databases: {
          retrieve: async (params: any) => {
            return {
              id: params.database_id,
              archived: false,
              parent: { page_id: 'parent-page-123' },
              title: [{ plain_text: 'Faturas / Ciclos de Cartão' }],
              description: [{ plain_text: `Base canônica de faturas. [MIGRATION_MARKER:${planHash}:CARD_BILLS_V1]` }],
            };
          },
        },
        search: async () => {
          return {
            results: [
              {
                object: 'data_source',
                id: 'ds-faturas-candidate',
                parent: { type: 'database_id', database_id: 'existing-faturas-db-id' },
              },
            ],
          };
        },
      };

      const plan: any = {
        version: '1.0.0',
        planHash,
        schemaPlan: {
          steps: [
            {
              stepNumber: 52,
              operation: 'CREATE_DATABASE',
              targetDataSource: { name: 'Faturas / Ciclos de Cartão', envKey: 'NOTION_DS_CARD_BILLS' },
              risk: 'SAFE_MUTATION',
              precondition: 'none',
              rollback: 'PLANNED_MANUAL',
              sanitizedPayload: {},
            },
          ],
        },
        backfillPlan: { totalPipelines: 0, pipelines: [] },
      };

      const executor = new SchemaApplyExecutor({
        client: mockClient,
        journal,
        plan,
        parentPageId: 'parent-page-123',
        allowRealMutations: true,
      });

      const result = await executor.executeDdlPlan('run_db_reconcile', 'commit_sha', 'main');
      expect(result.stepResults[0].status).toBe('NO_OP_VERIFIED');
      expect(result.stepResults[0].createdId).toBe('existing-faturas-db-id');
      expect(result.stepResults[0].detail).toContain('reconciliada com sucesso');
    });

    it('RESOLVE_DATA_SOURCE_ID extracts data_sources[0].id from /v1/databases/:id', async () => {
      const journal = new MigrationJournal(testDbPath);
      const planHash = 'hash_test_resolve_ds';

      // Pre-seed step 52 created database in journal
      journal.recordStepPending({
        planHash,
        stepNumber: 52,
        operation: 'CREATE_DATABASE',
        targetDataSource: 'Faturas / Ciclos de Cartão',
      });
      journal.recordStepVerified(planHash, 52, 'created-db-id-789');

      const mockCardBillsProps = createMockCardBillsProperties();

      const mockClient: any = {
        databases: {
          retrieve: async (params: any) => {
            expect(params.database_id).toBe('created-db-id-789');
            return {
              id: params.database_id,
              data_sources: [{ id: 'ds-resolved-card-bills-999' }],
            };
          },
        },
        dataSources: {
          retrieve: async (params: any) => {
            expect(params.data_source_id).toBe('ds-resolved-card-bills-999');
            return {
              id: 'ds-resolved-card-bills-999',
              properties: mockCardBillsProps,
            };
          },
        },
      };

      const plan: any = {
        version: '1.0.0',
        planHash,
        schemaPlan: {
          steps: [
            {
              stepNumber: 53,
              operation: 'RESOLVE_DATA_SOURCE_ID',
              targetDataSource: { name: 'Faturas / Ciclos de Cartão', envKey: 'NOTION_DS_CARD_BILLS' },
              risk: 'SAFE_MUTATION',
              precondition: 'GET /v1/databases/{database.id}',
              rollback: 'PLANNED_MANUAL',
              sanitizedPayload: {},
            },
          ],
        },
        backfillPlan: { totalPipelines: 0, pipelines: [] },
      };

      const executor = new SchemaApplyExecutor({
        client: mockClient,
        journal,
        plan,
        envVars: {
          ...REAL_DATA_SOURCE_IDS,
          NOTION_PARENT_PAGE_ID: '00000000-0000-0000-0000-000000000001',
        },
        allowRealMutations: true,
      });

      const result = await executor.executeDdlPlan('run_resolve_ds', 'commit_sha', 'main');
      expect(result.stepResults[0].status).toBe('VERIFIED');
      expect(result.stepResults[0].createdId).toBe('ds-resolved-card-bills-999');
      expect(journal.getResolvedDataSourceId(planHash)).toBe('ds-resolved-card-bills-999');
    });

    it('CREATE_DUAL_RELATION creates relation with resolved data source ID', async () => {
      const journal = new MigrationJournal(testDbPath);
      const planHash = 'hash_test_dual_rel';
      let updatePayload: any = null;

      // Pre-seed step 52 and 53
      journal.recordStepPending({
        planHash,
        stepNumber: 52,
        operation: 'CREATE_DATABASE',
        targetDataSource: 'Faturas / Ciclos de Cartão',
      });
      journal.recordStepVerified(planHash, 52, 'created-db-id-789');

      journal.recordStepPending({
        planHash,
        stepNumber: 53,
        operation: 'RESOLVE_DATA_SOURCE_ID',
        targetDataSource: 'Faturas / Ciclos de Cartão',
      });
      journal.recordStepVerified(planHash, 53, 'ds-resolved-card-bills-999');

      const mockClient: any = {
        dataSources: {
          retrieve: async (params: any) => {
            if (updatePayload) {
              if (params?.data_source_id === 'ds-resolved-card-bills-999') {
                return {
                  id: 'ds-resolved-card-bills-999',
                  properties: createMockCardBillsProperties({ includeDualRelation: true }),
                };
              }
              return {
                id: REAL_DATA_SOURCE_IDS.NOTION_DS_TRANSACTIONS,
                properties: {
                  'Fatura Vinculada': {
                    id: 'rel-fatura-id',
                    type: 'relation',
                    relation: {
                      data_source_id: 'ds-resolved-card-bills-999',
                      type: 'dual_property',
                      dual_property: { synced_property_name: 'Lançamentos do Ciclo' },
                    },
                  },
                },
              };
            }
            if (params?.data_source_id === 'ds-resolved-card-bills-999') {
              return {
                id: 'ds-resolved-card-bills-999',
                properties: createMockCardBillsProperties(),
              };
            }
            return {
              id: REAL_DATA_SOURCE_IDS.NOTION_DS_TRANSACTIONS,
              properties: {},
            };
          },
          update: async (params: any) => {
            updatePayload = params;
            return { id: params.data_source_id };
          },
        },
      };

      const plan: any = {
        version: '1.0.0',
        planHash,
        schemaPlan: {
          steps: [
            {
              stepNumber: 54,
              operation: 'CREATE_DUAL_RELATION',
              targetDataSource: { name: 'Transações', envKey: 'NOTION_DS_TRANSACTIONS', id: REAL_DATA_SOURCE_IDS.NOTION_DS_TRANSACTIONS },
              property: 'Fatura Vinculada',
              risk: 'SAFE_MUTATION',
              precondition: 'none',
              rollback: 'PLANNED_MANUAL',
              sanitizedPayload: {},
            },
          ],
        },
        backfillPlan: { totalPipelines: 0, pipelines: [] },
      };

      const executor = new SchemaApplyExecutor({
        client: mockClient,
        journal,
        plan,
        envVars: {
          ...REAL_DATA_SOURCE_IDS,
          NOTION_PARENT_PAGE_ID: '00000000-0000-0000-0000-000000000001',
        },
        allowRealMutations: true,
      });

      const result = await executor.executeDdlPlan('run_dual_rel', 'commit_sha', 'main');
      expect(result.stepResults[0].status).toBe('VERIFIED');
      expect(result.stepResults[0].createdId).toBe('rel-fatura-id');
      expect(updatePayload.properties['Fatura Vinculada'].relation.data_source_id).toBe('ds-resolved-card-bills-999');
      expect(updatePayload.properties['Fatura Vinculada'].relation.dual_property.synced_property_name).toBe('Lançamentos do Ciclo');
    });
  });

  describe('9. Fail-Closed Git Security & Exact Missing Set Conformance', () => {
    it('falha ao inspecionar git resulta em GIT_STATE_UNVERIFIED e bloqueia dryRunValid e applyReady', async () => {
      const runner = new TestableMigrationRunner(
        {
          mode: 'dry-run',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
        },
        {
          simulateGitFailure: true,
        },
      );

      const report = await runner.runDryRun();
      expect(report.readiness.worktreeStatus).toBe('GIT_STATE_UNVERIFIED');
      expect(report.readiness.dryRunValid).toBe(false);
      expect(report.readiness.applyReady).toBe(false);
      expect(report.readiness.reasons.some((r) => r.includes('GIT_STATE_UNVERIFIED'))).toBe(true);
    });

    it('divergência com upstream tracking remoto gera GIT_STATE_UNVERIFIED', async () => {
      const runner = new TestableMigrationRunner(
        {
          mode: 'dry-run',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
        },
        {
          simulateRemoteTrackingMismatch: true,
        },
      );

      const report = await runner.runDryRun();
      expect(report.readiness.worktreeStatus).toBe('GIT_STATE_UNVERIFIED');
      expect(report.readiness.dryRunValid).toBe(false);
      expect(report.readiness.applyReady).toBe(false);
      expect(report.readiness.reasons.some((r) => r.includes('GIT_STATE_UNVERIFIED'))).toBe(true);
    });

    it('incompatibilidade com expectedCommitSha gera GIT_STATE_UNVERIFIED', async () => {
      const runner = new TestableMigrationRunner(
        {
          mode: 'dry-run',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          expectedCommitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          gitCommitShaOverride: '0123456789abcdef0123456789abcdef01234567',
        },
      );

      // We test resolveGitState directly when options.expectedCommitSha is set
      const runnerNoDouble = new MigrationRunner({
        expectedCommitSha: '0000000000000000000000000000000000000000',
      });
      const gitState = runnerNoDouble.resolveGitState();
      expect(gitState.status).toBe('GIT_STATE_UNVERIFIED');
      expect(gitState.unverifiedReason).toContain('não coincide com o commit esperado');
    });

    it('propriedade inesperadamente ausente populates unexpectedMissingProperties e reprova schema conformance', async () => {
      // Create snapshot where NOTION_DS_ACCOUNTS has an extra missing property
      const snapshot: Record<string, Record<string, any>> = JSON.parse(
        JSON.stringify(LIVE_NOTION_FIXTURES),
      );
      // Remove 'Instituição' which is an existing baseline property
      delete snapshot.NOTION_DS_ACCOUNTS['Instituição'];

      const runner = new TestableMigrationRunner(
        {
          mode: 'dry-run',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_PARENT_PAGE_ID: '00000000-0000-0000-0000-000000000001',
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          liveSnapshotOverride: snapshot,
        },
      );

      const report = await runner.runDryRun();
      const sc = report.readiness.schemaConformance!;
      expect(sc.isConformant).toBe(false);
      expect(sc.unexpectedMissingProperties).toContain('NOTION_DS_ACCOUNTS.Instituição');
      expect(report.readiness.applyReady).toBe(false);
      expect(report.readiness.reasons.some((r) => r.includes('UNEXPECTED_MISSING'))).toBe(true);
    });

    it('propriedade esperada como ausente que já está presente populates expectedMissingButPresent e reprova', async () => {
      // Create snapshot where NOTION_DS_ACCOUNTS already has 'Limite Operacional Usado'
      const snapshot: Record<string, Record<string, any>> = JSON.parse(
        JSON.stringify(LIVE_NOTION_FIXTURES),
      );
      snapshot.NOTION_DS_ACCOUNTS['Limite Operacional Usado'] = {
        name: 'Limite Operacional Usado',
        type: 'number',
      };

      const runner = new TestableMigrationRunner(
        {
          mode: 'dry-run',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_PARENT_PAGE_ID: '00000000-0000-0000-0000-000000000001',
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          liveSnapshotOverride: snapshot,
        },
      );

      const report = await runner.runDryRun();
      const sc = report.readiness.schemaConformance!;
      expect(sc.isConformant).toBe(false);
      expect(sc.expectedMissingButPresent).toContain('NOTION_DS_ACCOUNTS.Limite Operacional Usado');
      expect(report.readiness.applyReady).toBe(false);
      expect(report.readiness.reasons.some((r) => r.includes('EXPECTED_MISSING_BUT_PRESENT'))).toBe(true);
    });
  });

  describe('10. Crash Recovery, Resume Apply, and Unified Structural Verification Hardening', () => {
    it('StepStructuralVerifier verifies ALTER_SELECT_OPTIONS correctly', () => {
      // Missing baseline options
      const propWithMissingBaseline = {
        type: 'select',
        select: { options: [{ name: 'Prevista' }] },
      };
      const baselineRes = StepStructuralVerifier.verifyAlterSelectOptions(propWithMissingBaseline, {
        requireBaselineOptions: true,
      });
      expect(baselineRes.valid).toBe(false);
      expect(baselineRes.reason).toBe('BASELINE_OPTION_MISSING');

      // Complete 7 options
      const propComplete = {
        type: 'select',
        select: {
          options: [
            { name: 'Prevista' },
            { name: 'Pendente' },
            { name: 'Paga' },
            { name: 'Atrasada' },
            { name: 'Dispensada' },
            { name: 'Revisão Necessária' },
            { name: 'Cancelada' },
          ],
        },
      };
      const completeRes = StepStructuralVerifier.verifyAlterSelectOptions(propComplete, {
        requireAllTargetOptions: true,
      });
      expect(completeRes.valid).toBe(true);
    });

    it('StepStructuralVerifier flags SCHEMA_INCOMPATIBLE on divergent property format or type', () => {
      // Divergent format for number
      const existingNumberProp = {
        type: 'number',
        number: { format: 'number' },
      };
      const expectedPayload = {
        'Valor Total': {
          number: { format: 'real' },
        },
      };
      const formatCheck = StepStructuralVerifier.verifyCreateProperty(
        existingNumberProp,
        expectedPayload,
        'Valor Total',
      );
      expect(formatCheck.isCompatible).toBe(false);
      expect(formatCheck.reason).toBe('FORMAT_MISMATCH');

      // Divergent type
      const existingTextProp = {
        type: 'rich_text',
      };
      const typeCheck = StepStructuralVerifier.verifyCreateProperty(
        existingTextProp,
        expectedPayload,
        'Valor Total',
      );
      expect(typeCheck.isCompatible).toBe(false);
      expect(typeCheck.reason).toBe('TYPE_MISMATCH');
    });

    it('StepStructuralVerifier rejects database without migration marker or mismatched parent page', () => {
      const dbWithoutMarker = {
        id: 'db-123',
        archived: false,
        parent: { page_id: 'parent-page-123' },
        title: [{ plain_text: 'Faturas / Ciclos de Cartão' }],
        description: [{ plain_text: 'Database sem marker' }],
      };
      const markerCheck = StepStructuralVerifier.verifyDatabase(
        dbWithoutMarker,
        'parent-page-123',
        'expected_hash',
      );
      expect(markerCheck.valid).toBe(false);
      expect(markerCheck.reason).toBe('MIGRATION_MARKER_MISSING');

      const dbWrongParent = {
        id: 'db-123',
        archived: false,
        parent: { page_id: 'wrong-parent-page' },
        title: [{ plain_text: 'Faturas / Ciclos de Cartão' }],
        description: [{ plain_text: 'MIGRATION_MARKER:expected_hash:CARD_BILLS_V1' }],
      };
      const parentCheck = StepStructuralVerifier.verifyDatabase(
        dbWrongParent,
        'parent-page-123',
        'expected_hash',
      );
      expect(parentCheck.valid).toBe(false);
      expect(parentCheck.reason).toBe('PARENT_PAGE_MISMATCH');
    });

    it('StepStructuralVerifier rejects ambiguous data sources in verifyResolveDataSource', () => {
      const dbMultipleDs = {
        id: 'db-multi',
        data_sources: [{ id: 'ds-1' }, { id: 'ds-2' }],
      };
      const multiCheck = StepStructuralVerifier.verifyResolveDataSource(dbMultipleDs);
      expect(multiCheck.valid).toBe(false);
      expect(multiCheck.reason).toBe('AMBIGUOUS_DATA_SOURCE');

      const dbSingleDs = {
        id: 'db-single',
        data_sources: [{ id: 'ds-sole-123' }],
      };
      const singleCheck = StepStructuralVerifier.verifyResolveDataSource(dbSingleDs);
      expect(singleCheck.valid).toBe(true);
      expect(singleCheck.dataSourceId).toBe('ds-sole-123');
    });

    it('AMBIGUOUS_OR_FOREIGN_DATABASE: base com mesmo título mas sem marker sob a página-mãe bloqueia criação', async () => {
      const journal = new MigrationJournal(testDbPath);
      const planHash = 'hash_foreign_db_test';

      const mockClient: any = {
        databases: {
          retrieve: async (params: any) => {
            return {
              id: params.database_id,
              archived: false,
              parent: { page_id: 'parent-page-test-123' },
              title: [{ plain_text: 'Faturas / Ciclos de Cartão' }],
              description: [{ plain_text: 'Base legada estrangeira sem marker' }],
            };
          },
        },
        search: async () => {
          return {
            results: [
              {
                object: 'data_source',
                id: 'ds-foreign',
                parent: { type: 'database_id', database_id: 'foreign-db-id' },
              },
            ],
          };
        },
      };

      const plan: any = {
        version: '1.0.0',
        planHash,
        schemaPlan: {
          steps: [
            {
              stepNumber: 52,
              operation: 'CREATE_DATABASE',
              targetDataSource: { name: 'Faturas / Ciclos de Cartão', envKey: 'NOTION_DS_CARD_BILLS' },
              risk: 'SAFE_MUTATION',
              precondition: 'none',
              rollback: 'PLANNED_MANUAL',
              sanitizedPayload: {},
            },
          ],
        },
        backfillPlan: { totalPipelines: 0, pipelines: [] },
      };

      const executor = new SchemaApplyExecutor({
        client: mockClient,
        journal,
        plan,
        parentPageId: 'parent-page-test-123',
        allowRealMutations: true,
      });

      await expect(
        executor.executeDdlPlan('run_foreign_test', 'commit_sha', 'main'),
      ).rejects.toThrow('AMBIGUOUS_OR_FOREIGN_DATABASE');
    });

    it('falha no search aborta imediatamente e nunca cria base duplicada', async () => {
      const journal = new MigrationJournal(testDbPath);
      const planHash = 'hash_search_failure_test';
      let createCalled = false;

      const mockClient: any = {
        databases: {
          create: async () => {
            createCalled = true;
            return { id: 'should-not-be-created' };
          },
        },
        search: async () => {
          throw new Error('RATE_LIMITED_OR_NETWORK_ERROR');
        },
      };

      const plan: any = {
        version: '1.0.0',
        planHash,
        schemaPlan: {
          steps: [
            {
              stepNumber: 52,
              operation: 'CREATE_DATABASE',
              targetDataSource: { name: 'Faturas / Ciclos de Cartão', envKey: 'NOTION_DS_CARD_BILLS' },
              risk: 'SAFE_MUTATION',
              precondition: 'none',
              rollback: 'PLANNED_MANUAL',
              sanitizedPayload: {},
            },
          ],
        },
        backfillPlan: { totalPipelines: 0, pipelines: [] },
      };

      const executor = new SchemaApplyExecutor({
        client: mockClient,
        journal,
        plan,
        parentPageId: 'parent-page-test-123',
        allowRealMutations: true,
      });

      await expect(
        executor.executeDdlPlan('run_search_fail', 'commit_sha', 'main'),
      ).rejects.toThrow('RATE_LIMITED_OR_NETWORK_ERROR');
      expect(createCalled).toBe(false);
    });

    it('janela crítica: databases.create teve sucesso mas processo foi encerrado antes de salvar no journal, retry reconcilia via marker', async () => {
      const journal = new MigrationJournal(testDbPath);
      const planHash = 'hash_critical_window_reconciliation';
      let createCallCount = 0;

      const mockClient: any = {
        databases: {
          create: async () => {
            createCallCount++;
            return { id: 'created-in-first-run-id' };
          },
          retrieve: async (params: any) => {
            return {
              id: params.database_id,
              archived: false,
              parent: { page_id: 'parent-page-test-123' },
              title: [{ plain_text: 'Faturas / Ciclos de Cartão' }],
              description: [{ plain_text: `Base canônica. [MIGRATION_MARKER:${planHash}:CARD_BILLS_V1]` }],
            };
          },
        },
        search: async () => {
          return {
            results: [
              {
                object: 'data_source',
                id: 'ds-reconciled',
                parent: { type: 'database_id', database_id: 'created-in-first-run-id' },
              },
            ],
          };
        },
      };

      const plan: any = {
        version: '1.0.0',
        planHash,
        schemaPlan: {
          steps: [
            {
              stepNumber: 52,
              operation: 'CREATE_DATABASE',
              targetDataSource: { name: 'Faturas / Ciclos de Cartão', envKey: 'NOTION_DS_CARD_BILLS' },
              risk: 'SAFE_MUTATION',
              precondition: 'none',
              rollback: 'PLANNED_MANUAL',
              sanitizedPayload: {},
            },
          ],
        },
        backfillPlan: { totalPipelines: 0, pipelines: [] },
      };

      // Journal has NO record yet (simulating crash right after databases.create)
      expect(journal.getStepStatus(planHash, 52)).toBeUndefined();

      const executor = new SchemaApplyExecutor({
        client: mockClient,
        journal,
        plan,
        parentPageId: 'parent-page-test-123',
        allowRealMutations: true,
      });

      const result = await executor.executeDdlPlan('retry_after_crash', 'commit_sha', 'main');
      expect(createCallCount).toBe(0); // databases.create was NEVER called on retry
      expect(result.stepResults[0].status).toBe('NO_OP_VERIFIED');
      expect(result.stepResults[0].createdId).toBe('created-in-first-run-id');
      expect(journal.getStepStatus(planHash, 52)?.status).toBe('NO_OP_VERIFIED');
    });

    it('StepStructuralVerifier: number sem format esperado ou relation sem target/type gera falha', () => {
      // 1. Number expecting format 'real', but format is missing
      const numberWithoutFormat = {
        type: 'number',
        number: {},
      };
      const expectedNumberPayload = {
        'Valor Previsto': {
          number: { format: 'real' },
        },
      };
      const resNum = StepStructuralVerifier.verifyCreateProperty(
        numberWithoutFormat,
        expectedNumberPayload,
        'Valor Previsto',
      );
      expect(resNum.isCompatible).toBe(false);
      expect(resNum.reason).toBe('FORMAT_MISMATCH');

      // 2. Relation without data_source_id
      const relWithoutTarget = {
        type: 'relation',
        relation: { type: 'dual_property' },
      };
      const expectedRelPayload = {
        'Conta Bancária': {
          relation: { data_source_id: 'ds_accounts_target', type: 'single_property' },
        },
      };
      const resRel = StepStructuralVerifier.verifyCreateProperty(
        relWithoutTarget,
        expectedRelPayload,
        'Conta Bancária',
      );
      expect(resRel.isCompatible).toBe(false);
      expect(resRel.reason).toBe('RELATION_TARGET_MISMATCH');

      // 3. Relation without type
      const relWithoutType = {
        type: 'relation',
        relation: { data_source_id: 'ds_accounts_target' },
      };
      const resRelType = StepStructuralVerifier.verifyCreateProperty(
        relWithoutType,
        expectedRelPayload,
        'Conta Bancária',
      );
      expect(resRelType.isCompatible).toBe(false);
      expect(resRelType.reason).toBe('RELATION_TYPE_MISMATCH');
    });

    it('StepStructuralVerifier: select/multi_select novos exigem igualdade exata de opções, salvo allowExtraOptions=true', () => {
      const expectedSelectPayload = {
        'Tipo de Conta': {
          select: {
            options: [{ name: 'Corrente' }, { name: 'Poupança' }],
          },
        },
      };
      const existingSelectWithExtra = {
        type: 'select',
        select: {
          options: [{ name: 'Corrente' }, { name: 'Poupança' }, { name: 'Investimento Extra' }],
        },
      };

      // By default (!allowExtraOptions): extra option causes mismatch
      const strictCheck = StepStructuralVerifier.verifyCreateProperty(
        existingSelectWithExtra,
        expectedSelectPayload,
        'Tipo de Conta',
        { allowExtraOptions: false },
      );
      expect(strictCheck.isCompatible).toBe(false);
      expect(strictCheck.reason).toBe('SELECT_OPTIONS_DIVERGENT');
      expect(strictCheck.detail).toContain('Investimento Extra');

      // With allowExtraOptions: true
      const permissiveCheck = StepStructuralVerifier.verifyCreateProperty(
        existingSelectWithExtra,
        expectedSelectPayload,
        'Tipo de Conta',
        { allowExtraOptions: true },
      );
      expect(permissiveCheck.isCompatible).toBe(true);
      expect(permissiveCheck.valid).toBe(true);
    });

    it('StepStructuralVerifier: Obrigações.Status pós-Step 1 exige conjunto exato das 7 opções homologadas', () => {
      // 8 options (has unexpected 'Outro Status')
      const propWith8Options = {
        type: 'select',
        select: {
          options: [
            { name: 'Prevista' },
            { name: 'Pendente' },
            { name: 'Paga' },
            { name: 'Atrasada' },
            { name: 'Dispensada' },
            { name: 'Revisão Necessária' },
            { name: 'Cancelada' },
            { name: 'Outro Status' },
          ],
        },
      };
      const check8 = StepStructuralVerifier.verifyAlterSelectOptions(propWith8Options, {
        requireAllTargetOptions: true,
      });
      expect(check8.valid).toBe(false);
      expect(check8.reason).toBe('UNEXPECTED_STATUS_OPTION');
      expect(check8.detail).toContain('Outro Status');
    });

    it('Recovery de Faturas: rejeita CARD_BILLS_V1 de outro plano com FOREIGN_MIGRATION_PLAN_DATABASE e exige campos exatos', () => {
      const planHash = '1111111111111111111111111111111111111111111111111111111111111111';
      const foreignHash = '2222222222222222222222222222222222222222222222222222222222222222';

      // Foreign plan hash database
      const foreignDb = {
        id: 'db-foreign-plan',
        archived: false,
        parent: { page_id: 'parent-123' },
        title: [{ plain_text: 'Faturas / Ciclos de Cartão' }],
        description: [{ plain_text: `Base oficial. [MIGRATION_MARKER:${foreignHash}:CARD_BILLS_V1]` }],
      };
      const foreignCheck = StepStructuralVerifier.verifyDatabase(foreignDb, 'parent-123', planHash);
      expect(foreignCheck.valid).toBe(false);
      expect(foreignCheck.reason).toBe('FOREIGN_MIGRATION_PLAN_DATABASE');

      // Mismatched normalized title
      const wrongTitleDb = {
        id: 'db-wrong-title',
        archived: false,
        parent: { page_id: 'parent-123' },
        title: [{ plain_text: 'Faturas de Cartão de Crédito' }],
        description: [{ plain_text: `Base oficial. [MIGRATION_MARKER:${planHash}:CARD_BILLS_V1]` }],
      };
      const titleCheck = StepStructuralVerifier.verifyDatabase(wrongTitleDb, 'parent-123', planHash);
      expect(titleCheck.valid).toBe(false);
      expect(titleCheck.reason).toBe('TITLE_MISMATCH');

      // Valid exact database
      const validDb = {
        id: 'db-valid',
        archived: false,
        in_trash: false,
        parent: { page_id: 'parent-123' },
        title: [{ plain_text: 'Faturas / Ciclos de Cartão' }],
        description: [{ plain_text: `Base oficial. [MIGRATION_MARKER:${planHash}:CARD_BILLS_V1]` }],
      };
      const validCheck = StepStructuralVerifier.verifyDatabase(validDb, 'parent-123', planHash);
      expect(validCheck.valid).toBe(true);
    });

    it('dual relation: erro de leitura em qualquer dos Data Sources reprova verificação', () => {
      const validTxDs = {
        properties: {
          'Fatura Vinculada': {
            type: 'relation',
            relation: {
              data_source_id: 'ds_bills',
              type: 'dual_property',
              dual_property: { synced_property_name: 'Lançamentos do Ciclo' },
            },
          },
        },
      };

      // billsDs is missing/undefined
      const missingBillsCheck = StepStructuralVerifier.verifyDualRelation(validTxDs, undefined, 'ds_bills', 'ds_tx');
      expect(missingBillsCheck.valid).toBe(false);
      expect(missingBillsCheck.reason).toBe('BILLS_DS_MISSING');

      // txDs is missing/undefined
      const missingTxCheck = StepStructuralVerifier.verifyDualRelation(undefined, {}, 'ds_bills', 'ds_tx');
      expect(missingTxCheck.valid).toBe(false);
      expect(missingTxCheck.reason).toBe('TRANSACTIONS_DS_MISSING');
    });

    it('RESUME_APPLY: divergência de fingerprint (commit, parentPageId, dataSourceIds, planHash) aborta com RESUME_FINGERPRINT_MISMATCH', async () => {
      const journal = new MigrationJournal(testDbPath);
      const snapshot: Record<string, Record<string, any>> = JSON.parse(
        JSON.stringify(LIVE_NOTION_FIXTURES),
      );

      const runner = new TestableMigrationRunner(
        {
          mode: 'dry-run',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_PARENT_PAGE_ID: '00000000-0000-0000-0000-000000000001',
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          gitCommitShaOverride: 'commit_sha_original_123',
          liveSnapshotOverride: snapshot,
        },
      );

      const dryRunReport = await runner.runDryRun();
      const planHash = dryRunReport.plan.planHash;
      journal.savePlan(dryRunReport.plan, 'feat/phase-1-schema-apply-executor');

      const mockClient: any = {
        dataSources: { retrieve: async () => ({ properties: {} }) },
      };

      // 1. Commit SHA mismatch
      const commitMismatchRunner = new TestableMigrationRunner(
        {
          mode: 'apply',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          notionApiKey: 'ntn_mock_api_key',
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_PARENT_PAGE_ID: '00000000-0000-0000-0000-000000000001',
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          gitCommitShaOverride: 'commit_sha_divergente_999',
          liveSnapshotOverride: snapshot,
        },
      );
      commitMismatchRunner.setClient(mockClient);
      await expect(commitMismatchRunner.execute(planHash)).rejects.toThrow('RESUME_FINGERPRINT_MISMATCH');

      // 2. Parent Page ID mismatch
      const parentMismatchRunner = new TestableMigrationRunner(
        {
          mode: 'apply',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          notionApiKey: 'ntn_mock_api_key',
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_PARENT_PAGE_ID: 'divergent-parent-page-id-999',
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          gitCommitShaOverride: 'commit_sha_original_123',
          liveSnapshotOverride: snapshot,
        },
      );
      parentMismatchRunner.setClient(mockClient);
      await expect(parentMismatchRunner.execute(planHash)).rejects.toThrow('RESUME_FINGERPRINT_MISMATCH');

      // 3. Data Source ID mismatch
      const dsMismatchRunner = new TestableMigrationRunner(
        {
          mode: 'apply',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          notionApiKey: 'ntn_mock_api_key',
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_DS_ACCOUNTS: '00000000-0000-0000-0000-000000009999',
            NOTION_PARENT_PAGE_ID: '00000000-0000-0000-0000-000000000001',
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          gitCommitShaOverride: 'commit_sha_original_123',
          liveSnapshotOverride: snapshot,
        },
      );
      dsMismatchRunner.setClient(mockClient);
      await expect(dsMismatchRunner.execute(planHash)).rejects.toThrow('RESUME_FINGERPRINT_MISMATCH');
    });

    it('CRASH RECOVERY OBRIGATÓRIO NA JANELA CRÍTICA: PATCH de CREATE_PROPERTY retorna sucesso, simula crash antes de recordStepApplied, novo runner reconhece frontier step, recupera com NO_OP_VERIFIED e continua N+1 sem novo PATCH', async () => {
      const fakeNotion = new StatefulNotionFake(LIVE_NOTION_FIXTURES);
      const journal = new MigrationJournal(testDbPath);

      // Compute initial plan
      const runner1 = new TestableMigrationRunner(
        {
          mode: 'dry-run',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_PARENT_PAGE_ID: '00000000-0000-0000-0000-000000000001',
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          gitCommitShaOverride: 'commit_sha_recovery_test',
        },
      );
      runner1.setClient(fakeNotion);

      const dryRunReport = await runner1.runDryRun();
      const plan = dryRunReport.plan;
      const planHash = plan.planHash;
      journal.savePlan(plan, 'feat/phase-1-schema-apply-executor');

      // 2. Execute Step 1 via SchemaApplyExecutor against fake Notion
      const executor1 = new SchemaApplyExecutor({
        client: fakeNotion as any,
        journal,
        plan,
        parentPageId: '00000000-0000-0000-0000-000000000001',
        allowRealMutations: true,
      });

      // Execute Step 1
      const step1Result = await (executor1 as any).executeAlterSelectOptions(plan.schemaPlan.steps[0], Date.now());
      expect(step1Result.status).toBe('VERIFIED');
      expect(fakeNotion.writeCallsCount).toBe(1);
      expect(journal.getStepStatus(planHash, 1)?.status).toBe('VERIFIED');

      // 3. Step 2 (Contas: 'Limite Operacional Usado'):
      // Mutation succeeds on fake Notion:
      await fakeNotion.dataSources.update({
        data_source_id: REAL_DATA_SOURCE_IDS.NOTION_DS_ACCOUNTS,
        properties: plan.schemaPlan.steps[1].sanitizedPayload,
      });
      expect(fakeNotion.writeCallsCount).toBe(2);
      expect(fakeNotion.writeCallsByProperty['Limite Operacional Usado']).toBe(1);

      // SIMULATE CRASH: Process was terminated BEFORE recordStepApplied was executed!
      // In journal: Step 2 was marked PENDING when step started, but NEVER APPLIED or VERIFIED.
      journal.recordStepPending({
        planHash,
        stepNumber: 2,
        operation: 'CREATE_PROPERTY',
        targetDataSource: 'Contas',
        propertyName: 'Limite Operacional Usado',
      });
      expect(journal.getStepStatus(planHash, 2)?.status).toBe('PENDING');

      // 4. Restart process: instantiate BRAND NEW RUNNER with same planHash
      const resumeRunner = new TestableMigrationRunner(
        {
          mode: 'apply',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          notionApiKey: 'ntn_mock_api_key',
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_PARENT_PAGE_ID: '00000000-0000-0000-0000-000000000001',
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          gitCommitShaOverride: 'commit_sha_recovery_test',
        },
      );
      resumeRunner.setClient(fakeNotion);

      // Execute resume. The runner must:
      // - identify Step 2 as the frontier step
      // - validate its exact postcondition
      // - record RECOVERED_AFTER_UNCERTAIN_WRITE / NO_OP_VERIFIED
      // - verify safeguarding gate
      await expect(resumeRunner.execute(planHash)).rejects.toThrow('MUTAÇÕES REAIS BLOQUEADAS');

      // Verify Step 2 is now NO_OP_VERIFIED in journal with recovery metadata
      const step2JournalStatus = journal.getStepStatus(planHash, 2);
      expect(step2JournalStatus?.status).toBe('NO_OP_VERIFIED');
      const step2Metadata = JSON.parse(step2JournalStatus?.metadataJson || '{}');
      expect(step2Metadata.recoveryReason).toBe('RECOVERED_AFTER_UNCERTAIN_WRITE');

      // 5. Verify N+1 continuation WITHOUT duplicate PATCH on Step 2:
      const executor2 = new SchemaApplyExecutor({
        client: fakeNotion as any,
        journal,
        plan,
        parentPageId: '00000000-0000-0000-0000-000000000001',
        allowRealMutations: true,
      });

      const writeCountBeforeContinuation = fakeNotion.writeCallsCount; // 2
      // Step 2 is verified via verifyStepAlreadyCompleted -> ZERO writes!
      const isStep2Valid = await (executor2 as any).verifyStepAlreadyCompleted(plan.schemaPlan.steps[1]);
      expect(isStep2Valid).toBe(true);

      // Execute Step 3 ('Limite Usado da Fonte (Bruto)')
      const step3Result = await (executor2 as any).executeCreateProperty(plan.schemaPlan.steps[2], Date.now());
      expect(step3Result.status).toBe('VERIFIED');
      expect(fakeNotion.writeCallsCount).toBe(writeCountBeforeContinuation + 1); // 3

      // CONFIRM CRUCIAL INVARIANT: Step 2 was NEVER patched a second time!
      expect(fakeNotion.writeCallsByProperty['Limite Operacional Usado']).toBe(1);
    });

    it('Frontier rule: alteração correspondente a passo posterior ao frontier permanece EXTERNAL_DRIFT_DETECTED', async () => {
      const journal = new MigrationJournal(testDbPath);
      const snapshot: Record<string, Record<string, any>> = JSON.parse(
        JSON.stringify(LIVE_NOTION_FIXTURES),
      );

      const runner = new TestableMigrationRunner(
        {
          mode: 'dry-run',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_PARENT_PAGE_ID: '00000000-0000-0000-0000-000000000001',
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          gitCommitShaOverride: 'commit_sha_posterior_drift',
          liveSnapshotOverride: snapshot,
        },
      );

      const dryRunReport = await runner.runDryRun();
      const planHash = dryRunReport.plan.planHash;
      journal.savePlan(dryRunReport.plan, 'feat/phase-1-schema-apply-executor');

      // Journal has Step 1 as completed. So frontier is Step 2.
      journal.recordStepPending({
        planHash,
        stepNumber: 1,
        operation: 'ALTER_SELECT_OPTIONS',
        targetDataSource: 'Obrigações Mensais',
      });
      journal.recordStepVerified(planHash, 1);

      // Live snapshot has Step 1 applied
      snapshot.NOTION_DS_MONTHLY_OBLIGATIONS['Status'] = {
        name: 'Status',
        type: 'select',
        selectOptions: [
          'Prevista',
          'Pendente',
          'Paga',
          'Atrasada',
          'Dispensada',
          'Revisão Necessária',
          'Cancelada',
        ],
      };

      // Live snapshot ALSO has Step 4 ('Contas.Dia de Fechamento') applied!
      // Step 4 > frontier (Step 2) -> this MUST be rejected as EXTERNAL_DRIFT_DETECTED
      snapshot.NOTION_DS_ACCOUNTS['Dia de Fechamento'] = {
        name: 'Dia de Fechamento',
        type: 'number',
        number: { format: 'number' },
      };

      const driftRunner = new TestableMigrationRunner(
        {
          mode: 'apply',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          notionApiKey: 'ntn_mock_api_key',
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_PARENT_PAGE_ID: '00000000-0000-0000-0000-000000000001',
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          gitCommitShaOverride: 'commit_sha_posterior_drift',
          liveSnapshotOverride: snapshot,
        },
      );
      driftRunner.setClient({
        dataSources: { retrieve: async () => ({ properties: {} }) },
      });

      await expect(driftRunner.execute(planHash)).rejects.toThrow('EXTERNAL_DRIFT_DETECTED');
    });
  });

  describe('11. Step 53 Hardening, Database Recovery & Operational Apply Gates', () => {
    const parentPageId = '00000000-0000-0000-0000-000000000001';
    const envVars = {
      ...REAL_DATA_SOURCE_IDS,
      NOTION_PARENT_PAGE_ID: parentPageId,
    };
    const planner = new SchemaPlanner({ envVars });
    const fullPlan = planner.generatePlan();
    const createDbStep = fullPlan.steps.find((s) => s.operation === 'CREATE_DATABASE');
    const initialPropsPayload = createDbStep?.sanitizedPayload?.initial_data_source?.properties || {};

    it('Step 53: base com parent/título/marker corretos mas propriedade inicial faltante DEVE FALHAR', async () => {
      const journal = new MigrationJournal(testDbPath);
      const planHash = 'hash_test_step53_missing_prop';

      journal.recordStepPending({ planHash, stepNumber: 52, operation: 'CREATE_DATABASE', targetDataSource: 'Faturas / Ciclos de Cartão' });
      journal.recordStepVerified(planHash, 52, 'db-id-123');

      // Database is valid with correct marker, parent and title
      // BUT data_source is missing 'Valor Pago'
      const invalidProps = createMockCardBillsProperties({ omitProps: ['Valor Pago'] });

      const mockClient: any = {
        databases: {
          retrieve: async () => ({
            id: 'db-id-123',
            data_sources: [{ id: 'ds-faturas-123' }],
          }),
        },
        dataSources: {
          retrieve: async () => ({
            id: 'ds-faturas-123',
            properties: invalidProps,
          }),
        },
      };

      // Direct verifier check
      const verif = StepStructuralVerifier.verifyCardBillsInitialProperties(
        { properties: invalidProps },
        initialPropsPayload,
      );
      expect(verif.valid).toBe(false);
      expect(verif.reason).toBe('INITIAL_PROPERTY_MISSING');
      expect(verif.detail).toContain('Valor Pago');

      // Executor execution check
      const executor = new SchemaApplyExecutor({
        client: mockClient,
        journal,
        plan: {
          version: '1.0.0',
          planHash,
          schemaPlan: {
            steps: [
              {
                stepNumber: 53,
                operation: 'RESOLVE_DATA_SOURCE_ID',
                targetDataSource: { name: 'Faturas / Ciclos de Cartão', envKey: 'NOTION_DS_CARD_BILLS' },
                sanitizedPayload: {},
              },
            ],
          },
        } as any,
        envVars,
        allowRealMutations: true,
      });

      await expect(executor.executeDdlPlan('run_step53_fail_missing', 'sha', 'main')).rejects.toThrow(
        /INITIAL_PROPERTY_MISSING|Valor Pago/,
      );
      expect(journal.getStepStatus(planHash, 53)?.status).toBe('FAILED');
    });

    it('Step 53: number format incorreto DEVE FALHAR', async () => {
      const journal = new MigrationJournal(testDbPath);
      const planHash = 'hash_test_step53_wrong_format';

      journal.recordStepPending({ planHash, stepNumber: 52, operation: 'CREATE_DATABASE', targetDataSource: 'Faturas / Ciclos de Cartão' });
      journal.recordStepVerified(planHash, 52, 'db-id-123');

      // 'Valor da Fatura Fechada (Oficial)' has wrong number format 'number' instead of 'real'
      const invalidProps = createMockCardBillsProperties({
        overrideProps: {
          'Valor da Fatura Fechada (Oficial)': {
            id: 'p_val_ofic',
            type: 'number',
            number: { format: 'number' },
          },
        },
      });

      const mockClient: any = {
        databases: {
          retrieve: async () => ({
            id: 'db-id-123',
            data_sources: [{ id: 'ds-faturas-123' }],
          }),
        },
        dataSources: {
          retrieve: async () => ({
            id: 'ds-faturas-123',
            properties: invalidProps,
          }),
        },
      };

      const verif = StepStructuralVerifier.verifyCardBillsInitialProperties(
        { properties: invalidProps },
        initialPropsPayload,
      );
      expect(verif.valid).toBe(false);
      expect(verif.reason).toBe('FORMAT_MISMATCH');

      const executor = new SchemaApplyExecutor({
        client: mockClient,
        journal,
        plan: {
          version: '1.0.0',
          planHash,
          schemaPlan: {
            steps: [
              {
                stepNumber: 53,
                operation: 'RESOLVE_DATA_SOURCE_ID',
                targetDataSource: { name: 'Faturas / Ciclos de Cartão', envKey: 'NOTION_DS_CARD_BILLS' },
                sanitizedPayload: {},
              },
            ],
          },
        } as any,
        envVars,
        allowRealMutations: true,
      });

      await expect(executor.executeDdlPlan('run_step53_fail_format', 'sha', 'main')).rejects.toThrow(
        /FORMAT_MISMATCH/,
      );
    });

    it('Step 53: relation target incorreto DEVE FALHAR', async () => {
      const journal = new MigrationJournal(testDbPath);
      const planHash = 'hash_test_step53_wrong_rel';

      journal.recordStepPending({ planHash, stepNumber: 52, operation: 'CREATE_DATABASE', targetDataSource: 'Faturas / Ciclos de Cartão' });
      journal.recordStepVerified(planHash, 52, 'db-id-123');

      // 'Cartão Vinculado' points to wrong relation target
      const invalidProps = createMockCardBillsProperties({
        overrideProps: {
          'Cartão Vinculado': {
            id: 'p_card',
            type: 'relation',
            relation: {
              data_source_id: 'wrong-account-data-source-id',
              type: 'single_property',
            },
          },
        },
      });

      const mockClient: any = {
        databases: {
          retrieve: async () => ({
            id: 'db-id-123',
            data_sources: [{ id: 'ds-faturas-123' }],
          }),
        },
        dataSources: {
          retrieve: async () => ({
            id: 'ds-faturas-123',
            properties: invalidProps,
          }),
        },
      };

      const verif = StepStructuralVerifier.verifyCardBillsInitialProperties(
        { properties: invalidProps },
        initialPropsPayload,
      );
      expect(verif.valid).toBe(false);
      expect(verif.reason).toBe('RELATION_TARGET_MISMATCH');

      const executor = new SchemaApplyExecutor({
        client: mockClient,
        journal,
        plan: {
          version: '1.0.0',
          planHash,
          schemaPlan: {
            steps: [
              {
                stepNumber: 53,
                operation: 'RESOLVE_DATA_SOURCE_ID',
                targetDataSource: { name: 'Faturas / Ciclos de Cartão', envKey: 'NOTION_DS_CARD_BILLS' },
                sanitizedPayload: {},
              },
            ],
          },
        } as any,
        envVars,
        allowRealMutations: true,
      });

      await expect(executor.executeDdlPlan('run_step53_fail_rel', 'sha', 'main')).rejects.toThrow(
        /RELATION_TARGET_MISMATCH/,
      );
    });

    it('Step 53: propriedade extra inesperada na nova base DEVE FALHAR', async () => {
      const journal = new MigrationJournal(testDbPath);
      const planHash = 'hash_test_step53_extra_prop';

      journal.recordStepPending({ planHash, stepNumber: 52, operation: 'CREATE_DATABASE', targetDataSource: 'Faturas / Ciclos de Cartão' });
      journal.recordStepVerified(planHash, 52, 'db-id-123');

      // Database has all 22 properties PLUS an unexpected property
      const invalidProps = createMockCardBillsProperties({
        extraProps: {
          'Propriedade Fantasma': {
            id: 'p_ghost',
            type: 'rich_text',
            rich_text: {},
          },
        },
      });

      const mockClient: any = {
        databases: {
          retrieve: async () => ({
            id: 'db-id-123',
            data_sources: [{ id: 'ds-faturas-123' }],
          }),
        },
        dataSources: {
          retrieve: async () => ({
            id: 'ds-faturas-123',
            properties: invalidProps,
          }),
        },
      };

      const verif = StepStructuralVerifier.verifyCardBillsInitialProperties(
        { properties: invalidProps },
        initialPropsPayload,
      );
      expect(verif.valid).toBe(false);
      expect(verif.reason).toBe('UNEXPECTED_PROPERTY');
      expect(verif.detail).toContain('Propriedade Fantasma');

      const executor = new SchemaApplyExecutor({
        client: mockClient,
        journal,
        plan: {
          version: '1.0.0',
          planHash,
          schemaPlan: {
            steps: [
              {
                stepNumber: 53,
                operation: 'RESOLVE_DATA_SOURCE_ID',
                targetDataSource: { name: 'Faturas / Ciclos de Cartão', envKey: 'NOTION_DS_CARD_BILLS' },
                sanitizedPayload: {},
              },
            ],
          },
        } as any,
        envVars,
        allowRealMutations: true,
      });

      await expect(executor.executeDdlPlan('run_step53_fail_extra', 'sha', 'main')).rejects.toThrow(
        /UNEXPECTED_PROPERTY|Propriedade Fantasma/,
      );
    });

    it('Step 53 & Step 54: schema final correto com 23 propriedades homologadas PASSA', async () => {
      // 1. Initial 22 properties pass Step 53
      const validInitialProps = createMockCardBillsProperties({ includeDualRelation: false });
      const initialVerif = StepStructuralVerifier.verifyCardBillsInitialProperties(
        { properties: validInitialProps },
        initialPropsPayload,
      );
      expect(initialVerif.valid).toBe(true);

      // 2. Final 23 properties pass post-Step 54 verification
      const validFinalProps = createMockCardBillsProperties({ includeDualRelation: true });
      expect(Object.keys(validFinalProps).length).toBe(23);

      const finalVerif = StepStructuralVerifier.verifyCardBillsFinalSchema(
        { properties: validFinalProps },
        initialPropsPayload,
        REAL_DATA_SOURCE_IDS.NOTION_DS_TRANSACTIONS,
      );
      expect(finalVerif.valid).toBe(true);

      // 3. Negative checks on Step 54:
      // Missing dual relation fails
      const withoutDual = StepStructuralVerifier.verifyCardBillsFinalSchema(
        { properties: validInitialProps },
        initialPropsPayload,
        REAL_DATA_SOURCE_IDS.NOTION_DS_TRANSACTIONS,
      );
      expect(withoutDual.valid).toBe(false);
      expect(withoutDual.reason).toBe('SYNCED_DUAL_RELATION_MISSING');

      // Wrong relation target in dual property fails
      const wrongTargetFinal = createMockCardBillsProperties({
        includeDualRelation: true,
        overrideProps: {
          'Lançamentos do Ciclo': {
            id: 'p_dual',
            type: 'relation',
            relation: {
              data_source_id: 'wrong-tx-id',
              type: 'dual_property',
              dual_property: { synced_property_name: 'Fatura Vinculada' },
            },
          },
        },
      });
      const wrongTargetVerif = StepStructuralVerifier.verifyCardBillsFinalSchema(
        { properties: wrongTargetFinal },
        initialPropsPayload,
        REAL_DATA_SOURCE_IDS.NOTION_DS_TRANSACTIONS,
      );
      expect(wrongTargetVerif.valid).toBe(false);
      expect(wrongTargetVerif.reason).toBe('RELATION_TARGET_MISMATCH');

      // Extra 24th property fails
      const extra24Props = createMockCardBillsProperties({
        includeDualRelation: true,
        extraProps: { 'Prop 24 Inesperada': { id: 'p24', type: 'rich_text', rich_text: {} } },
      });
      const extra24Verif = StepStructuralVerifier.verifyCardBillsFinalSchema(
        { properties: extra24Props },
        initialPropsPayload,
        REAL_DATA_SOURCE_IDS.NOTION_DS_TRANSACTIONS,
      );
      expect(extra24Verif.valid).toBe(false);
      expect(extra24Verif.reason).toBe('UNEXPECTED_PROPERTY');
    });

    it('Operational Apply Gate: gate ausente -> ZERO writes', async () => {
      const fakeNotion = new StatefulNotionFake(LIVE_NOTION_FIXTURES);
      const runner = new TestableMigrationRunner(
        {
          mode: 'apply',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          notionApiKey: 'ntn_mock_api_key',
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_PARENT_PAGE_ID: parentPageId,
            // NOTION_SCHEMA_APPLY_ENABLED NOT SET!
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          gitCommitShaOverride: 'commit_sha_gate_test',
          liveSnapshotOverride: LIVE_NOTION_FIXTURES,
        },
      );
      runner.setClient(fakeNotion);

      const dryRunReport = await runner.runDryRun();
      const planHash = dryRunReport.plan.planHash;

      // When gate is absent, resolveAllowRealMutations returns false and execute rejects
      expect(runner.resolveAllowRealMutations(planHash)).toBe(false);
      await expect(runner.execute(planHash)).rejects.toThrow('MUTAÇÕES REAIS BLOQUEADAS');
      expect(fakeNotion.writeCallsCount).toBe(0);
    });

    it('Operational Apply Gate: token incorreto -> ZERO writes', async () => {
      const fakeNotion = new StatefulNotionFake(LIVE_NOTION_FIXTURES);
      const runner = new TestableMigrationRunner(
        {
          mode: 'apply',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          notionApiKey: 'ntn_mock_api_key',
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_PARENT_PAGE_ID: parentPageId,
            NOTION_SCHEMA_APPLY_ENABLED: 'INCORRECT_TOKEN_TRY_MUTATE',
            NOTION_SCHEMA_APPLY_PLAN_HASH: 'some_hash',
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          gitCommitShaOverride: 'commit_sha_gate_test',
          liveSnapshotOverride: LIVE_NOTION_FIXTURES,
        },
      );
      runner.setClient(fakeNotion);

      const dryRunReport = await runner.runDryRun();
      const planHash = dryRunReport.plan.planHash;

      expect(runner.resolveAllowRealMutations(planHash)).toBe(false);
      await expect(runner.execute(planHash)).rejects.toThrow('MUTAÇÕES REAIS BLOQUEADAS');
      expect(fakeNotion.writeCallsCount).toBe(0);
    });

    it('Operational Apply Gate: hash de confirmação diferente -> ZERO writes', async () => {
      const fakeNotion = new StatefulNotionFake(LIVE_NOTION_FIXTURES);
      const runner = new TestableMigrationRunner(
        {
          mode: 'apply',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          notionApiKey: 'ntn_mock_api_key',
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_PARENT_PAGE_ID: parentPageId,
            NOTION_SCHEMA_APPLY_ENABLED: 'I_UNDERSTAND_SCHEMA_ONLY',
            NOTION_SCHEMA_APPLY_PLAN_HASH: 'bogus_hash_mismatch',
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          gitCommitShaOverride: 'commit_sha_gate_test',
          liveSnapshotOverride: LIVE_NOTION_FIXTURES,
        },
      );
      runner.setClient(fakeNotion);

      const dryRunReport = await runner.runDryRun();
      const planHash = dryRunReport.plan.planHash;

      expect(runner.resolveAllowRealMutations(planHash)).toBe(false);
      await expect(runner.execute(planHash)).rejects.toThrow('MUTAÇÕES REAIS BLOQUEADAS');
      expect(fakeNotion.writeCallsCount).toBe(0);
    });

    it('Operational Apply Gate: todos os gates corretos -> executor atinge o caminho mutante em mock/fake', async () => {
      // 1. First obtain the valid plan and planHash
      const tempRunner = new TestableMigrationRunner(
        {
          mode: 'dry-run',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_PARENT_PAGE_ID: parentPageId,
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          gitCommitShaOverride: 'commit_sha_apply_allowed',
          liveSnapshotOverride: LIVE_NOTION_FIXTURES,
        },
      );
      const dryRunReport = await tempRunner.runDryRun();
      const planHash = dryRunReport.plan.planHash;

      // 2. Setup stateful fake Notion
      const fakeNotion = new StatefulNotionFake(LIVE_NOTION_FIXTURES);

      // 3. Configure runner with EXACT approval gates
      const applyRunner = new TestableMigrationRunner(
        {
          mode: 'apply',
          dbPath: testDbPath,
          backupDir: testBackupDir,
          backupKey: validStrongBackupKey,
          notionApiKey: 'ntn_mock_api_key',
          envVars: {
            ...REAL_DATA_SOURCE_IDS,
            NOTION_PARENT_PAGE_ID: parentPageId,
            NOTION_SCHEMA_APPLY_ENABLED: 'I_UNDERSTAND_SCHEMA_ONLY',
            NOTION_SCHEMA_APPLY_PLAN_HASH: planHash,
          },
        },
        {
          worktreeStatusOverride: 'WORKTREE_CLEAN',
          gitCommitShaOverride: 'commit_sha_apply_allowed',
          liveSnapshotOverride: LIVE_NOTION_FIXTURES,
        },
      );
      applyRunner.setClient(fakeNotion);

      // Gate check
      expect(applyRunner.resolveAllowRealMutations(planHash)).toBe(true);

      // Execute apply
      const report = await applyRunner.execute(planHash);
      expect(report.mode).toBe('apply');
      if (report.mode === 'apply') {
        expect(report.summary.totalSteps).toBe(54);
        expect(report.summary.verifiedCount).toBe(54);
        expect(report.summary.noOpCount).toBe(0);
        expect(report.mutationsExecuted).toBe(54);
        expect(fakeNotion.writeCallsCount).toBeGreaterThan(50);

        // Check report formatting
        const formatted = applyRunner.formatReport(report);
        expect(formatted).toContain('SCHEMA APPLY EXECUTOR');
        expect(formatted).toContain('EXECUÇÃO DDL CONCLUÍDA COM SUCESSO NO NOTION');
      }
    });
  });
});
