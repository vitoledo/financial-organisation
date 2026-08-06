// Sheet (tab) names, in Portuguese. Kept in their own module so the pure
// builders can reference them without importing the Google API client.

export const SHEET_NAMES = {
  DASHBOARD: 'Dashboard',
  BALANCE: 'Saldo',
  MONTHLY_SUMMARY: 'Resumo Mensal',
  ANNUAL: 'Consolidado Anual',
  TRANSACTIONS: 'Transações',
  CURRENT_BILL: 'Fatura Atual',
  FUTURE_COMMITMENTS: 'Compromissos Futuros',
  INVESTMENTS: 'Investimentos',
  CONFIG_CATEGORIES: 'Config: Categorias',
  CONFIG_BUDGET: 'Config: Orçamento',
  CONFIG_INVESTMENTS: 'Config: Investimentos',
} as const;

export type SheetName = (typeof SHEET_NAMES)[keyof typeof SHEET_NAMES];
