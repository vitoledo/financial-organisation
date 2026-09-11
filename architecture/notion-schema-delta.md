# Manifesto de Schema-Delta: Notion vs. Modelo de Domínio (Fase 0)

> **Status:** Relatório Técnico de Introspecção e Conformidade de Schema
> **Data da Verificação:** 2026-09-11T02:24:38.901Z
> **Notion API Version:** `2026-03-11`
> **Data Sources Canônicos:** 13 (12 esperados existentes + 1 base proposta)

---

## 1. Resumo Executivo da Verificação

| Métrica de Data Sources | Valor |
| :--- | :--- |
| Total de Data Sources Canônicos | 13 |
| Bases Existentes Esperadas | 12 |
| Bases Configuradas no Ambiente | 12 |
| Bases Verificadas com Sucesso na API | 0 |
| Bases com Falha / Não Verificadas | 12 |
| Base Proposta (a criar externamente) | 1 |

| Status das Propriedades | Quantidade |
| :--- | :--- |
| Correspondência Exata (EXACT_MATCH) | 0 |
| Renomeações Mapeadas por Alias (RENAME_CANDIDATE) | 0 |
| Divergência Estrutural em Nome Exato (STRUCTURAL_MISMATCH) | 0 |
| Alias com Divergência Estrutural (RENAME_STRUCTURAL_MISMATCH) | 0 |
| Mapeamento por Alias com Tipo Divergente (RENAME_TYPE_MISMATCH) | 0 |
| Sugestões Heurísticas Não-Autoritativas (HEURISTIC_SUGGESTION) | 0 |
| Divergências de Tipo em Nome Exato (TYPE_MISMATCH) | 0 |
| Propriedades Ausentes em Bases Verificadas (MISSING) | 0 |
| Propriedades Não Verificadas (UNVERIFIED / UNKNOWN) | 178 |
| Propriedades a Criar na 13ª Base (PROPOSED_TO_CREATE) | 14 |
| Propriedades Adicionais Preservadas (EXTRA_PRESERVE) | 0 |

> [!IMPORTANT]
> **Atenção sobre Introspecção e Credenciais:**
> A variável `NOTION_API_KEY` não foi encontrada no ambiente. As 12 bases configuradas foram marcadas como `UNVERIFIED_NO_KEY` e suas propriedades como `UNVERIFIED`.
> Para executar a introspecção remota ao vivo contra o Notion, defina `NOTION_API_KEY` em `.env` e rode `pnpm notion:check-schema`.

---

## 2. Diagnóstico Detalhado por Data Source

