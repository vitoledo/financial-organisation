import { Auth } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { SheetsClient, Request } from './client';
import { SHEET_NAMES } from './names';

export { SHEET_NAMES };

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

export const CATEGORY_HEADER = [
  'Categoria Pierre', 'Categoria Planilha', 'Grupo 50/30/20', 'Fixa/Variável',
];

export const GROUP_OPTIONS = ['Necessidade', 'Desejo', 'Poupança', '—'];
export const VARIABILITY_OPTIONS = ['Fixa', 'Variável', '—'];

/**
 * Pierre → spreadsheet category map. The left column holds the category names
 * Pierre actually emits (confirmed against real API payloads); the rest is the
 * user's taxonomy and is theirs to edit.
 */
const DEFAULT_CATEGORY_MAPPINGS: string[][] = [
  CATEGORY_HEADER,
  // Transfers — money moving, not spending. Kept out of every total.
  ['Pagamento de cartão de crédito', '(Transferência)', '—', '—'],
  ['Transferências', '(Transferência)', '—', '—'],
  ['Transferência', '(Transferência)', '—', '—'],
  ['Transferência mesma titularidade', '(Transferência)', '—', '—'],
  ['Resgate', '(Transferência)', '—', '—'],
  ['Aplicação', '(Transferência)', '—', '—'],
  // Alimentação
  ['Supermercado', 'Alimentação', 'Necessidade', 'Variável'],
  ['Alimentação', 'Alimentação', 'Necessidade', 'Variável'],
  ['Restaurantes', 'Restaurantes e Delivery', 'Desejo', 'Variável'],
  ['Delivery', 'Restaurantes e Delivery', 'Desejo', 'Variável'],
  ['Bares e baladas', 'Restaurantes e Delivery', 'Desejo', 'Variável'],
  // Transporte
  ['Táxi e transporte privado urbano', 'Transporte', 'Necessidade', 'Variável'],
  ['Transporte', 'Transporte', 'Necessidade', 'Variável'],
  ['Postos de gasolina', 'Transporte', 'Necessidade', 'Variável'],
  ['Combustível', 'Transporte', 'Necessidade', 'Variável'],
  ['Transporte público', 'Transporte', 'Necessidade', 'Variável'],
  ['Estacionamento', 'Transporte', 'Necessidade', 'Variável'],
  // Moradia e contas
  ['Moradia', 'Moradia', 'Necessidade', 'Fixa'],
  ['Aluguel', 'Moradia', 'Necessidade', 'Fixa'],
  ['Contas e Utilidades', 'Contas e Utilidades', 'Necessidade', 'Fixa'],
  ['Internet', 'Contas e Utilidades', 'Necessidade', 'Fixa'],
  ['Telefone', 'Contas e Utilidades', 'Necessidade', 'Fixa'],
  ['Energia', 'Contas e Utilidades', 'Necessidade', 'Fixa'],
  ['Água', 'Contas e Utilidades', 'Necessidade', 'Fixa'],
  // Saúde e bem-estar
  ['Saúde', 'Saúde', 'Necessidade', 'Fixa'],
  ['Farmácia', 'Saúde', 'Necessidade', 'Variável'],
  ['Bem-estar', 'Saúde', 'Desejo', 'Variável'],
  ['Academia', 'Saúde', 'Desejo', 'Fixa'],
  // Educação
  ['Educação', 'Educação', 'Necessidade', 'Fixa'],
  ['Cursos', 'Educação', 'Necessidade', 'Fixa'],
  // Lazer
  ['Lazer', 'Lazer', 'Desejo', 'Variável'],
  ['Entretenimento', 'Lazer', 'Desejo', 'Variável'],
  ['Streaming', 'Assinaturas', 'Desejo', 'Fixa'],
  ['Assinaturas', 'Assinaturas', 'Desejo', 'Fixa'],
  ['Viagens', 'Lazer', 'Desejo', 'Variável'],
  // Compras e serviços
  ['Compras', 'Compras', 'Desejo', 'Variável'],
  ['Vestuário', 'Vestuário', 'Desejo', 'Variável'],
  ['Serviços', 'Serviços', 'Necessidade', 'Variável'],
  ['Eletrônicos', 'Compras', 'Desejo', 'Variável'],
  // Poupança e outros
  ['Poupança', 'Poupança/Investimentos', 'Poupança', '—'],
  ['Investimentos', 'Poupança/Investimentos', 'Poupança', '—'],
  ['Presentes', 'Presentes/Doações', 'Desejo', 'Variável'],
  ['Doações', 'Presentes/Doações', 'Desejo', 'Variável'],
  ['Impostos e taxas', 'Impostos e Taxas', 'Necessidade', 'Variável'],
  ['Salário', 'Salário', '—', '—'],
  ['Outros', 'Outros', 'Desejo', 'Variável'],
];

/** Distinct spreadsheet categories that should get a budget line. */
const BUDGET_CATEGORIES = Array.from(
  new Set(
    DEFAULT_CATEGORY_MAPPINGS.slice(1)
      .map((row) => row[1])
      .filter((c) => c !== '(Transferência)' && c !== 'Salário'),
  ),
).sort((a, b) => a.localeCompare(b, 'pt-BR'));

