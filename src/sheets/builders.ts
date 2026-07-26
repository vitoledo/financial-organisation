import { SHEET_NAMES } from './names';

// =============================================================================
// Pure builders — turn database rows into cell matrices.
//
// Two rules govern everything here:
//  1. Money is written as a NUMBER, never as a pre-formatted "R$ 1.234,56"
//     string. Number formats are applied separately, so cells stay sortable,
//     summable and chartable.
//  2. Derived values are written as FORMULAS referencing other tabs, so the
//     spreadsheet stays live: editing a category or a budget recalculates
//     immediately, without waiting for the next sync.
// =============================================================================

// ---------------------------------------------------------------------------
// Column maps (0-based) — the formulas below depend on these positions.
// ---------------------------------------------------------------------------

export const TX_COLS = {
  DATE: 0,
  DESCRIPTION: 1,
  CATEGORY: 2,
  GROUP: 3,
  TYPE: 4,
  AMOUNT: 5,
  ACCOUNT: 6,
  STATUS: 7,
  MONTH: 8,
} as const;

export const SUMMARY_FIXED_COLS = 2; // Categoria, Grupo
export const SUMMARY_COLS_PER_MONTH = 4; // Orçado, Realizado, Diferença, % Usado

export const GROUPS_5030 = ['Necessidade', 'Desejo', 'Poupança'] as const;