### Contas (`NOTION_DS_ACCOUNTS`)
* **Status:** `UNVERIFIED_NO_KEY`
* **Data Source ID (Parcial):** `a174...f4a2`
* **Diagnóstico:** *NOTION_API_KEY ausente no ambiente. Introspecção remota na API não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Nome da Conta` | `title` | `—` | ❓ UNVERIFIED | `PIERRE` | Nome identificador da conta |
| `Fonte` | `select` | `—` | ❓ UNVERIFIED | `PIERRE` | Sistema ou conector de origem (ex: PIERRE, MANUAL) |
| `ID da Fonte` | `rich_text` | `—` | ❓ UNVERIFIED | `PIERRE` | Identificador unívoco da conta no sistema de origem |
| `Moeda` | `select` | `—` | ❓ UNVERIFIED | `PIERRE` | Código da moeda da conta (ex: BRL, USD) |
| `Instituição` | `select` | `—` | ❓ UNVERIFIED | `PIERRE` | Nome do banco / conector (ex: Nubank, Mercado Pago) |
| `Tipo de Conta` | `select` | `—` | ❓ UNVERIFIED | `PIERRE` | CHECKING_ACCOUNT, CREDIT_CARD, SAVINGS |
| `Saldo Atual` | `number` | `—` | ❓ UNVERIFIED | `PIERRE` | Saldo disponível em reais |
| `Limite Contratado` | `number` | `—` | ❓ UNVERIFIED | `PIERRE` | Limite total concedido pelo banco (ex: R$ 2.400) |
| `Limite Personalizado` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Teto operacional ajustado pelo usuário no app (ex: R$ 400) |
| `Limite Disponível` | `number` | `—` | ❓ UNVERIFIED | `PIERRE` | Limite de crédito livre no momento |
| `Limite Operacional Usado` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | customizedCreditLimit - availableCreditLimit |
| `Limite Usado (Pierre Bruto)` | `number` | `—` | ❓ UNVERIFIED | `PIERRE` | Valor bruto reportado pelo Pierre para auditoria de inconsistência |
| `Dia de Fechamento` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Dia do mês do corte da fatura |
| `Dia de Vencimento` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Dia do mês do vencimento da fatura |
| `Incluir no Caixa` | `checkbox` | `—` | ❓ UNVERIFIED | `USUARIO` | Indica se computa para liquidez imediata |
| `Incluir no Patrimônio` | `checkbox` | `—` | ❓ UNVERIFIED | `USUARIO` | Indica se computa para o patrimônio total |
| `Última Sincronização` | `date` | `—` | ❓ UNVERIFIED | `DERIVADO` | Timestamp da sincronização |

### Transações (`NOTION_DS_TRANSACTIONS`)
* **Status:** `UNVERIFIED_NO_KEY`
* **Data Source ID (Parcial):** `1fc2...f199`
* **Diagnóstico:** *NOTION_API_KEY ausente no ambiente. Introspecção remota na API não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Descrição` | `title` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Descrição tratada da transação |
| `Fonte` | `select` | `—` | ❓ UNVERIFIED | `PIERRE` | Sistema ou conector de origem (ex: PIERRE, MANUAL) |
| `ID da Fonte` | `rich_text` | `—` | ❓ UNVERIFIED | `PIERRE` | Identificador unívoco da transação no sistema de origem |
| `Moeda` | `select` | `—` | ❓ UNVERIFIED | `PIERRE` | Código da moeda da transação (ex: BRL, USD) |
| `Hash Canônico` | `rich_text` | `—` | ❓ UNVERIFIED | `DERIVADO` | Fingerprint SHA-256 (64 chars) de versão |
| `Data` | `date` | `—` | ❓ UNVERIFIED | `PIERRE` | Data da transação (ISO-8601) |
| `Valor` | `number` | `—` | ❓ UNVERIFIED | `PIERRE` | Valor monetário absoluto (R$) |
| `Valor Bruto Pierre` | `number` | `—` | ❓ UNVERIFIED | `PIERRE` | Valor exato retornado pelo Pierre com sinal original |
| `Movimento` | `select` | `—` | ❓ UNVERIFIED | `PIERRE` | Entrada ou Saída de caixa físico |
| `Natureza Econômica` | `select` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Classificação contábil da operação |
| `Efeito Orçamentário` | `select` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | INCOME | EXPENSE | REVERSAL | NEUTRAL |
| `Propósito de Alocação` | `select` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | INVESTMENT_RESERVE | OPERATIONAL_CASH | etc. |
| `Contribuição Meta Poupança` | `number` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Valor que pontua na meta de poupança (ex: R$ 500 aporte) |
| `Conta` | `relation` | `—` | ❓ UNVERIFIED | `DERIVADO` | Relação com base Contas |
| `Categoria` | `relation` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Relação com Categorias Financeiras |
| `Fatura Vinculada` | `relation` | `—` | ❓ UNVERIFIED | `DERIVADO` | Relação com 13ª base Faturas / Ciclos |
| `Status Banco` | `select` | `—` | ❓ UNVERIFIED | `PIERRE` | Pendente ou Confirmado |
| `Status de Revisão` | `select` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Confirmado Auto, Pendente Revisão, Validado Manualmente, Legado Não Verificado |
| `Motivo da Revisão` | `rich_text` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Justificativa para intervenção humana |
| `Categoria Pierre` | `rich_text` | `—` | ❓ UNVERIFIED | `PIERRE` | Categoria bruta do open-finance |
| `Descrição Original` | `rich_text` | `—` | ❓ UNVERIFIED | `PIERRE` | Texto original do extrato |
| `HMAC Contraparte` | `rich_text` | `—` | ❓ UNVERIFIED | `DERIVADO` | Hash seguro do CPF/CNPJ para matching sem expor PII |

