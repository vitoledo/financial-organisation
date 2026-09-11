# Manifesto de Schema-Delta: Notion vs. Modelo de Domínio (Fase 0)

> **Status:** Relatório Técnico de Introspecção e Conformidade de Schema
> **Data da Verificação:** 2026-09-11T11:22:01.112Z
> **Notion API Version:** `2026-03-11`
> **Data Sources Canônicos:** 13 (12 esperados existentes + 1 base proposta)

---

## 1. Resumo Executivo da Verificação

| Métrica de Data Sources | Valor |
| :--- | :--- |
| Total de Data Sources Canônicos | 13 |
| Bases Existentes Esperadas | 12 |
| Bases Configuradas no Ambiente | 12 |
| Bases Verificadas com Sucesso na API | 12 |
| Bases com Falha / Não Verificadas | 0 |
| Base Proposta (a criar externamente) | 1 |

| Status das Propriedades | Quantidade |
| :--- | :--- |
| Correspondência Exata (EXACT_MATCH) | 45 |
| Renomeações Mapeadas por Alias (RENAME_CANDIDATE) | 35 |
| Divergência Estrutural em Nome Exato (STRUCTURAL_MISMATCH) | 10 |
| Alias com Divergência Estrutural (RENAME_STRUCTURAL_MISMATCH) | 10 |
| Mapeamento por Alias com Tipo Divergente (RENAME_TYPE_MISMATCH) | 1 |
| Sugestões Heurísticas Não-Autoritativas (HEURISTIC_SUGGESTION) | 12 |
| Divergências de Tipo em Nome Exato (TYPE_MISMATCH) | 2 |
| Propriedades Ausentes em Bases Verificadas (MISSING) | 63 |
| Propriedades Não Verificadas (UNVERIFIED / UNKNOWN) | 0 |
| Propriedades a Criar na 13ª Base (PROPOSED_TO_CREATE) | 14 |
| Propriedades Adicionais Preservadas (EXTRA_PRESERVE) | 67 |

---

## 2. Diagnóstico Detalhado por Data Source

### Contas (`NOTION_DS_ACCOUNTS`)
* **Status:** `CONFIGURED_AND_VERIFIED`
* **Data Source ID (Parcial):** `a174...f4a2`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Fonte` | `select` | `select` | ⚠️ STRUCTURAL_MISMATCH | `UPSTREAM` | Sistema ou conector de origem (ex: PIERRE, MANUAL, MIGRATION, OTHER) [Divergência Estrutural: Opções ausentes no Notion (1): "Migração"] |
| `ID da fonte` | `rich_text` | `rich_text` | ✅ EXACT_MATCH | `UPSTREAM` | Identificador unívoco da conta no sistema de origem |
| `Moeda` | `select` | `select` | ⚠️ STRUCTURAL_MISMATCH | `UPSTREAM` | Código da moeda da conta (ex: BRL, USD) [Divergência Estrutural: Opções ausentes no Notion (1): "EUR"] |
| `Instituição` | `select` | `rich_text` | ❌ TYPE_MISMATCH (esperado: select, no Notion: rich_text) | `UPSTREAM` | Nome do banco / conector (ex: Nubank, Mercado Pago) |
| `Limite contratado` | `number` | `number` | ✅ EXACT_MATCH | `UPSTREAM` | Limite total concedido pelo banco (ex: R$ 2.400) |
| `Limite personalizado` | `number` | `number` | ✅ EXACT_MATCH | `USUARIO` | Teto operacional ajustado pelo usuário no app (ex: R$ 400) |
| `Limite disponível` | `number` | `number` | ✅ EXACT_MATCH | `UPSTREAM` | Limite de crédito livre no momento |
| `Nome da Conta` | `title` | `title` | 🔄 RENAME_CANDIDATE (`Conta`) | `UPSTREAM` | Nome identificador da conta (Mapeado via alias explícito: "Conta" com tipo compatível: title) |
| `Tipo de Conta` | `select` | `select` | 🔄⚠️ RENAME_STRUCTURAL_MISMATCH (`Tipo`) | `UPSTREAM` | CHECKING_ACCOUNT, CREDIT_CARD, SAVINGS (Mapeado via alias explícito: "Tipo", tipo compatível, mas com divergência estrutural: Opções ausentes no Notion (3): "Conta Poupança", "Conta de Investimento", "Carteira Dinheiro") |
| `Saldo Atual` | `number` | `number` | 🔄 RENAME_CANDIDATE (`Saldo`) | `UPSTREAM` | Saldo disponível em reais (Mapeado via alias explícito: "Saldo" com tipo compatível: number) |
| `Última Sincronização` | `date` | `date` | 🔄 RENAME_CANDIDATE (`Atualizado em`) | `DERIVADO` | Timestamp da sincronização (Mapeado via alias explícito: "Atualizado em" com tipo compatível: date) |
| `Limite Operacional Usado` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | customizedCreditLimit - availableCreditLimit |
| `Limite Usado (Pierre Bruto)` | `number` | `—` | ⚠️ MISSING | `UPSTREAM` | Valor bruto reportado pelo Pierre para auditoria de inconsistência |
| `Dia de Fechamento` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Dia do mês do corte da fatura |
| `Dia de Vencimento` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Dia do mês do vencimento da fatura |
| `Incluir no Caixa` | `checkbox` | `checkbox` | 💡 HEURISTIC_SUGGESTION (`Inclui no caixa`) [Não-autoritativo] | `USUARIO` | Indica se computa para liquidez imediata (Sugestão heurística não-autoritativa: "Inclui no caixa" [checkbox], similaridade: 93%. Requer confirmação por alias explícito). |
| `Incluir no Patrimônio` | `checkbox` | `checkbox` | 💡 HEURISTIC_SUGGESTION (`Inclui no patrimônio`) [Não-autoritativo] | `USUARIO` | Indica se computa para o patrimônio total (Sugestão heurística não-autoritativa: "Inclui no patrimônio" [checkbox], similaridade: 95%. Requer confirmação por alias explícito). |
| `Ativa` | `—` | `checkbox` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Inclui no caixa` | `—` | `checkbox` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Observações` | `—` | `rich_text` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Inclui no patrimônio` | `—` | `checkbox` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |

### Transações (`NOTION_DS_TRANSACTIONS`)
* **Status:** `CONFIGURED_AND_VERIFIED`
* **Data Source ID (Parcial):** `1fc2...f199`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Fonte` | `select` | `select` | ✅ EXACT_MATCH | `UPSTREAM` | Sistema ou conector de origem (ex: PIERRE, MANUAL, MIGRATION, OTHER) |
| `ID da fonte` | `rich_text` | `rich_text` | ✅ EXACT_MATCH | `UPSTREAM` | Identificador unívoco da transação no sistema de origem |
| `Moeda` | `select` | `select` | ⚠️ STRUCTURAL_MISMATCH | `UPSTREAM` | Código da moeda da transação (ex: BRL, USD) [Divergência Estrutural: Opções ausentes no Notion (1): "EUR"] |
| `Data` | `date` | `date` | ✅ EXACT_MATCH | `UPSTREAM` | Data da transação (ISO-8601) |
| `Valor` | `number` | `number` | ✅ EXACT_MATCH | `UPSTREAM` | Valor monetário absoluto (R$) |
| `Movimento` | `select` | `select` | ✅ EXACT_MATCH | `UPSTREAM` | Entrada ou Saída de caixa físico |
| `Conta` | `relation` | `relation` | ✅ EXACT_MATCH | `DERIVADO` | Relação com base Contas |
| `Categoria` | `relation` | `relation` | ✅ EXACT_MATCH | `REGRA_AUTOMATICA` | Relação com Categorias Financeiras |
| `Categoria Pierre` | `rich_text` | `rich_text` | ✅ EXACT_MATCH | `UPSTREAM` | Categoria bruta do open-finance |
| `Descrição original` | `rich_text` | `rich_text` | ✅ EXACT_MATCH | `UPSTREAM` | Texto original do extrato |
| `Descrição` | `title` | `title` | 🔄 RENAME_CANDIDATE (`Lançamento`) | `REGRA_AUTOMATICA` | Descrição tratada da transação (Mapeado via alias explícito: "Lançamento" com tipo compatível: title) |
| `Natureza Econômica` | `select` | `select` | 🔄⚠️ RENAME_STRUCTURAL_MISMATCH (`Natureza`) | `REGRA_AUTOMATICA` | Classificação contábil da operação (Mapeado via alias explícito: "Natureza", tipo compatível, mas com divergência estrutural: Opções ausentes no Notion (11): "Receita Operacional", "Despesa Operacional", "Aporte de Capital", "Resgate de Capital", "Compra de Ativo", "Venda de Ativo", "Rendimento / Provento", "Amortização de Dívida", "Juros / Encargos de Dívida", "Reembolso / Estorno", "Ajuste Contábil") |
| `Status Banco` | `select` | `select` | 🔄⚠️ RENAME_STRUCTURAL_MISMATCH (`Status`) | `UPSTREAM` | Pendente ou Confirmado (Mapeado via alias explícito: "Status", tipo compatível, mas com divergência estrutural: Opções ausentes no Notion (2): "Liquidado", "Estornado") |
| `Hash Canônico` | `rich_text` | `—` | ⚠️ MISSING | `DERIVADO` | Fingerprint SHA-256 (64 chars) de versão |
| `Valor Bruto Pierre` | `number` | `—` | ⚠️ MISSING | `UPSTREAM` | Valor exato retornado pelo Pierre com sinal original |
| `Efeito Orçamentário` | `select` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | INCOME | EXPENSE | REVERSAL | NEUTRAL |
| `Propósito de Alocação` | `select` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | INVESTMENT_RESERVE | OPERATIONAL_CASH | etc. |
| `Contribuição Meta Poupança` | `number` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Valor que pontua na meta de poupança (ex: R$ 500 aporte) |
| `Fatura Vinculada` | `relation` | `—` | ⚠️ MISSING | `DERIVADO` | Relação com 13ª base Faturas / Ciclos |
| `Status de Revisão` | `select` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Confirmado Auto, Pendente Revisão, Validado Manualmente, Legado Não Verificado |
| `Motivo da Revisão` | `rich_text` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Justificativa para intervenção humana |
| `HMAC Contraparte` | `rich_text` | `—` | ⚠️ MISSING | `DERIVADO` | Hash seguro do CPF/CNPJ para matching sem expor PII |
| `Conta no orçamento` | `—` | `checkbox` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Conta como aporte` | `—` | `checkbox` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Revisado` | `—` | `checkbox` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Observações` | `—` | `rich_text` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |

### Categorias Financeiras (`NOTION_DS_CATEGORIES`)
* **Status:** `CONFIGURED_AND_VERIFIED`
* **Data Source ID (Parcial):** `eb8e...13b4`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Variabilidade` | `select` | `select` | ⚠️ STRUCTURAL_MISMATCH | `USUARIO` | Fixa, Variável, Ocasional [Divergência Estrutural: Opções ausentes no Notion (1): "Ocasional"] |
| `Natureza padrão` | `select` | `select` | ⚠️ STRUCTURAL_MISMATCH | `USUARIO` | Natureza contábil sugerida [Divergência Estrutural: Opções ausentes no Notion (13): "Receita Operacional", "Despesa Operacional", "Transferência Interna", "Aporte de Capital", "Resgate de Capital", "Compra de Ativo", "Venda de Ativo", "Rendimento / Provento", "Amortização de Dívida", "Juros / Encargos de Dívida", "Pagamento de Fatura", "Reembolso / Estorno", "Ajuste Contábil"] |
| `Nome da Categoria` | `title` | `title` | 🔄 RENAME_CANDIDATE (`Categoria`) | `USUARIO` | Nome da categoria (Mapeado via alias explícito: "Categoria" com tipo compatível: title) |
| `Grupo Orçamentário` | `select` | `select` | 🔄⚠️ RENAME_STRUCTURAL_MISMATCH (`Grupo`) | `USUARIO` | Agrupamento macro orçamentário configurável (ex: Essencial, Estilo de Vida, Metas, Estrutural) (Mapeado via alias explícito: "Grupo", tipo compatível, mas com divergência estrutural: Opções ausentes no Notion (4): "Essencial (Necessidades)", "Estilo de Vida (Desejos)", "Investimentos / Metas", "Estrutural / Neutro") |
| `Observações` | `—` | `rich_text` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Contas fixas` | `—` | `relation` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Ativa` | `—` | `checkbox` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Conta no orçamento` | `—` | `checkbox` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Transações` | `—` | `relation` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |

### Regras de Classificação (`NOTION_DS_RULES`)
* **Status:** `CONFIGURED_AND_VERIFIED`
* **Data Source ID (Parcial):** `b36b...0fbb`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Prioridade` | `number` | `number` | ✅ EXACT_MATCH | `USUARIO` | Ordem de avaliação (1 = prioridade máxima) |
| `Ativa` | `checkbox` | `checkbox` | ✅ EXACT_MATCH | `USUARIO` | Liga/desliga a regra |
| `Auto aplicar` | `checkbox` | `checkbox` | ✅ EXACT_MATCH | `USUARIO` | Se falso, obriga envio para revisão |
| `Exigir revisão` | `checkbox` | `checkbox` | ✅ EXACT_MATCH | `USUARIO` | Se verdadeiro, marca para checagem humana |
| `Válida de` | `date` | `date` | ✅ EXACT_MATCH | `USUARIO` | Início da vigência da regra |
| `Válida até` | `date` | `date` | ✅ EXACT_MATCH | `USUARIO` | Término da vigência da regra |
| `Nome da Regra` | `title` | `title` | 🔄 RENAME_CANDIDATE (`Regra`) | `USUARIO` | Título descritivo da regra (Mapeado via alias explícito: "Regra" com tipo compatível: title) |
| `Condição: Contraparte` | `rich_text` | `rich_text` | 🔄 RENAME_CANDIDATE (`Contraparte contém`) | `USUARIO` | Substring ou nome do merchant/destinatário (Mapeado via alias explícito: "Contraparte contém" com tipo compatível: rich_text) |
| `Condição: Descrição` | `rich_text` | `rich_text` | 🔄 RENAME_CANDIDATE (`Descrição contém`) | `USUARIO` | Substring ou regex na descrição (Mapeado via alias explícito: "Descrição contém" com tipo compatível: rich_text) |
| `Condição: Movimento` | `select` | `select` | 🔄 RENAME_CANDIDATE (`Movimento esperado`) | `USUARIO` | Qualquer, Entrada, Saída (Mapeado via alias explícito: "Movimento esperado" com tipo compatível: select) |
| `Condição: Conta` | `relation` | `relation` | 🔄 RENAME_CANDIDATE (`Conta origem`) | `USUARIO` | Conta de origem específica (Mapeado via alias explícito: "Conta origem" com tipo compatível: relation) |
| `Condição: Categoria Pierre` | `rich_text` | `rich_text` | 🔄 RENAME_CANDIDATE (`Categoria Pierre`) | `USUARIO` | Categoria original Pierre (Mapeado via alias explícito: "Categoria Pierre" com tipo compatível: rich_text) |
| `Condição: Valor Exato` | `number` | `number` | 🔄 RENAME_CANDIDATE (`Valor exato`) | `USUARIO` | Valor monetário exato (Mapeado via alias explícito: "Valor exato" com tipo compatível: number) |
| `Condição: Tolerância Valor` | `number` | `number` | 🔄 RENAME_CANDIDATE (`Tolerância`) | `USUARIO` | Tolerância aceitável em reais (Mapeado via alias explícito: "Tolerância" com tipo compatível: number) |
| `Condição: Valor Mínimo` | `number` | `number` | 🔄 RENAME_CANDIDATE (`Valor mínimo`) | `USUARIO` | Piso do valor (Mapeado via alias explícito: "Valor mínimo" com tipo compatível: number) |
| `Condição: Valor Máximo` | `number` | `number` | 🔄 RENAME_CANDIDATE (`Valor máximo`) | `USUARIO` | Teto do valor (Mapeado via alias explícito: "Valor máximo" com tipo compatível: number) |
| `Condição: Dia Mês Início` | `number` | `number` | 🔄 RENAME_CANDIDATE (`Dia mínimo`) | `USUARIO` | Dia inicial do mês (1 a 31) (Mapeado via alias explícito: "Dia mínimo" com tipo compatível: number) |
| `Condição: Dia Mês Fim` | `number` | `number` | 🔄 RENAME_CANDIDATE (`Dia máximo`) | `USUARIO` | Dia final do mês (1 a 31) (Mapeado via alias explícito: "Dia máximo" com tipo compatível: number) |
| `Atribuir: Natureza` | `select` | `select` | 🔄⚠️ RENAME_STRUCTURAL_MISMATCH (`Natureza resultante`) | `USUARIO` | Natureza atribuída (Mapeado via alias explícito: "Natureza resultante", tipo compatível, mas com divergência estrutural: Opções ausentes no Notion (11): "Receita Operacional", "Despesa Operacional", "Aporte de Capital", "Resgate de Capital", "Compra de Ativo", "Venda de Ativo", "Rendimento / Provento", "Amortização de Dívida", "Juros / Encargos de Dívida", "Reembolso / Estorno", "Ajuste Contábil") |
| `Atribuir: Categoria` | `relation` | `relation` | 🔄 RENAME_CANDIDATE (`Categoria resultante`) | `USUARIO` | Categoria vinculada (Mapeado via alias explícito: "Categoria resultante" com tipo compatível: relation) |
| `Atribuir: Efeito Orçamento` | `select` | `—` | ⚠️ MISSING | `USUARIO` | INCOME, EXPENSE, REVERSAL, NEUTRAL |
| `Atribuir: Alocação` | `select` | `—` | ⚠️ MISSING | `USUARIO` | Finalidade da movimentação |
| `Conta como aporte` | `—` | `checkbox` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Conta no orçamento` | `—` | `checkbox` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Destino / contexto` | `—` | `rich_text` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Observações` | `—` | `rich_text` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Tipo` | `—` | `select` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |

### Contas Fixas (`NOTION_DS_FIXED_BILLS`)
* **Status:** `CONFIGURED_AND_VERIFIED`
* **Data Source ID (Parcial):** `49e9...dfb9`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Periodicidade` | `select` | `select` | ✅ EXACT_MATCH | `USUARIO` | Mensal, Bimestral, Trimestral, Semestral, Anual |
| `Forma de pagamento` | `select` | `select` | ⚠️ STRUCTURAL_MISMATCH | `USUARIO` | Cartão de Crédito, Débito em Conta, Pix, Boleto [Divergência Estrutural: Opções ausentes no Notion (2): "Cartão de Crédito", "Débito em Conta"] |
| `Conta padrão` | `relation` | `relation` | ✅ EXACT_MATCH | `USUARIO` | Conta de débito usual |
| `Categoria` | `relation` | `relation` | ✅ EXACT_MATCH | `USUARIO` | Categoria orçamentária |
| `Ativa` | `checkbox` | `checkbox` | ✅ EXACT_MATCH | `USUARIO` | Gera obrigações no período |
| `Gerar obrigação` | `checkbox` | `checkbox` | ✅ EXACT_MATCH | `USUARIO` | Se ativado, gera automaticamente os lançamentos em Obrigações Mensais a cada competência |
| `Nome da Conta Fixa` | `title` | `title` | 🔄 RENAME_CANDIDATE (`Conta fixa`) | `USUARIO` | Nome do compromisso recorrente (Mapeado via alias explícito: "Conta fixa" com tipo compatível: title) |
| `Observações / Contrato` | `rich_text` | `rich_text` | 🔄 RENAME_CANDIDATE (`Observações`) | `USUARIO` | Código do assinante, detalhes do contrato ou instruções (Mapeado via alias explícito: "Observações" com tipo compatível: rich_text) |
| `Valor Previsto` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Valor esperado por competência |
| `Tolerância (R$)` | `number` | `number` | 💡 HEURISTIC_SUGGESTION (`Tolerância de valor`) [Não-autoritativo] | `USUARIO` | Tolerância para conciliação automática (Sugestão heurística não-autoritativa: "Tolerância de valor" [number], similaridade: 65%. Requer confirmação por alias explícito). |
| `Competência Âncora` | `rich_text` | `—` | ⚠️ MISSING | `USUARIO` | Mês de referência inicial (ex: 2026-01) |
| `Última Competência Gerada` | `rich_text` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Último mês gerado em Obrigações (ex: 2026-08) |
| `Dia de Vencimento` | `number` | `number` | 💡 HEURISTIC_SUGGESTION (`Dia do vencimento`) [Não-autoritativo] | `USUARIO` | Dia do mês do vencimento (1 a 31) (Sugestão heurística não-autoritativa: "Dia do vencimento" [number], similaridade: 93%. Requer confirmação por alias explícito). |
| `Padrão de Identificação` | `rich_text` | `rich_text` | 💡 HEURISTIC_SUGGESTION (`Regra de identificação`) [Não-autoritativo] | `USUARIO` | Expressão / substring para conciliação automática (Sugestão heurística não-autoritativa: "Regra de identificação" [rich_text], similaridade: 81%. Requer confirmação por alias explícito). |
| `Data de Início` | `date` | `—` | ⚠️ MISSING | `USUARIO` | Início da vigência do contrato |
| `Data de Término` | `date` | `—` | ⚠️ MISSING | `USUARIO` | Término da vigência do contrato |
| `Valor esperado` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Dia do vencimento` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Tolerância de valor` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Regra de identificação` | `—` | `rich_text` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |

