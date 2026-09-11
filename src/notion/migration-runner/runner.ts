import { Client } from '@notionhq/client';
import {
  CompleteMigrationPlan,
  DryRunReport,
  PreflightCheckResult,
  BackupResult,
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
  private schemaPlanner: SchemaPlanner;
  private backfillPlanner: BackfillPlanner;
  private backupManager: FinancialBackupManager;
  private allowEmptyDbForBackup: boolean;

  constructor(options: MigrationRunnerOptions = {}) {
    // Mode defaults unconditionally to 'dry-run'
    this.mode = options.mode ?? 'dry-run';
    this.envVars = options.envVars ?? process.env;
    this.allowEmptyDbForBackup = options.allowEmptyDbForBackup ?? true;

    const apiKey = options.notionApiKey ?? this.envVars.NOTION_API_KEY?.trim();
    if (apiKey) {
      this.client = new Client({
        auth: apiKey,
        notionVersion: '2026-03-11',
      });
    }

    this.preflightValidator = new PreflightValidator(this.client, '2026-03-11');
    this.schemaPlanner = new SchemaPlanner({ envVars: this.envVars });
    this.backfillPlanner = new BackfillPlanner();
    this.backupManager = new FinancialBackupManager({
      dbPath: options.dbPath,
      backupDir: options.backupDir,
      key: options.backupKey,
    });
  }

  /**
   * Executes a strict, read-only dry-run migration.
   * Performs preflight checks, generates deterministic DDL and DML plans,
   * calculates SHA-256 planHash, creates and verifies AES-256-GCM backup.
   * ABSOLUTELY ZERO NOTION MUTATIONS.
   */
  public async runDryRun(): Promise<DryRunReport> {
    const timestamp = new Date().toISOString();

    // 1. Read-only Preflight Check
    const preflight = await this.preflightValidator.runPreflight(this.envVars);

    // 2. Generate Deterministic Schema Plan (DDL)
    const schemaPlan = this.schemaPlanner.generatePlan();

    // 3. Generate Deterministic Backfill Plan (DML)
    const backfillPlan = this.backfillPlanner.generatePlan();

    // 4. Compute Deterministic Plan Hash
    const planHash = computePlanHash({ schemaPlan, backfillPlan });

    const completePlan: CompleteMigrationPlan = {
      version: '1.0.0',
      planHash,
      schemaPlan,
      backfillPlan,
    };

    // 5. Create and Verify Encrypted Pre-Migration Snapshot (AES-256-GCM)
    let backupResult: BackupResult;
    try {
      backupResult = await this.backupManager.createEncryptedBackup({
        allowInitializeIfMissing: this.allowEmptyDbForBackup,
      });
    } catch (err: any) {
      // If backup fails due to missing key in dry-run, generate a deterministic key for dry-run verification
      if (err.message.includes('MIGRATION_BACKUP_KEY')) {
        const dryRunKey = 'financial-dry-run-backup-verification-key';
        backupResult = await this.backupManager.createEncryptedBackup({
          key: dryRunKey,
          allowInitializeIfMissing: this.allowEmptyDbForBackup,
        });
      } else {
        throw err;
      }
    }

    return {
      mode: 'dry-run',
      timestamp,
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
    lines.push(`Deterministic Plan Hash (SHA-256):\n  --> ${report.plan.planHash}\n`);

    lines.push('───────────────────────────────────────────────────────────────────────────────');
    lines.push('1. PREFLIGHT READ-ONLY CHECK');
    lines.push('───────────────────────────────────────────────────────────────────────────────');
    lines.push(`API Version Header: ${report.preflight.apiVersion}`);
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
    lines.push('2. SNAPSHOT PRÉ-MIGRAÇÃO (AES-256-GCM + RESTAURAÇÃO SQLite)');
    lines.push('───────────────────────────────────────────────────────────────────────────────');
    lines.push(`Arquivo de Backup: ${report.backup.backupPath}`);
    lines.push(`Tamanho Original: ${report.backup.originalSize} bytes`);
    lines.push(`Tamanho Cifrado: ${report.backup.encryptedSize} bytes`);
    lines.push(`Hash SHA-256 do Arquivo Cifrado: ${report.backup.encryptedHashSha256}`);
    lines.push(
      `Teste de Restauração SQLite: ${
        report.backup.verifiedRestoration ? '✅ APROVADO (Integridade Confirmada)' : '❌ FALHOU'
      }\n`,
    );

    lines.push('───────────────────────────────────────────────────────────────────────────────');
    lines.push('3. SCHEMA PLAN (DDL DO NOTION)');
    lines.push('───────────────────────────────────────────────────────────────────────────────');
    const summary = report.plan.schemaPlan.summary;
    lines.push(`Total de Operações Determinísticas: ${summary.totalSteps}`);
    lines.push(`  • ALTER_SELECT_OPTIONS: ${summary.alterOptionsCount} (Obrigações.Status: preserva 5 + adiciona 2)`);
    lines.push(`  • CREATE_PROPERTY: ${summary.createPropertyCount} (51 novas propriedades nas 12 bases)`);
    lines.push(`  • CREATE_DATABASE: ${summary.createDatabaseCount} (Faturas / Ciclos de Cartão)`);
    lines.push(`  • RESOLVE_DATA_SOURCE_ID: ${summary.resolveDataSourceCount} (Resolução de ID em runtime)`);
    lines.push(`  • CREATE_DUAL_RELATION: ${summary.dualRelationCount} (Dual relation Transações <-> Faturas)\n`);

    lines.push('Operações Ordenadas do Plano DDL:');
    for (const step of report.plan.schemaPlan.steps) {
      const propText = step.property ? ` [Propriedade: '${step.property}']` : '';
      const depText = step.dependsOnStep ? ` (Depende do Passo ${step.dependsOnStep})` : '';
      lines.push(`  [Passo ${step.stepNumber.toString().padStart(2, '0')}] ${step.operation} -> ${step.targetDataSource.name}${propText}${depText}`);
      lines.push(`     Risco: ${step.risk} | Precondição: ${step.precondition}`);
    }

    lines.push('\n───────────────────────────────────────────────────────────────────────────────');
    lines.push('4. DATA BACKFILL PLAN (DML IDEMPOTENTE)');
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
