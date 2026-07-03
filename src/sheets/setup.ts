import { Auth } from 'googleapis';
import { SheetsClient } from './client';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Sheet names (in Portuguese, as decided)
// ---------------------------------------------------------------------------

export const SHEET_NAMES = {
  CONFIG_CATEGORIES: 'Config: Categorias',
  CONFIG_BUDGET: 'Config: Orçamento',
  BALANCE: 'Saldo',
  TRANSACTIONS: 'Transações',
  MONTHLY_SUMMARY: 'Resumo Mensal',
  CURRENT_BILL: 'Fatura Atual',
  FUTURE_COMMITMENTS: 'Compromissos Futuros',
  DASHBOARD: 'Dashboard',
} as const;

// ---------------------------------------------------------------------------
// Default category mappings (pre-populated)
// ---------------------------------------------------------------------------

const DEFAULT_CATEGORY_MAPPINGS: string[][] = [
  ['Categoria Pierre', 'Categoria Planilha', 'Grupo 50/30/20', 'Fixa/Variável'],
  ['Pagamento de cartão de crédito', '(Transferência)', '—', '—'],
  ['Transferências', '(Transferência)', '—', '—'],
  ['Transferência', '(Transferência)', '—', '—'],
  ['Resgate', '(Transferência)', '—', '—'],
  ['Aplicação', '(Transferência)', '—', '—'],
  ['Compras', 'Compras', 'Necessidade', 'Variável'],
  ['Alimentação', 'Alimentação', 'Necessidade', 'Variável'],
  ['Supermercado', 'Alimentação', 'Necessidade', 'Variável'],
  ['Restaurantes', 'Alimentação', 'Desejo', 'Variável'],
  ['Delivery', 'Alimentação', 'Desejo', 'Variável'],
  ['Transporte', 'Transporte', 'Necessidade', 'Variável'],
  ['Uber', 'Transporte', 'Necessidade', 'Variável'],
  ['Combustível', 'Transporte', 'Necessidade', 'Variável'],
  ['Saúde', 'Saúde', 'Necessidade', 'Fixa'],
  ['Farmácia', 'Saúde', 'Necessidade', 'Variável'],
  ['Educação', 'Educação', 'Necessidade', 'Fixa'],
  ['Lazer', 'Lazer', 'Desejo', 'Variável'],
  ['Entretenimento', 'Lazer', 'Desejo', 'Variável'],
  ['Streaming', 'Lazer', 'Desejo', 'Fixa'],
  ['Vestuário', 'Vestuário', 'Desejo', 'Variável'],
  ['Moradia', 'Moradia', 'Necessidade', 'Fixa'],
  ['Aluguel', 'Moradia', 'Necessidade', 'Fixa'],
  ['Contas e Utilidades', 'Contas e Utilidades', 'Necessidade', 'Fixa'],
  ['Internet', 'Contas e Utilidades', 'Necessidade', 'Fixa'],
  ['Telefone', 'Contas e Utilidades', 'Necessidade', 'Fixa'],
  ['Assinaturas', 'Assinaturas', 'Desejo', 'Fixa'],
  ['Poupança', 'Poupança/Investimentos', 'Poupança', '—'],
  ['Investimentos', 'Poupança/Investimentos', 'Poupança', '—'],
  ['Presentes', 'Presentes/Doações', 'Desejo', 'Variável'],
  ['Doações', 'Presentes/Doações', 'Desejo', 'Variável'],
  ['Outros', 'Outros', 'Desejo', 'Variável'],
];

// ---------------------------------------------------------------------------
// Default budget config
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET_CONFIG: string[][] = [
  ['Parâmetro', 'Valor'],
  ['Renda Líquida Mensal', ''],
  ['% Necessidades', '50%'],
  ['% Desejos', '30%'],
  ['% Poupança', '20%'],
  ['', ''],
  ['Categoria', 'Orçamento Mensal (R$)'],
  ['Alimentação', ''],
  ['Transporte', ''],
  ['Saúde', ''],
  ['Educação', ''],
  ['Lazer', ''],
  ['Vestuário', ''],
  ['Moradia', ''],
  ['Contas e Utilidades', ''],
  ['Assinaturas', ''],
  ['Compras', ''],
  ['Poupança/Investimentos', ''],
  ['Presentes/Doações', ''],
  ['Outros', ''],
];

// ---------------------------------------------------------------------------
// Setup: creates the spreadsheet and all tabs
// ---------------------------------------------------------------------------

export interface SetupResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
}

/**
 * Create a new Google Sheets spreadsheet with all tabs pre-configured.
 * Saves the spreadsheet ID to disk.
 */
