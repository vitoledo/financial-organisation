import dotenv from 'dotenv';
dotenv.config();

import { BackfillLiveResumePreflight } from '../src/notion/migration-runner/backfill-live-preflight';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  FASE 2D: RESUME PREFLIGHT & RECONCILIATION PREVIEW (READ-ONLY)');
  console.log('           (MODO ESTRITAMENTE LEITURA — ZERO MUTAÇÕES NO NOTION LIVE)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  try {
    const args = process.argv.slice(2);
    const runIdx = args.indexOf('--run');
    const runId = runIdx !== -1 ? args[runIdx + 1] : undefined;

    const preflight = new BackfillLiveResumePreflight({ runId });
    console.log('1. Executando inspeção read-only do workspace Notion live e journal...');
    const artifact = await preflight.executeResumePreflight();

    console.log('\n2. Resultados da Verificação de Resume:');
    console.log(`  • Run ID:                    ${artifact.runId}`);
    console.log(`  • Run Executor Commit:       ${artifact.runExecutorCommitSha}`);
    console.log(`  • Recovery Executor Commit:  ${artifact.recoveryExecutorCommitSha}`);
    console.log(`  • Workspace Identity Hash:   ${artifact.workspaceIdentityHash.substring(0, 16)}...`);
    console.log(`  • Actor Type:                ${artifact.actorType}`);
    console.log(`  • Bases Alvo Live:           Transações = ${artifact.targets.transactions}, Faturas = ${artifact.targets.bills}`);
    console.log(`  • Operações Verificadas:     ${artifact.verifiedOperationsCount}`);
    console.log(`  • Operações Recuperáveis:    ${artifact.recoverableOperationsCount}`);
    console.log(`  • Journal Fingerprint:       ${artifact.journalFingerprint}`);
    console.log(`  • Live Target State Hash:    ${artifact.liveTargetStateHash}`);
    console.log(`  • Projected Target State:    ${artifact.projectedTargetStateHash}`);
    console.log(`  • Target Drift:              ${artifact.liveTargetStateHash === artifact.projectedTargetStateHash ? 'ZERO (Idêntico)' : 'DETECTADO'}`);
    console.log(`  • Artefato Salvo em:         .local/backfill-live-resume-preflight.json`);
    console.log(`  • Validade:                  ${artifact.generatedAt} -> ${artifact.expiresAt} (${artifact.ttlMinutes} min)`);

    if (artifact.reconciliationPreview.length > 0) {
      console.log('\n3. Preview de Reconciliação das Operações:');
      for (const item of artifact.reconciliationPreview) {
        console.log(`  • Op #${item.operationIndex} [${item.action}]:`);
        console.log(`      Status no Journal:        ${item.currentJournalStatus}`);
        console.log(`      Attempts:                 ${item.attempts}`);
        console.log(`      Target Page ID:           ${item.targetPageId}`);
        console.log(`      Stable Identity Matches:  ${item.stableIdentityMatches}`);
        console.log(`      Expected Fingerprint:     ${item.expectedFingerprint}`);
        console.log(`      Normalized Live Fingerprint: ${item.actualNormalizedFingerprint}`);
        console.log(`      Recoverable:              ${item.recoverable}`);
        console.log(`      Preview Status:           ${item.previewStatus}`);
        if (item.reason) {
          console.log(`      Reason:                   ${item.reason}`);
        }
      }
    }

    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('  CONCLUSÃO DO RESUME PREFLIGHT (READ-ONLY)');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log(`  READY_FOR_LIVE_APPLY_REVIEW = ${artifact.readyForLiveApplyReview}`);
    console.log(`  readyForApply               = ${artifact.readyForApply}`);

    if (artifact.reasons.length > 0) {
      console.log('\n  Bloqueadores encontrados:');
      for (const r of artifact.reasons) {
        console.log(`   - ${r}`);
      }
    }

    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('  ARTEFATO SANITIZADO');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log(JSON.stringify(artifact, null, 2));

    if (!artifact.readyForLiveApplyReview) {
      process.exit(1);
    }
  } catch (err: any) {
    console.error('\nERRO NO RESUME PREFLIGHT:');
    console.error(err.message || err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
