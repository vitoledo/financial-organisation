import Database from 'better-sqlite3';
import { Auth } from 'googleapis';
import { PierreClient, PierreClientConfig } from '../pierre/client';
import {
  normalizeTransaction,
  normalizeAccount,
  shouldExcludeAccount,
  NormalizedTransaction,
} from '../pierre/normalizer';
import { PierrePurchasesByCard } from '../pierre/types';
import { getDatabase, closeDatabase, Repository } from '../storage';
import {
  getAuthClient,
  SheetsClient,
  setupSpreadsheet,
  SheetsRenderer,
  GoogleAuthConfig,
  SetupResult,
} from '../sheets';
import { AppConfig } from '../config';

// ---------------------------------------------------------------------------
// Sync options
// ---------------------------------------------------------------------------

export interface SyncOptions {
  fullSync: boolean;     // Ignore last sync date, pull 3 months
  dryRun: boolean;       // Don't write to Sheets or SQLite
  skipUpdate: boolean;   // Skip Pierre manual-update
  setupOnly: boolean;    // Only setup the spreadsheet, don't sync data
}

// ---------------------------------------------------------------------------
// Injectable dependencies — defaults are the real implementations; tests
// replace them with fakes to exercise the orchestration against in-memory data.
// ---------------------------------------------------------------------------

