import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { Client } from '@notionhq/client';
import { TARGET_CONTRACT, HOMOLOGATED_MISSING_PROPERTIES } from '../../domain/schema-contract';
import { NotionSchemaValidator } from '../schema-validator';
import {
  CompleteMigrationPlan,
  DryRunReport,
  ApplyReport,
  MigrationReport,
  InputFingerprint,
  MigrationReadiness,
  WorktreeStatus,
  SchemaConformanceResult,
  RecoveryPreflightReport,
  RecoveryEligibilityResult,
  PreflightCheckResult,
} from './types';
import { SchemaPlanner } from './schema-planner';
import { BackfillPlanner } from './backfill-planner';
import { computePlanHash, verifyPlanHash, canonicalizeJson } from './hasher';
import { PreflightValidator } from './preflight';
import { FinancialBackupManager } from './backup';
import { MigrationJournal } from './journal';
import { SchemaApplyExecutor } from './schema-executor';
import { StepStructuralVerifier } from './step-verifier';

export const HOMOLOGATED_RECOVERY_PLAN_HASH =
  'a6687b60765477849f84f885ab914f99286a38506380daa24dc37591724608db';
export const HOMOLOGATED_RECOVERY_FROM_COMMIT =
  '993c55ae332ab0be8ce5ea5f1b7f0b05b47b304c';

export interface MigrationRunnerOptions {
  mode?: 'dry-run' | 'apply' | 'recovery' | 'recovery-preflight';
  planHash?: string;
  backupKey?: string;
  dbPath?: string;
  backupDir?: string;
  envVars?: Record<string, string | undefined>;
  notionApiKey?: string;
  allowEmptyDbForBackup?: boolean;
  expectedCommitSha?: string;
}

export interface TestDoubles {
  worktreeStatusOverride?: WorktreeStatus;
  mockDirtyFiles?: string[];
  liveSnapshotOverride?: Record<string, Record<string, any>>;
  gitBranchOverride?: string;
  gitCommitShaOverride?: string;
  gitParentCommitShaOverride?: string;
  simulateGitFailure?: boolean;
  simulateRemoteTrackingMismatch?: boolean;
}

export class MigrationRunner {
  protected mode: 'dry-run' | 'apply' | 'recovery' | 'recovery-preflight';
  protected envVars: Record<string, string | undefined>;
  protected client?: Client;
  protected preflightValidator: PreflightValidator;
  protected backfillPlanner: BackfillPlanner;
  protected backupManager: FinancialBackupManager;
  protected journal: MigrationJournal;
  protected expectedCommitSha?: string;
  protected testDoubles?: TestDoubles;

  constructor(options: MigrationRunnerOptions = {}) {
    this.mode = options.mode ?? 'dry-run';
    this.envVars = options.envVars ?? process.env;
    this.expectedCommitSha = options.expectedCommitSha;

    const apiKey = options.notionApiKey ?? this.envVars.NOTION_API_KEY?.trim();
    if (apiKey) {
      this.client = new Client({
        auth: apiKey,
        notionVersion: '2026-03-11',
      });
    }

    this.preflightValidator = new PreflightValidator(this.client, '2026-03-11');
    this.backfillPlanner = new BackfillPlanner();
    this.backupManager = new FinancialBackupManager({
      dbPath: options.dbPath,
      backupDir: options.backupDir,
      key: options.backupKey ?? this.envVars.MIGRATION_BACKUP_KEY?.trim(),
      allowEmptyDbForBackup: options.allowEmptyDbForBackup ?? false,
    });

    const journalDbPath =
      options.dbPath ??
      (this.envVars.DATABASE_PATH
        ? path.resolve(process.cwd(), this.envVars.DATABASE_PATH)
        : path.resolve(process.cwd(), 'data', 'financial.db'));
    this.journal = new MigrationJournal(journalDbPath);
  }

  public getJournal(): MigrationJournal {
    return this.journal;
  }

