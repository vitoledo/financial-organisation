import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import schemas from './fixtures/notion-sync-live-schemas.json';
import { runMigrations } from '../src/storage/migrations';
import { Repository } from '../src/storage/repository';
import { serializePayloadForNotion } from '../src/notion/migration-runner/backfill-serializer';
import { classifyTransaction, projectNotionState, THIRD_PARTY_INCOMING_REASON, THIRD_PARTY_OUTGOING_REASON } from '../src/notion/sync/projection';
import { applyRuleToProjection, findMatchingRule, isEligibleRule, parseRule, effectFromNature } from '../src/notion/sync/rules';
import { reconcile, LiveState, AccountSourceContext } from '../src/notion/sync/reconcile';
import { canonicalizeLive, NotionSyncGateway, isRetryableNotionError } from '../src/notion/sync/notion-gateway';
import { NotionSyncEngine, NotionSyncSettings, validateAgainstLiveSchema } from '../src/notion/sync/engine';
import { ClassificationRule, LivePage, ProjectionContext, SqliteAccountRow, SqliteTransactionRow } from '../src/notion/sync/types';

const HMAC = 'a'.repeat(64);
const PAGES = { conta: 'page-conta', cartao: 'page-cartao', alimentacao: 'cat-alim', compras: 'cat-compras', renda: 'cat-renda', internas: 'cat-internas' };

function ctx(overrides: Partial<ProjectionContext> = {}): ProjectionContext {
  return {
    accountRoles: { 'bank-1': 'CHECKING', 'card-1': 'CREDIT' },
    defaultDueDay: 16,
    notionAccounts: [
      { id: PAGES.conta, name: 'Nubank Conta' },
      { id: PAGES.cartao, name: 'Nubank Cartão' },
    ],
    categoryIdByName: new Map([
      ['alimentação', PAGES.alimentacao],
      ['compras', PAGES.compras],
      ['renda extra', PAGES.renda],
      ['transferências internas', PAGES.internas],
    ]),
    hmacKey: HMAC,
    hmacKeyVersion: 'v1',
    sameOwnershipKeywords: ['mesma titularidade'],
    checkingAccountName: 'Nubank Conta',
    creditAccountName: 'Nubank Cartão',
    ...overrides,
  };
}

const ACCOUNTS: SqliteAccountRow[] = [
  { id: 'bank-1', name: 'Nubank Conta', type: 'BANK', subtype: 'CHECKING_ACCOUNT', closing_balance: 500, credit_limit: null, available_credit: null, last_synced_at: '2026-09-29 10:00:00' },
  { id: 'card-1', name: 'Nubank Cartão', type: 'CREDIT', subtype: 'CREDIT_CARD', closing_balance: null, credit_limit: 2400, available_credit: 300, last_synced_at: '2026-09-29 10:00:00' },
];

function row(o: Partial<SqliteTransactionRow> & { raw?: any } = {}): SqliteTransactionRow {
  const { raw, ...rest } = o;
  return {
    id: 'tx-1',
    account_id: 'bank-1',
    date: '2026-09-20T12:00:00.000Z',
    description: 'Mercado',
    amount: -50,
    direction: 'EXPENSE',
    category_pierre: 'Supermercado',
    category_mapped: 'Supermercado',
    account_type: 'BANK',
    status: 'POSTED',
    raw_json: JSON.stringify(raw ?? {}),
    ...rest,
  };
}

// Notion API property builders (request format; canonicalizeLive reads it like the response format).
const t = (s: string) => ({ title: [{ text: { content: s } }] });
const rt = (s: string) => ({ rich_text: [{ text: { content: s } }] });
const sel = (s: string) => ({ select: { name: s } });
const num = (n: number) => ({ number: n });
const chk = (b: boolean) => ({ checkbox: b });
const rel = (...ids: string[]) => ({ relation: ids.map((id) => ({ id })) });
const dt = (s: string) => ({ date: { start: s, end: null } });

function rule(props: Record<string, any>, id = 'rule-1'): ClassificationRule {
  return parseRule(id, { Regra: t('Regra teste'), Ativa: chk(true), 'Auto aplicar': chk(true), Prioridade: num(100), ...props });
}

// ---------------------------------------------------------------------------
// Classification (ported planner branches)
// ---------------------------------------------------------------------------

