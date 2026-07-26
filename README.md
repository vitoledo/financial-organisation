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

### Flags do CLI

| Flag | Efeito |
|------|--------|
| `--full` | Resync completo (3 meses retroativos). |
| `--dry-run` | Não grava no SQLite nem na planilha. |
| `--skip-update` | Pula o `manual-update` do Pierre. |
| `--setup-only` | Só cria/configura a planilha e faz o consent. |

---

## Execução autônoma (Docker no home server)

O alvo é rodar 2x/semana, de madrugada, num servidor sempre ligado. Um
container roda o **supercronic** como PID 1, que dispara `node dist/index.js`
no horário agendado (`docker/crontab`, hoje seg. e qui. às 06:30 BRT). Cada
execução é um processo novo — conexão SQLite limpa e código de saída honesto.

### Pré-requisito que trava tudo

**Publique a tela de consentimento OAuth em "Production"** no Google Cloud
Console. Em "Testing", o refresh token expira em 7 dias e a automação quebra
toda semana.

### Provisionar e subir

O consent do Google precisa de um navegador **uma vez**. Faça num desktop e
leve o token para o servidor:

```bash
# 1. Numa máquina com navegador (desktop). HEADLESS=0 força o fluxo interativo,
#    já que a imagem roda headless por padrão:
docker compose run --rm -e HEADLESS=0 app sync --setup-only
#    → grava data/google-tokens.json e cria a planilha
#    (fora do Docker, `pnpm setup` faz o mesmo sem precisar do -e)

# 2. Copie ./data/google-tokens.json e ./data/spreadsheet-id.txt para o servidor.

# 3. No servidor (dono do bind mount = uid 1000, para o WAL do SQLite escrever;
#    0700 para o diretório e os arquivos de token/DB ficarem privados):
mkdir -p data && sudo chown -R 1000:1000 data && chmod 700 data
docker compose up -d
```

> Combine com disco criptografado no host (LUKS/BitLocker): o token do Google e
> o banco SQLite ficam em texto puro no bind mount.

No servidor (headless), se faltar token o programa **falha rápido** com
instruções, em vez de travar esperando um navegador que não existe.

### Observabilidade

- **Heartbeat:** cada run escreve `data/last-run.json` (sucesso ou falha).
- **Healthcheck:** o container fica *unhealthy* se o último run falhou ou está
  mais velho que `STALE_HOURS` (padrão 96h). O Docker só marca — para agir,
  use um alerta externo ou um sidecar de autoheal.
- **Logs:** vão para o stdout (rotacionado pelo Docker: `max-size` / `max-file`).

```bash
docker compose logs -f            # acompanhar
docker inspect --format '{{.State.Health.Status}}' financial-organisation
cat data/last-run.json            # último resultado, legível por máquina
docker compose run --rm app sync  # sync manual sob demanda
```

> **Importante:** mantenha `data/` num filesystem **local**. O WAL do SQLite
> corrompe em compartilhamentos de rede (NFS/SMB).

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
- Não é tempo real — é uma fotografia recente, atualizada 2x/semana.