  /**
   * Resolves the current git state in a strict fail-closed manner.
   * Any failure in git commands, detached/invalid commit, or remote tracking mismatch
   * flags GIT_STATE_UNVERIFIED and blocks dry-run and apply.
   */
  public resolveGitState(): {
    status: WorktreeStatus;
    branch?: string;
    commitSha?: string;
    dirtyFiles: string[];
    unverifiedReason?: string;
  } {
    if (this.testDoubles?.simulateGitFailure) {
      return {
        status: 'GIT_STATE_UNVERIFIED',
        dirtyFiles: [],
        unverifiedReason: 'Simulated git failure in test environment',
      };
    }

    if (this.testDoubles?.worktreeStatusOverride) {
      return {
        status: this.testDoubles.worktreeStatusOverride,
        branch: this.testDoubles.gitBranchOverride ?? 'feat/phase-1-schema-apply-executor',
        commitSha: this.testDoubles.gitCommitShaOverride ?? '0123456789abcdef0123456789abcdef01234567',
        dirtyFiles:
          this.testDoubles.mockDirtyFiles ??
          (this.testDoubles.worktreeStatusOverride === 'WORKTREE_DIRTY' ? ['M mock/modified-file.ts'] : []),
        unverifiedReason:
          this.testDoubles.worktreeStatusOverride === 'GIT_STATE_UNVERIFIED'
            ? 'Test double override'
            : undefined,
      };
    }

    try {
      // 1. Resolve commit SHA
      const commitSha = execSync('git rev-parse HEAD', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      if (!commitSha || !/^[0-9a-f]{40}$/i.test(commitSha)) {
        return {
          status: 'GIT_STATE_UNVERIFIED',
          dirtyFiles: [],
          unverifiedReason: `Commit SHA inválido ou não determinável: '${commitSha}'`,
        };
      }

      // 2. Resolve branch
      let branch = 'unknown';
      try {
        const branchOutput = execSync('git rev-parse --abbrev-ref HEAD', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (branchOutput && branchOutput !== 'HEAD') {
          branch = branchOutput;
        } else {
          branch = 'DETACHED_HEAD';
        }
      } catch {
        branch = 'UNVERIFIED';
      }

      // 3. Remote Tracking Parity Check (if tracking branch configured)
      if (this.testDoubles?.simulateRemoteTrackingMismatch) {
        return {
          status: 'GIT_STATE_UNVERIFIED',
          branch,
          commitSha,
          dirtyFiles: [],
          unverifiedReason: 'HEAD local diverge do tracking remoto (simulado)',
        };
      }

      try {
        const upstreamSha = execSync('git rev-parse @{u}', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();

        if (upstreamSha && upstreamSha !== commitSha) {
          return {
            status: 'GIT_STATE_UNVERIFIED',
            branch,
            commitSha,
            dirtyFiles: [],
            unverifiedReason: `HEAD local (${commitSha.slice(0, 7)}) diverge do tracking remoto @{u} (${upstreamSha.slice(0, 7)}). Push ou sincronização obrigatória.`,
          };
        }
      } catch {
        // No upstream tracking branch configured yet, skip tracking parity check
      }

      // 4. Expected Commit SHA Check (if provided)
      if (this.expectedCommitSha && commitSha !== this.expectedCommitSha) {
        return {
          status: 'GIT_STATE_UNVERIFIED',
          branch,
          commitSha,
          dirtyFiles: [],
          unverifiedReason: `HEAD local (${commitSha}) não coincide com o commit esperado (${this.expectedCommitSha}).`,
        };
      }

      // 5. Working Tree Status Check
      const statusOutput = execSync('git status --porcelain', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      if (!statusOutput) {
        return {
          status: 'WORKTREE_CLEAN',
          branch,
          commitSha,
          dirtyFiles: [],
        };
      }

      const lines = statusOutput.split('\n').map((l) => l.trim()).filter(Boolean);
      const relevantDirtyFiles: string[] = [];

      for (const line of lines) {
        const statusCode = line.slice(0, 2);
        const filePath = line.slice(3).trim();

        // Check if tracked modified, staged, or untracked in relevant directories
        const isUntracked = statusCode === '??';
        const isRelevant =
          !isUntracked ||
          filePath.startsWith('src/') ||
          filePath.startsWith('scripts/') ||
          filePath.startsWith('tests/') ||
          filePath.startsWith('architecture/') ||
          filePath === 'package.json' ||
          filePath === 'tsconfig.json' ||
          filePath === 'schema-contract.ts';

        if (isRelevant) {
          relevantDirtyFiles.push(`${statusCode} ${filePath}`);
        }
      }

      if (relevantDirtyFiles.length > 0) {
        return {
          status: 'WORKTREE_DIRTY',
          branch,
          commitSha,
          dirtyFiles: relevantDirtyFiles,
        };
      }

      return {
        status: 'WORKTREE_CLEAN',
        branch,
        commitSha,
        dirtyFiles: [],
      };
    } catch (err: any) {
      return {
        status: 'GIT_STATE_UNVERIFIED',
        dirtyFiles: [],
        unverifiedReason: `Falha ao executar comandos git: ${err.message || String(err)}`,
      };
    }
  }

  public getGitParentCommitSha(): string | undefined {
    if (this.testDoubles?.gitParentCommitShaOverride) {
      return this.testDoubles.gitParentCommitShaOverride;
    }
    try {
      // Use HEAD~1 to avoid shell escaping issues with '^' on Windows cmd
      const parent = execSync('git rev-parse HEAD~1', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return parent || undefined;
    } catch {
      return undefined;
    }
  }

  public verifyUpstreamInSync(commitSha?: string): boolean {
    if (this.testDoubles?.simulateRemoteTrackingMismatch) {
      return false;
    }
    if (this.testDoubles?.gitCommitShaOverride) {
      return true;
    }
    try {
      const upstreamSha = execSync('git rev-parse @{u}', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return Boolean(upstreamSha && commitSha && upstreamSha === commitSha);
    } catch {
      return false;
    }
  }

  /**
   * Executes a strict, read-only dry-run migration.
   * Performs preflight checks, generates live structural snapshot, generates deterministic DDL and DML plans,
   * calculates SHA-256 planHash with inputFingerprint, creates and verifies AES-256-GCM backup.
   * ABSOLUTELY ZERO NOTION MUTATIONS.
   */
  public async runDryRun(): Promise<DryRunReport> {
    const timestamp = new Date().toISOString();

    // 0. Gate: Fail-closed Git State Check
    const gitState = this.resolveGitState();

    // 1. Read-only Preflight Check
    const preflight = await this.preflightValidator.runPreflight(this.envVars);

    // Apply liveSnapshotOverride if specified in test doubles
    if (this.testDoubles?.liveSnapshotOverride) {
      preflight.liveSnapshot = this.testDoubles.liveSnapshotOverride;
      preflight.liveSnapshotSha256 = crypto
        .createHash('sha256')
        .update(canonicalizeJson(this.testDoubles.liveSnapshotOverride), 'utf8')
        .digest('hex');
    }

    // 2. Generate Deterministic Schema Plan (DDL) directly from live preflight snapshot
    const schemaPlanner = new SchemaPlanner({
      envVars: this.envVars,
      liveSnapshot: preflight.liveSnapshot,
      parentPageId: preflight.parentPage.pageId,
    });
    const schemaPlan = schemaPlanner.generatePlan();

    // 3. Generate Deterministic Backfill Plan (DML)
    const backfillPlanner = new BackfillPlanner();
    const backfillPlan = backfillPlanner.generatePlan();

    // 4. Build Input Fingerprint
    const dataSourceIds: Record<string, string> = {};
    for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
      if (contract.isExisting) {
        dataSourceIds[contract.envKey] = this.envVars[contract.envKey]?.trim() || '';
      }
    }

    const inputFingerprint: InputFingerprint = {
      commitSha: gitState.commitSha ?? 'unknown',
      notionApiVersion: preflight.apiVersion,
      parentPageId: preflight.parentPage.pageId || '',
      dataSourceIds,
      liveSnapshotSha256: preflight.liveSnapshotSha256,
    };

    // 5. Compute Deterministic Plan Hash (incorporating inputFingerprint)
    const planHash = computePlanHash({ inputFingerprint, schemaPlan, backfillPlan });

    const completePlan: CompleteMigrationPlan = {
      version: '1.0.0',
      planHash,
      inputFingerprint,
      schemaPlan,
      backfillPlan,
    };

    // 6. Create and Verify Encrypted Pre-Migration Snapshot (AES-256-GCM)
    const backupResult = await this.backupManager.createEncryptedBackup();

    // 7. Schema Conformance Check (NotionSchemaValidator)
    const schemaValidator = new NotionSchemaValidator(
      this.client ? this.envVars.NOTION_API_KEY : undefined,
      preflight.apiVersion,
    );

    let typeMismatches = 0;
    let renameTypeMismatches = 0;
    let renameStructuralMismatches = 0;
    let heuristicSuggestions = 0;
    let structuralMismatches = 0;
    let structuralMismatchProperty: string | undefined;
    let missingCount = 0;
    const actualMissingProperties = new Set<string>();

    const hasLiveSnapshot = Object.keys(preflight.liveSnapshot).length > 0;

    if (hasLiveSnapshot) {
      for (const [envKey, contract] of Object.entries(TARGET_CONTRACT)) {
        if (!contract.isExisting) continue;
        const actualProps = preflight.liveSnapshot[contract.envKey] ?? {};
        const diffs = schemaValidator.compareProperties(contract, actualProps, dataSourceIds);

        for (const diff of diffs) {
          if (diff.status === 'TYPE_MISMATCH') typeMismatches++;
          if (diff.status === 'RENAME_TYPE_MISMATCH') renameTypeMismatches++;
          if (diff.status === 'RENAME_STRUCTURAL_MISMATCH') renameStructuralMismatches++;
          if (diff.status === 'HEURISTIC_SUGGESTION') heuristicSuggestions++;
          if (diff.status === 'STRUCTURAL_MISMATCH') {
            structuralMismatches++;
            structuralMismatchProperty = `${contract.defaultTitle}.${diff.notionProperty}`;
          }
          if (diff.status === 'MISSING') {
            missingCount++;
            actualMissingProperties.add(`${contract.envKey}.${diff.notionProperty}`);
          }
        }
      }
    }

    const unexpectedMissingProperties: string[] = [];
    for (const prop of actualMissingProperties) {
      if (!HOMOLOGATED_MISSING_PROPERTIES.has(prop)) {
        unexpectedMissingProperties.push(prop);
      }
    }

    const expectedMissingButPresent: string[] = [];
    for (const prop of HOMOLOGATED_MISSING_PROPERTIES) {
      if (!actualMissingProperties.has(prop)) {
        expectedMissingButPresent.push(prop);
      }
    }

    const isConformant =
      hasLiveSnapshot &&
      typeMismatches === 0 &&
      renameTypeMismatches === 0 &&
      renameStructuralMismatches === 0 &&
      heuristicSuggestions === 0 &&
      structuralMismatches === 1 &&
      structuralMismatchProperty === 'Obrigações Mensais.Status' &&
      missingCount === HOMOLOGATED_MISSING_PROPERTIES.size &&
      unexpectedMissingProperties.length === 0 &&
      expectedMissingButPresent.length === 0;

    const schemaConformance: SchemaConformanceResult = {
      typeMismatches,
      renameTypeMismatches,
      renameStructuralMismatches,
      heuristicSuggestions,
      structuralMismatches,
      structuralMismatchProperty,
      missingCount,
      unexpectedMissingProperties,
      expectedMissingButPresent,
      isConformant,
    };

    // 8. Evaluate Readiness (dryRunValid vs applyReady)
    const reasons: string[] = [];
    const verifiedDsCount = preflight.dataSources.filter((d) => d.status === 'VERIFIED').length;
    const parentConfigured =
      preflight.parentPage.status === 'CONFIGURED' && preflight.parentPage.accessible;

    let dryRunValid =
      backupResult.verifiedRestoration &&
      schemaPlan.steps.length > 0 &&
      backfillPlan.pipelines.length > 0;

    let applyReady = dryRunValid && preflight.errors.length === 0;

    if (gitState.status === 'GIT_STATE_UNVERIFIED') {
      dryRunValid = false;
      applyReady = false;
      reasons.push(
        `GIT_STATE_UNVERIFIED: Estado git não verificável (${gitState.unverifiedReason ?? 'Falha ao verificar commit/branch'}). Dry-run e apply bloqueados.`,
      );
    } else if (gitState.status === 'WORKTREE_DIRTY') {
      dryRunValid = false;
      applyReady = false;
      reasons.push(
        `WORKTREE_DIRTY: Working tree possui alterações não commitadas ou staged (${gitState.dirtyFiles.join(', ')}). Dry-run e apply bloqueados até commit 100% limpo.`,
      );
    }

    if (!schemaConformance.isConformant) {
      applyReady = false;
      const details: string[] = [];
      if (typeMismatches > 0) details.push(`TYPE_MISMATCH=${typeMismatches}`);
      if (renameTypeMismatches > 0) details.push(`RENAME_TYPE_MISMATCH=${renameTypeMismatches}`);
      if (renameStructuralMismatches > 0) details.push(`RENAME_STRUCTURAL_MISMATCH=${renameStructuralMismatches}`);
      if (heuristicSuggestions > 0) details.push(`HEURISTIC_SUGGESTION=${heuristicSuggestions}`);
      if (structuralMismatches !== 1 || structuralMismatchProperty !== 'Obrigações Mensais.Status') {
        details.push(`STRUCTURAL_MISMATCH=${structuralMismatches} [esperado: 1 em Obrigações Mensais.Status]`);
      }
      if (missingCount !== HOMOLOGATED_MISSING_PROPERTIES.size) {
        details.push(`MISSING=${missingCount} [esperado: ${HOMOLOGATED_MISSING_PROPERTIES.size}]`);
      }
      if (unexpectedMissingProperties.length > 0) {
        details.push(`UNEXPECTED_MISSING=${unexpectedMissingProperties.join(', ')}`);
      }
      if (expectedMissingButPresent.length > 0) {
        details.push(`EXPECTED_MISSING_BUT_PRESENT=${expectedMissingButPresent.join(', ')}`);
      }
      reasons.push(
        `SCHEMA_NON_CONFORMANT: Divergências contra o baseline homologado detectadas (${details.join(' | ')}).`,
      );
    }

    if (verifiedDsCount !== 12) {
      applyReady = false;
      reasons.push(`Apenas ${verifiedDsCount}/12 Data Sources verificados na API do Notion.`);
    }

    if (!parentConfigured) {
      applyReady = false;
      reasons.push(
        'NOTION_PARENT_PAGE_ID não configurado ou inacessível. Obrigatório para a criação de Faturas em modo apply.',
      );
    }

    if (preflight.relationTargets.some((r) => !r.valid)) {
      applyReady = false;
      reasons.push('Existem targets de relation pendentes ou inválidos no workspace.');
    }

    const readiness: MigrationReadiness = {
      dryRunValid,
      applyReady,
      worktreeStatus: gitState.status,
      gitBranch: gitState.branch,
      gitCommitSha: gitState.commitSha,
      dirtyFiles: gitState.dirtyFiles.length > 0 ? gitState.dirtyFiles : undefined,
      schemaConformance,
      reasons,
    };

    return {
      mode: 'dry-run',
      timestamp,
      readiness,
      preflight,
      backup: backupResult,
      plan: completePlan,
      mutationsExecuted: 0,
    };
  }

  /**
   * Resolves whether physical schema mutations (apply) are operationally authorized.
   * Strictly FALSE unless:
   * 1. mode === 'apply'
   * 2. NOTION_SCHEMA_APPLY_ENABLED === 'I_UNDERSTAND_SCHEMA_ONLY'
   * 3. NOTION_SCHEMA_APPLY_PLAN_HASH === providedPlanHash
   */
  public resolveAllowRealMutations(providedPlanHash?: string): boolean {
    if (this.mode !== 'apply') {
      return false;
    }

    const token = this.envVars.NOTION_SCHEMA_APPLY_ENABLED?.trim();
    const planHashConfirmation = this.envVars.NOTION_SCHEMA_APPLY_PLAN_HASH?.trim();

    const isTokenValid = token === 'I_UNDERSTAND_SCHEMA_ONLY';
    const isHashValid =
      Boolean(providedPlanHash) &&
      Boolean(planHashConfirmation) &&
      planHashConfirmation === providedPlanHash;

    return isTokenValid && isHashValid;
  }

  /**
   * Resolves whether physical schema mutations in RECOVERY mode are authorized.
   * Strictly FALSE unless:
   * 1. NOTION_SCHEMA_RECOVERY_ENABLED === 'I_UNDERSTAND_RECOVERY_ONLY'
   * 2. NOTION_SCHEMA_RECOVERY_PLAN_HASH === HOMOLOGATED_RECOVERY_PLAN_HASH && === providedPlanHash
   * 3. NOTION_SCHEMA_RECOVERY_FROM_COMMIT === HOMOLOGATED_RECOVERY_FROM_COMMIT
   * 4. NOTION_SCHEMA_RECOVERY_PATCH_SHA === currentCommit
   */
  public resolveAllowRecoveryMutations(providedPlanHash?: string, currentCommit?: string): boolean {
    const recoveryToken = this.envVars.NOTION_SCHEMA_RECOVERY_ENABLED?.trim();
    const recoveryPlanHash = this.envVars.NOTION_SCHEMA_RECOVERY_PLAN_HASH?.trim();
    const recoveryFromCommit = this.envVars.NOTION_SCHEMA_RECOVERY_FROM_COMMIT?.trim();
    const recoveryPatchSha = this.envVars.NOTION_SCHEMA_RECOVERY_PATCH_SHA?.trim();

    const isTokenValid = recoveryToken === 'I_UNDERSTAND_RECOVERY_ONLY';
    const isPlanHashValid =
      recoveryPlanHash === HOMOLOGATED_RECOVERY_PLAN_HASH &&
      Boolean(providedPlanHash) &&
      recoveryPlanHash === providedPlanHash;
    const isFromCommitValid = recoveryFromCommit === HOMOLOGATED_RECOVERY_FROM_COMMIT;
    const isPatchShaValid =
      Boolean(currentCommit) &&
      Boolean(recoveryPatchSha) &&
      recoveryPatchSha === currentCommit;

    return isTokenValid && isPlanHashValid && isFromCommitValid && isPatchShaValid;
  }

  /**
   * Execution dispatcher.
   */
  public async execute(providedPlanHash?: string): Promise<MigrationReport> {
    if (this.mode === 'recovery-preflight') {
      return this.runRecoveryPreflight(providedPlanHash);
    }

    if (this.mode === 'dry-run') {
      return this.runDryRun();
    }

    // Apply Mode Safeguards
    if (!providedPlanHash) {
      throw new Error(
        'Execução em modo apply requer o parâmetro obrigatório --plan-hash correspondente ao dry-run homologado.',
      );
    }

    const isResume = this.journal.hasPlan(providedPlanHash);

    if (!isResume) {
      // -----------------------------------------------------------------------
      // INITIAL_APPLY: Requer baseline homologado exato e persiste plano no SQLite
      // -----------------------------------------------------------------------
      const dryRunResult = await this.runDryRun();

      if (!dryRunResult.readiness.applyReady) {
        throw new Error(
          `APPLY_BLOCKED: O workspace não está pronto para apply. Motivos: ${dryRunResult.readiness.reasons.join(' | ')}`,
        );
      }

      if (!verifyPlanHash(dryRunResult.plan, providedPlanHash)) {
        throw new Error(
          `PLAN_HASH_MISMATCH: O hash fornecido (${providedPlanHash}) não coincide com o plano atual (${dryRunResult.plan.planHash}). A execução foi abortada por segurança.`,
        );
      }

      if (!this.client) {
        throw new Error('APPLY_BLOCKED: Client do Notion não inicializado. NOTION_API_KEY obrigatória.');
      }

      // Persist the approved immutable plan in SQLite BEFORE the first mutation
      this.journal.savePlan(
        dryRunResult.plan,
        dryRunResult.readiness.gitBranch ?? 'unknown',
      );

      const allowRealMutations = this.resolveAllowRealMutations(providedPlanHash);

      const executor = new SchemaApplyExecutor({
        client: this.client,
        journal: this.journal,
        plan: dryRunResult.plan,
        envVars: this.envVars,
        parentPageId: dryRunResult.preflight.parentPage.pageId,
        allowRealMutations,
      });

      const runId = `run_${Date.now()}`;
      const summary = await executor.executeDdlPlan(
        runId,
        dryRunResult.readiness.gitCommitSha ?? 'unknown',
        dryRunResult.readiness.gitBranch ?? 'unknown',
      );

      return {
        mode: 'apply',
        timestamp: new Date().toISOString(),
        planHash: providedPlanHash,
        runId,
        summary,
        mutationsExecuted: summary.verifiedCount,
        plan: dryRunResult.plan,
      };
    } else {
      // -----------------------------------------------------------------------
      // RESUME_APPLY: Carrega plano imutável do SQLite e valida contra baseline + passos do journal
      // -----------------------------------------------------------------------
      const plan = this.journal.getPlan(providedPlanHash);
      if (!plan) {
        throw new Error(`PLAN_NOT_FOUND: Plano com hash ${providedPlanHash} não encontrado no journal.`);
      }

      const gitState = this.resolveGitState();
      if (gitState.status !== 'WORKTREE_CLEAN') {
        throw new Error(
          `APPLY_BLOCKED: Estado git inválido para resume (${gitState.status}: ${gitState.unverifiedReason || gitState.dirtyFiles.join(', ')}).`,
        );
      }

      // Verificações obrigatórias de integridade e fingerprint
      if (!verifyPlanHash(plan, providedPlanHash)) {
        throw new Error(
          `RESUME_FINGERPRINT_MISMATCH: O hash do plano persistido não coincide com o planHash fornecido (${providedPlanHash}).`,
        );
      }

      const currentParentPageId = (this.envVars.NOTION_PARENT_PAGE_ID || '').trim();
      if (currentParentPageId !== plan.inputFingerprint.parentPageId) {
        throw new Error(
          `RESUME_FINGERPRINT_MISMATCH: Parent Page ID atual ('${currentParentPageId}') diverge do parentPageId do plano persistido ('${plan.inputFingerprint.parentPageId}').`,
        );
      }

      for (const [envKey, persistedDsId] of Object.entries(plan.inputFingerprint.dataSourceIds)) {
        const currentDsId = (this.envVars[envKey] || '').trim();
        if (currentDsId !== persistedDsId) {
          throw new Error(
            `RESUME_FINGERPRINT_MISMATCH: Data Source ID para '${envKey}' diverge (atual: '${currentDsId}', persistido: '${persistedDsId}').`,
          );
        }
      }

      if (!this.client) {
        throw new Error('APPLY_BLOCKED: Client do Notion não inicializado. NOTION_API_KEY obrigatória.');
      }

      // Inspect live state via preflight
      const preflight = await this.preflightValidator.runPreflight(this.envVars);
      if (this.testDoubles?.liveSnapshotOverride) {
        preflight.liveSnapshot = this.testDoubles.liveSnapshotOverride;
      }

      const isRecoveryRequested =
        this.mode === 'recovery' ||
        Boolean(this.envVars.NOTION_SCHEMA_RECOVERY_ENABLED);

      if (isRecoveryRequested) {
        const recoveryCheck = this.validateRecoveryEligibility(
          providedPlanHash,
          plan,
          gitState,
          preflight,
        );
        if (!recoveryCheck.eligible) {
          throw new Error(
            `RECOVERY_BLOCKED: Recovery não autorizado. Motivos:\n${recoveryCheck.reasons.join('\n')}`,
          );
        }
      } else if (gitState.commitSha !== plan.inputFingerprint.commitSha) {
        throw new Error(
          `RESUME_FINGERPRINT_MISMATCH: Commit SHA atual (${gitState.commitSha}) diverge do commit SHA do plano persistido (${plan.inputFingerprint.commitSha}).`,
        );
      }

      // Validate live state against: baseline + verified/applied steps in journal
      const recordedSteps = this.journal.getAllSteps(providedPlanHash);
      const completedSteps = recordedSteps.filter(
        (s) => s.status === 'VERIFIED' || s.status === 'NO_OP_VERIFIED',
      );
      const completedStepNumbers = new Set(completedSteps.map((s) => s.stepNumber));

      // Identify the first non-terminal step in the ordered plan: the frontier step
      const sortedPlanSteps = [...plan.schemaPlan.steps].sort((a, b) => a.stepNumber - b.stepNumber);
      const frontierStep = sortedPlanSteps.find((s) => !completedStepNumbers.has(s.stepNumber));

      // Uncertain-write recovery on frontier step ONLY
      if (frontierStep) {
        if (frontierStep.operation === 'CREATE_PROPERTY' && frontierStep.property) {
          const liveProp = preflight.liveSnapshot[frontierStep.targetDataSource.envKey]?.[frontierStep.property];
          if (liveProp) {
            const verif = StepStructuralVerifier.verifyCreateProperty(
              liveProp,
              frontierStep.sanitizedPayload,
              frontierStep.property,
            );
            if (!verif.valid || !verif.isCompatible) {
              throw new Error(
                `EXTERNAL_DRIFT_DETECTED: Pós-condição do frontier step ${frontierStep.stepNumber} ('${frontierStep.property}') não satisfeita (${verif.detail}).`,
              );
            }

            this.journal.recordStepNoOp(providedPlanHash, frontierStep.stepNumber, {
              operation: frontierStep.operation,
              targetDataSource: frontierStep.targetDataSource.name,
              targetDataSourceId: frontierStep.targetDataSource.id,
              propertyName: frontierStep.property,
              existingId: liveProp.id,
              metadata: {
                recoveryReason: 'RECOVERED_AFTER_UNCERTAIN_WRITE',
                recoveredFromUncertainWrite: true,
              },
            });
            completedStepNumbers.add(frontierStep.stepNumber);
          }
        } else if (frontierStep.operation === 'ALTER_SELECT_OPTIONS') {
          const statusProp = preflight.liveSnapshot.NOTION_DS_MONTHLY_OBLIGATIONS?.['Status'];
          if (statusProp) {
            const verif = StepStructuralVerifier.verifyAlterSelectOptions(statusProp, {
              requireAllTargetOptions: true,
            });
            if (verif.valid) {
              this.journal.recordStepNoOp(providedPlanHash, frontierStep.stepNumber, {
                operation: frontierStep.operation,
                targetDataSource: frontierStep.targetDataSource.name,
                targetDataSourceId: frontierStep.targetDataSource.id,
                propertyName: 'Status',
                metadata: {
                  recoveryReason: 'RECOVERED_AFTER_UNCERTAIN_WRITE',
                  recoveredFromUncertainWrite: true,
                },
              });
              completedStepNumbers.add(frontierStep.stepNumber);
            }
          }
        } else if (frontierStep.operation === 'CREATE_DUAL_RELATION') {
          const existingTxRel = preflight.liveSnapshot.NOTION_DS_TRANSACTIONS?.['Fatura Vinculada'];
          if (existingTxRel) {
            const resolvedBillsDsId = this.journal.getStepStatus(providedPlanHash, 53)?.createdId;
            if (resolvedBillsDsId && this.client) {
              let txDs: any;
              let billsDs: any;
              try {
                txDs = await this.client.dataSources.retrieve({ data_source_id: frontierStep.targetDataSource.id! });
                billsDs = await this.client.dataSources.retrieve({ data_source_id: resolvedBillsDsId });
              } catch (err: any) {
                throw new Error(
                  `EXTERNAL_DRIFT_DETECTED: Falha ao ler Data Sources para verificar dual relation do frontier: ${err?.message || String(err)}`,
                );
              }
              const verif = StepStructuralVerifier.verifyDualRelation(
                txDs,
                billsDs,
                resolvedBillsDsId,
                frontierStep.targetDataSource.id!,
              );
              if (!verif.valid) {
                throw new Error(
                  `EXTERNAL_DRIFT_DETECTED: Dual relation do frontier não atende pós-condição (${verif.detail}).`,
                );
              }
              this.journal.recordStepNoOp(providedPlanHash, frontierStep.stepNumber, {
                operation: frontierStep.operation,
                targetDataSource: frontierStep.targetDataSource.name,
                targetDataSourceId: frontierStep.targetDataSource.id,
                propertyName: 'Fatura Vinculada',
                metadata: {
                  recoveryReason: 'RECOVERED_AFTER_UNCERTAIN_WRITE',
                  recoveredFromUncertainWrite: true,
                },
              });
              completedStepNumbers.add(frontierStep.stepNumber);
            }
          }
        } else if (frontierStep.operation === 'CREATE_DATABASE') {
          const dbId = this.journal.getCreatedDatabaseId(providedPlanHash);
          if (dbId && this.client) {
            try {
              const db = await this.client.databases.retrieve({ database_id: dbId });
              const verif = StepStructuralVerifier.verifyDatabase(db, plan.inputFingerprint.parentPageId, providedPlanHash);
              if (verif.valid) {
                this.journal.recordStepNoOp(providedPlanHash, frontierStep.stepNumber, {
                  operation: frontierStep.operation,
                  targetDataSource: frontierStep.targetDataSource.name,
                  existingId: dbId,
                  metadata: {
                    recoveryReason: 'RECOVERED_AFTER_UNCERTAIN_WRITE',
                    recoveredFromUncertainWrite: true,
                  },
                });
                completedStepNumbers.add(frontierStep.stepNumber);
              }
            } catch {
              // Ignore retrieve failure
            }
          }
        } else if (frontierStep.operation === 'RESOLVE_DATA_SOURCE_ID') {
          const dbId = this.journal.getCreatedDatabaseId(providedPlanHash);
          if (dbId && this.client) {
            try {
              const db = (await this.client.databases.retrieve({ database_id: dbId })) as any;
              const verif = StepStructuralVerifier.verifyResolveDataSource(db);
              if (verif.valid && verif.dataSourceId) {
                const billsDs = (await this.client.dataSources.retrieve({ data_source_id: verif.dataSourceId })) as any;
                const createDbStep = plan.schemaPlan.steps.find((s) => s.operation === 'CREATE_DATABASE');
                const initialProps = createDbStep?.sanitizedPayload?.initial_data_source?.properties || {};
                const propsVerif = StepStructuralVerifier.verifyCardBillsInitialProperties(billsDs, initialProps, {
                  allowSyncedDualRelation: true,
                });
                if (propsVerif.valid) {
                  this.journal.recordStepNoOp(providedPlanHash, frontierStep.stepNumber, {
                    operation: frontierStep.operation,
                    targetDataSource: frontierStep.targetDataSource.name,
                    existingId: verif.dataSourceId,
                    metadata: {
                      recoveryReason: 'RECOVERED_AFTER_UNCERTAIN_WRITE',
                      recoveredFromUncertainWrite: true,
                    },
                  });
                  completedStepNumbers.add(frontierStep.stepNumber);
                }
              }
            } catch {
              // Ignore retrieve failure
            }
          }
        }
      }

      // Check posterior step modifications: any step with stepNumber >= activeFrontierNumber CANNOT already exist
      const activeFrontierNumber =
        sortedPlanSteps.find((s) => !completedStepNumbers.has(s.stepNumber))?.stepNumber ?? Infinity;

      for (const s of sortedPlanSteps) {
        if (s.stepNumber >= activeFrontierNumber) {
          if (s.operation === 'CREATE_PROPERTY' && s.property) {
            if (preflight.liveSnapshot[s.targetDataSource.envKey]?.[s.property]) {
              throw new Error(
                `EXTERNAL_DRIFT_DETECTED: Propriedade posterior ao frontier '${s.targetDataSource.envKey}.${s.property}' (Passo ${s.stepNumber}, frontier atual: ${activeFrontierNumber}) apareceu no Notion sem execução no journal.`,
              );
            }
          }
          if (s.operation === 'CREATE_DUAL_RELATION') {
            if (preflight.liveSnapshot.NOTION_DS_TRANSACTIONS?.['Fatura Vinculada']) {
              throw new Error(
                `EXTERNAL_DRIFT_DETECTED: Dual relation 'Fatura Vinculada' correspondente ao passo posterior 54 apareceu no Notion sem execução no journal.`,
              );
            }
          }
        }
      }

      // Check schema conformance against TARGET_CONTRACT
      const createdPropsByEnvKey = new Set<string>();
      let isStep1Completed = completedStepNumbers.has(1);

      for (const stepNum of completedStepNumbers) {
        const stepDef = plan.schemaPlan.steps.find((st) => st.stepNumber === stepNum);
        if (stepDef?.operation === 'CREATE_PROPERTY' && stepDef.property) {
          createdPropsByEnvKey.add(`${stepDef.targetDataSource.envKey}.${stepDef.property}`);
        }
      }

      const dataSourceIds: Record<string, string> = {};
      for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
        if (contract.isExisting) {
          dataSourceIds[contract.envKey] = this.envVars[contract.envKey]?.trim() || '';
        }
      }

      const schemaValidator = new NotionSchemaValidator(
        this.client ? this.envVars.NOTION_API_KEY : undefined,
        preflight.apiVersion,
      );

      const driftErrors: string[] = [];
      const actualMissing = new Set<string>();

      for (const [envKey, contract] of Object.entries(TARGET_CONTRACT)) {
        if (!contract.isExisting) continue;
        const actualProps = preflight.liveSnapshot[contract.envKey] ?? {};
        const diffs = schemaValidator.compareProperties(contract, actualProps, dataSourceIds);

        for (const diff of diffs) {
          if (diff.status === 'TYPE_MISMATCH') {
            driftErrors.push(`TYPE_MISMATCH em ${contract.defaultTitle}.${diff.notionProperty}`);
          }
          if (diff.status === 'RENAME_TYPE_MISMATCH') {
            driftErrors.push(`RENAME_TYPE_MISMATCH em ${contract.defaultTitle}.${diff.notionProperty}`);
          }
          if (diff.status === 'RENAME_STRUCTURAL_MISMATCH') {
            driftErrors.push(`RENAME_STRUCTURAL_MISMATCH em ${contract.defaultTitle}.${diff.notionProperty}`);
          }
          if (diff.status === 'HEURISTIC_SUGGESTION') {
            driftErrors.push(`HEURISTIC_SUGGESTION em ${contract.defaultTitle}.${diff.notionProperty}`);
          }
          if (diff.status === 'STRUCTURAL_MISMATCH') {
            if (isStep1Completed) {
              driftErrors.push(`STRUCTURAL_MISMATCH inesperado pós-Step 1 em ${contract.defaultTitle}.${diff.notionProperty}`);
            } else if (diff.notionProperty !== 'Status' || contract.envKey !== 'NOTION_DS_MONTHLY_OBLIGATIONS') {
              driftErrors.push(`STRUCTURAL_MISMATCH não homologado em ${contract.defaultTitle}.${diff.notionProperty}`);
            }
          }
          if (diff.status === 'MISSING') {
            const propKey = `${contract.envKey}.${diff.notionProperty}`;
            actualMissing.add(propKey);
            if (!HOMOLOGATED_MISSING_PROPERTIES.has(propKey)) {
              driftErrors.push(`UNEXPECTED_MISSING_PROPERTY: ${propKey}`);
            }
          }
        }
      }

      // Check regression: properties recorded as completed must NOT be missing
      for (const createdProp of createdPropsByEnvKey) {
        if (actualMissing.has(createdProp)) {
          driftErrors.push(`REGRESSION_DETECTED: Propriedade '${createdProp}' registrada como concluída no journal, mas ausente no Notion ao vivo.`);
        }
      }

      // Check external modifications: properties not yet created by journal must remain missing
      for (const homologatedProp of HOMOLOGATED_MISSING_PROPERTIES) {
        if (!createdPropsByEnvKey.has(homologatedProp) && !actualMissing.has(homologatedProp)) {
          driftErrors.push(`EXTERNAL_MODIFICATION_DETECTED: Propriedade '${homologatedProp}' apareceu no Notion sem execução registrada no journal.`);
        }
      }

      if (driftErrors.length > 0) {
        throw new Error(
          `EXTERNAL_DRIFT_DETECTED: Workspace divergiu do baseline esperado com passos aplicados (${driftErrors.join(' | ')}). Abortando resume.`,
        );
      }

      // Create pre-resume safety backup
      await this.backupManager.createEncryptedBackup();

      let allowRealMutations = false;
      if (isRecoveryRequested) {
        allowRealMutations = this.resolveAllowRecoveryMutations(providedPlanHash, gitState.commitSha);
      } else {
        allowRealMutations = this.resolveAllowRealMutations(providedPlanHash);
      }

      const executor = new SchemaApplyExecutor({
        client: this.client,
        journal: this.journal,
        plan,
        envVars: this.envVars,
        parentPageId: plan.inputFingerprint.parentPageId,
        allowRealMutations,
      });

      const runId = `resume_${Date.now()}`;
      const summary = await executor.executeDdlPlan(
        runId,
        gitState.commitSha ?? 'unknown',
        gitState.branch ?? 'unknown',
      );

      return {
        mode: 'apply',
        timestamp: new Date().toISOString(),
        planHash: providedPlanHash,
        runId,
        summary,
        mutationsExecuted: summary.verifiedCount,
        plan,
      };
    }
  }

  /**
   * Validates whether the environment, git repository, and live workspace qualify for RECOVERY_APPLY.
   */
  public validateRecoveryEligibility(
    providedPlanHash: string,
    plan: CompleteMigrationPlan,
    gitState: { status: WorktreeStatus; branch?: string; commitSha?: string; dirtyFiles: string[] },
    preflight: PreflightCheckResult,
  ): RecoveryEligibilityResult {
    const reasons: string[] = [];

    // 1. Plan Hash Match
    const planHashMatch =
      providedPlanHash === HOMOLOGATED_RECOVERY_PLAN_HASH &&
      plan.planHash === HOMOLOGATED_RECOVERY_PLAN_HASH;
    if (!planHashMatch) {
      reasons.push(
        `PLAN_HASH_MISMATCH: Recovery só é autorizado para o plano homologado '${HOMOLOGATED_RECOVERY_PLAN_HASH}' (fornecido: '${providedPlanHash}', persistido: '${plan.planHash}').`,
      );
    }

    // 2. Original Commit Match
    const originalCommitMatch = plan.inputFingerprint.commitSha === HOMOLOGATED_RECOVERY_FROM_COMMIT;
    if (!originalCommitMatch) {
      reasons.push(
        `ORIGINAL_COMMIT_MISMATCH: Commit original do plano persistido '${plan.inputFingerprint.commitSha}' diverge de '${HOMOLOGATED_RECOVERY_FROM_COMMIT}'.`,
      );
    }

    // 3. Parent Commit of current HEAD
    const parentSha = this.getGitParentCommitSha();
    const parentCommitMatch = parentSha === HOMOLOGATED_RECOVERY_FROM_COMMIT;
    if (!parentCommitMatch) {
      reasons.push(
        `PARENT_COMMIT_MISMATCH: HEAD atual (${gitState.commitSha}) não possui '${HOMOLOGATED_RECOVERY_FROM_COMMIT}' como parent direto (parent encontrado: '${parentSha || 'nenhum'}').`,
      );
    }

    // 4. Working tree clean
    const worktreeClean = gitState.status === 'WORKTREE_CLEAN';
    if (!worktreeClean) {
      reasons.push(
        `WORKTREE_DIRTY: Working tree não está limpa (${gitState.dirtyFiles.join(', ')}).`,
      );
    }

    // 5. Upstream in sync
    const upstreamInSync = this.verifyUpstreamInSync(gitState.commitSha);
    if (!upstreamInSync) {
      reasons.push(
        `UPSTREAM_OUT_OF_SYNC: HEAD local (${gitState.commitSha}) não está sincronizado com o upstream remoto.`,
      );
    }

    // 6. Parent page ID & Data Source IDs match
    const currentParentPageId = (this.envVars.NOTION_PARENT_PAGE_ID || '').trim();
    if (currentParentPageId !== plan.inputFingerprint.parentPageId) {
      reasons.push(
        `PARENT_PAGE_MISMATCH: Parent Page ID atual ('${currentParentPageId}') diverge do plano ('${plan.inputFingerprint.parentPageId}').`,
      );
    }

    for (const [envKey, persistedDsId] of Object.entries(plan.inputFingerprint.dataSourceIds)) {
      const currentDsId = (this.envVars[envKey] || '').trim();
      if (currentDsId !== persistedDsId) {
        reasons.push(
          `DATA_SOURCE_ID_MISMATCH: ${envKey} atual ('${currentDsId}') diverge do plano ('${persistedDsId}').`,
        );
      }
    }

    // 7. Journal state check: Steps 1..10 VERIFIED, Step 11 PENDING/FAILED, no steps > 11 applied
    const recordedSteps = this.journal.getAllSteps(providedPlanHash);
    let journalStateValid = true;

    for (let s = 1; s <= 10; s++) {
      const stepEntry = recordedSteps.find((st) => st.stepNumber === s);
      if (!stepEntry || (stepEntry.status !== 'VERIFIED' && stepEntry.status !== 'NO_OP_VERIFIED')) {
        journalStateValid = false;
        reasons.push(`JOURNAL_INVALID: Passo ${s} não está como VERIFIED no journal.`);
      }
    }

    const step11Entry = recordedSteps.find((st) => st.stepNumber === 11);
    if (!step11Entry || (step11Entry.status !== 'PENDING' && step11Entry.status !== 'FAILED')) {
      journalStateValid = false;
      reasons.push(`JOURNAL_INVALID: Passo 11 deve estar como PENDING ou FAILED no journal.`);
    }

    for (const st of recordedSteps) {
      if (st.stepNumber > 11 && (st.status === 'VERIFIED' || st.status === 'NO_OP_VERIFIED' || st.status === 'APPLIED')) {
        journalStateValid = false;
        reasons.push(`JOURNAL_INVALID: Passo ${st.stepNumber} (> 11) já foi aplicado no journal.`);
      }
    }

    // 8. Live state matches post-Step 10 projection
    let liveStateMatchesProjection = true;
    const liveTxProps = preflight.liveSnapshot.NOTION_DS_TRANSACTIONS ?? {};
    const liveAccountsProps = preflight.liveSnapshot.NOTION_DS_ACCOUNTS ?? {};
    const liveObligationsProps = preflight.liveSnapshot.NOTION_DS_MONTHLY_OBLIGATIONS ?? {};

    // Steps 1..10 present
    if (!liveObligationsProps['Status']) {
      liveStateMatchesProjection = false;
      reasons.push('LIVE_PROJECTION_MISMATCH: Obrigações Mensais.Status ausente ao vivo.');
    }
    const accountsExpected = [
      'Limite Operacional Usado',
      'Limite Usado da Fonte (Bruto)',
      'Dia de Fechamento',
      'Dia de Vencimento',
    ];
    for (const p of accountsExpected) {
      if (!liveAccountsProps[p]) {
        liveStateMatchesProjection = false;
        reasons.push(`LIVE_PROJECTION_MISMATCH: Contas.${p} ausente ao vivo.`);
      }
    }

    const txExpected = [
      'Hash Canônico',
      'Valor Bruto da Fonte',
      'Efeito Orçamentário',
      'Propósito de Alocação',
      'Contribuição Meta Poupança',
    ];
    for (const p of txExpected) {
      if (!liveTxProps[p]) {
        liveStateMatchesProjection = false;
        reasons.push(`LIVE_PROJECTION_MISMATCH: Transações.${p} ausente ao vivo.`);
      }
    }

    // Step 11 MUST be absent live
    if (liveTxProps['Conta Destino']) {
      liveStateMatchesProjection = false;
      reasons.push('LIVE_PROJECTION_MISMATCH: Transações.Conta Destino já existe ao vivo no Notion.');
    }

    // Dual relation MUST be absent live
    if (liveTxProps['Fatura Vinculada']) {
      liveStateMatchesProjection = false;
      reasons.push('LIVE_PROJECTION_MISMATCH: Transações.Fatura Vinculada já existe ao vivo no Notion.');
    }

    // Database Faturas MUST NOT exist in journal as created or live
    if (this.journal.getCreatedDatabaseId(providedPlanHash)) {
      liveStateMatchesProjection = false;
      reasons.push('LIVE_PROJECTION_MISMATCH: Base Faturas já foi criada no journal.');
    }

    // 9. Gates configuration
    const recoveryToken = this.envVars.NOTION_SCHEMA_RECOVERY_ENABLED?.trim();
    const recoveryPlanHash = this.envVars.NOTION_SCHEMA_RECOVERY_PLAN_HASH?.trim();
    const recoveryFromCommit = this.envVars.NOTION_SCHEMA_RECOVERY_FROM_COMMIT?.trim();
    const recoveryPatchSha = this.envVars.NOTION_SCHEMA_RECOVERY_PATCH_SHA?.trim();

    const patchCommitConfirmed = Boolean(
      recoveryPatchSha && gitState.commitSha && recoveryPatchSha === gitState.commitSha,
    );
    if (!patchCommitConfirmed) {
      reasons.push(
        `PATCH_SHA_MISMATCH: NOTION_SCHEMA_RECOVERY_PATCH_SHA ('${recoveryPatchSha || 'ausente'}') não coincide com HEAD atual ('${gitState.commitSha}').`,
      );
    }

    const gatesConfigured =
      recoveryToken === 'I_UNDERSTAND_RECOVERY_ONLY' &&
      recoveryPlanHash === HOMOLOGATED_RECOVERY_PLAN_HASH &&
      recoveryFromCommit === HOMOLOGATED_RECOVERY_FROM_COMMIT &&
      patchCommitConfirmed;

    if (!gatesConfigured) {
      if (recoveryToken !== 'I_UNDERSTAND_RECOVERY_ONLY') {
        reasons.push('RECOVERY_GATE_INVALID: NOTION_SCHEMA_RECOVERY_ENABLED deve ser "I_UNDERSTAND_RECOVERY_ONLY".');
      }
      if (recoveryPlanHash !== HOMOLOGATED_RECOVERY_PLAN_HASH) {
        reasons.push(`RECOVERY_GATE_INVALID: NOTION_SCHEMA_RECOVERY_PLAN_HASH deve ser "${HOMOLOGATED_RECOVERY_PLAN_HASH}".`);
      }
      if (recoveryFromCommit !== HOMOLOGATED_RECOVERY_FROM_COMMIT) {
        reasons.push(`RECOVERY_GATE_INVALID: NOTION_SCHEMA_RECOVERY_FROM_COMMIT deve ser "${HOMOLOGATED_RECOVERY_FROM_COMMIT}".`);
      }
    }

    const eligible =
      planHashMatch &&
      originalCommitMatch &&
      parentCommitMatch &&
      worktreeClean &&
      upstreamInSync &&
      journalStateValid &&
      liveStateMatchesProjection &&
      patchCommitConfirmed &&
      gatesConfigured;

    return {
      eligible,
      reasons,
      planHashMatch,
      originalCommitMatch,
      parentCommitMatch,
      patchCommitConfirmed,
      worktreeClean,
      upstreamInSync,
      journalStateValid,
      liveStateMatchesProjection,
      gatesConfigured,
    };
  }

  public async runRecoveryPreflight(providedPlanHash?: string): Promise<RecoveryPreflightReport> {
    const hash = providedPlanHash ?? HOMOLOGATED_RECOVERY_PLAN_HASH;
    const plan = this.journal.getPlan(hash);
    if (!plan) {
      throw new Error(`PLAN_NOT_FOUND: Plano com hash ${hash} não encontrado no journal.`);
    }

    const gitState = this.resolveGitState();
    const parentSha = this.getGitParentCommitSha();

    const preflight = await this.preflightValidator.runPreflight(this.envVars);
    if (this.testDoubles?.liveSnapshotOverride) {
      preflight.liveSnapshot = this.testDoubles.liveSnapshotOverride;
    }

    const eligibility = this.validateRecoveryEligibility(hash, plan, gitState, preflight);

    const recordedSteps = this.journal.getAllSteps(hash);
    const completedSteps = recordedSteps.filter(
      (s) => s.status === 'VERIFIED' || s.status === 'NO_OP_VERIFIED',
    );
    const frontierStep = plan.schemaPlan.steps.find((s) => !completedSteps.some((c) => c.stepNumber === s.stepNumber));

    return {
      mode: 'recovery-preflight',
      timestamp: new Date().toISOString(),
      planHash: hash,
      originalCommitSha: plan.inputFingerprint.commitSha,
      currentCommitSha: gitState.commitSha ?? 'unknown',
      parentCommitSha: parentSha,
      eligibility,
      journalStepsCompleted: completedSteps.length,
      frontierStepNumber: frontierStep?.stepNumber ?? 11,
      frontierStepProperty: frontierStep?.property,
      preflight,
      mutationsExecuted: 0,
    };
  }

  /**
   * Formats a comprehensive dry-run or apply report for terminal display.
   */
  public formatReport(report: MigrationReport): string {
    if (report.mode === 'recovery-preflight') {
      const lines: string[] = [];
      lines.push('═══════════════════════════════════════════════════════════════════════════════');
      lines.push('  RELATÓRIO DO NOTION MIGRATION RUNNER — RECOVERY PREFLIGHT (READ-ONLY)');
      lines.push('═══════════════════════════════════════════════════════════════════════════════\n');
      lines.push('Modo de Execução: RECOVERY-PREFLIGHT (Estritamente Read-Only)');
      lines.push(`Timestamp: ${report.timestamp}`);
      lines.push(`Plan Hash Alvo: ${report.planHash}`);
      lines.push(`Commit Original Homologado: ${report.originalCommitSha}`);
      lines.push(`Commit Atual (HEAD): ${report.currentCommitSha}`);
      lines.push(`Parent Commit (HEAD^): ${report.parentCommitSha ?? 'não detectado'}\n`);

      const elig = report.eligibility;
      lines.push('Status da Elegibilidade para Recovery:');
      lines.push(`  • Plan Hash Homologado: ${elig.planHashMatch ? '✅ VÁLIDO' : '❌ INVÁLIDO'}`);
      lines.push(`  • Commit Original Homologado: ${elig.originalCommitMatch ? '✅ VÁLIDO' : '❌ INVÁLIDO'}`);
      lines.push(`  • Parent Commit Direto (HEAD^): ${elig.parentCommitMatch ? '✅ VÁLIDO' : '❌ INVÁLIDO'}`);
      lines.push(`  • Working Tree Limpa: ${elig.worktreeClean ? '✅ LIMPA' : '❌ DIRTY'}`);
      lines.push(`  • Upstream Remoto em Sincronia: ${elig.upstreamInSync ? '✅ EM SINC' : '❌ DIVERGENTE'}`);
      lines.push(`  • Integridade do Journal (Passos 1..10 OK, 11 PENDING): ${elig.journalStateValid ? '✅ VÁLIDO' : '❌ INVÁLIDO'}`);
      lines.push(`  • Projeção do Estado Live do Notion: ${elig.liveStateMatchesProjection ? '✅ CONFORME PÓS-STEP 10' : '❌ DIVERGENTE'}`);
      lines.push(`  • Confirmação do Patch SHA: ${elig.patchCommitConfirmed ? '✅ CONFIRMADO' : '⚠️ NÃO CONFIRMADO'}`);
      lines.push(`  • Gates Operacionais de Recovery: ${elig.gatesConfigured ? '🟢 HABILITADOS' : '🔒 DESABILITADOS (Segurança Ativa)'}\n`);

      lines.push('Diagnóstico de Execução:');
      lines.push(`  • Passos Concluídos no Journal: ${report.journalStepsCompleted}/54`);
      lines.push(`  • Próximo Passo a Executar (Frontier): Passo ${report.frontierStepNumber} [${report.frontierStepProperty ?? 'desconhecido'}]`);
      lines.push(`  • Mutações no Notion: 0 (Estritamente Read-Only)\n`);

      if (elig.reasons.length > 0) {
        lines.push('Observações / Motivos de Bloqueio Operacional:');
        for (const reason of elig.reasons) {
          lines.push(`  - ${reason}`);
        }
        lines.push('');
      }

      lines.push('═══════════════════════════════════════════════════════════════════════════════');
      lines.push('  FIM DO RELATÓRIO — NENHUMA ALTERAÇÃO REALIZADA NO WORKSPACE DO NOTION');
      lines.push('═══════════════════════════════════════════════════════════════════════════════');
      return lines.join('\n');
    }

    if (report.mode === 'apply') {
      const lines: string[] = [];
      lines.push('═══════════════════════════════════════════════════════════════════════════════');
      lines.push('  RELATÓRIO DO NOTION MIGRATION RUNNER — SCHEMA APPLY EXECUTOR');
      lines.push('═══════════════════════════════════════════════════════════════════════════════\n');
      lines.push(`Modo de Execução: APPLY`);
      lines.push(`Timestamp: ${report.timestamp}`);
      lines.push(`Run ID: ${report.runId}`);
      lines.push(`Plan Hash: ${report.planHash}`);
      lines.push(`Total de Passos: ${report.summary.totalSteps}`);
      lines.push(`Passos Verificados (VERIFIED): ${report.summary.verifiedCount}`);
      lines.push(`Passos Idempotentes (NO_OP_VERIFIED): ${report.summary.noOpCount}`);
      lines.push(`Mutations Executadas no Notion: ${report.mutationsExecuted}`);
      lines.push('\n═══════════════════════════════════════════════════════════════════════════════');
      lines.push('  EXECUÇÃO DDL CONCLUÍDA COM SUCESSO NO NOTION');
      lines.push('═══════════════════════════════════════════════════════════════════════════════');
      return lines.join('\n');
    }

    const lines: string[] = [];
    lines.push('═══════════════════════════════════════════════════════════════════════════════');
    lines.push('  RELATÓRIO DO NOTION MIGRATION RUNNER — DRY-RUN (READ-ONLY)');
    lines.push('═══════════════════════════════════════════════════════════════════════════════\n');

    lines.push(`Modo de Execução: ${report.mode.toUpperCase()}`);
    lines.push(`Timestamp: ${report.timestamp}`);
    lines.push(`Mutations no Notion: ${report.mutationsExecuted} (Estritamente Read-Only)`);
    lines.push(
      `Working Tree / Git: ${
        report.readiness.worktreeStatus === 'WORKTREE_CLEAN'
          ? `✅ LIMPO (${report.readiness.gitBranch ?? 'branch'} @ ${report.readiness.gitCommitSha?.slice(0, 7) ?? 'sha'})`
          : report.readiness.worktreeStatus === 'WORKTREE_DIRTY'
          ? `❌ SUJO (WORKTREE_DIRTY — ${report.readiness.dirtyFiles?.join(', ') ?? 'arquivos alterados'})`
          : `❌ NÃO VERIFICADO (GIT_STATE_UNVERIFIED)`
      }`,
    );
    lines.push(`Dry-Run Status: ${report.readiness.dryRunValid ? '✅ VÁLIDO' : '❌ INVÁLIDO'}`);
    lines.push(
      `Apply Readiness: ${
        report.readiness.applyReady ? '🟢 PRONTO PARA APPLY' : '🟡 BLOQUEADO PARA APPLY (Aguardando Pré-requisitos)'
      }`,
    );

    if (report.readiness.schemaConformance) {
      const sc = report.readiness.schemaConformance;
      lines.push(
        `Schema Conformance: ${
          sc.isConformant ? '✅ APROVADO (Baseline Homologado Fase 1)' : '❌ REPROVADO (Divergência Estrutural)'
        }`,
      );
      lines.push(`  • TYPE_MISMATCH: ${sc.typeMismatches} (esperado: 0)`);
      lines.push(`  • RENAME_TYPE_MISMATCH: ${sc.renameTypeMismatches} (esperado: 0)`);
      lines.push(`  • RENAME_STRUCTURAL_MISMATCH: ${sc.renameStructuralMismatches} (esperado: 0)`);
      lines.push(`  • HEURISTIC_SUGGESTION: ${sc.heuristicSuggestions} (esperado: 0)`);
      lines.push(
        `  • STRUCTURAL_MISMATCH: ${sc.structuralMismatches} (esperado: 1 -> ${sc.structuralMismatchProperty ?? 'N/A'})`,
      );
      lines.push(`  • MISSING (Propriedades a criar): ${sc.missingCount} (esperado: ${HOMOLOGATED_MISSING_PROPERTIES.size})`);
      if (sc.unexpectedMissingProperties.length > 0) {
        lines.push(`  • UNEXPECTED MISSING: ${sc.unexpectedMissingProperties.join(', ')}`);
      }
      if (sc.expectedMissingButPresent.length > 0) {
        lines.push(`  • EXPECTED MISSING BUT PRESENT: ${sc.expectedMissingButPresent.join(', ')}`);
      }
    }

    if (report.readiness.reasons.length > 0) {
      lines.push('\nPendências para Apply:');
      report.readiness.reasons.forEach((r) => lines.push(`  • ${r}`));
    }

    lines.push(`\nDeterministic Plan Hash (SHA-256):\n  --> ${report.plan.planHash}\n`);

    lines.push('───────────────────────────────────────────────────────────────────────────────');
    lines.push('1. INPUT FINGERPRINT');
    lines.push('───────────────────────────────────────────────────────────────────────────────');
    lines.push(`Git Commit SHA: ${report.plan.inputFingerprint.commitSha}`);
    lines.push(`Notion API Version: ${report.plan.inputFingerprint.notionApiVersion}`);
    lines.push(`Parent Page ID: ${report.plan.inputFingerprint.parentPageId || '(não configurado)'}`);
    lines.push(`Live Structural Snapshot SHA-256: ${report.plan.inputFingerprint.liveSnapshotSha256}`);

    lines.push('\n───────────────────────────────────────────────────────────────────────────────');
    lines.push('2. PREFLIGHT READ-ONLY CHECK');
    lines.push('───────────────────────────────────────────────────────────────────────────────');
    lines.push(`Permissões Efetivas: ${report.preflight.permissions}`);
    lines.push(
      `Data Sources Verificados: ${
        report.preflight.dataSources.filter((d) => d.status === 'VERIFIED').length
      }/12 existentes`,
    );
    lines.push(`Página-mãe (Container): ${report.preflight.parentPage.status} (${report.preflight.parentPage.note})`);
    lines.push(`Relações Validadas: ${report.preflight.relationTargets.length} mapeamentos verificados`);

    if (report.preflight.warnings.length > 0) {
      lines.push('\nAvisos do Preflight:');
      report.preflight.warnings.forEach((w) => lines.push(`  ⚠️  ${w}`));
    }
    if (report.preflight.errors.length > 0) {
      lines.push('\nErros do Preflight:');
      report.preflight.errors.forEach((e) => lines.push(`  ❌ ${e}`));
    }

    lines.push('\n───────────────────────────────────────────────────────────────────────────────');
    lines.push('3. SNAPSHOT PRÉ-MIGRAÇÃO (AES-256-GCM + RESTAURAÇÃO SQLite)');
    lines.push('───────────────────────────────────────────────────────────────────────────────');
    lines.push(`Arquivo Cifrado: ${report.backup.backupPath}`);
    lines.push(`Manifesto Sidecar: ${report.backup.manifestPath}`);
    lines.push(`Escopo do Snapshot: ${report.backup.localDatabaseScope}`);
    lines.push(`Nota de Reconciliação: ${report.backup.notionWorkspaceReconciliationNote}`);
    lines.push(`Tamanho Original: ${report.backup.originalSize} bytes`);
    lines.push(`Tamanho Cifrado: ${report.backup.encryptedSize} bytes`);
    lines.push(`SHA-256 SQLite Original: ${report.backup.originalDbSha256}`);
    lines.push(`SHA-256 Arquivo Cifrado: ${report.backup.encryptedHashSha256}`);
    lines.push(
      `Teste de Restauração SQLite: ${
        report.backup.verifiedRestoration ? '✅ APROVADO (Integridade Confirmada)' : '❌ FALHOU'
      }\n`,
    );

    lines.push('───────────────────────────────────────────────────────────────────────────────');
    lines.push('4. SCHEMA PLAN (DDL DO NOTION — 54 PASSOS DETERMINÍSTICOS)');
    lines.push('───────────────────────────────────────────────────────────────────────────────');
    const summary = report.plan.schemaPlan.summary;
    lines.push(`Total de Operações Determinísticas: ${summary.totalSteps}`);
    lines.push(`  • ALTER_SELECT_OPTIONS: ${summary.alterOptionsCount} (Obrigações.Status via select: preserva IDs + adiciona 2)`);
    lines.push(`  • CREATE_PROPERTY: ${summary.createPropertyCount} (50 novas propriedades nas 12 bases)`);
    lines.push(`  • CREATE_DATABASE: ${summary.createDatabaseCount} (Faturas / Ciclos de Cartão via initial_data_source)`);
    lines.push(`  • RESOLVE_DATA_SOURCE_ID: ${summary.resolveDataSourceCount} (Resolução de ID em runtime)`);
    lines.push(`  • CREATE_DUAL_RELATION: ${summary.dualRelationCount} (Dual relation Transações.Fatura Vinculada <-> Faturas.Lançamentos do Ciclo)\n`);

    lines.push('Operações Ordenadas do Plano DDL:');
    for (const step of report.plan.schemaPlan.steps) {
      const propText = step.property ? ` [Propriedade: '${step.property}']` : '';
      const depText = step.dependsOnStep ? ` (Depende do Passo ${step.dependsOnStep})` : '';
      lines.push(`  [Passo ${step.stepNumber.toString().padStart(2, '0')}] ${step.operation} -> ${step.targetDataSource.name}${propText}${depText}`);
      lines.push(`     Risco: ${step.risk} | Precondição: ${step.precondition}`);
    }

    lines.push('\n───────────────────────────────────────────────────────────────────────────────');
    lines.push('5. DATA BACKFILL PLAN (DML IDEMPOTENTE)');
    lines.push('───────────────────────────────────────────────────────────────────────────────');
    lines.push(`Total de Pipelines Planejados: ${report.plan.backfillPlan.totalPipelines}`);
    for (const pipeline of report.plan.backfillPlan.pipelines) {
      lines.push(`  • [${pipeline.id}] ${pipeline.name}`);
      lines.push(`     Alvo: ${pipeline.targetDataSource.name} | Modo: ${pipeline.mode}`);
      lines.push(`     Estratégia Leitura: ${pipeline.readStrategy}`);
      lines.push(`     Estratégia Transformação: ${pipeline.transformStrategy}`);
      lines.push(`     Estratégia Escrita: ${pipeline.writeStrategy}`);
      lines.push(`     Verificação: ${pipeline.verificationStrategy}\n`);
    }

    lines.push('═══════════════════════════════════════════════════════════════════════════════');
    lines.push('  FIM DO RELATÓRIO — NENHUMA ALTERAÇÃO REALIZADA NO WORKSPACE DO NOTION');
    lines.push('═══════════════════════════════════════════════════════════════════════════════');

    return lines.join('\n');
  }
}

export class TestableMigrationRunner extends MigrationRunner {
  constructor(options: MigrationRunnerOptions = {}, testDoubles: TestDoubles = {}) {
    super(options);
    this.testDoubles = testDoubles;
  }

  public setClient(client: any): void {
    this.client = client;
    this.preflightValidator = new PreflightValidator(this.client, '2026-03-11');
  }

  public setTestDoubles(testDoubles: TestDoubles): void {
    this.testDoubles = testDoubles;
  }

  public setTestDoublesForTesting(testDoubles: TestDoubles): void {
    this.testDoubles = testDoubles;
  }

  public getJournalInstance(): MigrationJournal {
    return this.journal;
  }

  public getPreflightValidator(): PreflightValidator {
    return this.preflightValidator;
  }

  public getBackupManager(): FinancialBackupManager {
    return this.backupManager;
  }

  public getClient(): Client | undefined {
    return this.client;
  }
}
