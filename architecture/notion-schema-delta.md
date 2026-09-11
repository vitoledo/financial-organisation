# Manifesto de Schema-Delta: Notion vs. Modelo de Domínio (Fase 0)

> **Status:** Relatório Técnico de Introspecção e Conformidade de Schema
> **Data da Verificação:** 2026-09-11T01:18:53.051Z
> **Notion API Version:** `2026-03-11`
> **Data Sources Monitorados:** 12 existentes + 1 base proposta (Faturas / Ciclos)

---

## 1. Resumo Executivo da Verificação

| Métrica | Valor |
| :--- | :--- |
| Total de Data Sources Canônicos | 13 |
| Bases Existentes Inspecionadas | 12 |
| Bases com ID Configurado no Ambiente | 0 |

> [!IMPORTANT]
> **Atenção sobre Credenciais do Notion:**
> Existem **12** variáveis `NOTION_DS_*` pendentes de preenchimento no arquivo `.env`.
> Para executar a introspecção remota ao vivo contra sua conta, preencha as variáveis em `.env` e rode `pnpm notion:check-schema`.

---

## 2. Diagnóstico Detalhado por Data Source

### Contas (`NOTION_DS_ACCOUNTS`)
* **Status:** `MISSING_ENV_ID`
* **Diagnóstico:** *Variável de ambiente NOTION_DS_ACCOUNTS não configurada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Nome da Conta` | `title` | `—` | ⚠️ AUSENTE | `PIERRE` | Nome identificador da conta |
| `ID Pierre` | `rich_text` | `—` | ⚠️ AUSENTE | `PIERRE` | UUID da conta no Pierre Finance |
| `Instituição` | `select` | `—` | ⚠️ AUSENTE | `PIERRE` | Nome do banco / conector (ex: Nubank, Mercado Pago) |
| `Tipo de Conta` | `select` | `—` | ⚠️ AUSENTE | `PIERRE` | CHECKING_ACCOUNT, CREDIT_CARD, SAVINGS |
| `Saldo Atual` | `number` | `—` | ⚠️ AUSENTE | `PIERRE` | Saldo disponível em reais |
| `Limite Contratado` | `number` | `—` | ⚠️ AUSENTE | `PIERRE` | Limite total concedido pelo banco (ex: R$ 2.400) |
| `Limite Personalizado` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Teto operacional ajustado pelo usuário no app (ex: R$ 400) |
| `Limite Disponível` | `number` | `—` | ⚠️ AUSENTE | `PIERRE` | Limite de crédito livre no momento |
| `Limite Operacional Usado` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | customizedCreditLimit - availableCreditLimit |
| `Limite Usado (Pierre Bruto)` | `number` | `—` | ⚠️ AUSENTE | `PIERRE` | Valor bruto reportado pelo Pierre para auditoria de inconsistência |
| `Dia de Fechamento` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Dia do mês do corte da fatura |
| `Dia de Vencimento` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Dia do mês do vencimento da fatura |
| `Incluir no Caixa` | `checkbox` | `—` | ⚠️ AUSENTE | `USUARIO` | Indica se computa para liquidez imediata |
| `Incluir no Patrimônio` | `checkbox` | `—` | ⚠️ AUSENTE | `USUARIO` | Indica se computa para o patrimônio total |
| `Última Sincronização` | `date` | `—` | ⚠️ AUSENTE | `DERIVADO` | Timestamp da sincronização |

### Transações (`NOTION_DS_TRANSACTIONS`)
* **Status:** `MISSING_ENV_ID`
* **Diagnóstico:** *Variável de ambiente NOTION_DS_TRANSACTIONS não configurada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Descrição` | `title` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Descrição tratada da transação |
| `ID Pierre` | `rich_text` | `—` | ⚠️ AUSENTE | `PIERRE` | UUID unívoco da transação no Pierre |
| `Hash Canônico` | `rich_text` | `—` | ⚠️ AUSENTE | `DERIVADO` | Fingerprint SHA-256 (64 chars) de versão |
| `Data` | `date` | `—` | ⚠️ AUSENTE | `PIERRE` | Data da transação (ISO-8601) |
| `Valor` | `number` | `—` | ⚠️ AUSENTE | `PIERRE` | Valor monetário absoluto (R$) |
| `Valor Bruto Pierre` | `number` | `—` | ⚠️ AUSENTE | `PIERRE` | Valor exato retornado pelo Pierre com sinal original |
| `Movimento` | `select` | `—` | ⚠️ AUSENTE | `PIERRE` | Entrada ou Saída de caixa físico |
| `Natureza Econômica` | `select` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Classificação contábil da operação |
| `Efeito Orçamentário` | `select` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | INCOME | EXPENSE | REVERSAL | NEUTRAL |
| `Propósito de Alocação` | `select` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | INVESTMENT_RESERVE | OPERATIONAL_CASH | etc. |
| `Contribuição Meta Poupança` | `number` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Valor que pontua na meta de poupança (ex: R$ 500 aporte) |
| `Conta` | `relation` | `—` | ⚠️ AUSENTE | `DERIVADO` | Relação com base Contas |
| `Categoria` | `relation` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Relação com Categorias Financeiras |
| `Fatura Vinculada` | `relation` | `—` | ⚠️ AUSENTE | `DERIVADO` | Relação com 13ª base Faturas / Ciclos |
| `Status Banco` | `select` | `—` | ⚠️ AUSENTE | `PIERRE` | Pendente ou Confirmado |
| `Status de Revisão` | `select` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Confirmado Auto, Pendente Revisão, Validado Manualmente, Legado Não Verificado |
| `Motivo da Revisão` | `rich_text` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Justificativa para intervenção humana |
| `Categoria Pierre` | `rich_text` | `—` | ⚠️ AUSENTE | `PIERRE` | Categoria bruta do open-finance |
| `Descrição Original` | `rich_text` | `—` | ⚠️ AUSENTE | `PIERRE` | Texto original do extrato |
| `HMAC Contraparte` | `rich_text` | `—` | ⚠️ AUSENTE | `DERIVADO` | Hash seguro do CPF/CNPJ para matching sem expor PII |

