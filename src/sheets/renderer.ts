import { SheetsClient } from './client';
import { SHEET_NAMES } from './setup';
import { Repository, CategoryMapping } from '../storage/repository';

// ---------------------------------------------------------------------------
// Date/number formatting helpers
// ---------------------------------------------------------------------------

function formatDate(isoDate: string): string {
  const d = new Date(isoDate);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function directionLabel(direction: string): string {
  switch (direction) {
    case 'INCOME': return 'Entrada';
    case 'EXPENSE': return 'Saída';
    case 'TRANSFER': return 'Transferência';
    default: return direction;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'POSTED': return 'Confirmado';
    case 'PENDING': return 'Pendente';
    default: return status ?? '';
  }
}

const MONTH_NAMES_PT = [
  '', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

// ---------------------------------------------------------------------------
// Renderer — writes data from SQLite to Google Sheets
// ---------------------------------------------------------------------------

export class SheetsRenderer {
  private client: SheetsClient;
  private repo: Repository;
  private logger?: { info: (msg: string) => void };

  constructor(
    client: SheetsClient,
    repo: Repository,
    logger?: { info: (msg: string) => void },
  ) {
    this.client = client;
    this.repo = repo;
    this.logger = logger;
  }

  /**
   * Render all data tabs. Config tabs are NOT touched (they're user-editable).
   */
  async renderAll(): Promise<void> {
    this.logger?.info('Rendering spreadsheet...');

    await this.renderBalance();
    await this.renderTransactions();
    await this.renderMonthlySummary();
    await this.renderCurrentBill();
    await this.renderFutureCommitments();
    await this.renderDashboard();

    this.logger?.info('Spreadsheet rendering complete.');
  }

  // -------------------------------------------------------------------------
  // Balance tab
  // -------------------------------------------------------------------------

  private async renderBalance(): Promise<void> {
    this.logger?.info('  Rendering: Saldo');
    const accounts = this.repo.getAllAccounts();

    const header = ['Conta', 'Tipo', 'Saldo (R$)', 'Limite (R$)', 'Disponível (R$)', 'Última Atualização'];
    const rows = accounts.map((acc) => [
      acc.name,
      acc.subtype === 'CREDIT_CARD' ? 'Cartão de Crédito'
        : acc.subtype === 'CHECKING_ACCOUNT' ? 'Conta Corrente'
        : acc.subtype,
      acc.closing_balance !== null ? formatCurrency(acc.closing_balance) : '—',
      acc.credit_limit !== null ? formatCurrency(acc.credit_limit) : '—',
      acc.available_credit !== null ? formatCurrency(acc.available_credit) : '—',
      acc.last_synced_at ? formatDate(acc.last_synced_at) : '—',
    ]);

    await this.client.clearSheet(SHEET_NAMES.BALANCE);
    await this.client.writeRows(SHEET_NAMES.BALANCE, [header, ...rows]);
  }

  // -------------------------------------------------------------------------
  // Transactions tab
  // -------------------------------------------------------------------------

  private async renderTransactions(): Promise<void> {
    this.logger?.info('  Rendering: Transações');
    const transactions = this.repo.getAllTransactions();

    const header = ['Data', 'Descrição', 'Categoria', 'Tipo', 'Valor (R$)', 'Conta', 'Status'];
    const rows = transactions.map((tx: any) => [
      formatDate(tx.date),
      tx.description,
      tx.category_mapped ?? tx.category_pierre ?? '',
      directionLabel(tx.direction),
      formatCurrency(tx.amount),
      tx.account_name ?? '',
      statusLabel(tx.status),
    ]);

    await this.client.clearSheet(SHEET_NAMES.TRANSACTIONS);
    await this.client.writeRows(SHEET_NAMES.TRANSACTIONS, [header, ...rows]);
  }

  // -------------------------------------------------------------------------
  // Monthly Summary tab
  // -------------------------------------------------------------------------

  private async renderMonthlySummary(): Promise<void> {
    this.logger?.info('  Rendering: Resumo Mensal');

    // Read budget config from Google Sheets
    const budgetConfig = await this.readBudgetConfig();
    const months = this.repo.getDistinctMonths();

    if (months.length === 0) {
      await this.client.clearSheet(SHEET_NAMES.MONTHLY_SUMMARY);
      await this.client.writeRows(SHEET_NAMES.MONTHLY_SUMMARY, [
        ['Nenhuma transação encontrada. Execute a sincronização primeiro.'],
      ]);
      return;
    }

    // Build header: Categoria | Grupo | Month1 Orçado | Month1 Realizado | Month1 Diferença | Month1 % ...
    const header: string[] = ['Categoria', 'Grupo'];
    for (const { year, month } of months) {
      const label = `${MONTH_NAMES_PT[month]}/${year}`;
      header.push(`${label} Orçado`, `${label} Realizado`, `${label} Diferença`, `${label} %`);
    }

    // Collect all categories across all months
    const allCategories = new Set<string>();
    const monthData = new Map<string, Map<string, { total: number; group: string }>>();

    for (const { year, month } of months) {
      const key = `${year}-${month}`;
      const summary = this.repo.getMonthlySummary(year, month);
      const catMap = new Map<string, { total: number; group: string }>();
      for (const row of summary) {
        allCategories.add(row.category_mapped ?? 'Outros');
        catMap.set(row.category_mapped ?? 'Outros', {
          total: row.total,
          group: row.category_group ?? '',
        });
      }
      monthData.set(key, catMap);
    }

    // Build rows
    const dataRows: unknown[][] = [];
    for (const category of allCategories) {
      const row: unknown[] = [category, ''];
      let groupSet = false;

      for (const { year, month } of months) {
        const key = `${year}-${month}`;
        const catData = monthData.get(key)?.get(category);
        const realizado = catData ? Math.abs(catData.total) : 0;
        const orcado = budgetConfig.get(category) ?? 0;
        const diferenca = orcado - realizado;
        const percent = orcado > 0 ? realizado / orcado : 0;

        if (!groupSet && catData?.group) {
          row[1] = catData.group;
          groupSet = true;
        }

        row.push(
          orcado > 0 ? formatCurrency(orcado) : '—',
          formatCurrency(realizado),
          orcado > 0 ? formatCurrency(diferenca) : '—',
          orcado > 0 ? `${Math.round(percent * 100)}%` : '—',
        );
      }

      dataRows.push(row);
    }

    // Add totals row
    const totalsRow: unknown[] = ['TOTAL', ''];
    for (const { year, month } of months) {
      const summary = this.repo.getMonthlySummary(year, month);
      const totalRealizado = summary.reduce((sum, r) => sum + Math.abs(r.total), 0);
      const income = this.repo.getMonthlyIncome(year, month);
      totalsRow.push('—', formatCurrency(totalRealizado), '—', '—');
    }
    dataRows.push(totalsRow);

    await this.client.clearSheet(SHEET_NAMES.MONTHLY_SUMMARY);
    await this.client.writeRows(SHEET_NAMES.MONTHLY_SUMMARY, [header, ...dataRows]);
  }

  // -------------------------------------------------------------------------
  // Current Bill tab
  // -------------------------------------------------------------------------

  private async renderCurrentBill(): Promise<void> {
    this.logger?.info('  Rendering: Fatura Atual');

    // Get credit card transactions with status PENDING or from current month
    const now = new Date();
    const currentMonth = this.repo.getTransactionsByMonth(now.getFullYear(), now.getMonth() + 1);
    const creditCardTxs = currentMonth.filter(
      (tx: any) => tx.account_type === 'CREDIT' && tx.direction !== 'TRANSFER',
    );

    const header = ['Data', 'Descrição', 'Categoria', 'Valor (R$)', 'Status'];
    const rows = creditCardTxs.map((tx: any) => [
      formatDate(tx.date),
      tx.description,
      tx.category_mapped ?? tx.category_pierre ?? '',
      formatCurrency(Math.abs(tx.amount)),
      statusLabel(tx.status),
    ]);

    // Add total row
    const total = creditCardTxs.reduce((sum: number, tx: any) => sum + Math.abs(tx.amount), 0);
    rows.push(['', '', 'TOTAL', formatCurrency(total), '']);

    await this.client.clearSheet(SHEET_NAMES.CURRENT_BILL);
    await this.client.writeRows(SHEET_NAMES.CURRENT_BILL, [header, ...rows]);
  }

  // -------------------------------------------------------------------------
  // Future Commitments tab
  // -------------------------------------------------------------------------

  private async renderFutureCommitments(): Promise<void> {
    this.logger?.info('  Rendering: Compromissos Futuros');
    const installments = this.repo.getUnpaidInstallments();

    const header = ['Descrição', 'Parcela', 'Valor (R$)', 'Vencimento', 'Status', 'Cartão'];
    const rows = installments.map((inst: any) => [
      inst.purchase_description ?? '',
      `${inst.installment_number}/${inst.total_installments}`,
      formatCurrency(inst.amount),
      inst.due_date ? formatDate(inst.due_date) : '—',
      inst.is_projected ? 'Projetada' : 'Confirmada',
      inst.account_name ?? '',
    ]);

    if (rows.length === 0) {
      rows.push(['Nenhum compromisso futuro encontrado.', '', '', '', '', '']);
    }

    await this.client.clearSheet(SHEET_NAMES.FUTURE_COMMITMENTS);
    await this.client.writeRows(SHEET_NAMES.FUTURE_COMMITMENTS, [header, ...rows]);
  }

  // -------------------------------------------------------------------------
  // Dashboard tab
  // -------------------------------------------------------------------------

  private async renderDashboard(): Promise<void> {
    this.logger?.info('  Rendering: Dashboard');

    const accounts = this.repo.getAllAccounts();
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    // KPIs
    const bankAccounts = accounts.filter((a) => a.type === 'BANK');
    const totalBalance = bankAccounts.reduce((sum, a) => sum + (a.closing_balance ?? 0), 0);

    const monthlyExpenses = this.repo.getMonthlySummary(year, month);
    const totalExpenses = monthlyExpenses.reduce((sum, r) => sum + Math.abs(r.total), 0);

    const monthlyIncome = this.repo.getMonthlyIncome(year, month);
    const savingsRate = monthlyIncome > 0
      ? ((monthlyIncome - totalExpenses) / monthlyIncome) * 100
      : 0;

    const creditCard = accounts.find((a) => a.subtype === 'CREDIT_CARD');

    // Group by 50/30/20
    const groupTotals = new Map<string, number>();
    for (const row of monthlyExpenses) {
      const group = row.category_group ?? 'Outros';
      groupTotals.set(group, (groupTotals.get(group) ?? 0) + Math.abs(row.total));
    }

    // Build dashboard
    const data: unknown[][] = [
      ['Indicador', 'Valor'],
      [''],
      ['═══ VISÃO GERAL ═══', ''],
      ['Saldo Total (Contas)', formatCurrency(totalBalance)],
      [`Gastos do Mês (${MONTH_NAMES_PT[month]})`, formatCurrency(totalExpenses)],
      [`Receitas do Mês (${MONTH_NAMES_PT[month]})`, formatCurrency(monthlyIncome)],
      ['Taxa de Poupança', `${savingsRate.toFixed(1)}%`],
      [''],
      ['═══ CARTÃO DE CRÉDITO ═══', ''],
      ['Limite Total', creditCard ? formatCurrency(creditCard.credit_limit) : '—'],
      ['Limite Disponível', creditCard ? formatCurrency(creditCard.available_credit) : '—'],
      [''],
      ['═══ REGRA 50/30/20 ═══', ''],
    ];

    for (const [group, total] of groupTotals) {
      const pctOfIncome = monthlyIncome > 0 ? ((total / monthlyIncome) * 100).toFixed(1) : '—';
      data.push([`${group}`, `${formatCurrency(total)} (${pctOfIncome}% da renda)`]);
    }

    // Top categories this month
    data.push([''], ['═══ TOP CATEGORIAS DO MÊS ═══', '']);
    const sorted = [...monthlyExpenses].sort((a, b) => a.total - b.total); // most negative first
    for (const cat of sorted.slice(0, 6)) {
      data.push([cat.category_mapped ?? 'Outros', formatCurrency(Math.abs(cat.total))]);
    }

    await this.client.clearSheet(SHEET_NAMES.DASHBOARD);
    await this.client.writeRows(SHEET_NAMES.DASHBOARD, data);
  }

  // -------------------------------------------------------------------------
  // Read config from Google Sheets
  // -------------------------------------------------------------------------

  /**
   * Read category mappings from the Config: Categorias tab.
   */
  async readCategoryMappings(): Promise<Map<string, CategoryMapping>> {
    const rows = await this.client.readRows(SHEET_NAMES.CONFIG_CATEGORIES);
    const mappings = new Map<string, CategoryMapping>();

    // Skip header row
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] as string[];
      if (!row[0]) continue;

      mappings.set(row[0], {
        categoryPierre: row[0],
        categoryMapped: row[1] ?? row[0],
        group: row[2] ?? '',
        variability: row[3] ?? '',
      });
    }

    return mappings;
  }

  /**
   * Read budget values from the Config: Orçamento tab.
   * Returns a map of category → monthly budget amount.
   */
  private async readBudgetConfig(): Promise<Map<string, number>> {
    const rows = await this.client.readRows(SHEET_NAMES.CONFIG_BUDGET);
    const budget = new Map<string, number>();

    // Find the "Categoria | Orçamento Mensal" section (after the parameters section)
    let inBudgetSection = false;
    for (const row of rows) {
      const cells = row as string[];
      if (cells[0] === 'Categoria' && cells[1]?.includes('Orçamento')) {
        inBudgetSection = true;
        continue;
      }
      if (inBudgetSection && cells[0] && cells[1]) {
        const value = parseFloat(String(cells[1]).replace(/[R$\s.]/g, '').replace(',', '.'));
        if (!isNaN(value) && value > 0) {
          budget.set(cells[0], value);
        }
      }
    }

    return budget;
  }
}