export interface SyncEngineDeps {
  getAuthClient: (config: GoogleAuthConfig) => Promise<Auth.OAuth2Client>;
  setupSpreadsheet: (
    auth: Auth.OAuth2Client,
    idFilePath: string,
    logger?: { info: (msg: string) => void },
  ) => Promise<SetupResult>;
  createSheetsClient: (auth: Auth.OAuth2Client, spreadsheetId: string) => SheetsClient;
  createPierreClient: (config: PierreClientConfig) => PierreClient;
  getDatabase: (dbPath?: string) => Database.Database;
  closeDatabase: () => void;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_DEPS: SyncEngineDeps = {
  getAuthClient,
  setupSpreadsheet,
  createSheetsClient: (auth, spreadsheetId) => new SheetsClient(auth, spreadsheetId),
  createPierreClient: (config) => new PierreClient(config),
  getDatabase,
  closeDatabase,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const PIERRE_SYNC_WAIT_MS = 30_000;
const INCREMENTAL_OVERLAP_DAYS = 3;
const FULL_SYNC_MONTHS = 3;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Compute the transaction fetch window.
 * - Full sync (or no previous sync): FULL_SYNC_MONTHS back from now.
 * - Incremental: INCREMENTAL_OVERLAP_DAYS before the last successful sync,
 *   to catch late-posted updates.
 */
export function calculateDateRange(
  lastSyncCompletedAt: string | null,
  fullSync: boolean,
  now: Date = new Date(),
): { startDate: string; endDate: string } {
  const endDate = now.toISOString().split('T')[0];

  if (!fullSync && lastSyncCompletedAt) {
    const start = parseSqliteUtc(lastSyncCompletedAt);
    start.setUTCDate(start.getUTCDate() - INCREMENTAL_OVERLAP_DAYS);
    return { startDate: start.toISOString().split('T')[0], endDate };
  }

  const start = new Date(now);
  start.setMonth(start.getMonth() - FULL_SYNC_MONTHS);
  return { startDate: start.toISOString().split('T')[0], endDate };
}

/**
 * Parse a SQLite `datetime('now')` value ("YYYY-MM-DD HH:MM:SS", UTC, no zone
 * suffix). Left as-is, `new Date()` reads it in the host's local time, which
 * under TZ=America/Sao_Paulo shifts it +3h and can silently shrink the overlap
 * window near a day boundary. An explicit "Z" (when no zone is present) keeps it
 * in UTC. ISO strings that already carry a zone pass through unchanged.
 */
function parseSqliteUtc(value: string): Date {
  const hasZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value.trim());
  const normalized = hasZone ? value.trim() : `${value.trim().replace(' ', 'T')}Z`;
  return new Date(normalized);
}

export interface FlatInstallment {
  id: string;
  purchaseDescription: string;
  installmentNumber: number;
  totalInstallments: number;
  amount: number;
  dueDate: string;
  isPaid: boolean;
  isProjected: boolean;
  accountId: string;
  accountName: string;
}

/**
 * Flatten Pierre's purchases-by-card structure into installment rows.
 * IDs are deterministic within a snapshot (the installments table is fully
 * replaced each sync) and unique across cards and repeated purchases.
 */
export function flattenInstallments(
  purchasesByCard: PierrePurchasesByCard[],
): FlatInstallment[] {
  const result: FlatInstallment[] = [];

  for (const card of purchasesByCard) {
    (card.purchases ?? []).forEach((purchase, purchaseIndex) => {
      for (const inst of purchase.installments ?? []) {
        result.push({
          id: `${card.accountId}:${purchaseIndex}:${inst.installmentNumber}/${inst.totalInstallments}`,
          purchaseDescription: purchase.description,
          installmentNumber: inst.installmentNumber,
          totalInstallments: inst.totalInstallments,
          amount: inst.amount,
          dueDate: inst.dueDate,
          isPaid: inst.isPaid,
          isProjected: inst.isProjected,
          accountId: card.accountId,
          accountName: card.accountName,
        });
      }
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Sync engine — orchestrates the entire pipeline
// ---------------------------------------------------------------------------

export class SyncEngine {
  private config: AppConfig;
  private logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  private deps: SyncEngineDeps;

  constructor(
    config: AppConfig,
    logger: SyncEngine['logger'],
    deps: Partial<SyncEngineDeps> = {},
  ) {
    this.config = config;
    this.logger = logger;
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  async run(options: SyncOptions): Promise<void> {
    const startTime = Date.now();
    this.logger.info('═══════════════════════════════════════════════');
    this.logger.info('  Financeiro — Sincronização Iniciada');
    this.logger.info('═══════════════════════════════════════════════');
    this.logger.info(`  Modo: ${options.dryRun ? 'DRY RUN' : options.fullSync ? 'FULL SYNC' : 'INCREMENTAL'}`);

    let repo: Repository | null = null;
    let syncId: number | null = null;

    try {
      // 1. Setup Google Sheets auth + spreadsheet
      this.logger.info('\n[1/8] Autenticando com Google Sheets...');
      const auth = await this.deps.getAuthClient({
        clientId: this.config.googleClientId,
        clientSecret: this.config.googleClientSecret,
        tokensPath: this.config.tokensPath,
        headless: this.config.headless,
        logger: this.logger,
      });

      const { spreadsheetId, spreadsheetUrl } = await this.deps.setupSpreadsheet(
        auth,
        this.config.spreadsheetIdPath,
        this.logger,
      );

      if (options.setupOnly) {
        this.logger.info(`\n✅ Setup completo! Planilha: ${spreadsheetUrl}`);
        return;
      }

      const sheetsClient = this.deps.createSheetsClient(auth, spreadsheetId);

      // 2. Initialize SQLite
      this.logger.info('\n[2/8] Inicializando banco de dados...');
      const db = this.deps.getDatabase(this.config.dbPath);
      repo = new Repository(db);

      if (!options.dryRun) {
        syncId = repo.startSync();
      }

      // 3. Read category mappings from Google Sheets
      this.logger.info('\n[3/8] Lendo configurações da planilha...');
      const renderer = new SheetsRenderer(sheetsClient, repo, this.logger);
      const categoryMappings = await renderer.readCategoryMappings();
      this.logger.info(`  ${categoryMappings.size} mapeamentos de categoria carregados.`);

      // 4. Trigger Pierre manual-update
      const pierreClient = this.deps.createPierreClient({
        apiKey: this.config.pierreApiKey,
        baseUrl: this.config.pierreApiUrl,
        logger: this.logger,
      });

      if (!options.skipUpdate) {
        this.logger.info('\n[4/8] Sincronizando dados no Pierre...');
        try {
          await pierreClient.triggerManualUpdate();
          this.logger.info('  Aguardando 30s para o Pierre sincronizar com os bancos...');
          await this.deps.sleep(PIERRE_SYNC_WAIT_MS);
        } catch (err) {
          this.logger.warn('  manual-update falhou (continuando com dados existentes)', {
            error: (err as Error).message,
          });
        }
      } else {
        this.logger.info('\n[4/8] Pulando manual-update (--skip-update)');
      }

      // 5. Fetch accounts
      this.logger.info('\n[5/8] Buscando contas...');
      const accountsResponse = await pierreClient.getAccounts();
      const allAccounts = accountsResponse.data;

      const relevantAccounts = allAccounts.filter((a) => !shouldExcludeAccount(a));
      this.logger.info(`  ${allAccounts.length} contas encontradas, ${relevantAccounts.length} relevantes.`);

      if (!options.dryRun) {
        for (const account of relevantAccounts) {
          repo.upsertAccount(normalizeAccount(account));
        }
      }

      // 6. Fetch transactions
      this.logger.info('\n[6/8] Buscando transações...');
      // The current run's row is RUNNING, so getLastSuccessfulSync never
      // returns it — it yields the previous successful sync, as intended.
      const lastSync = repo.getLastSuccessfulSync();
      const { startDate, endDate } = calculateDateRange(
        lastSync?.completed_at ?? null,
        options.fullSync,
      );
      this.logger.info(`  Período: ${startDate} → ${endDate}`);

      const txResponse = await pierreClient.getTransactions(startDate, endDate);
      const rawTransactions = txResponse.data;
      this.logger.info(`  ${rawTransactions.length} transações recebidas da API.`);

      // Filter out transactions from excluded accounts
      const relevantAccountIds = new Set(relevantAccounts.map((a) => a.id));
      const filteredTx = rawTransactions.filter((tx) => relevantAccountIds.has(tx.account_id));

      const normalizedTx: NormalizedTransaction[] = filteredTx.map(normalizeTransaction);
      this.logger.info(`  ${normalizedTx.length} transações após filtros.`);

      let stats = { added: 0, updated: 0, unchanged: 0 };
      if (!options.dryRun) {
        stats = repo.upsertTransactions(normalizedTx, categoryMappings);
        this.logger.info(`  Adicionadas: ${stats.added}, Atualizadas: ${stats.updated}, Sem alteração: ${stats.unchanged}`);
      } else {
        this.logger.info('  [DRY RUN] Nenhuma transação gravada.');
      }

      // 7. Fetch installments.
      // The FETCH is best-effort: parcelas are already retried inside the
      // client, and a persistent fetch failure should not sink the whole sync —
      // we keep the previously stored parcelas. But the TRANSFORM and DB WRITE
      // run outside the catch on purpose: a bug there (or a failed SQLite write)
      // must surface and fail the sync loudly, instead of being mislabeled as
      // "falha ao buscar" and silently reported as SUCCESS.
      this.logger.info('\n[7/8] Buscando parcelas...');
      let purchasesByCard: PierrePurchasesByCard[] | null = null;
      try {
        const installmentsResponse = await pierreClient.getInstallments();
        purchasesByCard = installmentsResponse.data?.purchasesByCard ?? [];
      } catch (err) {
        this.logger.warn('  Falha ao BUSCAR parcelas (mantendo as existentes)', {
          error: (err as Error).message,
        });
      }

      if (purchasesByCard !== null && !options.dryRun) {
        const installments = flattenInstallments(purchasesByCard);
        if (installments.length > 0) {
          repo.replaceInstallments(installments);
          this.logger.info(`  ${installments.length} parcelas processadas.`);
        } else {
          this.logger.info('  Nenhuma parcela encontrada.');
        }
      }

      // 8. Render to Google Sheets
      if (!options.dryRun) {
        this.logger.info('\n[8/8] Atualizando planilha...');
        await renderer.renderAll();

        if (syncId !== null) {
          repo.completeSync(syncId, stats);
        }
      } else {
        this.logger.info('\n[8/8] [DRY RUN] Planilha não atualizada.');
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.info('\n═══════════════════════════════════════════════');
      this.logger.info(`  ✅ Sincronização concluída em ${elapsed}s`);
      if (!options.dryRun) {
        this.logger.info(`  📊 Planilha: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
      }
      this.logger.info('═══════════════════════════════════════════════\n');

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error(`Sincronização falhou: ${error.message}`, { stack: error.stack });

      if (repo !== null && syncId !== null) {
        try {
          repo.failSync(syncId, error.message);
        } catch (logErr) {
          this.logger.error('Falha ao registrar o erro no sync_log', {
            error: (logErr as Error).message,
          });
        }
      }

      throw error;
    } finally {
      // Guarded like failSync above: a close failure (e.g. a WAL checkpoint I/O
      // error under disk pressure) must not replace the real error propagating
      // out of the catch.
      try {
        this.deps.closeDatabase();
      } catch (closeErr) {
        this.logger.error('Falha ao fechar o banco de dados', {
          error: (closeErr as Error).message,
        });
      }
    }
  }
}
