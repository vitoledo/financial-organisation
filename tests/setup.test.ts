import { describe, it, expect, vi } from 'vitest';
import {
  seedMissingConfigTabs,
  DEFAULT_INVESTMENTS_CONFIG,
  INVESTMENTS_TABLE_HEADER_ROW,
  INVESTMENTS_DATA_FIRST_ROW,
} from '../src/sheets/setup';
import { parseInvestmentsConfig } from '../src/sheets/builders';
import { SHEET_NAMES } from '../src/sheets/names';
import { SheetsClient } from '../src/sheets/client';

describe('seedMissingConfigTabs', () => {
  it('seeds missing config tabs idempotently', async () => {
    const writtenRows: Record<string, unknown[][]> = {};
    const fakeClient = {
      readRows: vi.fn().mockImplementation(async (sheetName: string) => {
        // CONFIG_CATEGORIES already has rows, CONFIG_BUDGET and CONFIG_INVESTMENTS are empty
        if (sheetName === SHEET_NAMES.CONFIG_CATEGORIES) {
          return [['Categoria Pierre', 'Categoria Planilha']];
        }
        return [];
      }),
      writeRows: vi.fn().mockImplementation(async (sheetName: string, rows: unknown[][]) => {
        writtenRows[sheetName] = rows;
      }),
      getSheetId: vi.fn().mockResolvedValue(123),
      headerRequest: vi.fn().mockReturnValue([]),
      columnWidthRequests: vi.fn().mockReturnValue([]),
      dataValidationRequest: vi.fn().mockReturnValue({}),
      numberFormatRequest: vi.fn().mockReturnValue({}),
      boldRowRequest: vi.fn().mockReturnValue({}),
      batchUpdate: vi.fn().mockResolvedValue(undefined),
    } as unknown as SheetsClient;

    await seedMissingConfigTabs(fakeClient);

    // CONFIG_CATEGORIES was NOT written to because it already had rows
    expect(writtenRows[SHEET_NAMES.CONFIG_CATEGORIES]).toBeUndefined();

    // CONFIG_BUDGET and CONFIG_INVESTMENTS were seeded
    expect(writtenRows[SHEET_NAMES.CONFIG_BUDGET]).toBeDefined();
    expect(writtenRows[SHEET_NAMES.CONFIG_INVESTMENTS]).toBeDefined();
  });
});

describe('Config: Investimentos seed', () => {
  it('marks every seeded holding as an example so it never enters the net worth', () => {
    const assetRows = DEFAULT_INVESTMENTS_CONFIG.slice(INVESTMENTS_TABLE_HEADER_ROW + 1);

    expect(assetRows.length).toBeGreaterThan(0);
    for (const row of assetRows) {
      expect(String(row[0]).toLowerCase()).toContain('(exemplo)');
    }
    // And the parser that consumes the tab agrees they are inert.
    expect(parseInvestmentsConfig(DEFAULT_INVESTMENTS_CONFIG)).toEqual([]);
  });

  it('puts the CDI parameter where the CDI formula looks for it (B2)', () => {
    // buildInvestmentTabRows hardcodes 'Config: Investimentos'!$B$2.
    expect(DEFAULT_INVESTMENTS_CONFIG[1][0]).toBe('CDI anual (%)');
    expect(typeof DEFAULT_INVESTMENTS_CONFIG[1][1]).toBe('number');
  });

  it('anchors the dropdowns on the asset rows, not on the parameter block', async () => {
    const validations: Array<{ column: number; startRowIndex: number }> = [];
    const fakeClient = {
      readRows: vi.fn().mockResolvedValue([]),
      writeRows: vi.fn().mockResolvedValue(undefined),
      getSheetId: vi.fn().mockResolvedValue(7),
      headerRequest: vi.fn().mockReturnValue([]),
      columnWidthRequests: vi.fn().mockReturnValue([]),
      numberFormatRequest: vi.fn().mockReturnValue({}),
      boldRowRequest: vi.fn().mockReturnValue({}),
      batchUpdate: vi.fn().mockResolvedValue(undefined),
      dataValidationRequest: vi.fn().mockImplementation(
        (_sheetId: number, column: number, _values: string[], _end: number, startRowIndex = 1) => {
          validations.push({ column, startRowIndex });
          return {};
        },
      ),
    } as unknown as SheetsClient;

    await seedMissingConfigTabs(fakeClient);

    // Tipo / Origem / Método live in columns 1, 2 and 3 of the asset table.
    const investmentValidations = validations.filter((v) => v.startRowIndex === INVESTMENTS_DATA_FIRST_ROW);
    expect(investmentValidations.map((v) => v.column).sort()).toEqual([1, 2, 3]);
  });
});
