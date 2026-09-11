import path from 'path';
import dotenv from 'dotenv';
import { NotionSchemaValidator } from '../src/notion/schema-validator';

dotenv.config();

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Fase 0: Introspecção de Schemas do Notion (Data Sources API)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const apiKey = process.env.NOTION_API_KEY?.trim();
  const validator = new NotionSchemaValidator(apiKey);

  const report = await validator.runIntrospection(process.env as Record<string, string | undefined>);

  const outputPath = path.resolve(process.cwd(), 'architecture', 'notion-schema-delta.md');
  validator.writeReportToMarkdown(report, outputPath);

  console.log(`✅ Manifesto de Schema-Delta gerado com sucesso em:`);
  console.log(`   ${outputPath}\n`);

  console.log(`Resumo dos Data Sources (Canônicos: ${report.totalCanonical}, Esperados Existentes: ${report.expectedExisting}):`);
  console.log(`  • Bases Verificadas com Sucesso na API: ${report.verifiedCount}/${report.expectedExisting}`);
  console.log(`  • Bases com ID Configurado no Ambiente: ${report.configuredCount}/${report.expectedExisting}`);
  console.log(`  • Bases Não Verificadas / Falhas: ${report.failedCount}`);
  console.log(`  • Base Nova Proposta (a criar externamente): 1\n`);

  for (const [key, diff] of Object.entries(report.results)) {
    const icon =
      diff.status === 'CONFIGURED_AND_VERIFIED'
        ? '✅'
        : diff.status === 'PROPOSED_NEW_DATABASE'
          ? '🆕'
          : diff.status === 'UNVERIFIED_NO_KEY'
            ? '❓'
            : '⚠️';
    console.log(`  ${icon} [${diff.status}] ${diff.title} (${diff.envKey})`);
  }

  console.log('\nConsulte o relatório completo em architecture/notion-schema-delta.md');
}

main().catch((err) => {
  console.error('Erro na execução da introspecção:', err);
  process.exit(1);
});
