# Financeiro — Controle Automatizado

Organizador financeiro que roda sozinho. Puxa os dados das suas contas via
**Pierre** (Open Finance), guarda a "verdade" num banco **SQLite** e desenha
tudo numa planilha **Google Sheets** — saldo, gastos por categoria, fatura,
compromissos futuros e um dashboard com KPIs e gráficos.

```
Pierre API  ─▶  normalização  ─▶  SQLite  ─▶  Google Sheets
(Open Finance)   (regras de       (verdade)    (visualização,
                  domínio)                       fórmulas vivas)
```

O programa é previsível de propósito: nenhuma IA preenche a planilha. As regras
de domínio (o que é saldo real, o que é transferência, sinais de cartão) estão
no código e são testadas.

---

## Como funciona

Cada sincronização executa 8 passos (`src/sync/engine.ts`):

1. Autentica no Google (tokens em `data/google-tokens.json`).
2. Cria/atualiza a planilha e suas abas (idempotente).
3. Lê as abas de config (**Categorias** e **Orçamento**) — a sua entrada.
4. Pede ao Pierre um `manual-update` e espera os bancos sincronizarem.
5. Busca e normaliza as contas.
6. Busca, normaliza e faz upsert das transações.
7. Busca as parcelas e substitui a tabela.
8. Redesenha as abas de dados e registra o sync.

### Regras de domínio (as "pegadinhas" dos dados)

- **Saldo real = `closingBalance`.** Outras rotas somam a caixinha investida em
  dobro; o saldo verdadeiro é só o `closingBalance`.
- **Transferências e pagamento de fatura não são gasto.** Ficam de fora de todos
  os totais (senão "pagamento de fatura" viraria o maior "gasto").
- **Cartão inverte o sinal.** No banco, gastar é negativo; no cartão, comprar é
  positivo. Tudo é normalizado antes de somar: positivo = entrada, negativo =
  saída.

---

## Abas da planilha

| Aba | O que mostra |
|-----|--------------|
| **Dashboard** | KPIs (saldo, sobra, taxa de poupança), regra 50/30/20 e gráficos (rosca de categorias, colunas 50/30/20, linha de evolução de 12 meses). |
| **Saldo** | Saldo real de cada conta + total das contas. |
| **Resumo Mensal** | Orçado / Realizado / Diferença / % Usado por categoria e mês, com semáforo verde/amarelo/vermelho. |
| **Consolidado Anual** | 12 meses lado a lado, total, média e % do total. |
| **Transações** | Todo lançamento, classificado e filtrável. |
| **Fatura Atual** | O que está acumulando no cartão. |
| **Compromissos Futuros** | Parcelas que ainda vão vencer. |
| **Config: Categorias** | Mapa Pierre → sua taxonomia (50/30/20 + Fixa/Variável). **Você edita.** |
| **Config: Orçamento** | Renda líquida, alvos 50/30/20 e orçamento por categoria. **Você edita.** |

As abas de **Config** são lidas pelo programa e **nunca** sobrescritas. Os
valores derivados são fórmulas vivas: editar uma categoria ou um orçamento
recalcula a planilha na hora, sem esperar o próximo sync.

---

## Desenvolvimento (local)

```bash
pnpm install
cp .env.example .env      # preencha as credenciais

pnpm setup                # cria a planilha e faz o consent do Google (abre o navegador)
pnpm sync                 # sincroniza (incremental)
pnpm sync:full            # resync de 3 meses
pnpm sync:dry             # simula, sem gravar nada

pnpm test                 # testes
pnpm test:coverage        # com cobertura
pnpm typecheck            # tsc --noEmit
pnpm build                # compila para dist/
```

Os testes nunca usam credenciais reais: `tests/setup/isolate-live-credentials.ts` (carregado via
`setupFiles` do vitest) zera `NOTION_API_KEY`, as credenciais Google/Drive, os gates
`FINANCIAL_BACKFILL_*` e os IDs `NOTION_DS_*` antes de qualquer teste (inclusive os vindos do `.env`) e
bloqueia toda rede que não seja loopback (`TEST_NETWORK_BLOCKED`). Testes que falam com o Notion devem
injetar um client mock.

### Flags do CLI

| Flag | Efeito |
|------|--------|
| `--full` | Resync completo (3 meses retroativos). |
| `--dry-run` | Não grava no SQLite nem na planilha. |
| `--skip-update` | Pula o `manual-update` do Pierre. |
| `--setup-only` | Só cria/configura a planilha e faz o consent. |

---

## Execução autônoma (Docker no home server)

O alvo é rodar 2x/dia, todos os dias, num servidor sempre ligado. Um container roda o **supercronic** como
PID 1, que dispara os jobs do `docker/crontab` (horário de Brasília). Cada execução é um processo novo —
conexão SQLite limpa e código de saída honesto.

| Horário | Job | Quando roda |
|---------|-----|-------------|
| 06:40 e 18:40 | `node dist/notion/sync/cli.js --apply` — Pierre → SQLite → Notion | sempre |
| 06:30 e 18:30 | `node dist/index.js` — planilha Google Sheets (legado) | só com `ENABLE_GOOGLE_SHEETS_SYNC=true` |

