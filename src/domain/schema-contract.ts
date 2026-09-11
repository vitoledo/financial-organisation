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
  aliases?: string[];
  /**
   * Expected options for 'select' or 'multi_select' (or 'status') properties in Notion.
   * Can be declared using user-facing Portuguese labels or English enum values.
   */
  expectedOptions?: string[];
  /**
   * Explicit mapping between Notion display labels (e.g. Portuguese) and internal domain enum values (English).
   * Key = Notion display option name (e.g. "Entrada"), Value = Domain enum value (e.g. "INFLOW").
   */
  optionMappings?: Record<string, string>;
  /**
   * Expected target Data Source env key for 'relation' properties (e.g. 'NOTION_DS_ACCOUNTS').
   */
  relationTargetEnvKey?: string;
  /**
   * When true, relation is expected to be bidirectional (dual_property).
   */
  isBidirectionalRelation?: boolean;
  /**
   * Expected synced property name in the target data source when relation is bidirectional.
   */
  syncedPropertyName?: string;
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
      { domainField: 'name', notionProperty: 'Nome da Conta', notionType: 'title', direction: 'both', authority: 'PIERRE', description: 'Nome identificador da conta', aliases: ['Nome', 'Conta', 'Nome Conta', 'Nome da conta'] },
      { domainField: 'source', notionProperty: 'Fonte', notionType: 'select', direction: 'both', authority: 'PIERRE', description: 'Sistema ou conector de origem (ex: PIERRE, MANUAL)', aliases: ['Origem', 'Conector', 'Sistema Origem', 'Fonte'], expectedOptions: ['PIERRE', 'MANUAL', 'MIGRATION'] },
      { domainField: 'sourceAccountId', notionProperty: 'ID da Fonte', notionType: 'rich_text', direction: 'both', authority: 'PIERRE', description: 'Identificador unívoco da conta no sistema de origem', aliases: ['ID da fonte', 'ID da Fonte', 'ID Pierre', 'ID', 'UUID', 'Pierre ID', 'Source ID', 'ID Conta'] },
      { domainField: 'currency', notionProperty: 'Moeda', notionType: 'select', direction: 'both', authority: 'PIERRE', description: 'Código da moeda da conta (ex: BRL, USD)', aliases: ['Moeda da Conta', 'Currency', 'Divisa', 'Moeda'], expectedOptions: ['BRL', 'USD', 'EUR'] },
      { domainField: 'institution', notionProperty: 'Instituição', notionType: 'select', direction: 'both', authority: 'PIERRE', description: 'Nome do banco / conector (ex: Nubank, Mercado Pago)', aliases: ['Banco', 'Instituicao', 'Instituição'], expectedOptions: ['Nubank', 'Mercado Pago', 'Itaú', 'Bradesco', 'Santander', 'Inter', 'BTG Pactual', 'XP', 'Outro'] },
      { domainField: 'type', notionProperty: 'Tipo de Conta', notionType: 'select', direction: 'both', authority: 'PIERRE', description: 'CHECKING_ACCOUNT, CREDIT_CARD, SAVINGS', aliases: ['Tipo', 'Tipo Conta', 'Tipo de Conta', 'Tipo de conta'], expectedOptions: ['Conta Corrente', 'Cartão de Crédito', 'Conta Poupança', 'Conta de Investimento', 'Carteira Dinheiro'], optionMappings: { 'Conta Corrente': 'CHECKING_ACCOUNT', 'Cartão de Crédito': 'CREDIT_CARD', 'Conta Poupança': 'SAVINGS_ACCOUNT', 'Conta de Investimento': 'INVESTMENT_ACCOUNT', 'Carteira Dinheiro': 'CASH_WALLET' } },
      { domainField: 'balance', notionProperty: 'Saldo Atual', notionType: 'number', direction: 'write', authority: 'PIERRE', description: 'Saldo disponível em reais', aliases: ['Saldo', 'Saldo em Conta', 'Saldo Atual', 'Saldo atual'] },
      { domainField: 'contractedCreditLimit', notionProperty: 'Limite Contratado', notionType: 'number', direction: 'write', authority: 'PIERRE', description: 'Limite total concedido pelo banco (ex: R$ 2.400)', aliases: ['Limite', 'Limite Total', 'Limite Contratado'] },
      { domainField: 'customizedCreditLimit', notionProperty: 'Limite Personalizado', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Teto operacional ajustado pelo usuário no app (ex: R$ 400)', aliases: ['Teto Operacional', 'Limite Definido', 'Limite Personalizado'] },
      { domainField: 'availableCreditLimit', notionProperty: 'Limite Disponível', notionType: 'number', direction: 'write', authority: 'PIERRE', description: 'Limite de crédito livre no momento', aliases: ['Disponível', 'Limite Livre', 'Limite Disponível'] },
      { domainField: 'usedOperationalLimit', notionProperty: 'Limite Operacional Usado', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'customizedCreditLimit - availableCreditLimit', aliases: ['Limite Usado', 'Limite Operacional Usado'] },
      { domainField: 'rawUsedCreditLimit', notionProperty: 'Limite Usado (Pierre Bruto)', notionType: 'number', direction: 'write', authority: 'PIERRE', description: 'Valor bruto reportado pelo Pierre para auditoria de inconsistência', aliases: ['Limite Bruto Pierre', 'Limite Usado (Pierre Bruto)'] },
      { domainField: 'closingDay', notionProperty: 'Dia de Fechamento', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Dia do mês do corte da fatura', aliases: ['Dia Fechamento', 'Fechamento', 'Dia de Fechamento'] },
      { domainField: 'dueDay', notionProperty: 'Dia de Vencimento', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Dia do mês do vencimento da fatura', aliases: ['Dia Vencimento', 'Vencimento', 'Dia de Vencimento'] },
      { domainField: 'includeInCash', notionProperty: 'Incluir no Caixa', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Indica se computa para liquidez imediata', aliases: ['Caixa', 'Compor Caixa', 'Incluir no Caixa'] },
      { domainField: 'includeInNetWorth', notionProperty: 'Incluir no Patrimônio', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Indica se computa para o patrimônio total', aliases: ['Patrimônio', 'Compor Patrimônio', 'Incluir no Patrimônio'] },
      { domainField: 'lastSyncedAt', notionProperty: 'Última Sincronização', notionType: 'date', direction: 'write', authority: 'DERIVADO', description: 'Timestamp da sincronização', aliases: ['Atualizado em', 'Atualizado Em', 'Último Sync', 'Data Sync', 'Última Sincronização', 'Atualizado'] },
    ],
  },

  NOTION_DS_TRANSACTIONS: {
    envKey: 'NOTION_DS_TRANSACTIONS',
    defaultTitle: 'Transações',
    isExisting: true,
    properties: [
      { domainField: 'description', notionProperty: 'Descrição', notionType: 'title', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Descrição tratada da transação', aliases: ['Lançamento', 'Lancamento', 'Descricao', 'Descrição', 'Nome', 'Título', 'Titulo'] },
      { domainField: 'source', notionProperty: 'Fonte', notionType: 'select', direction: 'both', authority: 'PIERRE', description: 'Sistema ou conector de origem (ex: PIERRE, MANUAL)', aliases: ['Origem', 'Conector', 'Sistema', 'Fonte'], expectedOptions: ['PIERRE', 'MANUAL', 'MIGRATION'] },
      { domainField: 'sourceTransactionId', notionProperty: 'ID da Fonte', notionType: 'rich_text', direction: 'both', authority: 'PIERRE', description: 'Identificador unívoco da transação no sistema de origem', aliases: ['ID da fonte', 'ID da Fonte', 'ID Pierre', 'ID', 'UUID', 'Pierre ID', 'Source ID', 'ID Transação'] },
      { domainField: 'currency', notionProperty: 'Moeda', notionType: 'select', direction: 'both', authority: 'PIERRE', description: 'Código da moeda da transação (ex: BRL, USD)', aliases: ['Moeda da Transação', 'Currency', 'Moeda'], expectedOptions: ['BRL', 'USD', 'EUR'] },
      { domainField: 'canonicalHash', notionProperty: 'Hash Canônico', notionType: 'rich_text', direction: 'both', authority: 'DERIVADO', description: 'Fingerprint SHA-256 (64 chars) de versão', aliases: ['Hash', 'Fingerprint', 'Version Hash', 'Hash Canônico'] },
      { domainField: 'date', notionProperty: 'Data', notionType: 'date', direction: 'both', authority: 'PIERRE', description: 'Data da transação (ISO-8601)', aliases: ['Data Transacao', 'Data da Operação', 'Data Operação', 'Data'] },
      { domainField: 'amount', notionProperty: 'Valor', notionType: 'number', direction: 'both', authority: 'PIERRE', description: 'Valor monetário absoluto (R$)', aliases: ['Valor Transação', 'Valor Liquido', 'Total', 'Quantia', 'Valor'] },
      { domainField: 'rawAmount', notionProperty: 'Valor Bruto Pierre', notionType: 'number', direction: 'write', authority: 'PIERRE', description: 'Valor exato retornado pelo Pierre com sinal original', aliases: ['Valor Original', 'Valor Bruto', 'Valor Bruto Pierre'] },
      { domainField: 'flowDirection', notionProperty: 'Movimento', notionType: 'select', direction: 'both', authority: 'PIERRE', description: 'Entrada ou Saída de caixa físico', aliases: ['Tipo', 'Direção', 'Direcao', 'Sentido', 'Fluxo', 'Movimento'], expectedOptions: ['Entrada', 'Saída'], optionMappings: { 'Entrada': 'INFLOW', 'Saída': 'OUTFLOW' } },
      { domainField: 'economicNature', notionProperty: 'Natureza Econômica', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Classificação contábil da operação', aliases: ['Natureza', 'Classificação Contábil', 'Classificacao', 'Natureza Econômica'], expectedOptions: ['Receita Operacional', 'Despesa Operacional', 'Transferência Interna', 'Aporte de Capital', 'Resgate de Capital', 'Compra de Ativo', 'Venda de Ativo', 'Rendimento / Provento', 'Amortização de Dívida', 'Juros / Encargos de Dívida', 'Pagamento de Fatura', 'Reembolso / Estorno', 'Ajuste Contábil'], optionMappings: { 'Receita Operacional': 'OPERATING_REVENUE', 'Despesa Operacional': 'OPERATING_EXPENSE', 'Transferência Interna': 'INTERNAL_TRANSFER', 'Aporte de Capital': 'CAPITAL_CONTRIBUTION', 'Resgate de Capital': 'CAPITAL_WITHDRAWAL', 'Compra de Ativo': 'ASSET_PURCHASE', 'Venda de Ativo': 'ASSET_SALE', 'Rendimento / Provento': 'YIELD_DIVIDEND', 'Amortização de Dívida': 'DEBT_PRINCIPAL_AMORTIZATION', 'Juros / Encargos de Dívida': 'DEBT_INTEREST_CHARGES', 'Pagamento de Fatura': 'CREDIT_CARD_SETTLEMENT', 'Reembolso / Estorno': 'REIMBURSEMENT', 'Ajuste Contábil': 'ACCOUNTING_ADJUSTMENT' } },
      { domainField: 'budgetEffect', notionProperty: 'Efeito Orçamentário', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'INCOME | EXPENSE | REVERSAL | NEUTRAL', aliases: ['Efeito Orçamento', 'Impacto Orçamentário', 'Impacto Orcamentario', 'Efeito Orçamentário'], expectedOptions: ['Receita', 'Despesa', 'Estorno', 'Neutro'], optionMappings: { 'Receita': 'INCOME', 'Despesa': 'EXPENSE', 'Estorno': 'REVERSAL', 'Neutro': 'NEUTRAL' } },
      { domainField: 'allocationPurpose', notionProperty: 'Propósito de Alocação', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'INVESTMENT_RESERVE | OPERATIONAL_CASH | etc.', aliases: ['Propósito', 'Proposito', 'Finalidade', 'Alocação', 'Alocacao', 'Propósito de Alocação'], expectedOptions: ['Caixa Operacional', 'Reserva de Investimento', 'Reserva de Emergência', 'Poupança Geral'], optionMappings: { 'Caixa Operacional': 'OPERATIONAL_CASH', 'Reserva de Investimento': 'INVESTMENT_RESERVE', 'Reserva de Emergência': 'EMERGENCY_FUND', 'Poupança Geral': 'GENERAL_SAVINGS' } },
      { domainField: 'savingsGoalContribution', notionProperty: 'Contribuição Meta Poupança', notionType: 'number', direction: 'write', authority: 'REGRA_AUTOMATICA', description: 'Valor que pontua na meta de poupança (ex: R$ 500 aporte)', aliases: ['Poupança', 'Aporte Poupança', 'Contribuicao Poupanca', 'Contribuição Meta Poupança'] },
      { domainField: 'accountRelation', notionProperty: 'Conta', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Relação com base Contas', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Conta Bancária', 'Conta Origem', 'Conta'] },
      { domainField: 'categoryRelation', notionProperty: 'Categoria', notionType: 'relation', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Relação com Categorias Financeiras', relationTargetEnvKey: 'NOTION_DS_CATEGORIES', aliases: ['Categoria Financeira', 'Categoria'] },
      { domainField: 'billRelation', notionProperty: 'Fatura Vinculada', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Relação com 13ª base Faturas / Ciclos', relationTargetEnvKey: 'NOTION_DS_CARD_BILLS', aliases: ['Fatura', 'Ciclo Fatura', 'Fatura Vinculada'] },
      { domainField: 'status', notionProperty: 'Status Banco', notionType: 'select', direction: 'write', authority: 'PIERRE', description: 'Pendente ou Confirmado', aliases: ['Status', 'Status Transação', 'Status Banco'], expectedOptions: ['Pendente', 'Confirmado', 'Liquidado', 'Cancelado', 'Estornado'], optionMappings: { 'Pendente': 'PENDING', 'Confirmado': 'CONFIRMED', 'Liquidado': 'POSTED', 'Cancelado': 'CANCELLED', 'Estornado': 'VOIDED' } },
      { domainField: 'reviewStatus', notionProperty: 'Status de Revisão', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Confirmado Auto, Pendente Revisão, Validado Manualmente, Legado Não Verificado', aliases: ['Revisão', 'Status Revisão', 'Revisao', 'Status de Revisão'], expectedOptions: ['Confirmado Auto', 'Provável', 'Pendente Revisão', 'Validado Manual', 'Legado Não Verificado'], optionMappings: { 'Confirmado Auto': 'AUTO_CONFIRMED', 'Provável': 'PROBABLE', 'Pendente Revisão': 'NEEDS_REVIEW', 'Validado Manual': 'MANUALLY_CONFIRMED', 'Legado Não Verificado': 'LEGACY_UNVERIFIED' } },
      { domainField: 'reviewReason', notionProperty: 'Motivo da Revisão', notionType: 'rich_text', direction: 'write', authority: 'REGRA_AUTOMATICA', description: 'Justificativa para intervenção humana', aliases: ['Motivo Revisão', 'Razão Revisão', 'Justificativa', 'Motivo da Revisão'] },
      { domainField: 'rawCategory', notionProperty: 'Categoria Pierre', notionType: 'rich_text', direction: 'write', authority: 'PIERRE', description: 'Categoria bruta do open-finance', aliases: ['Categoria Original', 'Categoria Aberta', 'Categoria Pierre'] },
      { domainField: 'rawDescription', notionProperty: 'Descrição Original', notionType: 'rich_text', direction: 'write', authority: 'PIERRE', description: 'Texto original do extrato', aliases: ['Descrição Bruta', 'Descricao Banco', 'Descrição Original'] },
      { domainField: 'counterpartyHmac', notionProperty: 'HMAC Contraparte', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'Hash seguro do CPF/CNPJ para matching sem expor PII', aliases: ['Hash Contraparte', 'HMAC', 'HMAC Contraparte'] },
    ],
  },

  NOTION_DS_CATEGORIES: {
    envKey: 'NOTION_DS_CATEGORIES',
    defaultTitle: 'Categorias Financeiras',
    isExisting: true,
    properties: [
      { domainField: 'name', notionProperty: 'Nome da Categoria', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'Nome da categoria', aliases: ['Categoria', 'Nome', 'Título', 'Nome da Categoria'] },
      { domainField: 'budgetGroup', notionProperty: 'Grupo Orçamentário', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Agrupamento macro orçamentário configurável (ex: Essencial, Estilo de Vida, Metas, Estrutural)', aliases: ['Grupo 50/30/20', 'Grupo', 'Grupo Orçamento', 'Agrupamento', 'Grupo Orçamentário'], expectedOptions: ['Essencial (Necessidades)', 'Estilo de Vida (Desejos)', 'Investimentos / Metas', 'Estrutural / Neutro'] },
      { domainField: 'variability', notionProperty: 'Variabilidade', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Fixa, Variável, Ocasional', aliases: ['Variabilidade da Despesa', 'Variabilidade da Conta', 'Frequência', 'Tipo de Custo', 'Variabilidade'], expectedOptions: ['Fixa', 'Variável', 'Ocasional'] },
      { domainField: 'defaultNature', notionProperty: 'Natureza Padrão', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Natureza contábil sugerida', aliases: ['Natureza Padrão Sugerida', 'Natureza', 'Natureza Padrão'], expectedOptions: ['Receita Operacional', 'Despesa Operacional', 'Transferência Interna', 'Aporte de Capital', 'Resgate de Capital', 'Compra de Ativo', 'Venda de Ativo', 'Rendimento / Provento', 'Amortização de Dívida', 'Juros / Encargos de Dívida', 'Pagamento de Fatura', 'Reembolso / Estorno', 'Ajuste Contábil'] },
    ],
  },

  NOTION_DS_RULES: {
    envKey: 'NOTION_DS_RULES',
    defaultTitle: 'Regras de Classificação',
    isExisting: true,
    properties: [
      { domainField: 'name', notionProperty: 'Nome da Regra', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'Título descritivo da regra', aliases: ['Regra', 'Nome', 'Nome da Regra'] },
      { domainField: 'priority', notionProperty: 'Prioridade', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Ordem de avaliação (1 = prioridade máxima)', aliases: ['Ordem', 'Prioridade de Execução', 'Prioridade'] },
      { domainField: 'isActive', notionProperty: 'Ativa', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Liga/desliga a regra', aliases: ['Ativo', 'Habilitada', 'Ativa'] },
      { domainField: 'autoApply', notionProperty: 'Auto Aplicar', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Se falso, obriga envio para revisão', aliases: ['Aplicar Automaticamente', 'Auto', 'Auto Aplicar'] },
      { domainField: 'requireReview', notionProperty: 'Exigir Revisão', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Se verdadeiro, marca para checagem humana', aliases: ['Sinalizar para Revisão', 'Revisar', 'Exigir Revisão'] },
      { domainField: 'matchCounterparty', notionProperty: 'Condição: Contraparte', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Substring ou nome do merchant/destinatário', aliases: ['Contraparte contém', 'Contraparte Contém', 'Contraparte contem', 'Contraparte', 'Merchant', 'Estabelecimento'] },
      { domainField: 'matchDescription', notionProperty: 'Condição: Descrição', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Substring ou regex na descrição', aliases: ['Descrição contém', 'Descrição Contém', 'Descricao contem', 'Padrão de Descrição', 'Texto Descrição'] },
      { domainField: 'matchDirection', notionProperty: 'Condição: Movimento', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Qualquer, Entrada, Saída', aliases: ['Movimento esperado', 'Movimento Esperado', 'Sentido', 'Direção', 'Movimento'], expectedOptions: ['Qualquer', 'Entrada', 'Saída'] },
      { domainField: 'matchAccountRelation', notionProperty: 'Condição: Conta', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Conta de origem específica', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Conta origem', 'Conta Origem', 'Conta Aplicável', 'Conta'] },
      { domainField: 'matchRawCategory', notionProperty: 'Condição: Categoria Pierre', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Categoria original Pierre', aliases: ['Categoria Pierre', 'Categoria Banco', 'Categoria Original'] },
      { domainField: 'matchExactAmount', notionProperty: 'Condição: Valor Exato', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Valor monetário exato', aliases: ['Valor exato', 'Valor Exato', 'Valor'] },
      { domainField: 'matchAmountTolerance', notionProperty: 'Condição: Tolerância Valor', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Tolerância aceitável em reais', aliases: ['Tolerância', 'Tolerancia', 'Margem de Valor', 'Tolerância Valor'] },
      { domainField: 'matchMinAmount', notionProperty: 'Condição: Valor Mínimo', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Piso do valor', aliases: ['Valor mínimo', 'Valor Mínimo', 'Valor Minimo', 'Valor Mínimo (R$)'] },
      { domainField: 'matchMaxAmount', notionProperty: 'Condição: Valor Máximo', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Teto do valor', aliases: ['Valor máximo', 'Valor Máximo', 'Valor Maximo', 'Valor Máximo (R$)'] },
      { domainField: 'matchMinDay', notionProperty: 'Condição: Dia Mês Início', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Dia inicial do mês (1 a 31)', aliases: ['Dia mínimo', 'Dia Mínimo', 'Dia Minimo', 'Dia Início'] },
      { domainField: 'matchMaxDay', notionProperty: 'Condição: Dia Mês Fim', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Dia final do mês (1 a 31)', aliases: ['Dia máximo', 'Dia Máximo', 'Dia Maximo', 'Dia Fim'] },
      { domainField: 'validFrom', notionProperty: 'Válida de', notionType: 'date', direction: 'both', authority: 'USUARIO', description: 'Início da vigência da regra', aliases: ['Válida de', 'Válida De', 'Data de Início', 'Início Vigência', 'Vigência De', 'Período de Validade'] },
      { domainField: 'validUntil', notionProperty: 'Válida até', notionType: 'date', direction: 'both', authority: 'USUARIO', description: 'Término da vigência da regra', aliases: ['Válida até', 'Válida Até', 'Data de Término', 'Fim Vigência', 'Vigência Até'] },
      { domainField: 'assignNature', notionProperty: 'Atribuir: Natureza', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Natureza atribuída', aliases: ['Natureza resultante', 'Natureza Resultante', 'Natureza Contábil', 'Atribuir Natureza'], expectedOptions: ['Receita Operacional', 'Despesa Operacional', 'Transferência Interna', 'Aporte de Capital', 'Resgate de Capital', 'Compra de Ativo', 'Venda de Ativo', 'Rendimento / Provento', 'Amortização de Dívida', 'Juros / Encargos de Dívida', 'Pagamento de Fatura', 'Reembolso / Estorno', 'Ajuste Contábil'] },
      { domainField: 'assignBudgetEffect', notionProperty: 'Atribuir: Efeito Orçamento', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'INCOME, EXPENSE, REVERSAL, NEUTRAL', aliases: ['Efeito Orçamento Atribuído', 'Efeito Orçamento', 'Impacto Orçamentário'], expectedOptions: ['Receita', 'Despesa', 'Estorno', 'Neutro'] },
      { domainField: 'assignAllocationPurpose', notionProperty: 'Atribuir: Alocação', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Finalidade da movimentação', aliases: ['Finalidade Alocação', 'Propósito', 'Alocação'], expectedOptions: ['Caixa Operacional', 'Reserva de Investimento', 'Reserva de Emergência', 'Poupança Geral'] },
      { domainField: 'assignCategory', notionProperty: 'Atribuir: Categoria', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Categoria vinculada', relationTargetEnvKey: 'NOTION_DS_CATEGORIES', aliases: ['Categoria resultante', 'Categoria Resultante', 'Categoria Atribuída', 'Categoria'] },
    ],
  },

  NOTION_DS_FIXED_BILLS: {
    envKey: 'NOTION_DS_FIXED_BILLS',
    defaultTitle: 'Contas Fixas',
    isExisting: true,
    properties: [
      { domainField: 'name', notionProperty: 'Nome da Conta Fixa', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'Nome do compromisso recorrente', aliases: ['Conta Fixa', 'Serviço', 'Nome'] },
      { domainField: 'expectedAmount', notionProperty: 'Valor Previsto', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Valor esperado por competência', aliases: ['Valor', 'Valor Mensal', 'Preço'] },
      { domainField: 'toleranceAmount', notionProperty: 'Tolerância (R$)', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Tolerância para conciliação automática', aliases: ['Tolerância', 'Margem'] },
      { domainField: 'periodicity', notionProperty: 'Periodicidade', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Mensal, Bimestral, Trimestral, Semestral, Anual', aliases: ['Frequência', 'Recorrência'], expectedOptions: ['Mensal', 'Bimestral', 'Trimestral', 'Semestral', 'Anual'] },
      { domainField: 'anchorCompetence', notionProperty: 'Competência Âncora', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Mês de referência inicial (ex: 2026-01)', aliases: ['Competência Inicial', 'Mês Início'] },
      { domainField: 'lastGeneratedCompetence', notionProperty: 'Última Competência Gerada', notionType: 'rich_text', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Último mês gerado em Obrigações (ex: 2026-08)', aliases: ['Último Mês Gerado'] },
      { domainField: 'dueDay', notionProperty: 'Dia de Vencimento', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Dia do mês do vencimento (1 a 31)', aliases: ['Vencimento', 'Dia Venc'] },
      { domainField: 'paymentMethod', notionProperty: 'Forma de Pagamento', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Cartão de Crédito, Débito em Conta, Pix, Boleto', aliases: ['Meio de Pagamento', 'Método Pagamento'], expectedOptions: ['Cartão de Crédito', 'Débito em Conta', 'Pix', 'Boleto'] },
      { domainField: 'defaultAccount', notionProperty: 'Conta Padrão', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Conta de débito usual', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Conta', 'Conta Débito'] },
      { domainField: 'category', notionProperty: 'Categoria', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Categoria orçamentária', relationTargetEnvKey: 'NOTION_DS_CATEGORIES', aliases: ['Categoria Despesa'] },
      { domainField: 'matchPattern', notionProperty: 'Padrão de Identificação', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Expressão / substring para conciliação automática', aliases: ['Regex', 'Identificador', 'Padrão'] },
      { domainField: 'isActive', notionProperty: 'Ativa', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Gera obrigações no período', aliases: ['Ativo', 'Ativa'] },
      { domainField: 'generateObligation', notionProperty: 'Gerar obrigação', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Se ativado, gera automaticamente os lançamentos em Obrigações Mensais a cada competência', aliases: ['Gerar Obrigação', 'Gerar Parcela', 'Gerar Lançamento'] },
      { domainField: 'notes', notionProperty: 'Observações / Contrato', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Código do assinante, detalhes do contrato ou instruções', aliases: ['Observações', 'Notas', 'Contrato'] },
      { domainField: 'validFrom', notionProperty: 'Data de Início', notionType: 'date', direction: 'both', authority: 'USUARIO', description: 'Início da vigência do contrato', aliases: ['Início Vigência', 'Vigência De'] },
      { domainField: 'validUntil', notionProperty: 'Data de Término', notionType: 'date', direction: 'both', authority: 'USUARIO', description: 'Término da vigência do contrato', aliases: ['Fim Vigência', 'Vigência Até'] },
    ],
  },

  NOTION_DS_MONTHLY_OBLIGATIONS: {
    envKey: 'NOTION_DS_MONTHLY_OBLIGATIONS',
    defaultTitle: 'Obrigações Mensais',
    isExisting: true,
    properties: [
      { domainField: 'title', notionProperty: 'Identificador', notionType: 'title', direction: 'both', authority: 'DERIVADO', description: 'Nome da Conta Fixa - YYYY-MM', aliases: ['Nome', 'Obrigação', 'Identificador Parcela'] },
      { domainField: 'fixedBillRelation', notionProperty: 'Conta Fixa', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Relação com o cadastro permanente', relationTargetEnvKey: 'NOTION_DS_FIXED_BILLS', aliases: ['Conta Fixa Origem', 'Contrato'] },
      { domainField: 'competencePeriod', notionProperty: 'Competência', notionType: 'rich_text', direction: 'both', authority: 'DERIVADO', description: 'Mês de referência (YYYY-MM)', aliases: ['Mês', 'Competência Referência'] },
      { domainField: 'dueDate', notionProperty: 'Data de Vencimento', notionType: 'date', direction: 'both', authority: 'DERIVADO', description: 'Data exata do vencimento', aliases: ['Vencimento', 'Data Limite'] },
      { domainField: 'expectedAmount', notionProperty: 'Valor Previsto', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Valor esperado herdado da conta fixa', aliases: ['Valor Esperado', 'Valor Previsto'] },
      { domainField: 'status', notionProperty: 'Status', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Prevista, Paga, Atrasada, Revisão Necessária, Cancelada', aliases: ['Status Pagamento', 'Situação'], expectedOptions: ['Prevista', 'Paga', 'Atrasada', 'Revisão Necessária', 'Cancelada'] },
      { domainField: 'paidAmount', notionProperty: 'Valor Pago', notionType: 'number', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Valor efetivamente liquidado', aliases: ['Valor Efetivo', 'Valor Liquidado'] },
      { domainField: 'paidAt', notionProperty: 'Data do Pagamento', notionType: 'date', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Data em que ocorreu a quitação', aliases: ['Data Quitação', 'Pago Em'] },
      { domainField: 'matchedTransaction', notionProperty: 'Transação Vinculada', notionType: 'relation', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Relação com a transação que liquidou', relationTargetEnvKey: 'NOTION_DS_TRANSACTIONS', aliases: ['Transação', 'Comprovante'] },
      { domainField: 'autoValidated', notionProperty: 'Validado Automaticamente', notionType: 'checkbox', direction: 'write', authority: 'REGRA_AUTOMATICA', description: 'True se correspondência foi inequívoca', aliases: ['Validado Auto', 'Conciliado Auto'] },
      { domainField: 'notes', notionProperty: 'Observações / Conflitos', notionType: 'rich_text', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Avisos de divergência ou ambiguidade', aliases: ['Observações', 'Avisos'] },
    ],
  },

  NOTION_DS_INVESTMENTS: {
    envKey: 'NOTION_DS_INVESTMENTS',
    defaultTitle: 'Investimentos',
    isExisting: true,
    properties: [
      { domainField: 'assetName', notionProperty: 'Ativo', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'Nome do ativo ou produto financeiro', aliases: ['Nome do Ativo', 'Nome', 'Produto', 'Papel', 'Ativo'] },
      { domainField: 'assetType', notionProperty: 'Classe do Ativo', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Renda Fixa, Cripto, Ação, FII, ETF, Previdência Privada, Tesouro Direto (Caixa Reservado NÃO é classe de ativo)', aliases: ['Classe', 'Tipo de Ativo', 'Categoria', 'Classe do Ativo'], expectedOptions: ['Renda Fixa', 'Cripto', 'Ação', 'FII', 'ETF', 'Previdência Privada', 'Tesouro Direto', 'Outros'] },
      { domainField: 'origin', notionProperty: 'Custódia', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Conta Pierre ou Carteira Externa', aliases: ['Origem', 'Instituição Custódia', 'Custódia'] },
      { domainField: 'currency', notionProperty: 'Moeda', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Código da moeda do ativo (BRL, USD, BTC, EUR)', aliases: ['Moeda do Ativo', 'Moeda', 'Currency'], expectedOptions: ['BRL', 'USD', 'BTC', 'EUR'] },
      { domainField: 'quantity', notionProperty: 'Quantidade', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Posição atual custodiada', aliases: ['Posição', 'Qtd', 'Cotas / Ações', 'Quantidade'] },
      { domainField: 'unitAveragePrice', notionProperty: 'Preço Médio Unitário (PMP)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Preço médio ponderado unitário de aquisição', aliases: ['Preço Médio', 'PMP', 'PM', 'Preço de Aquisição'] },
      { domainField: 'totalCostBasis', notionProperty: 'Custo Base Total', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Montante total acumulado desembolsado nas compras (base de custo contábil)', aliases: ['Custo acumulado', 'Custo Acumulado', 'Custo Total', 'Total Investido', 'Custo Histórico'] },
      { domainField: 'currentMarketValue', notionProperty: 'Valor de Mercado Atual', notionType: 'number', direction: 'both', authority: 'PIERRE', description: 'Posição a mercado: Cotação atual x quantidade', aliases: ['Valor atual', 'Valor Atual', 'Saldo Atual', 'Posição Atual', 'Valor de Mercado', 'Patrimônio Atual'] },
      { domainField: 'unrealizedProfitLoss', notionProperty: 'Lucro / Prejuízo Não Realizado', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Valor de Mercado Atual - Custo Base Total', aliases: ['Lucro/Prejuízo', 'Rentabilidade (R$)', 'Resultado'] },
      { domainField: 'profitLossPercentage', notionProperty: 'Retorno Não Realizado (%)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: '((Valor de Mercado Atual - Custo Base Total) / Custo Base Total) * 100', aliases: ['Rentabilidade (%)', 'Retorno (%)'] },
      { domainField: 'liquidity', notionProperty: 'Liquidez', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Prazo de liquidez (ex: D+0, D+1, D+30, No Vencimento)', aliases: ['Prazo Liquidez', 'Liquidez Resgate', 'Liquidez'], expectedOptions: ['D+0', 'D+1', 'D+2', 'D+30', 'No Vencimento', 'Sem Liquidez'] },
      { domainField: 'valuationSource', notionProperty: 'Fonte da Avaliação', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Origem da cotação a mercado (ex: Pierre, B3, Manual, Cripto API)', aliases: ['Fonte do preço', 'Fonte do Preço', 'Fonte Avaliação', 'Fonte Cotação', 'Fonte da Avaliação'], expectedOptions: ['Pierre', 'B3', 'Manual', 'Cripto API', 'Tesouro Direto'] },
      { domainField: 'valuationDate', notionProperty: 'Data da Avaliação', notionType: 'date', direction: 'both', authority: 'DERIVADO', description: 'Data/hora da última cotação de mercado capturada', aliases: ['Data da avaliação', 'Data da Avaliação', 'Data Avaliação', 'Última Cotação'] },
      { domainField: 'includeInNetWorth', notionProperty: 'Incluir no Patrimônio', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Indica se esta posição deve compor o cálculo de patrimônio líquido final', aliases: ['Incluir Patrimônio', 'Compor Patrimônio', 'Patrimônio Líquido', 'Incluir no Patrimônio'] },
      { domainField: 'institution', notionProperty: 'Instituição / Corretora', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Corretora ou custodiante do investimento (ex: NuInvest, Binance, XP, BTG)', aliases: ['Instituição', 'Instituicao', 'Corretora', 'Custodiante', 'Instituição / Corretora'] },
      { domainField: 'sourceAssetId', notionProperty: 'ID do Ativo na Fonte', notionType: 'rich_text', direction: 'both', authority: 'PIERRE', description: 'Identificador único do ativo na API de origem para sincronização', aliases: ['ID da fonte', 'ID da Fonte', 'ID Fonte', 'Asset ID', 'Código do Ativo', 'ID do Ativo na Fonte'] },
      { domainField: 'linkedAccount', notionProperty: 'Conta Vinculada', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Conta corrente ou corretora associada', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Conta Corretora', 'Conta', 'Conta Vinculada'] },
    ],
  },

  NOTION_DS_INVESTMENT_MOVEMENTS: {
    envKey: 'NOTION_DS_INVESTMENT_MOVEMENTS',
    defaultTitle: 'Movimentações de Investimentos',
    isExisting: true,
    properties: [
      { domainField: 'title', notionProperty: 'Identificador', notionType: 'title', direction: 'write', authority: 'DERIVADO', description: 'Tipo - Ativo - Data', aliases: ['Título', 'Nome', 'Operação'] },
      { domainField: 'investmentRelation', notionProperty: 'Ativo Vinculado', notionType: 'relation', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Relação com a posição do ativo', relationTargetEnvKey: 'NOTION_DS_INVESTMENTS', aliases: ['Ativo', 'Investimento Vinculado'] },
      { domainField: 'movementType', notionProperty: 'Tipo de Movimentação', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Aporte de Capital, Resgate de Capital, Compra de Ativo, Venda de Ativo, Rendimento / Provento, Taxas e Impostos, Ajuste de Posição', aliases: ['Tipo', 'Operação'], expectedOptions: ['Aporte de Capital', 'Resgate de Capital', 'Compra de Ativo', 'Venda de Ativo', 'Rendimento / Provento', 'Taxas e Impostos', 'Ajuste de Posição'] },
      { domainField: 'date', notionProperty: 'Data da Operação', notionType: 'date', direction: 'both', authority: 'PIERRE', description: 'Data da execução', aliases: ['Data', 'Data Operação'] },
      { domainField: 'grossAmount', notionProperty: 'Valor Bruto', notionType: 'number', direction: 'both', authority: 'PIERRE', description: 'Volume financeiro total', aliases: ['Valor Total', 'Montante'] },
      { domainField: 'netAmount', notionProperty: 'Valor Líquido', notionType: 'number', direction: 'both', authority: 'PIERRE', description: 'Valor líquido após custos', aliases: ['Valor Líquido Operação'] },
      { domainField: 'quantity', notionProperty: 'Quantidade Negociada', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Fração ou unidades transacionadas', aliases: ['Quantidade', 'Cotas'] },
      { domainField: 'unitPrice', notionProperty: 'Preço Unitário', notionType: 'number', direction: 'both', authority: 'DERIVADO', description: 'Preço médio da ordem', aliases: ['Preço Médio Operação', 'Cotação'] },
      { domainField: 'sourceAccount', notionProperty: 'Conta Origem', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Conta debitada', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Conta Débito', 'Origem'] },
      { domainField: 'destinationAccount', notionProperty: 'Conta Destino / Caixa', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Conta creditada', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Conta Crédito', 'Destino'] },
      { domainField: 'relatedTransaction', notionProperty: 'Transação Financeira', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Transação bancária vinculada', relationTargetEnvKey: 'NOTION_DS_TRANSACTIONS', aliases: ['Transação Bancária'] },
    ],
  },

  NOTION_DS_MONTHLY_BUDGET: {
    envKey: 'NOTION_DS_MONTHLY_BUDGET',
    defaultTitle: 'Planejamento Mensal',
    isExisting: true,
    properties: [
      { domainField: 'competence', notionProperty: 'Competência', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'YYYY-MM', aliases: ['Mês', 'Competência Planejamento'] },
      { domainField: 'netIncomePlanned', notionProperty: 'Renda Prevista', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Meta de renda do mês', aliases: ['Renda Alvo', 'Renda Estimada'] },
      { domainField: 'cardSpendBudget', notionProperty: 'Teto Mensal Cartão', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Teto pessoal de compras no cartão (ex: R$ 400)', aliases: ['Teto Cartão', 'Limite Cartão'] },
      { domainField: 'savingsGoalPlanned', notionProperty: 'Meta de Poupança/Aporte', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Meta de dinheiro a poupar no mês', aliases: ['Meta Poupança', 'Meta Aporte'] },
      { domainField: 'budgetGroupTargets', notionProperty: 'Metas por Grupo Orçamentário', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Metas percentuais ou tetos nominais por grupo orçamentário configurável', aliases: ['Metas 50/30/20', 'Tetos por Grupo'] },
      { domainField: 'savingsRateTarget', notionProperty: 'Meta Taxa de Poupança (%)', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Percentual alvo da renda líquida destinado a investimentos e reservas', aliases: ['Taxa Poupança Alvo (%)'] },
      { domainField: 'realizedIncome', notionProperty: 'Receitas Realizadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma de transações OPERATING_REVENUE', aliases: ['Renda Realizada'] },
      { domainField: 'realizedExpenses', notionProperty: 'Despesas Realizadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma de transações OPERATING_EXPENSE', aliases: ['Despesas Realizadas'] },
      { domainField: 'realizedSavings', notionProperty: 'Poupança Realizada', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma de transações com savingsGoalContribution', aliases: ['Poupança Efetiva'] },
      { domainField: 'cardSpendRealized', notionProperty: 'Compras Realizadas Cartão', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma de compras de cartão no mês', aliases: ['Gasto Cartão Realizado'] },
    ],
  },

  NOTION_DS_FINANCIAL_GOALS: {
    envKey: 'NOTION_DS_FINANCIAL_GOALS',
    defaultTitle: 'Metas Financeiras',
    isExisting: true,
    properties: [
      { domainField: 'name', notionProperty: 'Meta', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'Nome do objetivo financeiro', aliases: ['Objetivo', 'Nome da Meta'] },
      { domainField: 'targetAmount', notionProperty: 'Valor Alvo', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Montante financeiro desejado', aliases: ['Valor da Meta', 'Total Alvo'] },
      { domainField: 'currentAmount', notionProperty: 'Valor Atual Acumulado', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Saldo alocado para a meta', aliases: ['Saldo Atual', 'Montante Acumulado'] },
      { domainField: 'deadline', notionProperty: 'Prazo Alvo', notionType: 'date', direction: 'both', authority: 'USUARIO', description: 'Data limite para cumprimento', aliases: ['Prazo', 'Data Alvo'] },
    ],
  },

  NOTION_DS_MONTHLY_CLOSINGS: {
    envKey: 'NOTION_DS_MONTHLY_CLOSINGS',
    defaultTitle: 'Fechamentos Mensais',
    isExisting: true,
    properties: [
      { domainField: 'title', notionProperty: 'Mês de Referência', notionType: 'title', direction: 'both', authority: 'DERIVADO', description: 'Fechamento YYYY-MM', aliases: ['Mês', 'Competência', 'Fechamento'] },
      { domainField: 'status', notionProperty: 'Status do Fechamento', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Aberto, Pré-fechado, Fechado Auditado', aliases: ['Status', 'Situação'], expectedOptions: ['Aberto', 'Pré-fechado', 'Fechado Auditado'] },
      { domainField: 'reconciliationStatus', notionProperty: 'Status de Reconciliação', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Conciliado Integralmente, Divergências Pendentes, Reconciliação Manual Necessária', aliases: ['Status Reconciliação', 'Reconciliação'], expectedOptions: ['Conciliado Integralmente', 'Divergências Pendentes', 'Reconciliação Manual Necessária'] },
      { domainField: 'dataQualityScore', notionProperty: 'Qualidade dos Dados', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Nota ou classificação da confiabilidade dos lançamentos do mês', aliases: ['Qualidade Dados', 'Confiabilidade Dados'], expectedOptions: ['Excelente', 'Bom', 'Atenção Necessária', 'Crítico'] },
      { domainField: 'initialNetWorth', notionProperty: 'Patrimônio Inicial', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Patrimônio líquido consolidado no início do mês', aliases: ['Patrimônio Inicial Consolidado'] },
      { domainField: 'totalIncome', notionProperty: 'Renda Consolidada', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Total de receitas operacionais líquidas', aliases: ['Total Receitas', 'Receita Líquida'] },
      { domainField: 'totalExpenses', notionProperty: 'Despesas Consolidadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Total de despesas correntes de subsistência e consumo', aliases: ['Total Despesas', 'Gastos Totais'] },
      { domainField: 'essentialExpenses', notionProperty: 'Despesas Essenciais (Necessidades)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Gastos essenciais de moradia, saúde, alimentação básica', aliases: ['Gastos Essenciais', 'Necessidades (50%)'] },
      { domainField: 'discretionaryExpenses', notionProperty: 'Despesas Discricionárias (Desejos)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Gastos de estilo de vida, lazer e compras', aliases: ['Gastos Discricionários', 'Desejos (30%)'] },
      { domainField: 'operatingSurplus', notionProperty: 'Resultado do Mês (Sobra Operacional)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Renda Consolidada - Despesas Consolidadas (fluxo de caixa operacional livre do mês antes de aportes)', aliases: ['Sobra Operacional', 'Superávit Operacional'] },
      { domainField: 'savingsAndInvestments', notionProperty: 'Poupança / Aportes Realizados', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Total efetivamente poupado e transferido para investimentos no mês', aliases: ['Aportes', 'Poupança Realizada'] },
      { domainField: 'savingsRate', notionProperty: 'Taxa de Poupança (%)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: '(Poupança / Aportes Realizados / Renda Consolidada) * 100', aliases: ['Taxa de Poupança Efetiva (%)'] },
      { domainField: 'unallocatedCashFlow', notionProperty: 'Fluxo Residual Não Alocado', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Sobra Operacional - Poupança/Aportes Realizados', aliases: ['Fluxo Residual'] },
      { domainField: 'investmentYield', notionProperty: 'Rendimentos de Investimentos', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Rendimentos e dividendos auferidos no mês', aliases: ['Rendimentos', 'Dividendos e Juros'] },
      { domainField: 'finalNetWorth', notionProperty: 'Patrimônio Líquido Final', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Saldo contas + investimentos - dívidas ao fechar o mês', aliases: ['Patrimônio Líquido Final Consolidado'] },
      { domainField: 'netWorthChange', notionProperty: 'Variação Patrimonial', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Patrimônio Final - Patrimônio Inicial', aliases: ['Evolução Patrimonial', 'Delta Patrimônio'] },
      { domainField: 'fixedBillsPaidCount', notionProperty: 'Contas Fixas Pagas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Contagem de obrigações fixas da competência com status Paga', aliases: ['Contas Fixas Liquidadas', 'Obrigações Pagas'] },
      { domainField: 'fixedBillsPendingCount', notionProperty: 'Contas Fixas Pendentes', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Contagem de obrigações fixas da competência ainda pendentes ou atrasadas', aliases: ['Contas Fixas em Aberto', 'Obrigações Pendentes'] },
      { domainField: 'itemsNeedingReviewCount', notionProperty: 'Itens para Revisão', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Contagem de transações ou lançamentos da competência aguardando revisão humana', aliases: ['Itens Pendentes Revisão', 'Transações em Revisão', 'Itens Para Revisão'] },
      { domainField: 'closedAt', notionProperty: 'Fechado Em', notionType: 'date', direction: 'both', authority: 'USUARIO', description: 'Data/hora em que o fechamento mensal foi consolidado e trancado', aliases: ['Data do Fechamento', 'Data Fechamento', 'Fechado em'] },
      { domainField: 'notes', notionProperty: 'Observações / Notas do Fechamento', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Comentários qualitativos sobre desvios e conquistas do mês', aliases: ['Observações', 'Notas'] },
    ],
  },

  NOTION_DS_SYNC_LOG: {
    envKey: 'NOTION_DS_SYNC_LOG',
    defaultTitle: 'Log de Sincronização',
    isExisting: true,
    properties: [
      { domainField: 'title', notionProperty: 'Execução', notionType: 'title', direction: 'write', authority: 'DERIVADO', description: 'Sync - YYYY-MM-DD HH:mm:ss', aliases: ['Execução Sync', 'Título'] },
      { domainField: 'status', notionProperty: 'Status', notionType: 'select', direction: 'write', authority: 'DERIVADO', description: 'Sucesso, Sucesso Parcial, Erro, Bloqueado por Concorrência', aliases: ['Resultado', 'Status Execução'], expectedOptions: ['Sucesso', 'Sucesso Parcial', 'Erro', 'Bloqueado por Concorrência'] },
      { domainField: 'syncSource', notionProperty: 'Fonte de Sincronização', notionType: 'select', direction: 'write', authority: 'DERIVADO', description: 'Sistema ou conector de origem da sincronização (ex: PIERRE, MANUAL_CSV, MIGRATION)', aliases: ['Fonte', 'Origem Sincronização', 'Source'], expectedOptions: ['PIERRE', 'MANUAL_CSV', 'MIGRATION'] },
      { domainField: 'startedAt', notionProperty: 'Data Início', notionType: 'date', direction: 'write', authority: 'DERIVADO', description: 'Timestamp do início da sincronização', aliases: ['Início', 'Timestamp Início'] },
      { domainField: 'endedAt', notionProperty: 'Data Fim', notionType: 'date', direction: 'write', authority: 'DERIVADO', description: 'Timestamp do término da sincronização', aliases: ['Término', 'Timestamp Fim'] },
      { domainField: 'durationSeconds', notionProperty: 'Duração (s)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Tempo total de processamento em segundos', aliases: ['Duração (segundos)', 'Tempo Total (s)'] },
      { domainField: 'durationMs', notionProperty: 'Duração (ms)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Tempo total de processamento em milissegundos', aliases: ['Tempo de Execução (ms)'] },
      { domainField: 'accountsSynced', notionProperty: 'Contas Processadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Quantidade de contas sincronizadas', aliases: ['Contas Sincronizadas'] },
      { domainField: 'transactionsReceived', notionProperty: 'Transações Recebidas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Lançamentos retornados pelo Pierre', aliases: ['Lançamentos Recebidos'] },
      { domainField: 'transactionsCreated', notionProperty: 'Transações Novas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Novas páginas criadas', aliases: ['Novas Transações', 'Criadas'] },
      { domainField: 'transactionsUpdated', notionProperty: 'Transações Atualizadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Páginas existentes com versionHash alterado', aliases: ['Transações Modificadas', 'Atualizadas'] },
      { domainField: 'transactionsUnchanged', notionProperty: 'Transações Inalteradas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Transações sem alteração ignoradas', aliases: ['Transações Iguais', 'Ignoradas'] },
      { domainField: 'errorsCount', notionProperty: 'Erros Encontrados', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Total de falhas ou exceções não fatais registradas durante o lote', aliases: ['Quantidade de Erros', 'Total Erros'] },
      { domainField: 'installmentsReceived', notionProperty: 'Parcelas Recebidas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Parcelamentos e faturas futuras identificadas', aliases: ['Faturas e Parcelas'] },
      { domainField: 'reviewQueueCount', notionProperty: 'Enviadas para Revisão', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Transações marcadas como Pendente Revisão', aliases: ['Fila de Revisão', 'Pendentes Revisão'] },
      { domainField: 'obligationsReconciled', notionProperty: 'Obrigações Conciliadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Compromissos mensais liquidados com sucesso', aliases: ['Compromissos Conciliados'] },
      { domainField: 'sourceFreshness', notionProperty: 'Freshness da Fonte', notionType: 'date', direction: 'write', authority: 'DERIVADO', description: 'Momento do último dado retornado pelo banco / open finance', aliases: ['Atualidade dos Dados', 'Freshness'] },
      { domainField: 'runId', notionProperty: 'ID da Execução (Run ID)', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'UUID unívoco da execução do worker', aliases: ['ID Execução', 'Execution ID'] },
      { domainField: 'errorCode', notionProperty: 'Código do Erro', notionType: 'select', direction: 'write', authority: 'DERIVADO', description: 'Código padronizado de erro (ex: AUTH_EXPIRED, NETWORK_TIMEOUT, VALIDATION_ERROR)', aliases: ['Tipo Erro', 'Error Code'] },
      { domainField: 'sanitizedErrorMessage', notionProperty: 'Mensagem de Erro Sanitizada', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'Mensagem descritiva tratada, sem stack trace ou dados sensíveis', aliases: ['Mensagem Erro', 'Erro Detalhado'] },
      { domainField: 'privateLogRef', notionProperty: 'Referência do Log Privado', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'Identificador do registro detalhado no armazenamento privado cifrado', aliases: ['Caminho Log', 'Log Ref'] },
      { domainField: 'rawBatchHash', notionProperty: 'Hash do Lote RAW', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'SHA-256 do payload bruto salvo no cofre cifrado', aliases: ['Hash RAW', 'Payload Hash'] },
      { domainField: 'workerCommit', notionProperty: 'Versão do Worker / Commit', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'Commit SHA ou tag da versão do worker em execução', aliases: ['Git Commit', 'Versão Worker'] },
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
      { domainField: 'title', notionProperty: 'Fatura / Ciclo', notionType: 'title', direction: 'write', authority: 'DERIVADO', description: 'Ex: Fatura Nubank - Venc 22/07/2026', aliases: ['Título', 'Ciclo'] },
      { domainField: 'accountRelation', notionProperty: 'Cartão Vinculado', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Relação com a conta do cartão em Contas', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Cartão', 'Conta Cartão'] },
      { domainField: 'cycleType', notionProperty: 'Tipo de Ciclo', notionType: 'select', direction: 'write', authority: 'DERIVADO', description: 'Ciclo Real Banco, Ciclo Configurado, Ciclo Estimado', aliases: ['Tipo Ciclo'], expectedOptions: ['Ciclo Real Banco', 'Ciclo Configurado', 'Ciclo Estimado'] },
      { domainField: 'status', notionProperty: 'Status da Fatura', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Aberta em Curso, Fechada a Vencer, Vencida, Paga Integralmente, Paga Parcialmente', aliases: ['Status Fatura', 'Situação'], expectedOptions: ['Aberta em Curso', 'Fechada a Vencer', 'Vencida', 'Paga Integralmente', 'Paga Parcialmente'] },
      { domainField: 'closingDate', notionProperty: 'Data de Fechamento', notionType: 'date', direction: 'write', authority: 'PIERRE', description: 'Data de corte (balance_close_date ou configurada)', aliases: ['Fechamento', 'Data Corte'] },
      { domainField: 'dueDate', notionProperty: 'Data de Vencimento', notionType: 'date', direction: 'write', authority: 'PIERRE', description: 'Data de vencimento (balance_due_date)', aliases: ['Vencimento', 'Data Venc'] },
      { domainField: 'rawBillAmount', notionProperty: 'Valor da Fatura (Banco)', notionType: 'number', direction: 'write', authority: 'PIERRE', description: 'Valor total consolidado emitido pela instituição', aliases: ['Valor Fatura', 'Total Fatura'] },
      { domainField: 'purchasesTotal', notionProperty: 'Total de Compras no Ciclo', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma real das transações de compra dentro do ciclo corrente', aliases: ['Total Compras'] },
      { domainField: 'additionalComponentsAmount', notionProperty: 'Componentes Adicionais da Fatura', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma dos componentes adicionais identificados (parcelas anteriores, encargos, IOF, juros, créditos/estornos)', aliases: ['Componentes Adicionais', 'Outros Encargos'] },
      { domainField: 'unexplainedDiscrepancy', notionProperty: 'Divergência Não Explicada', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Discrepância residual caso os componentes adicionais conhecidos não expliquem a diferença', aliases: ['Divergência Residual'] },
      { domainField: 'paidAmount', notionProperty: 'Valor Pago', notionType: 'number', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Valor total liquidado até o momento', aliases: ['Total Pago'] },
      { domainField: 'paidAt', notionProperty: 'Data de Liquidação', notionType: 'date', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Data do pagamento da fatura', aliases: ['Data Pagamento'] },
      { domainField: 'transactionsRelation', notionProperty: 'Lançamentos do Ciclo', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Relação bidirecional com as transações de compra deste ciclo', relationTargetEnvKey: 'NOTION_DS_TRANSACTIONS', isBidirectionalRelation: true, syncedPropertyName: 'Fatura Vinculada', aliases: ['Transações da Fatura', 'Compras'] },
      { domainField: 'paymentTransactions', notionProperty: 'Transações de Pagamento', notionType: 'relation', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Relações com as transações bancárias de saída que quitaram ou amortizaram a fatura (suporta múltiplos pagamentos)', relationTargetEnvKey: 'NOTION_DS_TRANSACTIONS', aliases: ['Pagamentos'] },
    ],
  },
};


