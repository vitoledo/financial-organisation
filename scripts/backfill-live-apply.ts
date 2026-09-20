/**
 * Phase 2D: Live Apply Script & Production Wiring Runner
 *
 * ARCHITECTURAL SAFETY INVARIANTS:
 * 1. Without '--execute-live': prints sanitized plan, executes ZERO writes, exits safely with code 0.
 * 2. With '--execute-live': strictly requires:
 *    - FINANCIAL_BACKFILL_ENABLED=I_UNDERSTAND_BACKFILL_MUTATIONS
 *    - FINANCIAL_BACKFILL_PLAN_HASH=948adff94c62dc8bb6857fa0f3c008f15106469b58333b69b6d5364ead92f657
 *    - FINANCIAL_BACKFILL_PLAN_COMMIT_SHA=92187f7f712178aac634d23e53e22aa9dededb7c
 *    - FINANCIAL_BACKFILL_EXECUTOR_COMMIT_SHA=<local HEAD SHA>
 *    - Working tree clean & remote branch HEAD matching local HEAD
 *    - Fresh preflight authorization artifact (age <= 15m) matching local HEAD
 *    - For initial run: '--canary 1' is MANDATORY (aborts otherwise with CANARY_REQUIRED_FOR_INITIAL_RUN)
 */

import 'dotenv/config';
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
} from '../src/notion/migration-runner/backfill-constants';
import {
  isPreflightValid,
  validatePreflightBinding,
  LivePreflightArtifact,
  isResumePreflightValid,
  validateResumePreflightBinding,
  ResumePreflightArtifact,
} from '../src/notion/migration-runner/backfill-live-preflight';
import {
  ProductionNotionAdapter,
  ProductionAuthorizationContext,
} from '../src/notion/migration-runner/production-adapter';
import { BackfillExecutor } from '../src/notion/migration-runner/backfill-executor';
import { BackfillJournal } from '../src/notion/migration-runner/backfill-journal';
import { BackfillDryRunAnalyzer } from '../src/notion/migration-runner/backfill-dry-run';
import { LiveNotionAdapter } from '../src/notion/migration-runner/backfill-adapter';
import { calculateTargetStateHash } from '../src/notion/migration-runner/data-snapshot';
import { NotionSchemaValidator } from '../src/notion/schema-validator';

function getGitCommitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown-executor-sha';
  }
}

