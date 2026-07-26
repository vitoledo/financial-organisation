import { SheetsClient, Request, NUMBER_FORMATS } from './client';
import { SHEET_NAMES } from './names';
import { Repository, CategoryMapping } from '../storage/repository';
import {
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
  BudgetConfig,
  MonthRef,
  SUMMARY_FIXED_COLS,
  SUMMARY_COLS_PER_MONTH,
  DASHBOARD_LAYOUT,
  TRANSACTIONS_HEADER,
  TransactionRow,
  AccountRow,
  InstallmentRow,
} from './builders';

interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Writes the SQLite state into Google Sheets.
 *
 * Data tabs are fully rewritten each run; the two Config tabs are read-only
 * from here — they belong to the user.
 */
export class SheetsRenderer {
  private client: SheetsClient;
  private repo: Repository;
  private logger?: Logger;

  constructor(client: SheetsClient, repo: Repository, logger?: Logger) {
    this.client = client;
    this.repo = repo;
    this.logger = logger;
  }

  async renderAll(): Promise<void> {
    this.logger?.info('Atualizando planilha...');

    await this.client.ensureLocale();

    const months = this.repo.getDistinctMonths();
    const categories = this.repo.getExpenseCategories();

    await this.renderBalance();
    await this.renderTransactions();
    await this.renderMonthlySummary(categories, months);
    await this.renderAnnual(categories, months);
    await this.renderCurrentBill();
    await this.renderFutureCommitments();
    await this.renderDashboard();

    this.logger?.info('Planilha atualizada.');
  }

  // -------------------------------------------------------------------------
  // Saldo
  // -------------------------------------------------------------------------

  private async renderBalance(): Promise<void> {
    this.logger?.info('  Renderizando: Saldo');
    const accounts = this.repo.getAllAccounts() as unknown as AccountRow[];
    const rows = buildBalanceRows(accounts);

    await this.client.clearSheet(SHEET_NAMES.BALANCE);
    await this.client.writeRows(SHEET_NAMES.BALANCE, rows);

    const sheetId = await this.client.getSheetId(SHEET_NAMES.BALANCE);
    await this.client.batchUpdate([
      ...this.client.headerRequest(sheetId, rows[0].length),
      this.client.numberFormatRequest(
        sheetId,
        { startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 5 },
        NUMBER_FORMATS.CURRENCY,
      ),
      ...this.client.columnWidthRequests(sheetId, [
        { column: 0, width: 200 },
        { column: 1, width: 150 },
        { column: 2, width: 130 },
        { column: 3, width: 130 },
        { column: 4, width: 130 },
        { column: 5, width: 160 },
      ]),
      ...(rows.length > 1 ? [this.client.boldRowRequest(sheetId, rows.length - 1, rows[0].length)] : []),
    ]);
  }

  // -------------------------------------------------------------------------
  // Transações
  // -------------------------------------------------------------------------

  private async renderTransactions(): Promise<void> {
    this.logger?.info('  Renderizando: Transações');
    const transactions = this.repo.getAllTransactions() as unknown as TransactionRow[];
    const rows = buildTransactionRows(transactions);

    await this.client.clearSheet(SHEET_NAMES.TRANSACTIONS);
    await this.client.writeRows(SHEET_NAMES.TRANSACTIONS, rows);

    const sheetId = await this.client.getSheetId(SHEET_NAMES.TRANSACTIONS);
    const clearRules = await this.client.clearConditionalFormatRequests(SHEET_NAMES.TRANSACTIONS);

    await this.client.batchUpdate([
      ...clearRules,
      ...this.client.headerRequest(sheetId, TRANSACTIONS_HEADER.length),
      this.client.numberFormatRequest(
        sheetId,
        { startRowIndex: 1, startColumnIndex: 5, endColumnIndex: 6 },
        NUMBER_FORMATS.CURRENCY_SIGNED,
      ),
      this.client.negativeRedRequest(sheetId, { startRowIndex: 1, startColumnIndex: 5, endColumnIndex: 6 }),
      ...this.client.columnWidthRequests(sheetId, [
        { column: 0, width: 100 },
        { column: 1, width: 320 },
        { column: 2, width: 180 },
        { column: 3, width: 120 },
        { column: 4, width: 120 },
        { column: 5, width: 120 },
        { column: 6, width: 150 },
        { column: 7, width: 110 },
        { column: 8, width: 90 },
      ]),
      // The whole log is filterable — the tab doubles as the user's ledger.
      {
        setBasicFilter: {
          filter: {
            range: {
              sheetId,
              startRowIndex: 0,
              endRowIndex: Math.max(rows.length, 2),
              startColumnIndex: 0,
              endColumnIndex: TRANSACTIONS_HEADER.length,
            },
          },
        },
      },
    ]);
  }