export const MONTH_NAMES_PT = [
  '', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Convert a 0-based column index to an A1 letter (0 → A, 25 → Z, 26 → AA).
 */
export function columnLetter(index: number): string {
  let result = '';
  let n = index;
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

/**
 * Format an ISO timestamp as dd/mm/yyyy using its date part verbatim.
 *
 * Deliberately string-based: `new Date(iso).getDate()` shifts across the
 * timezone offset, so a transaction stored as 2026-06-01T02:00:00Z would
 * render as 31/05 while SQL (which filters on the raw string) counts it in
 * June. Slicing keeps the sheet and the database telling the same story.
 */
export function formatDateBR(isoDate: string): string {
  const [year, month, day] = isoDate.slice(0, 10).split('-');
  if (!year || !month || !day) return '';
  return `${day}/${month}/${year}`;
}

/** Month key (yyyy-mm) used by the SUMIFS helper column. */
export function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES_PT[month]}/${year}`;
}

export function directionLabel(direction: string): string {
  switch (direction) {
    case 'INCOME': return 'Entrada';
    case 'EXPENSE': return 'Saída';
    case 'TRANSFER': return 'Transferência';
    default: return direction;
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'POSTED': return 'Confirmado';
    case 'PENDING': return 'Pendente';
    default: return status ?? '';
  }
}

export function accountTypeLabel(subtype: string): string {
  switch (subtype) {
    case 'CREDIT_CARD': return 'Cartão de Crédito';
    case 'CHECKING_ACCOUNT': return 'Conta Corrente';
    case 'SAVINGS': return 'Poupança';
    default: return subtype;
  }
}

/**
 * Parse a pt-BR money string from the config tab.
 * Accepts "R$ 1.234,56", "1.234,56", "1234,56", "500", 500.
 */
export function parseMoneyBR(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;

  const cleaned = raw
    .replace(/R\$/gi, '')
    .replace(/\s| /g, '')
    .replace(/\./g, '')
    .replace(',', '.');

  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Percentage strings ("50%", "50", 0.5) → fraction (0.5). */
export function parsePercent(raw: unknown): number | null {
  if (typeof raw === 'number') return raw > 1 ? raw / 100 : raw;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasSign = trimmed.includes('%');
  const value = parseMoneyBR(trimmed.replace('%', ''));
  if (value === null) return null;
  if (hasSign) return value / 100;
  return value > 1 ? value / 100 : value;
}

// A1 reference to a whole column of the Transações tab, absolute.
function txCol(index: number): string {
  return `'${SHEET_NAMES.TRANSACTIONS}'!$${columnLetter(index)}:$${columnLetter(index)}`;
}

// ---------------------------------------------------------------------------
// Saldo
// ---------------------------------------------------------------------------

export interface AccountRow {
  name: string;
  type: string;
  subtype: string;
  closing_balance: number | null;
  credit_limit: number | null;
  available_credit: number | null;
  last_synced_at: string | null;
}

export const BALANCE_HEADER = [
  'Conta', 'Tipo', 'Saldo (R$)', 'Limite (R$)', 'Disponível (R$)', 'Última Atualização',
];

export function buildBalanceRows(accounts: AccountRow[]): unknown[][] {
  const rows: unknown[][] = accounts.map((acc) => [
    acc.name,
    accountTypeLabel(acc.subtype),
    acc.closing_balance ?? '',
    acc.credit_limit ?? '',
    acc.available_credit ?? '',
    acc.last_synced_at ? formatDateBR(acc.last_synced_at) : '',
  ]);

  if (rows.length > 0) {
    const lastRow = rows.length + 1; // +1 for header
    rows.push([
      'TOTAL (contas)',
      '',
      `=SUMIF($B$2:$B$${lastRow},"Conta Corrente",$C$2:$C$${lastRow})+SUMIF($B$2:$B$${lastRow},"Poupança",$C$2:$C$${lastRow})`,
      '',
      '',
      '',
    ]);
  }

  return [BALANCE_HEADER, ...rows];
}

// ---------------------------------------------------------------------------
// Transações
// ---------------------------------------------------------------------------

export interface TransactionRow {
  date: string;
  description: string;
  category_mapped: string | null;
  category_pierre: string | null;
  category_group: string | null;
  direction: string;
  amount: number;
  account_name: string | null;
  status: string;
  account_type?: string;
}

export const TRANSACTIONS_HEADER = [
  'Data', 'Descrição', 'Categoria', 'Grupo', 'Tipo', 'Valor (R$)', 'Conta', 'Status', 'Mês',
];

export function buildTransactionRows(transactions: TransactionRow[]): unknown[][] {
  const rows = transactions.map((tx) => [
    formatDateBR(tx.date),
    tx.description,
    tx.category_mapped || tx.category_pierre || 'Outros',
    tx.category_group ?? '',
    directionLabel(tx.direction),
    tx.amount,
    tx.account_name ?? '',
    statusLabel(tx.status),
    monthKey(tx.date),
  ]);

  return [TRANSACTIONS_HEADER, ...rows];
}

// ---------------------------------------------------------------------------
// Resumo Mensal — live formulas, one column block per month
// ---------------------------------------------------------------------------

export interface MonthRef {
  year: number;
  month: number;
}

export function buildMonthlySummaryHeader(months: MonthRef[]): string[] {
  const header: string[] = ['Categoria', 'Grupo'];
  for (const { year, month } of months) {
    const label = monthLabel(year, month);
    header.push(`${label} · Orçado`, `${label} · Realizado`, `${label} · Diferença`, `${label} · % Usado`);
  }
  return header;
}

/**
 * One row per category. Orçado reads the budget tab, Realizado sums the
 * transaction log — so the sheet recalculates when either is edited by hand.
 */
export function buildMonthlySummaryRows(
  categories: Array<{ category: string; group: string }>,
  months: MonthRef[],
): unknown[][] {
  return categories.map(({ category, group }, catIndex) => {
    const rowNumber = catIndex + 2; // 1-based, after header
    const row: unknown[] = [category, group];

    months.forEach(({ year, month }, monthIndex) => {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      const base = SUMMARY_FIXED_COLS + monthIndex * SUMMARY_COLS_PER_MONTH;
      const orcadoRef = `${columnLetter(base)}${rowNumber}`;
      const realizadoRef = `${columnLetter(base + 1)}${rowNumber}`;

      row.push(
        `=IFERROR(VLOOKUP($A${rowNumber},'${SHEET_NAMES.CONFIG_BUDGET}'!$A:$B,2,FALSE),0)`,
        `=-SUMIFS(${txCol(TX_COLS.AMOUNT)},${txCol(TX_COLS.CATEGORY)},$A${rowNumber},` +
          `${txCol(TX_COLS.MONTH)},"${key}",${txCol(TX_COLS.TYPE)},"Saída")`,
        `=${orcadoRef}-${realizadoRef}`,
        `=IF(${orcadoRef}>0,${realizadoRef}/${orcadoRef},"")`,
      );
    });

    return row;
  });
}

export function buildMonthlySummaryTotalRow(
  categories: Array<{ category: string; group: string }>,
  months: MonthRef[],
): unknown[] {
  const firstRow = 2;
  const lastRow = categories.length + 1;
  const row: unknown[] = ['TOTAL', ''];

  months.forEach((_, monthIndex) => {
    const base = SUMMARY_FIXED_COLS + monthIndex * SUMMARY_COLS_PER_MONTH;
    const orcado = columnLetter(base);
    const realizado = columnLetter(base + 1);
    const diferenca = columnLetter(base + 2);

    row.push(
      categories.length > 0 ? `=SUM(${orcado}${firstRow}:${orcado}${lastRow})` : 0,
      categories.length > 0 ? `=SUM(${realizado}${firstRow}:${realizado}${lastRow})` : 0,
      categories.length > 0 ? `=SUM(${diferenca}${firstRow}:${diferenca}${lastRow})` : 0,
      '',
    );
  });

  return row;
}

// ---------------------------------------------------------------------------
// Consolidado Anual — 12 months side by side for a single year
// ---------------------------------------------------------------------------

export function buildAnnualHeader(year: number): string[] {
  return [
    'Categoria',
    ...MONTH_NAMES_PT.slice(1),
    `Total ${year}`,
    'Média mensal',
    '% do total',
  ];
}

export function buildAnnualRows(
  categories: Array<{ category: string; group: string }>,
  year: number,
): unknown[][] {
  const rows: unknown[][] = categories.map(({ category }, catIndex) => {
    const rowNumber = catIndex + 2;
    const row: unknown[] = [category];

    for (let month = 1; month <= 12; month++) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      row.push(
        `=-SUMIFS(${txCol(TX_COLS.AMOUNT)},${txCol(TX_COLS.CATEGORY)},$A${rowNumber},` +
          `${txCol(TX_COLS.MONTH)},"${key}",${txCol(TX_COLS.TYPE)},"Saída")`,
      );
    }

    const totalRow = categories.length + 1;
    row.push(
      `=SUM(B${rowNumber}:M${rowNumber})`,                        // Total
      `=IFERROR(AVERAGEIF(B${rowNumber}:M${rowNumber},"<>0"),0)`, // Média (ignora meses sem gasto)
      `=IFERROR(N${rowNumber}/N$${totalRow + 1},"")`,             // % do total
    );

    return row;
  });

  if (categories.length > 0) {
    const first = 2;
    const last = categories.length + 1;
    const totals: unknown[] = ['TOTAL'];
    for (let col = 1; col <= 12; col++) {
      const letter = columnLetter(col);
      totals.push(`=SUM(${letter}${first}:${letter}${last})`);
    }
    totals.push(`=SUM(N${first}:N${last})`, `=IFERROR(AVERAGEIF(B${last + 1}:M${last + 1},"<>0"),0)`, '');
    rows.push(totals);
  }

  return [buildAnnualHeader(year), ...rows];
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardInput {
  year: number;
  month: number;
  topCategories: Array<{ category_mapped: string | null; total: number }>;
  totalExpenses: number;
}

// Fixed 1-based layout. Charts anchor to these rows, so the grid must keep its
// shape even when a section has no data — short sections are padded.
export const DASHBOARD_LAYOUT = {
  GROUPS_FIRST_ROW: 9,
  GROUPS_LAST_ROW: 11,
  TOP_HEADER_ROW: 18,
  TOP_FIRST_ROW: 19,
  TOP_SLOTS: 8,
  get TOP_LAST_ROW() { return this.TOP_FIRST_ROW + this.TOP_SLOTS - 1; }, // 26
  EVOLUTION_HEADER_ROW: 29,
  EVOLUTION_FIRST_ROW: 30,
  EVOLUTION_MONTHS: 12,
  get EVOLUTION_LAST_ROW() { return this.EVOLUTION_FIRST_ROW + this.EVOLUTION_MONTHS - 1; }, // 41
} as const;

const SHORT_MONTHS_PT = [
  '', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez',
];

/** The `count` months ending at (and including) year/month, oldest first. */
export function lastMonths(year: number, month: number, count: number): MonthRef[] {
  const months: MonthRef[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(Date.UTC(year, month - 1 - offset, 1));
    months.push({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 });
  }
  return months;
}

function monthSum(key: string, type: 'Entrada' | 'Saída', negate: boolean): string {
  const sign = negate ? '-' : '';
  return `=${sign}SUMIFS(${txCol(TX_COLS.AMOUNT)},${txCol(TX_COLS.MONTH)},"${key}",${txCol(TX_COLS.TYPE)},"${type}")`;
}

/**
 * The whole dashboard grid in one matrix.
 *
 * Values are formulas rather than pre-computed numbers so the dashboard reacts
 * to manual edits (a corrected category, a new Renda Líquida) immediately,
 * instead of lying until the next sync.
 */
export function buildDashboardData(input: DashboardInput): unknown[][] {
  const { year, month, topCategories, totalExpenses } = input;
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const label = monthLabel(year, month);
  const budget = `'${SHEET_NAMES.CONFIG_BUDGET}'`;
  const balance = `'${SHEET_NAMES.BALANCE}'`;
  const L = DASHBOARD_LAYOUT;

  const rows: unknown[][] = [
    [`VISÃO GERAL · ${label}`, '', ''],
    ['Saldo em conta', `=IFERROR(VLOOKUP("TOTAL (contas)",${balance}!$A:$C,3,FALSE),0)`, ''],
    ['Receitas do mês', monthSum(key, 'Entrada', false), ''],
    ['Gastos do mês', monthSum(key, 'Saída', true), ''],
    ['Sobra do mês', '=B3-B4', ''],
    ['Taxa de poupança', '=IF(B3>0,(B3-B4)/B3,"")', 'Meta: ≥ 20% da renda'],
    ['', '', ''],
    ['REGRA 50/30/20', 'Realizado', 'Alvo'],
  ];

  // Rows 9-11 — targets are a share of Renda Líquida, both read from the config tab.
  const targetCells: Record<string, string> = {
    Necessidade: `${budget}!$B$3`,
    Desejo: `${budget}!$B$4`,
    Poupança: `${budget}!$B$5`,
  };

  for (const group of GROUPS_5030) {
    rows.push([
      group,
      `=-SUMIFS(${txCol(TX_COLS.AMOUNT)},${txCol(TX_COLS.GROUP)},"${group}",` +
        `${txCol(TX_COLS.MONTH)},"${key}",${txCol(TX_COLS.TYPE)},"Saída")`,
      `=IFERROR(${budget}!$B$2*${targetCells[group]},"")`,
    ]);
  }

  rows.push(
    ['', '', ''],                                     // 12
    ['CARTÃO DE CRÉDITO', '', ''],                    // 13
    ['Limite total', `=IFERROR(INDEX(${balance}!$D:$D,MATCH("Cartão de Crédito",${balance}!$B:$B,0)),"")`, ''],
    ['Limite disponível', `=IFERROR(INDEX(${balance}!$E:$E,MATCH("Cartão de Crédito",${balance}!$B:$B,0)),"")`, ''],
    ['Limite usado', '=IFERROR(B14-B15,"")', ''],     // 16
    ['', '', ''],                                     // 17
    ['TOP CATEGORIAS DO MÊS', 'Valor', '% dos gastos'], // 18
  );

  // Rows 19-26 — padded to a fixed height so the pie chart range never moves.
  const top = topCategories.slice(0, L.TOP_SLOTS);
  for (let i = 0; i < L.TOP_SLOTS; i++) {
    const entry = top[i];
    rows.push(
      entry
        ? [
            entry.category_mapped ?? 'Outros',
            Math.abs(entry.total),
            totalExpenses > 0 ? Math.abs(entry.total) / totalExpenses : '',
          ]
        : ['', '', ''],
    );
  }

  rows.push(
    ['', '', ''],                                              // 27
    ['EVOLUÇÃO (12 MESES)', '', ''],                           // 28
    ['Mês', 'Receitas', 'Gastos', 'Sobra'],                    // 29
  );

  // Rows 30-41
  for (const ref of lastMonths(year, month, L.EVOLUTION_MONTHS)) {
    const monthK = `${ref.year}-${String(ref.month).padStart(2, '0')}`;
    const rowNumber = rows.length + 1;
    rows.push([
      `${SHORT_MONTHS_PT[ref.month]}/${ref.year}`,
      monthSum(monthK, 'Entrada', false),
      monthSum(monthK, 'Saída', true),
      `=B${rowNumber}-C${rowNumber}`,
    ]);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Fatura Atual
// ---------------------------------------------------------------------------

export const CURRENT_BILL_HEADER = ['Data', 'Descrição', 'Categoria', 'Valor (R$)', 'Status'];

export function buildCurrentBillRows(transactions: TransactionRow[]): unknown[][] {
  const rows: unknown[][] = transactions.map((tx) => [
    formatDateBR(tx.date),
    tx.description,
    tx.category_mapped || tx.category_pierre || 'Outros',
    Math.abs(tx.amount),
    statusLabel(tx.status),
  ]);

  if (rows.length === 0) {
    return [CURRENT_BILL_HEADER, ['Nenhum lançamento na fatura atual.', '', '', '', '']];
  }

  const lastRow = rows.length + 1;
  rows.push(['', '', 'TOTAL', `=SUM(D2:D${lastRow})`, '']);

  return [CURRENT_BILL_HEADER, ...rows];
}

// ---------------------------------------------------------------------------
// Compromissos Futuros
// ---------------------------------------------------------------------------

export interface InstallmentRow {
  purchase_description: string | null;
  installment_number: number;
  total_installments: number;
  amount: number;
  due_date: string | null;
  is_projected: number;
  account_name: string | null;
}

export const COMMITMENTS_HEADER = [
  'Descrição', 'Parcela', 'Valor (R$)', 'Vencimento', 'Mês', 'Status', 'Cartão',
];

export function buildCommitmentRows(installments: InstallmentRow[]): unknown[][] {
  if (installments.length === 0) {
    return [COMMITMENTS_HEADER, ['Nenhum compromisso futuro encontrado.', '', '', '', '', '', '']];
  }

  const rows: unknown[][] = installments.map((inst) => [
    inst.purchase_description ?? '',
    `${inst.installment_number}/${inst.total_installments}`,
    inst.amount,
    inst.due_date ? formatDateBR(inst.due_date) : '',
    inst.due_date ? monthKey(inst.due_date) : '',
    inst.is_projected ? 'Projetada' : 'Confirmada',
    inst.account_name ?? '',
  ]);

  const lastRow = rows.length + 1;
  rows.push(['TOTAL A PAGAR', '', `=SUM(C2:C${lastRow})`, '', '', '', '']);

  return [COMMITMENTS_HEADER, ...rows];
}

// ---------------------------------------------------------------------------
// Config: Orçamento parsing
// ---------------------------------------------------------------------------

export interface BudgetConfig {
  netIncome: number | null;
  groupTargets: Map<string, number>;
  categoryBudgets: Map<string, number>;
}

/**
 * Read the budget tab back. Layout is fixed by setup.ts but parsed
 * defensively — the user edits this tab by hand.
 */
export function parseBudgetConfig(rows: unknown[][]): BudgetConfig {
  const config: BudgetConfig = {
    netIncome: null,
    groupTargets: new Map(),
    categoryBudgets: new Map(),
  };

  let inCategorySection = false;

  for (const raw of rows) {
    const cells = (raw ?? []) as unknown[];
    const label = typeof cells[0] === 'string' ? cells[0].trim() : '';
    const value = cells[1];

    if (!label) continue;

    if (label === 'Categoria') {
      inCategorySection = true;
      continue;
    }

    if (inCategorySection) {
      const amount = parseMoneyBR(value);
      if (amount !== null && amount > 0) config.categoryBudgets.set(label, amount);
      continue;
    }

    if (label === 'Renda Líquida Mensal') {
      config.netIncome = parseMoneyBR(value);
    } else if (label.startsWith('% Necessidades')) {
      const pct = parsePercent(value);
      if (pct !== null) config.groupTargets.set('Necessidade', pct);
    } else if (label.startsWith('% Desejos')) {
      const pct = parsePercent(value);
      if (pct !== null) config.groupTargets.set('Desejo', pct);
    } else if (label.startsWith('% Poupança')) {
      const pct = parsePercent(value);
      if (pct !== null) config.groupTargets.set('Poupança', pct);
    }
  }

  return config;
}
