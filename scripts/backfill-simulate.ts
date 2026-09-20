import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import {
  PLAN_ORIGIN_COMMIT_SHA,
  FROZEN_BACKFILL_PLAN_HASH,
  FROZEN_TARGET_STATE_HASH,
} from '../src/notion/migration-runner/backfill-constants';
import { BackfillDryRunAnalyzer } from '../src/notion/migration-runner/backfill-dry-run';
import { BackfillJournal } from '../src/notion/migration-runner/backfill-journal';
import { SimulatedNotionAdapter } from '../src/notion/migration-runner/backfill-adapter';
import {
  BackfillExecutor,
  DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
} from '../src/notion/migration-runner/backfill-executor';

dotenv.config();

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  FASE 2B.1: EXECUTOR DML IDEMPOTENTE EM SIMULAÇÃO');
  console.log('             (MODO ESTRITAMENTE SIMULADO — ZERO MUTAÇÕES NO NOTION LIVE)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  const envVars = process.env;

  // 1. Extração das bases do snapshot congelado
  const analyzer = new BackfillDryRunAnalyzer({ envVars });
  const targetSession = analyzer.prepareValidatedTargetSnapshot();
  const frozenBases = JSON.parse(JSON.stringify(targetSession.payload.bases));
  targetSession.cleanup();

  // 2. Instanciação do adaptador simulado em memória
  const adapter = new SimulatedNotionAdapter(frozenBases);

  // 3. Execução 1: Execução Completa em Simulação (Fresh journal)
  const journalDb1 = new Database(':memory:');
  const journal1 = new BackfillJournal(journalDb1);

  const executor1 = new BackfillExecutor({
    adapter,
    journal: journal1,
    envVars,
    planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
    schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
    skipWorktreeCleanCheck: true,
  });

  console.log('Executando Preflight e Simulação (Run 1: Snapshot Congelado -> Backend Simulado)...');
  const report1 = await executor1.execute();

  console.log(`[Run 1 Concluído] Run ID: ${report1.simulationRunId}`);
  console.log(`  • Semantic Creates: ${report1.semanticCreates}`);
  console.log(`  • Actual Simulated Create Writes: ${report1.actualSimulatedCreateWrites}`);
  console.log(`  • Logical Relation References: ${report1.logicalRelationReferences}`);
  console.log(`  • Canonical Relation Patch Groups: ${report1.canonicalRelationPatchGroups}`);
  console.log(`  • Actual Simulated Relation Writes: ${report1.actualSimulatedRelationWrites}`);
  console.log(`  • Write Requests Sent: ${report1.writeRequestsSent}`);
  console.log(`  • Retries: ${report1.retries}`);
  console.log(`  • Live Notion Mutations: ${report1.liveNotionMutations} (ZERO)`);
  console.log(`  • Journal Status: VERIFIED=${report1.journalFinal.VERIFIED}, NO_OP_VERIFIED=${report1.journalFinal.NO_OP_VERIFIED}, FAILED=${report1.journalFinal.FAILED}`);
  console.log(`  • Ready for Live Apply Review: ${report1.readyForLiveApplyReview}`);
  console.log(`  • Ready for Apply: ${report1.readyForApply}\n`);

  // 4. Execução 2: Teste de Idempotência Máxima (Fresh journal contra o backend já populado)
  console.log('Executando Teste de Idempotência Máxima (Run 2: Backend Populado -> 100% NO_OP_VERIFIED)...');
  const journalDb2 = new Database(':memory:');
  const journal2 = new BackfillJournal(journalDb2);

  const executor2 = new BackfillExecutor({
    adapter,
    journal: journal2,
    envVars,
    planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
    schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
    skipWorktreeCleanCheck: true,
  });

  const report2 = await executor2.execute();

  console.log(`[Run 2 Concluído] Run ID: ${report2.simulationRunId}`);
  console.log(`  • Semantic Creates: ${report2.semanticCreates}`);
  console.log(`  • Actual Simulated Create Writes: ${report2.actualSimulatedCreateWrites} (ZERO)`);
  console.log(`  • Existing Page Create No-Ops: ${report2.existingPageCreateNoOps}`);
  console.log(`  • Canonical Relation Patch Groups: ${report2.canonicalRelationPatchGroups}`);
  console.log(`  • Actual Simulated Relation Writes: ${report2.actualSimulatedRelationWrites} (ZERO)`);
  console.log(`  • Write Requests Sent: ${report2.writeRequestsSent} (ZERO)`);
  console.log(`  • Live Notion Mutations: ${report2.liveNotionMutations} (ZERO)`);
  console.log(`  • Journal Status: VERIFIED=${report2.journalFinal.VERIFIED}, NO_OP_VERIFIED=${report2.journalFinal.NO_OP_VERIFIED}, FAILED=${report2.journalFinal.FAILED}`);
  console.log(`  • Ready for Live Apply Review: ${report2.readyForLiveApplyReview}`);
  console.log(`  • Ready for Apply: ${report2.readyForApply}\n`);

  // 5. Emissão do Relatório Sanitizado em JSON
  const outputPayload = {
    timestampIso: new Date().toISOString(),
    planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
    frozenBackfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
    targetStateHash: FROZEN_TARGET_STATE_HASH,
    run1: report1,
    run2: report2,
  };

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  RELATÓRIO SANITIZADO FINAL DA SIMULAÇÃO (FASE 2B.1)');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(JSON.stringify(outputPayload, null, 2));

  executor1.close();
  executor2.close();
}

main().catch((err) => {
  console.error('\n❌ ERRO NA SIMULAÇÃO DO BACKFILL:', err.message || err);
  process.exit(1);
});
