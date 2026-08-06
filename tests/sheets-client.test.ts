import { describe, test, expect } from 'vitest';
import { Auth } from 'googleapis';
import { SheetsClient, NUMBER_FORMATS } from '../src/sheets/client';

// The request builders are pure: they assemble Sheets API payloads without
// touching the network, so they can be asserted directly.
const client = new SheetsClient({} as Auth.OAuth2Client, 'sheet-id');

const SHEET_ID = 7;

describe('numberFormatRequest', () => {
  test('targets the given range with the given pattern', () => {
    const req = client.numberFormatRequest(
      SHEET_ID,
      { startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 5 },
      NUMBER_FORMATS.CURRENCY,
    );

    expect(req.repeatCell?.range).toEqual({
      sheetId: SHEET_ID,
      startRowIndex: 1,
      startColumnIndex: 2,
      endColumnIndex: 5,
    });
    expect(req.repeatCell?.cell?.userEnteredFormat?.numberFormat?.pattern).toBe('"R$" #,##0.00');
    expect(req.repeatCell?.fields).toBe('userEnteredFormat.numberFormat');
  });
});

describe('headerRequest', () => {
  test('bolds the header row and freezes it', () => {
    const [format, freeze] = client.headerRequest(SHEET_ID, 6);

    expect(format.repeatCell?.range?.endRowIndex).toBe(1);
    expect(format.repeatCell?.range?.endColumnIndex).toBe(6);
    expect(format.repeatCell?.cell?.userEnteredFormat?.textFormat?.bold).toBe(true);
    expect(freeze.updateSheetProperties?.properties?.gridProperties?.frozenRowCount).toBe(1);
  });
});

describe('columnWidthRequests', () => {
  test('emits one request per column', () => {
    const reqs = client.columnWidthRequests(SHEET_ID, [
      { column: 0, width: 200 },
      { column: 3, width: 120 },
    ]);

    expect(reqs).toHaveLength(2);
    expect(reqs[1].updateDimensionProperties?.range).toEqual({
      sheetId: SHEET_ID,
      dimension: 'COLUMNS',
      startIndex: 3,
      endIndex: 4,
    });
    expect(reqs[1].updateDimensionProperties?.properties?.pixelSize).toBe(120);
  });
});

describe('dataValidationRequest', () => {
  test('builds a dropdown from an explicit list, skipping the header row', () => {
    const req = client.dataValidationRequest(SHEET_ID, 2, ['Necessidade', 'Desejo']);

    expect(req.setDataValidation?.range?.startRowIndex).toBe(1);
    expect(req.setDataValidation?.range?.startColumnIndex).toBe(2);
    expect(req.setDataValidation?.rule?.condition?.type).toBe('ONE_OF_LIST');
    expect(req.setDataValidation?.rule?.condition?.values).toEqual([
      { userEnteredValue: 'Necessidade' },
      { userEnteredValue: 'Desejo' },
    ]);
    expect(req.setDataValidation?.rule?.showCustomUi).toBe(true);
  });
});

describe('budgetTrafficLightRequests', () => {
  const range = { startRowIndex: 1, endRowIndex: 10, startColumnIndex: 5, endColumnIndex: 6 };
  const reqs = client.budgetTrafficLightRequests(SHEET_ID, range);

  test('emits three rules ordered so >100% wins over >80%', () => {
    expect(reqs).toHaveLength(3);
    expect(reqs.map((r) => r.addConditionalFormatRule?.index)).toEqual([0, 1, 2]);
    expect(reqs[0].addConditionalFormatRule?.rule?.booleanRule?.condition?.values).toEqual([
      { userEnteredValue: '1' },
    ]);
    expect(reqs[1].addConditionalFormatRule?.rule?.booleanRule?.condition?.values).toEqual([
      { userEnteredValue: '0,8' },
    ]);
  });

  test('writes the threshold with a pt-BR decimal comma', () => {
    // Not cosmetic. Sheets parses condition literals in the SPREADSHEET's
    // locale, which ensureLocale() pins to pt_BR. Verified against the live
    // API: "0.8" comes back as `Invalid ConditionValue` with HTTP 400 and the
    // whole batchUpdate fails, taking the render — and the sync — down with it.
    const values = reqs
      .map((r) => r.addConditionalFormatRule?.rule?.booleanRule?.condition?.values?.[0]?.userEnteredValue)
      .filter((v): v is string => typeof v === 'string');

    expect(values).not.toContain('0.8');
    for (const value of values) {
      expect(value).not.toMatch(/\./);
    }
  });

  test('red for overspend, green for under 80%', () => {
    const red = reqs[0].addConditionalFormatRule?.rule?.booleanRule?.format?.backgroundColor;
    const green = reqs[2].addConditionalFormatRule?.rule?.booleanRule?.format?.backgroundColor;

    expect(red!.red!).toBeGreaterThan(red!.green!);
    expect(green!.green!).toBeGreaterThan(green!.red!);
  });

  test('applies to the range it was given', () => {
    expect(reqs[0].addConditionalFormatRule?.rule?.ranges?.[0]).toEqual({
      sheetId: SHEET_ID,
      ...range,
    });
  });
});

