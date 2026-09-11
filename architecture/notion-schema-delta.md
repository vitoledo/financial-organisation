# Manifesto de Schema-Delta: Notion vs. Modelo de Domínio (Fase 0)

> **Status:** Relatório Técnico de Introspecção e Conformidade de Schema
> **Data da Verificação:** 2026-09-11T01:24:33.733Z
> **Notion API Version:** `2026-03-11`
> **Data Sources Monitorados:** 12 existentes + 1 base proposta (Faturas / Ciclos)

---

## 1. Resumo Executivo da Verificação

| Métrica | Valor |
| :--- | :--- |
| Total de Data Sources Canônicos | 13 |
| Bases Existentes Inspecionadas | 12 |
| Bases com ID Configurado no Ambiente | 12 |
| Propriedades com Correspondência Exata (EXACT_MATCH) | 0 |
| Candidatos a Renomeação (RENAME_CANDIDATE) | 0 |
| Divergências de Tipo (TYPE_MISMATCH) | 0 |
| Propriedades Ausentes no Notion (MISSING) | 161 |
| Propriedades Adicionais Preservadas (EXTRA_PRESERVE) | 0 |

> [!IMPORTANT]
> **Atenção sobre Credenciais do Notion:**
> NOTION_API_KEY ausente. Introspecção remota não executada.
> Para executar a introspecção remota ao vivo contra sua conta, preencha as variáveis em `.env` e rode `pnpm notion:check-schema`.

---

## 2. Diagnóstico Detalhado por Data Source