### Categorias Financeiras (`NOTION_DS_CATEGORIES`)
* **Status:** `UNVERIFIED_NO_KEY`
* **Data Source ID (Parcial):** `eb8e...13b4`
* **Diagnóstico:** *NOTION_API_KEY ausente no ambiente. Introspecção remota na API não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Nome da Categoria` | `title` | `—` | ❓ UNVERIFIED | `USUARIO` | Nome da categoria |
| `Grupo Orçamentário` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | Agrupamento macro orçamentário configurável (ex: Essencial, Estilo de Vida, Metas, Estrutural) |
| `Variabilidade` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | Fixa, Variável, Ocasional |
| `Natureza Padrão` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | Natureza contábil sugerida |

### Regras de Classificação (`NOTION_DS_RULES`)
* **Status:** `UNVERIFIED_NO_KEY`
* **Data Source ID (Parcial):** `b36b...0fbb`
* **Diagnóstico:** *NOTION_API_KEY ausente no ambiente. Introspecção remota na API não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Nome da Regra` | `title` | `—` | ❓ UNVERIFIED | `USUARIO` | Título descritivo da regra |
| `Prioridade` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Ordem de avaliação (1 = prioridade máxima) |
| `Ativa` | `checkbox` | `—` | ❓ UNVERIFIED | `USUARIO` | Liga/desliga a regra |
| `Auto Aplicar` | `checkbox` | `—` | ❓ UNVERIFIED | `USUARIO` | Se falso, obriga envio para revisão |
| `Exigir Revisão` | `checkbox` | `—` | ❓ UNVERIFIED | `USUARIO` | Se verdadeiro, marca para checagem humana |
| `Condição: Contraparte` | `rich_text` | `—` | ❓ UNVERIFIED | `USUARIO` | Substring ou nome do merchant/destinatário |
| `Condição: Descrição` | `rich_text` | `—` | ❓ UNVERIFIED | `USUARIO` | Substring ou regex na descrição |
| `Condição: Movimento` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | Qualquer, Entrada, Saída |
| `Condição: Conta` | `relation` | `—` | ❓ UNVERIFIED | `USUARIO` | Conta de origem específica |
| `Condição: Categoria Pierre` | `rich_text` | `—` | ❓ UNVERIFIED | `USUARIO` | Categoria original Pierre |
| `Condição: Valor Exato` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Valor monetário exato |
| `Condição: Tolerância Valor` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Tolerância aceitável em reais |
| `Condição: Valor Mínimo` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Piso do valor |
| `Condição: Valor Máximo` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Teto do valor |
| `Condição: Dia Mês Início` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Dia inicial do mês (1 a 31) |
| `Condição: Dia Mês Fim` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Dia final do mês (1 a 31) |
| `Válida de` | `date` | `—` | ❓ UNVERIFIED | `USUARIO` | Início da vigência da regra |
| `Válida até` | `date` | `—` | ❓ UNVERIFIED | `USUARIO` | Término da vigência da regra |
| `Atribuir: Natureza` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | Natureza atribuída |
| `Atribuir: Efeito Orçamento` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | INCOME, EXPENSE, REVERSAL, NEUTRAL |
| `Atribuir: Alocação` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | Finalidade da movimentação |
| `Atribuir: Categoria` | `relation` | `—` | ❓ UNVERIFIED | `USUARIO` | Categoria vinculada |

