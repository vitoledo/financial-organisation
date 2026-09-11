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
        name: 'Backfill de Transações (Classificação Canônica e Efeitos Orçamentários)',
        targetDataSource: {
          envKey: TARGET_CONTRACT.NOTION_DS_TRANSACTIONS.envKey,
          name: TARGET_CONTRACT.NOTION_DS_TRANSACTIONS.defaultTitle,
        },
        mode: 'IDEMPOTENT_CHECKPOINTED',
        description:
          'Popula Natureza Econômica, Efeito Orçamentário (INCOME | EXPENSE | REVERSAL | NEUTRAL), Propósito de Alocação e Contribuição Meta Poupança.',
        readStrategy:
          'Cursor paged query filtrando transações com Natureza Econômica nula ou não classificada.',
        transformStrategy:
          'Aplicação das regras de classificação: mapeamento para Natureza Econômica (Receita, Despesa, Aporte, Resgate, Transferência interna, Reembolso, Pagamento de fatura, Ajuste), definição do Efeito Orçamentário estritamente entre INCOME, EXPENSE, REVERSAL ou NEUTRAL, definição de Propósito de Alocação (Caixa Operacional, Reserva de Investimento, Reserva de Emergência, Poupança Geral) e atribuição de Contribuição Meta Poupança exclusivamente quando houver aporte novo à poupança (despesas subsequentes com recursos poupados = 0).',
        writeStrategy:
          'PATCH idempotente em lotes controlados com throttle, salvando o último ID processado na tabela local de checkpoints.',
        verificationStrategy:
          'Soma de verificação (checksum) dos totais por natureza, contagem de transações classificadas vs. pendentes, conferência de ausência de campos nulos em registros confirmados.',
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
          'Agrega e totaliza Receitas Realizadas, Despesas Realizadas, Poupança Realizada (via Contribuição Meta Poupança) e Compras Realizadas Cartão.',
        readStrategy:
          'Leitura dos registros de Planejamento Mensal existentes no Notion indexados pelo mês de referência.',
        transformStrategy:
          'Agregação a partir das transações migradas no SQLite: soma de transações com Efeito Orçamentário INCOME (Receitas Realizadas), soma com EXPENSE (Despesas Realizadas), soma estrita de savingsGoalContribution (Poupança Realizada), e soma de transações de contas de crédito no período.',
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
          'Padronização do Status (select) para o conjunto homologado de 7 opções, vinculação com Conta de Pagamento e identificador externo.',
        readStrategy:
          'Leitura completa das obrigações mensais do exercício atual.',
        transformStrategy:
          'Mapeamento de status: preservação de Prevista, Pendente, Paga, Atrasada, Dispensada; classificação de inconsistências como Revisão Necessária e obrigações descartadas como Cancelada. Vinculação com a conta bancária padrão configurada.',
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
          'Criação das instâncias de Fatura / Ciclo na 13ª base e vinculação dual com Transações via Lançamentos do Ciclo <-> Fatura Vinculada.',
        readStrategy:
          'Agrupamento das transações de cartão por conta e intervalo de datas de corte a partir da base local.',
        transformStrategy:
          'Determinação de identidade da fatura: se bill_id da fonte disponível, Qualidade da Identidade = SOURCE_ID; caso contrário, Qualidade da Identidade = PERIOD_FALLBACK com formato exato source:account:periodStart:periodEnd:currency. Atribuição de Status da Fatura estritamente conforme enums homologados (Aberta em Curso, Fechada a Vencer, Vencida, Paga Integralmente, Paga Parcialmente). Totalização de Valor da Fatura Fechada (Oficial) ou Valor Estimado da Fatura Aberta e Total de Compras no Ciclo.',
        writeStrategy:
          'POST de novos registros na base Faturas / Ciclos de Cartão, seguido de PATCH nas transações correspondentes para vincular a dual relation Fatura Vinculada.',
        verificationStrategy:
          'Soma das transações associadas a cada ciclo deve bater com precisão centesimal com o total de compras apurado no ciclo.',
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
