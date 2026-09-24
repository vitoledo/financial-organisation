import { describe, test, expect } from 'vitest';
import { TARGET_CONTRACT } from '../src/domain/schema-contract';
import {
  NotionSchemaValidator,
  NotionPropertySnapshot,
  PropertyDiff,
  normalizePropName,
} from '../src/notion/schema-validator';

/**
 * Validated Real Data Source UUIDs from the Phase 0 introspection report.
 */
export const REAL_DATA_SOURCE_IDS = {
  NOTION_DS_ACCOUNTS: 'a17455aa-4793-4001-9570-21b7f84ff4a2',
  NOTION_DS_TRANSACTIONS: '1fc274bd-b73a-45b1-a902-09aba993f199',
  NOTION_DS_CATEGORIES: 'eb8ef2e3-cfd3-437e-b3f5-6a47dec913b4',
  NOTION_DS_RULES: 'b36ba8da-9601-4456-a21f-5d9804110fbb',
  NOTION_DS_FIXED_BILLS: '49e909f9-7a08-4114-bc85-0bb500e3dfb9',
  NOTION_DS_MONTHLY_OBLIGATIONS: '5c59339c-7cfc-4f17-9355-803a4136f6b8',
  NOTION_DS_INVESTMENTS: 'db609202-8cb8-4ce9-8dd7-c01d9de6b6cb',
  NOTION_DS_INVESTMENT_MOVEMENTS: 'b19f56a4-e34f-42ec-9437-c5165b8725af',
  NOTION_DS_MONTHLY_BUDGET: '0c14523b-9e22-483a-8e63-4b3d0c31c7d5',
  NOTION_DS_FINANCIAL_GOALS: 'b62903fe-ee4e-411f-8828-fd465f9aed91',
  NOTION_DS_MONTHLY_CLOSINGS: '74ff9360-514c-4fde-a366-d7a1b726b94c',
  NOTION_DS_SYNC_LOG: '2a6107e9-4ebb-456f-84f9-dba3bc573d20',
};

import rawSnapshot from './fixtures/notion-live-schema.snapshot.json';

/**
 * Sanitized, versionable structural snapshot derived from real introspection of the 12 bases.
 * (No financial records, credentials, or PII).
 */
export const LIVE_NOTION_FIXTURES: Record<string, Record<string, NotionPropertySnapshot>> =
  rawSnapshot as unknown as Record<string, Record<string, NotionPropertySnapshot>>;