### Contas Fixas (`NOTION_DS_FIXED_BILLS`)
* **Status:** `UNVERIFIED_NO_KEY`
* **Data Source ID (Parcial):** `49e9...dfb9`
* **Diagnóstico:** *NOTION_API_KEY ausente no ambiente. Introspecção remota na API não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Nome da Conta Fixa` | `title` | `—` | ❓ UNVERIFIED | `USUARIO` | Nome do compromisso recorrente |
| `Valor Previsto` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Valor esperado por competência |
| `Tolerância (R$)` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Tolerância para conciliação automática |
| `Periodicidade` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | Mensal, Bimestral, Trimestral, Semestral, Anual |
| `Competência Âncora` | `rich_text` | `—` | ❓ UNVERIFIED | `USUARIO` | Mês de referência inicial (ex: 2026-01) |
| `Última Competência Gerada` | `rich_text` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Último mês gerado em Obrigações (ex: 2026-08) |
| `Dia de Vencimento` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Dia do mês do vencimento (1 a 31) |
| `Forma de Pagamento` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | Cartão de Crédito, Débito em Conta, Pix, Boleto |
| `Conta Padrão` | `relation` | `—` | ❓ UNVERIFIED | `USUARIO` | Conta de débito usual |
| `Categoria` | `relation` | `—` | ❓ UNVERIFIED | `USUARIO` | Categoria orçamentária |
| `Padrão de Identificação` | `rich_text` | `—` | ❓ UNVERIFIED | `USUARIO` | Expressão / substring para conciliação automática |
| `Ativa` | `checkbox` | `—` | ❓ UNVERIFIED | `USUARIO` | Gera obrigações no período |
| `Gerar obrigação` | `checkbox` | `—` | ❓ UNVERIFIED | `USUARIO` | Se ativado, gera automaticamente os lançamentos em Obrigações Mensais a cada competência |
| `Observações / Contrato` | `rich_text` | `—` | ❓ UNVERIFIED | `USUARIO` | Código do assinante, detalhes do contrato ou instruções |
| `Data de Início` | `date` | `—` | ❓ UNVERIFIED | `USUARIO` | Início da vigência do contrato |
| `Data de Término` | `date` | `—` | ❓ UNVERIFIED | `USUARIO` | Término da vigência do contrato |

### Obrigações Mensais (`NOTION_DS_MONTHLY_OBLIGATIONS`)
* **Status:** `UNVERIFIED_NO_KEY`
* **Data Source ID (Parcial):** `5c59...f6b8`
* **Diagnóstico:** *NOTION_API_KEY ausente no ambiente. Introspecção remota na API não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Identificador` | `title` | `—` | ❓ UNVERIFIED | `DERIVADO` | Nome da Conta Fixa - YYYY-MM |
| `Conta Fixa` | `relation` | `—` | ❓ UNVERIFIED | `DERIVADO` | Relação com o cadastro permanente |
| `Competência` | `rich_text` | `—` | ❓ UNVERIFIED | `DERIVADO` | Mês de referência (YYYY-MM) |
| `Data de Vencimento` | `date` | `—` | ❓ UNVERIFIED | `DERIVADO` | Data exata do vencimento |
| `Valor Previsto` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Valor esperado herdado da conta fixa |
| `Status` | `select` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Prevista, Paga, Atrasada, Revisão Necessária, Cancelada |
| `Valor Pago` | `number` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Valor efetivamente liquidado |
| `Data do Pagamento` | `date` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Data em que ocorreu a quitação |
| `Transação Vinculada` | `relation` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Relação com a transação que liquidou |
| `Validado Automaticamente` | `checkbox` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | True se correspondência foi inequívoca |
| `Observações / Conflitos` | `rich_text` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Avisos de divergência ou ambiguidade |