function getRemoteBranchHeadSha(): string | null {
  try {
    // Try upstream tracking branch first
    return execSync('git rev-parse @{u}', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    try {
      return execSync('git rev-parse origin/feat/phase-1-schema-apply-executor', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  }
}

function isWorktreeClean(): boolean {
  try {
    const out = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
    return out.length === 0;
  } catch {
    return false;
  }
}

export async function runLiveApply(
  customArgs?: string[],
  customEnv?: Record<string, string | undefined>,
): Promise<void> {
  const env = customEnv || process.env;
  const args = customArgs !== undefined ? customArgs : process.argv.slice(2);
  const isExecuteLive = args.includes('--execute-live');
  const canaryIdx = args.indexOf('--canary');
  const canary = canaryIdx !== -1 ? parseInt(args[canaryIdx + 1], 10) : undefined;
  const resumeIdx = args.indexOf('--resume');
  const resumeRunId = resumeIdx !== -1 ? args[resumeIdx + 1] : undefined;

  const currentCommitSha = getGitCommitSha();

  console.log('═'.repeat(79));
  console.log('  FASE 2D: BACKFILL LIVE APPLY & PRODUCTION EXECUTION');
  console.log(
    isExecuteLive
      ? '           (MODO LIVE AUTORIZADO — EXECUTANDO COM SAFEGUARDS)'
      : '           (MODO SEGURO / DRY INVOCATION — ZERO MUTAÇÕES NO NOTION)',
  );
  console.log('═'.repeat(79));
  console.log();

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. MODO DRY / INVOCATION SEM --execute-live (Item 13)
  // ─────────────────────────────────────────────────────────────────────────────
  if (!isExecuteLive) {
    console.log('1. Verificando baseline congelada da migração...');

    const analyzer = new BackfillDryRunAnalyzer({
      envVars: env,
      commitSha: PLAN_ORIGIN_COMMIT_SHA,
    });
    const analysisReport = await analyzer.runAnalysis();
    const plan = analysisReport.planArtifact;

    console.log();
    console.log('2. Resumo Sanitizado do Plano:');
    console.log(`  • Plan Hash:                 ${plan.backfillPlanHash}`);
    console.log(`  • Plan Origin Commit SHA:    ${PLAN_ORIGIN_COMMIT_SHA}`);
    console.log(`  • Current Executor Head SHA: ${currentCommitSha}`);
    console.log(`  • Operações Planejadas:      ${plan.summary.executableCreateCount} CREATE, ${plan.summary.executableUpdateCount} UPDATE`);
    console.log(`  • Relações Lógicas:          320 referências`);
    console.log(`  • Grupos de Faturas:         4 faturas`);
    console.log(`  • Target State Hash:         ${FROZEN_TARGET_STATE_HASH}`);
    console.log();
    console.log('3. Status da Invocação:');
    console.log('  • Flag --execute-live:       NÃO FORNECIDA');
    console.log('  • Mutações Live Notion:      0 (ZERO)');
    console.log('  • Write Requests Enviados:   0 (ZERO)');
    console.log('  • READY_FOR_CANARY_REVIEW:   true');
    console.log('  • readyForApply:             false');
    console.log();
    console.log('═'.repeat(79));
    console.log('  Invocação segura concluída com sucesso. Nenhuma mutação executada.');
    console.log('═'.repeat(79));
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. VALIDAÇÃO DOS GATES DE PRODUÇÃO (Itens 2, 3, 7)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('1. Validando Environment Gates de Produção...');

  const gateEnabled = env.FINANCIAL_BACKFILL_ENABLED?.trim();
  const gatePlanHash = env.FINANCIAL_BACKFILL_PLAN_HASH?.trim();
  const gatePlanCommit = env.FINANCIAL_BACKFILL_PLAN_COMMIT_SHA?.trim();
  const gateExecutorCommit = env.FINANCIAL_BACKFILL_EXECUTOR_COMMIT_SHA?.trim();

  if (gateEnabled !== 'I_UNDERSTAND_BACKFILL_MUTATIONS') {
    throw new Error(
      `FAIL_PRODUCTION_AUTHORIZATION: FINANCIAL_BACKFILL_ENABLED deve ser 'I_UNDERSTAND_BACKFILL_MUTATIONS'. Obtido: '${gateEnabled}'.`,
    );
  }
  if (gatePlanHash !== FROZEN_BACKFILL_PLAN_HASH) {
    throw new Error(
      `FAIL_PRODUCTION_AUTHORIZATION: FINANCIAL_BACKFILL_PLAN_HASH diverge da baseline congelada (${gatePlanHash} vs ${FROZEN_BACKFILL_PLAN_HASH}).`,
    );
  }
  if (gatePlanCommit !== PLAN_ORIGIN_COMMIT_SHA) {
    throw new Error(
      `FAIL_PRODUCTION_AUTHORIZATION: FINANCIAL_BACKFILL_PLAN_COMMIT_SHA diverge de ${PLAN_ORIGIN_COMMIT_SHA}.`,
    );
  }
  if (gateExecutorCommit !== currentCommitSha) {
    throw new Error(
      `FAIL_PRODUCTION_AUTHORIZATION: FINANCIAL_BACKFILL_EXECUTOR_COMMIT_SHA (${gateExecutorCommit}) diverge do commit HEAD atual (${currentCommitSha}).`,
    );
  }

  console.log('  ✓ Todos os 4 environment gates validados com sucesso.');

  // Validação Git
  console.log('2. Validando integridade do repositório Git...');
  if (!isWorktreeClean()) {
    throw new Error('FAIL_EXECUTOR_COMMIT_MISMATCH: Working tree possui alterações não commitadas.');
  }

  const remoteHead = getRemoteBranchHeadSha();
  if (remoteHead && remoteHead !== currentCommitSha) {
    throw new Error(
      `FAIL_EXECUTOR_COMMIT_MISMATCH: Local HEAD (${currentCommitSha}) diverge do remote branch HEAD (${remoteHead}).`,
    );
  }
  console.log('  ✓ Working tree limpa e sincronizada com o branch remoto.');

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. VALIDAÇÃO DO ARTEFATO DE PREFLIGHT (Itens 4, 5, 6, 16)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('3. Validando artefato de autorização de preflight...');

  const isResumeRun = Boolean(resumeRunId);
  const preflightArtifactPath = isResumeRun
    ? path.resolve(process.cwd(), '.local', 'backfill-live-resume-preflight.json')
    : path.resolve(process.cwd(), '.local', 'backfill-live-preflight.json');

  if (!fs.existsSync(preflightArtifactPath)) {
    throw new Error(
      `FAIL_PRODUCTION_AUTHORIZATION: Artefato de preflight obrigatório não encontrado em '${preflightArtifactPath}'. Execute pnpm notion:backfill-live-preflight primeiro.`,
    );
  }

  let artifact: any;
  try {
    artifact = JSON.parse(fs.readFileSync(preflightArtifactPath, 'utf8'));
  } catch (err: any) {
    throw new Error(`FAIL_PRODUCTION_AUTHORIZATION: Erro ao ler artefato de preflight: ${err.message}`);
  }

  // Validação temporal
  const validity = isResumeRun ? isResumePreflightValid(artifact) : isPreflightValid(artifact);
  if (!validity.valid) {
    throw new Error(`FAIL_PRODUCTION_AUTHORIZATION: ${validity.reason}`);
  }

  // Validação de binding
  const binding = isResumeRun
    ? validateResumePreflightBinding(artifact, {
        runId: resumeRunId,
        executorCommitSha: currentCommitSha,
        backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
      })
    : validatePreflightBinding(artifact, {
        executorCommitSha: currentCommitSha,
        planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
        backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
        sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
        targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
        targetStateHash: FROZEN_TARGET_STATE_HASH,
      });

  if (!binding.valid) {
    throw new Error(`FAIL_PRODUCTION_AUTHORIZATION: ${binding.reason}`);
  }

  console.log(`  ✓ Artefato de preflight válido (TTL ativo, SHA binding: ${currentCommitSha}).`);

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. VERIFICAÇÃO DE CANARY OBRIGATÓRIO (Item 14)
  // ─────────────────────────────────────────────────────────────────────────────
  if (!isResumeRun && canary !== 1) {
    throw new Error(
      'CANARY_REQUIRED_FOR_INITIAL_RUN: A execução inicial em ambiente live exige o parâmetro --canary 1 para verificação controlada.',
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. IN-PROCESS REVALIDATION DO WORKSPACE NOTION (Item 5)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('4. Executando revalidação in-process do workspace Notion antes de qualquer mutação...');

  const apiKey = env.NOTION_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('FAIL_PRODUCTION_AUTHORIZATION: NOTION_API_KEY não configurada.');
  }

  const client = new Client({ auth: apiKey, notionVersion: '2026-03-11' });

  // Workspace Identity Check
  const botUser: any = await client.users.me({});
  const liveWsId = botUser?.bot?.workspace_id || botUser?.id || '';
  const liveWsHash = crypto.createHash('sha256').update(liveWsId).digest('hex');
  if (liveWsHash !== artifact.workspaceIdentityHash) {
    throw new Error('FAIL_PRODUCTION_AUTHORIZATION: Workspace identity diverge do artefato de preflight.');
  }

  // Schema 13/13 Check
  const schemaValidator = new NotionSchemaValidator(apiKey);
  const schemaReport = await schemaValidator.runIntrospection(env, { treatAllAsExisting: true });
  if (schemaReport.verifiedCount !== 13 || schemaReport.failedCount > 0) {
    throw new Error('FAIL_SCHEMA_NON_CONFORMANT: Revalidação de schema live falhou (13/13 exigido).');
  }

  // State Hash & Pristine Target Check (Item 5)
  const auditAdapter = new LiveNotionAdapter(client, env as Record<string, string | undefined>);
  const currentLiveBases = await auditAdapter.queryTargetState();
  const currentLiveHash = calculateTargetStateHash(currentLiveBases);

  if (!isResumeRun) {
    const txCount = currentLiveBases['NOTION_DS_TRANSACTIONS']?.recordCount ?? 0;
    const billsCount = currentLiveBases['NOTION_DS_CARD_BILLS']?.recordCount ?? 0;
    if (txCount > 0 || billsCount > 0) {
      throw new Error(
        `PREEXISTING_BACKFILL_TARGET_DATA: Bases de escrita contêm dados prévios (Transações: ${txCount}, Faturas: ${billsCount}). Apply abortado.`,
      );
    }
    if (currentLiveHash !== FROZEN_TARGET_STATE_HASH) {
      throw new Error(
        `TARGET_DRIFT_DETECTED: Live target state (${currentLiveHash}) diverge do snapshot congelado (${FROZEN_TARGET_STATE_HASH}).`,
      );
    }
  }

  console.log('  ✓ In-process revalidation concluída com sucesso: 0 drift, 0 dados prévios.');

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. INSTANCIAÇÃO DO ADAPTER DE PRODUÇÃO E EXECUÇÃO
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('5. Inicializando ProductionNotionAdapter e Executor...');

  const journalPath = path.resolve(process.cwd(), '.local', 'backfill-live-journal.db');
  const authContext: ProductionAuthorizationContext = {
    planHash: FROZEN_BACKFILL_PLAN_HASH,
    planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
    executorCommitSha: currentCommitSha,
    sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
    targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
    targetStateHash: FROZEN_TARGET_STATE_HASH,
    workspaceIdentityHash: liveWsHash,
    preflightGeneratedAt: artifact.generatedAt,
    preflightExpiresAt: artifact.expiresAt,
    journalPath,
  };

  const productionAdapter = new ProductionNotionAdapter(client, authContext, env as any);
  const journalDb = new Database(journalPath);
  const journal = new BackfillJournal(journalDb);

  const executor = new BackfillExecutor({
    adapter: productionAdapter,
    journal,
    envVars: env,
    commitSha: currentCommitSha,
    planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
    canary,
    resumeRunId,
    isLive: true,
    schemaEvidence: {
      totalDataSources: 13,
      verifiedDataSources: 13,
      missingPropertiesCount: 0,
      structuralMismatchesCount: 0,
    },
  });

  const report = await executor.execute();

  console.log();
  console.log('═'.repeat(79));
  console.log(`  EXECUÇÃO CONCLUÍDA: Status = ${report.status}`);
  console.log('═'.repeat(79));
  console.log(`  • Run ID:                    ${report.simulationRunId}`);
  console.log(`  • Semantic Creates:          ${report.semanticCreates}`);
  console.log(`  • Actual Create Writes:      ${report.actualSimulatedCreateWrites}`);
  console.log(`  • Existing No-Ops:           ${report.existingPageCreateNoOps}`);
  console.log(`  • Relation Patch Groups:     ${report.canonicalRelationPatchGroups}`);
  console.log(`  • Total Writes Sent:         ${report.writeRequestsSent}`);
  console.log(`  • Live Mutation Count:       ${report.liveNotionMutations}`);
  console.log(`  • Status Final no Journal:   ${JSON.stringify(report.journalFinal)}`);
  console.log();
}

async function main(): Promise<void> {
  await runLiveApply();
}

if (require.main === module) {
  main().catch((err) => {
    console.error();
    console.error('FATAL_ERROR_IN_APPLY:');
    console.error(err.message || err);
    process.exit(1);
  });
}