  // -------------------------------------------------------------------------
  // Resumo Mensal
  // -------------------------------------------------------------------------

  private async renderMonthlySummary(
    categories: Array<{ category: string; group: string }>,
    months: MonthRef[],
  ): Promise<void> {
    this.logger?.info('  Renderizando: Resumo Mensal');

    await this.client.clearSheet(SHEET_NAMES.MONTHLY_SUMMARY);

    if (months.length === 0 || categories.length === 0) {
      await this.client.writeRows(SHEET_NAMES.MONTHLY_SUMMARY, [
        ['Nenhuma transação encontrada. Rode a sincronização primeiro.'],
      ]);
      return;
    }

    const header = buildMonthlySummaryHeader(months);
    const dataRows = buildMonthlySummaryRows(categories, months);
    const totalRow = buildMonthlySummaryTotalRow(categories, months);
    const rows = [header, ...dataRows, totalRow];

    await this.client.writeRows(SHEET_NAMES.MONTHLY_SUMMARY, rows);

    const sheetId = await this.client.getSheetId(SHEET_NAMES.MONTHLY_SUMMARY);
    const clearRules = await this.client.clearConditionalFormatRequests(SHEET_NAMES.MONTHLY_SUMMARY);
    const lastRow = rows.length;

    const requests: Request[] = [
      ...clearRules,
      ...this.client.headerRequest(sheetId, header.length),
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 2 } },
          fields: 'gridProperties(frozenRowCount,frozenColumnCount)',
        },
      },
      this.client.boldRowRequest(sheetId, lastRow - 1, header.length),
      ...this.client.columnWidthRequests(sheetId, [
        { column: 0, width: 200 },
        { column: 1, width: 130 },
      ]),
    ];

    months.forEach((_, monthIndex) => {
      const base = SUMMARY_FIXED_COLS + monthIndex * SUMMARY_COLS_PER_MONTH;
      // Orçado / Realizado / Diferença → currency
      requests.push(
        this.client.numberFormatRequest(
          sheetId,
          { startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: base, endColumnIndex: base + 3 },
          NUMBER_FORMATS.CURRENCY,
        ),
      );
      // % Usado → percent + traffic light
      const percentRange = {
        startRowIndex: 1,
        endRowIndex: lastRow - 1,
        startColumnIndex: base + 3,
        endColumnIndex: base + 4,
      };
      requests.push(
        this.client.numberFormatRequest(sheetId, percentRange, NUMBER_FORMATS.PERCENT),
        ...this.client.budgetTrafficLightRequests(sheetId, percentRange),
      );
    });

    await this.client.batchUpdate(requests);
  }

  // -------------------------------------------------------------------------
  // Consolidado Anual
  // -------------------------------------------------------------------------

  private async renderAnnual(
    categories: Array<{ category: string; group: string }>,
    months: MonthRef[],
  ): Promise<void> {
    this.logger?.info('  Renderizando: Consolidado Anual');

    await this.client.clearSheet(SHEET_NAMES.ANNUAL);

    if (months.length === 0 || categories.length === 0) {
      await this.client.writeRows(SHEET_NAMES.ANNUAL, [
        ['Nenhuma transação encontrada. Rode a sincronização primeiro.'],
      ]);
      return;
    }

    const year = months[0].year; // getDistinctMonths is ordered newest first
    const rows = buildAnnualRows(categories, year);
    await this.client.writeRows(SHEET_NAMES.ANNUAL, rows);

    const sheetId = await this.client.getSheetId(SHEET_NAMES.ANNUAL);
    const header = rows[0];

    await this.client.batchUpdate([
      ...this.client.headerRequest(sheetId, header.length),
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 } },
          fields: 'gridProperties(frozenRowCount,frozenColumnCount)',
        },
      },
      // Months + Total + Média → currency (B..O)
      this.client.numberFormatRequest(
        sheetId,
        { startRowIndex: 1, endRowIndex: rows.length, startColumnIndex: 1, endColumnIndex: 15 },
        NUMBER_FORMATS.CURRENCY,
      ),
      // % do total → percent (P)
      this.client.numberFormatRequest(
        sheetId,
        { startRowIndex: 1, endRowIndex: rows.length, startColumnIndex: 15, endColumnIndex: 16 },
        NUMBER_FORMATS.PERCENT,
      ),
      this.client.boldRowRequest(sheetId, rows.length - 1, header.length),
      ...this.client.columnWidthRequests(sheetId, [{ column: 0, width: 200 }]),
    ]);
  }

  // -------------------------------------------------------------------------
  // Fatura Atual
  // -------------------------------------------------------------------------

  private async renderCurrentBill(): Promise<void> {
    this.logger?.info('  Renderizando: Fatura Atual');

    const now = new Date();
    const currentMonth = this.repo.getTransactionsByMonth(
      now.getFullYear(),
      now.getMonth() + 1,
    ) as unknown as TransactionRow[];

    const creditCardTxs = currentMonth.filter(
      (tx) => tx.account_type === 'CREDIT' && tx.direction === 'EXPENSE',
    );
    const rows = buildCurrentBillRows(creditCardTxs);

    await this.client.clearSheet(SHEET_NAMES.CURRENT_BILL);
    await this.client.writeRows(SHEET_NAMES.CURRENT_BILL, rows);

    const sheetId = await this.client.getSheetId(SHEET_NAMES.CURRENT_BILL);
    await this.client.batchUpdate([
      ...this.client.headerRequest(sheetId, 5),
      this.client.numberFormatRequest(
        sheetId,
        { startRowIndex: 1, startColumnIndex: 3, endColumnIndex: 4 },
        NUMBER_FORMATS.CURRENCY,
      ),
      ...this.client.columnWidthRequests(sheetId, [
        { column: 0, width: 100 },
        { column: 1, width: 320 },
        { column: 2, width: 180 },
        { column: 3, width: 130 },
        { column: 4, width: 120 },
      ]),
      ...(creditCardTxs.length > 0
        ? [this.client.boldRowRequest(sheetId, rows.length - 1, 5)]
        : []),
    ]);
  }

  // -------------------------------------------------------------------------
  // Compromissos Futuros
  // -------------------------------------------------------------------------

  private async renderFutureCommitments(): Promise<void> {
    this.logger?.info('  Renderizando: Compromissos Futuros');
    const installments = this.repo.getUnpaidInstallments() as unknown as InstallmentRow[];
    const rows = buildCommitmentRows(installments);

    await this.client.clearSheet(SHEET_NAMES.FUTURE_COMMITMENTS);
    await this.client.writeRows(SHEET_NAMES.FUTURE_COMMITMENTS, rows);

    const sheetId = await this.client.getSheetId(SHEET_NAMES.FUTURE_COMMITMENTS);
    await this.client.batchUpdate([
      ...this.client.headerRequest(sheetId, 7),
      this.client.numberFormatRequest(
        sheetId,
        { startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 3 },
        NUMBER_FORMATS.CURRENCY,
      ),
      ...this.client.columnWidthRequests(sheetId, [
        { column: 0, width: 300 },
        { column: 1, width: 90 },
        { column: 2, width: 120 },
        { column: 3, width: 120 },
        { column: 4, width: 90 },
        { column: 5, width: 120 },
        { column: 6, width: 150 },
      ]),
      ...(installments.length > 0
        ? [this.client.boldRowRequest(sheetId, rows.length - 1, 7)]
        : []),
    ]);
  }

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------

  private async renderDashboard(): Promise<void> {
    this.logger?.info('  Renderizando: Dashboard');

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const summary = this.repo.getMonthlySummary(year, month);
    const totalExpenses = summary.reduce((sum, r) => sum + Math.abs(r.total), 0);
    const topCategories = [...summary].sort((a, b) => a.total - b.total); // most negative first

    const data = buildDashboardData({ year, month, topCategories, totalExpenses });

    await this.client.clearSheet(SHEET_NAMES.DASHBOARD);
    await this.client.writeRows(SHEET_NAMES.DASHBOARD, data);

    const sheetId = await this.client.getSheetId(SHEET_NAMES.DASHBOARD);
    const L = DASHBOARD_LAYOUT;

    const sectionRows = [1, 8, 13, L.TOP_HEADER_ROW, 28]; // 1-based section headers
    const requests: Request[] = [
      ...this.client.columnWidthRequests(sheetId, [
        { column: 0, width: 220 },
        { column: 1, width: 150 },
        { column: 2, width: 150 },
        { column: 3, width: 150 },
      ]),
      // Section titles
      ...sectionRows.map(
        (row): Request => ({
          repeatCell: {
            range: { sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 0, endColumnIndex: 4 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.13, green: 0.16, blue: 0.24 },
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        }),
      ),
      // KPIs
      this.client.numberFormatRequest(sheetId, { startRowIndex: 1, endRowIndex: 5, startColumnIndex: 1, endColumnIndex: 2 }, NUMBER_FORMATS.CURRENCY),
      this.client.numberFormatRequest(sheetId, { startRowIndex: 5, endRowIndex: 6, startColumnIndex: 1, endColumnIndex: 2 }, NUMBER_FORMATS.PERCENT),
      // 50/30/20 realizado + alvo
      this.client.numberFormatRequest(
        sheetId,
        { startRowIndex: L.GROUPS_FIRST_ROW - 1, endRowIndex: L.GROUPS_LAST_ROW, startColumnIndex: 1, endColumnIndex: 3 },
        NUMBER_FORMATS.CURRENCY,
      ),
      // Cartão
      this.client.numberFormatRequest(sheetId, { startRowIndex: 13, endRowIndex: 16, startColumnIndex: 1, endColumnIndex: 2 }, NUMBER_FORMATS.CURRENCY),
      // Top categorias
      this.client.numberFormatRequest(
        sheetId,
        { startRowIndex: L.TOP_FIRST_ROW - 1, endRowIndex: L.TOP_LAST_ROW, startColumnIndex: 1, endColumnIndex: 2 },
        NUMBER_FORMATS.CURRENCY,
      ),
      this.client.numberFormatRequest(
        sheetId,
        { startRowIndex: L.TOP_FIRST_ROW - 1, endRowIndex: L.TOP_LAST_ROW, startColumnIndex: 2, endColumnIndex: 3 },
        NUMBER_FORMATS.PERCENT,
      ),
      // Evolução
      this.client.numberFormatRequest(
        sheetId,
        { startRowIndex: L.EVOLUTION_FIRST_ROW - 1, endRowIndex: L.EVOLUTION_LAST_ROW, startColumnIndex: 1, endColumnIndex: 4 },
        NUMBER_FORMATS.CURRENCY,
      ),
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { hideGridlines: true } },
          fields: 'gridProperties.hideGridlines',
        },
      },
    ];

    // Charts are rebuilt from scratch each render so they can never drift onto
    // stale ranges or pile up as duplicates.
    const chartRequests = await this.client.replaceChartsRequests(SHEET_NAMES.DASHBOARD, [
      this.client.pieChartRequest({
        sheetId,
        title: 'Gastos por categoria (mês atual)',
        labelsRange: { sheetId, startRowIndex: L.TOP_FIRST_ROW - 1, endRowIndex: L.TOP_LAST_ROW, startColumnIndex: 0, endColumnIndex: 1 },
        valuesRange: { sheetId, startRowIndex: L.TOP_FIRST_ROW - 1, endRowIndex: L.TOP_LAST_ROW, startColumnIndex: 1, endColumnIndex: 2 },
        anchorRow: 1,
        anchorColumn: 5,
      }),
      this.client.basicChartRequest({
        sheetId,
        title: 'Regra 50/30/20 — realizado vs alvo',
        chartType: 'COLUMN',
        domainRange: { sheetId, startRowIndex: 7, endRowIndex: L.GROUPS_LAST_ROW, startColumnIndex: 0, endColumnIndex: 1 },
        seriesRanges: [
          { sheetId, startRowIndex: 7, endRowIndex: L.GROUPS_LAST_ROW, startColumnIndex: 1, endColumnIndex: 2 },
          { sheetId, startRowIndex: 7, endRowIndex: L.GROUPS_LAST_ROW, startColumnIndex: 2, endColumnIndex: 3 },
        ],
        anchorRow: 17,
        anchorColumn: 5,
      }),
      this.client.basicChartRequest({
        sheetId,
        title: 'Evolução: receitas, gastos e sobra (12 meses)',
        chartType: 'LINE',
        domainRange: { sheetId, startRowIndex: L.EVOLUTION_HEADER_ROW - 1, endRowIndex: L.EVOLUTION_LAST_ROW, startColumnIndex: 0, endColumnIndex: 1 },
        seriesRanges: [
          { sheetId, startRowIndex: L.EVOLUTION_HEADER_ROW - 1, endRowIndex: L.EVOLUTION_LAST_ROW, startColumnIndex: 1, endColumnIndex: 2 },
          { sheetId, startRowIndex: L.EVOLUTION_HEADER_ROW - 1, endRowIndex: L.EVOLUTION_LAST_ROW, startColumnIndex: 2, endColumnIndex: 3 },
          { sheetId, startRowIndex: L.EVOLUTION_HEADER_ROW - 1, endRowIndex: L.EVOLUTION_LAST_ROW, startColumnIndex: 3, endColumnIndex: 4 },
        ],
        anchorRow: 33,
        anchorColumn: 5,
        widthPixels: 700,
      }),
    ]);

    await this.client.batchUpdate([...requests, ...chartRequests]);
  }

  // -------------------------------------------------------------------------
  // Config tabs (read-only from here)
  // -------------------------------------------------------------------------

  /** Pierre category → user taxonomy, as edited in Config: Categorias. */
  async readCategoryMappings(): Promise<Map<string, CategoryMapping>> {
    const rows = await this.client.readRows(SHEET_NAMES.CONFIG_CATEGORIES);
    const mappings = new Map<string, CategoryMapping>();

    for (let i = 1; i < rows.length; i++) {
      const row = (rows[i] ?? []) as string[];
      const pierreCategory = typeof row[0] === 'string' ? row[0].trim() : '';
      if (!pierreCategory) continue;

      mappings.set(pierreCategory, {
        categoryPierre: pierreCategory,
        categoryMapped: row[1]?.trim() || pierreCategory,
        group: row[2]?.trim() === '—' ? '' : (row[2]?.trim() ?? ''),
        variability: row[3]?.trim() === '—' ? '' : (row[3]?.trim() ?? ''),
      });
    }

    return mappings;
  }

  async readBudgetConfig(): Promise<BudgetConfig> {
    const rows = await this.client.readRows(SHEET_NAMES.CONFIG_BUDGET);
    return parseBudgetConfig(rows);
  }
}
