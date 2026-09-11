import { TARGET_CONTRACT } from '../../domain/schema-contract';
import { BackfillPlan, BackfillPipeline } from './types';

export class BackfillPlanner {
  /**
   * Generates the deterministic DML backfill plan.
   * Details the read, transform, write, and verification strategies for each pipeline.
   * Strictly planned as dry-run; no backfill execution takes place.
   */
  public generatePlan(): BackfillPlan {
    const pipelines: BackfillPipeline[] = [
      {
        id: 'PIPELINE_1_ACCOUNTS',
        name: 'Backfill de Contas e Limites Operacionais',
        targetDataSource: {
          envKey: TARGET_CONTRACT.NOTION_DS_ACCOUNTS.envKey,
          name: TARGET_CONTRACT.NOTION_DS_ACCOUNTS.defaultTitle,
        },
        mode: 'IDEMPOTENT_CHECKPOINTED',
        description:
          'Popula Limite Operacional Usado (Limite Personalizado - Limite Disponível), Limite Usado da Fonte (Bruto) e Dia de Fechamento.',
        readStrategy:
          'Cursor-based paged query de todas as contas ativas no Notion; leitura comparativa dos metadados locais no SQLite.',
        transformStrategy:
          'Cálculo determinístico: limiteOperacionalUsado = max(0, limitePersonalizado - limiteDisponivel). Atribuição de diaDeFechamento para contas de cartão.',
        writeStrategy:
          'PATCH idempotente por registro com rate-limiting de 3 req/s; gravação de checkpoint no SQLite a cada página de 50 registros.',
        verificationStrategy:
          'Reconciliação 1:1 entre os saldos e limites do Notion e as entidades armazenadas no SQLite.',
        dependencies: [],
      },
      {
        id: 'PIPELINE_2_TRANSACTIONS',
        name: 'Backfill de Transações (Classificação Canônica e Impactos)',
        targetDataSource: {
          envKey: TARGET_CONTRACT.NOTION_DS_TRANSACTIONS.envKey,
          name: TARGET_CONTRACT.NOTION_DS_TRANSACTIONS.defaultTitle,
        },
        mode: 'IDEMPOTENT_CHECKPOINTED',
        description:
          'Popula Natureza Canônica, Mês Orçamentário (YYYY-MM), Efeito Orçamentário, Impacto Caixa, Contribuição Meta Poupança e Identity Quality.',
        readStrategy:
          'Cursor paged query filtrando registros com Natureza Canônica nula ou desatualizada.',
        transformStrategy:
          'Aplicação do pipeline de normalização: mapeamento semântico da Natureza, cálculo do mês de competência orçamentária, classificação de efeito (INCOME, EXPENSE, NEUTRAL, EQUITY_TRANSFER), impacto de caixa (IMMEDIATE, STATEMENT, NONE), e atribuição de Contribuição Meta Poupança estritamente para novas contribuições líquidas (gastos subsequentes = 0). Atribuição de Identity Quality (OFFICIAL_ID ou SYNTHETIC_FALLBACK).',
        writeStrategy:
          'PATCH idempotente em lotes controlados com throttle, salvando o último ID processado na tabela local de checkpoints.',
        verificationStrategy:
          'Soma de verificação (checksum) dos totais por natureza, contagem de registros classificados vs. pendentes, conferência de ausência de campos nulos em registros confirmados.',
        dependencies: ['PIPELINE_1_ACCOUNTS'],
      },
      {
        id: 'PIPELINE_3_MONTHLY_BUDGET',
        name: 'Backfill e Reconciliação do Planejamento Mensal',
        targetDataSource: {
          envKey: TARGET_CONTRACT.NOTION_DS_MONTHLY_BUDGET.envKey,
          name: TARGET_CONTRACT.NOTION_DS_MONTHLY_BUDGET.defaultTitle,
        },
        mode: 'IDEMPOTENT_CHECKPOINTED',
        description:
          'Agrega e totaliza Receitas Realizadas, Despesas Realizadas, Poupança Realizada e Compras Realizadas Cartão.',
        readStrategy:
          'Leitura dos registros de Planejamento Mensal existentes no Notion indexados por mês orçamentário.',
        transformStrategy:
          'Agregação a partir das transações já migradas no SQLite: sum(OPERATING_REVENUE), sum(OPERATING_EXPENSE), sum(savingsGoalContribution) e sum(card purchases).',
        writeStrategy:
          'PATCH idempotente por mês orçamentário atualizando os valores agregados arredondados em duas casas decimais.',
        verificationStrategy:
          'A soma dos valores realizados no Notion deve ser idêntica ao total apurado na agregação das transações no SQLite.',
        dependencies: ['PIPELINE_2_TRANSACTIONS'],
      },
      {
        id: 'PIPELINE_4_MONTHLY_OBLIGATIONS',
        name: 'Backfill de Obrigações Mensais e Vínculos',
        targetDataSource: {
          envKey: TARGET_CONTRACT.NOTION_DS_MONTHLY_OBLIGATIONS.envKey,
          name: TARGET_CONTRACT.NOTION_DS_MONTHLY_OBLIGATIONS.defaultTitle,
        },
        mode: 'IDEMPOTENT_CHECKPOINTED',
        description:
          'Padronização de Status para o enum homologado de 7 opções, vinculação com Conta de Pagamento e identificador externo.',
        readStrategy:
          'Leitura completa das obrigações mensais do exercício atual.',
        transformStrategy:
          'Mapeamento semântico de status: preservação de Prevista, Pendente, Paga, Atrasada, Dispensada; classificação de inconsistências como Revisão Necessária e obrigações descartadas como Cancelada. Vinculação com a conta bancária padrão configurada.',
        writeStrategy:
          'PATCH idempotente apenas nos registros cujos campos novos ou status divergirem do esperado.',
        verificationStrategy:
          'Verificação de que 100% das obrigações possuem status válido pertencente ao conjunto homologado de 7 opções.',
        dependencies: ['PIPELINE_1_ACCOUNTS'],
      },
      {
        id: 'PIPELINE_5_CARD_BILLS',
        name: 'Geração e Vinculação de Ciclos de Fatura',
        targetDataSource: {
          envKey: TARGET_CONTRACT.NOTION_DS_CARD_BILLS.envKey,
          name: TARGET_CONTRACT.NOTION_DS_CARD_BILLS.defaultTitle,
        },
        mode: 'IDEMPOTENT_CHECKPOINTED',
        description:
          'Criação das instâncias de fatura/ciclo na base criada e vinculação bidirecional com as transações da respectiva fatura.',
        readStrategy:
          'Agrupamento das transações de cartão por conta e mês de fechamento a partir da base local de transações.',
        transformStrategy:
          'Geração de identidade unívoca da fatura: identityQuality = SOURCE_ID se bill_id fornecido pela fonte, ou PERIOD_FALLBACK baseado em conta + fechamento. Totalização de valorTotal, valorMinimo e determinação de status (ABERTA, FECHADA, PAGA, ATRASADA).',
        writeStrategy:
          'POST de novos registros na base de Faturas, seguido de PATCH em lote nas transações correspondentes para vincular a dual relation Fatura / Ciclo de Cartão.',
        verificationStrategy:
          'Soma das transações associadas a cada ciclo deve bater com precisão centesimal com o valorTotal da fatura.',
        dependencies: ['PIPELINE_2_TRANSACTIONS'],
      },
    ];

    return {
      version: '1.0.0',
      totalPipelines: pipelines.length,
      pipelines,
    };
  }
}
