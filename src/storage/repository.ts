import Database from 'better-sqlite3';
import { NormalizedTransaction, NormalizedAccount } from '../pierre/normalizer';

// ---------------------------------------------------------------------------
// Category mapping (read from Google Sheets Config tab)
// ---------------------------------------------------------------------------

export interface CategoryMapping {
  categoryPierre: string;
  categoryMapped: string;
  group: string;        // Necessidade | Desejo | Poupança | —
  variability: string;  // Fixa | Variável | —
}

// ---------------------------------------------------------------------------
// Row shapes returned by the read queries. SQLite results are untyped at
// runtime, so there is a single unavoidable cast at each `.all()`/`.get()`
// boundary; declaring the shapes here lets the compiler check every consumer
// (the sheet renderer, the builders) against these contracts instead of `any`.
// ---------------------------------------------------------------------------

export interface AccountRow {
  id: string;
  name: string;
  type: string;
  subtype: string;
  closing_balance: number | null;
  credit_limit: number | null;
  available_credit: number | null;
  automatically_invested_balance: number | null;
  reserved_total: number | null;
  last_synced_at: string | null;
}

export interface TransactionRow {
  id: string;
  date: string;
  description: string;
  category_mapped: string | null;
  category_pierre: string | null;
  category_group: string | null;
  category_variability: string | null;
  direction: string;
  amount: number;
  account_name: string | null;
  account_type: string | null;
  status: string;
}

export interface InstallmentRow {
  id: string;
  purchase_description: string | null;
  installment_number: number;
  total_installments: number;
  amount: number;
  due_date: string | null;
  is_paid: number;
  is_projected: number;
  account_name: string | null;
}

export interface InvestmentRow {
  id: string;
  asset_name: string;
  asset_type: string;
  origin: string;           // EXTERNAL | PIERRE
  pricing_method: string;   // GOOGLEFINANCE | CDI | MANUAL | PIERRE
  ticker_or_rate: string | null;
  quantity: number | null;
  cost_basis: number | null;
  start_date: string | null;
  manual_value: number | null;
  market_value: number | null;
  market_value_at: string | null;
  pricing_status: string | null; // OK | FALLBACK | ERROR
  linked_account_id: string | null;
  notes: string | null;
  source: string;           // CONFIG_TAB | PIERRE_RESERVED
  updated_at?: string;
}

// ---------------------------------------------------------------------------
// Repository — CRUD operations for the financial database
// ---------------------------------------------------------------------------

