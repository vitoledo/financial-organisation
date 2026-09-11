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
  balanceTotalRow,
  RESERVE_RECONCILIATION_LABEL,
  buildTransactionRows,
  buildMonthlySummaryHeader,
  buildMonthlySummaryRows,
  buildMonthlySummaryTotalRow,
  buildAnnualRows,
  buildDashboardData,
  buildCurrentBillRows,
  buildCommitmentRows,
  buildInvestmentTabRows,
  parseInvestmentsConfig,
  parseIndexerPercentage,
  parseQuantity,
  parseSheetDate,
  parseBudgetConfig,
  sanitizeCellText,
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

  test('tolerates a dot used as a decimal separator (no comma)', () => {
    expect(parseMoneyBR('50.5')).toBeCloseTo(50.5, 2);
    expect(parseMoneyBR('1234.56')).toBeCloseTo(1234.56, 2);
  });

  test('still treats a dot with 3+ trailing digits as a thousands group', () => {
    expect(parseMoneyBR('1.234')).toBe(1234);
    expect(parseMoneyBR('1.234.567')).toBe(1234567);
  });
});

describe('sanitizeCellText', () => {
  test.each(['=1+1', '+1', '-1', '@x', '=HYPERLINK("http://e","x")'])(
    'prefixes an apostrophe to formula-triggering text %s',
    (value) => {
      expect(sanitizeCellText(value)).toBe(`'${value}`);
    },
  );

  test('leaves ordinary text untouched', () => {
    expect(sanitizeCellText('Mercado Pão de Açúcar')).toBe('Mercado Pão de Açúcar');
    expect(sanitizeCellText('99app *99app')).toBe('99app *99app');
  });

  test('maps null/undefined to empty string', () => {
    expect(sanitizeCellText(null)).toBe('');
    expect(sanitizeCellText(undefined)).toBe('');
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
      id: 'acc-1',
      name: 'Nubank Conta',
      type: 'BANK',
      subtype: 'CHECKING_ACCOUNT',
      closing_balance: 9.22,
      credit_limit: null,
      available_credit: null,
      automatically_invested_balance: null,
      reserved_total: null,
      last_synced_at: '2026-07-06T10:00:00.000Z',
    },
    {
      id: 'acc-2',
      name: 'Nubank Cartão',
      type: 'CREDIT',
      subtype: 'CREDIT_CARD',
      closing_balance: null,
      credit_limit: 1550,
      available_credit: 200,
      automatically_invested_balance: null,
      reserved_total: null,
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
    id: 'tx-1',
    date: '2026-06-15T12:00:00.000Z',
    description: 'Mercado',
    category_mapped: 'Alimentação',
    category_pierre: 'Supermercado',
    category_group: 'Necessidade',
    category_variability: 'Variável',
    direction: 'EXPENSE',
    amount: -150.5,
    account_name: 'Nubank Conta',
    account_type: 'BANK',
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

  test('neutralizes a formula-injection payload in the description', () => {
    const evil = '=HYPERLINK("https://evil.example","Clique")';
    const [, row] = buildTransactionRows([{ ...tx, description: evil }]);

    expect(row[1]).toBe(`'${evil}`); // written as literal text, not a formula
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
    id: 'tx-2',
    date: '2026-07-02T12:00:00.000Z',
    description: '99app',
    category_mapped: 'Transporte',
    category_pierre: null,
    category_group: 'Necessidade',
    category_variability: 'Variável',
    direction: 'EXPENSE',
    amount: -16.29,
    account_name: 'Nubank Cartão',
    account_type: 'CREDIT',
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
    id: 'inst-1',
    purchase_description: 'TV',
    installment_number: 2,
    total_installments: 10,
    amount: 150,
    due_date: '2026-08-22',
    is_paid: 0,
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

// ---------------------------------------------------------------------------
// Investment tab builders and config parsing
// ---------------------------------------------------------------------------

describe('parseIndexerPercentage', () => {
  test('parses indexer percentages correctly', () => {
    expect(parseIndexerPercentage('102%')).toBeCloseTo(1.02);
    expect(parseIndexerPercentage('102% CDI')).toBeCloseTo(1.02);
    expect(parseIndexerPercentage('100%')).toBeCloseTo(1.0);
    expect(parseIndexerPercentage('95.5%')).toBeCloseTo(0.955);
    expect(parseIndexerPercentage(null)).toBe(1.0);
  });
});

describe('buildInvestmentTabRows', () => {
  test('builds formulas and summary rows with IFERROR and correct wealth summary', () => {
    const rows = buildInvestmentTabRows([
      {
        id: 'inv1',
        asset_name: 'Bitcoin',
        asset_type: 'Cripto',
        origin: 'EXTERNAL',
        pricing_method: 'GOOGLEFINANCE',
        ticker_or_rate: 'CURRENCY:BTCBRL',
        quantity: 0.003,
        cost_basis: 1000,
        start_date: '2026-01-01',
        manual_value: null,
        market_value: 1800,
        market_value_at: null,
        pricing_status: 'OK',
        linked_account_id: null,
        notes: 'Reserva BTC',
        source: 'CONFIG_TAB',
      },
      {
        id: 'inv2',
        asset_name: 'Nubank Caixinha',
        asset_type: 'Renda Fixa',
        origin: 'PIERRE',
        pricing_method: 'PIERRE',
        ticker_or_rate: '100% CDI',
        quantity: 1,
        cost_basis: 500,
        start_date: null,
        manual_value: null,
        market_value: 520,
        market_value_at: null,
        pricing_status: 'OK',
        linked_account_id: 'acc1',
        notes: 'Reserva Nubank',
        source: 'PIERRE_RESERVED',
      },
    ]);

    expect(rows).toHaveLength(8); // Header + 2 data + 1 total + 1 blank + 3 summary rows

    // Check GOOGLEFINANCE price formula wrapping with IFERROR
    const btcRow = rows[1];
    expect(btcRow[5]).toContain('IFERROR(GOOGLEFINANCE("CURRENCY:BTCBRL"),"")');
    expect(btcRow[6]).toContain('IFERROR');

    // Check Summary rows
    const externasRow = rows[5];
    expect(externasRow[0]).toBe('Investido em carteiras externas');
    expect(externasRow[6]).toContain('SUMIF($C$2:$C$3, "Carteira Externa"');

    const pierreRow = rows[6];
    expect(pierreRow[0]).toBe('Já contido no Saldo (Pierre)');
    expect(pierreRow[6]).toContain('SUMIF($C$2:$C$3, "Conta Pierre"');

    const netWorthRow = rows[7];
    expect(netWorthRow[0]).toBe('PATRIMÔNIO TOTAL');
  });
});

describe('parseInvestmentsConfig', () => {
  test('parses Config: Investimentos tab correctly', () => {
    const configRows: unknown[][] = [
      ['Parâmetro', 'Valor', 'Observação'],
      ['CDI anual (%)', '0,1050'],
      ['', ''],
      ['Ativo', 'Tipo', 'Origem', 'Método', 'Ticker ou % Indexador', 'Quantidade', 'Custo Total (R$)', 'Data do Aporte', 'Valor Manual (R$)', 'Conta Vinculada', 'Anotações'],
      ['Bitcoin (BTC)', 'Cripto', 'Carteira Externa', 'GOOGLEFINANCE', 'CURRENCY:BTCBRL', '0,003', '1000,00', '2026-01-15', '', '', 'Minhas moedas'],
    ];

    const result = parseInvestmentsConfig(configRows);
    expect(result).toHaveLength(1);
    expect(result[0].asset_name).toBe('Bitcoin (BTC)');
    expect(result[0].asset_type).toBe('Cripto');
    expect(result[0].origin).toBe('EXTERNAL');
    expect(result[0].pricing_method).toBe('GOOGLEFINANCE');
    expect(result[0].ticker_or_rate).toBe('CURRENCY:BTCBRL');
    expect(result[0].quantity).toBe(0.003);
    expect(result[0].cost_basis).toBe(1000);
  });
});


// ---------------------------------------------------------------------------
// Regression guards for the investments feature
// ---------------------------------------------------------------------------

describe('parseQuantity', () => {
  test('keeps crypto precision where the money parser would corrupt it', () => {
    // parseMoneyBR reads a lone dot with 3+ digits as a thousands group, which
    // would turn a 0.00034 BTC position into 34 BTC.
    expect(parseMoneyBR('0.00034')).toBe(34);
    expect(parseQuantity('0.00034')).toBe(0.00034);
  });

  test('accepts pt-BR decimals and raw numbers', () => {
    expect(parseQuantity('0,003')).toBe(0.003);
    expect(parseQuantity('1.234,5')).toBe(1234.5);
    expect(parseQuantity(0.5)).toBe(0.5);
  });

  test('returns null for blanks and garbage', () => {
    expect(parseQuantity('')).toBeNull();
    expect(parseQuantity('abc')).toBeNull();
    expect(parseQuantity(null)).toBeNull();
  });
});

describe('parseSheetDate', () => {
  test('converts a Sheets serial number to ISO', () => {
    // UNFORMATTED_VALUE returns dates as days since 1899-12-30.
    expect(parseSheetDate(46037)).toBe('2026-01-15');
  });

  test('accepts pt-BR and ISO strings', () => {
    expect(parseSheetDate('15/01/2026')).toBe('2026-01-15');
    expect(parseSheetDate('2026-01-15')).toBe('2026-01-15');
  });

  test('returns null for blanks and unparseable text', () => {
    expect(parseSheetDate('')).toBeNull();
    expect(parseSheetDate('qualquer coisa')).toBeNull();
    expect(parseSheetDate(null)).toBeNull();
  });
});

describe('parseInvestmentsConfig — seeded examples and pricing honesty', () => {
  const header = ['Ativo', 'Tipo', 'Origem', 'Método', 'Ticker ou % Indexador', 'Quantidade', 'Custo Total (R$)', 'Data do Aporte', 'Valor Manual (R$)', 'Conta Vinculada', 'Anotações'];

  test('skips seeded "(exemplo)" rows so they never enter the net worth', () => {
    const rows: unknown[][] = [
      header,
      ['(exemplo) Bitcoin (BTC)', 'Cripto', 'Carteira Externa', 'GOOGLEFINANCE', 'CURRENCY:BTCBRL', 0.003, 1000, '2026-01-15', '', '', ''],
      ['(exemplo) CDB 102% CDI', 'Renda Fixa', 'Carteira Externa', 'CDI', '102%', 1, 500, '2026-01-01', '', '', ''],
      ['Bitcoin de verdade', 'Cripto', 'Carteira Externa', 'GOOGLEFINANCE', 'CURRENCY:BTCBRL', 0.01, 3000, '2026-02-01', '', '', ''],
    ];

    const result = parseInvestmentsConfig(rows);
    expect(result).toHaveLength(1);
    expect(result[0].asset_name).toBe('Bitcoin de verdade');
  });

  test('leaves market value null and status PENDING until the read-back prices it', () => {
    const rows: unknown[][] = [
      header,
      ['Bitcoin', 'Cripto', 'Carteira Externa', 'GOOGLEFINANCE', 'CURRENCY:BTCBRL', 0.01, 3000, '2026-02-01', '', '', ''],
    ];

    const [asset] = parseInvestmentsConfig(rows);
    // Cost basis must never be passed off as a quote.
    expect(asset.market_value).toBeNull();
    expect(asset.market_value_at).toBeNull();
    expect(asset.pricing_status).toBe('PENDING');
    expect(asset.cost_basis).toBe(3000);
  });

  test('a MANUAL holding is priced by the value the user typed', () => {
    const rows: unknown[][] = [
      header,
      ['Fundo fechado', 'Outro', 'Carteira Externa', 'MANUAL', '', 1, 1000, '', 1250, '', ''],
    ];

    const [asset] = parseInvestmentsConfig(rows);
    expect(asset.market_value).toBe(1250);
    expect(asset.pricing_status).toBe('OK');
  });

  test('folds accents and de-duplicates ids so the insert cannot abort the sync', () => {
    const rows: unknown[][] = [
      header,
      ['Ação PETR4', 'Ação', 'Carteira Externa', 'GOOGLEFINANCE', 'BVMF:PETR4', 10, 300, '', '', '', ''],
      ['Acao PETR4', 'Ação', 'Carteira Externa', 'GOOGLEFINANCE', 'BVMF:PETR4', 5, 150, '', '', '', ''],
    ];

    const result = parseInvestmentsConfig(rows);
    const ids = result.map((r) => r.id);
    expect(ids[0]).toBe('config:acao_petr4');
    expect(new Set(ids).size).toBe(2);
  });
});

describe('buildInvestmentTabRows — blank quantity must not zero a position', () => {
  const base = {
    asset_type: 'Cripto',
    origin: 'EXTERNAL',
    pricing_method: 'GOOGLEFINANCE',
    ticker_or_rate: 'CURRENCY:BTCBRL',
    start_date: null,
    market_value: null,
    market_value_at: null,
    pricing_status: 'PENDING',
    linked_account_id: null,
    notes: null,
    source: 'CONFIG_TAB',
  };

  test('guards the market value formula with ISNUMBER on quantity', () => {
    const rows = buildInvestmentTabRows([
      { id: 'a', asset_name: 'Bitcoin', quantity: null, cost_basis: 1000, manual_value: null, ...base },
    ] as never);

    // Sheets treats an empty cell as 0 in arithmetic, so `D2*F2` would evaluate
    // to a valid 0 that IFERROR passes through — silently zeroing the holding.
    expect(rows[1][6]).toContain('NOT(ISNUMBER(D2))');
  });

  test('the price-source column reports fallback when quantity is missing', () => {
    const rows = buildInvestmentTabRows([
      { id: 'a', asset_name: 'Bitcoin', quantity: null, cost_basis: 1000, manual_value: null, ...base },
    ] as never);

    expect(rows[1][10]).toContain('ISNUMBER(D2)');
  });
});

describe('buildBalanceRows — reconciliation block (D3)', () => {
  const account = (over: Record<string, unknown> = {}) => ({
    name: 'Nubank Conta',
    type: 'BANK',
    subtype: 'CHECKING_ACCOUNT',
    closing_balance: 1000,
    credit_limit: null,
    available_credit: null,
    automatically_invested_balance: null,
    reserved_total: null,
    last_synced_at: '2026-07-06T10:00:00.000Z',
    ...over,
  });

  test('stays silent for accounts without a reserve', () => {
    const rows = buildBalanceRows([account()] as never);

    expect(rows.some((r) => String(r[0]).includes('CONFERÊNCIA'))).toBe(false);
    expect(rows[rows.length - 1][0]).toBe('TOTAL (contas)');
  });

  test('prints the assumption when a reserve exists', () => {
    const rows = buildBalanceRows([account({ reserved_total: 400 })] as never);
    const reconciliation = rows.find((r) => r[1] === RESERVE_RECONCILIATION_LABEL);

    expect(reconciliation).toBeDefined();
    expect(reconciliation?.[2]).toBe(400);
    expect(String(reconciliation?.[5])).toContain('Já incluída no saldo');
  });

  test('flags the provable case where the reserve exceeds the balance', () => {
    const rows = buildBalanceRows([account({ closing_balance: 100, reserved_total: 900 })] as never);
    const reconciliation = rows.find((r) => r[1] === RESERVE_RECONCILIATION_LABEL);

    expect(String(reconciliation?.[5])).toContain('FORA do saldo');
  });

  test('keeps the reconciliation rows out of every sum', () => {
    const rows = buildBalanceRows([account({ reserved_total: 400 })] as never);
    const totalRow = rows[balanceTotalRow(1) - 1];

    // The TOTAL formula and the Investimentos patrimônio formula both match on
    // column B — the reconciliation label must never equal an account type.
    expect(totalRow[0]).toBe('TOTAL (contas)');
    expect(RESERVE_RECONCILIATION_LABEL).not.toBe(accountTypeLabel('CHECKING_ACCOUNT'));
    expect(RESERVE_RECONCILIATION_LABEL).not.toBe(accountTypeLabel('SAVINGS'));

    // And they sit below the total, outside its A2:A<lastRow> window.
    const reconciliationIndex = rows.findIndex((r) => r[1] === RESERVE_RECONCILIATION_LABEL);
    expect(reconciliationIndex).toBeGreaterThan(balanceTotalRow(1) - 1);
  });

  test('balanceTotalRow points at the TOTAL line regardless of the block below', () => {
    const rows = buildBalanceRows([
      account({ reserved_total: 400 }),
      account({ name: 'Outra', reserved_total: 50 }),
    ] as never);

    expect(rows[balanceTotalRow(2) - 1][0]).toBe('TOTAL (contas)');
  });
});
