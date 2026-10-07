import crypto from 'crypto';
import Database from 'better-sqlite3';
import { PierreClient } from '../../pierre/client';
import { normalizeAccount, normalizeBill, normalizeTransaction, shouldExcludeAccount, NormalizedAccount, NormalizedCardBill, NormalizedTransaction } from '../../pierre/normalizer';
import { CategoryMapping, Repository } from '../../storage/repository';
import { calculateDateRange } from '../../sync/engine';
import { findPropertyContract, serializePayloadForNotion } from '../migration-runner/backfill-serializer';
import { NotionSyncGateway, LoadedNotionState } from './notion-gateway';
import { projectNotionState } from './projection';
import { ACCOUNT_ENV, AccountSourceContext, BILL_ENV, reconcile, RefTarget, SyncPlan, TX_ENV } from './reconcile';
import { AccountRole, OfficialBill, ProjectionContext, SqliteAccountRow, SqliteTransactionRow } from './types';

/** Everything the projection reads from the local database. */
export interface SourceRows {
  accounts: SqliteAccountRow[];
  /** Live rows only: rows the source no longer lists are left out of every projection. */
  transactions: SqliteTransactionRow[];
  bills: OfficialBill[];
  /** Ids of rows flagged as removed at the source (their Notion pages are marked as cancelled). */
  removedIds: string[];
}

const SYNC_LOG_ENV = 'NOTION_DS_SYNC_LOG';
const PIERRE_SYNC_WAIT_MS = 30_000;
const PENDING_LOOKBACK_DAYS = 3;
/** Never reach further back than this to fill a local history gap. */
const HISTORY_GAP_MAX_MONTHS = 12;
/** Above this many vanished pending rows at once (and half of the pending rows), the read looks incomplete. */
const VANISHED_GUARD_MIN = 5;

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
    /** Notion pages marked as cancelled because the source no longer lists them. */
    txRemovedAtSource: number;
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