### Categorias Financeiras (`NOTION_DS_CATEGORIES`)
* **Status:** `MISSING_ENV_ID`
* **Diagnóstico:** *Variável de ambiente NOTION_DS_CATEGORIES não configurada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Nome da Categoria` | `title` | `—` | ⚠️ AUSENTE | `USUARIO` | Nome da categoria |
| `Grupo 50/30/20` | `select` | `—` | ⚠️ AUSENTE | `USUARIO` | Necessidade, Desejo, Poupança, Neutro |
| `Variabilidade` | `select` | `—` | ⚠️ AUSENTE | `USUARIO` | Fixa, Variável, Ocasional |
| `Natureza Padrão` | `select` | `—` | ⚠️ AUSENTE | `USUARIO` | Natureza contábil sugerida |

### Regras de Classificação (`NOTION_DS_RULES`)
* **Status:** `MISSING_ENV_ID`
* **Diagnóstico:** *Variável de ambiente NOTION_DS_RULES não configurada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Nome da Regra` | `title` | `—` | ⚠️ AUSENTE | `USUARIO` | Título descritivo da regra |
| `Prioridade` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Ordem de avaliação (1 = prioridade máxima) |
| `Ativa` | `checkbox` | `—` | ⚠️ AUSENTE | `USUARIO` | Liga/desliga a regra |
| `Auto Aplicar` | `checkbox` | `—` | ⚠️ AUSENTE | `USUARIO` | Se falso, obriga envio para revisão |
| `Exigir Revisão` | `checkbox` | `—` | ⚠️ AUSENTE | `USUARIO` | Se verdadeiro, marca para checagem humana |
| `Condição: Contraparte` | `rich_text` | `—` | ⚠️ AUSENTE | `USUARIO` | Substring ou nome do merchant/destinatário |
| `Condição: Descrição` | `rich_text` | `—` | ⚠️ AUSENTE | `USUARIO` | Substring ou regex na descrição |
| `Condição: Movimento` | `select` | `—` | ⚠️ AUSENTE | `USUARIO` | Qualquer, Entrada, Saída |
| `Condição: Conta` | `relation` | `—` | ⚠️ AUSENTE | `USUARIO` | Conta de origem específica |
| `Condição: Categoria Pierre` | `rich_text` | `—` | ⚠️ AUSENTE | `USUARIO` | Categoria original Pierre |
| `Condição: Valor Exato` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Valor monetário exato |
| `Condição: Tolerância Valor` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Tolerância aceitável em reais |
| `Condição: Valor Mínimo` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Piso do valor |
| `Condição: Valor Máximo` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Teto do valor |
| `Condição: Dia Mês Início` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Dia inicial do mês (1 a 31) |
| `Condição: Dia Mês Fim` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Dia final do mês (1 a 31) |
| `Período de Validade` | `date` | `—` | ⚠️ AUSENTE | `USUARIO` | Vigência temporal da regra |
| `Atribuir: Natureza` | `select` | `—` | ⚠️ AUSENTE | `USUARIO` | Natureza atribuída |
| `Atribuir: Efeito Orçamento` | `select` | `—` | ⚠️ AUSENTE | `USUARIO` | INCOME, EXPENSE, REVERSAL, NEUTRAL |
| `Atribuir: Alocação` | `select` | `—` | ⚠️ AUSENTE | `USUARIO` | Finalidade da movimentação |
| `Atribuir: Categoria` | `relation` | `—` | ⚠️ AUSENTE | `USUARIO` | Categoria vinculada |

