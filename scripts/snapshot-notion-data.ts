import dotenv from 'dotenv';
import { NotionLiveDataSnapshotManager } from '../src/notion/migration-runner/data-snapshot';

dotenv.config();

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  SNAPSHOT DE DADOS LIVE DO NOTION — AUDITORIA E BACKUP CRIPTOGRAFADO');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  const manager = new NotionLiveDataSnapshotManager();

  console.log('Iniciando leitura paginada de registros em todas as 13 bases de dados canônicas...');
  const result = await manager.captureLiveSnapshot();

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('  RELATÓRIO DE AUDITORIA DO SNAPSHOT DE DADOS LIVE');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`Timestamp: ${result.timestamp}`);
  console.log(`Arquivo Criptografado: ${result.backupPath}`);
  console.log(`Manifesto Sidecar: ${result.manifestPath}`);
  console.log(`Tamanho Original (JSON Plaintext): ${(result.originalSizeBytes / 1024).toFixed(2)} KB`);
  console.log(`Tamanho Criptografado (AES-256-GCM): ${(result.encryptedSizeBytes / 1024).toFixed(2)} KB`);
  console.log(`SHA-256 (Plaintext): ${result.originalJsonSha256}`);
  console.log(`SHA-256 (Criptografado): ${result.encryptedHashSha256}`);
  console.log(`Teste de Restauração Automatizada: ${result.verifiedRestoration ? '✅ APROVADO' : '❌ FALHOU'}\n`);

  console.log('Contagem de Registros por Data Source Canônico (Total de Bases: 13):');
  for (const [key, base] of Object.entries(result.metadata.summaryByDataSource)) {
    console.log(`  • ${base.title.padEnd(36)} [${key}]: ${base.recordCount} registros (ID: ${base.dataSourceId})`);
  }

  console.log('\nReconciliação e Totais Consolidados do Workspace:');
  const t = result.metadata.reconciliationTotals;
  console.log(`  • Total Geral de Páginas no Notion: ${t.totalRecords}`);
  console.log(`  • Contas Bancárias / Cartões: ${t.accountsCount}`);
  console.log(`  • Transações Existentes no Notion: ${t.transactionsCount}`);
  console.log(`  • Categorias Financeiras: ${t.categoriesCount}`);
  console.log(`  • Regras de Classificação: ${t.rulesCount}`);
  console.log(`  • Contas Fixas: ${t.fixedBillsCount}`);
  console.log(`  • Obrigações Mensais: ${t.monthlyObligationsCount}`);
  console.log(`  • Investimentos / Ativos: ${t.investmentsCount}`);
  console.log(`  • Movimentações de Investimentos: ${t.investmentMovementsCount}`);
  console.log(`  • Meses de Planejamento Orçamentário: ${t.monthlyBudgetCount}`);
  console.log(`  • Metas Financeiras: ${t.financialGoalsCount}`);
  console.log(`  • Fechamentos Mensais: ${t.monthlyClosingsCount}`);
  console.log(`  • Logs de Sincronização: ${t.syncLogCount}`);
  console.log(`  • Faturas / Ciclos de Cartão: ${t.cardBillsCount}`);

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('  SNAPSHOT DE DADOS CONCLUÍDO E PRESERVADO FORA DO NOTION COM SUCESSO');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('Erro fatal ao capturar snapshot de dados live:', err);
  process.exit(1);
});