export class Repository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  upsertAccount(account: NormalizedAccount): void {
    const stmt = this.db.prepare(`
      INSERT INTO accounts (id, name, type, subtype, connector_name, closing_balance, credit_limit, available_credit, automatically_invested_balance, reserved_total, last_synced_at, raw_json)
      VALUES (@id, @name, @type, @subtype, @connectorName, @closingBalance, @creditLimit, @availableCredit, @automaticallyInvestedBalance, @reservedTotal, datetime('now'), @rawJson)
      ON CONFLICT(id) DO UPDATE SET
        name = @name,
        closing_balance = @closingBalance,
        credit_limit = @creditLimit,
        available_credit = @availableCredit,
        automatically_invested_balance = @automaticallyInvestedBalance,
        reserved_total = @reservedTotal,
        last_synced_at = datetime('now'),
        raw_json = @rawJson
    `);
    // Defaulted explicitly rather than spread blind: better-sqlite3 throws on a
    // missing named parameter, and these two columns arrived in migration 003 —
    // an older caller (or a fixture) that predates them should write NULL, not
    // crash the sync.
    stmt.run({
      ...account,
      automaticallyInvestedBalance: account.automaticallyInvestedBalance ?? null,
      reservedTotal: account.reservedTotal ?? null,
    });
  }

  getAllAccounts(): AccountRow[] {
    return this.db.prepare('SELECT * FROM accounts ORDER BY type, name').all() as AccountRow[];
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  upsertTransaction(
    tx: NormalizedTransaction,
    categoryMapping?: CategoryMapping,
  ): 'added' | 'updated' | 'unchanged' {
    const existing = this.db
      .prepare('SELECT id, amount, direction, category_pierre FROM transactions WHERE id = ?')
      .get(tx.id) as { id: string; amount: number; direction: string; category_pierre: string } | undefined;

    const mapped = categoryMapping ?? {
      categoryMapped: tx.categoryPierre,
      group: '',
      variability: '',
    };

    if (!existing) {
      this.db.prepare(`
        INSERT INTO transactions (id, account_id, date, description, amount, original_amount, direction, category_pierre, category_mapped, category_group, category_variability, account_name, account_type, status, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tx.id, tx.accountId, tx.date, tx.description,
        tx.amount, tx.originalAmount, tx.direction,
        tx.categoryPierre, mapped.categoryMapped, mapped.group, mapped.variability,
        tx.accountName, tx.accountType, tx.status, tx.rawJson,
      );
      return 'added';
    }

    // Update if anything changed
    const hasChanged =
      existing.amount !== tx.amount ||
      existing.direction !== tx.direction ||
      existing.category_pierre !== tx.categoryPierre;

    if (hasChanged) {
      this.db.prepare(`
        UPDATE transactions SET
          amount = ?, original_amount = ?, direction = ?,
          category_pierre = ?, category_mapped = ?, category_group = ?, category_variability = ?,
          status = ?, raw_json = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        tx.amount, tx.originalAmount, tx.direction,
        tx.categoryPierre, mapped.categoryMapped, mapped.group, mapped.variability,
        tx.status, tx.rawJson, tx.id,
      );
      return 'updated';
    }

    return 'unchanged';
  }

  /**
   * Bulk upsert within a single transaction for performance.
   */
  upsertTransactions(
    txs: NormalizedTransaction[],
    mappings: Map<string, CategoryMapping>,
  ): { added: number; updated: number; unchanged: number } {
    const stats = { added: 0, updated: 0, unchanged: 0 };

    const run = this.db.transaction(() => {
      for (const tx of txs) {
        const mapping = mappings.get(tx.categoryPierre);
        const result = this.upsertTransaction(tx, mapping);
        stats[result]++;
      }
    });

    run();
    return stats;
  }

  /**
   * Get all transactions, ordered by date descending.
   */
  getAllTransactions(): TransactionRow[] {
    return this.db.prepare(`
      SELECT * FROM transactions ORDER BY date DESC
    `).all() as TransactionRow[];
  }

  /**
   * Get transactions for a specific month.
   */
  getTransactionsByMonth(year: number, month: number): TransactionRow[] {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

    return this.db.prepare(`
      SELECT * FROM transactions
      WHERE date >= ? AND date < ?
      ORDER BY date DESC
    `).all(startDate, endDate) as TransactionRow[];
  }

  /**
   * Monthly summary by category — only EXPENSE (excludes TRANSFER and INCOME).
   */
  getMonthlySummary(year: number, month: number): Array<{
    category_mapped: string;
    category_group: string;
    category_variability: string;
    total: number;
    count: number;
  }> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

    return this.db.prepare(`
      SELECT
        category_mapped,
        category_group,
        category_variability,
        SUM(amount) as total,
        COUNT(*) as count
      FROM transactions
      WHERE date >= ? AND date < ?
        AND direction = 'EXPENSE'
      GROUP BY category_mapped
      ORDER BY total ASC
    `).all(startDate, endDate) as any;
  }

  /**
   * Distinct expense categories with their 50/30/20 group, ordered by total
   * spend. Drives the rows of Resumo Mensal and Consolidado Anual.
   */
  getExpenseCategories(): Array<{ category: string; group: string }> {
    return this.db.prepare(`
      SELECT
        COALESCE(NULLIF(category_mapped, ''), category_pierre, 'Outros') AS category,
        COALESCE(MAX(NULLIF(category_group, '')), '')                    AS "group"
      FROM transactions
      WHERE direction = 'EXPENSE'
      GROUP BY category
      ORDER BY SUM(amount) ASC
    `).all() as Array<{ category: string; group: string }>;
  }

  /**
   * Get the list of distinct months that have transactions.
   */
  getDistinctMonths(): Array<{ year: number; month: number }> {
    const rows = this.db.prepare(`
      SELECT DISTINCT
        CAST(strftime('%Y', date) AS INTEGER) as year,
        CAST(strftime('%m', date) AS INTEGER) as month
      FROM transactions
      ORDER BY year DESC, month DESC
    `).all() as Array<{ year: number; month: number }>;
    return rows;
  }

  /**
   * Total income for a month.
   */
  getMonthlyIncome(year: number, month: number): number {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

    const row = this.db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM transactions
      WHERE date >= ? AND date < ?
        AND direction = 'INCOME'
    `).get(startDate, endDate) as { total: number };
    return row.total;
  }

  // -------------------------------------------------------------------------
  // Investments
  // -------------------------------------------------------------------------

  /**
   * Returns how many rows had an unresolvable `linked_account_id` dropped, so
   * the caller can surface it.
   */
  replaceInvestments(investments: InvestmentRow[], source: string): { droppedLinks: number } {
    let droppedLinks = 0;

    const run = this.db.transaction(() => {
      // "Conta Vinculada" is a free-text column the user edits, and this write
      // happens BEFORE accounts are fetched — on a first sync the accounts
      // table is still empty. Enforcing the foreign key literally would abort
      // the transaction and sink the whole sync over a typo, so an id that
      // resolves to no account is stored as NULL and reported instead.
      const knownAccountIds = new Set(
        (this.db.prepare('SELECT id FROM accounts').all() as Array<{ id: string }>)
          .map((row) => row.id),
      );

      this.db.prepare('DELETE FROM investments WHERE source = ?').run(source);
      const stmt = this.db.prepare(`
        INSERT INTO investments (
          id, asset_name, asset_type, origin, pricing_method, ticker_or_rate,
          quantity, cost_basis, start_date, manual_value, market_value,
          market_value_at, pricing_status, linked_account_id, notes, source, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
        )
      `);
      for (const inv of investments) {
        stmt.run(
          inv.id,
          inv.asset_name,
          inv.asset_type,
          inv.origin,
          inv.pricing_method,
          inv.ticker_or_rate ?? null,
          inv.quantity ?? null,
          inv.cost_basis ?? null,
          inv.start_date ?? null,
          inv.manual_value ?? null,
          inv.market_value ?? null,
          // Timestamp the price, not the row. Stamping datetime('now') on a row
          // whose market_value is still null would tell the exporter (and the
          // agent reading it) that an absent quote is fresh.
          inv.market_value == null ? null : (inv.market_value_at ?? new Date().toISOString()),
          // Default PENDING, never OK: a row arrives here before the read-back
          // has priced it, and claiming OK would launder a missing quote.
          inv.pricing_status ?? 'PENDING',
          resolveLink(inv.linked_account_id),
          inv.notes ?? null,
          source,
        );
      }

      function resolveLink(linkedAccountId: string | null): string | null {
        if (!linkedAccountId) return null;
        if (knownAccountIds.has(linkedAccountId)) return linkedAccountId;
        droppedLinks++;
        return null;
      }
    });

    run();
    return { droppedLinks };
  }

  updateMarketValues(updates: Array<{ id: string; marketValue: number | null; pricingStatus: string }>): void {
    const stmt = this.db.prepare(`
      UPDATE investments SET
        market_value = ?,
        market_value_at = datetime('now'),
        pricing_status = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `);
    const run = this.db.transaction(() => {
      for (const u of updates) {
        stmt.run(u.marketValue, u.pricingStatus, u.id);
      }
    });
    run();
  }

  getAllInvestments(): InvestmentRow[] {
    return this.db.prepare(`
      SELECT * FROM investments
      ORDER BY origin ASC, asset_name ASC
    `).all() as InvestmentRow[];
  }

  /**
   * Totals split by origin. Never collapse these into one number: PIERRE
   * holdings are already inside the accounts' closingBalance, so adding them to
   * a net worth that also counts the account balance double-counts the money.
   */
  getInvestmentTotals(origin?: 'EXTERNAL' | 'PIERRE'): { totalCost: number; totalMarket: number } {
    const where = origin ? 'WHERE origin = ?' : '';
    const params = origin ? [origin] : [];
    return this.db.prepare(`
      SELECT
        COALESCE(SUM(cost_basis), 0) as totalCost,
        COALESCE(SUM(market_value), 0) as totalMarket
      FROM investments
      ${where}
    `).get(...params) as { totalCost: number; totalMarket: number };
  }

  // -------------------------------------------------------------------------
  // Installments
  // -------------------------------------------------------------------------

  replaceInstallments(
    installments: Array<{
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
    }>,
  ): void {
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM installments').run();
      const stmt = this.db.prepare(`
        INSERT INTO installments (id, purchase_description, installment_number, total_installments, amount, due_date, is_paid, is_projected, account_id, account_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const inst of installments) {
        stmt.run(
          inst.id,
          inst.purchaseDescription,
          inst.installmentNumber,
          inst.totalInstallments,
          inst.amount,
          inst.dueDate,
          inst.isPaid ? 1 : 0,
          inst.isProjected ? 1 : 0,
          inst.accountId,
          inst.accountName,
        );
      }
    });
    run();
  }

  getUnpaidInstallments(): InstallmentRow[] {
    return this.db.prepare(`
      SELECT * FROM installments
      WHERE is_paid = 0
      ORDER BY due_date ASC
    `).all() as InstallmentRow[];
  }

  // -------------------------------------------------------------------------
  // Sync log
  // -------------------------------------------------------------------------

  startSync(): number {
    const result = this.db.prepare(`
      INSERT INTO sync_log (started_at, status) VALUES (datetime('now'), 'RUNNING')
    `).run();
    return Number(result.lastInsertRowid);
  }

  completeSync(syncId: number, stats: { added: number; updated: number }): void {
    this.db.prepare(`
      UPDATE sync_log SET
        completed_at = datetime('now'),
        status = 'SUCCESS',
        transactions_added = ?,
        transactions_updated = ?
      WHERE id = ?
    `).run(stats.added, stats.updated, syncId);
  }

  failSync(syncId: number, errorMessage: string): void {
    this.db.prepare(`
      UPDATE sync_log SET
        completed_at = datetime('now'),
        status = 'ERROR',
        error_message = ?
      WHERE id = ?
    `).run(errorMessage, syncId);
  }

  getLastSuccessfulSync(): { completed_at: string } | undefined {
    return this.db.prepare(`
      SELECT completed_at FROM sync_log
      WHERE status = 'SUCCESS'
      ORDER BY completed_at DESC
      LIMIT 1
    `).get() as { completed_at: string } | undefined;
  }
}