### Contas Fixas (`NOTION_DS_FIXED_BILLS`)
* **Status:** `MISSING_ENV_ID`
* **Diagnóstico:** *Variável de ambiente NOTION_DS_FIXED_BILLS não configurada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Nome da Conta Fixa` | `title` | `—` | ⚠️ AUSENTE | `USUARIO` | Nome do compromisso recorrente |
| `Valor Previsto` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Valor esperado por competência |
| `Tolerância (R$)` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Tolerância para conciliação automática |
| `Periodicidade` | `select` | `—` | ⚠️ AUSENTE | `USUARIO` | Mensal, Bimestral, Trimestral, Semestral, Anual |
| `Competência Âncora` | `rich_text` | `—` | ⚠️ AUSENTE | `USUARIO` | Mês de referência inicial (ex: 2026-01) |
| `Última Competência Gerada` | `rich_text` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Último mês gerado em Obrigações (ex: 2026-08) |
| `Dia de Vencimento` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Dia do mês do vencimento (1 a 31) |
| `Forma de Pagamento` | `select` | `—` | ⚠️ AUSENTE | `USUARIO` | Cartão de Crédito, Débito em Conta, Pix, Boleto |
| `Conta Padrão` | `relation` | `—` | ⚠️ AUSENTE | `USUARIO` | Conta de débito usual |
| `Categoria` | `relation` | `—` | ⚠️ AUSENTE | `USUARIO` | Categoria orçamentária |
| `Padrão de Identificação` | `rich_text` | `—` | ⚠️ AUSENTE | `USUARIO` | Expressão / substring para conciliação automática |
| `Ativa` | `checkbox` | `—` | ⚠️ AUSENTE | `USUARIO` | Gera obrigações no período |
| `Observações / Contrato` | `rich_text` | `—` | ⚠️ AUSENTE | `USUARIO` | Código do assinante, detalhes do contrato ou instruções |
| `Data de Início` | `date` | `—` | ⚠️ AUSENTE | `USUARIO` | Início da vigência do contrato |
| `Data de Término` | `date` | `—` | ⚠️ AUSENTE | `USUARIO` | Término da vigência do contrato |

### Obrigações Mensais (`NOTION_DS_MONTHLY_OBLIGATIONS`)
* **Status:** `MISSING_ENV_ID`
* **Diagnóstico:** *Variável de ambiente NOTION_DS_MONTHLY_OBLIGATIONS não configurada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Identificador` | `title` | `—` | ⚠️ AUSENTE | `DERIVADO` | Nome da Conta Fixa - YYYY-MM |
| `Conta Fixa` | `relation` | `—` | ⚠️ AUSENTE | `DERIVADO` | Relação com o cadastro permanente |
| `Competência` | `rich_text` | `—` | ⚠️ AUSENTE | `DERIVADO` | Mês de referência (YYYY-MM) |
| `Data de Vencimento` | `date` | `—` | ⚠️ AUSENTE | `DERIVADO` | Data exata do vencimento |
| `Valor Previsto` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Valor esperado herdado da conta fixa |
| `Status` | `select` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Prevista, Paga, Atrasada, Revisão Necessária, Cancelada |
| `Valor Pago` | `number` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Valor efetivamente liquidado |
| `Data do Pagamento` | `date` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Data em que ocorreu a quitação |
| `Transação Vinculada` | `relation` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Relação com a transação que liquidou |
| `Validado Automaticamente` | `checkbox` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | True se correspondência foi inequívoca |
| `Observações / Conflitos` | `rich_text` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Avisos de divergência ou ambiguidade |

