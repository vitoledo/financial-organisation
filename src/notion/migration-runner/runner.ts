import { execSync } from 'child_process';
import { Client } from '@notionhq/client';
import { TARGET_CONTRACT } from '../../domain/schema-contract';
import {
  CompleteMigrationPlan,
  DryRunReport,
  InputFingerprint,
  MigrationReadiness,
} from './types';
import { SchemaPlanner } from './schema-planner';
import { BackfillPlanner } from './backfill-planner';
import { computePlanHash, verifyPlanHash } from './hasher';
import { PreflightValidator } from './preflight';
import { FinancialBackupManager } from './backup';

export interface MigrationRunnerOptions {
  mode?: 'dry-run' | 'apply';
  planHash?: string;
  backupKey?: string;
  dbPath?: string;
  backupDir?: string;
  envVars?: Record<string, string | undefined>;
  notionApiKey?: string;
  allowEmptyDbForBackup?: boolean;
}

export class MigrationRunner {
  private mode: 'dry-run' | 'apply';
  private envVars: Record<string, string | undefined>;
  private client?: Client;
  private preflightValidator: PreflightValidator;
  private backfillPlanner: BackfillPlanner;
  private backupManager: FinancialBackupManager;

  constructor(options: MigrationRunnerOptions = {}) {
    this.mode = options.mode ?? 'dry-run';
    this.envVars = options.envVars ?? process.env;

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
  }

  /**
   * Resolves the current git commit SHA.
   */
  private resolveCommitSha(): string {
    try {
      return execSync('git rev-parse HEAD', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return this.envVars.GIT_COMMIT_SHA?.trim() || 'unknown';
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

    // 1. Read-only Preflight Check
    const preflight = await this.preflightValidator.runPreflight(this.envVars);

    // 2. Generate Deterministic Schema Plan (DDL) directly from live preflight snapshot
    const schemaPlanner = new SchemaPlanner({
      envVars: this.envVars,
      liveSnapshot: preflight.liveSnapshot,
      parentPageId: preflight.parentPage.pageId,
    });
    const schemaPlan = schemaPlanner.generatePlan();

    // 3. Generate Deterministic Backfill Plan (DML)
    const backfillPlan = this.backfillPlanner.generatePlan();

    // 4. Build Input Fingerprint
    const dataSourceIds: Record<string, string> = {};
    for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
      if (contract.isExisting) {
        dataSourceIds[contract.envKey] = this.envVars[contract.envKey]?.trim() || '';
      }
    }

    const inputFingerprint: InputFingerprint = {
      commitSha: this.resolveCommitSha(),
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

    // 7. Evaluate Readiness (dryRunValid vs applyReady)
    const reasons: string[] = [];
    const verifiedDsCount = preflight.dataSources.filter((d) => d.status === 'VERIFIED').length;
    const parentConfigured = preflight.parentPage.status === 'CONFIGURED' && preflight.parentPage.accessible;

    const dryRunValid =
      backupResult.verifiedRestoration &&
      schemaPlan.steps.length > 0 &&
      backfillPlan.pipelines.length > 0;

    let applyReady = dryRunValid && preflight.errors.length === 0;

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

    // Gate: Block actual mutations in this phase as per instructions
    throw new Error(
      'MUTAÇÕES REAIS BLOQUEADAS: A execução física (apply) de modificações no Notion permanece desabilitada nesta fase. Conclua a validação do runner e o gate de aprovação antes de habilitar mutations.',
    );
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
    lines.push(`Dry-Run Status: ${report.readiness.dryRunValid ? '✅ VÁLIDO' : '❌ INVÁLIDO'}`);
    lines.push(
      `Apply Readiness: ${
        report.readiness.applyReady ? '🟢 PRONTO PARA APPLY' : '🟡 BLOQUEADO PARA APPLY (Aguardando Pré-requisitos)'
      }`,
    );

    if (report.readiness.reasons.length > 0) {
      lines.push('Pendências para Apply:');
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
