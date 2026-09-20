import dotenv from 'dotenv';
dotenv.config();

import { BackfillLivePreflight } from '../src/notion/migration-runner/backfill-live-preflight';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  FASE 2C: PREFLIGHT REAL READ-ONLY & PREPARAÇÃO DO WIRING DE PRODUÇÃO');
  console.log('           (MODO ESTRITAMENTE LEITURA — ZERO MUTAÇÕES NO NOTION LIVE)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  try {
    const preflight = new BackfillLivePreflight();
    console.log('1. Executando inspeção read-only do workspace Notion live...');
    const artifact = await preflight.executePreflight();

    console.log('\n2. Resultados da Verificação:');
    console.log(`  • Workspace Identity Hash: ${artifact.workspaceIdentityHash.substring(0, 16)}...`);
    console.log(`  • Actor Type: ${artifact.actorType}`);
    console.log(`  • Schema Conformance: ${artifact.schema.verified}/${artifact.schema.total} bases (Ausentes: ${artifact.schema.missing}, Mismatches: ${artifact.schema.mismatches})`);
    console.log(`  • Bases Alvo DML: Transações = ${artifact.targets.transactions}, Faturas = ${artifact.targets.bills}`);
    console.log(`  • Live Target State Hash:   ${artifact.liveTargetStateHash}`);
    console.log(`  • Frozen Target State Hash: ${artifact.frozenTargetStateHash}`);
    console.log(`  • Target Drift: ${artifact.liveTargetStateHash === artifact.frozenTargetStateHash ? 'ZERO (Idêntico)' : 'DETECTADO'}`);
    console.log(`  • Plano Reproduzido: ${artifact.backfillPlanHash === '948adff94c62dc8bb6857fa0f3c008f15106469b58333b69b6d5364ead92f657' ? '100% Determinístico' : 'DIVERGENTE'}`);
    console.log(`  • Relações Existentes: ${artifact.existingRelationsSummary.verified}/${artifact.existingRelationsSummary.total} válidas (Ausentes: ${artifact.existingRelationsSummary.missing}, Alvo incorreto: ${artifact.existingRelationsSummary.wrongTarget})`);
    console.log(`  • Stable Identities: ${artifact.stableIdentitiesSummary.totalChecked} verificadas (Conflitos: ${artifact.stableIdentitiesSummary.conflicts}, Duplicatas: ${artifact.stableIdentitiesSummary.duplicates})`);
    console.log(`  • Journal Segregado: ${artifact.journalStatus.path} (Gravável: ${artifact.journalStatus.writable}, GitIgnored: ${artifact.journalStatus.gitIgnored})`);
    console.log(`  • Mutações Live Notion: ${artifact.liveMutations} (ZERO)`);
    console.log(`  • Artefato Salvo em: .local/backfill-live-preflight.json`);
    console.log(`  • Validade: ${artifact.generatedAt} -> ${artifact.expiresAt} (${artifact.ttlMinutes} min)`);

    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('  CONCLUSÃO DA AUDITORIA READ-ONLY (FASE 2C)');
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
    console.error('\n[ERRO CRÍTICO NO PREFLIGHT LIVE]', err.message);
    process.exit(1);
  }
}

main();
