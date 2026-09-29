import crypto from 'crypto';
import Database from 'better-sqlite3';
import { PierreClient } from '../../pierre/client';
import { normalizeAccount, normalizeTransaction, shouldExcludeAccount, NormalizedAccount, NormalizedTransaction } from '../../pierre/normalizer';
import { CategoryMapping, Repository } from '../../storage/repository';
import { calculateDateRange } from '../../sync/engine';
import { findPropertyContract, serializePayloadForNotion } from '../migration-runner/backfill-serializer';
import { NotionSyncGateway, LoadedNotionState } from './notion-gateway';
import { projectNotionState } from './projection';
import { ACCOUNT_ENV, AccountSourceContext, BILL_ENV, reconcile, RefTarget, SyncPlan, TX_ENV } from './reconcile';
import { AccountRole, ProjectionContext, SqliteAccountRow, SqliteTransactionRow } from './types';

const SYNC_LOG_ENV = 'NOTION_DS_SYNC_LOG';
const PIERRE_SYNC_WAIT_MS = 30_000;

export interface NotionSyncSettings {
  accountRoles: Record<string, AccountRole>;
  defaultDueDay?: number;
  checkingAccountName: string;
  creditAccountName: string;
  hmacKey?: string;
  hmacKeyVersion: string;
  sameOwnershipKeywords: string[];
  /** Refuse to create more pages than this in one run unless allowLarge (guards against broken matching). */
  maxCreates: number;
  workerVersion: string;
}

export interface NotionSyncOptions {
  apply: boolean;
  skipPierre: boolean;
  skipUpdate: boolean;
  fullSync: boolean;
  allowLarge: boolean;
}

