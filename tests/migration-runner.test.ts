import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
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
import { TARGET_CONTRACT } from '../src/domain/schema-contract';

describe('Notion Migration Runner (Phase 1 Dry-Run & Planning)', () => {
  let tempDir: string;
  let testDbPath: string;
  let testBackupDir: string;
  const testBackupKey = 'super-secret-migration-backup-key-for-tests-2026';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-migration-runner-test-'));
    testDbPath = path.join(tempDir, 'test-financial.db');
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
        backupKey: testBackupKey,
      });
      // @ts-expect-error private field access for test verification
      expect(runner.mode).toBe('dry-run');
    });

    it('produces a dry-run report with mutationsExecuted === 0 and does not perform any mutations', async () => {
      const runner = new MigrationRunner({
        mode: 'dry-run',
        dbPath: testDbPath,
        backupDir: testBackupDir,
        backupKey: testBackupKey,
        allowEmptyDbForBackup: true,
      });

      const report = await runner.runDryRun();

      expect(report.mode).toBe('dry-run');
      expect(report.mutationsExecuted).toBe(0);
      expect(report.plan).toBeDefined();
      expect(report.plan.planHash).toMatch(/^[a-f0-9]{64}$/);
      expect(report.backup.verifiedRestoration).toBe(true);
    });

    it('blocks apply execution if planHash is missing', async () => {
      const runner = new MigrationRunner({
        mode: 'apply',
        dbPath: testDbPath,
        backupDir: testBackupDir,
        backupKey: testBackupKey,
      });

      await expect(runner.execute()).rejects.toThrow(/--plan-hash/);
    });

    it('blocks apply execution if planHash does not match computed hash', async () => {
      const runner = new MigrationRunner({
        mode: 'apply',
        dbPath: testDbPath,
        backupDir: testBackupDir,
        backupKey: testBackupKey,
      });

      const bogusHash = '0000000000000000000000000000000000000000000000000000000000000000';
      await expect(runner.execute(bogusHash)).rejects.toThrow(/PLAN_HASH_MISMATCH/);
    });

    it('blocks apply execution with safeguard gate even when correct planHash is provided', async () => {
      const runnerDry = new MigrationRunner({
        mode: 'dry-run',
        dbPath: testDbPath,
        backupDir: testBackupDir,
        backupKey: testBackupKey,
      });
      const dryReport = await runnerDry.runDryRun();
      const validHash = dryReport.plan.planHash;

      const runnerApply = new MigrationRunner({
        mode: 'apply',
        dbPath: testDbPath,
        backupDir: testBackupDir,
        backupKey: testBackupKey,
      });

      await expect(runnerApply.execute(validHash)).rejects.toThrow(/MUTAÇÕES REAIS BLOQUEADAS/);
    });
  });

  describe('2. Deterministic Plan Hashing', () => {
    it('generates identical planHash across multiple calls on the same plan', () => {
      const planner = new SchemaPlanner();
      const backfillPlanner = new BackfillPlanner();

      const planA = {
        schemaPlan: planner.generatePlan(),
        backfillPlan: backfillPlanner.generatePlan(),
      };
      const planB = {
        schemaPlan: planner.generatePlan(),
        backfillPlan: backfillPlanner.generatePlan(),
      };

      const hashA = computePlanHash(planA);
      const hashB = computePlanHash(planB);

      expect(hashA).toBe(hashB);
      expect(verifyPlanHash(planA as any, hashA)).toBe(true);
    });

    it('detects modifications in schema plan payloads and changes the hash', () => {
      const planner = new SchemaPlanner();
      const backfillPlanner = new BackfillPlanner();

      const originalPlan = {
        schemaPlan: planner.generatePlan(),
        backfillPlan: backfillPlanner.generatePlan(),
      };
      const hashOriginal = computePlanHash(originalPlan);

      // Mutate a step in a clone
      const modifiedSchemaPlan = JSON.parse(JSON.stringify(originalPlan.schemaPlan));
      modifiedSchemaPlan.steps[0].sanitizedPayload.Status.status.options.push({ name: 'TamperedOption' });

      const modifiedPlan = {
        schemaPlan: modifiedSchemaPlan,
        backfillPlan: originalPlan.backfillPlan,
      };
      const hashModified = computePlanHash(modifiedPlan);

      expect(hashModified).not.toBe(hashOriginal);
      expect(verifyPlanHash(modifiedPlan as any, hashOriginal)).toBe(false);
    });

    it('canonicalizes JSON with sorted keys independent of insertion order', () => {
      const obj1 = { b: 2, a: 1, c: { z: 26, y: 25 } };
      const obj2 = { c: { y: 25, z: 26 }, a: 1, b: 2 };

      expect(canonicalizeJson(obj1)).toBe(canonicalizeJson(obj2));
    });
  });

  describe('3. Schema Plan DDL Generation (Homologated Plan Consistency)', () => {
    it('generates exactly 55 deterministic schema steps', () => {
      const planner = new SchemaPlanner();
      const plan = planner.generatePlan();

      expect(plan.summary.totalSteps).toBe(55);
      expect(plan.steps.length).toBe(55);

      expect(plan.summary.alterOptionsCount).toBe(1);
      expect(plan.summary.createPropertyCount).toBe(51);
      expect(plan.summary.createDatabaseCount).toBe(1);
      expect(plan.summary.resolveDataSourceCount).toBe(1);
      expect(plan.summary.dualRelationCount).toBe(1);
    });

    it('step 1 alters Obrigações Mensais Status preserving all 5 physical options and adding 2 new ones', () => {
      const planner = new SchemaPlanner();
      const plan = planner.generatePlan();

      const step1 = plan.steps[0];
      expect(step1.stepNumber).toBe(1);
      expect(step1.operation).toBe('ALTER_SELECT_OPTIONS');
      expect(step1.targetDataSource.envKey).toBe('NOTION_DS_MONTHLY_OBLIGATIONS');
      expect(step1.property).toBe('Status');

      const options = step1.sanitizedPayload.Status.status.options.map((o: any) => o.name);
      expect(options).toEqual([
        'Prevista',
        'Pendente',
        'Paga',
        'Atrasada',
        'Dispensada',
        'Revisão Necessária',
        'Cancelada',
      ]);
      expect(step1.metadata?.readBeforeWriteVerified).toBe(true);
    });

    it('generates 51 CREATE_PROPERTY steps corresponding to all missing contract fields across the 12 bases', () => {
      const planner = new SchemaPlanner();
      const plan = planner.generatePlan();

      const createSteps = plan.steps.filter((s) => s.operation === 'CREATE_PROPERTY');
      expect(createSteps.length).toBe(51);

      expect(plan.summary.createPropertyCount).toBe(51);
      expect(plan.summary.totalSteps).toBe(55);

      // Verify per-datasource breakdown matches exactly
      expect(plan.summary.byDataSource['NOTION_DS_ACCOUNTS']).toBe(4);
      expect(plan.summary.byDataSource['NOTION_DS_TRANSACTIONS']).toBe(10 + 1); // 10 create + 1 dual relation
      expect(plan.summary.byDataSource['NOTION_DS_RULES']).toBe(3);
      expect(plan.summary.byDataSource['NOTION_DS_FIXED_BILLS']).toBe(4);
      expect(plan.summary.byDataSource['NOTION_DS_INVESTMENTS']).toBe(5);
      expect(plan.summary.byDataSource['NOTION_DS_INVESTMENT_MOVEMENTS']).toBe(2);
      expect(plan.summary.byDataSource['NOTION_DS_MONTHLY_BUDGET']).toBe(4);
      expect(plan.summary.byDataSource['NOTION_DS_MONTHLY_CLOSINGS']).toBe(9);
      expect(plan.summary.byDataSource['NOTION_DS_SYNC_LOG']).toBe(10);
      expect(plan.summary.byDataSource['NOTION_DS_CARD_BILLS']).toBe(1); // 1 create database
      expect(plan.summary.byDataSource['NOTION_DS_MONTHLY_OBLIGATIONS']).toBe(1); // 1 alter status
    });

    it('models Faturas / Ciclos de Cartão in 3 distinct dependent phases', () => {
      const planner = new SchemaPlanner();
      const plan = planner.generatePlan();

      const createDbStep = plan.steps.find((s) => s.operation === 'CREATE_DATABASE')!;
      const resolveDsStep = plan.steps.find((s) => s.operation === 'RESOLVE_DATA_SOURCE_ID')!;
      const dualRelStep = plan.steps.find((s) => s.operation === 'CREATE_DUAL_RELATION')!;

      expect(createDbStep).toBeDefined();
      expect(resolveDsStep).toBeDefined();
      expect(dualRelStep).toBeDefined();

      expect(createDbStep.stepNumber).toBe(53);
      expect(resolveDsStep.stepNumber).toBe(54);
      expect(dualRelStep.stepNumber).toBe(55);

      expect(resolveDsStep.dependsOnStep).toBe(53);
      expect(dualRelStep.dependsOnStep).toBe(54);

      // Verify dual relation targets
      expect(dualRelStep.targetDataSource.envKey).toBe('NOTION_DS_TRANSACTIONS');
      expect(dualRelStep.property).toBe('Fatura / Ciclo de Cartão');
      expect(
        dualRelStep.sanitizedPayload['Fatura / Ciclo de Cartão'].relation.dual_property
          .synced_property_name,
      ).toBe('Transações da Fatura');
    });
  });

  describe('4. Backfill Plan Generation', () => {
    it('generates 5 distinct idempotent checkpointed backfill pipelines', () => {
      const backfillPlanner = new BackfillPlanner();
      const plan = backfillPlanner.generatePlan();

      expect(plan.totalPipelines).toBe(5);
      expect(plan.pipelines.map((p) => p.id)).toEqual([
        'PIPELINE_1_ACCOUNTS',
        'PIPELINE_2_TRANSACTIONS',
        'PIPELINE_3_MONTHLY_BUDGET',
        'PIPELINE_4_MONTHLY_OBLIGATIONS',
        'PIPELINE_5_CARD_BILLS',
      ]);

      for (const pipeline of plan.pipelines) {
        expect(pipeline.mode).toBe('IDEMPOTENT_CHECKPOINTED');
        expect(pipeline.readStrategy.length).toBeGreaterThan(10);
        expect(pipeline.transformStrategy.length).toBeGreaterThan(10);
        expect(pipeline.writeStrategy.length).toBeGreaterThan(10);
        expect(pipeline.verificationStrategy.length).toBeGreaterThan(10);
      }
    });
  });

  describe('5. Encrypted Backup Module (AES-256-GCM + Automated Restoration Test)', () => {
    it('creates an encrypted backup file, calculates SHA-256 and proves SQLite integrity', async () => {
      const backupManager = new FinancialBackupManager({
        dbPath: testDbPath,
        backupDir: testBackupDir,
        key: testBackupKey,
      });

      const result = await backupManager.createEncryptedBackup();

      expect(result.verifiedRestoration).toBe(true);
      expect(fs.existsSync(result.backupPath)).toBe(true);
      expect(result.originalSize).toBeGreaterThan(0);
      expect(result.encryptedSize).toBeGreaterThan(result.originalSize);
      expect(result.encryptedHashSha256).toMatch(/^[a-f0-9]{64}$/);

      // Verify file header starts with magic bytes FIN_ENC_V1
      const fileBytes = fs.readFileSync(result.backupPath);
      expect(fileBytes.subarray(0, 10).toString('utf8')).toBe('FIN_ENC_V1');
    });

    it('fails integrity test and throws error if backup file ciphertext is corrupted', async () => {
      const backupManager = new FinancialBackupManager({
        dbPath: testDbPath,
        backupDir: testBackupDir,
        key: testBackupKey,
      });

      const result = await backupManager.createEncryptedBackup();

      // Corrupt bytes in the backup file
      const corruptedBytes = fs.readFileSync(result.backupPath);
      corruptedBytes[corruptedBytes.length - 10] ^= 0xff; // flip bits in ciphertext
      fs.writeFileSync(result.backupPath, corruptedBytes);

      const restoreDest = path.join(tempDir, 'should-fail-restore.db');
      await expect(backupManager.restoreBackup(result.backupPath, restoreDest)).rejects.toThrow();
    });

    it('can restore backup to a new file and recover original database contents', async () => {
      const backupManager = new FinancialBackupManager({
        dbPath: testDbPath,
        backupDir: testBackupDir,
        key: testBackupKey,
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
    it('reports permissions as UNVERIFIED_UNTIL_APPLY and never sends mutations', async () => {
      // Mock client that records all method calls
      const calls: string[] = [];
      const mockClient: any = {
        dataSources: {
          retrieve: async (params: any) => {
            calls.push(`dataSources.retrieve:${params.data_source_id}`);
            return { properties: { Status: { type: 'status' } } };
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

      // Verify ONLY retrieve calls were made (strictly read-only)
      expect(calls.every((c) => c.startsWith('dataSources.retrieve') || c.startsWith('pages.retrieve'))).toBe(true);
      expect(calls.some((c) => c.includes('update') || c.includes('create') || c.includes('delete'))).toBe(false);
    });
  });
});
