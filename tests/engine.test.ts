import { describe, test, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/storage/migrations';
import { Repository } from '../src/storage/repository';
import {
  SyncEngine,
  SyncEngineDeps,
  calculateDateRange,
  flattenInstallments,
} from '../src/sync/engine';
import { AppConfig } from '../src/config';
import { PierrePurchasesByCard } from '../src/pierre/types';

// ---------------------------------------------------------------------------
// calculateDateRange (pure)
// ---------------------------------------------------------------------------

describe('calculateDateRange', () => {
  const now = new Date('2026-07-06T12:00:00.000Z');

  test('full sync pulls 3 months back regardless of last sync', () => {
    const range = calculateDateRange('2026-07-01T12:00:00.000Z', true, now);

    expect(range).toEqual({ startDate: '2026-04-06', endDate: '2026-07-06' });
  });

  test('incremental sync starts 3 days before the last successful sync', () => {
    const range = calculateDateRange('2026-07-01T12:00:00.000Z', false, now);

    expect(range).toEqual({ startDate: '2026-06-28', endDate: '2026-07-06' });
  });

  test('falls back to 3 months back when there is no previous sync', () => {
    const range = calculateDateRange(null, false, now);

    expect(range).toEqual({ startDate: '2026-04-06', endDate: '2026-07-06' });
  });

  test('parses a naive SQLite datetime as UTC, not host-local time', () => {
    // SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS", UTC, no zone suffix.
    // Read as UTC (23:30Z minus 3 days), the start date is the 17th regardless
    // of the host timezone; a local-time misparse under TZ=America/Sao_Paulo
    // would push 23:30 to the next UTC day and shift the window.
    const range = calculateDateRange('2026-07-20 23:30:00', false, now);

    expect(range.startDate).toBe('2026-07-17');
  });

  test('still honors an explicit-zone ISO string', () => {
    const range = calculateDateRange('2026-07-20T23:30:00.000Z', false, now);
    expect(range.startDate).toBe('2026-07-17');
  });
});

// ---------------------------------------------------------------------------
// flattenInstallments (pure)
// ---------------------------------------------------------------------------

describe('flattenInstallments', () => {
  const cards: PierrePurchasesByCard[] = [
    {
      accountId: 'card-a',
      accountName: 'Nubank Cartão',
      purchases: [
        {
          description: 'TV Samsung',
          totalAmount: 1000,
          installmentsPaid: 1,
          installmentsRemaining: 1,
          amountPaid: 500,
          amountRemaining: 500,
          hasPartialSyncData: false,
          installmentsInDb: 2,
          firstInstallmentInDb: 1,
          lastInstallmentInDb: 2,
          installments: [
            {
              installmentNumber: 1,
              totalInstallments: 2,
              amount: 500,
              dueDate: '2026-06-22',
              isPaid: true,
              isProjected: false,
            },
            {
              installmentNumber: 2,
              totalInstallments: 2,
              amount: 500,
              dueDate: '2026-07-22',
              isPaid: false,
              isProjected: true,
            },
          ],
        },
      ],
    },
    {
      accountId: 'card-b',
      accountName: 'Inter Cartão',
      purchases: [
        {
          description: 'TV Samsung',
          totalAmount: 800,
          installmentsPaid: 0,
          installmentsRemaining: 2,
          amountPaid: 0,
          amountRemaining: 800,
          hasPartialSyncData: false,
          installmentsInDb: 2,
          firstInstallmentInDb: 1,
          lastInstallmentInDb: 2,
          installments: [
            {
              installmentNumber: 1,
              totalInstallments: 2,
              amount: 400,
              dueDate: '2026-07-10',
              isPaid: false,
              isProjected: false,
            },
            {
              installmentNumber: 2,
              totalInstallments: 2,
              amount: 400,
              dueDate: '2026-08-10',
              isPaid: false,
              isProjected: true,
            },
          ],
        },
      ],
    },
  ];

  test('fills accountId and accountName on every row', () => {
    const rows = flattenInstallments(cards);

    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.accountId === 'card-a')).toHaveLength(2);
    expect(rows.filter((r) => r.accountName === 'Inter Cartão')).toHaveLength(2);
    expect(rows.every((r) => r.accountId && r.accountName)).toBe(true);
  });

  test('builds unique ids even for identical purchases on different cards', () => {
    const rows = flattenInstallments(cards);
    const ids = new Set(rows.map((r) => r.id));

    expect(ids.size).toBe(rows.length);
  });

  test('builds unique ids for repeated descriptions on the same card', () => {
    const card: PierrePurchasesByCard = {
      accountId: 'card-a',
      accountName: 'Nubank Cartão',
      purchases: [
        { ...cards[0].purchases[0] },
        { ...cards[0].purchases[0] },
      ],
    };

    const rows = flattenInstallments([card]);
    const ids = new Set(rows.map((r) => r.id));

    expect(ids.size).toBe(rows.length);
  });

  test('maps installment fields faithfully', () => {
    const [first] = flattenInstallments(cards);

    expect(first.purchaseDescription).toBe('TV Samsung');
    expect(first.installmentNumber).toBe(1);
    expect(first.totalInstallments).toBe(2);
    expect(first.amount).toBe(500);
    expect(first.dueDate).toBe('2026-06-22');
    expect(first.isPaid).toBe(true);
    expect(first.isProjected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SyncEngine.run — failure and success paths against a real in-memory DB
// ---------------------------------------------------------------------------

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// A throwaway data dir per run: the sync writes financial-summary.json into
// config.dataDir, and a test must never drop that file in the repo.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-engine-test-'));

const config: AppConfig = {
  pierreApiKey: 'key',
  googleClientId: 'id',
  googleClientSecret: 'secret',
  dataDir: testDataDir,
  dbPath: ':memory:',
  logPath: path.join(testDataDir, 'sync.log'),
  tokensPath: path.join(testDataDir, 'google-tokens.json'),
  spreadsheetIdPath: path.join(testDataDir, 'spreadsheet-id.txt'),
  headless: true,
  logToFile: false,
  staleHours: 96,
};

function makeSheetsStub() {
  return {
    // Values
    clearSheet: vi.fn(async () => undefined),
    writeRows: vi.fn(async () => undefined),
    readRows: vi.fn(async () => [] as unknown[][]),
    // Metadata
    ensureLocale: vi.fn(async () => undefined),
    getSheetId: vi.fn(async () => 0),
    getSpreadsheetMeta: vi.fn(async () => ({ sheets: [] })),
    listSheetTitles: vi.fn(async () => [] as string[]),
    invalidateMeta: vi.fn(),
    // Batch
    batchUpdate: vi.fn(async () => undefined),
    // Request builders — return plain markers; the engine only forwards them.
    headerRequest: vi.fn(() => []),
    boldRowRequest: vi.fn(() => ({})),
    columnWidthRequests: vi.fn(() => []),
    numberFormatRequest: vi.fn(() => ({})),
    dateFormatRequest: vi.fn(() => ({})),
    bandingRequest: vi.fn(() => ({})),
    dataValidationRequest: vi.fn(() => ({})),
    budgetTrafficLightRequests: vi.fn(() => []),
    negativeRedRequest: vi.fn(() => ({})),
    clearConditionalFormatRequests: vi.fn(async () => []),
    getChartIds: vi.fn(async () => [] as number[]),
    replaceChartsRequests: vi.fn(async () => []),
    pieChartRequest: vi.fn(() => ({})),
    basicChartRequest: vi.fn(() => ({})),
  };
}

function makeDeps(db: Database.Database, pierre: Record<string, unknown>): SyncEngineDeps {
  return {
    getAuthClient: vi.fn(async () => ({}) as never),
    setupSpreadsheet: vi.fn(async () => ({
      spreadsheetId: 'sheet-1',
      spreadsheetUrl: 'https://example.test/sheet-1',
    })),
    createSheetsClient: vi.fn(() => makeSheetsStub() as never),
    createPierreClient: vi.fn(() => pierre as never),
    getDatabase: vi.fn(() => db),
    closeDatabase: vi.fn(),
    sleep: vi.fn(async () => undefined),
  };
}

function makePierreStub(overrides: Record<string, unknown> = {}) {
  return {
    triggerManualUpdate: vi.fn(async () => ({ success: true })),
    getAccounts: vi.fn(async () => ({
      success: true,
      count: 1,
      timestamp: '',
      data: [
        {
          id: 'acc-1',
          itemId: 'item-1',
          name: 'Nu Pagamentos',
          type: 'BANK',
          subtype: 'CHECKING_ACCOUNT',
          number: '1',
          currencyCode: 'BRL',
          balance: '9.22',
          creditData: null,
          bankData: null,
          marketingName: null,
          taxNumber: null,
          owner: 'x',
          customName: null,
          userId: 'u',
          createdAt: '',
          updatedAt: '',
          connectorName: 'Nubank',
          connectorImageUrl: null,
          itemLastUpdatedAt: null,
          itemIsActive: true,
        },
      ],
    })),
    getTransactions: vi.fn(async () => ({
      success: true,
      timestamp: '',
      data: [
        {
          id: 'tx-1',
          account_id: 'acc-1',
          description: 'Compra',
          category: 'Compras',
          original_category: 'Compras',
          tr_confidence: null,
          tr_reasoning: null,
          currency_code: 'BRL',
          amount: -50,
          amount_in_account_currency: null,
          date: '2026-06-15T12:00:00.000Z',
          installment_due_date: null,
          type: 'DEBIT',
          status: 'POSTED',
          payment_data: null,
          credit_card_data: null,
          merchant: null,
          account_name: 'Nubank',
          account_type: 'BANK',
          account_subtype: 'CHECKING_ACCOUNT',
          account_item_id: 'item-1',
          connector_name: 'Nubank',
          connector_image_url: '',
        },
      ],
    })),
    getInstallments: vi.fn(async () => ({
      success: true,
      data: {
        summary: {},
        purchasesByCard: [
          {
            accountId: 'acc-1',
            accountName: 'Nubank Cartão',
            purchases: [
              {
                description: 'TV',
                totalAmount: 100,
                installmentsPaid: 0,
                installmentsRemaining: 1,
                amountPaid: 0,
                amountRemaining: 100,
                hasPartialSyncData: false,
                installmentsInDb: 1,
                firstInstallmentInDb: 1,
                lastInstallmentInDb: 1,
                installments: [
                  {
                    installmentNumber: 1,
                    totalInstallments: 1,
                    amount: 100,
                    dueDate: '2026-07-22',
                    isPaid: false,
                    isProjected: false,
                  },
                ],
              },
            ],
          },
        ],
        purchases: [],
        instructions: null,
      },
    })),
    getBillSummary: vi.fn(async () => ({ success: true, data: { accounts: [] } })),
    ...overrides,
  };
}

describe('SyncEngine.run', () => {
  test('marks the sync as ERROR in sync_log when a step throws', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const pierre = makePierreStub({
      getAccounts: vi.fn(async () => {
        throw new Error('Pierre exploded');
      }),
    });
    const engine = new SyncEngine(config, noopLogger, makeDeps(db, pierre));

    await expect(
      engine.run({ fullSync: false, dryRun: false, skipUpdate: true, setupOnly: false }),
    ).rejects.toThrow('Pierre exploded');

    const row = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').get() as any;
    expect(row.status).toBe('ERROR');
    expect(row.error_message).toContain('Pierre exploded');
    expect(row.completed_at).not.toBeNull();
  });

  test('completes successfully, persisting transactions and installments', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const engine = new SyncEngine(config, noopLogger, makeDeps(db, makePierreStub()));

    await engine.run({ fullSync: false, dryRun: false, skipUpdate: true, setupOnly: false });

    const sync = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').get() as any;
    expect(sync.status).toBe('SUCCESS');
    expect(sync.transactions_added).toBe(1);

    const tx = db.prepare('SELECT * FROM transactions').all() as any[];
    expect(tx).toHaveLength(1);
    expect(tx[0].direction).toBe('EXPENSE');

    const inst = db.prepare('SELECT * FROM installments').all() as any[];
    expect(inst).toHaveLength(1);
    expect(inst[0].account_name).toBe('Nubank Cartão');
    expect(inst[0].account_id).toBe('acc-1');
  });

  test('dry run writes nothing to the database', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const engine = new SyncEngine(config, noopLogger, makeDeps(db, makePierreStub()));

    await engine.run({ fullSync: false, dryRun: true, skipUpdate: true, setupOnly: false });

    expect(db.prepare('SELECT COUNT(*) c FROM sync_log').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM transactions').get()).toEqual({ c: 0 });
  });

  test('setup-only stops before touching Pierre', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const pierre = makePierreStub();
    const deps = makeDeps(db, pierre);
    const engine = new SyncEngine(config, noopLogger, deps);

    await engine.run({ fullSync: false, dryRun: false, skipUpdate: false, setupOnly: true });

    expect(pierre.getAccounts).not.toHaveBeenCalled();
    expect(deps.createPierreClient).not.toHaveBeenCalled();
  });

  test('a persistent installments FETCH failure does not sink the sync', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const pierre = makePierreStub({
      getInstallments: vi.fn(async () => {
        throw new Error('installments endpoint 500');
      }),
    });
    const engine = new SyncEngine(config, noopLogger, makeDeps(db, pierre));

    await engine.run({ fullSync: false, dryRun: false, skipUpdate: true, setupOnly: false });

    // Transactions persisted, sync SUCCESS, and existing installments untouched.
    expect((db.prepare('SELECT status FROM sync_log ORDER BY id DESC LIMIT 1').get() as any).status).toBe('SUCCESS');
    expect((db.prepare('SELECT COUNT(*) c FROM transactions').get() as any).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM installments').get() as any).c).toBe(0);
  });

  test('an installments DB-WRITE failure fails the sync loudly (not swallowed as SUCCESS)', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const spy = vi
      .spyOn(Repository.prototype, 'replaceInstallments')
      .mockImplementation(() => {
        throw new Error('disk full');
      });

    const engine = new SyncEngine(config, noopLogger, makeDeps(db, makePierreStub()));

    await expect(
      engine.run({ fullSync: false, dryRun: false, skipUpdate: true, setupOnly: false }),
    ).rejects.toThrow('disk full');

    const row = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').get() as any;
    expect(row.status).toBe('ERROR');
    expect(row.error_message).toContain('disk full');

    spy.mockRestore();
  });
});