### Contas (`NOTION_DS_ACCOUNTS`)
* **Status:** `API_ERROR`
* **Data Source ID (Parcial):** `a174...f4a2`
* **Diagnóstico:** *NOTION_API_KEY ausente. Introspecção remota não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Nome da Conta` | `title` | `—` | ⚠️ MISSING | `PIERRE` | Nome identificador da conta |
| `ID Pierre` | `rich_text` | `—` | ⚠️ MISSING | `PIERRE` | UUID da conta no Pierre Finance |
| `Instituição` | `select` | `—` | ⚠️ MISSING | `PIERRE` | Nome do banco / conector (ex: Nubank, Mercado Pago) |
| `Tipo de Conta` | `select` | `—` | ⚠️ MISSING | `PIERRE` | CHECKING_ACCOUNT, CREDIT_CARD, SAVINGS |
| `Saldo Atual` | `number` | `—` | ⚠️ MISSING | `PIERRE` | Saldo disponível em reais |
| `Limite Contratado` | `number` | `—` | ⚠️ MISSING | `PIERRE` | Limite total concedido pelo banco (ex: R$ 2.400) |
| `Limite Personalizado` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Teto operacional ajustado pelo usuário no app (ex: R$ 400) |
| `Limite Disponível` | `number` | `—` | ⚠️ MISSING | `PIERRE` | Limite de crédito livre no momento |
| `Limite Operacional Usado` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | customizedCreditLimit - availableCreditLimit |
| `Limite Usado (Pierre Bruto)` | `number` | `—` | ⚠️ MISSING | `PIERRE` | Valor bruto reportado pelo Pierre para auditoria de inconsistência |
| `Dia de Fechamento` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Dia do mês do corte da fatura |
| `Dia de Vencimento` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Dia do mês do vencimento da fatura |
| `Incluir no Caixa` | `checkbox` | `—` | ⚠️ MISSING | `USUARIO` | Indica se computa para liquidez imediata |
| `Incluir no Patrimônio` | `checkbox` | `—` | ⚠️ MISSING | `USUARIO` | Indica se computa para o patrimônio total |
| `Última Sincronização` | `date` | `—` | ⚠️ MISSING | `DERIVADO` | Timestamp da sincronização |

### Transações (`NOTION_DS_TRANSACTIONS`)
* **Status:** `API_ERROR`
* **Data Source ID (Parcial):** `1fc2...f199`
* **Diagnóstico:** *NOTION_API_KEY ausente. Introspecção remota não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Descrição` | `title` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Descrição tratada da transação |
| `ID Pierre` | `rich_text` | `—` | ⚠️ MISSING | `PIERRE` | UUID unívoco da transação no Pierre |
| `Hash Canônico` | `rich_text` | `—` | ⚠️ MISSING | `DERIVADO` | Fingerprint SHA-256 (64 chars) de versão |
| `Data` | `date` | `—` | ⚠️ MISSING | `PIERRE` | Data da transação (ISO-8601) |
| `Valor` | `number` | `—` | ⚠️ MISSING | `PIERRE` | Valor monetário absoluto (R$) |
| `Valor Bruto Pierre` | `number` | `—` | ⚠️ MISSING | `PIERRE` | Valor exato retornado pelo Pierre com sinal original |
| `Movimento` | `select` | `—` | ⚠️ MISSING | `PIERRE` | Entrada ou Saída de caixa físico |
| `Natureza Econômica` | `select` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Classificação contábil da operação |
| `Efeito Orçamentário` | `select` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | INCOME | EXPENSE | REVERSAL | NEUTRAL |
| `Propósito de Alocação` | `select` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | INVESTMENT_RESERVE | OPERATIONAL_CASH | etc. |
| `Contribuição Meta Poupança` | `number` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Valor que pontua na meta de poupança (ex: R$ 500 aporte) |
| `Conta` | `relation` | `—` | ⚠️ MISSING | `DERIVADO` | Relação com base Contas |
| `Categoria` | `relation` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Relação com Categorias Financeiras |
| `Fatura Vinculada` | `relation` | `—` | ⚠️ MISSING | `DERIVADO` | Relação com 13ª base Faturas / Ciclos |
| `Status Banco` | `select` | `—` | ⚠️ MISSING | `PIERRE` | Pendente ou Confirmado |
| `Status de Revisão` | `select` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Confirmado Auto, Pendente Revisão, Validado Manualmente, Legado Não Verificado |
| `Motivo da Revisão` | `rich_text` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Justificativa para intervenção humana |
| `Categoria Pierre` | `rich_text` | `—` | ⚠️ MISSING | `PIERRE` | Categoria bruta do open-finance |
| `Descrição Original` | `rich_text` | `—` | ⚠️ MISSING | `PIERRE` | Texto original do extrato |
| `HMAC Contraparte` | `rich_text` | `—` | ⚠️ MISSING | `DERIVADO` | Hash seguro do CPF/CNPJ para matching sem expor PII |