describe('Phase 0 Live Schema Fixtures Verification (Contract Alignment)', () => {
  const validator = new NotionSchemaValidator();
  const allDiffs: Record<string, PropertyDiff[]> = {};

  // Compute diffs once for all 12 existing bases
  for (const envKey of Object.keys(LIVE_NOTION_FIXTURES)) {
    const contract = TARGET_CONTRACT[envKey];
    const actualProps = LIVE_NOTION_FIXTURES[envKey];
    allDiffs[envKey] = validator.compareProperties(contract, actualProps, REAL_DATA_SOURCE_IDS);
  }

  describe('Global Integrity Across All 12 Bases', () => {
    test('ZERO TYPE_MISMATCH across the entire workspace', () => {
      const typeMismatches: Array<{ base: string; prop: string; desc: string }> = [];
      for (const [base, diffs] of Object.entries(allDiffs)) {
        for (const diff of diffs) {
          if (diff.status === 'TYPE_MISMATCH') {
            typeMismatches.push({ base, prop: diff.notionProperty, desc: diff.description });
          }
        }
      }
      expect(typeMismatches).toEqual([]);
    });

    test('ZERO RENAME_TYPE_MISMATCH across the entire workspace', () => {
      const renameTypeMismatches: Array<{ base: string; prop: string; candidate: string }> = [];
      for (const [base, diffs] of Object.entries(allDiffs)) {
        for (const diff of diffs) {
          if (diff.status === 'RENAME_TYPE_MISMATCH') {
            renameTypeMismatches.push({
              base,
              prop: diff.notionProperty,
              candidate: diff.candidateName || '',
            });
          }
        }
      }
      expect(renameTypeMismatches).toEqual([]);
    });

    test('ZERO unexpected RENAME_STRUCTURAL_MISMATCH across the entire workspace', () => {
      const renameStructuralMismatches: Array<{ base: string; prop: string }> = [];
      for (const [base, diffs] of Object.entries(allDiffs)) {
        for (const diff of diffs) {
          if (diff.status === 'RENAME_STRUCTURAL_MISMATCH') {
            renameStructuralMismatches.push({ base, prop: diff.notionProperty });
          }
        }
      }
      expect(renameStructuralMismatches).toEqual([]);
    });

    test('STRUCTURAL_MISMATCH occurs ONLY on NOTION_DS_MONTHLY_OBLIGATIONS.Status (homologated ALTER_SCHEMA)', () => {
      const structuralMismatches: Array<{ base: string; prop: string }> = [];
      for (const [base, diffs] of Object.entries(allDiffs)) {
        for (const diff of diffs) {
          if (diff.status === 'STRUCTURAL_MISMATCH') {
            structuralMismatches.push({ base, prop: diff.notionProperty });
          }
        }
      }

      // Exactly one structural mismatch in the whole workspace, which is the homologated ALTER_SCHEMA
      expect(structuralMismatches).toEqual([
        { base: 'NOTION_DS_MONTHLY_OBLIGATIONS', prop: 'Status' },
      ]);
    });

    test('ZERO unconfirmed HEURISTIC_SUGGESTION across the entire workspace (all aliases explicit)', () => {
      const heuristicSuggestions: Array<{ base: string; prop: string }> = [];
      for (const [base, diffs] of Object.entries(allDiffs)) {
        for (const diff of diffs) {
          if (diff.status === 'HEURISTIC_SUGGESTION') {
            heuristicSuggestions.push({ base, prop: diff.notionProperty });
          }
        }
      }
      expect(heuristicSuggestions).toEqual([]);
    });
  });

  const findDiff = (diffs: PropertyDiff[], propName: string) => {
    const norm = normalizePropName(propName);
    return diffs.find(
      (d) =>
        normalizePropName(d.notionProperty) === norm ||
        (d.candidateName && normalizePropName(d.candidateName) === norm),
    );
  };

  describe('Base-by-Base Conformance against Homologated Decisions', () => {
    test('1. Contas (NOTION_DS_ACCOUNTS): Instituição is rich_text, Tipo maps alias without mismatch', () => {
      const diffs = allDiffs.NOTION_DS_ACCOUNTS;
      const getDiff = (p: string) => findDiff(diffs, p);

      expect(getDiff('Instituição')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Instituição')?.expectedType).toBe('rich_text');
      expect(getDiff('Instituição')?.actualType).toBe('rich_text');

      expect(getDiff('Fonte')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Moeda')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Tipo de Conta')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Tipo de Conta')?.candidateName).toBe('Tipo');

      expect(getDiff('Nome da Conta')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Saldo Atual')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Última Sincronização')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Incluir no Caixa')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Incluir no Patrimônio')?.status).toBe('RENAME_CANDIDATE');

      // Only the 4 homologated CREATE_NEW properties are missing
      const missing = diffs.filter((d) => d.status === 'MISSING').map((d) => d.notionProperty);
      expect(missing).toEqual([
        'Limite Operacional Usado',
        'Limite Usado da Fonte (Bruto)',
        'Dia de Fechamento',
        'Dia de Vencimento',
      ]);
    });

    test('2. Transações (NOTION_DS_TRANSACTIONS): Natureza, Status, Moeda match cleanly', () => {
      const diffs = allDiffs.NOTION_DS_TRANSACTIONS;
      const getDiff = (p: string) => findDiff(diffs, p);

      expect(getDiff('Moeda')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Fonte')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Descrição')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Natureza Econômica')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Natureza Econômica')?.candidateName).toBe('Natureza');
      expect(getDiff('Status Banco')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Status Banco')?.candidateName).toBe('Status');

      // 10 homologated CREATE_NEW properties
      const missing = diffs.filter((d) => d.status === 'MISSING').map((d) => d.notionProperty);
      expect(missing).toEqual([
        'Hash Canônico',
        'Valor Bruto da Fonte',
        'Efeito Orçamentário',
        'Propósito de Alocação',
        'Contribuição Meta Poupança',
        'Conta Destino',
        'Fatura Vinculada',
        'Status de Revisão',
        'Motivo da Revisão',
        'HMAC Contraparte',
      ]);
    });

    test('3. Categorias (NOTION_DS_CATEGORIES): Grupo and Variabilidade match with zero missing', () => {
      const diffs = allDiffs.NOTION_DS_CATEGORIES;
      const getDiff = (p: string) => findDiff(diffs, p);

      expect(getDiff('Grupo Orçamentário')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Grupo Orçamentário')?.candidateName).toBe('Grupo');
      expect(getDiff('Variabilidade')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Natureza Padrão')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Nome da Categoria')?.status).toBe('RENAME_CANDIDATE');

      const missing = diffs.filter((d) => d.status === 'MISSING');
      expect(missing).toHaveLength(0);
    });

    test('4. Regras (NOTION_DS_RULES): Natureza resultante and all conditions match via aliases', () => {
      const diffs = allDiffs.NOTION_DS_RULES;
      const getDiff = (p: string) => findDiff(diffs, p);

      expect(getDiff('Atribuir: Natureza')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Atribuir: Natureza')?.candidateName).toBe('Natureza resultante');
      expect(getDiff('Condição: Movimento')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Condição: Conta')?.status).toBe('RENAME_CANDIDATE');

      // 3 homologated CREATE_NEW
      const missing = diffs.filter((d) => d.status === 'MISSING').map((d) => d.notionProperty);
      expect(missing).toEqual([
        'Atribuir: Efeito Orçamento',
        'Atribuir: Alocação',
        'Atribuir: Conta Destino',
      ]);
    });

    test('5. Contas Fixas (NOTION_DS_FIXED_BILLS): payment methods and aliases match', () => {
      const diffs = allDiffs.NOTION_DS_FIXED_BILLS;
      const getDiff = (p: string) => findDiff(diffs, p);

      expect(getDiff('Forma de Pagamento')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Valor Previsto')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Valor Previsto')?.candidateName).toBe('Valor esperado');
      expect(getDiff('Dia de Vencimento')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Dia de Vencimento')?.candidateName).toBe('Dia do vencimento');
      expect(getDiff('Tolerância (R$)')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Tolerância (R$)')?.candidateName).toBe('Tolerância de valor');
      expect(getDiff('Padrão de Identificação')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Padrão de Identificação')?.candidateName).toBe('Regra de identificação');

      // 4 homologated CREATE_NEW
      const missing = diffs.filter((d) => d.status === 'MISSING').map((d) => d.notionProperty);
      expect(missing).toEqual([
        'Competência Âncora',
        'Última Competência Gerada',
        'Data de Início',
        'Data de Término',
      ]);
    });

    test('6. Obrigações (NOTION_DS_MONTHLY_OBLIGATIONS): single ALTER_SCHEMA on Status, Referência, Conta, Origem represented', () => {
      const diffs = allDiffs.NOTION_DS_MONTHLY_OBLIGATIONS;
      const getDiff = (p: string) => findDiff(diffs, p);

      expect(getDiff('Status')?.status).toBe('STRUCTURAL_MISMATCH');
      expect(getDiff('Transação Vinculada')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Transação Vinculada')?.candidateName).toBe('Transação conciliada');
      expect(getDiff('Identificador')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Data de Vencimento')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Data do Pagamento')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Referência')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Conta')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Origem')?.status).toBe('EXACT_MATCH');

      // 0 missing: all existing fields represented and reused, zero duplicates
      const missing = diffs.filter((d) => d.status === 'MISSING').map((d) => d.notionProperty);
      expect(missing).toEqual([]);
    });

    test('7. Investimentos (NOTION_DS_INVESTMENTS): Instituição/Liquidez are rich_text, Classe matches', () => {
      const diffs = allDiffs.NOTION_DS_INVESTMENTS;
      const getDiff = (p: string) => findDiff(diffs, p);

      expect(getDiff('Instituição / Corretora')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Instituição / Corretora')?.candidateName).toBe('Instituição');
      expect(getDiff('Liquidez')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Liquidez')?.expectedType).toBe('rich_text');
      expect(getDiff('Moeda')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Classe do Ativo')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Classe do Ativo')?.candidateName).toBe('Classe');
      expect(getDiff('Fonte da Avaliação')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Fonte da Avaliação')?.candidateName).toBe('Fonte do preço');

      // 5 homologated CREATE_NEW
      const missing = diffs.filter((d) => d.status === 'MISSING').map((d) => d.notionProperty);
      expect(missing).toEqual([
        'Custódia',
        'Preço Médio Unitário (PMP)',
        'Lucro / Prejuízo Não Realizado',
        'Retorno Não Realizado (%)',
        'Conta Vinculada',
      ]);
    });

    test('8. Movimentações (NOTION_DS_INVESTMENT_MOVEMENTS): sole title is Movimentação, aliases resolved', () => {
      const diffs = allDiffs.NOTION_DS_INVESTMENT_MOVEMENTS;
      const getDiff = (p: string) => findDiff(diffs, p);

      expect(getDiff('Movimentação')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Movimentação')?.expectedType).toBe('title');
      expect(getDiff('Tipo de Movimentação')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Tipo de Movimentação')?.candidateName).toBe('Tipo');
      expect(getDiff('Valor Bruto')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Valor Bruto')?.candidateName).toBe('Valor');
      expect(getDiff('Transação Financeira')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Transação Financeira')?.candidateName).toBe('Transação origem');

      // 2 homologated CREATE_NEW
      const missing = diffs.filter((d) => d.status === 'MISSING').map((d) => d.notionProperty);
      expect(missing).toEqual([
        'Impacto Líquido de Caixa',
        'Conta Destino / Caixa',
      ]);
    });

    test('9. Planejamento Mensal (NOTION_DS_MONTHLY_BUDGET): all aliases map cleanly', () => {
      const diffs = allDiffs.NOTION_DS_MONTHLY_BUDGET;
      const getDiff = (p: string) => findDiff(diffs, p);

      expect(getDiff('Competência')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Competência')?.candidateName).toBe('Mês');
      expect(getDiff('Renda Prevista')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Renda Prevista')?.candidateName).toBe('Renda planejada');
      expect(getDiff('Teto Mensal Cartão')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Teto Mensal Cartão')?.candidateName).toBe('Teto pessoal de crédito');
      expect(getDiff('Meta de Poupança/Aporte')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Meta de Poupança/Aporte')?.candidateName).toBe('Aporte planejado');
      expect(getDiff('Meta Taxa de Poupança (%)')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Meta Taxa de Poupança (%)')?.candidateName).toBe('Meta de poupança %');

      // 4 homologated CREATE_NEW
      const missing = diffs.filter((d) => d.status === 'MISSING').map((d) => d.notionProperty);
      expect(missing).toEqual([
        'Receitas Realizadas',
        'Despesas Realizadas',
        'Poupança Realizada',
        'Compras Realizadas Cartão',
      ]);
    });

    test('10. Metas Financeiras (NOTION_DS_FINANCIAL_GOALS): represents all 10 properties with zero missing', () => {
      const diffs = allDiffs.NOTION_DS_FINANCIAL_GOALS;
      const getDiff = (p: string) => findDiff(diffs, p);

      expect(getDiff('Meta')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Valor Alvo')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Prazo Alvo')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Prazo Alvo')?.candidateName).toBe('Prazo');
      expect(getDiff('Valor Atual Acumulado')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Valor Atual Acumulado')?.candidateName).toBe('Valor atual');
      expect(getDiff('Aporte Mensal Planejado')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Tipo')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Liquidez Necessária')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Prioridade')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Status')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Observações')?.status).toBe('EXACT_MATCH');

      const missing = diffs.filter((d) => d.status === 'MISSING');
      expect(missing).toHaveLength(0);
    });

    test('11. Fechamentos Mensais (NOTION_DS_MONTHLY_CLOSINGS): 3-tier Qualidade and Status match', () => {
      const diffs = allDiffs.NOTION_DS_MONTHLY_CLOSINGS;
      const getDiff = (p: string) => findDiff(diffs, p);

      expect(getDiff('Qualidade dos Dados')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Status do Fechamento')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Status do Fechamento')?.candidateName).toBe('Status');
      expect(getDiff('Poupança / Aportes Realizados')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Poupança / Aportes Realizados')?.candidateName).toBe('Aportes');
      expect(getDiff('Renda Consolidada')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Renda Consolidada')?.candidateName).toBe('Receitas');
      expect(getDiff('Despesas Consolidadas')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Despesas Consolidadas')?.candidateName).toBe('Despesas');
      expect(getDiff('Patrimônio Líquido Final')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Patrimônio Líquido Final')?.candidateName).toBe('Patrimônio final');

      // 9 homologated CREATE_NEW
      const missing = diffs.filter((d) => d.status === 'MISSING').map((d) => d.notionProperty);
      expect(missing).toEqual([
        'Status de Reconciliação',
        'Patrimônio Inicial',
        'Despesas Essenciais (Necessidades)',
        'Despesas Discricionárias (Desejos)',
        'Resultado do Mês (Sobra Operacional)',
        'Taxa de Poupança (%)',
        'Fluxo Residual Não Alocado',
        'Rendimentos de Investimentos',
        'Variação Patrimonial',
      ]);
    });

    test('12. Log de Sincronização (NOTION_DS_SYNC_LOG): Fonte and Status match cleanly via mappings', () => {
      const diffs = allDiffs.NOTION_DS_SYNC_LOG;
      const getDiff = (p: string) => findDiff(diffs, p);

      expect(getDiff('Status')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Fonte')?.status).toBe('EXACT_MATCH');
      expect(getDiff('Data Início')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Data Início')?.candidateName).toBe('Iniciada em');
      expect(getDiff('Data Fim')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Data Fim')?.candidateName).toBe('Concluída em');
      expect(getDiff('Contas Processadas')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Contas Processadas')?.candidateName).toBe('Contas recebidas');
      expect(getDiff('Enviadas para Revisão')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Enviadas para Revisão')?.candidateName).toBe('Pendências de revisão');
      expect(getDiff('Mensagem de Erro Sanitizada')?.status).toBe('RENAME_CANDIDATE');
      expect(getDiff('Mensagem de Erro Sanitizada')?.candidateName).toBe('Erro / alerta');

      // 10 homologated CREATE_NEW
      const missing = diffs.filter((d) => d.status === 'MISSING').map((d) => d.notionProperty);
      expect(missing).toEqual([
        'Duração (s)',
        'Duração (ms)',
        'Transações Inalteradas',
        'Erros Encontrados',
        'Obrigações Conciliadas',
        'ID da Execução (Run ID)',
        'Código do Erro',
        'Referência do Log Privado',
        'Hash do Lote RAW',
        'Versão do Worker / Commit',
      ]);
    });
  });

  describe('Anti-Regression: Physical Schema Snapshot Integrity and Option Equality', () => {
    test('contains all 12 existing Data Sources in the physical snapshot', () => {
      const keys = Object.keys(LIVE_NOTION_FIXTURES);
      expect(keys).toHaveLength(12);
      for (const envKey of Object.keys(REAL_DATA_SOURCE_IDS)) {
        expect(LIVE_NOTION_FIXTURES[envKey], `Missing ${envKey} in snapshot`).toBeDefined();
      }
    });

    test('validates exact equality of all physical select/status options directly against the snapshot', () => {
      // 1. Contas
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_ACCOUNTS['Moeda']?.selectOptions).toEqual(['BRL', 'USD', 'Outra']);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_ACCOUNTS['Tipo']?.selectOptions).toEqual([
        'Conta corrente', 'Cartão de crédito', 'Carteira', 'Corretora', 'Dinheiro', 'Outro',
      ]);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_ACCOUNTS['Fonte']?.selectOptions).toEqual(['Pierre', 'Manual', 'Outra']);

      // 2. Transações
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_TRANSACTIONS['Fonte']?.selectOptions).toEqual(['Pierre', 'Manual', 'Migração', 'Outra']);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_TRANSACTIONS['Natureza']?.selectOptions).toEqual([
        'Receita', 'Despesa', 'Transferência interna', 'Aporte', 'Resgate', 'Reembolso', 'Pagamento de fatura', 'Ajuste',
      ]);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_TRANSACTIONS['Status']?.selectOptions).toEqual(['Pendente', 'Confirmado', 'Cancelado']);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_TRANSACTIONS['Movimento']?.selectOptions).toEqual(['Entrada', 'Saída']);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_TRANSACTIONS['Moeda']?.selectOptions).toEqual(['BRL', 'USD', 'Outra']);

      // 3. Categorias
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_CATEGORIES['Natureza padrão']?.selectOptions).toEqual(['Receita', 'Despesa', 'Patrimonial', 'Mista']);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_CATEGORIES['Variabilidade']?.selectOptions).toEqual(['Fixa', 'Variável', 'N/A']);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_CATEGORIES['Grupo']?.selectOptions).toEqual([
        'Necessidade', 'Desejo', 'Poupança/Investimento', 'Fora do orçamento',
      ]);

      // 4. Regras
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_RULES['Movimento esperado']?.selectOptions).toEqual(['Entrada', 'Saída', 'Qualquer']);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_RULES['Tipo']?.selectOptions).toEqual([
        'Contraparte + valor', 'Contraparte', 'Descrição', 'Categoria Pierre', 'Conta', 'Personalizada',
      ]);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_RULES['Natureza resultante']?.selectOptions).toEqual([
        'Receita', 'Despesa', 'Transferência interna', 'Aporte', 'Resgate', 'Reembolso', 'Pagamento de fatura', 'Ajuste',
      ]);

      // 5. Contas Fixas
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_FIXED_BILLS['Forma de pagamento']?.selectOptions).toEqual([
        'Cartão', 'Débito', 'Pix', 'Boleto', 'Débito automático', 'Outro',
      ]);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_FIXED_BILLS['Periodicidade']?.selectOptions).toEqual([
        'Mensal', 'Bimestral', 'Trimestral', 'Semestral', 'Anual',
      ]);

      // 6. Obrigações Mensais
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_MONTHLY_OBLIGATIONS['Status']?.selectOptions).toEqual([
        'Prevista', 'Pendente', 'Paga', 'Atrasada', 'Dispensada',
      ]);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_MONTHLY_OBLIGATIONS['Origem']?.selectOptions).toEqual(['Rotina', 'Manual', 'Pierre']);

      // 7. Investimentos
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_INVESTMENTS['Moeda']?.selectOptions).toEqual(['BRL', 'USD', 'Outra']);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_INVESTMENTS['Classe']?.selectOptions).toEqual([
        'Cripto', 'Renda fixa', 'Ações', 'FIIs', 'ETFs', 'Fundos', 'Caixa', 'Outro',
      ]);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_INVESTMENTS['Fonte do preço']?.selectOptions).toEqual(['Pierre', 'Mercado', 'Manual', 'Outra']);

      // 8. Movimentações de Investimentos
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_INVESTMENT_MOVEMENTS['Moeda']?.selectOptions).toEqual(['BRL', 'USD', 'Outra']);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_INVESTMENT_MOVEMENTS['Tipo']?.selectOptions).toEqual([
        'Aporte', 'Compra', 'Venda', 'Rendimento', 'Resgate', 'Taxa', 'Transferência', 'Ajuste',
      ]);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_INVESTMENT_MOVEMENTS['Fonte']?.selectOptions).toEqual(['Pierre', 'Manual', 'Migração', 'Outra']);

      // 9. Planejamento Mensal
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_MONTHLY_BUDGET['Status']?.selectOptions).toEqual(['Planejando', 'Ativo', 'Fechado']);

      // 10. Metas Financeiras
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_FINANCIAL_GOALS['Tipo']?.selectOptions).toEqual([
        'Reserva de emergência', 'Compra', 'Viagem', 'Investimento', 'Quitação', 'Outro',
      ]);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_FINANCIAL_GOALS['Liquidez necessária']?.selectOptions).toEqual([
        'Imediata', 'Curta', 'Média', 'Longa',
      ]);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_FINANCIAL_GOALS['Prioridade']?.selectOptions).toEqual(['Alta', 'Média', 'Baixa']);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_FINANCIAL_GOALS['Status']?.selectOptions).toEqual([
        'Planejada', 'Em andamento', 'Concluída', 'Pausada',
      ]);

      // 11. Fechamentos Mensais
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_MONTHLY_CLOSINGS['Status']?.selectOptions).toEqual(['Aberto', 'Em revisão', 'Fechado']);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_MONTHLY_CLOSINGS['Qualidade dos dados']?.selectOptions).toEqual(['Alta', 'Média', 'Baixa']);

      // 12. Log de Sincronização
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_SYNC_LOG['Status']?.selectOptions).toEqual(['Executando', 'Sucesso', 'Parcial', 'Erro']);
      expect(LIVE_NOTION_FIXTURES.NOTION_DS_SYNC_LOG['Fonte']?.selectOptions).toEqual(['Pierre', 'Migração', 'Manual']);
    });

    test('validates that NOTION_DS_SYNC_LOG.Fonte strictly does NOT contain Outra', () => {
      const syncFonte = LIVE_NOTION_FIXTURES.NOTION_DS_SYNC_LOG['Fonte'];
      expect(syncFonte?.selectOptions).not.toContain('Outra');
      expect(syncFonte?.selectOptions).toEqual(['Pierre', 'Migração', 'Manual']);
    });

    test('validates that NOTION_DS_MONTHLY_OBLIGATIONS.Status strictly does NOT contain post-migration options yet', () => {
      const statusProp = LIVE_NOTION_FIXTURES.NOTION_DS_MONTHLY_OBLIGATIONS['Status'];
      expect(statusProp?.selectOptions).not.toContain('Revisão Necessária');
      expect(statusProp?.selectOptions).not.toContain('Cancelada');
    });

    test('fails if any known physical option is inadvertently omitted from a fixture property', () => {
      // Intentionally simulate omission of 'Taxa' in a cloned fixture of Movements Tipo
      const corruptedProps: Record<string, NotionPropertySnapshot> = {
        ...LIVE_NOTION_FIXTURES.NOTION_DS_INVESTMENT_MOVEMENTS,
        'Tipo': {
          type: 'select',
          selectOptions: ['Aporte', 'Compra', 'Venda', 'Rendimento', 'Resgate', 'Transferência', 'Ajuste'], // Missing 'Taxa'
        },
      };

      const diffs = validator.compareProperties(
        TARGET_CONTRACT.NOTION_DS_INVESTMENT_MOVEMENTS,
        corruptedProps,
        REAL_DATA_SOURCE_IDS,
      );

      const tipoDiff = diffs.find((d) => normalizePropName(d.notionProperty) === normalizePropName('Tipo de Movimentação'));
      expect(tipoDiff?.status).toBe('RENAME_STRUCTURAL_MISMATCH');
      expect(tipoDiff?.description).toContain('Taxa');
    });
  });
});
