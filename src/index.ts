import { Command } from 'commander';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig, AppConfig } from './config';
import { SyncEngine, SyncOptions } from './sync/engine';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function buildLogger(config: AppConfig): pino.Logger {
  const targets: pino.TransportTargetOptions[] = [
    {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      level: 'info',
    },
  ];

  // In a container, stdout is captured and rotated by the Docker log driver, so
  // the on-disk file transport (which does not rotate) is left off by default.
  if (config.logToFile) {
    const logDir = path.dirname(config.logPath);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    targets.push({
      target: 'pino/file',
      options: { destination: config.logPath, mkdir: true },
      level: 'info',
    });
  }

  return pino({ level: 'info', transport: { targets } });
}

// ---------------------------------------------------------------------------
// Heartbeat — machine-readable "did it run, and did it work" for the
// healthcheck. Written on every terminal path so an unattended job can be
// monitored without parsing logs.
// ---------------------------------------------------------------------------

function writeHeartbeat(dataDir: string, payload: Record<string, unknown>): void {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'last-run.json'),
      JSON.stringify({ ...payload, host: os.hostname() }, null, 2),
    );
  } catch {
    // Heartbeat is best-effort; never mask the real exit status.
  }
}

// ---------------------------------------------------------------------------
// CLI
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
    const options: SyncOptions = {
      fullSync: opts.full,
      dryRun: opts.dryRun,
      skipUpdate: opts.skipUpdate,
      setupOnly: opts.setupOnly,
    };

    const startedAt = new Date().toISOString();
    // loadConfig/buildLogger are inside the try so a config error (e.g. a
    // missing env var on first boot — the most likely production failure)
    // still logs, writes a failure heartbeat, and exits 1, instead of escaping
    // as an unhandled rejection.
    let logger: pino.Logger | undefined;
    let dataDir: string | undefined;

    try {
      const config = loadConfig();
      dataDir = config.dataDir;
      logger = buildLogger(config);

      await new SyncEngine(config, logger).run(options);

      // A --setup-only run is not a data sync; leave the heartbeat untouched so
      // it keeps reflecting the last real sync.
      if (!options.setupOnly) {
        writeHeartbeat(dataDir, {
          status: 'success', startedAt, finishedAt: new Date().toISOString(), exitCode: 0,
        });
      }
      process.exit(0);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (logger) logger.error(error, 'Fatal error');
      else console.error('Fatal error:', error.message);

      // Only overwrite the heartbeat for real syncs, and only once we know
      // where to write it — a failed --setup-only run must not flip the
      // healthcheck for the healthy scheduled pipeline.
      if (dataDir && !options.setupOnly) {
        writeHeartbeat(dataDir, {
          status: 'failure', startedAt, finishedAt: new Date().toISOString(),
          exitCode: 1, error: error.message,
        });
      }
      process.exit(1);
    }
  });

// parseAsync so a rejection from the async action is caught here rather than
// becoming an unhandled rejection (the action already exits the process on both
// paths; this is the last-resort net for anything thrown before it can).
program.parseAsync().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
