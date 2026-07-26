import { google, sheets_v4, Auth } from 'googleapis';

export type Request = sheets_v4.Schema$Request;
export type GridRange = sheets_v4.Schema$GridRange;
export type Color = { red: number; green: number; blue: number };

export const NUMBER_FORMATS = {
  CURRENCY: '"R$" #,##0.00',
  CURRENCY_SIGNED: '"R$" #,##0.00;[RED]-"R$" #,##0.00',
  PERCENT: '0.0%',
  DATE: 'dd/mm/yyyy',
} as const;

/**
 * Wrapper around the Google Sheets API v4.
 *
 * Spreadsheet metadata is cached for the lifetime of the instance: sheet ids
 * are needed by nearly every formatting request, and re-fetching them per call
 * turned a single render into dozens of round trips.
 */
export class SheetsClient {
  private sheets: sheets_v4.Sheets;
  private spreadsheetId: string;
  private metaCache: sheets_v4.Schema$Spreadsheet | null = null;

  constructor(auth: Auth.OAuth2Client, spreadsheetId: string) {
    this.sheets = google.sheets({ version: 'v4', auth });
    this.spreadsheetId = spreadsheetId;
  }

  get id(): string {
    return this.spreadsheetId;
  }

  // -------------------------------------------------------------------------
  // Spreadsheet-level
  // -------------------------------------------------------------------------

  static async createSpreadsheet(auth: Auth.OAuth2Client, title: string): Promise<string> {
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.create({
      requestBody: {
        properties: {
          title,
          locale: 'pt_BR',
          timeZone: 'America/Sao_Paulo',
        },
      },
    });
    return response.data.spreadsheetId!;
  }

  /** Invalidate the metadata cache (after adding or deleting sheets/charts). */
  invalidateMeta(): void {
    this.metaCache = null;
  }

  async getSpreadsheetMeta(force = false): Promise<sheets_v4.Schema$Spreadsheet> {
    if (this.metaCache && !force) return this.metaCache;
    const res = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    this.metaCache = res.data;
    return this.metaCache;
  }

  /**
   * pt_BR locale makes Sheets read "15/06/2026" as a date and render
   * R$ / decimal comma natively. Applied on existing spreadsheets too, so
   * sheets created before this change get fixed on the next sync.
   */
  async ensureLocale(): Promise<void> {
    const meta = await this.getSpreadsheetMeta();
    if (meta.properties?.locale === 'pt_BR' && meta.properties?.timeZone === 'America/Sao_Paulo') {
      return;
    }
    await this.batchUpdate([
      {
        updateSpreadsheetProperties: {
          properties: { locale: 'pt_BR', timeZone: 'America/Sao_Paulo' },
          fields: 'locale,timeZone',
        },
      },
    ]);
    this.invalidateMeta();
  }

  // -------------------------------------------------------------------------
  // Sheets (tabs)
  // -------------------------------------------------------------------------

  async listSheetTitles(): Promise<string[]> {
    const meta = await this.getSpreadsheetMeta();
    return (meta.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => Boolean(t));
  }

