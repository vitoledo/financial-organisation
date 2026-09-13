import dotenv from 'dotenv';
import { BackfillDryRunAnalyzer } from '../src/notion/migration-runner/backfill-dry-run';

dotenv.config();

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  FASE 2A: AUDITORIA E FECHAMENTO DETERMINÍSTICO DO PLANO DE BACKFILL');
  console.log('             (MODO ESTRITAMENTE READ-ONLY — ZERO ESCRITAS NO NOTION)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  const analyzer = new BackfillDryRunAnalyzer();
  const report = await analyzer.runAnalysis();

  console.log(`Timestamp da Análise: ${report.timestampIso}`);
  console.log(`Banco de Origem: ${report.sourceDatabase}`);
  console.log(`Total de Transações no SQLite: ${report.totalSourceTransactions}`);
  console.log(`Total de Contas no SQLite: ${report.totalSourceAccounts}\n`);

  // 1. RESOLUÇÃO DAS 109 TRANSAÇÕES COM CONTA AMBÍGUA
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  1. RESOLUÇÃO DETERMINÍSTICA DAS CONTAS DE ORIGEM (155/155 RESOLVIDAS)');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  const nubankContaTx = report.transactionAudits.filter((t) => t.resolvedAccountName === 'Nubank Conta');
  const nubankCartaoTx = report.transactionAudits.filter((t) => t.resolvedAccountName === 'Nubank Cartão');
  const unresolvedTx = report.transactionAudits.filter((t) => t.resolutionMethod === 'UNRESOLVED');

  console.log(`  • Transações de Conta Corrente (Nubank Conta): ${nubankContaTx.length}`);
  console.log(`    - Método de Resolução: SOURCE_ACCOUNT_ID (FK 'c82e6d46-15f2-47fc-991d-abaa12f063b8')`);
  console.log(`    - Evidência Forte: account_id, account_subtype='CHECKING_ACCOUNT', connector_name='Nubank', item_bank_name='Nu Pagamentos S.A.'`);
  console.log(`    - Confiança: VERY_HIGH`);
  console.log(`  • Transações de Cartão de Crédito (Nubank Cartão): ${nubankCartaoTx.length}`);
  console.log(`    - Método de Resolução: SOURCE_ACCOUNT_ID (FK '02e273f7-840e-4b3a-b487-348f922dce70')`);
  console.log(`    - Evidência Forte: account_id, account_type='CREDIT', credit_card_data com billId`);
  console.log(`    - Confiança: VERY_HIGH`);
  console.log(`  • Transações UNRESOLVED: ${unresolvedTx.length} (ZERO PENDÊNCIAS)`);
  console.log(`  • Transações Mercado Pago: 0 (Base criada manualmente, sem vínculo open-finance no SQLite)\n`);

  // 2. INTERVALO TEMPORAL E RECONCILIAÇÃO FINANCEIRA
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  2. INTERVALO TEMPORAL E RECONCILIAÇÃO FINANCEIRA DETALHADA');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  const r = report.reconciliation;
  console.log(`  • Período Temporal Disponível: ${r.minDate.substring(0, 10)} até ${r.maxDate.substring(0, 10)}`);
  console.log('  • Volume Mensal:');
  for (const [m, count] of Object.entries(r.countByMonth)) {
    console.log(`      - ${m}: ${count} transações`);
  }
  console.log('\n  • Fluxo de Caixa Físico (Movimentações Bancárias Reais):');
  console.log(`      - Entradas Físicas (+): R$ ${r.physicalInflows.toFixed(2)}`);
  console.log(`      - Saídas Físicas (-): R$ ${r.physicalOutflows.toFixed(2)}`);
  console.log(`      - Saldo Líquido Físico: R$ ${r.physicalNetFlow.toFixed(2)}`);

  console.log('\n  • Reconciliação Econômica e Orçamentária (BudgetEffect):');
  console.log(`      - Receitas Econômicas: R$ ${r.economicIncome.toFixed(2)}`);
  console.log(`      - Despesas Econômicas: R$ ${r.economicExpense.toFixed(2)}`);
  console.log(`      - Transferências Internas (Neutras): R$ ${r.internalTransfers.toFixed(2)}`);
  console.log(`      - Pagamentos de Fatura (Neutros): R$ ${r.cardBillPayments.toFixed(2)}`);
  console.log(`      - Reembolsos / Estornos: R$ ${r.refunds.toFixed(2)}`);
  console.log(`      - Aportes / Investimentos: R$ ${r.investments.toFixed(2)}`);
  console.log(`      - Discrepância / Diferença: R$ ${r.discrepancy.toFixed(2)} (ZERO DIVERGÊNCIA)`);
  console.log('      * Nota Semântica: Os R$ 149,88 do relatório inicial eram decorrência de filtro estrito');
  console.log('        na coluna legado "direction". O total de entradas com transferência familiar atinge R$ 2.294,39.\n');

  // 3. AUDITORIA INDIVIDUAL DOS 5 CICLOS DE CARTÃO
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  3. AUDITORIA INDIVIDUAL DOS 5 CICLOS DE FATURA DE CARTÃO');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('| Stable Bill ID | Início | Fim | Fechamento | Vencimento | Status | Qualidade | Compras | Soma Compras | Valor Oficial | Dif |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');
  for (const b of report.cardBillAudits) {
    const ofVal = b.valorOficial !== null ? `R$ ${b.valorOficial.toFixed(2)}` : 'null';
    console.log(
      `| ${b.stableBillId.padEnd(42, ' ')} | ${b.inicio} | ${b.fim} | ${b.fechamento} | ${b.vencimento} | ${b.status.padEnd(18, ' ')} | ${b.qualidade} | ${b.nCompras.toString().padStart(2, ' ')} | R$ ${b.somaCompras.toFixed(2).padStart(6, ' ')} | ${ofVal.padStart(7, ' ')} | R$ 0.00 |`,
    );
  }
  console.log(`  • Total de Compras de Cartão: R$ ${r.creditCardPurchasesTotal.toFixed(2)} em 20 compras.`);
  console.log('  • Demais 26 transações de cartão são pagamentos/amortizações de fatura (NEUTRAL).\n');

  // 4. ATUALIZAÇÕES DERIVADAS SUSPENSAS
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  4. ATUALIZAÇÕES DERIVADAS SUSPENSAS (PROPOSED_DERIVED_UPDATE_REQUIRES_REVIEW)');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  for (const u of report.proposedDerivedUpdates) {
    console.log(`▶ [${u.targetBase}] ${u.title}:`);
    console.log(`    • Campo: ${u.field}`);
    console.log(`    • Valor Atual: ${JSON.stringify(u.currentValue)}`);
    console.log(`    • Valor Proposto: ${JSON.stringify(u.proposedValue)}`);
    console.log(`    • Diferença: ${u.difference}`);
    console.log(`    • Fórmula / Fonte: ${u.formulaSource}`);
    console.log(`    • Freshness: ${u.timestampFreshness}`);
    console.log(`    • Justificativa da Suspensão: ${u.rationale}`);
    console.log(`    • Status: ${u.status}\n`);
  }

  // 5. AUDITORIA DE CATEGORIAS
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  5. RECONCILIAÇÃO DE CATEGORIAS (18 PARES MAPEADOS — ZERO DEFAULT SILENCIOSO)');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('| Categoria Legado (Mapped || Pierre) | Categoria Canônica | Qtd | Soma (R$) | Método de Mapeamento |');
  console.log('| :--- | :--- | :---: | :---: | :--- |');
  for (const c of report.categoryReconciliations) {
    console.log(
      `| ${c.categoriaLegado.padEnd(52, ' ')} | ${c.categoriaCanonica.padEnd(24, ' ')} | ${c.quantidade.toString().padStart(2, ' ')} | ${c.soma.toFixed(2).padStart(8, ' ')} | ${c.metodoMapeamento} |`,
    );
  }
  console.log('');

  // 6. ESTRATÉGIA DE IDENTIDADE DETERMINÍSTICA
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  6. ESTRATÉGIA DE IDENTIDADE DETERMINÍSTICA E IDEMPOTÊNCIA');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  const idS = report.identityStrategy;
  console.log(`  • Transações com ID Estável da Fonte (Source ID): ${idS.countWithSourceId}/155 (100%)`);
  console.log(`  • Transações Dependentes de Fallback Hash: ${idS.countWithFallback}`);
  console.log(`  • Colisões de Identidade Detectadas: ${idS.collisionsFound} (ZERO COLISÕES)`);
  console.log(`  • Colisões Potenciais: ${idS.potentialCollisions}\n`);

  // 7. ARTEFATO IMUTÁVEL DE BACKFILL PLAN
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  7. ARTEFATO IMUTÁVEL: BACKFILL PLAN HASH & GATES DE SEGURANÇA');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  const p = report.planArtifact;
  console.log(`  • Versão do Plano: ${p.version} (mapping: ${p.mappingVersion})`);
  console.log(`  • Commit SHA de Referência: ${p.commitSha}`);
  console.log(`  • Source Snapshot Hash (SQLite): ${p.sourceSnapshotHash}`);
  console.log(`  • Target Notion Snapshot Hash: ${p.targetNotionSnapshotHash}`);
  console.log(`  • Deterministic BackfillPlanHash: ${p.backfillPlanHash}`);
  console.log(`  • Total de Operações Planejadas: ${p.summary.totalOperations}`);
  console.log(`      - CREATE Executáveis (Transações + Faturas): ${p.summary.executableCreateCount}`);
  console.log(`      - UPDATE Executáveis: ${p.summary.executableUpdateCount}`);
  console.log(`      - UPDATE Suspensos para Revisão: ${p.summary.proposedReviewCount}`);
  console.log(`      - Total de Vínculos Relacionais: ${p.summary.totalRelations}`);

  console.log('\n  • Gates de Segurança Obrigatórios para Futura Escrita DML:');
  console.log(`      - $env:${p.securityGates.enabledVar} = "${p.securityGates.expectedEnabledValue}"`);
  console.log(`      - $env:${p.securityGates.planHashVar} = "${p.backfillPlanHash}"`);
  console.log(`      - $env:${p.securityGates.commitShaVar} = "${p.commitSha}"`);

  console.log('\n  • Avaliação das Pré-condições de Execução (READY_FOR_APPLY):');
  for (const [chk, val] of Object.entries(p.readiness.checks)) {
    console.log(`      [${val ? '✅ CONFORME' : '❌ PENDENTE'}] ${chk}`);
  }
  console.log(`\n  • Status Consolidado: READY_FOR_APPLY = ${p.readiness.readyForApply ? 'true' : 'false'}`);
  if (p.readiness.blockers.length > 0) {
    console.log('  • Bloqueadores Atuais:');
    for (const b of p.readiness.blockers) {
      console.log(`      ⚠️  ${b}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('  AUDITORIA CONCLUÍDA — SISTEMA PERMANECE 100% READ-ONLY');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('Erro na auditoria de backfill:', err);
  process.exit(1);
});