### Investimentos (`NOTION_DS_INVESTMENTS`)
* **Status:** `MISSING_ENV_ID`
* **Diagnóstico:** *Variável de ambiente NOTION_DS_INVESTMENTS não configurada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Ativo` | `title` | `—` | ⚠️ AUSENTE | `USUARIO` | Nome do ativo ou produto financeiro |
| `Classe do Ativo` | `select` | `—` | ⚠️ AUSENTE | `USUARIO` | Renda Fixa, Cripto, Ação, FII, ETF, Previdência Privada, Tesouro Direto (Caixa Reservado NÃO é classe de ativo) |
| `Custódia` | `select` | `—` | ⚠️ AUSENTE | `USUARIO` | Conta Pierre ou Carteira Externa |
| `Quantidade` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Posição atual custodiada |
| `Custo de Aquisição (PMP)` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Custo acumulado pelo Preço Médio Ponderado das compras |
| `Valor de Mercado Atual` | `number` | `—` | ⚠️ AUSENTE | `PIERRE` | Cotação atual x quantidade |
| `Lucro / Prejuízo` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Valor de mercado - Custo de aquisição |
| `Conta Vinculada` | `relation` | `—` | ⚠️ AUSENTE | `USUARIO` | Conta corrente ou corretora associada |

### Movimentações de Investimentos (`NOTION_DS_INVESTMENT_MOVEMENTS`)
* **Status:** `MISSING_ENV_ID`
* **Diagnóstico:** *Variável de ambiente NOTION_DS_INVESTMENT_MOVEMENTS não configurada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Identificador` | `title` | `—` | ⚠️ AUSENTE | `DERIVADO` | Tipo - Ativo - Data |
| `Ativo Vinculado` | `relation` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Relação com a posição do ativo |
| `Tipo de Movimentação` | `select` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Aporte de Capital, Resgate de Capital, Compra de Ativo, Venda de Ativo, Rendimento / Provento, Taxas e Impostos, Ajuste de Posição |
| `Data da Operação` | `date` | `—` | ⚠️ AUSENTE | `PIERRE` | Data da execução |
| `Valor Bruto` | `number` | `—` | ⚠️ AUSENTE | `PIERRE` | Volume financeiro total |
| `Valor Líquido` | `number` | `—` | ⚠️ AUSENTE | `PIERRE` | Valor líquido após custos |
| `Quantidade Negociada` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Fração ou unidades transacionadas |
| `Preço Unitário` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Preço médio da ordem |
| `Conta Origem` | `relation` | `—` | ⚠️ AUSENTE | `DERIVADO` | Conta debitada |
| `Conta Destino / Caixa` | `relation` | `—` | ⚠️ AUSENTE | `DERIVADO` | Conta creditada |
| `Transação Financeira` | `relation` | `—` | ⚠️ AUSENTE | `DERIVADO` | Transação bancária vinculada |