  async addSheet(title: string, index?: number): Promise<number> {
    const res = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title, index } } }] },
    });
    this.invalidateMeta();
    return res.data.replies![0].addSheet!.properties!.sheetId!;
  }

  async deleteDefaultSheet(): Promise<void> {
    const meta = await this.getSpreadsheetMeta(true);
    const defaultSheet = meta.sheets?.find(
      (s) => s.properties?.title === 'Sheet1' || s.properties?.title === 'Planilha1',
    );
    if (defaultSheet?.properties?.sheetId !== undefined && defaultSheet.properties.sheetId !== null) {
      await this.batchUpdate([{ deleteSheet: { sheetId: defaultSheet.properties.sheetId } }]);
      this.invalidateMeta();
    }
  }

  async getSheetId(sheetName: string): Promise<number> {
    const meta = await this.getSpreadsheetMeta();
    const sheet = meta.sheets?.find((s) => s.properties?.title === sheetName);
    const sheetId = sheet?.properties?.sheetId;
    if (sheetId === undefined || sheetId === null) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }
    return sheetId;
  }

  // -------------------------------------------------------------------------
  // Values
  // -------------------------------------------------------------------------

  async clearSheet(sheetName: string): Promise<void> {
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: `'${sheetName}'`,
    });
  }

  /**
   * Write rows starting at A1. USER_ENTERED so formulas evaluate and numbers
   * land as numbers rather than text.
   */
  async writeRows(sheetName: string, rows: unknown[][]): Promise<void> {
    if (rows.length === 0) return;
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `'${sheetName}'!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });
  }

  async readRows(sheetName: string): Promise<unknown[][]> {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${sheetName}'`,
    });
    return (res.data.values as unknown[][]) ?? [];
  }

  // -------------------------------------------------------------------------
  // Batch requests
  // -------------------------------------------------------------------------

  async batchUpdate(requests: Request[]): Promise<sheets_v4.Schema$BatchUpdateSpreadsheetResponse | void> {
    if (requests.length === 0) return;
    const res = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests },
    });
    return res.data;
  }

  // -------------------------------------------------------------------------
  // Request builders — return requests so callers can batch them into one call
  // -------------------------------------------------------------------------

  numberFormatRequest(sheetId: number, range: Omit<GridRange, 'sheetId'>, pattern: string): Request {
    return {
      repeatCell: {
        range: { sheetId, ...range },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    };
  }

  dateFormatRequest(sheetId: number, range: Omit<GridRange, 'sheetId'>): Request {
    return {
      repeatCell: {
        range: { sheetId, ...range },
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: NUMBER_FORMATS.DATE } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    };
  }

  headerRequest(
    sheetId: number,
    numColumns: number,
    bgColor: Color = { red: 0.13, green: 0.16, blue: 0.24 },
  ): Request[] {
    return [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numColumns },
          cell: {
            userEnteredFormat: {
              backgroundColor: bgColor,
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 10 },
              horizontalAlignment: 'CENTER',
              verticalAlignment: 'MIDDLE',
              wrapStrategy: 'WRAP',
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
        },
      },
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      },
    ];
  }

  boldRowRequest(sheetId: number, rowIndex: number, numColumns: number): Request {
    return {
      repeatCell: {
        range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: numColumns },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    };
  }

  columnWidthRequests(sheetId: number, widths: Array<{ column: number; width: number }>): Request[] {
    return widths.map((w) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: w.column, endIndex: w.column + 1 },
        properties: { pixelSize: w.width },
        fields: 'pixelSize',
      },
    }));
  }

  bandingRequest(sheetId: number, numColumns: number): Request {
    return {
      addBanding: {
        bandedRange: {
          range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: numColumns },
          rowProperties: {
            headerColor: { red: 0.13, green: 0.16, blue: 0.24 },
            firstBandColor: { red: 1, green: 1, blue: 1 },
            secondBandColor: { red: 0.96, green: 0.97, blue: 0.98 },
          },
        },
      },
    };
  }

  /**
   * Dropdown backed by an explicit list. Keeps the config tab free of typos,
   * which would silently break the SUMIFS the whole spreadsheet depends on.
   */
  dataValidationRequest(
    sheetId: number,
    columnIndex: number,
    values: string[],
    endRowIndex = 1000,
  ): Request {
    return {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex, startColumnIndex: columnIndex, endColumnIndex: columnIndex + 1 },
        rule: {
          condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) },
          showCustomUi: true,
          strict: false,
        },
      },
    };
  }

  /**
   * Budget traffic light. Order matters: Sheets applies the first matching
   * rule, so >100% must be evaluated before >80%.
   */
  budgetTrafficLightRequests(sheetId: number, range: Omit<GridRange, 'sheetId'>): Request[] {
    const full = { sheetId, ...range };
    const rule = (
      type: 'NUMBER_GREATER' | 'NUMBER_LESS_THAN_EQ',
      value: string,
      bg: Color,
      fg: Color,
      index: number,
    ): Request => ({
      addConditionalFormatRule: {
        rule: {
          ranges: [full],
          booleanRule: {
            condition: { type, values: [{ userEnteredValue: value }] },
            format: { backgroundColor: bg, textFormat: { foregroundColor: fg, bold: true } },
          },
        },
        index,
      },
    });

    return [
      rule('NUMBER_GREATER', '1', { red: 0.96, green: 0.80, blue: 0.80 }, { red: 0.6, green: 0.06, blue: 0.06 }, 0),
      rule('NUMBER_GREATER', '0.8', { red: 1, green: 0.95, blue: 0.75 }, { red: 0.6, green: 0.4, blue: 0, }, 1),
      rule('NUMBER_LESS_THAN_EQ', '0.8', { red: 0.85, green: 0.94, blue: 0.85 }, { red: 0.1, green: 0.45, blue: 0.15 }, 2),
    ];
  }

  /** Negative values in red — applies to the signed transaction amounts. */
  negativeRedRequest(sheetId: number, range: Omit<GridRange, 'sheetId'>, index = 0): Request {
    return {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, ...range }],
          booleanRule: {
            condition: { type: 'NUMBER_LESS', values: [{ userEnteredValue: '0' }] },
            format: { textFormat: { foregroundColor: { red: 0.7, green: 0.1, blue: 0.1 } } },
          },
        },
        index,
      },
    };
  }

  /**
   * Conditional format rules are additive — without clearing, every sync would
   * stack another copy of the same rules onto the sheet.
   */
  async clearConditionalFormatRequests(sheetName: string): Promise<Request[]> {
    const meta = await this.getSpreadsheetMeta(true);
    const sheet = meta.sheets?.find((s) => s.properties?.title === sheetName);
    const sheetId = sheet?.properties?.sheetId;
    if (sheetId === undefined || sheetId === null) return [];

    const count = sheet?.conditionalFormats?.length ?? 0;
    const requests: Request[] = [];
    // Delete from the end: indexes shift as rules are removed.
    for (let i = count - 1; i >= 0; i--) {
      requests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
    }
    return requests;
  }

  // -------------------------------------------------------------------------
  // Charts
  // -------------------------------------------------------------------------

  async getChartIds(sheetName: string): Promise<number[]> {
    const meta = await this.getSpreadsheetMeta(true);
    const sheet = meta.sheets?.find((s) => s.properties?.title === sheetName);
    return (sheet?.charts ?? [])
      .map((c) => c.chartId)
      .filter((id): id is number => typeof id === 'number');
  }

  /**
   * Charts are deleted and recreated on each render rather than updated in
   * place: their anchor ranges depend on the layout, and recreating is the only
   * way to guarantee a chart never drifts onto stale ranges.
   */
  async replaceChartsRequests(sheetName: string, chartSpecs: Request[]): Promise<Request[]> {
    const existing = await this.getChartIds(sheetName);
    return [
      ...existing.map((chartId): Request => ({ deleteEmbeddedObject: { objectId: chartId } })),
      ...chartSpecs,
    ];
  }

  pieChartRequest(params: {
    sheetId: number;
    title: string;
    labelsRange: GridRange;
    valuesRange: GridRange;
    anchorRow: number;
    anchorColumn: number;
    widthPixels?: number;
    heightPixels?: number;
  }): Request {
    return {
      addChart: {
        chart: {
          spec: {
            title: params.title,
            pieChart: {
              legendPosition: 'RIGHT_LEGEND',
              pieHole: 0.45,
              domain: { sourceRange: { sources: [params.labelsRange] } },
              series: { sourceRange: { sources: [params.valuesRange] } },
            },
          },
          position: {
            overlayPosition: {
              anchorCell: { sheetId: params.sheetId, rowIndex: params.anchorRow, columnIndex: params.anchorColumn },
              widthPixels: params.widthPixels ?? 460,
              heightPixels: params.heightPixels ?? 300,
            },
          },
        },
      },
    };
  }

  basicChartRequest(params: {
    sheetId: number;
    title: string;
    chartType: 'COLUMN' | 'LINE' | 'BAR';
    domainRange: GridRange;
    seriesRanges: GridRange[];
    anchorRow: number;
    anchorColumn: number;
    widthPixels?: number;
    heightPixels?: number;
    stacked?: boolean;
  }): Request {
    return {
      addChart: {
        chart: {
          spec: {
            title: params.title,
            basicChart: {
              chartType: params.chartType,
              legendPosition: 'BOTTOM_LEGEND',
              headerCount: 1,
              domains: [{ domain: { sourceRange: { sources: [params.domainRange] } } }],
              series: params.seriesRanges.map((range) => ({
                series: { sourceRange: { sources: [range] } },
                targetAxis: 'LEFT_AXIS',
              })),
              stackedType: params.stacked ? 'STACKED' : undefined,
            },
          },
          position: {
            overlayPosition: {
              anchorCell: { sheetId: params.sheetId, rowIndex: params.anchorRow, columnIndex: params.anchorColumn },
              widthPixels: params.widthPixels ?? 460,
              heightPixels: params.heightPixels ?? 300,
            },
          },
        },
      },
    };
  }
}
