// =============================================================================
// CONTRACT SPECIFICATION: NOTION DATA SOURCES <-> DOMAIN ENTITIES
// =============================================================================

export type NotionPropertyType =
  | 'title'
  | 'rich_text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'date'
  | 'relation'
  | 'checkbox'
  | 'formula'
  | 'rollup'
  | 'created_time'
  | 'last_edited_time';

export type ContractDirection = 'read' | 'write' | 'both';

export type FieldAuthority =
  | 'PIERRE'            // Direct from upstream open-finance API
  | 'REGRA_AUTOMATICA'  // Assigned by deterministic classification / reconciliation engine
  | 'USUARIO'           // Human authority (edits are locked and preserved against overwrites)
  | 'DERIVADO';         // Calculated mathematically by domain logic

export interface PropertyContract {
  domainField: string;
  notionProperty: string;
  notionType: NotionPropertyType;
  direction: ContractDirection;
  authority: FieldAuthority;
  description: string;
}

export interface DataSourceContract {
  envKey: string;
  defaultTitle: string;
  isExisting: boolean; // false for 13th database (Faturas)
  properties: PropertyContract[];
}

export const TARGET_CONTRACT: Record<string, DataSourceContract> = {
  NOTION_DS_ACCOUNTS: {
    envKey: 'NOTION_DS_ACCOUNTS',
    defaultTitle: 'Contas',
    isExisting: true,
    properties: [
      { domainField: 'name', notionProperty: 'Nome da Conta', notionType: 'title', direction: 'both', authority: 'PIERRE', description: 'Nome identificador da conta' },
      { domainField: 'id', notionProperty: 'ID Pierre', notionType: 'rich_text', direction: 'both', authority: 'PIERRE', description: 'UUID da conta no Pierre Finance' },
      { domainField: 'institution', notionProperty: 'Instituição', notionType: 'select', direction: 'both', authority: 'PIERRE', description: 'Nome do banco / conector (ex: Nubank, Mercado Pago)' },
      { domainField: 'type', notionProperty: 'Tipo de Conta', notionType: 'select', direction: 'both', authority: 'PIERRE', description: 'CHECKING_ACCOUNT, CREDIT_CARD, SAVINGS' },
      { domainField: 'balance', notionProperty: 'Saldo Atual', notionType: 'number', direction: 'write', authority: 'PIERRE', description: 'Saldo disponível em reais' },
      { domainField: 'contractedCreditLimit', notionProperty: 'Limite Contratado', notionType: 'number', direction: 'write', authority: 'PIERRE', description: 'Limite total concedido pelo banco (ex: R$ 2.400)' },
      { domainField: 'customizedCreditLimit', notionProperty: 'Limite Personalizado', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Teto operacional ajustado pelo usuário no app (ex: R$ 400)' },
      { domainField: 'availableCreditLimit', notionProperty: 'Limite Disponível', notionType: 'number', direction: 'write', authority: 'PIERRE', description: 'Limite de crédito livre no momento' },
      { domainField: 'usedOperationalLimit', notionProperty: 'Limite Operacional Usado', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'customizedCreditLimit - availableCreditLimit' },
      { domainField: 'rawUsedCreditLimit', notionProperty: 'Limite Usado (Pierre Bruto)', notionType: 'number', direction: 'write', authority: 'PIERRE', description: 'Valor bruto reportado pelo Pierre para auditoria de inconsistência' },
      { domainField: 'closingDay', notionProperty: 'Dia de Fechamento', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Dia do mês do corte da fatura' },
      { domainField: 'dueDay', notionProperty: 'Dia de Vencimento', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Dia do mês do vencimento da fatura' },
      { domainField: 'includeInCash', notionProperty: 'Incluir no Caixa', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Indica se computa para liquidez imediata' },
      { domainField: 'includeInNetWorth', notionProperty: 'Incluir no Patrimônio', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Indica se computa para o patrimônio total' },
      { domainField: 'lastSyncedAt', notionProperty: 'Última Sincronização', notionType: 'date', direction: 'write', authority: 'DERIVADO', description: 'Timestamp da sincronização' },
    ],
  },

  NOTION_DS_TRANSACTIONS: {
    envKey: 'NOTION_DS_TRANSACTIONS',
    defaultTitle: 'Transações',
    isExisting: true,
    properties: [
      { domainField: 'description', notionProperty: 'Descrição', notionType: 'title', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Descrição tratada da transação' },
      { domainField: 'id', notionProperty: 'ID Pierre', notionType: 'rich_text', direction: 'both', authority: 'PIERRE', description: 'UUID unívoco da transação no Pierre' },
      { domainField: 'canonicalHash', notionProperty: 'Hash Canônico', notionType: 'rich_text', direction: 'both', authority: 'DERIVADO', description: 'Fingerprint SHA-256 (64 chars) de versão' },
      { domainField: 'date', notionProperty: 'Data', notionType: 'date', direction: 'both', authority: 'PIERRE', description: 'Data da transação (ISO-8601)' },
      { domainField: 'amount', notionProperty: 'Valor', notionType: 'number', direction: 'both', authority: 'PIERRE', description: 'Valor monetário absoluto (R$)' },
      { domainField: 'rawAmount', notionProperty: 'Valor Bruto Pierre', notionType: 'number', direction: 'write', authority: 'PIERRE', description: 'Valor exato retornado pelo Pierre com sinal original' },
      { domainField: 'flowDirection', notionProperty: 'Movimento', notionType: 'select', direction: 'both', authority: 'PIERRE', description: 'Entrada ou Saída de caixa físico' },
      { domainField: 'economicNature', notionProperty: 'Natureza Econômica', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Classificação contábil da operação' },
      { domainField: 'budgetEffect', notionProperty: 'Efeito Orçamentário', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'INCOME | EXPENSE | REVERSAL | NEUTRAL' },
      { domainField: 'allocationPurpose', notionProperty: 'Propósito de Alocação', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'INVESTMENT_RESERVE | OPERATIONAL_CASH | etc.' },
      { domainField: 'savingsGoalContribution', notionProperty: 'Contribuição Meta Poupança', notionType: 'number', direction: 'write', authority: 'REGRA_AUTOMATICA', description: 'Valor que pontua na meta de poupança (ex: R$ 500 aporte)' },
      { domainField: 'accountRelation', notionProperty: 'Conta', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Relação com base Contas' },
      { domainField: 'categoryRelation', notionProperty: 'Categoria', notionType: 'relation', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Relação com Categorias Financeiras' },
      { domainField: 'billRelation', notionProperty: 'Fatura Vinculada', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Relação com 13ª base Faturas / Ciclos' },
      { domainField: 'status', notionProperty: 'Status Banco', notionType: 'select', direction: 'write', authority: 'PIERRE', description: 'Pendente ou Confirmado' },
      { domainField: 'reviewStatus', notionProperty: 'Status de Revisão', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Confirmado Auto, Pendente Revisão, Validado Manualmente, Legado Não Verificado' },
      { domainField: 'reviewReason', notionProperty: 'Motivo da Revisão', notionType: 'rich_text', direction: 'write', authority: 'REGRA_AUTOMATICA', description: 'Justificativa para intervenção humana' },
      { domainField: 'rawCategory', notionProperty: 'Categoria Pierre', notionType: 'rich_text', direction: 'write', authority: 'PIERRE', description: 'Categoria bruta do open-finance' },
      { domainField: 'rawDescription', notionProperty: 'Descrição Original', notionType: 'rich_text', direction: 'write', authority: 'PIERRE', description: 'Texto original do extrato' },
      { domainField: 'counterpartyHmac', notionProperty: 'HMAC Contraparte', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'Hash seguro do CPF/CNPJ para matching sem expor PII' },
    ],
  },

  NOTION_DS_CATEGORIES: {
    envKey: 'NOTION_DS_CATEGORIES',
    defaultTitle: 'Categorias Financeiras',
    isExisting: true,
    properties: [
      { domainField: 'name', notionProperty: 'Nome da Categoria', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'Nome da categoria' },
      { domainField: 'macroGroup', notionProperty: 'Grupo 50/30/20', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Necessidade, Desejo, Poupança, Neutro' },
      { domainField: 'variability', notionProperty: 'Variabilidade', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Fixa, Variável, Ocasional' },
      { domainField: 'defaultNature', notionProperty: 'Natureza Padrão', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Natureza contábil sugerida' },
    ],
  },

  NOTION_DS_RULES: {
    envKey: 'NOTION_DS_RULES',
    defaultTitle: 'Regras de Classificação',
    isExisting: true,
    properties: [
      { domainField: 'name', notionProperty: 'Nome da Regra', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'Título descritivo da regra' },
      { domainField: 'priority', notionProperty: 'Prioridade', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Ordem de avaliação (1 = prioridade máxima)' },
      { domainField: 'isActive', notionProperty: 'Ativa', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Liga/desliga a regra' },
      { domainField: 'autoApply', notionProperty: 'Auto Aplicar', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Se falso, obriga envio para revisão' },
      { domainField: 'requireReview', notionProperty: 'Exigir Revisão', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Se verdadeiro, marca para checagem humana' },
      { domainField: 'matchCounterparty', notionProperty: 'Condição: Contraparte', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Substring ou nome do merchant/destinatário' },
      { domainField: 'matchDescription', notionProperty: 'Condição: Descrição', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Substring ou regex na descrição' },
      { domainField: 'matchDirection', notionProperty: 'Condição: Movimento', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Qualquer, Entrada, Saída' },
      { domainField: 'matchAccountRelation', notionProperty: 'Condição: Conta', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Conta de origem específica' },
      { domainField: 'matchRawCategory', notionProperty: 'Condição: Categoria Pierre', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Categoria original Pierre' },
      { domainField: 'matchExactAmount', notionProperty: 'Condição: Valor Exato', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Valor monetário exato' },
      { domainField: 'matchAmountTolerance', notionProperty: 'Condição: Tolerância Valor', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Tolerância aceitável em reais' },
      { domainField: 'matchMinAmount', notionProperty: 'Condição: Valor Mínimo', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Piso do valor' },
      { domainField: 'matchMaxAmount', notionProperty: 'Condição: Valor Máximo', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Teto do valor' },
      { domainField: 'matchMinDay', notionProperty: 'Condição: Dia Mês Início', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Dia inicial do mês (1 a 31)' },
      { domainField: 'matchMaxDay', notionProperty: 'Condição: Dia Mês Fim', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Dia final do mês (1 a 31)' },
      { domainField: 'validityPeriod', notionProperty: 'Período de Validade', notionType: 'date', direction: 'both', authority: 'USUARIO', description: 'Vigência temporal da regra' },
      { domainField: 'assignNature', notionProperty: 'Atribuir: Natureza', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Natureza atribuída' },
      { domainField: 'assignBudgetEffect', notionProperty: 'Atribuir: Efeito Orçamento', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'INCOME, EXPENSE, REVERSAL, NEUTRAL' },
      { domainField: 'assignAllocationPurpose', notionProperty: 'Atribuir: Alocação', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Finalidade da movimentação' },
      { domainField: 'assignCategory', notionProperty: 'Atribuir: Categoria', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Categoria vinculada' },
    ],
  },

  NOTION_DS_FIXED_BILLS: {
    envKey: 'NOTION_DS_FIXED_BILLS',
    defaultTitle: 'Contas Fixas',
    isExisting: true,
    properties: [
      { domainField: 'name', notionProperty: 'Nome da Conta Fixa', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'Nome do compromisso recorrente' },
      { domainField: 'expectedAmount', notionProperty: 'Valor Previsto', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Valor esperado por competência' },
      { domainField: 'toleranceAmount', notionProperty: 'Tolerância (R$)', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Tolerância para conciliação automática' },
      { domainField: 'periodicity', notionProperty: 'Periodicidade', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Mensal, Bimestral, Trimestral, Semestral, Anual' },
      { domainField: 'anchorCompetence', notionProperty: 'Competência Âncora', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Mês de referência inicial (ex: 2026-01)' },
      { domainField: 'lastGeneratedCompetence', notionProperty: 'Última Competência Gerada', notionType: 'rich_text', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Último mês gerado em Obrigações (ex: 2026-08)' },
      { domainField: 'dueDay', notionProperty: 'Dia de Vencimento', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Dia do mês do vencimento (1 a 31)' },
      { domainField: 'paymentMethod', notionProperty: 'Forma de Pagamento', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Cartão de Crédito, Débito em Conta, Pix, Boleto' },
      { domainField: 'defaultAccount', notionProperty: 'Conta Padrão', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Conta de débito usual' },
      { domainField: 'category', notionProperty: 'Categoria', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Categoria orçamentária' },
      { domainField: 'matchPattern', notionProperty: 'Padrão de Identificação', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Expressão / substring para conciliação automática' },
      { domainField: 'isActive', notionProperty: 'Ativa', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Gera obrigações no período' },
      { domainField: 'notes', notionProperty: 'Observações / Contrato', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Código do assinante, detalhes do contrato ou instruções' },
      { domainField: 'validFrom', notionProperty: 'Data de Início', notionType: 'date', direction: 'both', authority: 'USUARIO', description: 'Início da vigência do contrato' },
      { domainField: 'validUntil', notionProperty: 'Data de Término', notionType: 'date', direction: 'both', authority: 'USUARIO', description: 'Término da vigência do contrato' },
    ],
  },

  NOTION_DS_MONTHLY_OBLIGATIONS: {
    envKey: 'NOTION_DS_MONTHLY_OBLIGATIONS',
    defaultTitle: 'Obrigações Mensais',
    isExisting: true,
    properties: [
      { domainField: 'title', notionProperty: 'Identificador', notionType: 'title', direction: 'both', authority: 'DERIVADO', description: 'Nome da Conta Fixa - YYYY-MM' },
      { domainField: 'fixedBillRelation', notionProperty: 'Conta Fixa', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Relação com o cadastro permanente' },
      { domainField: 'competencePeriod', notionProperty: 'Competência', notionType: 'rich_text', direction: 'both', authority: 'DERIVADO', description: 'Mês de referência (YYYY-MM)' },
      { domainField: 'dueDate', notionProperty: 'Data de Vencimento', notionType: 'date', direction: 'both', authority: 'DERIVADO', description: 'Data exata do vencimento' },
      { domainField: 'expectedAmount', notionProperty: 'Valor Previsto', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Valor esperado herdado da conta fixa' },
      { domainField: 'status', notionProperty: 'Status', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Prevista, Paga, Atrasada, Revisão Necessária, Cancelada' },
      { domainField: 'paidAmount', notionProperty: 'Valor Pago', notionType: 'number', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Valor efetivamente liquidado' },
      { domainField: 'paidAt', notionProperty: 'Data do Pagamento', notionType: 'date', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Data em que ocorreu a quitação' },
      { domainField: 'matchedTransaction', notionProperty: 'Transação Vinculada', notionType: 'relation', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Relação com a transação que liquidou' },
      { domainField: 'autoValidated', notionProperty: 'Validado Automaticamente', notionType: 'checkbox', direction: 'write', authority: 'REGRA_AUTOMATICA', description: 'True se correspondência foi inequívoca' },
      { domainField: 'notes', notionProperty: 'Observações / Conflitos', notionType: 'rich_text', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Avisos de divergência ou ambiguidade' },
    ],
  },

  NOTION_DS_INVESTMENTS: {
    envKey: 'NOTION_DS_INVESTMENTS',
    defaultTitle: 'Investimentos',
    isExisting: true,
    properties: [
      { domainField: 'assetName', notionProperty: 'Ativo', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'Nome do ativo ou produto financeiro' },
      { domainField: 'assetType', notionProperty: 'Classe do Ativo', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Renda Fixa, Cripto, Ação, FII, ETF, Previdência Privada, Tesouro Direto (Caixa Reservado NÃO é classe de ativo)' },
      { domainField: 'origin', notionProperty: 'Custódia', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Conta Pierre ou Carteira Externa' },
      { domainField: 'quantity', notionProperty: 'Quantidade', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Posição atual custodiada' },
      { domainField: 'costBasis', notionProperty: 'Custo de Aquisição (PMP)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Custo acumulado pelo Preço Médio Ponderado das compras' },
      { domainField: 'currentMarketValue', notionProperty: 'Valor de Mercado Atual', notionType: 'number', direction: 'both', authority: 'PIERRE', description: 'Cotação atual x quantidade' },
      { domainField: 'profitLoss', notionProperty: 'Lucro / Prejuízo', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Valor de mercado - Custo de aquisição' },
      { domainField: 'linkedAccount', notionProperty: 'Conta Vinculada', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Conta corrente ou corretora associada' },
    ],
  },

  NOTION_DS_INVESTMENT_MOVEMENTS: {
    envKey: 'NOTION_DS_INVESTMENT_MOVEMENTS',
    defaultTitle: 'Movimentações de Investimentos',
    isExisting: true,
    properties: [
      { domainField: 'title', notionProperty: 'Identificador', notionType: 'title', direction: 'write', authority: 'DERIVADO', description: 'Tipo - Ativo - Data' },
      { domainField: 'investmentRelation', notionProperty: 'Ativo Vinculado', notionType: 'relation', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Relação com a posição do ativo' },
      { domainField: 'movementType', notionProperty: 'Tipo de Movimentação', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Aporte de Capital, Resgate de Capital, Compra de Ativo, Venda de Ativo, Rendimento / Provento, Taxas e Impostos, Ajuste de Posição' },
      { domainField: 'date', notionProperty: 'Data da Operação', notionType: 'date', direction: 'both', authority: 'PIERRE', description: 'Data da execução' },
      { domainField: 'grossAmount', notionProperty: 'Valor Bruto', notionType: 'number', direction: 'both', authority: 'PIERRE', description: 'Volume financeiro total' },
      { domainField: 'netAmount', notionProperty: 'Valor Líquido', notionType: 'number', direction: 'both', authority: 'PIERRE', description: 'Valor líquido após custos' },
      { domainField: 'quantity', notionProperty: 'Quantidade Negociada', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Fração ou unidades transacionadas' },
      { domainField: 'unitPrice', notionProperty: 'Preço Unitário', notionType: 'number', direction: 'both', authority: 'DERIVADO', description: 'Preço médio da ordem' },
      { domainField: 'sourceAccount', notionProperty: 'Conta Origem', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Conta debitada' },
      { domainField: 'destinationAccount', notionProperty: 'Conta Destino / Caixa', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Conta creditada' },
      { domainField: 'relatedTransaction', notionProperty: 'Transação Financeira', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Transação bancária vinculada' },
    ],
  },

  NOTION_DS_MONTHLY_BUDGET: {
    envKey: 'NOTION_DS_MONTHLY_BUDGET',
    defaultTitle: 'Planejamento Mensal',
    isExisting: true,
    properties: [
      { domainField: 'competence', notionProperty: 'Competência', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'YYYY-MM' },
      { domainField: 'netIncomePlanned', notionProperty: 'Renda Prevista', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Meta de renda do mês' },
      { domainField: 'cardSpendBudget', notionProperty: 'Teto Mensal Cartão', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Teto pessoal de compras no cartão (ex: R$ 400)' },
      { domainField: 'savingsGoalPlanned', notionProperty: 'Meta de Poupança/Aporte', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Meta de dinheiro a poupar no mês' },
      { domainField: 'realizedIncome', notionProperty: 'Receitas Realizadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma de transações OPERATING_REVENUE' },
      { domainField: 'realizedExpenses', notionProperty: 'Despesas Realizadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma de transações OPERATING_EXPENSE' },
      { domainField: 'realizedSavings', notionProperty: 'Poupança Realizada', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma de transações com savingsGoalContribution' },
      { domainField: 'cardSpendRealized', notionProperty: 'Compras Realizadas Cartão', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma de compras de cartão no mês' },
    ],
  },

  NOTION_DS_FINANCIAL_GOALS: {
    envKey: 'NOTION_DS_FINANCIAL_GOALS',
    defaultTitle: 'Metas Financeiras',
    isExisting: true,
    properties: [
      { domainField: 'name', notionProperty: 'Meta', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'Nome do objetivo financeiro' },
      { domainField: 'targetAmount', notionProperty: 'Valor Alvo', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Montante financeiro desejado' },
      { domainField: 'currentAmount', notionProperty: 'Valor Atual Acumulado', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Saldo alocado para a meta' },
      { domainField: 'deadline', notionProperty: 'Prazo Alvo', notionType: 'date', direction: 'both', authority: 'USUARIO', description: 'Data limite para cumprimento' },
    ],
  },

  NOTION_DS_MONTHLY_CLOSINGS: {
    envKey: 'NOTION_DS_MONTHLY_CLOSINGS',
    defaultTitle: 'Fechamentos Mensais',
    isExisting: true,
    properties: [
      { domainField: 'title', notionProperty: 'Mês de Referência', notionType: 'title', direction: 'both', authority: 'DERIVADO', description: 'Fechamento YYYY-MM' },
      { domainField: 'status', notionProperty: 'Status do Fechamento', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Aberto, Pré-fechado, Fechado Auditado' },
      { domainField: 'initialNetWorth', notionProperty: 'Patrimônio Inicial', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Patrimônio líquido consolidado no início do mês' },
      { domainField: 'totalIncome', notionProperty: 'Renda Consolidada', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Total de receitas operacionais líquidas' },
      { domainField: 'totalExpenses', notionProperty: 'Despesas Consolidadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Total de despesas correntes de subsistência' },
      { domainField: 'essentialExpenses', notionProperty: 'Despesas Essenciais (Necessidades)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Gastos essenciais de moradia, saúde, alimentação, etc. (Regra 50%)' },
      { domainField: 'discretionaryExpenses', notionProperty: 'Despesas Discricionárias (Desejos)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Gastos de estilo de vida, lazer, compras pessoais (Regra 30%)' },
      { domainField: 'savingsAmount', notionProperty: 'Total Poupado / Aportado', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Renda - Despesas (Regra 20%)' },
      { domainField: 'savingsRate', notionProperty: 'Taxa de Poupança (%)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: '(Total Poupado / Renda) * 100' },
      { domainField: 'investmentYield', notionProperty: 'Rendimentos de Investimentos', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Rendimentos e dividendos auferidos no mês' },
      { domainField: 'finalNetWorth', notionProperty: 'Patrimônio Líquido Final', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Saldo contas + investimentos - dívidas ao fechar o mês' },
      { domainField: 'netWorthChange', notionProperty: 'Variação Patrimonial', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Patrimônio Final - Patrimônio Inicial' },
      { domainField: 'notes', notionProperty: 'Observações / Notas do Fechamento', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Comentários qualitativos sobre desvios e conquistas do mês' },
    ],
  },

  NOTION_DS_SYNC_LOG: {
    envKey: 'NOTION_DS_SYNC_LOG',
    defaultTitle: 'Log de Sincronização',
    isExisting: true,
    properties: [
      { domainField: 'title', notionProperty: 'Execução', notionType: 'title', direction: 'write', authority: 'DERIVADO', description: 'Sync - YYYY-MM-DD HH:mm:ss' },
      { domainField: 'status', notionProperty: 'Status', notionType: 'select', direction: 'write', authority: 'DERIVADO', description: 'Sucesso, Sucesso Parcial, Erro, Bloqueado por Concorrência' },
      { domainField: 'startedAt', notionProperty: 'Data Início', notionType: 'date', direction: 'write', authority: 'DERIVADO', description: 'Timestamp do início da sincronização' },
      { domainField: 'endedAt', notionProperty: 'Data Fim', notionType: 'date', direction: 'write', authority: 'DERIVADO', description: 'Timestamp do término da sincronização' },
      { domainField: 'durationSeconds', notionProperty: 'Duração (s)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Tempo total de processamento em segundos' },
      { domainField: 'accountsSynced', notionProperty: 'Contas Processadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Quantidade de contas sincronizadas' },
      { domainField: 'transactionsReceived', notionProperty: 'Transações Recebidas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Lançamentos retornados pelo Pierre' },
      { domainField: 'transactionsCreated', notionProperty: 'Transações Novas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Novas páginas criadas' },
      { domainField: 'transactionsUpdated', notionProperty: 'Transações Atualizadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Páginas existentes com versionHash alterado' },
      { domainField: 'transactionsUnchanged', notionProperty: 'Transações Inalteradas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Transações sem alteração ignoradas' },
      { domainField: 'installmentsReceived', notionProperty: 'Parcelas Recebidas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Parcelamentos e faturas futuras identificadas' },
      { domainField: 'reviewQueueCount', notionProperty: 'Enviadas para Revisão', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Transações marcadas como Pendente Revisão' },
      { domainField: 'obligationsReconciled', notionProperty: 'Obrigações Conciliadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Compromissos mensais liquidados com sucesso' },
      { domainField: 'sourceFreshness', notionProperty: 'Freshness da Fonte', notionType: 'date', direction: 'write', authority: 'DERIVADO', description: 'Momento do último dado retornado pelo banco / open finance' },
      { domainField: 'workerCommit', notionProperty: 'Versão do Worker / Commit', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'Commit SHA ou tag da versão do worker em execução' },
      { domainField: 'rawBatchHash', notionProperty: 'Hash do Lote RAW', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'SHA-256 do payload bruto salvo no cofre cifrado' },
      { domainField: 'errorMessage', notionProperty: 'Detalhes do Erro', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'Stack trace ou mensagem de falha' },
    ],
  },

  // ===========================================================================
  // 13ª BASE: PROPOSTA DE SCHEMA PARA CRIAÇÃO EXTERNA PELO USUÁRIO NO NOTION
  // (Esta base NÃO existe atualmente; o introspector NUNCA tenta consultá-la)
  // ===========================================================================
  NOTION_DS_CARD_BILLS: {
    envKey: 'NOTION_DS_CARD_BILLS',
    defaultTitle: 'Faturas / Ciclos de Cartão',
    isExisting: false,
    properties: [
      { domainField: 'title', notionProperty: 'Fatura / Ciclo', notionType: 'title', direction: 'write', authority: 'DERIVADO', description: 'Ex: Fatura Nubank - Venc 22/07/2026' },
      { domainField: 'accountRelation', notionProperty: 'Cartão Vinculado', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Relação com a conta do cartão em Contas' },
      { domainField: 'cycleType', notionProperty: 'Tipo de Ciclo', notionType: 'select', direction: 'write', authority: 'DERIVADO', description: 'Ciclo Real Banco, Ciclo Configurado, Ciclo Estimado' },
      { domainField: 'status', notionProperty: 'Status da Fatura', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Aberta em Curso, Fechada a Vencer, Vencida, Paga Integralmente, Paga Parcialmente' },
      { domainField: 'closingDate', notionProperty: 'Data de Fechamento', notionType: 'date', direction: 'write', authority: 'PIERRE', description: 'Data de corte (balance_close_date ou configurada)' },
      { domainField: 'dueDate', notionProperty: 'Data de Vencimento', notionType: 'date', direction: 'write', authority: 'PIERRE', description: 'Data de vencimento (balance_due_date)' },
      { domainField: 'rawBillAmount', notionProperty: 'Valor da Fatura (Banco)', notionType: 'number', direction: 'write', authority: 'PIERRE', description: 'Valor total consolidado emitido pela instituição' },
      { domainField: 'purchasesTotal', notionProperty: 'Total de Compras no Ciclo', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma real das transações de compra dentro do ciclo corrente' },
      { domainField: 'additionalComponentsAmount', notionProperty: 'Componentes Adicionais da Fatura', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Diferença entre fatura emitida e compras correntes (parcelas anteriores, encargos, IOF, juros, créditos/estornos)' },
      { domainField: 'unexplainedDiscrepancy', notionProperty: 'Divergência Não Explicada', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Discrepância residual caso os componentes adicionais conhecidos não expliquem a diferença' },
      { domainField: 'paidAmount', notionProperty: 'Valor Pago', notionType: 'number', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Valor total liquidado até o momento' },
      { domainField: 'paidAt', notionProperty: 'Data de Liquidação', notionType: 'date', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Data do pagamento da fatura' },
      { domainField: 'transactionsRelation', notionProperty: 'Lançamentos do Ciclo', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Relação bidirecional com as transações de compra deste ciclo' },
      { domainField: 'paymentTransactions', notionProperty: 'Transações de Pagamento', notionType: 'relation', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Relações com as transações bancárias de saída que quitaram ou amortizaram a fatura (suporta múltiplos pagamentos)' },
    ],
  },
};