### Categorias Financeiras (`NOTION_DS_CATEGORIES`)
* **Status:** `API_ERROR`
* **Data Source ID (Parcial):** `eb8e...13b4`
* **Diagnóstico:** *NOTION_API_KEY ausente. Introspecção remota não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Nome da Categoria` | `title` | `—` | ⚠️ MISSING | `USUARIO` | Nome da categoria |
| `Grupo 50/30/20` | `select` | `—` | ⚠️ MISSING | `USUARIO` | Necessidade, Desejo, Poupança, Neutro |
| `Variabilidade` | `select` | `—` | ⚠️ MISSING | `USUARIO` | Fixa, Variável, Ocasional |
| `Natureza Padrão` | `select` | `—` | ⚠️ MISSING | `USUARIO` | Natureza contábil sugerida |

### Regras de Classificação (`NOTION_DS_RULES`)
* **Status:** `API_ERROR`
* **Data Source ID (Parcial):** `b36b...0fbb`
* **Diagnóstico:** *NOTION_API_KEY ausente. Introspecção remota não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Nome da Regra` | `title` | `—` | ⚠️ MISSING | `USUARIO` | Título descritivo da regra |
| `Prioridade` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Ordem de avaliação (1 = prioridade máxima) |
| `Ativa` | `checkbox` | `—` | ⚠️ MISSING | `USUARIO` | Liga/desliga a regra |
| `Auto Aplicar` | `checkbox` | `—` | ⚠️ MISSING | `USUARIO` | Se falso, obriga envio para revisão |
| `Exigir Revisão` | `checkbox` | `—` | ⚠️ MISSING | `USUARIO` | Se verdadeiro, marca para checagem humana |
| `Condição: Contraparte` | `rich_text` | `—` | ⚠️ MISSING | `USUARIO` | Substring ou nome do merchant/destinatário |
| `Condição: Descrição` | `rich_text` | `—` | ⚠️ MISSING | `USUARIO` | Substring ou regex na descrição |
| `Condição: Movimento` | `select` | `—` | ⚠️ MISSING | `USUARIO` | Qualquer, Entrada, Saída |
| `Condição: Conta` | `relation` | `—` | ⚠️ MISSING | `USUARIO` | Conta de origem específica |
| `Condição: Categoria Pierre` | `rich_text` | `—` | ⚠️ MISSING | `USUARIO` | Categoria original Pierre |
| `Condição: Valor Exato` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Valor monetário exato |
| `Condição: Tolerância Valor` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Tolerância aceitável em reais |
| `Condição: Valor Mínimo` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Piso do valor |
| `Condição: Valor Máximo` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Teto do valor |
| `Condição: Dia Mês Início` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Dia inicial do mês (1 a 31) |
| `Condição: Dia Mês Fim` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Dia final do mês (1 a 31) |
| `Período de Validade` | `date` | `—` | ⚠️ MISSING | `USUARIO` | Vigência temporal da regra |
| `Atribuir: Natureza` | `select` | `—` | ⚠️ MISSING | `USUARIO` | Natureza atribuída |
| `Atribuir: Efeito Orçamento` | `select` | `—` | ⚠️ MISSING | `USUARIO` | INCOME, EXPENSE, REVERSAL, NEUTRAL |
| `Atribuir: Alocação` | `select` | `—` | ⚠️ MISSING | `USUARIO` | Finalidade da movimentação |
| `Atribuir: Categoria` | `relation` | `—` | ⚠️ MISSING | `USUARIO` | Categoria vinculada |

