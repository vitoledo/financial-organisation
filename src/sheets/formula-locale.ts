/**
 * Formula syntax is locale-dependent, and this spreadsheet is pinned to pt_BR
 * by SheetsClient.ensureLocale().
 *
 * Google Sheets parses a USER_ENTERED formula in the SPREADSHEET's locale, not
 * in en-US. Verified against the live API on a pt_BR sheet:
 *
 *   =SUM(1,2)  →  1.2     ← parsed as the single decimal "1,2"
 *   =SUM(1;2)  →  3       ← correct
 *
 * The first case is the dangerous one: it is not an error, it is a wrong
 * number. Multi-argument formulas with non-numeric arguments fail louder, with
 * "#ERROR! (Formula parse error.)".
 *
 * So builders keep authoring formulas in the familiar en-US syntax and this
 * module translates them once, at the single point where cells are written.
 * Adding a formula anywhere is then automatically correct.
 */

/** Quote characters that open a literal: "text" and 'Sheet Name'. */
const QUOTES = new Set(['"', "'"]);

const isDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '9';

/**
 * Translate an en-US formula to pt-BR syntax: `,` becomes the argument
 * separator `;`, and a `.` between digits becomes the decimal comma.
 *
 * Characters inside quoted literals are left untouched, so a sheet name like
 * 'Config: Investimentos' or a text argument like "Conta Corrente" survives
 * verbatim.
 */
export function toPtBrFormula(formula: string): string {
  let result = '';
  let quote: string | null = null;

  for (let i = 0; i < formula.length; i++) {
    const char = formula[i];

    if (quote !== null) {
      result += char;
      // A doubled quote is an escaped quote inside the literal, not the end.
      if (char === quote) {
        if (formula[i + 1] === quote) {
          result += formula[++i];
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (QUOTES.has(char)) {
      quote = char;
      result += char;
      continue;
    }

    if (char === ',') {
      result += ';';
      continue;
    }

    if (char === '.' && isDigit(formula[i - 1]) && isDigit(formula[i + 1])) {
      result += ',';
      continue;
    }

    result += char;
  }

  return result;
}

/**
 * Apply the translation to every formula cell in a matrix, leaving all other
 * values untouched. A cell is a formula only when it is a string starting with
 * `=` — sanitizeCellText() has already neutralised any external text that
 * would otherwise look like one.
 */
export function localizeFormulas(rows: unknown[][]): unknown[][] {
  return rows.map((row) =>
    row.map((cell) =>
      typeof cell === 'string' && cell.startsWith('=') ? toPtBrFormula(cell) : cell,
    ),
  );
}