const DEFAULT_BUDGET_CONFIG: unknown[][] = [
  ['Parâmetro', 'Valor', 'Observação'],
  ['Renda Líquida Mensal', '', 'Preencha: base da regra 50/30/20 e da taxa de poupança'],
  ['% Necessidades', 0.5, 'Alvo do grupo Necessidade'],
  ['% Desejos', 0.3, 'Alvo do grupo Desejo'],
  ['% Poupança', 0.2, 'Alvo do grupo Poupança'],
  ['', '', ''],
  ['Categoria', 'Orçamento Mensal (R$)', 'Deixe em branco para não acompanhar'],
  ...BUDGET_CATEGORIES.map((c) => [c, '', '']),
];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export interface SetupResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
}

const SPREADSHEET_TITLE = 'Financeiro — Controle Automatizado';

export function spreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

/**
 * Create the spreadsheet (or adopt the saved one) and make sure every tab
 * exists. Idempotent: safe to run on every sync, so a spreadsheet created by an
 * older version gains new tabs (e.g. Consolidado Anual) without a rebuild.
 */
export async function setupSpreadsheet(
  auth: Auth.OAuth2Client,
  idFilePath: string,
  logger?: { info: (msg: string) => void },
): Promise<SetupResult> {
  const existingId = readSpreadsheetId(idFilePath);

  if (existingId) {
    const client = new SheetsClient(auth, existingId);
    await client.ensureLocale();
    await ensureTabs(client, logger);
    return { spreadsheetId: existingId, spreadsheetUrl: spreadsheetUrl(existingId) };
  }

  logger?.info('Criando nova planilha...');
  const spreadsheetId = await SheetsClient.createSpreadsheet(auth, SPREADSHEET_TITLE);
  const client = new SheetsClient(auth, spreadsheetId);
  logger?.info(`Planilha criada: ${spreadsheetId}`);

  await ensureTabs(client, logger);
  await client.deleteDefaultSheet();
  await seedConfigTabs(client, logger);

  writeSpreadsheetId(idFilePath, spreadsheetId);
  logger?.info(`\n✅ Planilha pronta: ${spreadsheetUrl(spreadsheetId)}\n`);

  return { spreadsheetId, spreadsheetUrl: spreadsheetUrl(spreadsheetId) };
}

/** Create any tab that does not exist yet, preserving the intended order. */
async function ensureTabs(
  client: SheetsClient,
  logger?: { info: (msg: string) => void },
): Promise<void> {
  const existing = new Set(await client.listSheetTitles());
  const wanted = Object.values(SHEET_NAMES);

  for (let i = 0; i < wanted.length; i++) {
    if (existing.has(wanted[i])) continue;
    logger?.info(`  Criando aba: ${wanted[i]}`);
    await client.addSheet(wanted[i], i);
  }
}

/**
 * Config tabs hold the user's own decisions, so they are written exactly once —
 * at creation. Later syncs read them and never overwrite them.
 */
async function seedConfigTabs(
  client: SheetsClient,
  logger?: { info: (msg: string) => void },
): Promise<void> {
  logger?.info('  Preenchendo Config: Categorias...');
  await client.writeRows(SHEET_NAMES.CONFIG_CATEGORIES, DEFAULT_CATEGORY_MAPPINGS);

  logger?.info('  Preenchendo Config: Orçamento...');
  await client.writeRows(SHEET_NAMES.CONFIG_BUDGET, DEFAULT_BUDGET_CONFIG);

  const categoriesId = await client.getSheetId(SHEET_NAMES.CONFIG_CATEGORIES);
  const budgetId = await client.getSheetId(SHEET_NAMES.CONFIG_BUDGET);

  const requests: Request[] = [
    ...client.headerRequest(categoriesId, CATEGORY_HEADER.length, { red: 0.11, green: 0.31, blue: 0.47 }),
    ...client.columnWidthRequests(categoriesId, [
      { column: 0, width: 300 },
      { column: 1, width: 240 },
      { column: 2, width: 150 },
      { column: 3, width: 130 },
    ]),
    // Dropdowns keep the taxonomy typo-free — a misspelled group silently
    // breaks the dashboard's SUMIFS.
    client.dataValidationRequest(categoriesId, 2, GROUP_OPTIONS),
    client.dataValidationRequest(categoriesId, 3, VARIABILITY_OPTIONS),

    ...client.headerRequest(budgetId, 3, { red: 0.11, green: 0.31, blue: 0.47 }),
    ...client.columnWidthRequests(budgetId, [
      { column: 0, width: 240 },
      { column: 1, width: 190 },
      { column: 2, width: 420 },
    ]),
    client.numberFormatRequest(budgetId, { startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 2 }, '"R$" #,##0.00'),
    client.numberFormatRequest(budgetId, { startRowIndex: 2, endRowIndex: 5, startColumnIndex: 1, endColumnIndex: 2 }, '0%'),
    client.numberFormatRequest(
      budgetId,
      { startRowIndex: 7, endRowIndex: 7 + BUDGET_CATEGORIES.length, startColumnIndex: 1, endColumnIndex: 2 },
      '"R$" #,##0.00',
    ),
    client.boldRowRequest(budgetId, 6, 3),
  ];

  await client.batchUpdate(requests);
}

// ---------------------------------------------------------------------------
// Spreadsheet id persistence
// ---------------------------------------------------------------------------

function readSpreadsheetId(idFilePath: string): string | null {
  if (!fs.existsSync(idFilePath)) return null;
  const id = fs.readFileSync(idFilePath, 'utf8').trim();
  return id || null;
}

function writeSpreadsheetId(idFilePath: string, spreadsheetId: string): void {
  const dir = path.dirname(idFilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(idFilePath, spreadsheetId);
}