### Contas Fixas (`NOTION_DS_FIXED_BILLS`)
* **Status:** `API_ERROR`
* **Data Source ID (Parcial):** `49e9...dfb9`
* **Diagnóstico:** *NOTION_API_KEY ausente. Introspecção remota não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Nome da Conta Fixa` | `title` | `—` | ⚠️ MISSING | `USUARIO` | Nome do compromisso recorrente |
| `Valor Previsto` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Valor esperado por competência |
| `Tolerância (R$)` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Tolerância para conciliação automática |
| `Periodicidade` | `select` | `—` | ⚠️ MISSING | `USUARIO` | Mensal, Bimestral, Trimestral, Semestral, Anual |
| `Competência Âncora` | `rich_text` | `—` | ⚠️ MISSING | `USUARIO` | Mês de referência inicial (ex: 2026-01) |
| `Última Competência Gerada` | `rich_text` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Último mês gerado em Obrigações (ex: 2026-08) |
| `Dia de Vencimento` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Dia do mês do vencimento (1 a 31) |
| `Forma de Pagamento` | `select` | `—` | ⚠️ MISSING | `USUARIO` | Cartão de Crédito, Débito em Conta, Pix, Boleto |
| `Conta Padrão` | `relation` | `—` | ⚠️ MISSING | `USUARIO` | Conta de débito usual |
| `Categoria` | `relation` | `—` | ⚠️ MISSING | `USUARIO` | Categoria orçamentária |
| `Padrão de Identificação` | `rich_text` | `—` | ⚠️ MISSING | `USUARIO` | Expressão / substring para conciliação automática |
| `Ativa` | `checkbox` | `—` | ⚠️ MISSING | `USUARIO` | Gera obrigações no período |
| `Observações / Contrato` | `rich_text` | `—` | ⚠️ MISSING | `USUARIO` | Código do assinante, detalhes do contrato ou instruções |
| `Data de Início` | `date` | `—` | ⚠️ MISSING | `USUARIO` | Início da vigência do contrato |
| `Data de Término` | `date` | `—` | ⚠️ MISSING | `USUARIO` | Término da vigência do contrato |

### Obrigações Mensais (`NOTION_DS_MONTHLY_OBLIGATIONS`)
* **Status:** `API_ERROR`
* **Data Source ID (Parcial):** `5c59...f6b8`
* **Diagnóstico:** *NOTION_API_KEY ausente. Introspecção remota não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Identificador` | `title` | `—` | ⚠️ MISSING | `DERIVADO` | Nome da Conta Fixa - YYYY-MM |
| `Conta Fixa` | `relation` | `—` | ⚠️ MISSING | `DERIVADO` | Relação com o cadastro permanente |
| `Competência` | `rich_text` | `—` | ⚠️ MISSING | `DERIVADO` | Mês de referência (YYYY-MM) |
| `Data de Vencimento` | `date` | `—` | ⚠️ MISSING | `DERIVADO` | Data exata do vencimento |
| `Valor Previsto` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Valor esperado herdado da conta fixa |
| `Status` | `select` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Prevista, Paga, Atrasada, Revisão Necessária, Cancelada |
| `Valor Pago` | `number` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Valor efetivamente liquidado |
| `Data do Pagamento` | `date` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Data em que ocorreu a quitação |
| `Transação Vinculada` | `relation` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Relação com a transação que liquidou |
| `Validado Automaticamente` | `checkbox` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | True se correspondência foi inequívoca |
| `Observações / Conflitos` | `rich_text` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Avisos de divergência ou ambiguidade |

### Investimentos (`NOTION_DS_INVESTMENTS`)
* **Status:** `API_ERROR`
* **Data Source ID (Parcial):** `db60...b6cb`
* **Diagnóstico:** *NOTION_API_KEY ausente. Introspecção remota não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Ativo` | `title` | `—` | ⚠️ MISSING | `USUARIO` | Nome do ativo ou produto financeiro |
| `Classe do Ativo` | `select` | `—` | ⚠️ MISSING | `USUARIO` | Renda Fixa, Cripto, Ação, FII, ETF, Previdência Privada, Tesouro Direto (Caixa Reservado NÃO é classe de ativo) |
| `Custódia` | `select` | `—` | ⚠️ MISSING | `USUARIO` | Conta Pierre ou Carteira Externa |
| `Quantidade` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Posição atual custodiada |
| `Custo de Aquisição (PMP)` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Custo acumulado pelo Preço Médio Ponderado das compras |
| `Valor de Mercado Atual` | `number` | `—` | ⚠️ MISSING | `PIERRE` | Cotação atual x quantidade |
| `Lucro / Prejuízo` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Valor de mercado - Custo de aquisição |
| `Conta Vinculada` | `relation` | `—` | ⚠️ MISSING | `USUARIO` | Conta corrente ou corretora associada |

### Movimentações de Investimentos (`NOTION_DS_INVESTMENT_MOVEMENTS`)
* **Status:** `API_ERROR`
* **Data Source ID (Parcial):** `b19f...25af`
* **Diagnóstico:** *NOTION_API_KEY ausente. Introspecção remota não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Identificador` | `title` | `—` | ⚠️ MISSING | `DERIVADO` | Tipo - Ativo - Data |
| `Ativo Vinculado` | `relation` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Relação com a posição do ativo |
| `Tipo de Movimentação` | `select` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Aporte de Capital, Resgate de Capital, Compra de Ativo, Venda de Ativo, Rendimento / Provento, Taxas e Impostos, Ajuste de Posição |
| `Data da Operação` | `date` | `—` | ⚠️ MISSING | `PIERRE` | Data da execução |
| `Valor Bruto` | `number` | `—` | ⚠️ MISSING | `PIERRE` | Volume financeiro total |
| `Valor Líquido` | `number` | `—` | ⚠️ MISSING | `PIERRE` | Valor líquido após custos |
| `Quantidade Negociada` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Fração ou unidades transacionadas |
| `Preço Unitário` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Preço médio da ordem |
| `Conta Origem` | `relation` | `—` | ⚠️ MISSING | `DERIVADO` | Conta debitada |
| `Conta Destino / Caixa` | `relation` | `—` | ⚠️ MISSING | `DERIVADO` | Conta creditada |
| `Transação Financeira` | `relation` | `—` | ⚠️ MISSING | `DERIVADO` | Transação bancária vinculada |