describe('classifyTransaction', () => {
  const kw = ['mesma titularidade'];
  it('keeps third-party incoming transfers pending review', () => {
    const c = classifyTransaction(row({ amount: 200, category_pierre: 'Transferências', description: 'Transferência Recebida|Fulano' }), kw);
    expect(c).toMatchObject({ branch: 'THIRD_PARTY_INCOMING', reviewStatus: 'Pendente Revisão', reviewReason: THIRD_PARTY_INCOMING_REASON, economicNature: null });
  });
  it('confirms same-ownership transfers as internal', () => {
    const c = classifyTransaction(row({ amount: 100, category_pierre: 'Transferência mesma titularidade' }), kw);
    expect(c).toMatchObject({ branch: 'SAME_OWNERSHIP_INCOMING', economicNature: 'Transferência interna', budgetEffect: 'Neutro', categoryName: 'Transferências internas' });
  });
  it('treats card bill payments as neutral', () => {
    const c = classifyTransaction(row({ amount: -300, description: 'Pagamento de fatura', category_pierre: 'Pagamento de cartão de crédito' }), kw);
    expect(c).toMatchObject({ branch: 'CARD_BILL_PAYMENT', economicNature: 'Pagamento de fatura', budgetEffect: 'Neutro' });
  });
  it('does not mistake a Pix to a payment institution for a bill payment', () => {
    const c = classifyTransaction(row({ amount: -67.21, category_pierre: 'Serviços', description: 'Transferência enviada|Pagar Me Instituição De Pagamento S.A.' }), kw);
    expect(c).toMatchObject({ branch: 'STANDARD_EXPENSE', economicNature: 'Despesa', categoryName: 'Serviços e assinaturas' });
    const nu = classifyTransaction(row({ amount: -50, category_pierre: 'Transferências', description: 'Transferência enviada|Nu Pagamentos S.A.' }), kw);
    expect(nu.branch).toBe('THIRD_PARTY_OUTGOING');
  });
  it('recognizes the bank card-payment descriptions even without the Pierre category', () => {
    expect(classifyTransaction(row({ amount: -10, category_pierre: null, description: 'Pagamento recebido' }), kw).branch).toBe('CARD_BILL_PAYMENT');
    expect(classifyTransaction(row({ amount: -10, category_pierre: 'Outros', description: 'Pagamento de fatura' }), kw).branch).toBe('CARD_BILL_PAYMENT');
  });
  it('keeps third-party outgoing transfers pending review', () => {
    const c = classifyTransaction(row({ amount: -30, category_pierre: 'Transferências', description: 'Transferência enviada|Beltrano' }), kw);
    expect(c).toMatchObject({ branch: 'THIRD_PARTY_OUTGOING', reviewReason: THIRD_PARTY_OUTGOING_REASON });
  });
  it('maps a homologated Pierre category to a confirmed expense', () => {
    expect(classifyTransaction(row(), kw)).toMatchObject({ branch: 'STANDARD_EXPENSE', economicNature: 'Despesa', budgetEffect: 'Despesa', categoryName: 'Alimentação' });
  });
  it('sends an unknown Pierre category to review instead of guessing', () => {
    const c = classifyTransaction(row({ category_pierre: 'Pet shop' }), kw);
    expect(c.branch).toBe('UNRESOLVED_CATEGORY');
    expect(c.reviewReason).toContain('Pet shop');
  });
});

// ---------------------------------------------------------------------------
// Projection: cycles and payment allocation
// ---------------------------------------------------------------------------

describe('projectNotionState', () => {
  it('links card purchases to their upstream bill and allocates the paired payment', () => {
    const txs = [
      row({ id: 'p1', account_id: 'card-1', account_type: 'CREDIT', amount: -80, category_pierre: 'Compras', description: 'Loja', date: '2026-09-05T10:00:00.000Z', raw: { credit_card_data: { billId: 'bill-9' } } }),
      row({ id: 'pay-bank', amount: -80, description: 'Pagamento de fatura', category_pierre: 'Pagamento de cartão de crédito', date: '2026-10-10T15:00:00.000Z' }),
      row({ id: 'pay-card', account_id: 'card-1', account_type: 'CREDIT', amount: -80, description: 'Pagamento recebido', category_pierre: 'Pagamento de cartão de crédito', date: '2026-10-10T15:02:00.000Z', raw: { credit_card_data: { billId: 'bill-9' } } }),
    ];
    const p = projectNotionState(ACCOUNTS, txs, ctx());
    expect(p.bills).toHaveLength(1);
    const bill = p.bills[0];
    expect(bill.stableId).toBe('nubank:bill:bill-9');
    expect(bill.payload['Fatura / Ciclo']).toBe('Nubank Cartão - Ciclo 2026-09 (Venc 16/10)');
    expect(bill.purchaseIds).toEqual(['p1']);
    expect(bill.paymentIds).toEqual(['pay-bank']);
    expect(bill.payload['Total de Compras no Ciclo']).toBe(80);
    expect(bill.payload['Valor Pago']).toBe(80);
    expect(p.transactions.find((x) => x.stableId === 'p1')!.billStableId).toBe('nubank:bill:bill-9');
    expect(p.transactions.find((x) => x.stableId === 'pay-card')!.billStableId).toBeNull();
  });

  it('derives an open period cycle when the purchase has no bill id yet', () => {
    const p = projectNotionState(ACCOUNTS, [row({ id: 'p2', account_id: 'card-1', account_type: 'CREDIT', amount: -12, category_pierre: 'Compras', date: '2026-09-21T10:00:00.000Z' })], ctx());
    expect(p.bills[0].stableId).toBe('nubank:cartao:2026-09:cycle');
    expect(p.bills[0].payload['Fatura / Ciclo']).toBe('Nubank Cartão - Ciclo 2026-09 Aberto (Venc 16/10)');
    expect(p.bills[0].payload['Qualidade da Identidade']).toBe('PERIOD_FALLBACK');
  });

  it('fails closed when the mapped Notion account pages are missing', () => {
    expect(() => projectNotionState(ACCOUNTS, [row()], ctx({ notionAccounts: [] }))).toThrow(/FAIL_CLOSED_ACCOUNT_MAPPING/);
  });
});

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