export function readSqliteRows(db: Database.Database): SourceRows {
  const accounts = db.prepare('SELECT id, name, type, subtype, closing_balance, credit_limit, available_credit, last_synced_at, raw_json FROM accounts').all() as SqliteAccountRow[];
  // Databases from before migration 005 (e.g. the frozen migration snapshot) have no removal flag.
  const hasRemoved = (db.pragma('table_info(transactions)') as Array<{ name: string }>).some((c) => c.name === 'removed_at');
  const transactions = db
    .prepare(
      `SELECT id, account_id, date, description, amount, direction, category_pierre, category_mapped, account_type, status, raw_json FROM transactions${hasRemoved ? ' WHERE removed_at IS NULL' : ''} ORDER BY date ASC, id ASC`,
    )
    .all() as SqliteTransactionRow[];
  const removedIds = hasRemoved ? (db.prepare('SELECT id FROM transactions WHERE removed_at IS NOT NULL ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id) : [];
  // A database from before migration 004 (e.g. the frozen migration snapshot) has no official bills.
  const hasBills = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'card_bills'").get() !== undefined;
  const bills = hasBills
    ? (db
        .prepare('SELECT id, account_id AS accountId, due_date AS dueDate, closing_date AS closingDate, total_amount AS totalAmount FROM card_bills ORDER BY closing_date ASC, id ASC')
        .all() as OfficialBill[])
    : [];
  return { accounts, transactions, bills, removedIds };
}

const toOfficial = (b: NormalizedCardBill): OfficialBill => ({ id: b.id, accountId: b.accountId, dueDate: b.dueDate, closingDate: b.closingDate, totalAmount: b.totalAmount });

/** Today's date in Brazil (the bank's calendar), YYYY-MM-DD. */
export function brazilDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
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
  current: SourceRows,
  accounts: NormalizedAccount[],
  txs: NormalizedTransaction[],
  bills: NormalizedCardBill[] | null,
  mappings: Map<string, { categoryMapped: string }>,
  nowSql: string,
  vanished: string[] = [],
): SourceRows {
  const acc = new Map(current.accounts.map((a) => [a.id, a]));
  for (const a of accounts) {
    acc.set(a.id, {
      id: a.id, name: a.name, type: a.type, subtype: a.subtype, closing_balance: a.closingBalance,
      credit_limit: a.creditLimit, available_credit: a.availableCredit, last_synced_at: nowSql, raw_json: a.rawJson,
    });
  }
  const billById = new Map(current.bills.map((b) => [b.id, b]));
  for (const b of bills ?? []) {
    const prev = billById.get(b.id);
    const next = toOfficial(b);
    billById.set(b.id, {
      ...next,
      dueDate: next.dueDate ?? prev?.dueDate ?? null,
      closingDate: next.closingDate ?? prev?.closingDate ?? null,
      totalAmount: next.totalAmount ?? prev?.totalAmount ?? null,
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
  for (const id of vanished) tx.delete(id);
  const fetchedIds = new Set(txs.map((t) => t.id));
  return {
    accounts: Array.from(acc.values()),
    transactions: Array.from(tx.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    bills: Array.from(billById.values()),
    removedIds: Array.from(new Set([...current.removedIds.filter((id) => !fetchedIds.has(id)), ...vanished])).sort(),
  };
}

const dayShift = (iso: string, days: number) => {
  const d = new Date(`${iso.substring(0, 10)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().substring(0, 10);
};

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

  private buildContext(state: LoadedNotionState, rows: SourceRows): ProjectionContext {
    return {
      officialBills: rows.bills,
      today: brazilDate(this.now()),
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

  private plan(rows: SourceRows, state: LoadedNotionState): SyncPlan {
    const ctx = this.buildContext(state, rows);
    const projection = projectNotionState(rows.accounts, rows.transactions, ctx);
    return reconcile(projection, rows.transactions, state.rules, state.live, this.accountContext(rows.accounts, ctx), {
      hmacKeyAvailable: Boolean(this.settings.hmacKey && this.settings.hmacKey.trim()),
      removedAtSource: rows.removedIds,
      today: ctx.today,
    });
  }

  /**
   * Notion pages from Pierre whose source row is missing locally (a database restored from an older backup, or one
   * that started later than the migration): the oldest of them, so the Pierre read reaches back and fills the gap.
   */
  private historyGapStart(rows: SourceRows, state: LoadedNotionState, warnings: string[]): string | null {
    const known = new Set([...rows.transactions.map((t) => t.id), ...rows.removedIds]);
    const days: string[] = [];
    for (const [id, pages] of state.live.transactions) {
      if (known.has(id) || pages.length === 0) continue;
      const page = pages[0];
      if (page.canonical['Fonte'] !== 'Pierre') continue;
      const day = (page.canonical['Data'] as { start?: string } | null)?.start?.substring(0, 10);
      if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) days.push(day);
    }
    if (days.length === 0) return null;
    const floor = new Date(this.now());
    floor.setUTCMonth(floor.getUTCMonth() - HISTORY_GAP_MAX_MONTHS);
    const oldest = days.sort()[0];
    const start = oldest < floor.toISOString().substring(0, 10) ? floor.toISOString().substring(0, 10) : oldest;
    warnings.push(`HISTORY_GAP: ${days.length} transações do Notion (Fonte Pierre) sem linha no SQLite local; buscando no Pierre desde ${start} para completar o histórico.`);
    return start;
  }

  /**
   * Pending rows inside the window the source just returned in full that are no longer listed: the bank cancelled
   * them or posted them under a new id. Window edges are skipped (time-zone slack), posted rows are never touched,
   * and a read that looks incomplete (empty, or too many at once) removes nothing.
   */
  private vanishedPending(rows: SourceRows, fetched: { txs: NormalizedTransaction[]; accounts: NormalizedAccount[]; window: { startDate: string; endDate: string } }, warnings: string[]): string[] {
    const fetchedIds = new Set(fetched.txs.map((t) => t.id));
    const accountIds = new Set(fetched.accounts.map((a) => a.id));
    const lo = dayShift(fetched.window.startDate, 2);
    const hi = dayShift(fetched.window.endDate, -1);
    const pendingInWindow = rows.transactions.filter((t) => {
      const day = t.date.substring(0, 10);
      return t.status === 'PENDING' && accountIds.has(t.account_id) && day >= lo && day <= hi;
    });
    const vanished = pendingInWindow.filter((t) => !fetchedIds.has(t.id));
    if (vanished.length === 0) return [];
    if (fetched.txs.length === 0 || vanished.length > Math.max(VANISHED_GUARD_MIN, Math.floor(pendingInWindow.length / 2))) {
      warnings.push(`SUSPICIOUS_SOURCE_GAP: ${vanished.length} de ${pendingInWindow.length} lançamentos pendentes não vieram do Pierre; a leitura parece incompleta e nada foi removido.`);
      return [];
    }
    const list = vanished.map((t) => `${t.date.substring(0, 10)} R$ ${Math.abs(Number(t.amount)).toFixed(2)} ${t.description.substring(0, 30)}`).join('; ');
    warnings.push(`REMOVED_AT_SOURCE: ${vanished.length} lançamento(s) pendente(s) não aparecem mais no Pierre (cancelados ou efetivados com outro ID): ${list}.`);
    return vanished.map((t) => t.id);
  }

  private async fetchPierre(options: NotionSyncOptions, repo: Repository, historyStart: string | null) {
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
    // Pending rows change date, status and bill when the bank posts them (often weeks later), and the posted
    // copies can arrive back-dated: re-read from the oldest pending row, bounded by the full-sync window.
    const hasRemoved = (this.deps.db.pragma('table_info(transactions)') as Array<{ name: string }>).some((c) => c.name === 'removed_at');
    const oldestPending = (
      this.deps.db.prepare(`SELECT MIN(date) AS d FROM transactions WHERE status = 'PENDING'${hasRemoved ? ' AND removed_at IS NULL' : ''}`).get() as { d: string | null }
    ).d;
    if (oldestPending) {
      const start = new Date(oldestPending);
      start.setUTCDate(start.getUTCDate() - PENDING_LOOKBACK_DAYS);
      const floor = calculateDateRange(null, true, this.now()).startDate;
      const candidate = start.toISOString().substring(0, 10) < floor ? floor : start.toISOString().substring(0, 10);
      if (candidate < window.startDate) window.startDate = candidate;
    }
    if (historyStart && historyStart < window.startDate) window.startDate = historyStart;
    // In Pierre's API, passing endDate as YYYY-MM-DD acts exclusively (< YYYY-MM-DD 00:00:00)
    // because ISO timestamps like 'YYYY-MM-DDT12:00:00Z' are strictly greater than 'YYYY-MM-DD'.
    // To include transactions made today during daytime cron runs, we query Pierre with tomorrow.
    const queryEndDate = dayShift(window.endDate, 1);
    const rawTxs = (await pierre.getTransactions(window.startDate, queryEndDate)).data;
    const relevantIds = new Set(relevant.map((a) => a.id));
    const txs = rawTxs.filter((t) => relevantIds.has(t.account_id)).map(normalizeTransaction);
    // Official bills are an enrichment: without them the cycles fall back to the last ones stored locally.
    let bills: NormalizedCardBill[] | null = null;
    try {
      bills = (await pierre.getBills()).data.filter((b) => relevantIds.has(b.accountId)).map(normalizeBill);
    } catch (err) {
      this.logger.warn('  get-bills falhou (usando as faturas oficiais já guardadas)', { error: (err as Error).message });
    }
    return { accounts: relevant.map(normalizeAccount), txs, bills, window, received: rawTxs.length };
  }

  async run(options: NotionSyncOptions): Promise<NotionSyncReport> {
    const started = this.now();
    const runId = `notion-sync-${started.toISOString().replace(/[:.]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
    const repo = new Repository(this.deps.db);
    const report: NotionSyncReport = {
      runId, mode: options.apply ? 'APPLY' : 'DRY_RUN', status: 'SUCCESS', pierre: null,
      plan: { billCreates: 0, txCreates: 0, txSourceUpdates: 0, txRemovedAtSource: 0, txReclassified: 0, billUpdates: 0, accountUpdates: 0, unchangedTransactions: 0, rulesApplied: {} },
      applied: { writes: 0, errors: [] }, residual: null, warnings: [], freshness: null, pendingReview: null, logPageId: null,
    };

    // 1. Notion state (read first: it tells how far back the local history must reach).
    this.logger.info('[1/5] Lendo o estado atual do Notion...');
    const gw = this.deps.gateway;
    let state = await gw.loadState();

    // 2. Pierre → SQLite (dry-run merges in memory and writes nothing).
    let rows = readSqliteRows(this.deps.db);
    let sqliteSyncId: number | null = null;
    if (this.deps.pierre && !options.skipPierre) {
      this.logger.info('[2/5] Buscando dados no Pierre...');
      const fetched = await this.fetchPierre(options, repo, this.historyGapStart(rows, state, report.warnings));
      report.pierre = { accounts: fetched.accounts.length, transactionsReceived: fetched.received, window: fetched.window };
      const vanished = this.vanishedPending(rows, fetched, report.warnings);
      const mappings = learnedCategoryMappings(this.deps.db);
      if (options.apply) {
        sqliteSyncId = repo.startSync();
        for (const a of fetched.accounts) repo.upsertAccount(a);
        if (fetched.bills) repo.upsertCardBills(fetched.bills);
        const stats = repo.upsertTransactions(fetched.txs, mappings);
        const removed = repo.markRemovedAtSource(vanished);
        repo.completeSync(sqliteSyncId, stats);
        rows = readSqliteRows(this.deps.db);
        this.logger.info(`  SQLite: ${stats.added} novas, ${stats.updated} atualizadas, ${stats.unchanged} sem alteração${removed ? `, ${removed} removidas na fonte` : ''}.`);
      } else {
        const nowSql = this.now().toISOString().replace('T', ' ').substring(0, 19);
        rows = mergeInMemory(rows, fetched.accounts, fetched.txs, fetched.bills, mappings, nowSql, vanished);
      }
    } else {
      this.logger.info('[2/5] Pierre ignorado: usando o histórico local do SQLite como fonte.');
    }
    report.freshness = rows.transactions.length > 0 ? rows.transactions[rows.transactions.length - 1].date.substring(0, 10) : null;

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
      txRemovedAtSource: plan.txUpdates.filter((u) => u.kind === 'REMOVED').length,
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
    for (const a of plan.billAdoptions) idByBill.set(a.stableId, a.pageId);

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
      txUpdates: after.txUpdates.filter((u) => u.kind !== 'RECLASSIFY').length,
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
        'Transações atualizadas': report.plan.txSourceUpdates + report.plan.txReclassified + report.plan.txRemovedAtSource,
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