### Investimentos (`NOTION_DS_INVESTMENTS`)
* **Status:** `UNVERIFIED_NO_KEY`
* **Data Source ID (Parcial):** `db60...b6cb`
* **Diagnóstico:** *NOTION_API_KEY ausente no ambiente. Introspecção remota na API não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Ativo` | `title` | `—` | ❓ UNVERIFIED | `USUARIO` | Nome do ativo ou produto financeiro |
| `Classe do Ativo` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | Renda Fixa, Cripto, Ação, FII, ETF, Previdência Privada, Tesouro Direto (Caixa Reservado NÃO é classe de ativo) |
| `Custódia` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | Conta Pierre ou Carteira Externa |
| `Moeda` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | Código da moeda do ativo (BRL, USD, BTC, EUR) |
| `Quantidade` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Posição atual custodiada |
| `Preço Médio Unitário (PMP)` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Preço médio ponderado unitário de aquisição |
| `Custo Base Total` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Montante total acumulado desembolsado nas compras (base de custo contábil) |
| `Valor de Mercado Atual` | `number` | `—` | ❓ UNVERIFIED | `PIERRE` | Posição a mercado: Cotação atual x quantidade |
| `Lucro / Prejuízo Não Realizado` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Valor de Mercado Atual - Custo Base Total |
| `Retorno Não Realizado (%)` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | ((Valor de Mercado Atual - Custo Base Total) / Custo Base Total) * 100 |
| `Liquidez` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | Prazo de liquidez (ex: D+0, D+1, D+30, No Vencimento) |
| `Fonte da Avaliação` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | Origem da cotação a mercado (ex: Pierre, B3, Manual, Cripto API) |
| `Data da Avaliação` | `date` | `—` | ❓ UNVERIFIED | `DERIVADO` | Data/hora da última cotação de mercado capturada |
| `Incluir no Patrimônio` | `checkbox` | `—` | ❓ UNVERIFIED | `USUARIO` | Indica se esta posição deve compor o cálculo de patrimônio líquido final |
| `Instituição / Corretora` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | Corretora ou custodiante do investimento (ex: NuInvest, Binance, XP, BTG) |
| `ID do Ativo na Fonte` | `rich_text` | `—` | ❓ UNVERIFIED | `PIERRE` | Identificador único do ativo na API de origem para sincronização |
| `Conta Vinculada` | `relation` | `—` | ❓ UNVERIFIED | `USUARIO` | Conta corrente ou corretora associada |

### Movimentações de Investimentos (`NOTION_DS_INVESTMENT_MOVEMENTS`)
* **Status:** `UNVERIFIED_NO_KEY`
* **Data Source ID (Parcial):** `b19f...25af`
* **Diagnóstico:** *NOTION_API_KEY ausente no ambiente. Introspecção remota na API não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Identificador` | `title` | `—` | ❓ UNVERIFIED | `DERIVADO` | Tipo - Ativo - Data |
| `Ativo Vinculado` | `relation` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Relação com a posição do ativo |
| `Tipo de Movimentação` | `select` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Aporte de Capital, Resgate de Capital, Compra de Ativo, Venda de Ativo, Rendimento / Provento, Taxas e Impostos, Ajuste de Posição |
| `Data da Operação` | `date` | `—` | ❓ UNVERIFIED | `PIERRE` | Data da execução |
| `Valor Bruto` | `number` | `—` | ❓ UNVERIFIED | `PIERRE` | Volume financeiro total |
| `Valor Líquido` | `number` | `—` | ❓ UNVERIFIED | `PIERRE` | Valor líquido após custos |
| `Quantidade Negociada` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Fração ou unidades transacionadas |
| `Preço Unitário` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Preço médio da ordem |
| `Conta Origem` | `relation` | `—` | ❓ UNVERIFIED | `DERIVADO` | Conta debitada |
| `Conta Destino / Caixa` | `relation` | `—` | ❓ UNVERIFIED | `DERIVADO` | Conta creditada |
| `Transação Financeira` | `relation` | `—` | ❓ UNVERIFIED | `DERIVADO` | Transação bancária vinculada |