### Planejamento Mensal (`NOTION_DS_MONTHLY_BUDGET`)
* **Status:** `MISSING_ENV_ID`
* **Diagnóstico:** *Variável de ambiente NOTION_DS_MONTHLY_BUDGET não configurada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Competência` | `title` | `—` | ⚠️ AUSENTE | `USUARIO` | YYYY-MM |
| `Renda Prevista` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Meta de renda do mês |
| `Teto Mensal Cartão` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Teto pessoal de compras no cartão (ex: R$ 400) |
| `Meta de Poupança/Aporte` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Meta de dinheiro a poupar no mês |
| `Receitas Realizadas` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Soma de transações OPERATING_REVENUE |
| `Despesas Realizadas` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Soma de transações OPERATING_EXPENSE |
| `Poupança Realizada` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Soma de transações com savingsGoalContribution |
| `Compras Realizadas Cartão` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Soma de compras de cartão no mês |

### Metas Financeiras (`NOTION_DS_FINANCIAL_GOALS`)
* **Status:** `MISSING_ENV_ID`
* **Diagnóstico:** *Variável de ambiente NOTION_DS_FINANCIAL_GOALS não configurada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Meta` | `title` | `—` | ⚠️ AUSENTE | `USUARIO` | Nome do objetivo financeiro |
| `Valor Alvo` | `number` | `—` | ⚠️ AUSENTE | `USUARIO` | Montante financeiro desejado |
| `Valor Atual Acumulado` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Saldo alocado para a meta |
| `Prazo Alvo` | `date` | `—` | ⚠️ AUSENTE | `USUARIO` | Data limite para cumprimento |

### Fechamentos Mensais (`NOTION_DS_MONTHLY_CLOSINGS`)
* **Status:** `MISSING_ENV_ID`
* **Diagnóstico:** *Variável de ambiente NOTION_DS_MONTHLY_CLOSINGS não configurada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Mês de Referência` | `title` | `—` | ⚠️ AUSENTE | `DERIVADO` | Fechamento YYYY-MM |
| `Status do Fechamento` | `select` | `—` | ⚠️ AUSENTE | `USUARIO` | Aberto, Pré-fechado, Fechado Auditado |
| `Patrimônio Inicial` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Patrimônio líquido consolidado no início do mês |
| `Renda Consolidada` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Total de receitas operacionais líquidas |
| `Despesas Consolidadas` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Total de despesas correntes de subsistência |
| `Despesas Essenciais (Necessidades)` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Gastos essenciais de moradia, saúde, alimentação, etc. (Regra 50%) |
| `Despesas Discricionárias (Desejos)` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Gastos de estilo de vida, lazer, compras pessoais (Regra 30%) |
| `Total Poupado / Aportado` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Renda - Despesas (Regra 20%) |
| `Taxa de Poupança (%)` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | (Total Poupado / Renda) * 100 |
| `Rendimentos de Investimentos` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Rendimentos e dividendos auferidos no mês |
| `Patrimônio Líquido Final` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Saldo contas + investimentos - dívidas ao fechar o mês |
| `Variação Patrimonial` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Patrimônio Final - Patrimônio Inicial |
| `Observações / Notas do Fechamento` | `rich_text` | `—` | ⚠️ AUSENTE | `USUARIO` | Comentários qualitativos sobre desvios e conquistas do mês |

### Log de Sincronização (`NOTION_DS_SYNC_LOG`)
* **Status:** `MISSING_ENV_ID`
* **Diagnóstico:** *Variável de ambiente NOTION_DS_SYNC_LOG não configurada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Execução` | `title` | `—` | ⚠️ AUSENTE | `DERIVADO` | Sync - YYYY-MM-DD HH:mm:ss |
| `Status` | `select` | `—` | ⚠️ AUSENTE | `DERIVADO` | Sucesso, Sucesso Parcial, Erro, Bloqueado por Concorrência |
| `Data Início` | `date` | `—` | ⚠️ AUSENTE | `DERIVADO` | Timestamp do início da sincronização |
| `Data Fim` | `date` | `—` | ⚠️ AUSENTE | `DERIVADO` | Timestamp do término da sincronização |
| `Duração (s)` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Tempo total de processamento em segundos |
| `Contas Processadas` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Quantidade de contas sincronizadas |
| `Transações Recebidas` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Lançamentos retornados pelo Pierre |
| `Transações Novas` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Novas páginas criadas |
| `Transações Atualizadas` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Páginas existentes com versionHash alterado |
| `Transações Inalteradas` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Transações sem alteração ignoradas |
| `Parcelas Recebidas` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Parcelamentos e faturas futuras identificadas |
| `Enviadas para Revisão` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Transações marcadas como Pendente Revisão |
| `Obrigações Conciliadas` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Compromissos mensais liquidados com sucesso |
| `Freshness da Fonte` | `date` | `—` | ⚠️ AUSENTE | `DERIVADO` | Momento do último dado retornado pelo banco / open finance |
| `Versão do Worker / Commit` | `rich_text` | `—` | ⚠️ AUSENTE | `DERIVADO` | Commit SHA ou tag da versão do worker em execução |
| `Hash do Lote RAW` | `rich_text` | `—` | ⚠️ AUSENTE | `DERIVADO` | SHA-256 do payload bruto salvo no cofre cifrado |
| `Detalhes do Erro` | `rich_text` | `—` | ⚠️ AUSENTE | `DERIVADO` | Stack trace ou mensagem de falha |