### Planejamento Mensal (`NOTION_DS_MONTHLY_BUDGET`)
* **Status:** `API_ERROR`
* **Data Source ID (Parcial):** `0c14...c7d5`
* **Diagnóstico:** *NOTION_API_KEY ausente. Introspecção remota não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Competência` | `title` | `—` | ⚠️ MISSING | `USUARIO` | YYYY-MM |
| `Renda Prevista` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Meta de renda do mês |
| `Teto Mensal Cartão` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Teto pessoal de compras no cartão (ex: R$ 400) |
| `Meta de Poupança/Aporte` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Meta de dinheiro a poupar no mês |
| `Receitas Realizadas` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Soma de transações OPERATING_REVENUE |
| `Despesas Realizadas` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Soma de transações OPERATING_EXPENSE |
| `Poupança Realizada` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Soma de transações com savingsGoalContribution |
| `Compras Realizadas Cartão` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Soma de compras de cartão no mês |

### Metas Financeiras (`NOTION_DS_FINANCIAL_GOALS`)
* **Status:** `API_ERROR`
* **Data Source ID (Parcial):** `b629...ed91`
* **Diagnóstico:** *NOTION_API_KEY ausente. Introspecção remota não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Meta` | `title` | `—` | ⚠️ MISSING | `USUARIO` | Nome do objetivo financeiro |
| `Valor Alvo` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Montante financeiro desejado |
| `Valor Atual Acumulado` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Saldo alocado para a meta |
| `Prazo Alvo` | `date` | `—` | ⚠️ MISSING | `USUARIO` | Data limite para cumprimento |

