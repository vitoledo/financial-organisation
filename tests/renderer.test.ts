import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/storage/migrations';
import { Repository } from '../src/storage/repository';
import { SheetsRenderer } from '../src/sheets/renderer';
import { SHEET_NAMES } from '../src/sheets/names';
import { NormalizedTransaction } from '../src/pierre/normalizer';

// A recording stub for the Sheets client: captures what each tab was written
// with, so we can assert the renderer's orchestration and the builder output
// end to end without hitting the network.
function makeRecordingClient(configTabs: Record<string, unknown[][]> = {}) {
  const writes = new Map<string, unknown[][]>();
  const cleared: string[] = [];

  return {
    writes,
    cleared,
    ensureLocale: vi.fn(async () => undefined),
    clearSheet: vi.fn(async (sheet: string) => { cleared.push(sheet); }),
    writeRows: vi.fn(async (sheet: string, rows: unknown[][]) => { writes.set(sheet, rows); }),
    readRows: vi.fn(async (sheet: string) => configTabs[sheet] ?? []),
    getSheetId: vi.fn(async () => 0),
    batchUpdate: vi.fn(async () => undefined),
    headerRequest: vi.fn(() => []),
    boldRowRequest: vi.fn(() => ({})),
    columnWidthRequests: vi.fn(() => []),
    numberFormatRequest: vi.fn(() => ({})),
    budgetTrafficLightRequests: vi.fn(() => []),
    negativeRedRequest: vi.fn(() => ({})),
    clearConditionalFormatRequests: vi.fn(async () => []),
    replaceChartsRequests: vi.fn(async () => []),
    pieChartRequest: vi.fn(() => ({})),
    basicChartRequest: vi.fn(() => ({})),
  };
}

function makeTx(overrides: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  return {
    id: 'tx-1',
    accountId: 'acc-1',
    date: '2026-07-15T12:00:00.000Z',
    description: 'Compra',
    amount: -100,
    originalAmount: -100,
    direction: 'EXPENSE',
    categoryPierre: 'Supermercado',
    accountName: 'Nubank Conta',
    accountType: 'BANK',
    status: 'POSTED',
    rawJson: '{}',
    ...overrides,
  };
}

describe('SheetsRenderer.renderAll', () => {
  let db: Database.Database;
  let repo: Repository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    repo = new Repository(db);

    repo.upsertAccount({
      id: 'acc-1', name: 'Nubank Conta', type: 'BANK', subtype: 'CHECKING_ACCOUNT',
      connectorName: 'Nubank', closingBalance: 9.22, creditLimit: null, availableCredit: null, rawJson: '{}',
    });
    repo.upsertTransaction(
      makeTx({ id: 'a', amount: -100 }),
      { categoryPierre: 'Supermercado', categoryMapped: 'Alimentação', group: 'Necessidade', variability: 'Variável' },
    );
    repo.upsertTransaction(makeTx({ id: 'b', amount: 2000, direction: 'INCOME', categoryPierre: 'Salário' }));
  });

  test('clears and writes every data tab', async () => {
    const client = makeRecordingClient();
    const renderer = new SheetsRenderer(client as never, repo);

    await renderer.renderAll();

    for (const tab of [
      SHEET_NAMES.BALANCE,
      SHEET_NAMES.TRANSACTIONS,
      SHEET_NAMES.MONTHLY_SUMMARY,
      SHEET_NAMES.ANNUAL,
      SHEET_NAMES.CURRENT_BILL,
      SHEET_NAMES.FUTURE_COMMITMENTS,
      SHEET_NAMES.DASHBOARD,
    ]) {
      expect(client.cleared).toContain(tab);
      expect(client.writes.has(tab)).toBe(true);
    }
  });

  test('never writes to the user-owned config tabs', async () => {
    const client = makeRecordingClient();
    const renderer = new SheetsRenderer(client as never, repo);

    await renderer.renderAll();

    expect(client.writes.has(SHEET_NAMES.CONFIG_CATEGORIES)).toBe(false);
    expect(client.writes.has(SHEET_NAMES.CONFIG_BUDGET)).toBe(false);
  });

  test('writes balances as numbers with a totals row', async () => {
    const client = makeRecordingClient();
    await new SheetsRenderer(client as never, repo).renderAll();

    const balance = client.writes.get(SHEET_NAMES.BALANCE)!;
    expect(balance[1][0]).toBe('Nubank Conta');
    expect(balance[1][2]).toBe(9.22);
    expect(balance[balance.length - 1][0]).toBe('TOTAL (contas)');
  });

  test('transactions tab carries the month helper and signed amount', async () => {
    const client = makeRecordingClient();
    await new SheetsRenderer(client as never, repo).renderAll();

    const tx = client.writes.get(SHEET_NAMES.TRANSACTIONS)!;
    const expenseRow = tx.slice(1).find((r) => r[5] === -100)!;
    expect(expenseRow[5]).toBe(-100);     // amount as number, sign preserved
    expect(expenseRow[8]).toBe('2026-07'); // month key
    // Every data row carries a yyyy-mm helper for the dashboard SUMIFS.
    expect(tx.slice(1).every((r) => /^\d{4}-\d{2}$/.test(String(r[8])))).toBe(true);
  });

  test('monthly summary lists the expense category, not income', async () => {
    const client = makeRecordingClient();
    await new SheetsRenderer(client as never, repo).renderAll();

    const summary = client.writes.get(SHEET_NAMES.MONTHLY_SUMMARY)!;
    const categoryCol = summary.slice(1).map((r) => r[0]);
    expect(categoryCol).toContain('Alimentação');
    expect(categoryCol).not.toContain('Salário');
  });

  test('shows an empty-state message when there are no transactions', async () => {
    const emptyDb = new Database(':memory:');
    runMigrations(emptyDb);
    const client = makeRecordingClient();

    await new SheetsRenderer(client as never, new Repository(emptyDb)).renderAll();

    const summary = client.writes.get(SHEET_NAMES.MONTHLY_SUMMARY)!;
    expect(String(summary[0][0])).toContain('Nenhuma transação');
  });
});