### Planejamento Mensal (`NOTION_DS_MONTHLY_BUDGET`)
* **Status:** `UNVERIFIED_NO_KEY`
* **Data Source ID (Parcial):** `0c14...c7d5`
* **Diagnóstico:** *NOTION_API_KEY ausente no ambiente. Introspecção remota na API não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Competência` | `title` | `—` | ❓ UNVERIFIED | `USUARIO` | YYYY-MM |
| `Renda Prevista` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Meta de renda do mês |
| `Teto Mensal Cartão` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Teto pessoal de compras no cartão (ex: R$ 400) |
| `Meta de Poupança/Aporte` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Meta de dinheiro a poupar no mês |
| `Metas por Grupo Orçamentário` | `rich_text` | `—` | ❓ UNVERIFIED | `USUARIO` | Metas percentuais ou tetos nominais por grupo orçamentário configurável |
| `Meta Taxa de Poupança (%)` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Percentual alvo da renda líquida destinado a investimentos e reservas |
| `Receitas Realizadas` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Soma de transações OPERATING_REVENUE |
| `Despesas Realizadas` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Soma de transações OPERATING_EXPENSE |
| `Poupança Realizada` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Soma de transações com savingsGoalContribution |
| `Compras Realizadas Cartão` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Soma de compras de cartão no mês |

### Metas Financeiras (`NOTION_DS_FINANCIAL_GOALS`)
* **Status:** `UNVERIFIED_NO_KEY`
* **Data Source ID (Parcial):** `b629...ed91`
* **Diagnóstico:** *NOTION_API_KEY ausente no ambiente. Introspecção remota na API não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Meta` | `title` | `—` | ❓ UNVERIFIED | `USUARIO` | Nome do objetivo financeiro |
| `Valor Alvo` | `number` | `—` | ❓ UNVERIFIED | `USUARIO` | Montante financeiro desejado |
| `Valor Atual Acumulado` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Saldo alocado para a meta |
| `Prazo Alvo` | `date` | `—` | ❓ UNVERIFIED | `USUARIO` | Data limite para cumprimento |