### Fechamentos Mensais (`NOTION_DS_MONTHLY_CLOSINGS`)
* **Status:** `API_ERROR`
* **Data Source ID (Parcial):** `74ff...b94c`
* **Diagnóstico:** *NOTION_API_KEY ausente. Introspecção remota não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Mês de Referência` | `title` | `—` | ⚠️ MISSING | `DERIVADO` | Fechamento YYYY-MM |
| `Status do Fechamento` | `select` | `—` | ⚠️ MISSING | `USUARIO` | Aberto, Pré-fechado, Fechado Auditado |
| `Patrimônio Inicial` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Patrimônio líquido consolidado no início do mês |
| `Renda Consolidada` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Total de receitas operacionais líquidas |
| `Despesas Consolidadas` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Total de despesas correntes de subsistência |
| `Despesas Essenciais (Necessidades)` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Gastos essenciais de moradia, saúde, alimentação, etc. (Regra 50%) |
| `Despesas Discricionárias (Desejos)` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Gastos de estilo de vida, lazer, compras pessoais (Regra 30%) |
| `Total Poupado / Aportado` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Renda - Despesas (Regra 20%) |
| `Taxa de Poupança (%)` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | (Total Poupado / Renda) * 100 |
| `Rendimentos de Investimentos` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Rendimentos e dividendos auferidos no mês |
| `Patrimônio Líquido Final` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Saldo contas + investimentos - dívidas ao fechar o mês |
| `Variação Patrimonial` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Patrimônio Final - Patrimônio Inicial |
| `Observações / Notas do Fechamento` | `rich_text` | `—` | ⚠️ MISSING | `USUARIO` | Comentários qualitativos sobre desvios e conquistas do mês |

### Log de Sincronização (`NOTION_DS_SYNC_LOG`)
* **Status:** `API_ERROR`
* **Data Source ID (Parcial):** `2a61...3d20`
* **Diagnóstico:** *NOTION_API_KEY ausente. Introspecção remota não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Execução` | `title` | `—` | ⚠️ MISSING | `DERIVADO` | Sync - YYYY-MM-DD HH:mm:ss |
| `Status` | `select` | `—` | ⚠️ MISSING | `DERIVADO` | Sucesso, Sucesso Parcial, Erro, Bloqueado por Concorrência |
| `Data Início` | `date` | `—` | ⚠️ MISSING | `DERIVADO` | Timestamp do início da sincronização |
| `Data Fim` | `date` | `—` | ⚠️ MISSING | `DERIVADO` | Timestamp do término da sincronização |
| `Duração (s)` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Tempo total de processamento em segundos |
| `Contas Processadas` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Quantidade de contas sincronizadas |
| `Transações Recebidas` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Lançamentos retornados pelo Pierre |
| `Transações Novas` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Novas páginas criadas |
| `Transações Atualizadas` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Páginas existentes com versionHash alterado |
| `Transações Inalteradas` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Transações sem alteração ignoradas |
| `Parcelas Recebidas` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Parcelamentos e faturas futuras identificadas |
| `Enviadas para Revisão` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Transações marcadas como Pendente Revisão |
| `Obrigações Conciliadas` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Compromissos mensais liquidados com sucesso |
| `Freshness da Fonte` | `date` | `—` | ⚠️ MISSING | `DERIVADO` | Momento do último dado retornado pelo banco / open finance |
| `Versão do Worker / Commit` | `rich_text` | `—` | ⚠️ MISSING | `DERIVADO` | Commit SHA ou tag da versão do worker em execução |
| `Hash do Lote RAW` | `rich_text` | `—` | ⚠️ MISSING | `DERIVADO` | SHA-256 do payload bruto salvo no cofre cifrado |
| `Detalhes do Erro` | `rich_text` | `—` | ⚠️ MISSING | `DERIVADO` | Stack trace ou mensagem de falha |