describe('SheetsRenderer config reads', () => {
  let repo: Repository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    repo = new Repository(db);
  });

  test('reads category mappings, dropping the em-dash placeholder group', async () => {
    const client = makeRecordingClient({
      [SHEET_NAMES.CONFIG_CATEGORIES]: [
        ['Categoria Pierre', 'Categoria Planilha', 'Grupo 50/30/20', 'Fixa/Variável'],
        ['Supermercado', 'Alimentação', 'Necessidade', 'Variável'],
        ['Transferências', '(Transferência)', '—', '—'],
        ['', '', '', ''],
      ],
    });

    const mappings = await new SheetsRenderer(client as never, repo).readCategoryMappings();

    expect(mappings.size).toBe(2);
    expect(mappings.get('Supermercado')).toMatchObject({
      categoryMapped: 'Alimentação',
      group: 'Necessidade',
    });
    expect(mappings.get('Transferências')!.group).toBe('');
  });

  test('falls back to the Pierre category when the mapped column is blank', async () => {
    const client = makeRecordingClient({
      [SHEET_NAMES.CONFIG_CATEGORIES]: [
        ['Categoria Pierre', 'Categoria Planilha', 'Grupo', 'Var'],
        ['Estranha', '', '', ''],
      ],
    });

    const mappings = await new SheetsRenderer(client as never, repo).readCategoryMappings();

    expect(mappings.get('Estranha')!.categoryMapped).toBe('Estranha');
  });

  test('parses the budget config tab', async () => {
    const client = makeRecordingClient({
      [SHEET_NAMES.CONFIG_BUDGET]: [
        ['Parâmetro', 'Valor', ''],
        ['Renda Líquida Mensal', 'R$ 5.000,00', ''],
        ['% Necessidades', '50%', ''],
        ['', '', ''],
        ['Categoria', 'Orçamento Mensal (R$)', ''],
        ['Alimentação', '1.200,00', ''],
      ],
    });

    const budget = await new SheetsRenderer(client as never, repo).readBudgetConfig();

    expect(budget.netIncome).toBe(5000);
    expect(budget.groupTargets.get('Necessidade')).toBeCloseTo(0.5);
    expect(budget.categoryBudgets.get('Alimentação')).toBe(1200);
  });
});