### Faturas / Ciclos de Cartão (`NOTION_DS_CARD_BILLS`)
* **Status:** `PROPOSED_NEW_DATABASE`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Fatura / Ciclo` | `title` | `—` | ⚠️ AUSENTE | `DERIVADO` | Ex: Fatura Nubank - Venc 22/07/2026 |
| `Cartão Vinculado` | `relation` | `—` | ⚠️ AUSENTE | `DERIVADO` | Relação com a conta do cartão em Contas |
| `Tipo de Ciclo` | `select` | `—` | ⚠️ AUSENTE | `DERIVADO` | Ciclo Real Banco, Ciclo Configurado, Ciclo Estimado |
| `Status da Fatura` | `select` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Aberta em Curso, Fechada a Vencer, Vencida, Paga Integralmente, Paga Parcialmente |
| `Data de Fechamento` | `date` | `—` | ⚠️ AUSENTE | `PIERRE` | Data de corte (balance_close_date ou configurada) |
| `Data de Vencimento` | `date` | `—` | ⚠️ AUSENTE | `PIERRE` | Data de vencimento (balance_due_date) |
| `Valor da Fatura (Banco)` | `number` | `—` | ⚠️ AUSENTE | `PIERRE` | Valor total consolidado emitido pela instituição |
| `Total de Compras no Ciclo` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Soma real das transações de compra dentro do ciclo corrente |
| `Componentes Adicionais da Fatura` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Diferença entre fatura emitida e compras correntes (parcelas anteriores, encargos, IOF, juros, créditos/estornos) |
| `Divergência Não Explicada` | `number` | `—` | ⚠️ AUSENTE | `DERIVADO` | Discrepância residual caso os componentes adicionais conhecidos não expliquem a diferença |
| `Valor Pago` | `number` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Valor total liquidado até o momento |
| `Data de Liquidação` | `date` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Data do pagamento da fatura |
| `Lançamentos do Ciclo` | `relation` | `—` | ⚠️ AUSENTE | `DERIVADO` | Relação bidirecional com as transações de compra deste ciclo |
| `Transações de Pagamento` | `relation` | `—` | ⚠️ AUSENTE | `REGRA_AUTOMATICA` | Relações com as transações bancárias de saída que quitaram ou amortizaram a fatura (suporta múltiplos pagamentos) |

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
3. Nas bases existentes, revise as propriedades marcadas como `⚠️ AUSENTE` ou `❌ TIPO DIVERGENTE` e adicione/ajuste-as.
4. Execute novamente `pnpm notion:check-schema` para validar que todos os status convergiram para `✅ OK`.
