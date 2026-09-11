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
  | 'UPSTREAM'          // Direct from upstream open-finance API / external banking connector
  | 'FONTE_EXTERNA'     // External source authority (alias for UPSTREAM)
  | 'REGRA_AUTOMATICA'  // Assigned by deterministic classification / reconciliation engine
  | 'USUARIO'           // Human authority (edits are locked and preserved against overwrites)
  | 'DERIVADO'          // Calculated mathematically by domain logic
  | 'PIERRE';           // Legacy alias for backwards compatibility

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
   * Policy on unexpected/additional options found in Notion select/multi_select properties.
   * - true: Permits additional unlisted options in Notion without flagging structural mismatch.
   * - false: Enforces a strict closed enum set, flagging unexpected options as warnings.
   */
  allowExtraOptions?: boolean;
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
      { domainField: 'name', notionProperty: 'Nome da Conta', notionType: 'title', direction: 'both', authority: 'UPSTREAM', description: 'Nome identificador da conta', aliases: ['Nome', 'Conta', 'Nome Conta', 'Nome da conta'] },
      { domainField: 'source', notionProperty: 'Fonte', notionType: 'select', direction: 'both', authority: 'UPSTREAM', description: 'Sistema ou conector de origem (ex: PIERRE, MANUAL, OTHER)', aliases: ['Origem', 'Conector', 'Sistema Origem', 'Fonte'], expectedOptions: ['Pierre', 'Manual', 'Outra'], optionMappings: { 'Pierre': 'PIERRE', 'Manual': 'MANUAL', 'Outra': 'OTHER' }, allowExtraOptions: true },
      { domainField: 'sourceAccountId', notionProperty: 'ID da Fonte', notionType: 'rich_text', direction: 'both', authority: 'UPSTREAM', description: 'Identificador unívoco da conta no sistema de origem', aliases: ['ID da fonte', 'ID da Fonte', 'ID Pierre', 'ID', 'UUID', 'Pierre ID', 'Source ID', 'ID Conta'] },
      { domainField: 'currency', notionProperty: 'Moeda', notionType: 'select', direction: 'both', authority: 'UPSTREAM', description: 'Código da moeda da conta (ex: BRL, USD)', aliases: ['Moeda da Conta', 'Currency', 'Divisa', 'Moeda'], expectedOptions: ['BRL', 'USD'], optionMappings: { 'BRL': 'BRL', 'USD': 'USD', 'Outra': 'OTHER' }, allowExtraOptions: true },
      { domainField: 'institution', notionProperty: 'Instituição', notionType: 'rich_text', direction: 'both', authority: 'UPSTREAM', description: 'Nome do banco / conector (ex: Nubank, Mercado Pago)', aliases: ['Banco', 'Instituicao', 'Instituição'] },
      { domainField: 'type', notionProperty: 'Tipo de Conta', notionType: 'select', direction: 'both', authority: 'UPSTREAM', description: 'CHECKING_ACCOUNT, CREDIT_CARD, SAVINGS, CASH_WALLET, INVESTMENT_ACCOUNT, OTHER', aliases: ['Tipo', 'Tipo Conta', 'Tipo de Conta', 'Tipo de conta'], expectedOptions: ['Conta corrente', 'Cartão de crédito', 'Carteira', 'Corretora', 'Dinheiro', 'Outro'], optionMappings: { 'Conta corrente': 'CHECKING_ACCOUNT', 'Conta Corrente': 'CHECKING_ACCOUNT', 'Cartão de crédito': 'CREDIT_CARD', 'Cartão de Crédito': 'CREDIT_CARD', 'Carteira': 'CASH_WALLET', 'Corretora': 'INVESTMENT_ACCOUNT', 'Dinheiro': 'CASH_WALLET', 'Outro': 'OTHER', 'Conta Poupança': 'SAVINGS_ACCOUNT', 'Poupança': 'SAVINGS_ACCOUNT' }, allowExtraOptions: true },
      { domainField: 'balance', notionProperty: 'Saldo Atual', notionType: 'number', direction: 'write', authority: 'UPSTREAM', description: 'Saldo disponível em reais', aliases: ['Saldo', 'Saldo em Conta', 'Saldo Atual', 'Saldo atual'] },
      { domainField: 'contractedCreditLimit', notionProperty: 'Limite Contratado', notionType: 'number', direction: 'write', authority: 'UPSTREAM', description: 'Limite total concedido pelo banco (ex: R$ 2.400)', aliases: ['Limite', 'Limite Total', 'Limite Contratado', 'Limite contratado'] },
      { domainField: 'customizedCreditLimit', notionProperty: 'Limite Personalizado', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Teto operacional ajustado pelo usuário no app (ex: R$ 400)', aliases: ['Teto Operacional', 'Limite Definido', 'Limite Personalizado', 'Limite personalizado'] },
      { domainField: 'availableCreditLimit', notionProperty: 'Limite Disponível', notionType: 'number', direction: 'write', authority: 'UPSTREAM', description: 'Limite de crédito livre no momento', aliases: ['Disponível', 'Limite Livre', 'Limite Disponível', 'Limite disponível'] },
      { domainField: 'usedOperationalLimit', notionProperty: 'Limite Operacional Usado', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'customizedCreditLimit - availableCreditLimit', aliases: ['Limite Usado', 'Limite Operacional Usado'] },
      { domainField: 'rawUsedCreditLimit', notionProperty: 'Limite Usado da Fonte (Bruto)', notionType: 'number', direction: 'write', authority: 'UPSTREAM', description: 'Valor bruto reportado pela fonte para auditoria de inconsistência', aliases: ['Limite Usado (Pierre Bruto)', 'Limite Bruto Pierre', 'Limite Usado da Fonte (Bruto)'] },
      { domainField: 'closingDay', notionProperty: 'Dia de Fechamento', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Dia do mês do corte da fatura', aliases: ['Dia Fechamento', 'Fechamento', 'Dia de Fechamento'] },
      { domainField: 'dueDay', notionProperty: 'Dia de Vencimento', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Dia do mês do vencimento da fatura', aliases: ['Dia Vencimento', 'Vencimento', 'Dia de Vencimento'] },
      { domainField: 'includeInCash', notionProperty: 'Incluir no Caixa', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Indica se computa para liquidez imediata', aliases: ['Caixa', 'Compor Caixa', 'Incluir no Caixa', 'Inclui no caixa'] },
      { domainField: 'includeInNetWorth', notionProperty: 'Incluir no Patrimônio', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Indica se computa para o patrimônio total', aliases: ['Patrimônio', 'Compor Patrimônio', 'Incluir no Patrimônio', 'Inclui no patrimônio'] },
      { domainField: 'lastSyncedAt', notionProperty: 'Última Sincronização', notionType: 'date', direction: 'write', authority: 'DERIVADO', description: 'Timestamp da sincronização', aliases: ['Atualizado em', 'Atualizado Em', 'Último Sync', 'Data Sync', 'Última Sincronização', 'Atualizado'] },
    ],
  },

  NOTION_DS_TRANSACTIONS: {
    envKey: 'NOTION_DS_TRANSACTIONS',
    defaultTitle: 'Transações',
    isExisting: true,
    properties: [
      { domainField: 'description', notionProperty: 'Descrição', notionType: 'title', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Descrição tratada da transação', aliases: ['Lançamento', 'Lancamento', 'Descricao', 'Descrição', 'Nome', 'Título', 'Titulo'] },
      { domainField: 'source', notionProperty: 'Fonte', notionType: 'select', direction: 'both', authority: 'UPSTREAM', description: 'Sistema ou conector de origem (ex: PIERRE, MANUAL, MIGRATION, OTHER)', aliases: ['Origem', 'Conector', 'Sistema', 'Fonte'], expectedOptions: ['Pierre', 'Manual', 'Migração', 'Outra'], optionMappings: { 'Pierre': 'PIERRE', 'Manual': 'MANUAL', 'Migração': 'MIGRATION', 'Outra': 'OTHER' }, allowExtraOptions: true },
      { domainField: 'sourceTransactionId', notionProperty: 'ID da Fonte', notionType: 'rich_text', direction: 'both', authority: 'UPSTREAM', description: 'Identificador unívoco da transação no sistema de origem', aliases: ['ID da fonte', 'ID da Fonte', 'ID Pierre', 'ID', 'UUID', 'Pierre ID', 'Source ID', 'ID Transação'] },
      { domainField: 'currency', notionProperty: 'Moeda', notionType: 'select', direction: 'both', authority: 'UPSTREAM', description: 'Código da moeda da transação (ex: BRL, USD)', aliases: ['Moeda da Transação', 'Currency', 'Moeda'], expectedOptions: ['BRL', 'USD', 'Outra'], optionMappings: { 'BRL': 'BRL', 'USD': 'USD', 'Outra': 'OTHER' }, allowExtraOptions: true },
      { domainField: 'canonicalHash', notionProperty: 'Hash Canônico', notionType: 'rich_text', direction: 'both', authority: 'DERIVADO', description: 'Fingerprint SHA-256 (64 chars) de versão', aliases: ['Hash', 'Fingerprint', 'Version Hash', 'Hash Canônico'] },
      { domainField: 'date', notionProperty: 'Data', notionType: 'date', direction: 'both', authority: 'UPSTREAM', description: 'Data da transação (ISO-8601)', aliases: ['Data Transacao', 'Data da Operação', 'Data Operação', 'Data'] },
      { domainField: 'amount', notionProperty: 'Valor', notionType: 'number', direction: 'both', authority: 'UPSTREAM', description: 'Valor monetário absoluto (R$)', aliases: ['Valor Transação', 'Valor Liquido', 'Total', 'Quantia', 'Valor'] },
      { domainField: 'rawAmount', notionProperty: 'Valor Bruto da Fonte', notionType: 'number', direction: 'write', authority: 'UPSTREAM', description: 'Valor exato retornado pelo conector/banco com sinal original', aliases: ['Valor Original', 'Valor Bruto', 'Valor Bruto Pierre', 'Valor Bruto da Fonte'] },
      { domainField: 'flowDirection', notionProperty: 'Movimento', notionType: 'select', direction: 'both', authority: 'UPSTREAM', description: 'Entrada ou Saída de caixa físico', aliases: ['Tipo', 'Direção', 'Direcao', 'Sentido', 'Fluxo', 'Movimento'], expectedOptions: ['Entrada', 'Saída'], optionMappings: { 'Entrada': 'INFLOW', 'Saída': 'OUTFLOW' } },
      { domainField: 'economicNature', notionProperty: 'Natureza Econômica', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Classificação contábil da operação', aliases: ['Natureza', 'Classificação Contábil', 'Classificacao', 'Natureza Econômica'], expectedOptions: ['Receita', 'Despesa', 'Aporte', 'Resgate', 'Transferência interna', 'Reembolso', 'Pagamento de fatura', 'Ajuste'], optionMappings: { 'Receita': 'OPERATING_REVENUE', 'Despesa': 'OPERATING_EXPENSE', 'Transferência interna': 'INTERNAL_TRANSFER', 'Transferência Interna': 'INTERNAL_TRANSFER', 'Reembolso': 'REIMBURSEMENT', 'Pagamento de fatura': 'CREDIT_CARD_SETTLEMENT', 'Pagamento de Fatura': 'CREDIT_CARD_SETTLEMENT', 'Ajuste': 'ACCOUNTING_ADJUSTMENT' }, allowExtraOptions: true },
      { domainField: 'budgetEffect', notionProperty: 'Efeito Orçamentário', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'INCOME | EXPENSE | REVERSAL | NEUTRAL', aliases: ['Efeito Orçamento', 'Impacto Orçamentário', 'Impacto Orcamentario', 'Efeito Orçamentário'], expectedOptions: ['Receita', 'Despesa', 'Estorno', 'Neutro'], optionMappings: { 'Receita': 'INCOME', 'Despesa': 'EXPENSE', 'Estorno': 'REVERSAL', 'Neutro': 'NEUTRAL' } },
      { domainField: 'allocationPurpose', notionProperty: 'Propósito de Alocação', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'INVESTMENT_RESERVE | OPERATIONAL_CASH | etc.', aliases: ['Propósito', 'Proposito', 'Finalidade', 'Alocação', 'Alocacao', 'Propósito de Alocação'], expectedOptions: ['Caixa Operacional', 'Reserva de Investimento', 'Reserva de Emergência', 'Poupança Geral'], optionMappings: { 'Caixa Operacional': 'OPERATIONAL_CASH', 'Reserva de Investimento': 'INVESTMENT_RESERVE', 'Reserva de Emergência': 'EMERGENCY_FUND', 'Poupança Geral': 'GENERAL_SAVINGS' } },
      { domainField: 'savingsGoalContribution', notionProperty: 'Contribuição Meta Poupança', notionType: 'number', direction: 'write', authority: 'REGRA_AUTOMATICA', description: 'Valor que pontua na meta de poupança (ex: R$ 500 aporte)', aliases: ['Poupança', 'Aporte Poupança', 'Contribuicao Poupanca', 'Contribuição Meta Poupança'] },
      { domainField: 'accountRelation', notionProperty: 'Conta', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Relação com base Contas', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Conta Bancária', 'Conta Origem', 'Conta'] },
      { domainField: 'destinationAccountRelation', notionProperty: 'Conta Destino', notionType: 'relation', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Conta de destino para transferências internas entre contas', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Conta Destino', 'Conta de Destino', 'Destino'] },
      { domainField: 'categoryRelation', notionProperty: 'Categoria', notionType: 'relation', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Relação com Categorias Financeiras', relationTargetEnvKey: 'NOTION_DS_CATEGORIES', aliases: ['Categoria Financeira', 'Categoria'] },
      { domainField: 'billRelation', notionProperty: 'Fatura Vinculada', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Relação com 13ª base Faturas / Ciclos', relationTargetEnvKey: 'NOTION_DS_CARD_BILLS', aliases: ['Fatura', 'Ciclo Fatura', 'Fatura Vinculada'] },
      { domainField: 'status', notionProperty: 'Status Banco', notionType: 'select', direction: 'write', authority: 'UPSTREAM', description: 'Pendente, Confirmado ou Cancelado', aliases: ['Status', 'Status Transação', 'Status Banco'], expectedOptions: ['Confirmado', 'Pendente', 'Cancelado'], optionMappings: { 'Confirmado': 'CONFIRMED', 'Pendente': 'PENDING', 'Cancelado': 'CANCELLED' }, allowExtraOptions: true },
      { domainField: 'reviewStatus', notionProperty: 'Status de Revisão', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Confirmado Auto, Pendente Revisão, Validado Manualmente, Legado Não Verificado', aliases: ['Revisão', 'Status Revisão', 'Revisao', 'Status de Revisão'], expectedOptions: ['Confirmado Auto', 'Provável', 'Pendente Revisão', 'Validado Manual', 'Legado Não Verificado'], optionMappings: { 'Confirmado Auto': 'AUTO_CONFIRMED', 'Provável': 'PROBABLE', 'Pendente Revisão': 'NEEDS_REVIEW', 'Validado Manual': 'MANUALLY_CONFIRMED', 'Legado Não Verificado': 'LEGACY_UNVERIFIED' } },
      { domainField: 'reviewReason', notionProperty: 'Motivo da Revisão', notionType: 'rich_text', direction: 'write', authority: 'REGRA_AUTOMATICA', description: 'Justificativa para intervenção humana', aliases: ['Motivo Revisão', 'Razão Revisão', 'Justificativa', 'Motivo da Revisão'] },
      { domainField: 'rawCategory', notionProperty: 'Categoria Pierre', notionType: 'rich_text', direction: 'write', authority: 'UPSTREAM', description: 'Categoria bruta do open-finance', aliases: ['Categoria Original', 'Categoria Aberta', 'Categoria Pierre', 'Categoria da Fonte'] },
      { domainField: 'rawDescription', notionProperty: 'Descrição Original', notionType: 'rich_text', direction: 'write', authority: 'UPSTREAM', description: 'Texto original do extrato', aliases: ['Descrição Bruta', 'Descricao Banco', 'Descrição Original', 'Descrição original'] },
      { domainField: 'counterpartyHmac', notionProperty: 'HMAC Contraparte', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'Hash seguro do CPF/CNPJ para matching sem expor PII', aliases: ['Hash Contraparte', 'HMAC', 'HMAC Contraparte'] },
    ],
  },

  NOTION_DS_CATEGORIES: {
    envKey: 'NOTION_DS_CATEGORIES',
    defaultTitle: 'Categorias Financeiras',
    isExisting: true,
    properties: [
      { domainField: 'name', notionProperty: 'Nome da Categoria', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'Nome da categoria', aliases: ['Categoria', 'Nome', 'Título', 'Nome da Categoria'] },
      { domainField: 'budgetGroup', notionProperty: 'Grupo Orçamentário', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Agrupamento macro orçamentário configurável (ex: Necessidade, Desejo, Poupança/Investimento, Fora do orçamento)', aliases: ['Grupo 50/30/20', 'Grupo', 'Grupo Orçamento', 'Agrupamento', 'Grupo Orçamentário'], expectedOptions: ['Necessidade', 'Desejo', 'Poupança/Investimento', 'Fora do orçamento'], optionMappings: { 'Necessidade': 'ESSENTIAL', 'Desejo': 'DISCRETIONARY', 'Poupança/Investimento': 'SAVINGS_INVESTMENT', 'Fora do orçamento': 'STRUCTURAL_NEUTRAL' }, allowExtraOptions: true },
      { domainField: 'variability', notionProperty: 'Variabilidade', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Fixa, Variável, N/A', aliases: ['Variabilidade da Despesa', 'Variabilidade da Conta', 'Frequência', 'Tipo de Custo', 'Variabilidade'], expectedOptions: ['Fixa', 'Variável', 'N/A'], optionMappings: { 'Fixa': 'FIXED', 'Variável': 'VARIABLE', 'N/A': 'NOT_APPLICABLE' }, allowExtraOptions: true },
      {
        domainField: 'defaultNature',
        notionProperty: 'Natureza Padrão',
        notionType: 'select',
        direction: 'both',
        authority: 'USUARIO',
        description: 'Natureza contábil sugerida (Receita, Despesa, Patrimonial, Mista)',
        aliases: ['Natureza Padrão Sugerida', 'Natureza', 'Natureza Padrão', 'Natureza padrão'],
        expectedOptions: ['Receita', 'Despesa', 'Patrimonial', 'Mista'],
        optionMappings: {
          'Receita': 'OPERATING_REVENUE',
          'Despesa': 'OPERATING_EXPENSE',
          'Patrimonial': 'CAPITAL_OR_EQUITY',
          'Mista': 'MIXED_SPLIT',
        },
        allowExtraOptions: true,
      },
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
      { domainField: 'assignNature', notionProperty: 'Atribuir: Natureza', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Natureza atribuída', aliases: ['Natureza resultante', 'Natureza Resultante', 'Natureza Contábil', 'Atribuir Natureza'], expectedOptions: ['Receita', 'Despesa', 'Aporte', 'Resgate', 'Transferência interna', 'Reembolso', 'Pagamento de fatura', 'Ajuste'], optionMappings: { 'Receita': 'OPERATING_REVENUE', 'Despesa': 'OPERATING_EXPENSE', 'Transferência interna': 'INTERNAL_TRANSFER', 'Transferência Interna': 'INTERNAL_TRANSFER', 'Reembolso': 'REIMBURSEMENT', 'Pagamento de fatura': 'CREDIT_CARD_SETTLEMENT', 'Pagamento de Fatura': 'CREDIT_CARD_SETTLEMENT', 'Ajuste': 'ACCOUNTING_ADJUSTMENT' }, allowExtraOptions: true },
      { domainField: 'assignBudgetEffect', notionProperty: 'Atribuir: Efeito Orçamento', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'INCOME, EXPENSE, REVERSAL, NEUTRAL', aliases: ['Efeito Orçamento Atribuído', 'Efeito Orçamento', 'Impacto Orçamentário'], expectedOptions: ['Receita', 'Despesa', 'Estorno', 'Neutro'] },
      { domainField: 'assignAllocationPurpose', notionProperty: 'Atribuir: Alocação', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Finalidade da movimentação', aliases: ['Finalidade Alocação', 'Propósito', 'Alocação'], expectedOptions: ['Caixa Operacional', 'Reserva de Investimento', 'Reserva de Emergência', 'Poupança Geral'] },
      { domainField: 'assignCategory', notionProperty: 'Atribuir: Categoria', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Categoria vinculada', relationTargetEnvKey: 'NOTION_DS_CATEGORIES', aliases: ['Categoria resultante', 'Categoria Resultante', 'Categoria Atribuída', 'Categoria'] },
      { domainField: 'assignDestinationAccount', notionProperty: 'Atribuir: Conta Destino', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Conta de destino atribuída para transferências internas', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Atribuir Conta Destino', 'Conta Destino Resultante', 'Conta Destino'] },
    ],
  },

  NOTION_DS_FIXED_BILLS: {
    envKey: 'NOTION_DS_FIXED_BILLS',
    defaultTitle: 'Contas Fixas',
    isExisting: true,
    properties: [
      { domainField: 'name', notionProperty: 'Nome da Conta Fixa', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'Nome do compromisso recorrente', aliases: ['Conta fixa', 'Conta Fixa', 'Serviço', 'Nome'] },
      { domainField: 'expectedAmount', notionProperty: 'Valor Previsto', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Valor esperado por competência', aliases: ['Valor esperado', 'Valor', 'Valor Mensal', 'Preço', 'Valor Previsto'] },
      { domainField: 'toleranceAmount', notionProperty: 'Tolerância (R$)', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Tolerância para conciliação automática', aliases: ['Tolerância de valor', 'Tolerância', 'Margem', 'Tolerância (R$)'] },
      { domainField: 'periodicity', notionProperty: 'Periodicidade', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Mensal, Bimestral, Trimestral, Semestral, Anual', aliases: ['Frequência', 'Recorrência', 'Periodicidade'], expectedOptions: ['Mensal', 'Bimestral', 'Trimestral', 'Semestral', 'Anual'] },
      { domainField: 'anchorCompetence', notionProperty: 'Competência Âncora', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Mês de referência inicial (ex: 2026-01)', aliases: ['Competência Inicial', 'Mês Início', 'Competência Âncora'] },
      { domainField: 'lastGeneratedCompetence', notionProperty: 'Última Competência Gerada', notionType: 'rich_text', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Último mês gerado em Obrigações (ex: 2026-08)', aliases: ['Último Mês Gerado', 'Última Competência Gerada'] },
      { domainField: 'dueDay', notionProperty: 'Dia de Vencimento', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Dia do mês do vencimento (1 a 31)', aliases: ['Dia do vencimento', 'Dia de Vencimento', 'Vencimento', 'Dia Venc'] },
      { domainField: 'paymentMethod', notionProperty: 'Forma de Pagamento', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Cartão, Débito, Pix, Boleto, Débito automático, Outro', aliases: ['Forma de pagamento', 'Forma de Pagamento', 'Meio de Pagamento', 'Método Pagamento'], expectedOptions: ['Cartão', 'Débito', 'Pix', 'Boleto', 'Débito automático', 'Outro'], optionMappings: { 'Cartão': 'CREDIT_CARD', 'Cartão de Crédito': 'CREDIT_CARD', 'Débito': 'BANK_DEBIT', 'Débito em Conta': 'BANK_DEBIT', 'Débito automático': 'BANK_DEBIT', 'Pix': 'PIX', 'Boleto': 'BOLETO', 'Outro': 'OTHER' }, allowExtraOptions: true },
      { domainField: 'defaultAccount', notionProperty: 'Conta Padrão', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Conta de débito usual', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Conta padrão', 'Conta Padrão', 'Conta', 'Conta Débito'] },
      { domainField: 'category', notionProperty: 'Categoria', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Categoria orçamentária', relationTargetEnvKey: 'NOTION_DS_CATEGORIES', aliases: ['Categoria Despesa', 'Categoria'] },
      { domainField: 'matchPattern', notionProperty: 'Padrão de Identificação', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Expressão / substring para conciliação automática', aliases: ['Regra de identificação', 'Padrão de Identificação', 'Regex', 'Identificador', 'Padrão'] },
      { domainField: 'isActive', notionProperty: 'Ativa', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Gera obrigações no período', aliases: ['Ativo', 'Ativa'] },
      { domainField: 'generateObligation', notionProperty: 'Gerar obrigação', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Se ativado, gera automaticamente os lançamentos em Obrigações Mensais a cada competência', aliases: ['Gerar Obrigação', 'Gerar Parcela', 'Gerar Lançamento', 'Gerar obrigação'] },
      { domainField: 'notes', notionProperty: 'Observações / Contrato', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Código do assinante, detalhes do contrato ou instruções', aliases: ['Observações', 'Notas', 'Contrato', 'Observações / Contrato'] },
      { domainField: 'validFrom', notionProperty: 'Data de Início', notionType: 'date', direction: 'both', authority: 'USUARIO', description: 'Início da vigência do contrato', aliases: ['Início Vigência', 'Vigência De', 'Data de Início'] },
      { domainField: 'validUntil', notionProperty: 'Data de Término', notionType: 'date', direction: 'both', authority: 'USUARIO', description: 'Término da vigência do contrato', aliases: ['Fim Vigência', 'Vigência Até', 'Data de Término'] },
    ],
  },

  NOTION_DS_MONTHLY_OBLIGATIONS: {
    envKey: 'NOTION_DS_MONTHLY_OBLIGATIONS',
    defaultTitle: 'Obrigações Mensais',
    isExisting: true,
    properties: [
      { domainField: 'title', notionProperty: 'Identificador', notionType: 'title', direction: 'both', authority: 'DERIVADO', description: 'Nome da Conta Fixa - YYYY-MM', aliases: ['Obrigação', 'Nome', 'Identificador Parcela', 'Identificador'] },
      { domainField: 'fixedBillRelation', notionProperty: 'Conta Fixa', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Relação com o cadastro permanente', relationTargetEnvKey: 'NOTION_DS_FIXED_BILLS', aliases: ['Conta fixa', 'Conta Fixa Origem', 'Contrato', 'Conta Fixa'] },
      { domainField: 'referenceDate', notionProperty: 'Referência', notionType: 'date', direction: 'both', authority: 'DERIVADO', description: 'Data de referência / competência para extração canônica de YYYY-MM', aliases: ['Referência', 'Competência', 'Mês', 'Data Referência'] },
      { domainField: 'dueDate', notionProperty: 'Data de Vencimento', notionType: 'date', direction: 'both', authority: 'DERIVADO', description: 'Data exata do vencimento', aliases: ['Vencimento', 'Data Limite', 'Data de Vencimento'] },
      { domainField: 'expectedAmount', notionProperty: 'Valor Previsto', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Valor esperado herdado da conta fixa', aliases: ['Valor previsto', 'Valor esperado', 'Valor Esperado', 'Valor Previsto'] },
      { domainField: 'status', notionProperty: 'Status', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Prevista, Paga, Atrasada, Revisão Necessária, Cancelada', aliases: ['Status Pagamento', 'Situação', 'Status'], expectedOptions: ['Prevista', 'Paga', 'Atrasada', 'Revisão Necessária', 'Cancelada'], optionMappings: { 'Prevista': 'PENDING', 'Pendente': 'PENDING', 'Paga': 'PAID', 'Atrasada': 'OVERDUE', 'Dispensada': 'DISMISSED', 'Revisão Necessária': 'NEEDS_REVIEW', 'Cancelada': 'CANCELLED' } },
      { domainField: 'paidAmount', notionProperty: 'Valor Pago', notionType: 'number', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Valor efetivamente liquidado', aliases: ['Valor pago', 'Valor Efetivo', 'Valor Liquidado', 'Valor Pago'] },
      { domainField: 'paidAt', notionProperty: 'Data do Pagamento', notionType: 'date', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Data em que ocorreu a quitação', aliases: ['Pago em', 'Data Quitação', 'Pago Em', 'Data do Pagamento'] },
      { domainField: 'matchedTransaction', notionProperty: 'Transação Vinculada', notionType: 'relation', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Relação com a transação que liquidou', relationTargetEnvKey: 'NOTION_DS_TRANSACTIONS', aliases: ['Transação conciliada', 'Transação', 'Comprovante', 'Transação Vinculada'] },
      { domainField: 'accountRelation', notionProperty: 'Conta', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Conta de débito efetiva', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Conta', 'Conta Débito'] },
      { domainField: 'origin', notionProperty: 'Origem', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Origem do registro da obrigação (Rotina, Manual, Pierre)', aliases: ['Origem da Obrigação', 'Proveniência', 'Origem'], expectedOptions: ['Rotina', 'Manual', 'Pierre'], optionMappings: { 'Rotina': 'ROUTINE', 'Manual': 'MANUAL', 'Pierre': 'PIERRE' }, allowExtraOptions: true },
      { domainField: 'autoValidated', notionProperty: 'Validado Automaticamente', notionType: 'checkbox', direction: 'write', authority: 'REGRA_AUTOMATICA', description: 'True se correspondência foi inequívoca', aliases: ['Validado automaticamente', 'Validado Auto', 'Conciliado Auto', 'Validado Automaticamente'] },
      { domainField: 'notes', notionProperty: 'Observações / Conflitos', notionType: 'rich_text', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Avisos de divergência ou ambiguidade', aliases: ['Observações', 'Avisos', 'Observações / Conflitos'] },
    ],
  },

  NOTION_DS_INVESTMENTS: {
    envKey: 'NOTION_DS_INVESTMENTS',
    defaultTitle: 'Investimentos',
    isExisting: true,
    properties: [
      { domainField: 'assetName', notionProperty: 'Ativo', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'Nome do ativo ou produto financeiro', aliases: ['Nome do Ativo', 'Nome', 'Produto', 'Papel', 'Ativo'] },
      {
        domainField: 'assetType',
        notionProperty: 'Classe do Ativo',
        notionType: 'select',
        direction: 'both',
        authority: 'USUARIO',
        description: 'Renda Fixa, Cripto, Ações, FIIs, ETFs, Previdência Privada, Tesouro Direto, Outros (Caixa Reservado NÃO é classe de ativo)',
        aliases: ['Classe', 'Tipo de Ativo', 'Categoria', 'Classe do Ativo'],
        expectedOptions: ['Ações', 'Cripto', 'FIIs', 'Renda Fixa', 'ETFs', 'Fundos', 'Caixa', 'Outro'],
        optionMappings: {
          'Ações': 'Ação',
          'Ação': 'Ação',
          'Cripto': 'Cripto',
          'FIIs': 'FII',
          'FII': 'FII',
          'Renda Fixa': 'Renda Fixa',
          'Renda fixa': 'Renda Fixa',
          'ETFs': 'ETF',
          'ETF': 'ETF',
          'Fundos': 'Fundo',
          'Fundo': 'Fundo',
          'Caixa': 'Caixa',
          'Outro': 'Outro',
          'Outros': 'Outros',
        },
        allowExtraOptions: true,
      },
      { domainField: 'origin', notionProperty: 'Custódia', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Conta Pierre ou Carteira Externa', aliases: ['Origem', 'Instituição Custódia', 'Custódia'] },
      { domainField: 'currency', notionProperty: 'Moeda', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Código da moeda do ativo (BRL, USD)', aliases: ['Moeda do Ativo', 'Moeda', 'Currency'], expectedOptions: ['BRL', 'USD', 'Outra'], optionMappings: { 'BRL': 'BRL', 'USD': 'USD', 'Outra': 'OTHER' }, allowExtraOptions: true },
      { domainField: 'quantity', notionProperty: 'Quantidade', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Posição atual custodiada', aliases: ['Posição', 'Qtd', 'Cotas / Ações', 'Quantidade'] },
      { domainField: 'unitAveragePrice', notionProperty: 'Preço Médio Unitário (PMP)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Preço médio ponderado unitário de aquisição', aliases: ['Preço Médio', 'PMP', 'PM', 'Preço de Aquisição', 'Preço Médio Unitário (PMP)'] },
      { domainField: 'totalCostBasis', notionProperty: 'Custo Base Total', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Montante total acumulado desembolsado nas compras (base de custo contábil)', aliases: ['Custo acumulado', 'Custo Acumulado', 'Custo Total', 'Total Investido', 'Custo Histórico', 'Custo Base Total'] },
      { domainField: 'currentMarketValue', notionProperty: 'Valor de Mercado Atual', notionType: 'number', direction: 'both', authority: 'UPSTREAM', description: 'Posição a mercado: Cotação atual x quantidade', aliases: ['Valor atual', 'Valor Atual', 'Saldo Atual', 'Posição Atual', 'Valor de Mercado', 'Patrimônio Atual', 'Valor de Mercado Atual'] },
      { domainField: 'unrealizedProfitLoss', notionProperty: 'Lucro / Prejuízo Não Realizado', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Valor de Mercado Atual - Custo Base Total', aliases: ['Lucro/Prejuízo', 'Rentabilidade (R$)', 'Resultado', 'Lucro / Prejuízo Não Realizado'] },
      { domainField: 'profitLossPercentage', notionProperty: 'Retorno Não Realizado (%)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: '((Valor de Mercado Atual - Custo Base Total) / Custo Base Total) * 100', aliases: ['Rentabilidade (%)', 'Retorno (%)', 'Retorno Não Realizado (%)'] },
      { domainField: 'liquidity', notionProperty: 'Liquidez', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Prazo de liquidez livre (ex: D+0, D+1, D+30, No Vencimento)', aliases: ['Prazo Liquidez', 'Liquidez Resgate', 'Liquidez'] },
      { domainField: 'valuationSource', notionProperty: 'Fonte da Avaliação', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Origem da cotação a mercado (ex: Pierre, Manual, Mercado, Outra)', aliases: ['Fonte do preço', 'Fonte do Preço', 'Fonte Avaliação', 'Fonte Cotação', 'Fonte da Avaliação'], expectedOptions: ['Pierre', 'Mercado', 'Manual', 'Outra'], optionMappings: { 'Pierre': 'PIERRE', 'Manual': 'MANUAL', 'Mercado': 'MARKET', 'Outra': 'OTHER' }, allowExtraOptions: true },
      { domainField: 'valuationDate', notionProperty: 'Data da Avaliação', notionType: 'date', direction: 'both', authority: 'DERIVADO', description: 'Data/hora da última cotação de mercado capturada', aliases: ['Data da avaliação', 'Data da Avaliação', 'Data Avaliação', 'Última Cotação'] },
      { domainField: 'includeInNetWorth', notionProperty: 'Incluir no Patrimônio', notionType: 'checkbox', direction: 'both', authority: 'USUARIO', description: 'Indica se esta posição deve compor o cálculo de patrimônio líquido final', aliases: ['Inclui no patrimônio', 'Incluir Patrimônio', 'Compor Patrimônio', 'Patrimônio Líquido', 'Incluir no Patrimônio'] },
      { domainField: 'institution', notionProperty: 'Instituição / Corretora', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Corretora ou custodiante do investimento (ex: NuInvest, Binance, XP, BTG)', aliases: ['Instituição', 'Instituicao', 'Corretora', 'Custodiante', 'Instituição / Corretora'] },
      { domainField: 'sourceAssetId', notionProperty: 'ID do Ativo na Fonte', notionType: 'rich_text', direction: 'both', authority: 'UPSTREAM', description: 'Identificador único do ativo na API de origem para sincronização', aliases: ['ID da fonte', 'ID da Fonte', 'ID Fonte', 'Asset ID', 'Código do Ativo', 'ID do Ativo na Fonte'] },
      { domainField: 'linkedAccount', notionProperty: 'Conta Vinculada', notionType: 'relation', direction: 'both', authority: 'USUARIO', description: 'Conta corrente ou corretora associada', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Conta Corretora', 'Conta', 'Conta Vinculada'] },
    ],
  },

  NOTION_DS_INVESTMENT_MOVEMENTS: {
    envKey: 'NOTION_DS_INVESTMENT_MOVEMENTS',
    defaultTitle: 'Movimentações de Investimentos',
    isExisting: true,
    properties: [
      { domainField: 'title', notionProperty: 'Movimentação', notionType: 'title', direction: 'both', authority: 'DERIVADO', description: 'Título unívoco da movimentação', aliases: ['Identificador', 'Título', 'Nome', 'Operação', 'Movimentação'] },
      { domainField: 'investmentRelation', notionProperty: 'Ativo Vinculado', notionType: 'relation', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Relação com a posição do ativo', relationTargetEnvKey: 'NOTION_DS_INVESTMENTS', aliases: ['Ativo', 'Investimento Vinculado', 'Ativo Vinculado'] },
      {
        domainField: 'movementType',
        notionProperty: 'Tipo de Movimentação',
        notionType: 'select',
        direction: 'both',
        authority: 'REGRA_AUTOMATICA',
        description: 'Aporte de Capital, Resgate de Capital, Compra de Ativo, Venda de Ativo, Rendimento / Provento, Taxas e Impostos, Ajuste de Posição',
        aliases: ['Tipo', 'Operação', 'Tipo de Movimentação'],
        expectedOptions: ['Aporte', 'Compra', 'Venda', 'Rendimento', 'Resgate', 'Taxa', 'Transferência', 'Ajuste'],
        optionMappings: {
          'Aporte': 'CAPITAL_CONTRIBUTION',
          'Aporte de Capital': 'CAPITAL_CONTRIBUTION',
          'Compra': 'ASSET_PURCHASE',
          'Compra de Ativo': 'ASSET_PURCHASE',
          'Venda': 'ASSET_SALE',
          'Venda de Ativo': 'ASSET_SALE',
          'Rendimento': 'INVESTMENT_INCOME',
          'Rendimento / Provento': 'INVESTMENT_INCOME',
          'Resgate': 'ASSET_REDEMPTION',
          'Resgate de Capital': 'ASSET_REDEMPTION',
          'Taxa': 'FEE_TAX',
          'Taxas e Impostos': 'FEE_TAX',
          'Transferência': 'INTERNAL_TRANSFER',
          'Ajuste': 'POSITION_ADJUSTMENT',
          'Ajuste de Posição': 'POSITION_ADJUSTMENT',
        },
        allowExtraOptions: true,
      },
      { domainField: 'date', notionProperty: 'Data da Operação', notionType: 'date', direction: 'both', authority: 'UPSTREAM', description: 'Data da execução', aliases: ['Data', 'Data Operação', 'Data da Operação'] },
      { domainField: 'grossAmount', notionProperty: 'Valor Bruto', notionType: 'number', direction: 'both', authority: 'UPSTREAM', description: 'Volume financeiro total', aliases: ['Valor', 'Valor Total', 'Montante', 'Valor Bruto'] },
      { domainField: 'netCashEffect', notionProperty: 'Impacto Líquido de Caixa', notionType: 'number', direction: 'both', authority: 'DERIVADO', description: 'Efeito líquido de caixa com sinal econômico direcional (compra = negativo, venda = positivo)', aliases: ['Valor Líquido', 'Valor Líquido Operação', 'Impacto Caixa', 'Impacto Líquido de Caixa'] },
      { domainField: 'quantity', notionProperty: 'Quantidade Negociada', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Fração ou unidades transacionadas', aliases: ['Quantidade', 'Cotas', 'Quantidade Negociada'] },
      { domainField: 'unitPrice', notionProperty: 'Preço Unitário', notionType: 'number', direction: 'both', authority: 'DERIVADO', description: 'Preço médio da ordem', aliases: ['Preço unitário', 'Preço Unitário', 'Preço Médio Operação', 'Cotação'] },
      { domainField: 'sourceAccount', notionProperty: 'Conta Origem', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Conta debitada', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Conta origem', 'Conta Débito', 'Origem', 'Conta Origem'] },
      { domainField: 'destinationAccount', notionProperty: 'Conta Destino / Caixa', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Conta creditada', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Conta Crédito', 'Destino', 'Conta Destino / Caixa'] },
      { domainField: 'relatedTransaction', notionProperty: 'Transação Financeira', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Transação bancária vinculada', relationTargetEnvKey: 'NOTION_DS_TRANSACTIONS', aliases: ['Transação origem', 'Transação Bancária', 'Transação Financeira'] },
    ],
  },

  NOTION_DS_MONTHLY_BUDGET: {
    envKey: 'NOTION_DS_MONTHLY_BUDGET',
    defaultTitle: 'Planejamento Mensal',
    isExisting: true,
    properties: [
      { domainField: 'competence', notionProperty: 'Competência', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'YYYY-MM', aliases: ['Mês', 'Competência Planejamento', 'Competência'] },
      { domainField: 'netIncomePlanned', notionProperty: 'Renda Prevista', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Meta de renda do mês', aliases: ['Renda planejada', 'Renda Alvo', 'Renda Estimada', 'Renda Prevista'] },
      { domainField: 'cardSpendBudget', notionProperty: 'Teto Mensal Cartão', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Teto pessoal de compras no cartão (ex: R$ 400)', aliases: ['Teto pessoal de crédito', 'Teto Cartão', 'Limite Cartão', 'Teto Mensal Cartão'] },
      { domainField: 'savingsGoalPlanned', notionProperty: 'Meta de Poupança/Aporte', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Meta de dinheiro a poupar no mês', aliases: ['Aporte planejado', 'Meta Poupança', 'Meta Aporte', 'Meta de Poupança/Aporte'] },
      { domainField: 'budgetGroupTargets', notionProperty: 'Metas por Grupo Orçamentário', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Metas percentuais ou tetos nominais por grupo orçamentário configurável', aliases: ['Metas 50/30/20', 'Tetos por Grupo', 'Metas por Grupo Orçamentário'] },
      { domainField: 'savingsRateTarget', notionProperty: 'Meta Taxa de Poupança (%)', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Percentual alvo da renda líquida destinado a investimentos e reservas', aliases: ['Meta de poupança %', 'Taxa Poupança Alvo (%)', 'Meta Taxa de Poupança (%)'] },
      { domainField: 'realizedIncome', notionProperty: 'Receitas Realizadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma de transações OPERATING_REVENUE', aliases: ['Renda Realizada', 'Receitas Realizadas'] },
      { domainField: 'realizedExpenses', notionProperty: 'Despesas Realizadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma de transações OPERATING_EXPENSE', aliases: ['Despesas Realizadas'] },
      { domainField: 'realizedSavings', notionProperty: 'Poupança Realizada', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma de transações com savingsGoalContribution', aliases: ['Poupança Efetiva', 'Poupança Realizada'] },
      { domainField: 'cardSpendRealized', notionProperty: 'Compras Realizadas Cartão', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma de compras de cartão no mês', aliases: ['Gasto Cartão Realizado', 'Compras Realizadas Cartão'] },
    ],
  },

  NOTION_DS_FINANCIAL_GOALS: {
    envKey: 'NOTION_DS_FINANCIAL_GOALS',
    defaultTitle: 'Metas Financeiras',
    isExisting: true,
    properties: [
      { domainField: 'name', notionProperty: 'Meta', notionType: 'title', direction: 'both', authority: 'USUARIO', description: 'Nome do objetivo financeiro', aliases: ['Objetivo', 'Nome da Meta', 'Meta'] },
      { domainField: 'targetAmount', notionProperty: 'Valor Alvo', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Montante financeiro desejado', aliases: ['Valor alvo', 'Valor da Meta', 'Total Alvo', 'Valor Alvo'] },
      { domainField: 'currentAmount', notionProperty: 'Valor Atual Acumulado', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Saldo alocado para a meta', aliases: ['Valor atual', 'Saldo Atual', 'Montante Acumulado', 'Valor Atual Acumulado'] },
      { domainField: 'deadline', notionProperty: 'Prazo Alvo', notionType: 'date', direction: 'both', authority: 'USUARIO', description: 'Data limite para cumprimento', aliases: ['Prazo', 'Data Alvo', 'Prazo Alvo'] },
      { domainField: 'plannedMonthlyContribution', notionProperty: 'Aporte Mensal Planejado', notionType: 'number', direction: 'both', authority: 'USUARIO', description: 'Aporte mensal planejado para a meta', aliases: ['Aporte mensal planejado', 'Aporte Planejado', 'Aporte Mensal Planejado'] },
      { domainField: 'goalType', notionProperty: 'Tipo', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Classificação da meta (Reserva de emergência, Compra, Viagem, Investimento, Quitação, Outro)', aliases: ['Tipo de Meta', 'Categoria Meta', 'Tipo'], expectedOptions: ['Reserva de emergência', 'Compra', 'Viagem', 'Investimento', 'Quitação', 'Outro'], optionMappings: { 'Reserva de emergência': 'EMERGENCY_FUND', 'Compra': 'PURCHASE', 'Viagem': 'TRAVEL', 'Investimento': 'INVESTMENT', 'Quitação': 'DEBT_PAYOFF', 'Outro': 'OTHER' }, allowExtraOptions: true },
      { domainField: 'requiredLiquidity', notionProperty: 'Liquidez Necessária', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Prazo/perfil de liquidez necessária para a meta (Imediata, Curta, Média, Longa)', aliases: ['Liquidez necessária', 'Liquidez', 'Liquidez Necessária'], expectedOptions: ['Imediata', 'Curta', 'Média', 'Longa'], optionMappings: { 'Imediata': 'IMMEDIATE', 'Curta': 'SHORT_TERM', 'Média': 'MEDIUM_TERM', 'Longa': 'LONG_TERM', 'Curto Prazo': 'SHORT_TERM', 'Médio Prazo': 'MEDIUM_TERM', 'Longo Prazo': 'LONG_TERM' }, allowExtraOptions: true },
      { domainField: 'priority', notionProperty: 'Prioridade', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Nível de prioridade da meta (Alta, Média, Baixa)', aliases: ['Prioridade da Meta', 'Prioridade'], expectedOptions: ['Alta', 'Média', 'Baixa'], allowExtraOptions: true },
      { domainField: 'status', notionProperty: 'Status', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Andamento da meta (Planejada, Em andamento, Concluída, Pausada)', aliases: ['Status Meta', 'Situação', 'Status'], expectedOptions: ['Planejada', 'Em andamento', 'Concluída', 'Pausada'], optionMappings: { 'Planejada': 'PLANNED', 'Em andamento': 'IN_PROGRESS', 'Concluída': 'COMPLETED', 'Pausada': 'PAUSED', 'Não iniciada': 'PLANNED' }, allowExtraOptions: true },
      { domainField: 'notes', notionProperty: 'Observações', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Anotações gerais sobre a meta', aliases: ['Observações', 'Notas', 'Comentários'] },
    ],
  },

  NOTION_DS_MONTHLY_CLOSINGS: {
    envKey: 'NOTION_DS_MONTHLY_CLOSINGS',
    defaultTitle: 'Fechamentos Mensais',
    isExisting: true,
    properties: [
      { domainField: 'title', notionProperty: 'Mês de Referência', notionType: 'title', direction: 'both', authority: 'DERIVADO', description: 'Fechamento YYYY-MM', aliases: ['Fechamento', 'Mês', 'Competência', 'Mês de Referência'] },
      { domainField: 'status', notionProperty: 'Status do Fechamento', notionType: 'select', direction: 'both', authority: 'USUARIO', description: 'Aberto, Em revisão, Fechado', aliases: ['Status', 'Situação', 'Status do Fechamento'], expectedOptions: ['Aberto', 'Em revisão', 'Fechado'], optionMappings: { 'Aberto': 'OPEN', 'Em revisão': 'PRE_CLOSED', 'Fechado': 'CLOSED' }, allowExtraOptions: true },
      { domainField: 'reconciliationStatus', notionProperty: 'Status de Reconciliação', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Conciliado Integralmente, Divergências Pendentes, Reconciliação Manual Necessária', aliases: ['Status Reconciliação', 'Reconciliação', 'Status de Reconciliação'], expectedOptions: ['Conciliado Integralmente', 'Divergências Pendentes', 'Reconciliação Manual Necessária'] },
      { domainField: 'dataQualityScore', notionProperty: 'Qualidade dos Dados', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Nota ou classificação da confiabilidade dos lançamentos do mês', aliases: ['Qualidade dos dados', 'Qualidade Dados', 'Confiabilidade Dados', 'Qualidade dos Dados'], expectedOptions: ['Alta', 'Média', 'Baixa'], optionMappings: { 'Alta': 'HIGH', 'Média': 'MEDIUM', 'Baixa': 'LOW' }, allowExtraOptions: true },
      { domainField: 'initialNetWorth', notionProperty: 'Patrimônio Inicial', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Patrimônio líquido consolidado no início do mês', aliases: ['Patrimônio Inicial Consolidado', 'Patrimônio Inicial'] },
      { domainField: 'totalIncome', notionProperty: 'Renda Consolidada', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Total de receitas operacionais líquidas', aliases: ['Receitas', 'Total Receitas', 'Receita Líquida', 'Renda Consolidada'] },
      { domainField: 'totalExpenses', notionProperty: 'Despesas Consolidadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Total de despesas correntes de subsistência e consumo', aliases: ['Despesas', 'Total Despesas', 'Gastos Totais', 'Despesas Consolidadas'] },
      { domainField: 'essentialExpenses', notionProperty: 'Despesas Essenciais (Necessidades)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Gastos essenciais de moradia, saúde, alimentação básica', aliases: ['Gastos Essenciais', 'Necessidades (50%)', 'Despesas Essenciais (Necessidades)'] },
      { domainField: 'discretionaryExpenses', notionProperty: 'Despesas Discricionárias (Desejos)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Gastos de estilo de vida, lazer e compras', aliases: ['Gastos Discricionários', 'Desejos (30%)', 'Despesas Discricionárias (Desejos)'] },
      { domainField: 'operatingSurplus', notionProperty: 'Resultado do Mês (Sobra Operacional)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Renda Consolidada - Despesas Consolidadas (fluxo de caixa operacional livre do mês antes de aportes)', aliases: ['Sobra Operacional', 'Superávit Operacional', 'Resultado do Mês (Sobra Operacional)'] },
      { domainField: 'savingsAndInvestments', notionProperty: 'Poupança / Aportes Realizados', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Total efetivamente poupado e transferido para investimentos no mês', aliases: ['Aportes', 'Poupança Realizada', 'Poupança / Aportes Realizados'] },
      { domainField: 'savingsRate', notionProperty: 'Taxa de Poupança (%)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: '(Poupança / Aportes Realizados / Renda Consolidada) * 100', aliases: ['Taxa de Poupança Efetiva (%)', 'Taxa de Poupança (%)'] },
      { domainField: 'unallocatedCashFlow', notionProperty: 'Fluxo Residual Não Alocado', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Sobra Operacional - Poupança/Aportes Realizados', aliases: ['Fluxo Residual', 'Fluxo Residual Não Alocado'] },
      { domainField: 'investmentYield', notionProperty: 'Rendimentos de Investimentos', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Rendimentos e dividendos auferidos no mês', aliases: ['Rendimentos', 'Dividendos e Juros', 'Rendimentos de Investimentos'] },
      { domainField: 'finalNetWorth', notionProperty: 'Patrimônio Líquido Final', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Saldo contas + investimentos - dívidas ao fechar o mês', aliases: ['Patrimônio final', 'Patrimônio Líquido Final Consolidado', 'Patrimônio Líquido Final'] },
      { domainField: 'netWorthChange', notionProperty: 'Variação Patrimonial', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Patrimônio Final - Patrimônio Inicial', aliases: ['Evolução Patrimonial', 'Delta Patrimônio', 'Variação Patrimonial'] },
      { domainField: 'fixedBillsPaidCount', notionProperty: 'Contas Fixas Pagas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Contagem de obrigações fixas da competência com status Paga', aliases: ['Contas fixas pagas', 'Contas Fixas Liquidadas', 'Obrigações Pagas', 'Contas Fixas Pagas'] },
      { domainField: 'fixedBillsPendingCount', notionProperty: 'Contas Fixas Pendentes', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Contagem de obrigações fixas da competência ainda pendentes ou atrasadas', aliases: ['Contas fixas pendentes', 'Contas Fixas em Aberto', 'Obrigações Pendentes', 'Contas Fixas Pendentes'] },
      { domainField: 'itemsNeedingReviewCount', notionProperty: 'Itens para Revisão', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Contagem de transações ou lançamentos da competência aguardando revisão humana', aliases: ['Itens para revisão', 'Itens Pendentes Revisão', 'Transações em Revisão', 'Itens Para Revisão'] },
      { domainField: 'closedAt', notionProperty: 'Fechado Em', notionType: 'date', direction: 'both', authority: 'USUARIO', description: 'Data/hora em que o fechamento mensal foi consolidado e trancado', aliases: ['Fechado em', 'Data do Fechamento', 'Data Fechamento', 'Fechado Em'] },
      { domainField: 'notes', notionProperty: 'Observações / Notas do Fechamento', notionType: 'rich_text', direction: 'both', authority: 'USUARIO', description: 'Comentários qualitativos sobre desvios e conquistas do mês', aliases: ['Observações', 'Notas', 'Observações / Notas do Fechamento'] },
    ],
  },

  NOTION_DS_SYNC_LOG: {
    envKey: 'NOTION_DS_SYNC_LOG',
    defaultTitle: 'Log de Sincronização',
    isExisting: true,
    properties: [
      { domainField: 'title', notionProperty: 'Execução', notionType: 'title', direction: 'write', authority: 'DERIVADO', description: 'Sync - YYYY-MM-DD HH:mm:ss', aliases: ['Execução Sync', 'Título', 'Execução'] },
      {
        domainField: 'status',
        notionProperty: 'Status',
        notionType: 'select',
        direction: 'write',
        authority: 'DERIVADO',
        description: 'Sucesso, Parcial, Erro, Executando',
        aliases: ['Resultado', 'Status Execução', 'Status'],
        expectedOptions: ['Sucesso', 'Parcial', 'Erro', 'Executando'],
        optionMappings: {
          'Sucesso': 'SUCCESS',
          'Parcial': 'PARTIAL_SUCCESS',
          'Sucesso Parcial': 'PARTIAL_SUCCESS',
          'Erro': 'ERROR',
          'Executando': 'RUNNING',
        },
        allowExtraOptions: true,
      },
      {
        domainField: 'syncSource',
        notionProperty: 'Fonte',
        notionType: 'select',
        direction: 'write',
        authority: 'DERIVADO',
        description: 'Sistema ou conector de origem da sincronização (ex: Pierre, Manual, Migração)',
        aliases: ['Fonte de Sincronização', 'Origem Sincronização', 'Source', 'Fonte'],
        expectedOptions: ['Pierre', 'Manual', 'Migração'],
        optionMappings: {
          'Pierre': 'PIERRE',
          'Manual': 'MANUAL',
          'Migração': 'MIGRATION',
          'Outra': 'OTHER',
        },
        allowExtraOptions: true,
      },
      { domainField: 'startedAt', notionProperty: 'Data Início', notionType: 'date', direction: 'write', authority: 'DERIVADO', description: 'Timestamp do início da sincronização', aliases: ['Iniciada em', 'Início', 'Timestamp Início', 'Data Início'] },
      { domainField: 'endedAt', notionProperty: 'Data Fim', notionType: 'date', direction: 'write', authority: 'DERIVADO', description: 'Timestamp do término da sincronização', aliases: ['Concluída em', 'Término', 'Timestamp Fim', 'Data Fim'] },
      { domainField: 'durationSeconds', notionProperty: 'Duração (s)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Tempo total de processamento em segundos', aliases: ['Duração (segundos)', 'Tempo Total (s)', 'Duração (s)'] },
      { domainField: 'durationMs', notionProperty: 'Duração (ms)', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Tempo total de processamento em milissegundos', aliases: ['Tempo de Execução (ms)', 'Duração (ms)'] },
      { domainField: 'accountsSynced', notionProperty: 'Contas Processadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Quantidade de contas sincronizadas', aliases: ['Contas recebidas', 'Contas Sincronizadas', 'Contas Processadas'] },
      { domainField: 'transactionsReceived', notionProperty: 'Transações Recebidas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Lançamentos retornados pelo Pierre', aliases: ['Transações recebidas', 'Lançamentos Recebidos', 'Transações Recebidas'] },
      { domainField: 'transactionsCreated', notionProperty: 'Transações Novas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Novas páginas criadas', aliases: ['Transações novas', 'Novas Transações', 'Criadas', 'Transações Novas'] },
      { domainField: 'transactionsUpdated', notionProperty: 'Transações Atualizadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Páginas existentes com versionHash alterado', aliases: ['Transações atualizadas', 'Transações Modificadas', 'Atualizadas', 'Transações Atualizadas'] },
      { domainField: 'transactionsUnchanged', notionProperty: 'Transações Inalteradas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Transações sem alteração ignoradas', aliases: ['Transações Iguais', 'Ignoradas', 'Transações Inalteradas'] },
      { domainField: 'errorsCount', notionProperty: 'Erros Encontrados', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Total de falhas ou exceções não fatais registradas durante o lote', aliases: ['Quantidade de Erros', 'Total Erros', 'Erros Encontrados'] },
      { domainField: 'installmentsReceived', notionProperty: 'Parcelas Recebidas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Parcelamentos e faturas futuras identificadas', aliases: ['Parcelas recebidas', 'Faturas e Parcelas', 'Parcelas Recebidas'] },
      { domainField: 'reviewQueueCount', notionProperty: 'Enviadas para Revisão', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Transações marcadas como Pendente Revisão', aliases: ['Pendências de revisão', 'Fila de Revisão', 'Pendentes Revisão', 'Enviadas para Revisão'] },
      { domainField: 'obligationsReconciled', notionProperty: 'Obrigações Conciliadas', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Compromissos mensais liquidados com sucesso', aliases: ['Compromissos Conciliados', 'Obrigações Conciliadas'] },
      { domainField: 'sourceFreshness', notionProperty: 'Freshness da Fonte', notionType: 'date', direction: 'write', authority: 'DERIVADO', description: 'Momento do último dado retornado pelo banco / open finance', aliases: ['Freshness da fonte', 'Atualidade dos Dados', 'Freshness', 'Freshness da Fonte'] },
      { domainField: 'runId', notionProperty: 'ID da Execução (Run ID)', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'UUID unívoco da execução do worker', aliases: ['ID Execução', 'Execution ID', 'ID da Execução (Run ID)'] },
      { domainField: 'errorCode', notionProperty: 'Código do Erro', notionType: 'select', direction: 'write', authority: 'DERIVADO', description: 'Código padronizado de erro (ex: AUTH_EXPIRED, NETWORK_TIMEOUT, VALIDATION_ERROR, CONCURRENCY_LOCKED)', aliases: ['Tipo Erro', 'Error Code', 'Código do Erro'], allowExtraOptions: true },
      { domainField: 'sanitizedErrorMessage', notionProperty: 'Mensagem de Erro Sanitizada', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'Mensagem descritiva tratada, sem stack trace ou dados sensíveis', aliases: ['Erro / alerta', 'Mensagem Erro', 'Erro Detalhado', 'Mensagem de Erro Sanitizada'] },
      { domainField: 'privateLogRef', notionProperty: 'Referência do Log Privado', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'Identificador do registro detalhado no armazenamento privado cifrado', aliases: ['Caminho Log', 'Log Ref', 'Referência do Log Privado'] },
      { domainField: 'rawBatchHash', notionProperty: 'Hash do Lote RAW', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'SHA-256 do payload bruto salvo no cofre cifrado', aliases: ['Hash RAW', 'Payload Hash', 'Hash do Lote RAW'] },
      { domainField: 'workerCommit', notionProperty: 'Versão do Worker / Commit', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'Commit SHA ou tag da versão do worker em execução', aliases: ['Git Commit', 'Versão Worker', 'Versão do Worker / Commit'] },
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
      { domainField: 'title', notionProperty: 'Fatura / Ciclo', notionType: 'title', direction: 'write', authority: 'DERIVADO', description: 'Ex: Nubank - Ciclo 2026-07 (Venc 22/07)', aliases: ['Título', 'Ciclo', 'Nome'] },
      { domainField: 'source', notionProperty: 'Fonte', notionType: 'select', direction: 'write', authority: 'UPSTREAM', description: 'Conector de proveniência da fatura (PIERRE, MANUAL, MIGRATION, OTHER) - instituição bancária vem de Cartão Vinculado', aliases: ['Origem', 'Conector', 'Sistema'], expectedOptions: ['Pierre', 'Manual', 'Migração', 'Outra'], optionMappings: { 'Pierre': 'PIERRE', 'Manual': 'MANUAL', 'Migração': 'MIGRATION', 'Outra': 'OTHER' }, allowExtraOptions: true },
      { domainField: 'sourceBillId', notionProperty: 'ID da Fatura na Fonte', notionType: 'rich_text', direction: 'write', authority: 'UPSTREAM', description: 'Identificador primário bruto retornado pela API ou fatura externa', aliases: ['ID da fatura', 'Bill ID', 'Source Bill ID'] },
      { domainField: 'stableBillId', notionProperty: 'ID Estável da Fatura', notionType: 'rich_text', direction: 'write', authority: 'DERIVADO', description: 'Chave canônica unívoca (source:account_id:bill_id ou fallback completo)', aliases: ['ID Estável', 'Stable ID'] },
      { domainField: 'identityQuality', notionProperty: 'Qualidade da Identidade', notionType: 'select', direction: 'write', authority: 'DERIVADO', description: 'SOURCE_ID ou PERIOD_FALLBACK para reconciliação/rekeying', aliases: ['Tipo de Identidade', 'Identity Quality'], expectedOptions: ['SOURCE_ID', 'PERIOD_FALLBACK'], allowExtraOptions: true },
      { domainField: 'accountRelation', notionProperty: 'Cartão Vinculado', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Relação com a conta do cartão em Contas', relationTargetEnvKey: 'NOTION_DS_ACCOUNTS', aliases: ['Cartão', 'Conta Cartão'] },
      { domainField: 'currency', notionProperty: 'Moeda', notionType: 'select', direction: 'write', authority: 'UPSTREAM', description: 'Código da moeda da fatura (BRL, USD, EUR)', aliases: ['Moeda da Fatura', 'Currency'], expectedOptions: ['BRL', 'USD', 'EUR'] },
      { domainField: 'periodStart', notionProperty: 'Início do Período', notionType: 'date', direction: 'write', authority: 'DERIVADO', description: 'Data inicial das compras elegíveis ao ciclo', aliases: ['Data Início', 'Início Período'] },
      { domainField: 'periodEnd', notionProperty: 'Fim do Período', notionType: 'date', direction: 'write', authority: 'DERIVADO', description: 'Data final de corte das compras elegíveis ao ciclo', aliases: ['Data Fim', 'Fim Período'] },
      { domainField: 'closingDate', notionProperty: 'Data de Fechamento', notionType: 'date', direction: 'write', authority: 'UPSTREAM', description: 'Data oficial de corte da fatura emitida pelo banco', aliases: ['Fechamento', 'Data Corte'] },
      { domainField: 'dueDate', notionProperty: 'Data de Vencimento', notionType: 'date', direction: 'write', authority: 'UPSTREAM', description: 'Data oficial de vencimento da fatura emitida pelo banco', aliases: ['Vencimento', 'Data Venc'] },
      { domainField: 'cycleType', notionProperty: 'Tipo de Ciclo', notionType: 'select', direction: 'write', authority: 'DERIVADO', description: 'Ciclo Real Banco, Ciclo Configurado, Ciclo Estimado', aliases: ['Tipo Ciclo'], expectedOptions: ['Ciclo Real Banco', 'Ciclo Configurado', 'Ciclo Estimado'] },
      { domainField: 'valueQuality', notionProperty: 'Origem / Qualidade dos Dados', notionType: 'select', direction: 'write', authority: 'DERIVADO', description: 'Qualidade do valor da fatura: UPSTREAM_OFFICIAL, UPSTREAM_APPROXIMATE, DERIVED, MANUAL', aliases: ['Qualidade do Valor', 'Qualidade dos Dados', 'Origem dos Dados'], expectedOptions: ['UPSTREAM_OFFICIAL', 'UPSTREAM_APPROXIMATE', 'DERIVED', 'MANUAL'], allowExtraOptions: true },
      { domainField: 'status', notionProperty: 'Status da Fatura', notionType: 'select', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Aberta em Curso, Fechada a Vencer, Vencida, Paga Integralmente, Paga Parcialmente', aliases: ['Status Fatura', 'Situação'], expectedOptions: ['Aberta em Curso', 'Fechada a Vencer', 'Vencida', 'Paga Integralmente', 'Paga Parcialmente'] },
      { domainField: 'officialClosedBillAmount', notionProperty: 'Valor da Fatura Fechada (Oficial)', notionType: 'number', direction: 'write', authority: 'UPSTREAM', description: 'Valor consolidado oficial emitido pelo banco após fechamento. Estritamente null enquanto fatura aberta.', aliases: ['Valor Oficial', 'Valor Fechado', 'Valor da Fatura (Banco)', 'Total Fatura'] },
      { domainField: 'estimatedOpenBillAmount', notionProperty: 'Valor Estimado da Fatura Aberta', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Projeção acumulada das compras correntes antes do corte', aliases: ['Valor Estimado', 'Estimativa Aberta'] },
      { domainField: 'purchasesTotal', notionProperty: 'Total de Compras no Ciclo', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma real das transações de compra dentro do ciclo corrente', aliases: ['Total Compras'] },
      { domainField: 'additionalComponentsAmount', notionProperty: 'Componentes Adicionais da Fatura', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Soma dos componentes adicionais identificados (parcelas anteriores não contabilizadas no ciclo, encargos, IOF, juros, créditos/estornos)', aliases: ['Componentes Adicionais', 'Outros Encargos'] },
      { domainField: 'unexplainedDiscrepancy', notionProperty: 'Divergência Não Explicada', notionType: 'number', direction: 'write', authority: 'DERIVADO', description: 'Discrepância residual caso os componentes adicionais conhecidos não expliquem a diferença', aliases: ['Divergência Residual'] },
      { domainField: 'paidAmount', notionProperty: 'Valor Pago', notionType: 'number', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Valor total liquidado até o momento', aliases: ['Total Pago'] },
      { domainField: 'paidAt', notionProperty: 'Data de Liquidação', notionType: 'date', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Data exclusiva da quitação integral da fatura', aliases: ['Data Pagamento', 'Quitação Integral'] },
      { domainField: 'paymentTransactions', notionProperty: 'Transações de Pagamento', notionType: 'relation', direction: 'both', authority: 'REGRA_AUTOMATICA', description: 'Relações com as transações bancárias de saída que quitaram ou amortizaram a fatura (suporta múltiplos pagamentos)', relationTargetEnvKey: 'NOTION_DS_TRANSACTIONS', aliases: ['Pagamentos'] },
      { domainField: 'transactionsRelation', notionProperty: 'Lançamentos do Ciclo', notionType: 'relation', direction: 'write', authority: 'DERIVADO', description: 'Relação dual bidirecional única sincronizada com Transações.Fatura Vinculada', relationTargetEnvKey: 'NOTION_DS_TRANSACTIONS', isBidirectionalRelation: true, syncedPropertyName: 'Fatura Vinculada', aliases: ['Transações da Fatura', 'Compras'] },
    ],
  },
};