describe('classification rules', () => {
  const incoming = row({ id: 'in-1', amount: 200, category_pierre: 'Transferências', description: 'Transferência Recebida|NILSON R SILVA', date: '2026-09-03T10:00:00.000Z', raw: { payment_data: { payer: { name: 'Nilson Rodrigues Silva' } } } });

  it('is eligible only when active, auto-applied, with a condition and a result', () => {
    expect(isEligibleRule(rule({ 'Contraparte contém': rt('Nilson'), 'Natureza resultante': sel('Receita') }))).toBe(true);
    expect(isEligibleRule(rule({ 'Contraparte contém': rt('Nilson'), 'Natureza resultante': sel('Receita'), 'Auto aplicar': chk(false) }))).toBe(false);
    expect(isEligibleRule(rule({ 'Natureza resultante': sel('Receita') }))).toBe(false);
    expect(isEligibleRule(rule({ 'Contraparte contém': rt('Nilson') }))).toBe(false);
  });

  it('matches the counterparty through Pierre payer data, ignoring case and accents', () => {
    const r = rule({ 'Contraparte contém': rt('nilson rodrigues'), 'Movimento esperado': sel('Entrada'), 'Natureza resultante': sel('Receita') });
    expect(findMatchingRule([r], incoming, PAGES.conta)).toBe(r);
    const wrongDirection = rule({ 'Contraparte contém': rt('nilson'), 'Movimento esperado': sel('Saída'), 'Natureza resultante': sel('Receita') });
    expect(findMatchingRule([wrongDirection], incoming, PAGES.conta)).toBeNull();
  });

  it('honours exact value with tolerance, day-of-month windows (wrapping) and validity', () => {
    const exact = rule({ 'Valor exato': num(199.99), Tolerância: num(0.01), 'Natureza resultante': sel('Receita') });
    expect(findMatchingRule([exact], incoming, null)).toBe(exact);
    const wrap = rule({ 'Dia mínimo': num(28), 'Dia máximo': num(5), 'Natureza resultante': sel('Receita') });
    expect(findMatchingRule([wrap], incoming, null)).toBe(wrap);
    const expired = rule({ 'Valor mínimo': num(1), 'Válida até': dt('2026-08-31'), 'Natureza resultante': sel('Receita') });
    expect(findMatchingRule([expired], incoming, null)).toBeNull();
  });

  it('evaluates by ascending priority', () => {
    const low = rule({ 'Valor mínimo': num(1), 'Natureza resultante': sel('Reembolso'), Prioridade: num(200) }, 'r-low');
    const high = rule({ 'Valor mínimo': num(1), 'Natureza resultante': sel('Receita'), Prioridade: num(10) }, 'r-high');
    expect(findMatchingRule([low, high], incoming, null)!.pageId).toBe('r-high');
  });

  it('applies nature, derived effect and category; "Exigir revisão" leaves it Provável', () => {
    const base = projectNotionState(ACCOUNTS, [incoming], ctx()).transactions[0];
    const r = rule({ 'Contraparte contém': rt('nilson'), 'Natureza resultante': sel('Receita'), 'Categoria resultante': rel(PAGES.renda), 'Exigir revisão': chk(true) });
    const { projected } = applyRuleToProjection([r], incoming, base);
    expect(projected.payload).toMatchObject({ Natureza: 'Receita', 'Efeito Orçamentário': 'Receita', 'Status de Revisão': 'Provável' });
    expect(projected.relations['Categoria']).toEqual([PAGES.renda]);
    expect(effectFromNature('Reembolso')).toBe('Estorno');
    expect(effectFromNature('Aporte')).toBe('Neutro');
  });
});

