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
  last_synced_at: string | null;
}

export interface TransactionRow {
  id: string;
  date: string;
  description: string;
  category_mapped: string | null;
  category_pierre: string | null;
  category_group: string | null;
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
      INSERT INTO accounts (id, name, type, subtype, connector_name, closing_balance, credit_limit, available_credit, last_synced_at, raw_json)
      VALUES (@id, @name, @type, @subtype, @connectorName, @closingBalance, @creditLimit, @availableCredit, datetime('now'), @rawJson)
      ON CONFLICT(id) DO UPDATE SET
        name = @name,
        closing_balance = @closingBalance,
        credit_limit = @creditLimit,
        available_credit = @availableCredit,
        last_synced_at = datetime('now'),
        raw_json = @rawJson
    `);
    stmt.run(account);
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
