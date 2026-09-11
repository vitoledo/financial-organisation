import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/storage/migrations';
import { Repository, CategoryMapping } from '../src/storage/repository';
import { NormalizedTransaction, NormalizedAccount } from '../src/pierre/normalizer';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeAccount(overrides: Partial<NormalizedAccount> = {}): NormalizedAccount {
  return {
    id: 'acc-1',
    name: 'Nubank Conta',
    type: 'BANK',
    subtype: 'CHECKING_ACCOUNT',
    connectorName: 'Nubank',
    closingBalance: 9.22,
    creditLimit: null,
    availableCredit: null,
    automaticallyInvestedBalance: null,
    reservedTotal: null,
    rawJson: '{}',
    ...overrides,
  };
}

function makeTx(overrides: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  return {
    id: 'tx-1',
    accountId: 'acc-1',
    date: '2026-06-15T12:00:00.000Z',
    description: 'Compra teste',
    amount: -100,
    originalAmount: -100,
    direction: 'EXPENSE',
    categoryPierre: 'Compras',
    accountName: 'Nubank Conta',
    accountType: 'BANK',
    status: 'POSTED',
    rawJson: '{}',
    ...overrides,
  };
}

const FOOD_MAPPING: CategoryMapping = {
  categoryPierre: 'Supermercado',
  categoryMapped: 'Alimentação',
  group: 'Necessidade',
  variability: 'Variável',
};

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