// ---------------------------------------------------------------------------
// Reconciliation (ownership rules)
// ---------------------------------------------------------------------------

/** Builds the live state the Notion workspace would hold after the projection was written verbatim. */
function liveFromProjection(txs: SqliteTransactionRow[], c = ctx(), mutate: (id: string, props: Record<string, any>) => void = () => {}): LiveState {
  const p = projectNotionState(ACCOUNTS, txs, c);
  const billPage = (id: string) => `bill-page:${id}`;
  const transactions = new Map<string, LivePage[]>();
  for (const tx of p.transactions) {
    const relations: Record<string, string[]> = { ...tx.relations };
    if (tx.billStableId) relations['Fatura Vinculada'] = [billPage(tx.billStableId)];
    const props = serializePayloadForNotion('NOTION_DS_TRANSACTIONS', tx.payload, relations, true).notionProperties;
    mutate(tx.stableId, props);
    transactions.set(tx.stableId, [{ pageId: `tx-page:${tx.stableId}`, canonical: canonicalizeLive('NOTION_DS_TRANSACTIONS', props), raw: props }]);
  }
  const bills = new Map<string, LivePage[]>();
  for (const b of p.bills) {
    const props = serializePayloadForNotion('NOTION_DS_CARD_BILLS', b.payload, { 'Cartão Vinculado': [b.cardPageId], 'Transações de Pagamento': b.paymentIds.map((i) => `tx-page:${i}`) }, true).notionProperties;
    mutate(b.stableId, props);
    bills.set(b.stableId, [{ pageId: billPage(b.stableId), canonical: canonicalizeLive('NOTION_DS_CARD_BILLS', props), raw: props }]);
  }
  return { transactions, bills, accounts: [] };
}

const noAccounts: AccountSourceContext = { rows: [], roles: {}, pageBySourceId: new Map() };

