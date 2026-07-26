import { describe, test, expect } from 'vitest';
import {
  columnLetter,
  formatDateBR,
  monthKey,
  parseMoneyBR,
  parsePercent,
  directionLabel,
  statusLabel,
  accountTypeLabel,
  buildBalanceRows,
  buildTransactionRows,
  buildMonthlySummaryHeader,
  buildMonthlySummaryRows,
  buildMonthlySummaryTotalRow,
  buildAnnualRows,
  buildDashboardData,
  buildCurrentBillRows,
  buildCommitmentRows,
  parseBudgetConfig,
  lastMonths,
  DASHBOARD_LAYOUT,
  TransactionRow,
} from '../src/sheets/builders';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

describe('columnLetter', () => {
  test.each([
    [0, 'A'],
    [1, 'B'],
    [25, 'Z'],
    [26, 'AA'],
    [27, 'AB'],
    [51, 'AZ'],
    [52, 'BA'],
  ])('index %i → %s', (index, expected) => {
    expect(columnLetter(index)).toBe(expected);
  });
});

describe('formatDateBR', () => {
  test('formats an ISO timestamp as dd/mm/yyyy', () => {
    expect(formatDateBR('2026-06-15T12:00:00.000Z')).toBe('15/06/2026');
  });

  test('formats a bare ISO date', () => {
    expect(formatDateBR('2026-07-22')).toBe('22/07/2026');
  });

  test('does not shift the day across the timezone offset', () => {
    // 02:00Z is 23:00 of the previous day in America/Sao_Paulo. SQL filters on
    // the raw string, so the sheet must agree with SQL and keep June 1st.
    expect(formatDateBR('2026-06-01T02:00:00.000Z')).toBe('01/06/2026');
  });

  test('returns empty string for garbage input', () => {
    expect(formatDateBR('')).toBe('');
  });
});

describe('monthKey', () => {
  test('extracts yyyy-mm consistent with SQL filtering', () => {
    expect(monthKey('2026-06-01T02:00:00.000Z')).toBe('2026-06');
    expect(monthKey('2026-12-31T23:59:59.000Z')).toBe('2026-12');
  });
});

describe('parseMoneyBR', () => {
  test.each([
    ['R$ 1.234,56', 1234.56],
    ['1.234,56', 1234.56],
    ['1234,56', 1234.56],
    ['500', 500],
    ['R$ 2.000,00', 2000],
    ['0,99', 0.99],
  ])('parses %s → %d', (input, expected) => {
    expect(parseMoneyBR(input)).toBeCloseTo(expected, 2);
  });

  test('passes numbers through', () => {
    expect(parseMoneyBR(1234.56)).toBe(1234.56);
  });

  test('returns null for empty or invalid values', () => {
    expect(parseMoneyBR('')).toBeNull();
    expect(parseMoneyBR('abc')).toBeNull();
    expect(parseMoneyBR(undefined)).toBeNull();
    expect(parseMoneyBR(null)).toBeNull();
  });
});

describe('parsePercent', () => {
  test.each([
    ['50%', 0.5],
    ['30%', 0.3],
    ['20', 0.2],
    [0.5, 0.5],
    [50, 0.5],
  ])('parses %s → %d', (input, expected) => {
    expect(parsePercent(input)).toBeCloseTo(expected, 4);
  });

  test('returns null for blanks', () => {
    expect(parsePercent('')).toBeNull();
  });
});

describe('labels', () => {
  test('translates direction, status and account subtype', () => {
    expect(directionLabel('INCOME')).toBe('Entrada');
    expect(directionLabel('EXPENSE')).toBe('Saída');
    expect(directionLabel('TRANSFER')).toBe('Transferência');
    expect(statusLabel('POSTED')).toBe('Confirmado');
    expect(statusLabel('PENDING')).toBe('Pendente');
    expect(accountTypeLabel('CREDIT_CARD')).toBe('Cartão de Crédito');
    expect(accountTypeLabel('CHECKING_ACCOUNT')).toBe('Conta Corrente');
  });
});

// ---------------------------------------------------------------------------
// Saldo
// ---------------------------------------------------------------------------

