import { describe, test, expect } from 'vitest';
import { toPtBrFormula, localizeFormulas } from '../src/sheets/formula-locale';

describe('toPtBrFormula', () => {
  test('turns argument separators into semicolons', () => {
    // The bug this exists for: in a pt_BR sheet =SUM(1,2) evaluates to 1.2,
    // silently, because "1,2" reads as one decimal number.
    expect(toPtBrFormula('=SUM(1,2)')).toBe('=SUM(1;2)');
  });

  test('turns a decimal point between digits into a comma', () => {
    expect(toPtBrFormula('=IF(A1>0.8,1,0)')).toBe('=IF(A1>0,8;1;0)');
  });

  test('leaves text literals untouched', () => {
    expect(toPtBrFormula('=SUMIF($B$2:$B$5,"Conta Corrente",$C$2:$C$5)'))
      .toBe('=SUMIF($B$2:$B$5;"Conta Corrente";$C$2:$C$5)');
  });

  test('preserves commas and dots inside quoted text', () => {
    expect(toPtBrFormula('=IF(A1,"1,5 e 2.5","x")')).toBe('=IF(A1;"1,5 e 2.5";"x")');
  });

  test('leaves single-quoted sheet names untouched', () => {
    expect(toPtBrFormula("=IFERROR(VLOOKUP($A2,'Config: Orçamento'!$A:$B,2,FALSE),0)"))
      .toBe("=IFERROR(VLOOKUP($A2;'Config: Orçamento'!$A:$B;2;FALSE);0)");
  });

  test('handles an escaped quote inside a literal', () => {
    expect(toPtBrFormula('=IFERROR(GOOGLEFINANCE("A""B"),"")'))
      .toBe('=IFERROR(GOOGLEFINANCE("A""B");"")');
  });

  test('does not touch range colons or absolute markers', () => {
    expect(toPtBrFormula('=SUM($G$2:$G$10)')).toBe('=SUM($G$2:$G$10)');
  });

  test('converts a real GOOGLEFINANCE row formula end to end', () => {
    expect(toPtBrFormula('=IF(NOT(ISNUMBER(D2)), IF(ISNUMBER(E2), E2, 181.54), IFERROR(D2*F2, E2))'))
      .toBe('=IF(NOT(ISNUMBER(D2)); IF(ISNUMBER(E2); E2; 181,54); IFERROR(D2*F2; E2))');
  });
});

describe('localizeFormulas', () => {
  test('rewrites only cells that are formulas', () => {
    const rows = localizeFormulas([['Texto, com vírgula', 42, '=SUM(1,2)', null]]);

    expect(rows[0][0]).toBe('Texto, com vírgula');
    expect(rows[0][1]).toBe(42);
    expect(rows[0][2]).toBe('=SUM(1;2)');
    expect(rows[0][3]).toBeNull();
  });

  test('leaves apostrophe-escaped text alone', () => {
    // sanitizeCellText prefixes an apostrophe, so injected text never starts
    // with "=" and is never treated as a formula here.
    const rows = localizeFormulas([["'=SUM(1,2)"]]);
    expect(rows[0][0]).toBe("'=SUM(1,2)");
  });
});
