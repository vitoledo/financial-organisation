import { PierreClient } from '../pierre/client';
import {
  normalizeTransaction,
  normalizeAccount,
  shouldExcludeAccount,
  NormalizedTransaction,
} from '../pierre/normalizer';
import { PierreAccount, PierrePurchase } from '../pierre/types';
import { getDatabase, closeDatabase, Repository } from '../storage';
import { CategoryMapping } from '../storage/repository';
import { getAuthClient, SheetsClient, setupSpreadsheet, SheetsRenderer } from '../sheets';
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
// Sync engine — orchestrates the entire pipeline
// ---------------------------------------------------------------------------

export class SyncEngine {
  private config: AppConfig;
  private logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };

  constructor(config: AppConfig, logger: SyncEngine['logger']) {
    this.config = config;
    this.logger = logger;
  }

  async run(options: SyncOptions): Promise<void> {
    const startTime = Date.now();
    this.logger.info('═══════════════════════════════════════════════');
    this.logger.info('  Financeiro — Sincronização Iniciada');
    this.logger.info('═══════════════════════════════════════════════');
    this.logger.info(`  Modo: ${options.dryRun ? 'DRY RUN' : options.fullSync ? 'FULL SYNC' : 'INCREMENTAL'}`);

    try {
      // 1. Setup Google Sheets auth + spreadsheet
      this.logger.info('\n[1/8] Autenticando com Google Sheets...');
      const auth = await getAuthClient({
        clientId: this.config.googleClientId,
        clientSecret: this.config.googleClientSecret,
        tokensPath: this.config.tokensPath,
        logger: this.logger,
      });

      const { spreadsheetId, spreadsheetUrl } = await setupSpreadsheet(
        auth,
        this.config.spreadsheetIdPath,
        this.logger,
      );

      if (options.setupOnly) {
        this.logger.info(`\n✅ Setup completo! Planilha: ${spreadsheetUrl}`);
        return;
      }

      const sheetsClient = new SheetsClient(auth, spreadsheetId);

      // 2. Initialize SQLite
      this.logger.info('\n[2/8] Inicializando banco de dados...');
      const db = getDatabase(this.config.dbPath);
      const repo = new Repository(db);

      const syncId = options.dryRun ? 0 : repo.startSync();

      // 3. Read category mappings from Google Sheets
      this.logger.info('\n[3/8] Lendo configurações da planilha...');
      const renderer = new SheetsRenderer(sheetsClient, repo, this.logger);
      const categoryMappings = await renderer.readCategoryMappings();
      this.logger.info(`  ${categoryMappings.size} mapeamentos de categoria carregados.`);

      // 4. Trigger Pierre manual-update
      const pierreClient = new PierreClient({
        apiKey: this.config.pierreApiKey,
        logger: this.logger,
      });

      if (!options.skipUpdate) {
        this.logger.info('\n[4/8] Sincronizando dados no Pierre...');
        try {
          await pierreClient.triggerManualUpdate();
          this.logger.info('  Aguardando 30s para o Pierre sincronizar com os bancos...');
          await this.sleep(30_000);
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

      // Upsert accounts
      if (!options.dryRun) {
        for (const account of relevantAccounts) {
          repo.upsertAccount(normalizeAccount(account));
        }
      }

      // 6. Fetch transactions
      this.logger.info('\n[6/8] Buscando transações...');
      const { startDate, endDate } = this.calculateDateRange(repo, options.fullSync);
      this.logger.info(`  Período: ${startDate} → ${endDate}`);

      const txResponse = await pierreClient.getTransactions(startDate, endDate);
      const rawTransactions = txResponse.data;
      this.logger.info(`  ${rawTransactions.length} transações recebidas da API.`);

      // Filter out transactions from excluded accounts
      const relevantAccountIds = new Set(relevantAccounts.map((a) => a.id));
      const filteredTx = rawTransactions.filter((tx) => relevantAccountIds.has(tx.account_id));

      // Normalize
      const normalizedTx: NormalizedTransaction[] = filteredTx.map(normalizeTransaction);
      this.logger.info(`  ${normalizedTx.length} transações após filtros.`);

      // Upsert to SQLite
      let stats = { added: 0, updated: 0, unchanged: 0 };
      if (!options.dryRun) {
        stats = repo.upsertTransactions(normalizedTx, categoryMappings);
        this.logger.info(`  Adicionadas: ${stats.added}, Atualizadas: ${stats.updated}, Sem alteração: ${stats.unchanged}`);
      } else {
        this.logger.info('  [DRY RUN] Nenhuma transação gravada.');
      }

      // 7. Fetch installments
      this.logger.info('\n[7/8] Buscando parcelas...');
      try {
        const installmentsResponse = await pierreClient.getInstallments();
        const purchases = installmentsResponse.data?.purchases ?? installmentsResponse.purchases ?? [];

        if (purchases.length > 0 && !options.dryRun) {
          const installments = this.flattenInstallments(purchases, relevantAccounts);
          repo.replaceInstallments(installments);
          this.logger.info(`  ${installments.length} parcelas processadas.`);
        } else {
          this.logger.info('  Nenhuma parcela encontrada.');
        }
      } catch (err) {
        this.logger.warn('  Falha ao buscar parcelas (continuando)', {
          error: (err as Error).message,
        });
      }

      // 8. Render to Google Sheets
      if (!options.dryRun) {
        this.logger.info('\n[8/8] Atualizando planilha...');
        await renderer.renderAll();

        // Complete sync log
        repo.completeSync(syncId, stats);
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
      this.logger.error(`Sincronização falhou: ${error.message}`);

      // Try to log the failure in SQLite
      try {
        const db = getDatabase(this.config.dbPath);
        const repo = new Repository(db);
        const lastSync = repo.getLastSuccessfulSync();
        // We can't easily get the syncId here, so just log the error
        this.logger.error('Stack trace:', { error: error.stack });
      } catch {
        // Ignore errors in error handling
      }

      throw error;
    } finally {
      closeDatabase();
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private calculateDateRange(
    repo: Repository,
    fullSync: boolean,
  ): { startDate: string; endDate: string } {
    const endDate = new Date().toISOString().split('T')[0];

    if (fullSync) {
      const start = new Date();
      start.setMonth(start.getMonth() - 3);
      return { startDate: start.toISOString().split('T')[0], endDate };
    }

    const lastSync = repo.getLastSuccessfulSync();
    if (lastSync?.completed_at) {
      // Start 3 days before the last sync to catch updates
      const start = new Date(lastSync.completed_at);
      start.setDate(start.getDate() - 3);
      return { startDate: start.toISOString().split('T')[0], endDate };
    }

    // No previous sync — pull 3 months
    const start = new Date();
    start.setMonth(start.getMonth() - 3);
    return { startDate: start.toISOString().split('T')[0], endDate };
  }

  private flattenInstallments(
    purchases: PierrePurchase[],
    accounts: PierreAccount[],
  ): Array<{
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
  }> {
    const result: ReturnType<typeof this.flattenInstallments> = [];

    for (const purchase of purchases) {
      for (const inst of purchase.installments ?? []) {
        result.push({
          id: `${purchase.description}-${inst.installmentNumber}/${inst.totalInstallments}`,
          purchaseDescription: purchase.description,
          installmentNumber: inst.installmentNumber,
          totalInstallments: inst.totalInstallments,
          amount: inst.amount,
          dueDate: inst.dueDate,
          isPaid: inst.isPaid,
          isProjected: inst.isProjected,
          accountId: '',
          accountName: '',
        });
      }
    }

    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