export async function setupSpreadsheet(
  auth: Auth.OAuth2Client,
  idFilePath: string,
  logger?: { info: (msg: string) => void },
): Promise<SetupResult> {
  // Check if a spreadsheet ID already exists
  if (fs.existsSync(idFilePath)) {
    const existingId = fs.readFileSync(idFilePath, 'utf8').trim();
    if (existingId) {
      logger?.info(`Spreadsheet already exists: ${existingId}`);
      return {
        spreadsheetId: existingId,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${existingId}`,
      };
    }
  }

  logger?.info('Creating new spreadsheet...');

  // 1. Create the spreadsheet
  const spreadsheetId = await SheetsClient.createSpreadsheet(
    auth,
    'Financeiro — Controle Automatizado',
  );
  const client = new SheetsClient(auth, spreadsheetId);

  logger?.info(`Spreadsheet created: ${spreadsheetId}`);

  // 2. Create all tabs in order
  const tabNames = Object.values(SHEET_NAMES);
  for (let i = 0; i < tabNames.length; i++) {
    logger?.info(`  Creating tab: ${tabNames[i]}`);
    await client.addSheet(tabNames[i], i);
  }

  // 3. Delete the default "Sheet1" / "Planilha1"
  await client.deleteDefaultSheet();

  // 4. Pre-populate Config: Categorias
  logger?.info('  Populating Config: Categorias...');
  await client.writeRows(SHEET_NAMES.CONFIG_CATEGORIES, DEFAULT_CATEGORY_MAPPINGS);
  await client.freezeHeader(SHEET_NAMES.CONFIG_CATEGORIES);
  await client.formatHeaderRow(SHEET_NAMES.CONFIG_CATEGORIES, 4, { red: 0.15, green: 0.35, blue: 0.55 });
  await client.setColumnWidths(SHEET_NAMES.CONFIG_CATEGORIES, [
    { column: 0, width: 280 },
    { column: 1, width: 250 },
    { column: 2, width: 150 },
    { column: 3, width: 130 },
  ]);

  // 5. Pre-populate Config: Orçamento
  logger?.info('  Populating Config: Orçamento...');
  await client.writeRows(SHEET_NAMES.CONFIG_BUDGET, DEFAULT_BUDGET_CONFIG);
  await client.formatHeaderRow(SHEET_NAMES.CONFIG_BUDGET, 2, { red: 0.15, green: 0.35, blue: 0.55 });

  // 6. Write placeholder headers for data tabs
  const dataTabHeaders: Record<string, string[]> = {
    [SHEET_NAMES.BALANCE]: ['Conta', 'Tipo', 'Saldo (R$)', 'Limite (R$)', 'Disponível (R$)', 'Última Atualização'],
    [SHEET_NAMES.TRANSACTIONS]: ['Data', 'Descrição', 'Categoria', 'Tipo', 'Valor (R$)', 'Conta', 'Status'],
    [SHEET_NAMES.MONTHLY_SUMMARY]: ['Categoria', 'Grupo', 'Orçado (R$)', 'Realizado (R$)', 'Diferença (R$)', '% Usado'],
    [SHEET_NAMES.CURRENT_BILL]: ['Data', 'Descrição', 'Categoria', 'Valor (R$)', 'Status'],
    [SHEET_NAMES.FUTURE_COMMITMENTS]: ['Descrição', 'Parcela', 'Valor (R$)', 'Vencimento', 'Status', 'Cartão'],
    [SHEET_NAMES.DASHBOARD]: ['Indicador', 'Valor'],
  };

  for (const [tabName, headers] of Object.entries(dataTabHeaders)) {
    logger?.info(`  Setting up headers: ${tabName}`);
    await client.writeRows(tabName, [headers]);
    await client.freezeHeader(tabName);
    await client.formatHeaderRow(tabName, headers.length, { red: 0.2, green: 0.2, blue: 0.3 });
  }

  // 7. Set column widths for key data tabs
  await client.setColumnWidths(SHEET_NAMES.TRANSACTIONS, [
    { column: 0, width: 120 },  // Data
    { column: 1, width: 300 },  // Descrição
    { column: 2, width: 200 },  // Categoria
    { column: 3, width: 120 },  // Tipo
    { column: 4, width: 120 },  // Valor
    { column: 5, width: 150 },  // Conta
    { column: 6, width: 100 },  // Status
  ]);

  await client.setColumnWidths(SHEET_NAMES.BALANCE, [
    { column: 0, width: 200 },
    { column: 1, width: 150 },
    { column: 2, width: 130 },
    { column: 3, width: 130 },
    { column: 4, width: 130 },
    { column: 5, width: 170 },
  ]);

  // 8. Save spreadsheet ID to disk
  const dir = path.dirname(idFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(idFilePath, spreadsheetId);

  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
  logger?.info(`\n✅ Spreadsheet created: ${url}\n`);

  return { spreadsheetId, spreadsheetUrl: url };
}