describe('Repository accounts', () => {
  let db: Database.Database;
  let repo: Repository;

  beforeEach(() => {
    db = makeDb();
    repo = new Repository(db);
  });

  test('upsertAccount inserts and then updates on conflict', () => {
    repo.upsertAccount(makeAccount());
    repo.upsertAccount(makeAccount({ closingBalance: 42.5, name: 'Nubank Conta 2' }));

    const accounts = repo.getAllAccounts();

    expect(accounts).toHaveLength(1);
    expect(accounts[0].closing_balance).toBe(42.5);
    expect(accounts[0].name).toBe('Nubank Conta 2');
  });
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

describe('Repository transactions', () => {
  let db: Database.Database;
  let repo: Repository;

  beforeEach(() => {
    db = makeDb();
    repo = new Repository(db);
    repo.upsertAccount(makeAccount());
  });

  test('upsertTransaction returns added on first insert', () => {
    expect(repo.upsertTransaction(makeTx())).toBe('added');
  });

  test('upsertTransaction returns unchanged for identical data', () => {
    repo.upsertTransaction(makeTx());
    expect(repo.upsertTransaction(makeTx())).toBe('unchanged');
  });

  test('upsertTransaction returns updated when amount changes', () => {
    repo.upsertTransaction(makeTx({ amount: -100 }));
    expect(repo.upsertTransaction(makeTx({ amount: -120 }))).toBe('updated');

    const all = repo.getAllTransactions();
    expect(all[0].amount).toBe(-120);
  });

  test('applies category mapping when provided', () => {
    repo.upsertTransaction(makeTx({ categoryPierre: 'Supermercado' }), FOOD_MAPPING);

    const [tx] = repo.getAllTransactions();

    expect(tx.category_mapped).toBe('Alimentação');
    expect(tx.category_group).toBe('Necessidade');
    expect(tx.category_variability).toBe('Variável');
  });

  test('falls back to Pierre category without mapping', () => {
    repo.upsertTransaction(makeTx({ categoryPierre: 'Compras' }));

    const [tx] = repo.getAllTransactions();

    expect(tx.category_mapped).toBe('Compras');
  });

  test('upsertTransactions reports bulk stats', () => {
    repo.upsertTransaction(makeTx({ id: 'a', amount: -10 }));

    const stats = repo.upsertTransactions(
      [makeTx({ id: 'a', amount: -20 }), makeTx({ id: 'b' }), makeTx({ id: 'b' })],
      new Map(),
    );

    expect(stats).toEqual({ added: 1, updated: 1, unchanged: 1 });
  });

  test('getTransactionsByMonth handles the December→January boundary', () => {
    repo.upsertTransaction(makeTx({ id: 'dec', date: '2026-12-15T10:00:00.000Z' }));
    repo.upsertTransaction(makeTx({ id: 'jan', date: '2027-01-02T10:00:00.000Z' }));

    const december = repo.getTransactionsByMonth(2026, 12);
    const january = repo.getTransactionsByMonth(2027, 1);

    expect(december.map((t) => t.id)).toEqual(['dec']);
    expect(january.map((t) => t.id)).toEqual(['jan']);
  });

  test('getDistinctMonths returns months in descending order', () => {
    repo.upsertTransaction(makeTx({ id: 'a', date: '2026-05-10T00:00:00.000Z' }));
    repo.upsertTransaction(makeTx({ id: 'b', date: '2026-06-10T00:00:00.000Z' }));
    repo.upsertTransaction(makeTx({ id: 'c', date: '2025-12-10T00:00:00.000Z' }));

    expect(repo.getDistinctMonths()).toEqual([
      { year: 2026, month: 6 },
      { year: 2026, month: 5 },
      { year: 2025, month: 12 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Monthly aggregations
// ---------------------------------------------------------------------------

describe('Repository monthly aggregations', () => {
  let db: Database.Database;
  let repo: Repository;

  beforeEach(() => {
    db = makeDb();
    repo = new Repository(db);
    repo.upsertAccount(makeAccount());

    repo.upsertTransaction(
      makeTx({ id: 'food-1', amount: -100, categoryPierre: 'Supermercado' }),
      FOOD_MAPPING,
    );
    repo.upsertTransaction(
      makeTx({ id: 'food-2', amount: -50, categoryPierre: 'Supermercado' }),
      FOOD_MAPPING,
    );
    repo.upsertTransaction(makeTx({ id: 'salary', amount: 1000, direction: 'INCOME' }));
    repo.upsertTransaction(
      makeTx({ id: 'bill-pay', amount: -300, direction: 'TRANSFER' }),
    );
  });

  test('getMonthlySummary sums only EXPENSE grouped by mapped category', () => {
    const summary = repo.getMonthlySummary(2026, 6);

    expect(summary).toHaveLength(1);
    expect(summary[0].category_mapped).toBe('Alimentação');
    expect(summary[0].total).toBe(-150);
    expect(summary[0].count).toBe(2);
    expect(summary[0].category_group).toBe('Necessidade');
  });

  test('getMonthlyIncome sums only INCOME', () => {
    expect(repo.getMonthlyIncome(2026, 6)).toBe(1000);
  });

  test('getMonthlyIncome returns 0 for empty months', () => {
    expect(repo.getMonthlyIncome(2020, 1)).toBe(0);
  });

  test('getExpenseCategories lists expense categories with their group, biggest first', () => {
    repo.upsertTransaction(
      makeTx({ id: 'fun-1', amount: -20, categoryPierre: 'Lazer' }),
      { categoryPierre: 'Lazer', categoryMapped: 'Lazer', group: 'Desejo', variability: 'Variável' },
    );

    const categories = repo.getExpenseCategories();

    expect(categories).toEqual([
      { category: 'Alimentação', group: 'Necessidade' },
      { category: 'Lazer', group: 'Desejo' },
    ]);
  });

  test('getExpenseCategories excludes income and transfers', () => {
    const categories = repo.getExpenseCategories().map((c) => c.category);

    expect(categories).toContain('Alimentação');
    expect(categories).not.toContain('Compras'); // only used by INCOME/TRANSFER fixtures
  });
});

// ---------------------------------------------------------------------------
// Installments
// ---------------------------------------------------------------------------

describe('Repository installments', () => {
  let db: Database.Database;
  let repo: Repository;

  const installment = (overrides: Record<string, unknown> = {}) => ({
    id: 'inst-1',
    purchaseDescription: 'TV',
    installmentNumber: 1,
    totalInstallments: 10,
    amount: 100,
    dueDate: '2026-07-22',
    isPaid: false,
    isProjected: false,
    accountId: 'acc-1',
    accountName: 'Nubank Cartão',
    ...overrides,
  });

  beforeEach(() => {
    db = makeDb();
    repo = new Repository(db);
    repo.upsertAccount(makeAccount());
  });

  test('replaceInstallments fully replaces previous rows', () => {
    repo.replaceInstallments([installment(), installment({ id: 'inst-2' })]);
    repo.replaceInstallments([installment({ id: 'inst-3' })]);

    const rows = repo.getUnpaidInstallments();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('inst-3');
  });

  test('getUnpaidInstallments filters paid and orders by due date', () => {
    repo.replaceInstallments([
      installment({ id: 'late', dueDate: '2026-09-22' }),
      installment({ id: 'paid', isPaid: true }),
      installment({ id: 'soon', dueDate: '2026-08-22', isProjected: true }),
    ]);

    const rows = repo.getUnpaidInstallments();

    expect(rows.map((r) => r.id)).toEqual(['soon', 'late']);
    expect(rows[0].is_projected).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Sync log
// ---------------------------------------------------------------------------

describe('Repository sync log', () => {
  let db: Database.Database;
  let repo: Repository;

  beforeEach(() => {
    db = makeDb();
    repo = new Repository(db);
  });

  test('startSync creates a RUNNING row', () => {
    const syncId = repo.startSync();
    const row = db.prepare('SELECT * FROM sync_log WHERE id = ?').get(syncId) as any;

    expect(row.status).toBe('RUNNING');
    expect(row.completed_at).toBeNull();
  });

  test('completeSync marks SUCCESS with counters', () => {
    const syncId = repo.startSync();
    repo.completeSync(syncId, { added: 5, updated: 2 });

    const row = db.prepare('SELECT * FROM sync_log WHERE id = ?').get(syncId) as any;

    expect(row.status).toBe('SUCCESS');
    expect(row.transactions_added).toBe(5);
    expect(row.transactions_updated).toBe(2);
    expect(row.completed_at).not.toBeNull();
  });

  test('failSync marks ERROR with message', () => {
    const syncId = repo.startSync();
    repo.failSync(syncId, 'Pierre API error 500');

    const row = db.prepare('SELECT * FROM sync_log WHERE id = ?').get(syncId) as any;

    expect(row.status).toBe('ERROR');
    expect(row.error_message).toBe('Pierre API error 500');
  });

  test('getLastSuccessfulSync ignores failed syncs', () => {
    const failed = repo.startSync();
    repo.failSync(failed, 'boom');

    expect(repo.getLastSuccessfulSync()).toBeUndefined();

    const ok = repo.startSync();
    repo.completeSync(ok, { added: 0, updated: 0 });

    expect(repo.getLastSuccessfulSync()?.completed_at).toBeTruthy();
  });
});