describe('reconcile', () => {
  const pending = row({ id: 'in-1', amount: 200, category_pierre: 'Transferências', description: 'Transferência Recebida|Fulano', raw: { payment_data: { payer: { name: 'Fulano' } } } });
  const purchase = row({ id: 'p1', account_id: 'card-1', account_type: 'CREDIT', amount: -80, category_pierre: 'Compras', date: '2026-09-05T10:00:00.000Z', raw: { credit_card_data: { billId: 'bill-9' } } });
  const fulanoRule = rule({ 'Contraparte contém': rt('fulano'), 'Natureza resultante': sel('Receita'), 'Categoria resultante': rel(PAGES.renda) });

  it('creates every missing page, with the rule applied and the bill linked', () => {
    const rows = [row(), pending, purchase];
    const plan = reconcile(projectNotionState(ACCOUNTS, rows, ctx()), rows, [fulanoRule], { transactions: new Map(), bills: new Map(), accounts: [] }, noAccounts, { hmacKeyAvailable: true });
    expect(plan.txCreates.map((c) => c.stableId).sort()).toEqual(['in-1', 'p1', 'tx-1']);
    expect(plan.billCreates.map((b) => b.stableId)).toEqual(['nubank:bill:bill-9']);
    const created = plan.txCreates.find((c) => c.stableId === 'in-1')!;
    expect(created.rule).toBe('Regra teste');
    expect(created.payload['Natureza']).toBe('Receita');
    expect(plan.txCreates.find((c) => c.stableId === 'p1')!.relations['Fatura Vinculada']).toEqual([{ kind: 'bill', stableId: 'nubank:bill:bill-9' }]);
  });

  it('is idempotent: a workspace that already holds the projection needs nothing', () => {
    const rows = [row(), pending, purchase];
    const plan = reconcile(projectNotionState(ACCOUNTS, rows, ctx()), rows, [], liveFromProjection(rows), noAccounts, { hmacKeyAvailable: true });
    expect(plan.txCreates).toEqual([]);
    expect(plan.txUpdates).toEqual([]);
    expect(plan.billCreates).toEqual([]);
    expect(plan.billUpdates).toEqual([]);
    expect(plan.stats.unchangedTransactions).toBe(3);
  });

  it('refreshes source fields (bank status) without touching classification or user fields', () => {
    const before = [row({ status: 'PENDING' })];
    const live = liveFromProjection(before, ctx(), (id, props) => {
      if (id === 'tx-1') {
        props['Natureza'] = sel('Reembolso'); // the person re-classified it
        props['Revisado'] = chk(true);
      }
    });
    live.transactions.get('tx-1')![0].canonical = canonicalizeLive('NOTION_DS_TRANSACTIONS', live.transactions.get('tx-1')![0].raw);
    const after = [row({ status: 'POSTED' })];
    const plan = reconcile(projectNotionState(ACCOUNTS, after, ctx()), after, [], live, noAccounts, { hmacKeyAvailable: true });
    expect(plan.txUpdates).toHaveLength(1);
    expect(plan.txUpdates[0].kind).toBe('SOURCE');
    expect(plan.txUpdates[0].fields.sort()).toEqual(['Hash Canônico', 'Status']);
    expect(plan.txUpdates[0].payload['Status']).toBe('Confirmado');
    expect(plan.txUpdates[0].payload).not.toHaveProperty('Natureza');
  });

  it('re-classifies an untouched pending page when a rule now matches, but never a reviewed one', () => {
    const rows = [pending];
    const plan = reconcile(projectNotionState(ACCOUNTS, rows, ctx()), rows, [fulanoRule], liveFromProjection(rows), noAccounts, { hmacKeyAvailable: true });
    expect(plan.txUpdates).toHaveLength(1);
    expect(plan.txUpdates[0]).toMatchObject({ kind: 'RECLASSIFY', rule: 'Regra teste' });
    expect(plan.txUpdates[0].payload).toMatchObject({ Natureza: 'Receita', 'Efeito Orçamentário': 'Receita', 'Status de Revisão': 'Confirmado Auto' });

    const reviewed = liveFromProjection(rows, ctx(), (id, props) => {
      if (id === 'in-1') props['Revisado'] = chk(true);
    });
    const plan2 = reconcile(projectNotionState(ACCOUNTS, rows, ctx()), rows, [fulanoRule], reviewed, noAccounts, { hmacKeyAvailable: true });
    expect(plan2.txUpdates).toEqual([]);
  });

  it('fails closed on duplicate stable ids', () => {
    const rows = [row()];
    const live = liveFromProjection(rows);
    live.transactions.set('tx-1', [...live.transactions.get('tx-1')!, { ...live.transactions.get('tx-1')![0], pageId: 'dup' }]);
    const plan = reconcile(projectNotionState(ACCOUNTS, rows, ctx()), rows, [], live, noAccounts, { hmacKeyAvailable: true });
    expect(plan.fatal.join()).toMatch(/DUPLICATE_STABLE_ID/);
  });

  it('never writes an obfuscated pseudonym when the HMAC key is not configured', () => {
    const rows = [pending];
    const noKey = ctx({ hmacKey: undefined });
    const create = reconcile(projectNotionState(ACCOUNTS, rows, noKey), rows, [], { transactions: new Map(), bills: new Map(), accounts: [] }, noAccounts, { hmacKeyAvailable: false });
    expect(create.txCreates[0].payload['HMAC Contraparte']).toBeNull();
    const update = reconcile(projectNotionState(ACCOUNTS, rows, noKey), rows, [], liveFromProjection(rows), noAccounts, { hmacKeyAvailable: false });
    expect(update.txUpdates).toEqual([]);
  });

  it('keeps what a person filled in on a bill and reports bills the source no longer derives', () => {
    const rows = [purchase];
    const live = liveFromProjection(rows, ctx(), (id, props) => {
      if (id === 'nubank:bill:bill-9') props['Status da Fatura'] = sel('Paga Integralmente');
    });
    live.bills.get('nubank:bill:bill-9')![0].canonical = canonicalizeLive('NOTION_DS_CARD_BILLS', live.bills.get('nubank:bill:bill-9')![0].raw);
    live.bills.set('nubank:cartao:2026-01:cycle', [{ pageId: 'old', canonical: {}, raw: {} }]);
    const plan = reconcile(projectNotionState(ACCOUNTS, rows, ctx()), rows, [], live, noAccounts, { hmacKeyAvailable: true });
    expect(plan.billUpdates).toEqual([]);
    expect(plan.warnings.join()).toMatch(/STALE_BILL: a fatura nubank:cartao:2026-01:cycle/);
  });

  it('refreshes balances only from a snapshot at least as recent as the page', () => {
    const accountPage = (name: string, props: Record<string, any>) => ({ pageId: name === 'Nubank Conta' ? PAGES.conta : PAGES.cartao, name, canonical: canonicalizeLive('NOTION_DS_ACCOUNTS', props), raw: props });
    const live: LiveState = {
      transactions: new Map(),
      bills: new Map(),
      accounts: [
        accountPage('Nubank Conta', { Conta: t('Nubank Conta'), Saldo: num(121.26), 'Atualizado em': dt('2026-09-10') }),
        accountPage('Nubank Cartão', { Conta: t('Nubank Cartão'), 'Limite personalizado': num(400), 'Limite disponível': num(261.35), 'Atualizado em': dt('2026-09-10') }),
      ],
    };
    const acc: AccountSourceContext = { rows: ACCOUNTS, roles: { 'bank-1': 'CHECKING', 'card-1': 'CREDIT' }, pageBySourceId: new Map([['bank-1', PAGES.conta], ['card-1', PAGES.cartao]]) };
    const plan = reconcile(projectNotionState(ACCOUNTS, [], ctx()), [], [], live, acc, { hmacKeyAvailable: true });
    const bank = plan.accountUpdates.find((a) => a.pageId === PAGES.conta)!;
    expect(bank.payload).toMatchObject({ Saldo: 500, 'Atualizado em': { start: '2026-09-29', end: null } });
    const card = plan.accountUpdates.find((a) => a.pageId === PAGES.cartao)!;
    expect(card.payload).toMatchObject({ 'Limite contratado': 2400, 'Limite disponível': 300, 'Limite Usado da Fonte (Bruto)': 2100, 'Limite Operacional Usado': 100 });

    const oldRows = ACCOUNTS.map((a) => ({ ...a, last_synced_at: '2026-08-03 00:16:23' }));
    const stale = reconcile(projectNotionState(oldRows, [], ctx()), [], [], live, { ...acc, rows: oldRows }, { hmacKeyAvailable: true });
    expect(stale.accountUpdates).toEqual([]);
    expect(stale.warnings.join()).toMatch(/STALE_SOURCE_ACCOUNT/);
  });
});

