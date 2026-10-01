import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { Client } from '@notionhq/client';
import { PierreClient } from '../../pierre/client';
import { getDatabase, closeDatabase } from '../../storage';
import { loadNotionSyncConfig } from './config';
import { Logger, NotionSyncEngine, NotionSyncError, NotionSyncReport } from './engine';
import { NotionSyncGateway } from './notion-gateway';

const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

// With --json, stdout carries only the report; progress goes to stderr.
const jsonMode = process.argv.includes('--json');
const logger: Logger = {
  info: (msg) => (jsonMode ? console.error : console.log)(`${new Date().toISOString().substring(11, 19)} ${msg}`),
  warn: (msg, meta) => console.warn(`${new Date().toISOString().substring(11, 19)} ⚠ ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
  error: (msg, meta) => console.error(`${new Date().toISOString().substring(11, 19)} ✖ ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
};

/** One run at a time: two concurrent runs could both decide a page is missing and create it twice. */
function acquireLock(dataDir: string): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const lock = path.join(dataDir, 'notion-sync.lock');
  if (fs.existsSync(lock)) {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age < LOCK_STALE_MS) throw new Error(`FAIL_CLOSED_LOCKED: outra sincronização com o Notion está em andamento (${lock}).`);
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }));
  return () => fs.rmSync(lock, { force: true });
}

function printReport(r: NotionSyncReport): void {
  logger.info('───────────────────────────────────────────────');
  logger.info(`Modo: ${r.mode === 'APPLY' ? 'GRAVAÇÃO' : 'SIMULAÇÃO (nada foi gravado; use --apply)'} · status ${r.status} · run ${r.runId}`);
  if (r.pierre) {
    logger.info(`Pierre: ${r.pierre.accounts} contas, ${r.pierre.transactionsReceived} transações (${r.pierre.window?.startDate} → ${r.pierre.window?.endDate})`);
  }
  logger.info(`Lançamentos até: ${r.freshness ?? '—'}`);
  const p = r.plan;
  logger.info(`Transações: ${p.txCreates} novas · ${p.txSourceUpdates} atualizadas pela fonte · ${p.txReclassified} classificadas por regra · ${p.unchangedTransactions} sem alteração`);
  logger.info(`Faturas: ${p.billCreates} novas · ${p.billUpdates} atualizadas   Contas: ${p.accountUpdates} atualizadas`);
  for (const [rule, n] of Object.entries(p.rulesApplied)) logger.info(`  regra "${rule}": ${n}`);
  if (r.mode === 'APPLY') {
    logger.info(`Gravações: ${r.applied.writes} · erros: ${r.applied.errors.length}`);
    if (r.residual) logger.info(`Reverificação: ${JSON.stringify(r.residual)} (esperado tudo 0)`);
  }
  if (r.pendingReview !== null) logger.info(`Pendentes de revisão no Notion: ${r.pendingReview}`);
  for (const w of r.warnings) logger.warn(w);
  for (const e of r.applied.errors) logger.error(e);
}

function writeHeartbeat(dataDir: string, payload: Record<string, unknown>): void {
  try {
    fs.writeFileSync(path.join(dataDir, 'last-notion-sync.json'), JSON.stringify({ ...payload, host: os.hostname() }, null, 2));
  } catch {
    // The heartbeat is a convenience; never fail the run because of it.
  }
}

const program = new Command();
program
  .name('notion-sync')
  .description('Sincroniza Pierre → SQLite → Notion (Transações, Faturas, Contas e Log de Sincronização)')
  .option('--apply', 'Grava no Notion. Sem esta flag o comando só simula e mostra o que mudaria.', false)
  .option('--skip-pierre', 'Não chama o Pierre: projeta o histórico local do SQLite no Notion.', false)
  .option('--skip-update', 'Não dispara o manual-update do Pierre antes de ler.', false)
  .option('--full', 'Busca os últimos 3 meses no Pierre em vez da janela incremental.', false)
  .option('--allow-large', 'Permite criar mais páginas que NOTION_SYNC_MAX_CREATES numa execução.', false)
  .option('--json', 'Imprime o relatório completo em JSON.', false)
  .action(async (opts) => {
    const startedAt = new Date().toISOString();
    let release: (() => void) | null = null;
    let dataDir = path.resolve(process.cwd(), process.env.DATA_DIR ?? 'data');
    try {
      const config = loadNotionSyncConfig();
      dataDir = config.dataDir;
      release = acquireLock(dataDir);
      if (!opts.skipPierre && !config.pierreApiKey) throw new Error('FAIL_CLOSED_ENV: PIERRE_API_KEY ausente (ou use --skip-pierre).');

      const notion = new Client({ auth: config.notionApiKey, notionVersion: '2026-03-11' } as any);
      const engine = new NotionSyncEngine(
        config.settings,
        {
          gateway: new NotionSyncGateway(notion, config.ds),
          db: getDatabase(config.dbPath),
          pierre: opts.skipPierre ? null : new PierreClient({ apiKey: config.pierreApiKey!, baseUrl: config.pierreApiUrl, logger }),
        },
        logger,
      );
      const report = await engine.run({
        apply: Boolean(opts.apply),
        skipPierre: Boolean(opts.skipPierre),
        skipUpdate: Boolean(opts.skipUpdate),
        fullSync: Boolean(opts.full),
        allowLarge: Boolean(opts.allowLarge),
      });
      printReport(report);
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      // Only --apply runs feed the container healthcheck; a manual simulation must not mask the scheduled state.
      if (opts.apply) writeHeartbeat(dataDir, { status: report.status, mode: report.mode, startedAt, finishedAt: new Date().toISOString(), runId: report.runId });
      closeDatabase();
      release();
      process.exit(report.status === 'PARTIAL' ? 2 : 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(message);
      if (err instanceof NotionSyncError && opts.json) console.log(JSON.stringify(err.report, null, 2));
      // A run refused by the lock leaves the heartbeat to the run that holds it.
      if (opts.apply && !message.startsWith('FAIL_CLOSED_LOCKED')) {
        writeHeartbeat(dataDir, { status: 'failure', startedAt, finishedAt: new Date().toISOString(), error: message });
      }
      try {
        closeDatabase();
      } catch {
        // already closed or never opened
      }
      release?.();
      process.exit(1);
    }
  });

program.parseAsync().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