describe('negativeRedRequest', () => {
  test('colors values below zero', () => {
    const req = client.negativeRedRequest(SHEET_ID, { startColumnIndex: 5, endColumnIndex: 6 });
    const rule = req.addConditionalFormatRule?.rule?.booleanRule;

    expect(rule?.condition?.type).toBe('NUMBER_LESS');
    expect(rule?.condition?.values).toEqual([{ userEnteredValue: '0' }]);
    expect(rule?.format?.textFormat?.foregroundColor?.red).toBeGreaterThan(0.5);
  });
});

describe('pieChartRequest', () => {
  test('wires labels and values to a donut anchored at the given cell', () => {
    const req = client.pieChartRequest({
      sheetId: SHEET_ID,
      title: 'Gastos',
      labelsRange: { sheetId: SHEET_ID, startRowIndex: 18, endRowIndex: 26, startColumnIndex: 0, endColumnIndex: 1 },
      valuesRange: { sheetId: SHEET_ID, startRowIndex: 18, endRowIndex: 26, startColumnIndex: 1, endColumnIndex: 2 },
      anchorRow: 1,
      anchorColumn: 5,
    });

    const pie = req.addChart?.chart?.spec?.pieChart;
    expect(req.addChart?.chart?.spec?.title).toBe('Gastos');
    expect(pie?.pieHole).toBe(0.45);
    expect(pie?.domain?.sourceRange?.sources?.[0].startColumnIndex).toBe(0);
    expect(pie?.series?.sourceRange?.sources?.[0].startColumnIndex).toBe(1);
    expect(req.addChart?.chart?.position?.overlayPosition?.anchorCell).toEqual({
      sheetId: SHEET_ID,
      rowIndex: 1,
      columnIndex: 5,
    });
  });
});

describe('basicChartRequest', () => {
  test('builds a line chart with one series per range and a header row', () => {
    const range = (col: number) => ({
      sheetId: SHEET_ID, startRowIndex: 28, endRowIndex: 41, startColumnIndex: col, endColumnIndex: col + 1,
    });

    const req = client.basicChartRequest({
      sheetId: SHEET_ID,
      title: 'Evolução',
      chartType: 'LINE',
      domainRange: range(0),
      seriesRanges: [range(1), range(2), range(3)],
      anchorRow: 33,
      anchorColumn: 5,
    });

    const chart = req.addChart?.chart?.spec?.basicChart;
    expect(chart?.chartType).toBe('LINE');
    expect(chart?.headerCount).toBe(1);
    expect(chart?.series).toHaveLength(3);
    expect(chart?.domains?.[0].domain?.sourceRange?.sources?.[0].startColumnIndex).toBe(0);
    expect(chart?.stackedType).toBeUndefined();
  });

  test('marks the chart stacked when asked', () => {
    const range = { sheetId: SHEET_ID, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 };
    const req = client.basicChartRequest({
      sheetId: SHEET_ID,
      title: 'x',
      chartType: 'COLUMN',
      domainRange: range,
      seriesRanges: [range],
      anchorRow: 0,
      anchorColumn: 0,
      stacked: true,
    });

    expect(req.addChart?.chart?.spec?.basicChart?.stackedType).toBe('STACKED');
  });
});

describe('boldRowRequest', () => {
  test('bolds exactly one row', () => {
    const req = client.boldRowRequest(SHEET_ID, 12, 4);

    expect(req.repeatCell?.range?.startRowIndex).toBe(12);
    expect(req.repeatCell?.range?.endRowIndex).toBe(13);
    expect(req.repeatCell?.cell?.userEnteredFormat?.textFormat?.bold).toBe(true);
  });
});
