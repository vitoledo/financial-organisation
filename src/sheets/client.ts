import { google, sheets_v4 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

/**
 * Low-level wrapper around the Google Sheets API v4.
 */
export class SheetsClient {
  private sheets: sheets_v4.Sheets;
  private spreadsheetId: string;

  constructor(auth: OAuth2Client, spreadsheetId: string) {
    this.sheets = google.sheets({ version: 'v4', auth });
    this.spreadsheetId = spreadsheetId;
  }

  get id(): string {
    return this.spreadsheetId;
  }

  // -------------------------------------------------------------------------
  // Spreadsheet-level operations
  // -------------------------------------------------------------------------

  /**
   * Create a brand-new spreadsheet and return its ID.
   */
  static async createSpreadsheet(
    auth: OAuth2Client,
    title: string,
  ): Promise<string> {
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.create({
      requestBody: { properties: { title } },
    });
    return response.data.spreadsheetId!;
  }

  /**
   * Get metadata about the spreadsheet (e.g. list of sheets).
   */
  async getSpreadsheetMeta(): Promise<sheets_v4.Schema$Spreadsheet> {
    const res = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
    });
    return res.data;
  }

  // -------------------------------------------------------------------------
  // Sheet (tab) operations
  // -------------------------------------------------------------------------

  /**
   * Add a new sheet (tab) to the spreadsheet.
   */
  async addSheet(title: string, index?: number): Promise<number> {
    const res = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title,
                index,
              },
            },
          },
        ],
      },
    });
    return res.data.replies![0].addSheet!.properties!.sheetId!;
  }

  /**
   * Delete the default 'Sheet1' if it exists.
   */
  async deleteDefaultSheet(): Promise<void> {
    const meta = await this.getSpreadsheetMeta();
    const defaultSheet = meta.sheets?.find(
      (s) => s.properties?.title === 'Sheet1' || s.properties?.title === 'Planilha1',
    );
    if (defaultSheet?.properties?.sheetId !== undefined) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: [
            { deleteSheet: { sheetId: defaultSheet.properties.sheetId } },
          ],
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Data operations
  // -------------------------------------------------------------------------

  /**
   * Clear all data from a sheet (tab).
   */
  async clearSheet(sheetName: string): Promise<void> {
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: sheetName,
    });
  }

  /**
   * Write rows to a sheet. Each row is an array of cell values.
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

  /**
   * Read all rows from a sheet.
   */
  async readRows(sheetName: string): Promise<unknown[][]> {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: sheetName,
    });
    return (res.data.values as unknown[][]) ?? [];
  }

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------

  /**
   * Execute a batch of formatting/update requests.
   */
  async batchUpdate(requests: sheets_v4.Schema$Request[]): Promise<void> {
    if (requests.length === 0) return;
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests },
    });
  }

  /**
   * Get the sheet ID (gid) for a given sheet name.
   */
  async getSheetId(sheetName: string): Promise<number> {
    const meta = await this.getSpreadsheetMeta();
    const sheet = meta.sheets?.find((s) => s.properties?.title === sheetName);
    if (!sheet?.properties?.sheetId && sheet?.properties?.sheetId !== 0) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }
    return sheet.properties.sheetId;
  }

  /**
   * Freeze the first row (header) of a sheet.
   */
  async freezeHeader(sheetName: string): Promise<void> {
    const sheetId = await this.getSheetId(sheetName);
    await this.batchUpdate([
      {
        updateSheetProperties: {
          properties: {
            sheetId,
            gridProperties: { frozenRowCount: 1 },
          },
          fields: 'gridProperties.frozenRowCount',
        },
      },
    ]);
  }

  /**
   * Apply conditional formatting for budget status (green/yellow/red).
   */
  async applyBudgetFormatting(
    sheetName: string,
    percentColumn: number,
    startRow: number,
    endRow: number,
  ): Promise<void> {
    const sheetId = await this.getSheetId(sheetName);
    const range = {
      sheetId,
      startRowIndex: startRow,
      endRowIndex: endRow,
      startColumnIndex: percentColumn,
      endColumnIndex: percentColumn + 1,
    };

    await this.batchUpdate([
      // Red: > 100%
      {
        addConditionalFormatRule: {
          rule: {
            ranges: [range],
            booleanRule: {
              condition: {
                type: 'NUMBER_GREATER',
                values: [{ userEnteredValue: '1' }],
              },
              format: {
                backgroundColor: { red: 0.95, green: 0.8, blue: 0.8 },
                textFormat: { foregroundColor: { red: 0.8, green: 0.1, blue: 0.1 } },
              },
            },
          },
          index: 0,
        },
      },
      // Yellow: 80% - 100%
      {
        addConditionalFormatRule: {
          rule: {
            ranges: [range],
            booleanRule: {
              condition: {
                type: 'NUMBER_GREATER',
                values: [{ userEnteredValue: '0.8' }],
              },
              format: {
                backgroundColor: { red: 1, green: 0.95, blue: 0.8 },
                textFormat: { foregroundColor: { red: 0.7, green: 0.5, blue: 0.1 } },
              },
            },
          },
          index: 1,
        },
      },
      // Green: < 80%
      {
        addConditionalFormatRule: {
          rule: {
            ranges: [range],
            booleanRule: {
              condition: {
                type: 'NUMBER_LESS',
                values: [{ userEnteredValue: '0.8' }],
              },
              format: {
                backgroundColor: { red: 0.85, green: 0.95, blue: 0.85 },
                textFormat: { foregroundColor: { red: 0.1, green: 0.5, blue: 0.1 } },
              },
            },
          },
          index: 2,
        },
      },
    ]);
  }

  /**
   * Set column widths for a sheet.
   */
  async setColumnWidths(
    sheetName: string,
    widths: Array<{ column: number; width: number }>,
  ): Promise<void> {
    const sheetId = await this.getSheetId(sheetName);
    const requests: sheets_v4.Schema$Request[] = widths.map((w) => ({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: w.column,
          endIndex: w.column + 1,
        },
        properties: { pixelSize: w.width },
        fields: 'pixelSize',
      },
    }));
    await this.batchUpdate(requests);
  }

  /**
   * Format a row as bold header with background color.
   */
  async formatHeaderRow(
    sheetName: string,
    numColumns: number,
    bgColor: { red: number; green: number; blue: number } = { red: 0.2, green: 0.2, blue: 0.3 },
    textColor: { red: number; green: number; blue: number } = { red: 1, green: 1, blue: 1 },
  ): Promise<void> {
    const sheetId = await this.getSheetId(sheetName);
    await this.batchUpdate([
      {
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: numColumns,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: bgColor,
              textFormat: {
                bold: true,
                foregroundColor: textColor,
              },
              horizontalAlignment: 'CENTER',
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
        },
      },
    ]);
  }
}
