import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { Command } from 'commander';
import { MigrationRunner } from '../src/notion/migration-runner';

dotenv.config();

const program = new Command();

program
  .name('migrate-notion')
  .description('Notion Schema & Backfill Migration Runner (Dry-run by default)')
  .option('-m, --mode <mode>', 'Modo de execução (dry-run | apply | recovery-preflight | recovery)', 'dry-run')
  .option('--plan-hash <hash>', 'SHA-256 planHash obrigatório para modo apply / recovery')
  .option('--output-plan <path>', 'Caminho opcional para exportar o plano completo em formato JSON')
  .option('--recovery-preflight', 'Atalho para executar recovery-preflight (estritamente read-only)')
  .action(async (options) => {
    try {
      let mode = (options.mode || 'dry-run').toLowerCase();
      if (options.recoveryPreflight) {
        mode = 'recovery-preflight';
      }

      const validModes = ['dry-run', 'apply', 'recovery', 'recovery-preflight'];
      if (!validModes.includes(mode)) {
        console.error(`Modo inválido: '${mode}'. Utilize 'dry-run', 'apply', 'recovery-preflight' ou 'recovery'.`);
        process.exit(1);
      }

      const runner = new MigrationRunner({
        mode,
        planHash: options.planHash,
      });

      const report = await runner.execute(options.planHash);

      // Print human-readable report
      console.log(runner.formatReport(report));

      // Optionally output complete plan to JSON file
      if (options.outputPlan && 'plan' in report && report.plan) {
        const targetPath = path.resolve(process.cwd(), options.outputPlan);
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(targetPath, JSON.stringify(report.plan, null, 2), 'utf8');
        console.log(`\n📄 Plano completo exportado com sucesso para:\n   ${targetPath}`);
      }
    } catch (err: any) {
      console.error('\n❌ ERRO NA EXECUÇÃO DO MIGRATION RUNNER:');
      console.error(err.message || err);
      process.exit(1);
    }
  });

program.parse(process.argv);