### Faturas / Ciclos de Cartão (`NOTION_DS_CARD_BILLS`)
* **Status:** `PROPOSED_NEW_DATABASE`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Fatura / Ciclo` | `title` | `—` | ⚠️ MISSING | `DERIVADO` | Ex: Fatura Nubank - Venc 22/07/2026 |
| `Cartão Vinculado` | `relation` | `—` | ⚠️ MISSING | `DERIVADO` | Relação com a conta do cartão em Contas |
| `Tipo de Ciclo` | `select` | `—` | ⚠️ MISSING | `DERIVADO` | Ciclo Real Banco, Ciclo Configurado, Ciclo Estimado |
| `Status da Fatura` | `select` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Aberta em Curso, Fechada a Vencer, Vencida, Paga Integralmente, Paga Parcialmente |
| `Data de Fechamento` | `date` | `—` | ⚠️ MISSING | `PIERRE` | Data de corte (balance_close_date ou configurada) |
| `Data de Vencimento` | `date` | `—` | ⚠️ MISSING | `PIERRE` | Data de vencimento (balance_due_date) |
| `Valor da Fatura (Banco)` | `number` | `—` | ⚠️ MISSING | `PIERRE` | Valor total consolidado emitido pela instituição |
| `Total de Compras no Ciclo` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Soma real das transações de compra dentro do ciclo corrente |
| `Componentes Adicionais da Fatura` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Diferença entre fatura emitida e compras correntes (parcelas anteriores, encargos, IOF, juros, créditos/estornos) |
| `Divergência Não Explicada` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Discrepância residual caso os componentes adicionais conhecidos não expliquem a diferença |
| `Valor Pago` | `number` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Valor total liquidado até o momento |
| `Data de Liquidação` | `date` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Data do pagamento da fatura |
| `Lançamentos do Ciclo` | `relation` | `—` | ⚠️ MISSING | `DERIVADO` | Relação bidirecional com as transações de compra deste ciclo |
| `Transações de Pagamento` | `relation` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Relações com as transações bancárias de saída que quitaram ou amortizaram a fatura (suporta múltiplos pagamentos) |

---

## 3. Especificação Completa da 13ª Base: `Faturas / Ciclos de Cartão`

Esta base **não existe atualmente** no seu Notion. Ela deve ser criada externamente para desacoplar faturas de fechamentos mensais.

* **Nome Sugerido da Base:** `Faturas / Ciclos de Cartão`
* **Variável de Ambiente Prevista:** `NOTION_DS_CARD_BILLS`

| Propriedade a Criar | Tipo no Notion | Direção | Autoridade | Finalidade |
| :--- | :--- | :--- | :--- | :--- |
| `Fatura / Ciclo` | `title` | `write` | `DERIVADO` | Ex: Fatura Nubank - Venc 22/07/2026 |
| `Cartão Vinculado` | `relation` | `write` | `DERIVADO` | Relação com a conta do cartão em Contas |
| `Tipo de Ciclo` | `select` | `write` | `DERIVADO` | Ciclo Real Banco, Ciclo Configurado, Ciclo Estimado |
| `Status da Fatura` | `select` | `both` | `REGRA_AUTOMATICA` | Aberta em Curso, Fechada a Vencer, Vencida, Paga Integralmente, Paga Parcialmente |
| `Data de Fechamento` | `date` | `write` | `PIERRE` | Data de corte (balance_close_date ou configurada) |
| `Data de Vencimento` | `date` | `write` | `PIERRE` | Data de vencimento (balance_due_date) |
| `Valor da Fatura (Banco)` | `number` | `write` | `PIERRE` | Valor total consolidado emitido pela instituição |
| `Total de Compras no Ciclo` | `number` | `write` | `DERIVADO` | Soma real das transações de compra dentro do ciclo corrente |
| `Componentes Adicionais da Fatura` | `number` | `write` | `DERIVADO` | Diferença entre fatura emitida e compras correntes (parcelas anteriores, encargos, IOF, juros, créditos/estornos) |
| `Divergência Não Explicada` | `number` | `write` | `DERIVADO` | Discrepância residual caso os componentes adicionais conhecidos não expliquem a diferença |
| `Valor Pago` | `number` | `both` | `REGRA_AUTOMATICA` | Valor total liquidado até o momento |
| `Data de Liquidação` | `date` | `both` | `REGRA_AUTOMATICA` | Data do pagamento da fatura |
| `Lançamentos do Ciclo` | `relation` | `write` | `DERIVADO` | Relação bidirecional com as transações de compra deste ciclo |
| `Transações de Pagamento` | `relation` | `both` | `REGRA_AUTOMATICA` | Relações com as transações bancárias de saída que quitaram ou amortizaram a fatura (suporta múltiplos pagamentos) |

---

## 4. Instruções de Aplicação para o Usuário

1. Para cada base com status `MISSING_ENV_ID`, copie o Data Source ID correspondente no Notion para o `.env`.
2. Crie a 13ª base **Faturas / Ciclos de Cartão** no Notion seguindo as propriedades listadas na Seção 3.
3. Nas bases existentes, revise as propriedades marcadas como `⚠️ MISSING`, `❌ TYPE_MISMATCH` ou `🔄 RENAME_CANDIDATE` e adicione/ajuste-as.
4. Propriedades marcadas como `🛡️ EXTRA_PRESERVE` são mantidas integralmente no Notion.
5. Execute novamente `pnpm notion:check-schema` para validar que todos os status convergiram para `✅ EXACT_MATCH`.