O servidor continua necessário: o SQLite em `data/` guarda o histórico completo de que a projeção depende
(o Pierre só devolve uma janela recente) e é ele que roda o cron.

### Subir no servidor (Notion)

```bash
# 1. Código novo
git pull

# 2. .env (ao lado do docker-compose.yml) — além do que já existe:
#    PIERRE_API_KEY=<chave ativa do Pierre>
#    NOTION_API_KEY=<token da integração do Notion>
#    NOTION_DS_TRANSACTIONS / NOTION_DS_CARD_BILLS / NOTION_DS_ACCOUNTS /
#    NOTION_DS_CATEGORIES / NOTION_DS_RULES / NOTION_DS_SYNC_LOG = IDs das data sources
#    Remova PIERRE_API_URL se apontar para api.pierre.com.br (esse host não existe mais;
#    o padrão já é https://www.pierre.finance/tools/api).

# 3. data/account-mapping.json: qual conta do Pierre é a conta corrente e qual é o cartão
#    {"<id conta>": "CHECKING", "<id cartão>": "CREDIT", "defaultDueDay": 16}

# 4. Dono do bind mount = uid 1000 (o WAL do SQLite precisa escrever), 0700 para ficar privado
sudo chown -R 1000:1000 data && chmod 700 data

# 5. Simula uma vez (não grava nada) e confere o resumo; depois sobe o agendador
docker compose build
docker compose run --rm app notion-sync
docker compose up -d
```

O SQLite que já está no servidor serve como está: a primeira execução busca no Pierre desde a transação
pendente mais antiga e converge para o que já está no Notion, sem duplicar nada.

> Combine com disco criptografado no host (LUKS/BitLocker): o banco SQLite (e o token do Google, se usar a
> planilha) ficam em texto puro no bind mount.

### Planilha Google Sheets (opcional, legado)

Para continuar atualizando a planilha, coloque `ENABLE_GOOGLE_SHEETS_SYNC=true` no `.env` e faça o consent
do Google **uma vez** num desktop (publique antes a tela de consentimento OAuth em **"Production"** no
Google Cloud Console — em "Testing" o refresh token expira em 7 dias):

```bash
docker compose run --rm -e HEADLESS=0 app sync --setup-only   # num desktop; grava data/google-tokens.json
# copie data/google-tokens.json e data/spreadsheet-id.txt para o servidor
```

No servidor (headless), se faltar token o job da planilha **falha rápido** com instruções.

### Observabilidade

- **Heartbeat:** cada execução com `--apply` da sincronização do Notion escreve `data/last-notion-sync.json`
  (a planilha, quando ligada, escreve `data/last-run.json`).
- **Healthcheck:** o container fica *unhealthy* se a última sincronização do Notion falhou, gravou só em parte
  (`PARTIAL`) ou está mais velha que `STALE_HOURS` (30h, ~1 run perdido de margem); a planilha só conta com
  `ENABLE_GOOGLE_SHEETS_SYNC=true`. O Docker só marca — para agir, use um alerta externo ou um sidecar de
  autoheal.
- **No Notion:** cada execução vira uma linha no **Log de Sincronização**.
- **Logs:** vão para o stdout (rotacionado pelo Docker: `max-size` / `max-file`).

```bash
docker compose logs -f                                  # acompanhar
docker inspect --format '{{.State.Health.Status}}' financial-organisation
cat data/last-notion-sync.json                          # último resultado, legível por máquina
docker compose run --rm app notion-sync --apply         # sincronização manual sob demanda
```

> **Importante:** mantenha `data/` num filesystem **local**. O WAL do SQLite
> corrompe em compartilhamentos de rede (NFS/SMB).

---

## Sincronização com o Notion

`pnpm notion:sync` leva os dados do Pierre para o painel **Finanças** no Notion (Transações, Faturas /
Ciclos de Cartão, Contas e Log de Sincronização):

```
Pierre → normalização → SQLite (verdade local) → projeção determinística → Notion
```

```bash
pnpm notion:sync                 # simula: mostra o que mudaria e não grava nada
pnpm notion:sync:apply           # grava no Notion
pnpm notion:sync --skip-pierre   # projeta só o histórico local do SQLite (sem chamar o Pierre)
docker compose run --rm app notion-sync --apply   # no servidor
```

No servidor ela roda sozinha às 06:40 e 18:40 (`docker/crontab`). A janela buscada no Pierre começa na
transação pendente mais antiga do SQLite (limitada a 3 meses), para pegar compras que o banco efetiva semanas
depois com outra data e a fatura oficial.

**Como decide o que gravar.** Cada execução recalcula, a partir de todo o histórico do SQLite, o estado
esperado dos campos que pertencem ao pipeline (autoridade `UPSTREAM`/`DERIVADO` no contrato
`src/domain/schema-contract.ts`), compara com as páginas existentes e aplica o mínimo:

- **Transações novas** são criadas com a mesma classificação da migração (a projeção é validada contra o
  plano congelado de 159 operações em `tests/notion-sync-parity.test.ts`). O casamento é pelo
  `ID da fonte`, então rodar duas vezes nunca duplica nada.
- **Transações existentes**: só data, valor, status do banco, categoria do Pierre, conta, fatura e hash são
  atualizados. A classificação que você revisou (Natureza, Efeito, Categoria, Status de Revisão) e os seus
  campos (Revisado, Observações, Conta no orçamento…) **nunca** são sobrescritos.
- **Regras de Classificação**: regras ativas com *Auto aplicar* classificam as transações novas e também as
  pendentes que ninguém tocou ainda. *Exigir revisão* deixa o resultado como *Provável*. Vale a primeira
  regra por *Prioridade* (menor primeiro).
- **Faturas** seguem o calendário do banco. As faturas oficiais do Pierre (`get-bills`, guardadas na tabela
  `card_bills`) dão a data de fechamento, o vencimento e o saldo de fechamento (*Valor da Fatura Fechada
  (Oficial)*); o período vai do dia seguinte ao fechamento anterior até o fechamento. O *Status da Fatura* é
  calculado: saldo oficial zero (ou negativo) → *Paga Integralmente*; com saldo, *Fechada a Vencer* até o
  vencimento e depois *Paga Integralmente* / *Paga Parcialmente* / *Vencida* pelos pagamentos feitos da conta
  após o fechamento.
- **Fatura aberta**: as compras pendentes vão para a fatura aberta do calendário do banco (fecha no mesmo dia
  do mês do último fechamento oficial), com status *Aberta em Curso* e, em *Valor Estimado da Fatura Aberta*,
  o valor que o banco informa para a fatura atual (o mesmo do app). *Total de Compras no Ciclo* e *Valor Pago*
  são somas das transações que o Pierre lista e podem não fechar com o valor do banco (compras ainda
  pendentes, pagamentos que o banco aplica na fatura anterior). Quando o banco fecha a fatura, **a mesma
  página** passa a ser a fatura oficial (aviso `ADOPTED_BILL`), sem duplicar.
- Ciclos novos são criados; período, totais e pagamentos são recalculados; a *Data de Liquidação* preenchida
  por você é preservada. Sem faturas oficiais (Pierre fora do ar e nada guardado) vale o cálculo da migração.
  Um ciclo *estimado* que perdeu todas as compras tem os totais zerados (aviso `SUPERSEDED_ESTIMATED_BILL`) e
  pode ser apagado à mão; uma fatura real nunca é alterada assim.
- **Contas**: saldo e limites só são atualizados quando o dado da fonte é tão ou mais recente que o
  *Atualizado em* da página. O *Limite Operacional Usado* do cartão é o *Limite personalizado* (seu) menos o
  disponível; se o banco informar outro limite personalizado, a execução avisa (`LIMIT_DRIFT`).
- **Pix no crédito** (cobrança no cartão com categoria de transferência) entra como *Saída*, pendente de
  revisão como transferência enviada a terceiro.
- Nada é apagado ou arquivado. Opções novas de select e propriedades inexistentes abortam a execução antes
  de gravar (nenhuma mudança de schema). Mais de `NOTION_SYNC_MAX_CREATES` (300) páginas novas numa execução
  exigem `--allow-large`. Uma trava (`data/notion-sync.lock`) impede duas execuções simultâneas.
- Cada execução com `--apply` registra uma linha no **Log de Sincronização** e grava
  `data/last-notion-sync.json`; depois de gravar, relê o Notion e confirma que não sobrou diferença.

**Configuração** (além das variáveis do Pierre): `NOTION_API_KEY`, `NOTION_DS_TRANSACTIONS`,
`NOTION_DS_CARD_BILLS`, `NOTION_DS_ACCOUNTS`, `NOTION_DS_CATEGORIES`, `NOTION_DS_RULES`,
`NOTION_DS_SYNC_LOG` e `data/account-mapping.json` (`ACCOUNT_MAPPING_PATH`), que diz qual conta do Pierre é a
conta corrente e qual é o cartão. `COUNTERPARTY_HMAC_KEY` é opcional: vazia, o campo *HMAC Contraparte* fica
`[OFUSCADO]` (como na migração); preenchida, as transações passam a receber o pseudônimo.

---

## Estrutura

```
src/
├── index.ts            CLI + logging + heartbeat
├── config.ts           carrega .env (paths, headless, etc.)
├── pierre/             cliente da API + normalização (regras de domínio)
├── storage/            SQLite: conexão, migrations, repository
├── sheets/             Google Sheets: auth, client, setup, builders, renderer
└── sync/engine.ts      orquestra os 8 passos
docker/                 crontab, entrypoint, healthcheck
tests/                  vitest (lógica de negócio + builders)
```

---

## O que este projeto **não** é

- Não movimenta dinheiro (a API é somente leitura).
- Não substitui o Pierre — usa o Pierre como motor.
- Não é tempo real — é uma fotografia recente, atualizada 2x/dia.