### Fechamentos Mensais (`NOTION_DS_MONTHLY_CLOSINGS`)
* **Status:** `UNVERIFIED_NO_KEY`
* **Data Source ID (Parcial):** `74ff...b94c`
* **Diagnóstico:** *NOTION_API_KEY ausente no ambiente. Introspecção remota na API não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Mês de Referência` | `title` | `—` | ❓ UNVERIFIED | `DERIVADO` | Fechamento YYYY-MM |
| `Status do Fechamento` | `select` | `—` | ❓ UNVERIFIED | `USUARIO` | Aberto, Pré-fechado, Fechado Auditado |
| `Status de Reconciliação` | `select` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Conciliado Integralmente, Divergências Pendentes, Reconciliação Manual Necessária |
| `Qualidade dos Dados` | `select` | `—` | ❓ UNVERIFIED | `REGRA_AUTOMATICA` | Nota ou classificação da confiabilidade dos lançamentos do mês |
| `Patrimônio Inicial` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Patrimônio líquido consolidado no início do mês |
| `Renda Consolidada` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Total de receitas operacionais líquidas |
| `Despesas Consolidadas` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Total de despesas correntes de subsistência e consumo |
| `Despesas Essenciais (Necessidades)` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Gastos essenciais de moradia, saúde, alimentação básica |
| `Despesas Discricionárias (Desejos)` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Gastos de estilo de vida, lazer e compras |
| `Resultado do Mês (Sobra Operacional)` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Renda Consolidada - Despesas Consolidadas (fluxo de caixa operacional livre do mês antes de aportes) |
| `Poupança / Aportes Realizados` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Total efetivamente poupado e transferido para investimentos no mês |
| `Taxa de Poupança (%)` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | (Poupança / Aportes Realizados / Renda Consolidada) * 100 |
| `Fluxo Residual Não Alocado` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Sobra Operacional - Poupança/Aportes Realizados |
| `Rendimentos de Investimentos` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Rendimentos e dividendos auferidos no mês |
| `Patrimônio Líquido Final` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Saldo contas + investimentos - dívidas ao fechar o mês |
| `Variação Patrimonial` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Patrimônio Final - Patrimônio Inicial |
| `Contas Fixas Pagas` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Contagem de obrigações fixas da competência com status Paga |
| `Contas Fixas Pendentes` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Contagem de obrigações fixas da competência ainda pendentes ou atrasadas |
| `Itens para Revisão` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Contagem de transações ou lançamentos da competência aguardando revisão humana |
| `Fechado Em` | `date` | `—` | ❓ UNVERIFIED | `USUARIO` | Data/hora em que o fechamento mensal foi consolidado e trancado |
| `Observações / Notas do Fechamento` | `rich_text` | `—` | ❓ UNVERIFIED | `USUARIO` | Comentários qualitativos sobre desvios e conquistas do mês |

### Log de Sincronização (`NOTION_DS_SYNC_LOG`)
* **Status:** `UNVERIFIED_NO_KEY`
* **Data Source ID (Parcial):** `2a61...3d20`
* **Diagnóstico:** *NOTION_API_KEY ausente no ambiente. Introspecção remota na API não executada.*

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Execução` | `title` | `—` | ❓ UNVERIFIED | `DERIVADO` | Sync - YYYY-MM-DD HH:mm:ss |
| `Status` | `select` | `—` | ❓ UNVERIFIED | `DERIVADO` | Sucesso, Sucesso Parcial, Erro, Bloqueado por Concorrência |
| `Fonte de Sincronização` | `select` | `—` | ❓ UNVERIFIED | `DERIVADO` | Sistema ou conector de origem da sincronização (ex: PIERRE, MANUAL_CSV, MIGRATION) |
| `Data Início` | `date` | `—` | ❓ UNVERIFIED | `DERIVADO` | Timestamp do início da sincronização |
| `Data Fim` | `date` | `—` | ❓ UNVERIFIED | `DERIVADO` | Timestamp do término da sincronização |
| `Duração (s)` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Tempo total de processamento em segundos |
| `Duração (ms)` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Tempo total de processamento em milissegundos |
| `Contas Processadas` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Quantidade de contas sincronizadas |
| `Transações Recebidas` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Lançamentos retornados pelo Pierre |
| `Transações Novas` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Novas páginas criadas |
| `Transações Atualizadas` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Páginas existentes com versionHash alterado |
| `Transações Inalteradas` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Transações sem alteração ignoradas |
| `Erros Encontrados` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Total de falhas ou exceções não fatais registradas durante o lote |
| `Parcelas Recebidas` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Parcelamentos e faturas futuras identificadas |
| `Enviadas para Revisão` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Transações marcadas como Pendente Revisão |
| `Obrigações Conciliadas` | `number` | `—` | ❓ UNVERIFIED | `DERIVADO` | Compromissos mensais liquidados com sucesso |
| `Freshness da Fonte` | `date` | `—` | ❓ UNVERIFIED | `DERIVADO` | Momento do último dado retornado pelo banco / open finance |
| `ID da Execução (Run ID)` | `rich_text` | `—` | ❓ UNVERIFIED | `DERIVADO` | UUID unívoco da execução do worker |
| `Código do Erro` | `select` | `—` | ❓ UNVERIFIED | `DERIVADO` | Código padronizado de erro (ex: AUTH_EXPIRED, NETWORK_TIMEOUT, VALIDATION_ERROR) |
| `Mensagem de Erro Sanitizada` | `rich_text` | `—` | ❓ UNVERIFIED | `DERIVADO` | Mensagem descritiva tratada, sem stack trace ou dados sensíveis |
| `Referência do Log Privado` | `rich_text` | `—` | ❓ UNVERIFIED | `DERIVADO` | Identificador do registro detalhado no armazenamento privado cifrado |
| `Hash do Lote RAW` | `rich_text` | `—` | ❓ UNVERIFIED | `DERIVADO` | SHA-256 do payload bruto salvo no cofre cifrado |
| `Versão do Worker / Commit` | `rich_text` | `—` | ❓ UNVERIFIED | `DERIVADO` | Commit SHA ou tag da versão do worker em execução |