### Obrigações Mensais (`NOTION_DS_MONTHLY_OBLIGATIONS`)
* **Status:** `CONFIGURED_AND_VERIFIED`
* **Data Source ID (Parcial):** `5c59...f6b8`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Conta fixa` | `relation` | `relation` | ✅ EXACT_MATCH | `DERIVADO` | Relação com o cadastro permanente |
| `Valor previsto` | `number` | `number` | ✅ EXACT_MATCH | `DERIVADO` | Valor esperado herdado da conta fixa |
| `Status` | `select` | `select` | ⚠️ STRUCTURAL_MISMATCH | `REGRA_AUTOMATICA` | Prevista, Paga, Atrasada, Revisão Necessária, Cancelada [Divergência Estrutural: Opções ausentes no Notion (2): "Revisão Necessária", "Cancelada"] |
| `Valor pago` | `number` | `number` | ✅ EXACT_MATCH | `REGRA_AUTOMATICA` | Valor efetivamente liquidado |
| `Validado automaticamente` | `checkbox` | `checkbox` | ✅ EXACT_MATCH | `REGRA_AUTOMATICA` | True se correspondência foi inequívoca |
| `Identificador` | `title` | `title` | 🔄 RENAME_CANDIDATE (`Obrigação`) | `DERIVADO` | Nome da Conta Fixa - YYYY-MM (Mapeado via alias explícito: "Obrigação" com tipo compatível: title) |
| `Data de Vencimento` | `date` | `date` | 🔄 RENAME_CANDIDATE (`Vencimento`) | `DERIVADO` | Data exata do vencimento (Mapeado via alias explícito: "Vencimento" com tipo compatível: date) |
| `Data do Pagamento` | `date` | `date` | 🔄 RENAME_CANDIDATE (`Pago em`) | `REGRA_AUTOMATICA` | Data em que ocorreu a quitação (Mapeado via alias explícito: "Pago em" com tipo compatível: date) |
| `Observações / Conflitos` | `rich_text` | `rich_text` | 🔄 RENAME_CANDIDATE (`Observações`) | `REGRA_AUTOMATICA` | Avisos de divergência ou ambiguidade (Mapeado via alias explícito: "Observações" com tipo compatível: rich_text) |
| `Competência` | `rich_text` | `—` | ⚠️ MISSING | `DERIVADO` | Mês de referência (YYYY-MM) |
| `Transação Vinculada` | `relation` | `relation` | 💡 HEURISTIC_SUGGESTION (`Transação conciliada`) [Não-autoritativo] | `REGRA_AUTOMATICA` | Relação com a transação que liquidou (Sugestão heurística não-autoritativa: "Transação conciliada" [relation], similaridade: 79%. Requer confirmação por alias explícito). |
| `Referência` | `—` | `date` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Conta` | `—` | `relation` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Transação conciliada` | `—` | `relation` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Origem` | `—` | `select` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |

### Investimentos (`NOTION_DS_INVESTMENTS`)
* **Status:** `CONFIGURED_AND_VERIFIED`
* **Data Source ID (Parcial):** `db60...b6cb`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Ativo` | `title` | `title` | ✅ EXACT_MATCH | `USUARIO` | Nome do ativo ou produto financeiro |
| `Moeda` | `select` | `select` | ⚠️ STRUCTURAL_MISMATCH | `USUARIO` | Código da moeda do ativo (BRL, USD, BTC, EUR) [Divergência Estrutural: Opções ausentes no Notion (2): "BTC", "EUR"] |
| `Quantidade` | `number` | `number` | ✅ EXACT_MATCH | `USUARIO` | Posição atual custodiada |
| `Liquidez` | `select` | `rich_text` | ❌ TYPE_MISMATCH (esperado: select, no Notion: rich_text) | `USUARIO` | Prazo de liquidez (ex: D+0, D+1, D+30, No Vencimento) |
| `Data da avaliação` | `date` | `date` | ✅ EXACT_MATCH | `DERIVADO` | Data/hora da última cotação de mercado capturada |
| `Classe do Ativo` | `select` | `select` | 🔄⚠️ RENAME_STRUCTURAL_MISMATCH (`Classe`) | `USUARIO` | Renda Fixa, Cripto, Ação, FII, ETF, Previdência Privada, Tesouro Direto (Caixa Reservado NÃO é classe de ativo) (Mapeado via alias explícito: "Classe", tipo compatível, mas com divergência estrutural: Opções ausentes no Notion (6): "Ação", "FII", "ETF", "Previdência Privada", "Tesouro Direto", "Outros") |
| `Custo Base Total` | `number` | `number` | 🔄 RENAME_CANDIDATE (`Custo acumulado`) | `DERIVADO` | Montante total acumulado desembolsado nas compras (base de custo contábil) (Mapeado via alias explícito: "Custo acumulado" com tipo compatível: number) |
| `Valor de Mercado Atual` | `number` | `number` | 🔄 RENAME_CANDIDATE (`Valor atual`) | `UPSTREAM` | Posição a mercado: Cotação atual x quantidade (Mapeado via alias explícito: "Valor atual" com tipo compatível: number) |
| `Fonte da Avaliação` | `select` | `select` | 🔄⚠️ RENAME_STRUCTURAL_MISMATCH (`Fonte do preço`) | `USUARIO` | Origem da cotação a mercado (ex: Pierre, B3, Manual, Cripto API) (Mapeado via alias explícito: "Fonte do preço", tipo compatível, mas com divergência estrutural: Opções ausentes no Notion (3): "B3", "Cripto API", "Tesouro Direto") |
| `Instituição / Corretora` | `select` | `rich_text` | 🔄❌ RENAME_TYPE_MISMATCH (`Instituição`) | `USUARIO` | Corretora ou custodiante do investimento (ex: NuInvest, Binance, XP, BTG) (Mapeado via alias explícito: "Instituição", porém com tipo incompatível: esperado "select", encontrado "rich_text") |
| `ID do Ativo na Fonte` | `rich_text` | `rich_text` | 🔄 RENAME_CANDIDATE (`ID da fonte`) | `UPSTREAM` | Identificador único do ativo na API de origem para sincronização (Mapeado via alias explícito: "ID da fonte" com tipo compatível: rich_text) |
| `Custódia` | `select` | `—` | ⚠️ MISSING | `USUARIO` | Conta Pierre ou Carteira Externa |
| `Preço Médio Unitário (PMP)` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Preço médio ponderado unitário de aquisição |
| `Lucro / Prejuízo Não Realizado` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Valor de Mercado Atual - Custo Base Total |
| `Retorno Não Realizado (%)` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | ((Valor de Mercado Atual - Custo Base Total) / Custo Base Total) * 100 |
| `Incluir no Patrimônio` | `checkbox` | `checkbox` | 💡 HEURISTIC_SUGGESTION (`Inclui no patrimônio`) [Não-autoritativo] | `USUARIO` | Indica se esta posição deve compor o cálculo de patrimônio líquido final (Sugestão heurística não-autoritativa: "Inclui no patrimônio" [checkbox], similaridade: 95%. Requer confirmação por alias explícito). |
| `Conta Vinculada` | `relation` | `—` | ⚠️ MISSING | `USUARIO` | Conta corrente ou corretora associada |
| `Observações` | `—` | `rich_text` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Movimentações` | `—` | `relation` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Inclui no patrimônio` | `—` | `checkbox` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |

### Movimentações de Investimentos (`NOTION_DS_INVESTMENT_MOVEMENTS`)
* **Status:** `CONFIGURED_AND_VERIFIED`
* **Data Source ID (Parcial):** `b19f...25af`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Preço unitário` | `number` | `number` | ✅ EXACT_MATCH | `DERIVADO` | Preço médio da ordem |
| `Conta origem` | `relation` | `relation` | ✅ EXACT_MATCH | `DERIVADO` | Conta debitada |
| `Ativo Vinculado` | `relation` | `relation` | 🔄 RENAME_CANDIDATE (`Ativo`) | `REGRA_AUTOMATICA` | Relação com a posição do ativo (Mapeado via alias explícito: "Ativo" com tipo compatível: relation) |
| `Tipo de Movimentação` | `select` | `select` | 🔄⚠️ RENAME_STRUCTURAL_MISMATCH (`Tipo`) | `REGRA_AUTOMATICA` | Aporte de Capital, Resgate de Capital, Compra de Ativo, Venda de Ativo, Rendimento / Provento, Taxas e Impostos, Ajuste de Posição (Mapeado via alias explícito: "Tipo", tipo compatível, mas com divergência estrutural: Opções ausentes no Notion (7): "Aporte de Capital", "Resgate de Capital", "Compra de Ativo", "Venda de Ativo", "Rendimento / Provento", "Taxas e Impostos", "Ajuste de Posição") |
| `Data da Operação` | `date` | `date` | 🔄 RENAME_CANDIDATE (`Data`) | `UPSTREAM` | Data da execução (Mapeado via alias explícito: "Data" com tipo compatível: date) |
| `Quantidade Negociada` | `number` | `number` | 🔄 RENAME_CANDIDATE (`Quantidade`) | `USUARIO` | Fração ou unidades transacionadas (Mapeado via alias explícito: "Quantidade" com tipo compatível: number) |
| `Identificador` | `title` | `—` | ⚠️ MISSING | `DERIVADO` | Tipo - Ativo - Data |
| `Valor Bruto` | `number` | `—` | ⚠️ MISSING | `UPSTREAM` | Volume financeiro total |
| `Valor Líquido` | `number` | `—` | ⚠️ MISSING | `UPSTREAM` | Valor líquido após custos |
| `Conta Destino / Caixa` | `relation` | `—` | ⚠️ MISSING | `DERIVADO` | Conta creditada |
| `Transação Financeira` | `relation` | `—` | ⚠️ MISSING | `DERIVADO` | Transação bancária vinculada |
| `Moeda` | `—` | `select` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Valor` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Observações` | `—` | `rich_text` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `ID da fonte` | `—` | `rich_text` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Fonte` | `—` | `select` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Custos e taxas` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Transação origem` | `—` | `relation` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Movimentação` | `—` | `title` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |

### Planejamento Mensal (`NOTION_DS_MONTHLY_BUDGET`)
* **Status:** `CONFIGURED_AND_VERIFIED`
* **Data Source ID (Parcial):** `0c14...c7d5`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Competência` | `title` | `title` | 🔄 RENAME_CANDIDATE (`Mês`) | `USUARIO` | YYYY-MM (Mapeado via alias explícito: "Mês" com tipo compatível: title) |
| `Renda Prevista` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Meta de renda do mês |
| `Teto Mensal Cartão` | `number` | `—` | ⚠️ MISSING | `USUARIO` | Teto pessoal de compras no cartão (ex: R$ 400) |
| `Meta de Poupança/Aporte` | `number` | `number` | 💡 HEURISTIC_SUGGESTION (`Meta de poupança %`) [Não-autoritativo] | `USUARIO` | Meta de dinheiro a poupar no mês (Sugestão heurística não-autoritativa: "Meta de poupança %" [number], similaridade: 70%. Requer confirmação por alias explícito). |
| `Metas por Grupo Orçamentário` | `rich_text` | `—` | ⚠️ MISSING | `USUARIO` | Metas percentuais ou tetos nominais por grupo orçamentário configurável |
| `Meta Taxa de Poupança (%)` | `number` | `number` | 💡 HEURISTIC_SUGGESTION (`Meta de poupança %`) [Não-autoritativo] | `USUARIO` | Percentual alvo da renda líquida destinado a investimentos e reservas (Sugestão heurística não-autoritativa: "Meta de poupança %" [number], similaridade: 78%. Requer confirmação por alias explícito). |
| `Receitas Realizadas` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Soma de transações OPERATING_REVENUE |
| `Despesas Realizadas` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Soma de transações OPERATING_EXPENSE |
| `Poupança Realizada` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Soma de transações com savingsGoalContribution |
| `Compras Realizadas Cartão` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Soma de compras de cartão no mês |
| `Teto pessoal de crédito` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Necessidades planejadas` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Renda planejada` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Observações` | `—` | `rich_text` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Status` | `—` | `select` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Referência` | `—` | `date` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Aporte planejado` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Meta de poupança %` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Reserva operacional` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Desejos planejados` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |

### Metas Financeiras (`NOTION_DS_FINANCIAL_GOALS`)
* **Status:** `CONFIGURED_AND_VERIFIED`
* **Data Source ID (Parcial):** `b629...ed91`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Meta` | `title` | `title` | ✅ EXACT_MATCH | `USUARIO` | Nome do objetivo financeiro |
| `Valor alvo` | `number` | `number` | ✅ EXACT_MATCH | `USUARIO` | Montante financeiro desejado |
| `Prazo Alvo` | `date` | `date` | 🔄 RENAME_CANDIDATE (`Prazo`) | `USUARIO` | Data limite para cumprimento (Mapeado via alias explícito: "Prazo" com tipo compatível: date) |
| `Valor Atual Acumulado` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Saldo alocado para a meta |
| `Aporte mensal planejado` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Tipo` | `—` | `select` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Liquidez necessária` | `—` | `select` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Valor atual` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Prioridade` | `—` | `select` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Observações` | `—` | `rich_text` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Status` | `—` | `select` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |

### Fechamentos Mensais (`NOTION_DS_MONTHLY_CLOSINGS`)
* **Status:** `CONFIGURED_AND_VERIFIED`
* **Data Source ID (Parcial):** `74ff...b94c`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Qualidade dos dados` | `select` | `select` | ⚠️ STRUCTURAL_MISMATCH | `REGRA_AUTOMATICA` | Nota ou classificação da confiabilidade dos lançamentos do mês [Divergência Estrutural: Opções ausentes no Notion (4): "Excelente", "Bom", "Atenção Necessária", "Crítico"] |
| `Contas fixas pagas` | `number` | `number` | ✅ EXACT_MATCH | `DERIVADO` | Contagem de obrigações fixas da competência com status Paga |
| `Contas fixas pendentes` | `number` | `number` | ✅ EXACT_MATCH | `DERIVADO` | Contagem de obrigações fixas da competência ainda pendentes ou atrasadas |
| `Itens para revisão` | `number` | `number` | ✅ EXACT_MATCH | `DERIVADO` | Contagem de transações ou lançamentos da competência aguardando revisão humana |
| `Fechado em` | `date` | `date` | ✅ EXACT_MATCH | `USUARIO` | Data/hora em que o fechamento mensal foi consolidado e trancado |
| `Mês de Referência` | `title` | `title` | 🔄 RENAME_CANDIDATE (`Fechamento`) | `DERIVADO` | Fechamento YYYY-MM (Mapeado via alias explícito: "Fechamento" com tipo compatível: title) |
| `Status do Fechamento` | `select` | `select` | 🔄⚠️ RENAME_STRUCTURAL_MISMATCH (`Status`) | `USUARIO` | Aberto, Pré-fechado, Fechado Auditado (Mapeado via alias explícito: "Status", tipo compatível, mas com divergência estrutural: Opções ausentes no Notion (2): "Pré-fechado", "Fechado Auditado") |
| `Poupança / Aportes Realizados` | `number` | `number` | 🔄 RENAME_CANDIDATE (`Aportes`) | `DERIVADO` | Total efetivamente poupado e transferido para investimentos no mês (Mapeado via alias explícito: "Aportes" com tipo compatível: number) |
| `Observações / Notas do Fechamento` | `rich_text` | `rich_text` | 🔄 RENAME_CANDIDATE (`Observações`) | `USUARIO` | Comentários qualitativos sobre desvios e conquistas do mês (Mapeado via alias explícito: "Observações" com tipo compatível: rich_text) |
| `Status de Reconciliação` | `select` | `—` | ⚠️ MISSING | `REGRA_AUTOMATICA` | Conciliado Integralmente, Divergências Pendentes, Reconciliação Manual Necessária |
| `Patrimônio Inicial` | `number` | `number` | 💡 HEURISTIC_SUGGESTION (`Patrimônio final`) [Não-autoritativo] | `DERIVADO` | Patrimônio líquido consolidado no início do mês (Sugestão heurística não-autoritativa: "Patrimônio final" [number], similaridade: 76%. Requer confirmação por alias explícito). |
| `Renda Consolidada` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Total de receitas operacionais líquidas |
| `Despesas Consolidadas` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Total de despesas correntes de subsistência e consumo |
| `Despesas Essenciais (Necessidades)` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Gastos essenciais de moradia, saúde, alimentação básica |
| `Despesas Discricionárias (Desejos)` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Gastos de estilo de vida, lazer e compras |
| `Resultado do Mês (Sobra Operacional)` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Renda Consolidada - Despesas Consolidadas (fluxo de caixa operacional livre do mês antes de aportes) |
| `Taxa de Poupança (%)` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | (Poupança / Aportes Realizados / Renda Consolidada) * 100 |
| `Fluxo Residual Não Alocado` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Sobra Operacional - Poupança/Aportes Realizados |
| `Rendimentos de Investimentos` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Rendimentos e dividendos auferidos no mês |
| `Patrimônio Líquido Final` | `number` | `number` | 💡 HEURISTIC_SUGGESTION (`Patrimônio final`) [Não-autoritativo] | `DERIVADO` | Saldo contas + investimentos - dívidas ao fechar o mês (Sugestão heurística não-autoritativa: "Patrimônio final" [number], similaridade: 68%. Requer confirmação por alias explícito). |
| `Variação Patrimonial` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Patrimônio Final - Patrimônio Inicial |
| `Reconciliação OK` | `—` | `checkbox` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Receitas` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Saldo livre final` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Patrimônio final` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Referência` | `—` | `date` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Fatura em aberto` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Despesas` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |

### Log de Sincronização (`NOTION_DS_SYNC_LOG`)
* **Status:** `CONFIGURED_AND_VERIFIED`
* **Data Source ID (Parcial):** `2a61...3d20`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Execução` | `title` | `title` | ✅ EXACT_MATCH | `DERIVADO` | Sync - YYYY-MM-DD HH:mm:ss |
| `Status` | `select` | `select` | ⚠️ STRUCTURAL_MISMATCH | `DERIVADO` | Sucesso, Sucesso Parcial, Erro, Bloqueado por Concorrência [Divergência Estrutural: Opções ausentes no Notion (2): "Sucesso Parcial", "Bloqueado por Concorrência"] |
| `Transações recebidas` | `number` | `number` | ✅ EXACT_MATCH | `DERIVADO` | Lançamentos retornados pelo Pierre |
| `Transações novas` | `number` | `number` | ✅ EXACT_MATCH | `DERIVADO` | Novas páginas criadas |
| `Transações atualizadas` | `number` | `number` | ✅ EXACT_MATCH | `DERIVADO` | Páginas existentes com versionHash alterado |
| `Parcelas recebidas` | `number` | `number` | ✅ EXACT_MATCH | `DERIVADO` | Parcelamentos e faturas futuras identificadas |
| `Freshness da fonte` | `date` | `date` | ✅ EXACT_MATCH | `DERIVADO` | Momento do último dado retornado pelo banco / open finance |
| `Fonte de Sincronização` | `select` | `select` | 🔄⚠️ RENAME_STRUCTURAL_MISMATCH (`Fonte`) | `DERIVADO` | Sistema ou conector de origem da sincronização (ex: PIERRE, MANUAL_CSV, MIGRATION) (Mapeado via alias explícito: "Fonte", tipo compatível, mas com divergência estrutural: Opções ausentes no Notion (2): "MANUAL_CSV", "MIGRATION") |
| `Data Início` | `date` | `—` | ⚠️ MISSING | `DERIVADO` | Timestamp do início da sincronização |
| `Data Fim` | `date` | `—` | ⚠️ MISSING | `DERIVADO` | Timestamp do término da sincronização |
| `Duração (s)` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Tempo total de processamento em segundos |
| `Duração (ms)` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Tempo total de processamento em milissegundos |
| `Contas Processadas` | `number` | `number` | 💡 HEURISTIC_SUGGESTION (`Contas recebidas`) [Não-autoritativo] | `DERIVADO` | Quantidade de contas sincronizadas (Sugestão heurística não-autoritativa: "Contas recebidas" [number], similaridade: 71%. Requer confirmação por alias explícito). |
| `Transações Inalteradas` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Transações sem alteração ignoradas |
| `Erros Encontrados` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Total de falhas ou exceções não fatais registradas durante o lote |
| `Enviadas para Revisão` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Transações marcadas como Pendente Revisão |
| `Obrigações Conciliadas` | `number` | `—` | ⚠️ MISSING | `DERIVADO` | Compromissos mensais liquidados com sucesso |
| `ID da Execução (Run ID)` | `rich_text` | `—` | ⚠️ MISSING | `DERIVADO` | UUID unívoco da execução do worker |
| `Código do Erro` | `select` | `—` | ⚠️ MISSING | `DERIVADO` | Código padronizado de erro (ex: AUTH_EXPIRED, NETWORK_TIMEOUT, VALIDATION_ERROR) |
| `Mensagem de Erro Sanitizada` | `rich_text` | `—` | ⚠️ MISSING | `DERIVADO` | Mensagem descritiva tratada, sem stack trace ou dados sensíveis |
| `Referência do Log Privado` | `rich_text` | `—` | ⚠️ MISSING | `DERIVADO` | Identificador do registro detalhado no armazenamento privado cifrado |
| `Hash do Lote RAW` | `rich_text` | `—` | ⚠️ MISSING | `DERIVADO` | SHA-256 do payload bruto salvo no cofre cifrado |
| `Versão do Worker / Commit` | `rich_text` | `—` | ⚠️ MISSING | `DERIVADO` | Commit SHA ou tag da versão do worker em execução |
| `Pendências de revisão` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Observações` | `—` | `rich_text` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Erro / alerta` | `—` | `rich_text` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Concluída em` | `—` | `date` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Contas recebidas` | `—` | `number` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |
| `Iniciada em` | `—` | `date` | 🛡️ EXTRA_PRESERVE | `USUARIO` | Propriedade existente no Notion (preservada integralmente) |

### Faturas / Ciclos de Cartão (`NOTION_DS_CARD_BILLS`)
* **Status:** `PROPOSED_NEW_DATABASE`

| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Fatura / Ciclo` | `title` | `—` | 🆕 PROPOSED_TO_CREATE | `DERIVADO` | Ex: Fatura Nubank - Venc 22/07/2026 |
| `Cartão Vinculado` | `relation` | `—` | 🆕 PROPOSED_TO_CREATE | `DERIVADO` | Relação com a conta do cartão em Contas |
| `Tipo de Ciclo` | `select` | `—` | 🆕 PROPOSED_TO_CREATE | `DERIVADO` | Ciclo Real Banco, Ciclo Configurado, Ciclo Estimado |
| `Status da Fatura` | `select` | `—` | 🆕 PROPOSED_TO_CREATE | `REGRA_AUTOMATICA` | Aberta em Curso, Fechada a Vencer, Vencida, Paga Integralmente, Paga Parcialmente |
| `Data de Fechamento` | `date` | `—` | 🆕 PROPOSED_TO_CREATE | `UPSTREAM` | Data de corte (balance_close_date ou configurada) |
| `Data de Vencimento` | `date` | `—` | 🆕 PROPOSED_TO_CREATE | `UPSTREAM` | Data de vencimento (balance_due_date) |
| `Valor da Fatura (Banco)` | `number` | `—` | 🆕 PROPOSED_TO_CREATE | `UPSTREAM` | Valor total consolidado emitido pela instituição |
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
| `Data de Fechamento` | `date` | `write` | `UPSTREAM` | Data de corte (balance_close_date ou configurada) |
| `Data de Vencimento` | `date` | `write` | `UPSTREAM` | Data de vencimento (balance_due_date) |
| `Valor da Fatura (Banco)` | `number` | `write` | `UPSTREAM` | Valor total consolidado emitido pela instituição |
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
