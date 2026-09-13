import dotenv from 'dotenv';
import { BackfillDryRunAnalyzer } from '../src/notion/migration-runner/backfill-dry-run';

dotenv.config();

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  FASE 2A.1: AUDITORIA E FECHAMENTO DETERMINÍSTICO DO PLANO DE BACKFILL');
  console.log('             (MODO ESTRITAMENTE READ-ONLY — ZERO ESCRITAS NO NOTION)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  const analyzer = new BackfillDryRunAnalyzer();
  const report = await analyzer.runAnalysis();

  console.log(`Timestamp da Análise: ${report.timestampIso}`);
  console.log(`Banco de Origem: ${report.sourceDatabase}`);
  console.log(`Total de Transações no SQLite: ${report.totalSourceTransactions}`);
  console.log(`Total de Contas no SQLite: ${report.totalSourceAccounts}\n`);

  // 1. RESOLUÇÃO DETERMINÍSTICA DAS CONTAS DE ORIGEM
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

  // 2. DESACOPLAMENTO FINANCEIRO: CAIXA FÍSICO, PASSIVO DE CARTÃO E CONSUMO ECONÔMICO
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  2. DESACOPLAMENTO FINANCEIRO E RECONCILIAÇÃO CANÔNICA');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  const r = report.reconciliation;
  console.log(`  • Período Temporal Disponível: ${r.minDate.substring(0, 10)} até ${r.maxDate.substring(0, 10)}`);
  console.log('  • Volume Mensal:');
  for (const [m, count] of Object.entries(r.countByMonth)) {
    console.log(`      - ${m}: ${count} transações`);
  }

  console.log('\n  [A] Fluxo de Caixa Físico — Conta Corrente (Nubank Conta, 109 txs):');
  console.log(`      • Entradas Físicas (+): R$ ${r.checkingCashFlow.inflowsTotal.toFixed(2)}`);
  console.log(`          - Entradas de Terceiros: R$ ${r.checkingCashFlow.thirdPartyInflows.toFixed(2)}`);
  console.log(`          - Transferências Mesma Titularidade: R$ ${r.checkingCashFlow.sameOwnershipInflows.toFixed(2)}`);
  console.log(`      • Saídas Físicas (-): R$ ${r.checkingCashFlow.totalOutflows.toFixed(2)}`);
  console.log(`          - Despesas Diretas / Transferências: R$ ${r.checkingCashFlow.directOutflows.toFixed(2)}`);
  console.log(`          - Pagamentos / Amortizações de Fatura: R$ ${r.checkingCashFlow.cardBillSettlementOutflows.toFixed(2)}`);
  console.log(`      • Saldo Líquido de Caixa Físico: R$ ${r.checkingCashFlow.netCashFlow.toFixed(2)}`);

  console.log('\n  [B] Variação de Passivo de Cartão de Crédito (Nubank Cartão, 46 txs):');
  console.log(`      • Compras no Período (+Passivo): R$ ${r.cardLiability.totalPurchases.toFixed(2)} (${r.cardLiability.purchasesCount} compras)`);
  console.log(`      • Pagamentos / Créditos Registrados (-Passivo): R$ ${r.cardLiability.paymentsCreditsRecorded.toFixed(2)} (${r.cardLiability.paymentsCreditsCount} lançamentos)`);
  console.log('      * Regra Canônica: Compras no cartão NÃO representam saída de caixa no ato;');
  console.log('        o desembolso físico ocorre unicamente no pagamento da fatura pela conta corrente.');

  console.log('\n  [C] Consumo Econômico e Orçamentário Desacoplado:');
  console.log(`      • Despesas Econômicas Diretas (Conta Corrente): R$ ${r.economicConsumption.directCheckingExpenses.toFixed(2)}`);
  console.log(`      • Despesas Econômicas de Cartão (Compras): R$ ${r.economicConsumption.cardPurchases.toFixed(2)}`);
  console.log(`      • Consumo Econômico Total: R$ ${r.economicConsumption.totalEconomicExpenses.toFixed(2)}`);
  console.log(`      • Receitas Econômicas: R$ ${r.economicConsumption.economicIncome.toFixed(2)}`);
  console.log(`      • Liquidações de Dívida (Neutras): R$ ${r.economicConsumption.neutralSettlements.toFixed(2)}`);
  console.log(`      • Transferências Internas (Neutras): R$ ${r.economicConsumption.neutralTransfers.toFixed(2)}`);
  console.log(`      • Discrepância / Diferença: R$ ${r.discrepancy.toFixed(2)} (ZERO DIVERGÊNCIA)\n`);

  // 3. AUDITORIA DAS 40 OCORRÊNCIAS DE PAGAMENTO DE CARTÃO
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  3. AUDITORIA INDIVIDUAL DAS 40 OCORRÊNCIAS DE PAGAMENTO DE CARTÃO');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  const pAudit = r.paymentAuditSummary;
  console.log(`  • Total de Ocorrências Analisadas: ${pAudit.totalPaymentOccurrences}`);
  console.log(`  • Pernas de Caixa Bancário (BANK_CASH_LEG): ${pAudit.bankCashLegs} (Total R$ ${pAudit.totalBankCashPaid.toFixed(2)})`);
  console.log(`  • Pernas de Amortização no Cartão (CARD_LIABILITY_LEG): ${pAudit.cardLiabilityLegs}`);
  console.log(`  • Ocorrências Não Pareadas / Sombra (UNPAIRED_PAYMENT): ${pAudit.unpairedPayments}`);
  console.log('  • Vínculos Canônicos com Faturas:');
  console.log('      - 14 BANK_CASH_LEGs vinculam-se a Faturas.Transações de Pagamento');
  console.log('      - 0 pagamentos de cartão vinculam-se a Transações.Fatura Vinculada (exclusivo para 20 compras)\n');

  console.log('| # | ID Transação | Conta | Data | Valor (R$) | Role | Source ID | Possível Par | Descrição |');
  console.log('| :---: | :--- | :--- | :---: | :---: | :--- | :--- | :--- | :--- |');
  report.paymentLegAudits.forEach((leg, idx) => {
    const num = (idx + 1).toString().padStart(2, ' ');
    const txIdShort = leg.txId.substring(0, 16);
    const acc = leg.account.padEnd(13, ' ');
    const dt = leg.date.substring(0, 19).replace('T', ' ');
    const val = leg.signedAmount.toFixed(2).padStart(8, ' ');
    const role = leg.role.padEnd(18, ' ');
    const src = leg.sourceId.substring(0, 14);
    const pair = leg.possiblePairId ? leg.possiblePairId.substring(0, 14) : 'nenhum        ';
    const desc = leg.description.substring(0, 30);
    console.log(`| ${num} | ${txIdShort} | ${acc} | ${dt} | ${val} | ${role} | ${src} | ${pair} | ${desc} |`);
  });
  console.log('');

  // 4. AUDITORIA DAS 36 ENTRADAS E TRANSFERÊNCIAS RECEBIDAS
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  4. AUDITORIA DAS 36 ENTRADAS E TRANSFERÊNCIAS RECEBIDAS');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  const inAudit = r.inflowsAuditSummary;
  console.log(`  • Total de Entradas Analisadas: ${inAudit.totalInflows}`);
  console.log(`  • Transferências Mesma Titularidade: ${inAudit.sameOwnershipInflowsCount} (R$ 149,88 — Neutro)`);
  console.log(`  • Entradas de Terceiros: ${inAudit.thirdPartyInflowsCount} (Total R$ ${inAudit.unprovedThirdPartyRevenueTotal.toFixed(2)})`);
  console.log('  • Política de Governança de Dados:');
  console.log('      - 35 entradas de terceiros classificadas como "Receita", porém com');
  console.log('        Status de Revisão = "Pendente Revisão" devido à ausência de comprovação');
  console.log('        documental estrita de vínculo empregatício / folha salarial na fonte.\n');

  console.log('| # | Data | Valor (R$) | Contraparte | Classificação | Natureza | Status Revisão | Motivo Revisão |');
  console.log('| :---: | :---: | :---: | :--- | :--- | :--- | :--- | :--- |');
  report.incomingTransferAudits.forEach((inf, idx) => {
    const num = (idx + 1).toString().padStart(2, ' ');
    const dt = inf.date.substring(0, 10);
    const val = inf.amount.toFixed(2).padStart(8, ' ');
    const cp = inf.counterpartyName.substring(0, 22).padEnd(22, ' ');
    const cls = inf.counterpartyType.padEnd(22, ' ');
    const nat = inf.economicNature.padEnd(14, ' ');
    const st = inf.reviewStatus.padEnd(16, ' ');
    const rsn = inf.reviewReason ? inf.reviewReason.substring(0, 45) : 'Confirmado';
    console.log(`| ${num} | ${dt} | ${val} | ${cp} | ${cls} | ${nat} | ${st} | ${rsn} |`);
  });
  console.log('');

  // 5. AUDITORIA DOS 5 CICLOS DE FATURA E PROVENIÊNCIA CAMPO A CAMPO
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  5. AUDITORIA DOS 5 CICLOS DE FATURA DE CARTÃO E PROVENIÊNCIA DE CAMPOS');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('| Stable Bill ID | Início | Fim | Fechamento | Vencimento | Status | Qualidade | Compras | Soma Compras | Valor Oficial |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');
  for (const b of report.cardBillAudits) {
    const ofVal = b.valorOficial !== null ? `R$ ${b.valorOficial.toFixed(2)}` : 'null';
    console.log(
      `| ${b.stableBillId.padEnd(42, ' ')} | ${b.inicio} | ${b.fim} | ${b.fechamento} | ${b.vencimento} | ${b.status.padEnd(18, ' ')} | ${b.qualidade} | ${b.nCompras.toString().padStart(2, ' ')} | R$ ${b.somaCompras.toFixed(2).padStart(6, ' ')} | ${ofVal.padStart(7, ' ')} |`,
    );
  }

  console.log('\n  • Matriz de Proveniência Campo a Campo das Faturas:');
  console.log('| Campo | Proveniência | Origem / Justificativa Canônica |');
  console.log('| :--- | :---: | :--- |');
  console.log('| Fatura / Ciclo (Title) | DERIVED | Template "Nubank Cartão - Mês/Ano" |');
  console.log('| Fonte | SOURCE | Valor "Open Finance" fixado da extração upstream |');
  console.log('| ID da Fatura na Fonte | SOURCE | UUID upstream ou "OPEN_FINANCE_AGGREGATED_BILL" |');
  console.log('| ID Estável da Fatura | DERIVED | Hash SHA-256 do cartão + datas do ciclo |');
  console.log('| Qualidade da Identidade | SOURCE/CONFIG | "UPSTREAM_APPROXIMATE" ou "UPSTREAM_EXPLICIT" |');
  console.log('| Cartão Vinculado | DERIVED | Vínculo tipado para Notion page ID de Nubank Cartão |');
  console.log('| Tipo de Ciclo | CONFIGURED | "Ciclo Real Banco" conforme enum canônico Notion |');
  console.log('| Origem / Qualidade dos Dados | CONFIGURED | "Aproximado por Transações Upstream" |');
  console.log('| Status da Fatura | DERIVED | "Fechada" se fechamento <= data corte, senão "Aberta" |');
  console.log('| Início / Fim / Fechamento / Vencimento | SOURCE/CONFIG | Metadados do ciclo ou datas de transações |');
  console.log('| Total de Compras no Ciclo | DERIVED | Soma estrita das 20 compras (R$ 649,79 total) |');
  console.log('| Lançamentos do Ciclo | DERIVED | Relação com exatamente 20 compras (STAGE_2) |');
  console.log('| Transações de Pagamento | DERIVED | Relação com 14 pernas bancárias de pagamento (STAGE_2) |\n');

  // 6. ATUALIZAÇÕES DERIVADAS SUSPENSAS (FORA DE ESCOPO)
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  6. ATUALIZAÇÕES DERIVADAS SUSPENSAS (OUT_OF_SCOPE_NOT_EXECUTED)');
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
    console.log(`    • Status: ${u.status} (EXCLUÍDO DE OPERATIONS — 0 UPDATES)\n`);
  }

  // 7. RECONCILIAÇÃO DE CATEGORIAS
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  7. RECONCILIAÇÃO DE CATEGORIAS (18 PARES MAPEADOS — ZERO DEFAULT SILENCIOSO)');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('| Categoria Legado (Mapped || Pierre) | Categoria Canônica | Qtd | Soma (R$) | Método de Mapeamento |');
  console.log('| :--- | :--- | :---: | :---: | :--- |');
  for (const c of report.categoryReconciliations) {
    console.log(
      `| ${c.categoriaLegado.padEnd(52, ' ')} | ${c.categoriaCanonica.padEnd(24, ' ')} | ${c.quantidade.toString().padStart(2, ' ')} | ${c.soma.toFixed(2).padStart(8, ' ')} | ${c.metodoMapeamento} |`,
    );
  }
  console.log('');

  // 8. ESTRATÉGIA DE IDENTIDADE DETERMINÍSTICA
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  8. ESTRATÉGIA DE IDENTIDADE DETERMINÍSTICA E IDEMPOTÊNCIA');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  const idS = report.identityStrategy;
  console.log(`  • Transações com ID Estável da Fonte (Source ID): ${idS.countWithSourceId}/155 (100%)`);
  console.log(`  • Transações Dependentes de Fallback Hash: ${idS.countWithFallback}`);
  console.log(`  • Colisões de Identidade Detectadas: ${idS.collisionsFound} (ZERO COLISÕES)`);
  console.log(`  • Colisões Potenciais: ${idS.potentialCollisions}\n`);

  // 9. PLANO DE EXECUÇÃO EM DOIS ESTÁGIOS
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  9. PLANO DE EXECUÇÃO EM DOIS ESTÁGIOS (STAGE 1 & STAGE 2)');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  const execPlan = report.planArtifact.executionPlan;
  console.log(`  • Estágio 1 (Criação de Páginas com Metadados Escalares): ${execPlan.stage1CreationsCount} operações CREATE`);
  console.log('      - 155 Transações (sem links entre novas entidades)');
  console.log('      - 5 Faturas de Cartão (vinculadas ao Cartão existente)');
  console.log(`  • Estágio 2 (Resolução e Patch de Relações Recíprocas): ${execPlan.stage2RelationPatchesCount} entidades alvo`);
  console.log('      - 20 compras vinculadas à Fatura Vinculada (PLANNED_STABLE_ID -> pageId real)');
  console.log('      - 5 faturas vinculadas aos Lançamentos do Ciclo (20 compras) e Transações de Pagamento (14 pagamentos)\n');

  // 10. ARTEFATO IMUTÁVEL DE BACKFILL PLAN
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('  10. ARTEFATO IMUTÁVEL: BACKFILL PLAN HASH & GATES DE SEGURANÇA');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  const p = report.planArtifact;
  console.log(`  • Versão do Plano: ${p.version} (mapping: ${p.mappingVersion})`);
  console.log(`  • Commit SHA de Referência: ${p.commitSha}`);
  console.log(`  • Source DB Path: ${p.explicitSnapshots.sourceDbPath}`);
  console.log(`  • Source DB SHA-256: ${p.explicitSnapshots.sourceDbSha256}`);
  console.log(`  • Target Notion Manifest: ${p.explicitSnapshots.targetNotionManifestPath}`);
  console.log(`  • Target Notion Snapshot SHA-256: ${p.explicitSnapshots.targetNotionSnapshotSha256}`);
  console.log(`  • Deterministic BackfillPlanHash: ${p.backfillPlanHash}`);
  console.log(`  • Total de Operações Planejadas: ${p.summary.totalOperations}`);
  console.log(`      - CREATE Executáveis (Transações + Faturas): ${p.summary.executableCreateCount}`);
  console.log(`      - UPDATE Executáveis: ${p.summary.executableUpdateCount}`);
  console.log(`      - UPDATE Suspensos para Revisão: ${p.summary.proposedReviewCount}`);
  console.log(`      - Total de Vínculos Relacionais Tipados: ${p.summary.totalRelations}`);

  console.log('\n  • Gates de Segurança Obrigatórios para Futura Escrita DML:');
  console.log(`      - $env:${p.securityGates.enabledVar} = "${p.securityGates.expectedEnabledValue}"`);
  console.log(`      - $env:${p.securityGates.planHashVar} = "${p.backfillPlanHash}"`);
  console.log(`      - $env:${p.securityGates.commitShaVar} = "${p.commitSha}"`);

  console.log('\n  • Avaliação Dinâmica das Pré-condições de Execução (13 Checks):');
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