describe('buildBalanceRows', () => {
  const accounts = [
    {
      name: 'Nubank Conta',
      type: 'BANK',
      subtype: 'CHECKING_ACCOUNT',
      closing_balance: 9.22,
      credit_limit: null,
      available_credit: null,
      last_synced_at: '2026-07-06T10:00:00.000Z',
    },
    {
      name: 'Nubank Cartão',
      type: 'CREDIT',
      subtype: 'CREDIT_CARD',
      closing_balance: null,
      credit_limit: 1550,
      available_credit: 200,
      last_synced_at: '2026-07-06T10:00:00.000Z',
    },
  ];

  test('writes balances as numbers, not formatted strings', () => {
    const [, first] = buildBalanceRows(accounts);

    expect(first[2]).toBe(9.22);
    expect(typeof first[2]).toBe('number');
  });

  test('leaves missing values empty so the column stays numeric', () => {
    const [, , card] = buildBalanceRows(accounts);

    expect(card[2]).toBe('');
    expect(card[3]).toBe(1550);
    expect(card[4]).toBe(200);
  });

  test('appends a total row that sums only cash accounts', () => {
    const rows = buildBalanceRows(accounts);
    const total = rows[rows.length - 1];

    expect(total[0]).toBe('TOTAL (contas)');
    expect(total[2]).toContain('SUMIF');
    expect(total[2]).toContain('Conta Corrente');
    expect(total[2]).not.toContain('Cartão de Crédito');
  });

  test('omits the total row when there are no accounts', () => {
    expect(buildBalanceRows([])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Transações
// ---------------------------------------------------------------------------

describe('buildTransactionRows', () => {
  const tx: TransactionRow = {
    date: '2026-06-15T12:00:00.000Z',
    description: 'Mercado',
    category_mapped: 'Alimentação',
    category_pierre: 'Supermercado',
    category_group: 'Necessidade',
    direction: 'EXPENSE',
    amount: -150.5,
    account_name: 'Nubank Conta',
    status: 'POSTED',
  };

  test('emits amount as a number and adds the month helper column', () => {
    const [, row] = buildTransactionRows([tx]);

    expect(row[5]).toBe(-150.5);
    expect(row[8]).toBe('2026-06');
    expect(row[0]).toBe('15/06/2026');
  });

  test('carries the 50/30/20 group for dashboard SUMIFS', () => {
    const [, row] = buildTransactionRows([tx]);
    expect(row[3]).toBe('Necessidade');
  });

  test('falls back through mapped → pierre → Outros', () => {
    const [, mapped] = buildTransactionRows([tx]);
    const [, pierre] = buildTransactionRows([{ ...tx, category_mapped: null }]);
    const [, fallback] = buildTransactionRows([
      { ...tx, category_mapped: null, category_pierre: null },
    ]);

    expect(mapped[2]).toBe('Alimentação');
    expect(pierre[2]).toBe('Supermercado');
    expect(fallback[2]).toBe('Outros');
  });
});

// ---------------------------------------------------------------------------
// Resumo Mensal
// ---------------------------------------------------------------------------

describe('buildMonthlySummary', () => {
  const months = [{ year: 2026, month: 6 }, { year: 2026, month: 5 }];
  const categories = [
    { category: 'Alimentação', group: 'Necessidade' },
    { category: 'Lazer', group: 'Desejo' },
  ];

  test('header has 2 fixed columns plus 4 per month', () => {
    const header = buildMonthlySummaryHeader(months);

    expect(header).toHaveLength(2 + months.length * 4);
    expect(header[0]).toBe('Categoria');
    expect(header[2]).toBe('Junho/2026 · Orçado');
    expect(header[5]).toBe('Junho/2026 · % Usado');
    expect(header[6]).toBe('Maio/2026 · Orçado');
  });

  test('Orçado pulls the budget live from the config tab', () => {
    const [row] = buildMonthlySummaryRows(categories, months);

    expect(row[2]).toBe(`=IFERROR(VLOOKUP($A2,'Config: Orçamento'!$A:$B,2,FALSE),0)`);
  });

  test('Realizado sums the transaction log for that category and month', () => {
    const [row] = buildMonthlySummaryRows(categories, months);
    const formula = row[3] as string;

    expect(formula).toContain('SUMIFS');
    expect(formula).toContain(`'Transações'!$F:$F`);
    expect(formula).toContain('"2026-06"');
    expect(formula).toContain('"Saída"');
    expect(formula.startsWith('=-SUMIFS')).toBe(true);
  });

  test('Diferença and % Usado reference the sibling cells with a zero guard', () => {
    const [row] = buildMonthlySummaryRows(categories, months);

    expect(row[4]).toBe('=C2-D2');
    expect(row[5]).toBe('=IF(C2>0,D2/C2,"")');
  });

  test('second month block shifts four columns to the right', () => {
    const [row] = buildMonthlySummaryRows(categories, months);

    expect(row[8]).toBe('=G2-H2');
    expect(row[9]).toBe('=IF(G2>0,H2/G2,"")');
  });

  test('rows advance with the category index', () => {
    const [, second] = buildMonthlySummaryRows(categories, months);

    expect(second[0]).toBe('Lazer');
    expect(second[4]).toBe('=C3-D3');
  });

  test('total row sums each month block', () => {
    const total = buildMonthlySummaryTotalRow(categories, months);

    expect(total[0]).toBe('TOTAL');
    expect(total[2]).toBe('=SUM(C2:C3)');
    expect(total[3]).toBe('=SUM(D2:D3)');
  });

  test('total row degrades to zeros with no categories', () => {
    const total = buildMonthlySummaryTotalRow([], months);
    expect(total[2]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Consolidado Anual
// ---------------------------------------------------------------------------

describe('buildAnnualRows', () => {
  const categories = [
    { category: 'Alimentação', group: 'Necessidade' },
    { category: 'Transporte', group: 'Necessidade' },
  ];

  test('has a column per month plus total, average and share', () => {
    const [header] = buildAnnualRows(categories, 2026);

    expect(header).toHaveLength(1 + 12 + 3);
    expect(header[1]).toBe('Janeiro');
    expect(header[12]).toBe('Dezembro');
    expect(header[13]).toBe('Total 2026');
  });

  test('each month cell sums that category and month', () => {
    const [, row] = buildAnnualRows(categories, 2026);

    expect(row[1]).toContain('"2026-01"');
    expect(row[12]).toContain('"2026-12"');
  });

  test('total, average and share are formulas', () => {
    const [, row] = buildAnnualRows(categories, 2026);

    expect(row[13]).toBe('=SUM(B2:M2)');
    expect(row[14]).toContain('AVERAGEIF');
    expect(row[15]).toContain('IFERROR');
  });

  test('appends a TOTAL row', () => {
    const rows = buildAnnualRows(categories, 2026);
    const total = rows[rows.length - 1];

    expect(total[0]).toBe('TOTAL');
    expect(total[1]).toBe('=SUM(B2:B3)');
  });

  test('returns only the header when there are no categories', () => {
    expect(buildAnnualRows([], 2026)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

describe('buildDashboardData', () => {
  const topCategories = [
    { category_mapped: 'Alimentação', total: -300 },
    { category_mapped: 'Transporte', total: -200 },
    { category_mapped: null, total: -100 },
  ];
  const data = buildDashboardData({
    year: 2026,
    month: 7,
    topCategories,
    totalExpenses: 600,
  });
  const at = (row1Based: number) => data[row1Based - 1];

  test('income and expenses are month-filtered formulas', () => {
    expect(at(3)[0]).toBe('Receitas do mês');
    expect(at(3)[1]).toContain('"2026-07"');
    expect(at(3)[1]).toContain('"Entrada"');
    expect(at(4)[1]).toContain('"Saída"');
  });

  test('savings rate guards against zero income', () => {
    expect(at(6)[0]).toBe('Taxa de poupança');
    expect(at(6)[1]).toBe('=IF(B3>0,(B3-B4)/B3,"")');
  });

  test('50/30/20 rows sit at the layout rows the chart anchors to', () => {
    expect(at(DASHBOARD_LAYOUT.GROUPS_FIRST_ROW)[0]).toBe('Necessidade');
    expect(at(DASHBOARD_LAYOUT.GROUPS_LAST_ROW)[0]).toBe('Poupança');
  });

  test('50/30/20 rows compare realizado against the configured target', () => {
    const needs = at(DASHBOARD_LAYOUT.GROUPS_FIRST_ROW);

    expect(needs[1]).toContain('"Necessidade"');
    expect(needs[2]).toContain(`'Config: Orçamento'!$B$2`);
  });

  test('top categories start at the anchored row with absolute numbers and share', () => {
    expect(at(DASHBOARD_LAYOUT.TOP_HEADER_ROW)[0]).toBe('TOP CATEGORIAS DO MÊS');
    expect(at(DASHBOARD_LAYOUT.TOP_FIRST_ROW)).toEqual(['Alimentação', 300, 0.5]);
    expect(at(DASHBOARD_LAYOUT.TOP_FIRST_ROW + 2)[0]).toBe('Outros');
  });

  test('pads the top categories block so the chart range never moves', () => {
    expect(at(DASHBOARD_LAYOUT.TOP_LAST_ROW)).toEqual(['', '', '']);
    expect(at(DASHBOARD_LAYOUT.EVOLUTION_HEADER_ROW)[0]).toBe('Mês');
  });

  test('guards division by zero in the share column', () => {
    const zeroed = buildDashboardData({
      year: 2026, month: 7, topCategories, totalExpenses: 0,
    });
    expect(zeroed[DASHBOARD_LAYOUT.TOP_FIRST_ROW - 1][2]).toBe('');
  });

  test('evolution block covers 12 months ending at the current one', () => {
    const first = at(DASHBOARD_LAYOUT.EVOLUTION_FIRST_ROW);
    const last = at(DASHBOARD_LAYOUT.EVOLUTION_LAST_ROW);

    expect(first[0]).toBe('Ago/2025');
    expect(last[0]).toBe('Jul/2026');
    expect(last[1]).toContain('"2026-07"');
    expect(last[3]).toBe(`=B${DASHBOARD_LAYOUT.EVOLUTION_LAST_ROW}-C${DASHBOARD_LAYOUT.EVOLUTION_LAST_ROW}`);
  });
});

describe('lastMonths', () => {
  test('walks back across a year boundary', () => {
    expect(lastMonths(2026, 2, 4)).toEqual([
      { year: 2025, month: 11 },
      { year: 2025, month: 12 },
      { year: 2026, month: 1 },
      { year: 2026, month: 2 },
    ]);
  });

  test('returns the month itself for count = 1', () => {
    expect(lastMonths(2026, 7, 1)).toEqual([{ year: 2026, month: 7 }]);
  });
});

// ---------------------------------------------------------------------------
// Fatura Atual / Compromissos
// ---------------------------------------------------------------------------

describe('buildCurrentBillRows', () => {
  const tx: TransactionRow = {
    date: '2026-07-02T12:00:00.000Z',
    description: '99app',
    category_mapped: 'Transporte',
    category_pierre: null,
    category_group: 'Necessidade',
    direction: 'EXPENSE',
    amount: -16.29,
    account_name: 'Nubank Cartão',
    status: 'PENDING',
  };

  test('writes positive numbers and a total formula', () => {
    const rows = buildCurrentBillRows([tx]);

    expect(rows[1][3]).toBe(16.29);
    expect(rows[2][3]).toBe('=SUM(D2:D2)');
  });

  test('shows a friendly message when the bill is empty', () => {
    const rows = buildCurrentBillRows([]);
    expect(rows[1][0]).toContain('Nenhum lançamento');
  });
});

describe('buildCommitmentRows', () => {
  const inst = {
    purchase_description: 'TV',
    installment_number: 2,
    total_installments: 10,
    amount: 150,
    due_date: '2026-08-22',
    is_projected: 1,
    account_name: 'Nubank Cartão',
  };

  test('formats the installment counter and keeps the amount numeric', () => {
    const [, row] = buildCommitmentRows([inst]);

    expect(row[1]).toBe('2/10');
    expect(row[2]).toBe(150);
    expect(row[3]).toBe('22/08/2026');
    expect(row[4]).toBe('2026-08');
    expect(row[5]).toBe('Projetada');
    expect(row[6]).toBe('Nubank Cartão');
  });

  test('appends a total to pay', () => {
    const rows = buildCommitmentRows([inst]);
    const total = rows[rows.length - 1];

    expect(total[0]).toBe('TOTAL A PAGAR');
    expect(total[2]).toBe('=SUM(C2:C2)');
  });

  test('handles the empty case', () => {
    expect(buildCommitmentRows([])[1][0]).toContain('Nenhum compromisso');
  });
});

// ---------------------------------------------------------------------------
// Budget config parsing
// ---------------------------------------------------------------------------

describe('parseBudgetConfig', () => {
  const rows: unknown[][] = [
    ['Parâmetro', 'Valor'],
    ['Renda Líquida Mensal', 'R$ 5.000,00'],
    ['% Necessidades', '50%'],
    ['% Desejos', '30%'],
    ['% Poupança', '20%'],
    ['', ''],
    ['Categoria', 'Orçamento Mensal (R$)'],
    ['Alimentação', '1.200,00'],
    ['Transporte', '400'],
    ['Lazer', ''],
  ];

  test('reads net income and group targets', () => {
    const config = parseBudgetConfig(rows);

    expect(config.netIncome).toBe(5000);
    expect(config.groupTargets.get('Necessidade')).toBeCloseTo(0.5);
    expect(config.groupTargets.get('Desejo')).toBeCloseTo(0.3);
    expect(config.groupTargets.get('Poupança')).toBeCloseTo(0.2);
  });

  test('reads per-category budgets and skips blanks', () => {
    const config = parseBudgetConfig(rows);

    expect(config.categoryBudgets.get('Alimentação')).toBe(1200);
    expect(config.categoryBudgets.get('Transporte')).toBe(400);
    expect(config.categoryBudgets.has('Lazer')).toBe(false);
  });

  test('does not treat parameter rows as categories', () => {
    const config = parseBudgetConfig(rows);
    expect(config.categoryBudgets.has('Renda Líquida Mensal')).toBe(false);
  });

  test('tolerates an empty tab', () => {
    const config = parseBudgetConfig([]);

    expect(config.netIncome).toBeNull();
    expect(config.categoryBudgets.size).toBe(0);
  });
});