export interface NotionSyncDeps {
  gateway: NotionSyncGateway;
  db: Database.Database;
  pierre: PierreClient | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface NotionSyncReport {
  runId: string;
  mode: 'DRY_RUN' | 'APPLY';
  status: 'SUCCESS' | 'PARTIAL' | 'NOTHING_TO_DO';
  pierre: { accounts: number; transactionsReceived: number; window: { startDate: string; endDate: string } | null } | null;
  plan: {
    billCreates: number;
    txCreates: number;
    txSourceUpdates: number;
    txReclassified: number;
    billUpdates: number;
    accountUpdates: number;
    unchangedTransactions: number;
    rulesApplied: Record<string, number>;
  };
  applied: { writes: number; errors: string[] };
  residual: { txCreates: number; txUpdates: number; billCreates: number; billUpdates: number } | null;
  warnings: string[];
  freshness: string | null;
  pendingReview: number | null;
  logPageId: string | null;
}

export class NotionSyncError extends Error {
  constructor(message: string, public readonly report: Partial<NotionSyncReport>) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

export function readSqliteRows(db: Database.Database): { accounts: SqliteAccountRow[]; transactions: SqliteTransactionRow[] } {
  const accounts = db.prepare('SELECT id, name, type, subtype, closing_balance, credit_limit, available_credit, last_synced_at FROM accounts').all() as SqliteAccountRow[];
  const transactions = db
    .prepare('SELECT id, account_id, date, description, amount, direction, category_pierre, category_mapped, account_type, status, raw_json FROM transactions ORDER BY date ASC, id ASC')
    .all() as SqliteTransactionRow[];
  return { accounts, transactions };
}

/** Category mapping learned from the local history (most frequent mapping per Pierre category). */
export function learnedCategoryMappings(db: Database.Database): Map<string, CategoryMapping> {
  const rows = db
    .prepare(
      `SELECT category_pierre AS p, category_mapped AS m, category_group AS g, category_variability AS v, COUNT(*) AS n
       FROM transactions WHERE category_pierre IS NOT NULL GROUP BY 1, 2, 3, 4 ORDER BY n DESC`,
    )
    .all() as Array<{ p: string; m: string | null; g: string | null; v: string | null }>;
  const map = new Map<string, CategoryMapping>();
  for (const r of rows) if (!map.has(r.p)) map.set(r.p, { categoryPierre: r.p, categoryMapped: r.m ?? r.p, group: r.g ?? '', variability: r.v ?? '' });
  return map;
}

/** Dry-run: the rows the database WOULD hold after upserting the fetched data (nothing is written). */
function mergeInMemory(
  current: { accounts: SqliteAccountRow[]; transactions: SqliteTransactionRow[] },
  accounts: NormalizedAccount[],
  txs: NormalizedTransaction[],
  mappings: Map<string, { categoryMapped: string }>,
  nowSql: string,
): { accounts: SqliteAccountRow[]; transactions: SqliteTransactionRow[] } {
  const acc = new Map(current.accounts.map((a) => [a.id, a]));
  for (const a of accounts) {
    acc.set(a.id, {
      id: a.id, name: a.name, type: a.type, subtype: a.subtype, closing_balance: a.closingBalance,
      credit_limit: a.creditLimit, available_credit: a.availableCredit, last_synced_at: nowSql,
    });
  }
  const tx = new Map(current.transactions.map((t) => [t.id, t]));
  for (const t of txs) {
    const prev = tx.get(t.id);
    tx.set(t.id, {
      id: t.id, account_id: t.accountId, date: t.date, description: t.description, amount: t.amount, direction: t.direction,
      category_pierre: t.categoryPierre,
      category_mapped: prev && prev.category_pierre === t.categoryPierre ? prev.category_mapped : mappings.get(t.categoryPierre)?.categoryMapped ?? t.categoryPierre,
      account_type: t.accountType, status: t.status, raw_json: t.rawJson,
    });
  }
  return { accounts: Array.from(acc.values()), transactions: Array.from(tx.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}

// ---------------------------------------------------------------------------
// Schema preflight: every property written must exist with the contract type, and every select value must
// already be an option — writing an unknown option would silently create it (a schema change).
// ---------------------------------------------------------------------------

const CONTRACT_TO_NOTION_TYPE: Record<string, string> = {
  title: 'title', rich_text: 'rich_text', number: 'number', select: 'select', date: 'date', relation: 'relation', checkbox: 'checkbox',
};

export function validateAgainstLiveSchema(envKey: string, schema: Record<string, any>, payload: Record<string, any>, relationKeys: string[]): string[] {
  const problems: string[] = [];
  for (const key of [...Object.keys(payload), ...relationKeys]) {
    const contract = findPropertyContract(envKey, key);
    const live = schema[key];
    if (!contract || !live) {
      problems.push(`SCHEMA_MISSING_PROPERTY: '${key}' não existe em ${envKey}.`);
      continue;
    }
    if (CONTRACT_TO_NOTION_TYPE[contract.notionType] !== live.type) {
      problems.push(`SCHEMA_TYPE_MISMATCH: '${key}' em ${envKey} é '${live.type}', esperado '${contract.notionType}'.`);
      continue;
    }
    const value = payload[key];
    if (live.type === 'select' && value !== null && value !== undefined) {
      const options = (live.select?.options || []).map((o: any) => o.name);
      if (!options.includes(value)) problems.push(`SCHEMA_UNKNOWN_OPTION: opção '${value}' não existe em '${key}' (${envKey}); nada é criado automaticamente.`);
    }
  }
  return problems;
}

function planSchemaProblems(plan: SyncPlan, schemas: Record<string, Record<string, any>>): string[] {
  const problems = new Set<string>();
  const add = (list: string[]) => list.forEach((p) => problems.add(p));
  for (const c of plan.txCreates) add(validateAgainstLiveSchema(TX_ENV, schemas[TX_ENV], c.payload, Object.keys(c.relations)));
  for (const u of plan.txUpdates) add(validateAgainstLiveSchema(TX_ENV, schemas[TX_ENV], u.payload, Object.keys(u.relations)));
  for (const c of plan.billCreates) add(validateAgainstLiveSchema(BILL_ENV, schemas[BILL_ENV], c.payload, Object.keys(c.relations)));
  for (const u of plan.billUpdates) add(validateAgainstLiveSchema(BILL_ENV, schemas[BILL_ENV], u.payload, Object.keys(u.relations)));
  for (const a of plan.accountUpdates) add(validateAgainstLiveSchema(ACCOUNT_ENV, schemas[ACCOUNT_ENV], a.payload, []));
  return Array.from(problems);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class NotionSyncEngine {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly settings: NotionSyncSettings,
    private readonly deps: NotionSyncDeps,
    private readonly logger: Logger,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private buildContext(state: LoadedNotionState): ProjectionContext {
    return {
      accountRoles: this.settings.accountRoles,
      defaultDueDay: this.settings.defaultDueDay,
      notionAccounts: state.live.accounts.map((a) => ({ id: a.pageId, name: a.name, sourceId: (a as any).sourceId ?? null })),
      categoryIdByName: new Map(state.categories.map((c) => [c.name.toLowerCase().trim(), c.id])),
      hmacKey: this.settings.hmacKey,
      hmacKeyVersion: this.settings.hmacKeyVersion,
      sameOwnershipKeywords: this.settings.sameOwnershipKeywords,
      checkingAccountName: this.settings.checkingAccountName,
      creditAccountName: this.settings.creditAccountName,
    };
  }

  private accountContext(rows: SqliteAccountRow[], ctx: ProjectionContext): AccountSourceContext {
    const pageBySourceId = new Map<string, string>();
    for (const row of rows) {
      const role = this.settings.accountRoles[row.id];
      if (!role) continue;
      const name = role === 'CREDIT' ? ctx.creditAccountName : ctx.checkingAccountName;
      const page = ctx.notionAccounts.find((a) => a.sourceId === row.id) ?? ctx.notionAccounts.find((a) => a.name === name);
      if (page) pageBySourceId.set(row.id, page.id);
    }
    return { rows, roles: this.settings.accountRoles, pageBySourceId };
  }

  private plan(rows: { accounts: SqliteAccountRow[]; transactions: SqliteTransactionRow[] }, state: LoadedNotionState): SyncPlan {
    const ctx = this.buildContext(state);
    const projection = projectNotionState(rows.accounts, rows.transactions, ctx);
    return reconcile(projection, rows.transactions, state.rules, state.live, this.accountContext(rows.accounts, ctx), {
      hmacKeyAvailable: Boolean(this.settings.hmacKey && this.settings.hmacKey.trim()),
    });
  }

  private async fetchPierre(options: NotionSyncOptions, repo: Repository) {
    const pierre = this.deps.pierre!;
    if (!options.skipUpdate) {
      try {
        await pierre.triggerManualUpdate();
        this.logger.info('  Aguardando o Pierre sincronizar com os bancos...');
        await this.sleep(PIERRE_SYNC_WAIT_MS);
      } catch (err) {
        this.logger.warn('  manual-update falhou (seguindo com os dados já disponíveis no Pierre)', { error: (err as Error).message });
      }
    }
    const allAccounts = (await pierre.getAccounts()).data;
    const relevant = allAccounts.filter((a) => !shouldExcludeAccount(a));
    const window = calculateDateRange(repo.getLastSuccessfulSync()?.completed_at ?? null, options.fullSync, this.now());
    const rawTxs = (await pierre.getTransactions(window.startDate, window.endDate)).data;
    const relevantIds = new Set(relevant.map((a) => a.id));
    const txs = rawTxs.filter((t) => relevantIds.has(t.account_id)).map(normalizeTransaction);
    return { accounts: relevant.map(normalizeAccount), txs, window, received: rawTxs.length };
  }

  async run(options: NotionSyncOptions): Promise<NotionSyncReport> {
    const started = this.now();
    const runId = `notion-sync-${started.toISOString().replace(/[:.]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
    const repo = new Repository(this.deps.db);
    const report: NotionSyncReport = {
      runId, mode: options.apply ? 'APPLY' : 'DRY_RUN', status: 'SUCCESS', pierre: null,
      plan: { billCreates: 0, txCreates: 0, txSourceUpdates: 0, txReclassified: 0, billUpdates: 0, accountUpdates: 0, unchangedTransactions: 0, rulesApplied: {} },
      applied: { writes: 0, errors: [] }, residual: null, warnings: [], freshness: null, pendingReview: null, logPageId: null,
    };

    // 1. Pierre → SQLite (dry-run merges in memory and writes nothing).
    let rows = readSqliteRows(this.deps.db);
    let sqliteSyncId: number | null = null;
    if (this.deps.pierre && !options.skipPierre) {
      this.logger.info('[1/5] Buscando dados no Pierre...');
      const fetched = await this.fetchPierre(options, repo);
      report.pierre = { accounts: fetched.accounts.length, transactionsReceived: fetched.received, window: fetched.window };
      const mappings = learnedCategoryMappings(this.deps.db);
      if (options.apply) {
        sqliteSyncId = repo.startSync();
        for (const a of fetched.accounts) repo.upsertAccount(a);
        const stats = repo.upsertTransactions(fetched.txs, mappings);
        repo.completeSync(sqliteSyncId, stats);
        rows = readSqliteRows(this.deps.db);
        this.logger.info(`  SQLite: ${stats.added} novas, ${stats.updated} atualizadas, ${stats.unchanged} sem alteração.`);
      } else {
        const nowSql = this.now().toISOString().replace('T', ' ').substring(0, 19);
        rows = mergeInMemory(rows, fetched.accounts, fetched.txs, mappings, nowSql);
      }
    } else {
      this.logger.info('[1/5] Pierre ignorado: usando o histórico local do SQLite como fonte.');
    }
    report.freshness = rows.transactions.length > 0 ? rows.transactions[rows.transactions.length - 1].date.substring(0, 10) : null;

    // 2. Notion state + live schemas.
    this.logger.info('[2/5] Lendo o estado atual do Notion...');
    const gw = this.deps.gateway;
    let state = await gw.loadState();
    const schemas: Record<string, Record<string, any>> = {
      [TX_ENV]: await gw.retrieveSchema(gw.ds.transactions),
      [BILL_ENV]: await gw.retrieveSchema(gw.ds.bills),
      [ACCOUNT_ENV]: await gw.retrieveSchema(gw.ds.accounts),
      [SYNC_LOG_ENV]: await gw.retrieveSchema(gw.ds.syncLog),
    };

    // 3. Projection + reconciliation.
    this.logger.info('[3/5] Calculando a diferença entre a fonte e o Notion...');
    const plan = this.plan(rows, state);
    report.warnings.push(...plan.warnings);
    report.plan = {
      billCreates: plan.billCreates.length,
      txCreates: plan.txCreates.length,
      txSourceUpdates: plan.txUpdates.filter((u) => u.kind === 'SOURCE').length,
      txReclassified: plan.stats.reclassified,
      billUpdates: plan.billUpdates.length,
      accountUpdates: plan.accountUpdates.length,
      unchangedTransactions: plan.stats.unchangedTransactions,
      rulesApplied: {},
    };
    for (const r of [...plan.txCreates.map((c) => c.rule), ...plan.txUpdates.map((u) => u.rule)]) {
      if (r) report.plan.rulesApplied[r] = (report.plan.rulesApplied[r] ?? 0) + 1;
    }

    // 4. Guards (fail closed before any Notion write).
    const fatal = [...plan.fatal, ...planSchemaProblems(plan, schemas)];
    if (fatal.length > 0) throw new NotionSyncError(`FAIL_CLOSED: ${fatal.join(' | ')}`, report);
    if (plan.txCreates.length + plan.billCreates.length > this.settings.maxCreates && !options.allowLarge) {
      throw new NotionSyncError(
        `FAIL_CLOSED_LARGE_WRITE: ${plan.txCreates.length + plan.billCreates.length} páginas novas excedem o limite de ${this.settings.maxCreates}; confira e rode com --allow-large.`,
        report,
      );
    }

    const totalChanges = plan.txCreates.length + plan.txUpdates.length + plan.billCreates.length + plan.billUpdates.length + plan.accountUpdates.length;
    if (!options.apply) {
      report.status = totalChanges === 0 ? 'NOTHING_TO_DO' : 'SUCCESS';
      report.pendingReview = state.pendingReview;
      return report;
    }

    // 5. Apply.
    this.logger.info(`[4/5] Gravando no Notion (${totalChanges} alterações)...`);
    report.logPageId = await this.openSyncLog(runId, started, report);

    const idByTx = new Map<string, string>();
    for (const [id, pages] of state.live.transactions) if (pages.length === 1) idByTx.set(id, pages[0].pageId);
    const idByBill = new Map<string, string>();
    for (const [id, pages] of state.live.bills) if (pages.length === 1) idByBill.set(id, pages[0].pageId);

    const resolve = (refs: Record<string, RefTarget[]>): Record<string, string[]> | null => {
      const out: Record<string, string[]> = {};
      for (const [k, list] of Object.entries(refs)) {
        const ids: string[] = [];
        for (const r of list) {
          const id = r.kind === 'page' ? r.id : r.kind === 'tx' ? idByTx.get(r.stableId) : idByBill.get(r.stableId);
          if (!id) return null;
          ids.push(id);
        }
        out[k] = ids;
      }
      return out;
    };
    const attempt = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err: any) {
        report.applied.errors.push(`${label}: ${String(err?.message ?? err).slice(0, 300)}`);
      }
    };

    for (const c of plan.billCreates) {
      await attempt(`bill-create ${c.stableId}`, async () => {
        const rel = resolve(c.relations);
        if (!rel) throw new Error('relação não resolvida');
        const { notionProperties } = serializePayloadForNotion(BILL_ENV, c.payload, rel, true);
        idByBill.set(c.stableId, await gw.createPage(gw.ds.bills, notionProperties));
      });
    }
    for (const c of plan.txCreates) {
      await attempt(`tx-create ${c.stableId}`, async () => {
        const rel = resolve(c.relations);
        if (!rel) throw new Error('relação não resolvida (fatura ausente)');
        const { notionProperties } = serializePayloadForNotion(TX_ENV, c.payload, rel, true);
        idByTx.set(c.stableId, await gw.createPage(gw.ds.transactions, notionProperties));
      });
    }
    for (const u of plan.txUpdates) {
      await attempt(`tx-update ${u.stableId}`, async () => {
        const rel = resolve(u.relations);
        if (!rel) throw new Error('relação não resolvida');
        const { notionProperties } = serializePayloadForNotion(TX_ENV, u.payload, rel, false);
        await gw.updatePage(u.pageId, notionProperties);
      });
    }
    for (const u of plan.billUpdates) {
      await attempt(`bill-update ${u.stableId}`, async () => {
        const pageId = u.pageId ?? idByBill.get(u.stableId);
        const rel = resolve(u.relations);
        if (!pageId || !rel) throw new Error('fatura ou transação de pagamento não resolvida');
        const { notionProperties } = serializePayloadForNotion(BILL_ENV, u.payload, rel, false);
        await gw.updatePage(pageId, notionProperties);
      });
    }
    for (const a of plan.accountUpdates) {
      await attempt(`account-update ${a.name}`, async () => {
        const { notionProperties } = serializePayloadForNotion(ACCOUNT_ENV, a.payload, {}, false);
        await gw.updatePage(a.pageId, notionProperties);
      });
    }
    report.applied.writes = gw.writes;

    // 6. Post-write verification: a fresh read must leave nothing left to create or refresh.
    this.logger.info('[5/5] Reverificando o Notion após a gravação...');
    state = await gw.loadState();
    const after = this.plan(rows, state);
    report.residual = {
      txCreates: after.txCreates.length,
      txUpdates: after.txUpdates.filter((u) => u.kind === 'SOURCE').length,
      billCreates: after.billCreates.length,
      billUpdates: after.billUpdates.length,
    };
    report.pendingReview = state.pendingReview;
    if (after.fatal.length > 0) report.applied.errors.push(...after.fatal);
    const residualTotal = Object.values(report.residual).reduce((s, n) => s + n, 0);
    report.status = report.applied.errors.length > 0 || residualTotal > 0 ? 'PARTIAL' : totalChanges === 0 ? 'NOTHING_TO_DO' : 'SUCCESS';

    await this.closeSyncLog(report.logPageId, started, report);
    return report;
  }

  // -------------------------------------------------------------------------
  // Log de Sincronização (best effort: a logging failure never fails the sync)
  // -------------------------------------------------------------------------

  private async openSyncLog(runId: string, started: Date, report: NotionSyncReport): Promise<string | null> {
    try {
      const payload = {
        Execução: `Sync Pierre → Notion ${started.toISOString().substring(0, 16).replace('T', ' ')} UTC`,
        Status: 'Executando',
        Fonte: 'Pierre',
        'Iniciada em': { start: started.toISOString(), end: null },
        'ID da Execução (Run ID)': runId,
        'Versão do Worker / Commit': this.settings.workerVersion,
        'Transações recebidas': report.pierre?.transactionsReceived ?? 0,
        'Contas recebidas': report.pierre?.accounts ?? 0,
      };
      const { notionProperties } = serializePayloadForNotion(SYNC_LOG_ENV, payload, {}, true);
      return await this.deps.gateway.createPage(this.deps.gateway.ds.syncLog, notionProperties);
    } catch (err: any) {
      report.warnings.push(`SYNC_LOG_OPEN_FAILED: ${String(err?.message ?? err).slice(0, 200)}`);
      return null;
    }
  }

  private async closeSyncLog(pageId: string | null, started: Date, report: NotionSyncReport): Promise<void> {
    if (!pageId) return;
    try {
      const finished = this.now();
      const statusLabel = report.status === 'PARTIAL' ? 'Parcial' : 'Sucesso';
      const notes = [...report.applied.errors, ...report.warnings].join(' | ').slice(0, 1900);
      const payload: Record<string, any> = {
        Status: statusLabel,
        'Concluída em': { start: finished.toISOString(), end: null },
        'Duração (s)': Math.round((finished.getTime() - started.getTime()) / 100) / 10,
        'Duração (ms)': finished.getTime() - started.getTime(),
        'Transações novas': report.plan.txCreates,
        'Transações atualizadas': report.plan.txSourceUpdates + report.plan.txReclassified,
        'Transações Inalteradas': report.plan.unchangedTransactions,
        'Erros Encontrados': report.applied.errors.length,
        'Pendências de revisão': report.pendingReview ?? 0,
        'Erro / alerta': notes,
      };
      if (report.freshness) payload['Freshness da fonte'] = { start: report.freshness, end: null };
      const { notionProperties } = serializePayloadForNotion(SYNC_LOG_ENV, payload, {}, false);
      await this.deps.gateway.updatePage(pageId, notionProperties);
    } catch (err: any) {
      report.warnings.push(`SYNC_LOG_CLOSE_FAILED: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }
}
