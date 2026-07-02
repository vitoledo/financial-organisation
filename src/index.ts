import { Command } from 'commander';
import { loadConfig } from './config';
import { SyncEngine, SyncOptions } from './sync/engine';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('financial-sync')
  .description('Sincroniza dados do Pierre API → SQLite → Google Sheets')
  .version('1.0.0')
  .option('--full', 'Resync completo (3 meses retroativos)', false)
  .option('--dry-run', 'Simula sem gravar no SQLite ou Google Sheets', false)
  .option('--skip-update', 'Pula o manual-update do Pierre', false)
  .option('--setup-only', 'Apenas cria/configura a planilha, sem sincronizar dados', false)
  .action(async (opts) => {
    // Load config
    const config = loadConfig();

    // Setup logger
    const logDir = path.dirname(config.logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logger = pino(
      {
        level: 'info',
        transport: {
          targets: [
            {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'HH:MM:ss',
                ignore: 'pid,hostname',
              },
              level: 'info',
            },
            {
              target: 'pino/file',
              options: { destination: config.logPath, mkdir: true },
              level: 'info',
            },
          ],
        },
      },
    );

    const options: SyncOptions = {
      fullSync: opts.full,
      dryRun: opts.dryRun,
      skipUpdate: opts.skipUpdate,
      setupOnly: opts.setupOnly,
    };

    const engine = new SyncEngine(config, logger);

    try {
      await engine.run(options);
      process.exit(0);
    } catch (err) {
      logger.error(err as Error, 'Fatal error');
      process.exit(1);
    }
  });

program.parse();