### Faturas / Ciclos de Cartão (`NOTION_DS_CARD_BILLS`)
* **Status:** `PROPOSED_NEW_DATABASE`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Fatura / Ciclo` | `title` | `—` | 🆕 PROPOSED_TO_CREATE | `DERIVADO` | Ex: Fatura Nubank - Venc 22/07/2026 |
| `Cartão Vinculado` | `relation` | `—` | 🆕 PROPOSED_TO_CREATE | `DERIVADO` | Relação com a conta do cartão em Contas |
| `Tipo de Ciclo` | `select` | `—` | 🆕 PROPOSED_TO_CREATE | `DERIVADO` | Ciclo Real Banco, Ciclo Configurado, Ciclo Estimado |
| `Status da Fatura` | `select` | `—` | 🆕 PROPOSED_TO_CREATE | `REGRA_AUTOMATICA` | Aberta em Curso, Fechada a Vencer, Vencida, Paga Integralmente, Paga Parcialmente |
| `Data de Fechamento` | `date` | `—` | 🆕 PROPOSED_TO_CREATE | `PIERRE` | Data de corte (balance_close_date ou configurada) |
| `Data de Vencimento` | `date` | `—` | 🆕 PROPOSED_TO_CREATE | `PIERRE` | Data de vencimento (balance_due_date) |
| `Valor da Fatura (Banco)` | `number` | `—` | 🆕 PROPOSED_TO_CREATE | `PIERRE` | Valor total consolidado emitido pela instituição |
| `Total de Compras no Ciclo` | `number` | `—` | 🆕 PROPOSED_TO_CREATE | `DERIVADO` | Soma real das transações de compra dentro do ciclo corrente |
| `Componentes Adicionais da Fatura` | `number` | `—` | 🆕 PROPOSED_TO_CREATE | `DERIVADO` | Soma dos componentes adicionais identificados (parcelas anteriores, encargos, IOF, juros, créditos/estornos) |
| `Divergência Não Explicada` | `number` | `—` | 🆕 PROPOSED_TO_CREATE | `DERIVADO` | Discrepância residual caso os componentes adicionais conhecidos não expliquem a diferença |
| `Valor Pago` | `number` | `—` | 🆕 PROPOSED_TO_CREATE | `REGRA_AUTOMATICA` | Valor total liquidado até o momento |
| `Data de Liquidação` | `date` | `—` | 🆕 PROPOSED_TO_CREATE | `REGRA_AUTOMATICA` | Data do pagamento da fatura |
| `Lançamentos do Ciclo` | `relation` | `—` | 🆕 PROPOSED_TO_CREATE | `DERIVADO` | Relação bidirecional com as transações de compra deste ciclo |
| `Transações de Pagamento` | `relation` | `—` | 🆕 PROPOSED_TO_CREATE | `REGRA_AUTOMATICA` | Relações com as transações bancárias de saída que quitaram ou amortizaram a fatura (suporta múltiplos pagamentos) |

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
| `Componentes Adicionais da Fatura` | `number` | `write` | `DERIVADO` | Soma dos componentes adicionais identificados (parcelas anteriores, encargos, IOF, juros, créditos/estornos) |
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
