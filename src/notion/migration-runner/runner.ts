import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { Client } from '@notionhq/client';
import { TARGET_CONTRACT, HOMOLOGATED_MISSING_PROPERTIES } from '../../domain/schema-contract';
import { NotionSchemaValidator } from '../schema-validator';
import {
  CompleteMigrationPlan,
  DryRunReport,
  InputFingerprint,
  MigrationReadiness,
  WorktreeStatus,
  SchemaConformanceResult,
} from './types';
import { SchemaPlanner } from './schema-planner';
import { BackfillPlanner } from './backfill-planner';
import { computePlanHash, verifyPlanHash, canonicalizeJson } from './hasher';
import { PreflightValidator } from './preflight';
import { FinancialBackupManager } from './backup';
import { MigrationJournal } from './journal';
import { SchemaApplyExecutor } from './schema-executor';

export interface MigrationRunnerOptions {
  mode?: 'dry-run' | 'apply';
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
  simulateGitFailure?: boolean;
  simulateRemoteTrackingMismatch?: boolean;
}

export class MigrationRunner {
  protected mode: 'dry-run' | 'apply';
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
   * Execution dispatcher.
   */
  public async execute(providedPlanHash?: string): Promise<DryRunReport> {
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

      const executor = new SchemaApplyExecutor({
        client: this.client,
        journal: this.journal,
        plan: dryRunResult.plan,
        envVars: this.envVars,
        parentPageId: dryRunResult.preflight.parentPage.pageId,
        allowRealMutations: false,
      });

      const runId = `run_${Date.now()}`;
      await executor.executeDdlPlan(
        runId,
        dryRunResult.readiness.gitCommitSha ?? 'unknown',
        dryRunResult.readiness.gitBranch ?? 'unknown',
      );

      throw new Error(
        'MUTAÇÕES REAIS BLOQUEADAS: A execução física (apply) de modificações no Notion permanece desabilitada nesta fase. Conclua a validação do runner e o gate de aprovação antes de habilitar mutations.',
      );
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

      if (!this.client) {
        throw new Error('APPLY_BLOCKED: Client do Notion não inicializado. NOTION_API_KEY obrigatória.');
      }

      // Inspect live state via preflight
      const preflight = await this.preflightValidator.runPreflight(this.envVars);
      if (this.testDoubles?.liveSnapshotOverride) {
        preflight.liveSnapshot = this.testDoubles.liveSnapshotOverride;
      }

      // Validate live state against: baseline + verified/applied steps in journal
      const recordedSteps = this.journal.getAllSteps(providedPlanHash);
      const completedSteps = recordedSteps.filter(
        (s) => s.status === 'VERIFIED' || s.status === 'NO_OP_VERIFIED' || s.status === 'APPLIED',
      );
      const createdPropsByEnvKey = new Set<string>();
      let isStep1Completed = false;

      for (const s of completedSteps) {
        if (s.stepNumber === 1 || s.operation === 'ALTER_SELECT_OPTIONS') {
          isStep1Completed = true;
        }
        if (s.operation === 'CREATE_PROPERTY' && s.propertyName) {
          const stepDef = plan.schemaPlan.steps.find((st) => st.stepNumber === s.stepNumber);
          const envKey = stepDef?.targetDataSource.envKey;
          if (envKey) {
            createdPropsByEnvKey.add(`${envKey}.${s.propertyName}`);
          }
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

      const executor = new SchemaApplyExecutor({
        client: this.client,
        journal: this.journal,
        plan,
        envVars: this.envVars,
        parentPageId: plan.inputFingerprint.parentPageId,
        allowRealMutations: false,
      });

      const runId = `resume_${Date.now()}`;
      await executor.executeDdlPlan(
        runId,
        gitState.commitSha ?? 'unknown',
        gitState.branch ?? 'unknown',
      );

      throw new Error(
        'MUTAÇÕES REAIS BLOQUEADAS: A execução física (apply) de modificações no Notion permanece desabilitada nesta fase. Conclua a validação do runner e o gate de aprovação antes de habilitar mutations.',
      );
    }
  }

  /**
   * Formats a comprehensive dry-run report for terminal display.
   */
  public formatReport(report: DryRunReport): string {
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