// ---------------------------------------------------------------------------
// Schema preflight and gateway
// ---------------------------------------------------------------------------

describe('schema preflight and gateway', () => {
  it('refuses select options that do not exist (writing one would create it)', () => {
    const txSchema = (schemas as any).NOTION_DS_TRANSACTIONS;
    expect(validateAgainstLiveSchema('NOTION_DS_TRANSACTIONS', txSchema, { Natureza: 'Receita' }, [])).toEqual([]);
    expect(validateAgainstLiveSchema('NOTION_DS_TRANSACTIONS', txSchema, { Natureza: 'Mesada' }, [])[0]).toMatch(/SCHEMA_UNKNOWN_OPTION/);
    expect(validateAgainstLiveSchema('NOTION_DS_TRANSACTIONS', { ...txSchema, Valor: { type: 'rich_text' } }, { Valor: 1 }, [])[0]).toMatch(/SCHEMA_TYPE_MISMATCH/);
  });

  it('retries rate limits and server errors only', () => {
    expect(isRetryableNotionError({ status: 429 })).toBe(true);
    expect(isRetryableNotionError({ code: 'conflict_error' })).toBe(true);
    expect(isRetryableNotionError({ status: 503 })).toBe(true);
    expect(isRetryableNotionError({ status: 400, code: 'validation_error' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Engine end to end against an in-memory Notion
// ---------------------------------------------------------------------------

const DS = { transactions: 'ds-tx', bills: 'ds-bills', accounts: 'ds-acc', categories: 'ds-cat', rules: 'ds-rules', syncLog: 'ds-log' };
const SCHEMA_BY_DS: Record<string, any> = {
  'ds-tx': (schemas as any).NOTION_DS_TRANSACTIONS,
  'ds-bills': (schemas as any).NOTION_DS_CARD_BILLS,
  'ds-acc': (schemas as any).NOTION_DS_ACCOUNTS,
  'ds-cat': (schemas as any).NOTION_DS_CATEGORIES,
  'ds-rules': (schemas as any).NOTION_DS_RULES,
  'ds-log': (schemas as any).NOTION_DS_SYNC_LOG,
};

class FakeNotion {
  store = new Map<string, { id: string; ds: string; properties: Record<string, any> }>();
  seq = 0;
  writes = 0;
  seed(ds: string, id: string, properties: Record<string, any>) {
    this.store.set(id, { id, ds, properties });
  }
  byDs(ds: string) {
    return Array.from(this.store.values()).filter((p) => p.ds === ds);
  }
  dataSources = {
    query: async ({ data_source_id }: any) => ({ results: this.byDs(data_source_id).map((p) => ({ id: p.id, properties: p.properties })), has_more: false, next_cursor: null }),
    retrieve: async ({ data_source_id }: any) => ({ properties: SCHEMA_BY_DS[data_source_id] }),
  };
  pages = {
    create: async ({ parent, properties }: any) => {
      this.writes++;
      const id = `new-${++this.seq}`;
      this.store.set(id, { id, ds: parent.data_source_id, properties });
      return { id };
    },
    update: async ({ page_id, properties }: any) => {
      this.writes++;
      const page = this.store.get(page_id)!;
      page.properties = { ...page.properties, ...properties };
      return { id: page_id };
    },
  };
}

function seedWorkspace(n: FakeNotion) {
  n.seed(DS.accounts, PAGES.conta, { Conta: t('Nubank Conta'), 'Atualizado em': dt('2026-09-10'), Saldo: num(121.26) });
  n.seed(DS.accounts, PAGES.cartao, { Conta: t('Nubank Cartão'), 'Limite personalizado': num(400), 'Atualizado em': dt('2026-09-10') });
  n.seed(DS.categories, PAGES.alimentacao, { Categoria: t('Alimentação') });
  n.seed(DS.categories, PAGES.compras, { Categoria: t('Compras') });
  n.seed(DS.categories, PAGES.renda, { Categoria: t('Renda extra') });
  n.seed(DS.rules, 'rule-fulano', {
    Regra: t('Fulano é renda'), Ativa: chk(true), 'Auto aplicar': chk(true), Prioridade: num(100),
    'Contraparte contém': rt('fulano'), 'Natureza resultante': sel('Receita'), 'Categoria resultante': rel(PAGES.renda),
  });
}

const pierreTx = (o: Record<string, any>) => ({
  id: 'x', account_id: 'bank-1', description: 'Mercado', category: 'Supermercado', original_category: '', tr_confidence: null, tr_reasoning: null,
  currency_code: 'BRL', amount: -50, amount_in_account_currency: null, date: '2026-09-20T12:00:00.000Z', installment_due_date: null, type: 'DEBIT',
  status: 'POSTED', payment_data: null, credit_card_data: null, merchant: null, account_name: 'Conta', account_type: 'BANK', account_subtype: 'CHECKING_ACCOUNT',
  account_item_id: 'item', connector_name: 'Nubank', connector_image_url: '', ...o,
});

function fakePierre(txs: any[]) {
  return {
    triggerManualUpdate: async () => ({}),
    getAccounts: async () => ({
      data: [
        { id: 'bank-1', name: 'Conta', type: 'BANK', subtype: 'CHECKING_ACCOUNT', connectorName: 'Nubank', customName: null, bankData: { closingBalance: 500 }, creditData: null },
        { id: 'card-1', name: 'Cartão', type: 'CREDIT', subtype: 'CREDIT_CARD', connectorName: 'Nubank', customName: null, bankData: null, creditData: { creditLimit: 2400, availableCreditLimit: 300 } },
      ],
    }),
    getTransactions: async () => ({ data: txs }),
  } as any;
}

const SETTINGS: NotionSyncSettings = {
  accountRoles: { 'bank-1': 'CHECKING', 'card-1': 'CREDIT' },
  defaultDueDay: 16,
  checkingAccountName: 'Nubank Conta',
  creditAccountName: 'Nubank Cartão',
  hmacKey: HMAC,
  hmacKeyVersion: 'v1',
  sameOwnershipKeywords: ['mesma titularidade'],
  maxCreates: 300,
  workerVersion: 'test',
};
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

describe('NotionSyncEngine', () => {
  let notion: FakeNotion;
  let db: Database.Database;
  const txs = [
    pierreTx({ id: 't-mercado' }),
    pierreTx({ id: 't-loja', account_id: 'card-1', account_type: 'CREDIT', account_subtype: 'CREDIT_CARD', amount: 80, category: 'Compras', description: 'Loja', status: 'PENDING', date: '2026-09-18T12:00:00.000Z', credit_card_data: { billId: 'bill-9' } }),
    pierreTx({ id: 't-pix', amount: 200, category: 'Transferências', description: 'Transferência Recebida|Fulano', payment_data: { payer: { name: 'Fulano de Tal' } } }),
  ];
  const engine = (pierreTxs = txs, settings = SETTINGS) =>
    new NotionSyncEngine(settings, { gateway: new NotionSyncGateway(notion as any, DS, { minIntervalMs: 0, sleep: async () => {} }), db, pierre: fakePierre(pierreTxs), now: () => new Date('2026-09-29T12:00:00.000Z'), sleep: async () => {} }, quiet);
  const opts = { apply: true, skipPierre: false, skipUpdate: false, fullSync: false, allowLarge: false };

  beforeEach(() => {
    notion = new FakeNotion();
    seedWorkspace(notion);
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('dry-run plans the changes without writing to Notion or SQLite', async () => {
    const report = await engine().run({ ...opts, apply: false });
    expect(report.mode).toBe('DRY_RUN');
    expect(report.plan).toMatchObject({ txCreates: 3, billCreates: 1, accountUpdates: 2 });
    expect(report.plan.rulesApplied).toEqual({ 'Fulano é renda': 1 });
    expect(notion.writes).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM transactions').get() as any).n).toBe(0);
  });

  it('applies, verifies, logs the run, and a second run has nothing to do', async () => {
    const first = await engine().run(opts);
    expect(first.status).toBe('SUCCESS');
    expect(first.applied.errors).toEqual([]);
    expect(first.residual).toEqual({ txCreates: 0, txUpdates: 0, billCreates: 0, billUpdates: 0 });
    expect(notion.byDs(DS.transactions)).toHaveLength(3);
    expect(notion.byDs(DS.bills)).toHaveLength(1);
    const pix = notion.byDs(DS.transactions).find((p) => p.properties['ID da fonte'].rich_text[0].text.content === 't-pix')!;
    expect(pix.properties['Natureza']).toEqual(sel('Receita'));
    const loja = notion.byDs(DS.transactions).find((p) => p.properties['ID da fonte'].rich_text[0].text.content === 't-loja')!;
    expect(loja.properties['Fatura Vinculada']).toEqual(rel(notion.byDs(DS.bills)[0].id));
    expect(loja.properties['Status']).toEqual(sel('Pendente'));
    expect(notion.store.get(PAGES.conta)!.properties['Saldo']).toEqual(num(500));
    const log = notion.byDs(DS.syncLog);
    expect(log).toHaveLength(1);
    expect(log[0].properties['Status']).toEqual(sel('Sucesso'));
    expect(log[0].properties['Transações novas']).toEqual(num(3));

    // Second run: every run is logged, but no data page is written or changed.
    const snapshot = JSON.stringify([DS.transactions, DS.bills, DS.accounts].map((ds) => notion.byDs(ds)));
    const writesAfterFirst = notion.writes;
    const second = await engine().run(opts);
    expect(second.status).toBe('NOTHING_TO_DO');
    expect(notion.writes - writesAfterFirst).toBe(2); // Log de Sincronização: open + close
    expect(notion.byDs(DS.syncLog)).toHaveLength(2);
    expect(JSON.stringify([DS.transactions, DS.bills, DS.accounts].map((ds) => notion.byDs(ds)))).toBe(snapshot);
  });

  it('propagates a bank status change (PENDING → POSTED) through SQLite to Notion', async () => {
    await engine().run(opts);
    const posted = txs.map((t) => (t.id === 't-loja' ? { ...t, status: 'POSTED' } : t));
    const report = await engine(posted).run(opts);
    expect(report.plan.txSourceUpdates).toBe(1);
    expect((db.prepare("SELECT status FROM transactions WHERE id = 't-loja'").get() as any).status).toBe('POSTED');
    const loja = notion.byDs(DS.transactions).find((p) => p.properties['ID da fonte'].rich_text[0].text.content === 't-loja')!;
    expect(loja.properties['Status']).toEqual(sel('Confirmado'));
  });

  it('fails closed before writing when the plan would create an unknown select option', async () => {
    notion.store.get('rule-fulano')!.properties['Natureza resultante'] = sel('Mesada');
    await expect(engine().run(opts)).rejects.toThrow(/SCHEMA_UNKNOWN_OPTION/);
    expect(notion.writes).toBe(0);
  });

  it('refuses unexpectedly large writes unless explicitly allowed', async () => {
    await expect(engine(txs, { ...SETTINGS, maxCreates: 2 }).run(opts)).rejects.toThrow(/FAIL_CLOSED_LARGE_WRITE/);
    expect(notion.writes).toBe(0);
    const report = await engine(txs, { ...SETTINGS, maxCreates: 2 }).run({ ...opts, allowLarge: true });
    expect(report.status).toBe('SUCCESS');
  });
});

describe('Repository.upsertTransaction (status/date/description changes)', () => {
  it('persists a status change and keeps the historical category mapping', () => {
    const d = new Database(':memory:');
    runMigrations(d);
    const repo = new Repository(d);
    d.prepare("INSERT INTO accounts (id, name, type, subtype) VALUES ('bank-1', 'Conta', 'BANK', 'CHECKING_ACCOUNT')").run();
    const base = { id: 'tx', accountId: 'bank-1', date: '2026-09-01T10:00:00.000Z', description: 'Pix', amount: -10, originalAmount: -10, direction: 'TRANSFER' as const, categoryPierre: 'Transferências', accountName: 'Conta', accountType: 'BANK' as const, status: 'PENDING', rawJson: '{}' };
    repo.upsertTransaction(base, { categoryPierre: 'Transferências', categoryMapped: '(Transferência)', group: '', variability: '' });
    expect(repo.upsertTransaction({ ...base, status: 'POSTED' })).toBe('updated');
    const saved = d.prepare("SELECT status, category_mapped FROM transactions WHERE id = 'tx'").get() as any;
    expect(saved).toEqual({ status: 'POSTED', category_mapped: '(Transferência)' });
    expect(repo.upsertTransaction({ ...base, status: 'POSTED' })).toBe('unchanged');
  });
});
