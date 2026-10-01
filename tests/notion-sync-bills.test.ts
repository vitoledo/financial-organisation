import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { runMigrations } from '../src/storage/migrations';
import { Repository } from '../src/storage/repository';
import { normalizeBill, normalizeTransaction } from '../src/pierre/normalizer';
import { serializePayloadForNotion } from '../src/notion/migration-runner/backfill-serializer';
import { classifyTransaction, projectNotionState, THIRD_PARTY_INCOMING_REASON, THIRD_PARTY_OUTGOING_REASON } from '../src/notion/sync/projection';
import { reconcile, LiveState, AccountSourceContext } from '../src/notion/sync/reconcile';
import { canonicalizeLive } from '../src/notion/sync/notion-gateway';
import { LivePage, OfficialBill, ProjectionContext, SqliteAccountRow, SqliteTransactionRow } from '../src/notion/sync/types';

// Mirrors the real Nubank calendar seen through Pierre: bills close on the 9th and are due on the 16th/17th,
// every purchase is paid right away (official statement balance 0.00), and the card balance is the open bill.
const PAGES = { conta: 'page-conta', cartao: 'page-cartao' };
const CARD_RAW = JSON.stringify({ balance: '477.90', creditData: { disaggregatedCreditLimits: [{ customizedLimitAmount: 500 }] } });
const ACCOUNTS: SqliteAccountRow[] = [
  { id: 'bank-1', name: 'Nubank Conta', type: 'BANK', subtype: 'CHECKING_ACCOUNT', closing_balance: 26.8, credit_limit: null, available_credit: null, last_synced_at: '2026-10-01 10:00:00' },
  { id: 'card-1', name: 'Nubank Cartão', type: 'CREDIT', subtype: 'CREDIT_CARD', closing_balance: null, credit_limit: 2400, available_credit: 22.1, last_synced_at: '2026-10-01 10:00:00', raw_json: CARD_RAW },
];
const OFFICIAL: OfficialBill[] = [
  { id: 'B-AUG', accountId: 'card-1', closingDate: '2026-08-09', dueDate: '2026-08-17', totalAmount: 0 },
  { id: 'B-SEP', accountId: 'card-1', closingDate: '2026-09-09', dueDate: '2026-09-16', totalAmount: 0 },
  { id: 'B-OLD', accountId: 'card-1', closingDate: null, dueDate: '2026-04-22', totalAmount: 12.7 },
  { id: 'B-OTHER', accountId: 'other-card', closingDate: '2026-09-20', dueDate: '2026-09-28', totalAmount: 99 },
];

function ctx(overrides: Partial<ProjectionContext> = {}): ProjectionContext {
  return {
    accountRoles: { 'bank-1': 'CHECKING', 'card-1': 'CREDIT' },
    defaultDueDay: 16,
    notionAccounts: [
      { id: PAGES.conta, name: 'Nubank Conta' },
      { id: PAGES.cartao, name: 'Nubank Cartão' },
    ],
    categoryIdByName: new Map([['compras', 'cat-compras']]),
    hmacKey: 'a'.repeat(64),
    hmacKeyVersion: 'v1',
    sameOwnershipKeywords: ['mesma titularidade'],
    checkingAccountName: 'Nubank Conta',
    creditAccountName: 'Nubank Cartão',
    officialBills: OFFICIAL,
    today: '2026-10-01',
    ...overrides,
  };
}

function card(id: string, amount: number, date: string, billId: string | null, o: Partial<SqliteTransactionRow> = {}): SqliteTransactionRow {
  return {
    id, account_id: 'card-1', date, description: `Compra ${id}`, amount, direction: 'EXPENSE', category_pierre: 'Compras', category_mapped: 'Compras',
    account_type: 'CREDIT', status: billId ? 'POSTED' : 'PENDING', raw_json: JSON.stringify(billId ? { credit_card_data: { billId } } : {}), ...o,
  };
}
function bankPayment(id: string, amount: number, date: string): SqliteTransactionRow {
  return {
    id, account_id: 'bank-1', date, description: 'Pagamento de fatura', amount: -amount, direction: 'TRANSFER', category_pierre: 'Pagamento de cartão de crédito',
    category_mapped: 'Pagamento de cartão de crédito', account_type: 'BANK', status: 'POSTED', raw_json: '{}',
  };
}

const HISTORY = [
  card('p-aug', -100, '2026-07-20T12:00:00.000Z', 'B-AUG'),
  card('p-sep', -60, '2026-09-06T12:00:00.000Z', 'B-SEP'),
  card('p-open', -30, '2026-09-12T03:00:00.000Z', null),
  // Still pending although dated before the last closing: the bank bills it on the next (open) bill.
  card('p-late', -20, '2026-09-08T03:00:00.000Z', null),
];
const bill = (p: ReturnType<typeof projectNotionState>, id: string) => p.bills.find((b) => b.stableId === id)!;

describe('card bills anchored on the bank calendar (GET /get-bills)', () => {
  it('takes closing, due date, period and statement balance of a reported bill from the bank', () => {
    const p = projectNotionState(ACCOUNTS, HISTORY, ctx());
    const sep = bill(p, 'nubank:bill:B-SEP').payload;
    expect(sep['Fatura / Ciclo']).toBe('Nubank Cartão - Ciclo 2026-09 (Venc 16/09)');
    expect(sep['Início do Período']).toEqual({ start: '2026-08-10', end: null });
    expect(sep['Fim do Período']).toEqual({ start: '2026-09-09', end: null });
    expect(sep['Data de Fechamento']).toEqual({ start: '2026-09-09', end: null });
    expect(sep['Data de Vencimento']).toEqual({ start: '2026-09-16', end: null });
    expect(sep['Origem / Qualidade dos Dados']).toBe('UPSTREAM_OFFICIAL');
    expect(sep['Valor da Fatura Fechada (Oficial)']).toBe(0);
    expect(sep['Status da Fatura']).toBe('Paga Integralmente');
    // The oldest reported bill has no earlier closing: its period still starts at its first purchase.
    expect(bill(p, 'nubank:bill:B-AUG').payload['Início do Período']).toEqual({ start: '2026-07-20', end: null });
  });

  it('places pending purchases on the open bill of the bank calendar, with the bank figure for the open amount', () => {
    const p = projectNotionState(ACCOUNTS, HISTORY, ctx());
    expect(p.bills.map((b) => b.stableId).sort()).toEqual(['nubank:bill:B-AUG', 'nubank:bill:B-SEP', 'nubank:cartao:2026-10:cycle']);
    const open = bill(p, 'nubank:cartao:2026-10:cycle');
    expect(open.purchaseIds.sort()).toEqual(['p-late', 'p-open']);
    expect(open.payload).toMatchObject({
      'Fatura / Ciclo': 'Nubank Cartão - Ciclo 2026-10 Aberto (Venc 16/10)',
      'Início do Período': { start: '2026-09-10', end: null },
      'Fim do Período': { start: '2026-10-09', end: null },
      'Data de Fechamento': { start: '2026-10-09', end: null },
      'Data de Vencimento': { start: '2026-10-16', end: null },
      'Status da Fatura': 'Aberta em Curso',
      'Valor Estimado da Fatura Aberta': 477.9,
      'Valor da Fatura Fechada (Oficial)': null,
      'Total de Compras no Ciclo': 50,
    });
    expect(p.transactions.find((x) => x.stableId === 'p-late')!.billStableId).toBe('nubank:cartao:2026-10:cycle');
  });

  it('between closing and due date, places a not-yet-reported bill on the calendar and opens the next one', () => {
    const closed = [
      ...HISTORY.slice(0, 2),
      card('p-open', -30, '2026-09-12T03:00:00.000Z', 'B-OCT'),
      card('p-late', -20, '2026-09-08T03:00:00.000Z', 'B-OCT'),
      card('p-next', -15, '2026-10-11T03:00:00.000Z', null),
    ];
    const p = projectNotionState(ACCOUNTS, closed, ctx({ today: '2026-10-12' }));
    expect(bill(p, 'nubank:bill:B-OCT').payload).toMatchObject({
      'Fatura / Ciclo': 'Nubank Cartão - Ciclo 2026-10 (Venc 16/10)',
      'Início do Período': { start: '2026-09-10', end: null },
      'Data de Fechamento': { start: '2026-10-09', end: null },
      'Data de Vencimento': { start: '2026-10-16', end: null },
      'Origem / Qualidade dos Dados': 'UPSTREAM_APPROXIMATE',
      'Status da Fatura': 'Fechada a Vencer',
      'Valor Estimado da Fatura Aberta': null,
    });
    expect(bill(p, 'nubank:cartao:2026-11:cycle').payload).toMatchObject({
      'Início do Período': { start: '2026-10-10', end: null },
      'Data de Fechamento': { start: '2026-11-09', end: null },
      'Data de Vencimento': { start: '2026-11-16', end: null },
      'Status da Fatura': 'Aberta em Curso',
      'Valor Estimado da Fatura Aberta': 477.9,
    });
  });

  it('derives the status of a statement with a balance from the payments made after closing', () => {
    const owing: OfficialBill[] = [{ id: 'B-SEP', accountId: 'card-1', closingDate: '2026-09-09', dueDate: '2026-09-16', totalAmount: 150 }];
    const txs = [card('p-sep', -150, '2026-09-06T12:00:00.000Z', 'B-SEP')];
    const status = (extra: SqliteTransactionRow[], today: string) =>
      bill(projectNotionState(ACCOUNTS, [...txs, ...extra], ctx({ officialBills: owing, today })), 'nubank:bill:B-SEP').payload['Status da Fatura'];
    expect(status([], '2026-09-12')).toBe('Fechada a Vencer');
    expect(status([], '2026-10-01')).toBe('Vencida');
    expect(status([bankPayment('pay-1', 50, '2026-09-14T12:00:00.000Z')], '2026-10-01')).toBe('Paga Parcialmente');
    expect(status([bankPayment('pay-1', 150, '2026-09-14T12:00:00.000Z')], '2026-10-01')).toBe('Paga Integralmente');
    // A payment before the closing reduced the statement itself; it does not settle it again.
    expect(status([bankPayment('pay-0', 150, '2026-09-05T12:00:00.000Z')], '2026-10-01')).toBe('Vencida');
  });

  it('without official bills keeps the migration behaviour (no status, no official values)', () => {
    const p = projectNotionState(ACCOUNTS, HISTORY, ctx({ officialBills: [], today: '2026-10-01' }));
    expect(p.bills.map((b) => b.stableId).sort()).toEqual(['nubank:bill:B-AUG', 'nubank:bill:B-SEP', 'nubank:cartao:2026-09:cycle']);
    for (const b of p.bills) {
      expect(b.payload['Status da Fatura']).toBeNull();
      expect(b.payload['Valor da Fatura Fechada (Oficial)']).toBeNull();
      expect(b.payload['Valor Estimado da Fatura Aberta']).toBeNull();
    }
  });
});

describe('Pix paid with credit', () => {
  const pierre = (o: Record<string, any>) => ({
    id: 'x', account_id: 'card-1', description: 'Apmetecbentoquiri', category: 'Transferências', amount: 110, date: '2026-09-15T03:00:00.000Z',
    status: 'PENDING', type: 'DEBIT', account_type: 'CREDIT', account_name: 'Cartão', ...o,
  }) as any;

  it('is a charge leaving the card, while card payments and account transfers keep their sign', () => {
    expect(normalizeTransaction(pierre({}))).toMatchObject({ amount: -110, direction: 'TRANSFER' });
    expect(normalizeTransaction(pierre({ amount: -110, type: 'CREDIT', category: 'Pagamento de cartão de crédito', description: 'Pagamento recebido' }))).toMatchObject({ amount: -110, direction: 'TRANSFER' });
    expect(normalizeTransaction(pierre({ account_type: 'BANK', amount: 110, type: 'CREDIT' }))).toMatchObject({ amount: 110, direction: 'TRANSFER' });
  });

  it('goes to review as an outgoing third-party transfer', () => {
    const c = classifyTransaction(card('pix', -110, '2026-09-15T03:00:00.000Z', null, { category_pierre: 'Transferências', description: 'Apmetecbentoquiri' }), []);
    expect(c).toMatchObject({ branch: 'THIRD_PARTY_OUTGOING', reviewStatus: 'Pendente Revisão', reviewReason: THIRD_PARTY_OUTGOING_REASON });
  });
});

describe('official bill storage', () => {
  it('normalizes Pierre bills and keeps known values when a later read omits them', () => {
    expect(normalizeBill({ id: 'b', accountId: 'card-1', dueDate: '2026-09-16T00:00:00.000Z', billClosingDate: null, totalAmount: '-8.49', totalAmountCurrencyCode: 'BRL', minimumPaymentAmount: '0.00', updatedAt: null })).toMatchObject({
      dueDate: '2026-09-16', closingDate: null, totalAmount: -8.49,
    });
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new Repository(db);
    const raw = { id: 'b', accountId: 'card-1', dueDate: '2026-09-16T00:00:00.000Z', billClosingDate: '2026-09-09T00:00:00.000Z', totalAmount: '0.00', totalAmountCurrencyCode: 'BRL', minimumPaymentAmount: '0.00', updatedAt: null };
    repo.upsertCardBills([normalizeBill(raw)]);
    repo.upsertCardBills([normalizeBill({ ...raw, billClosingDate: null, totalAmount: null })]);
    expect(db.prepare('SELECT closing_date, due_date, total_amount FROM card_bills').get()).toEqual({ closing_date: '2026-09-09', due_date: '2026-09-16', total_amount: 0 });
  });
});

// ---------------------------------------------------------------------------
// Reconcile: the open-bill page follows the bill when the bank closes it
// ---------------------------------------------------------------------------

function liveFrom(txs: SqliteTransactionRow[], c: ProjectionContext): LiveState {
  const p = projectNotionState(ACCOUNTS, txs, c);
  const billPage = (id: string) => `bill-page:${id}`;
  const transactions = new Map<string, LivePage[]>();
  for (const tx of p.transactions) {
    const relations: Record<string, string[]> = { ...tx.relations };
    if (tx.billStableId) relations['Fatura Vinculada'] = [billPage(tx.billStableId)];
    const props = serializePayloadForNotion('NOTION_DS_TRANSACTIONS', tx.payload, relations, true).notionProperties;
    transactions.set(tx.stableId, [{ pageId: `tx-page:${tx.stableId}`, canonical: canonicalizeLive('NOTION_DS_TRANSACTIONS', props), raw: props }]);
  }
  const bills = new Map<string, LivePage[]>();
  for (const b of p.bills) {
    const props = serializePayloadForNotion('NOTION_DS_CARD_BILLS', b.payload, { 'Cartão Vinculado': [b.cardPageId] }, true).notionProperties;
    bills.set(b.stableId, [{ pageId: billPage(b.stableId), canonical: canonicalizeLive('NOTION_DS_CARD_BILLS', props), raw: props }]);
  }
  return { transactions, bills, accounts: [] };
}
const noAccounts: AccountSourceContext = { rows: [], roles: {}, pageBySourceId: new Map() };

describe('reconcile — open bill page continuity', () => {
  const closedTxs = [
    ...HISTORY.slice(0, 2),
    card('p-open', -30, '2026-09-12T03:00:00.000Z', 'B-OCT'),
    card('p-late', -20, '2026-09-08T03:00:00.000Z', 'B-OCT'),
  ];

  it('adopts the open-bill page under the official bill id instead of creating a twin', () => {
    const live = liveFrom(HISTORY, ctx());
    const openPage = live.bills.get('nubank:cartao:2026-10:cycle')![0].pageId;
    const plan = reconcile(projectNotionState(ACCOUNTS, closedTxs, ctx({ today: '2026-10-12' })), closedTxs, [], live, noAccounts, { hmacKeyAvailable: true });
    expect(plan.billAdoptions).toEqual([{ stableId: 'nubank:bill:B-OCT', fromStableId: 'nubank:cartao:2026-10:cycle', pageId: openPage }]);
    expect(plan.billCreates).toEqual([]);
    const update = plan.billUpdates.find((u) => u.pageId === openPage)!;
    expect(update.payload).toMatchObject({ 'ID Estável da Fatura': 'nubank:bill:B-OCT', 'Tipo de Ciclo': 'Ciclo Real Banco', 'Status da Fatura': 'Fechada a Vencer', 'ID da Fatura na Fonte': 'B-OCT' });
    // The purchases already point to that page: nothing to relink, and nothing is zeroed as superseded.
    expect(plan.txUpdates.filter((u) => 'Fatura Vinculada' in u.relations)).toEqual([]);
    expect(plan.warnings.join()).not.toMatch(/SUPERSEDED_ESTIMATED_BILL/);
  });

  it('does not adopt when the purchases of the new bill sit on different pages', () => {
    const live = liveFrom(HISTORY, ctx());
    const late = live.transactions.get('p-late')![0];
    late.canonical = { ...late.canonical, 'Fatura Vinculada': ['bill-page:nubank:bill:B-SEP'] };
    const plan = reconcile(projectNotionState(ACCOUNTS, closedTxs, ctx({ today: '2026-10-12' })), closedTxs, [], live, noAccounts, { hmacKeyAvailable: true });
    expect(plan.billAdoptions).toEqual([]);
    expect(plan.billCreates.map((b) => b.stableId)).toEqual(['nubank:bill:B-OCT']);
  });

  it('keeps the review reason of an untouched pending charge in step with the source', () => {
    const pix = card('pix', -110, '2026-09-15T03:00:00.000Z', null, { category_pierre: 'Transferências', description: 'Apmetecbentoquiri' });
    const live = liveFrom([pix], ctx());
    const page = live.transactions.get('pix')![0];
    page.canonical = { ...page.canonical, 'Motivo da Revisão': THIRD_PARTY_INCOMING_REASON };
    const plan = reconcile(projectNotionState(ACCOUNTS, [pix], ctx()), [pix], [], live, noAccounts, { hmacKeyAvailable: true });
    expect(plan.txUpdates).toHaveLength(1);
    expect(plan.txUpdates[0].payload['Motivo da Revisão']).toBe(THIRD_PARTY_OUTGOING_REASON);
  });

  it('warns when the customized limit in Notion differs from the one the bank reports', () => {
    const cardPage = (limit: number) => {
      const raw = { Conta: { title: [{ text: { content: 'Nubank Cartão' } }] }, 'Limite personalizado': { number: limit }, 'Atualizado em': { date: { start: '2026-09-29', end: null } } };
      return { pageId: PAGES.cartao, name: 'Nubank Cartão', canonical: canonicalizeLive('NOTION_DS_ACCOUNTS', raw), raw };
    };
    const acc: AccountSourceContext = { rows: ACCOUNTS, roles: { 'card-1': 'CREDIT' }, pageBySourceId: new Map([['card-1', PAGES.cartao]]) };
    const run = (limit: number) => reconcile(projectNotionState(ACCOUNTS, [], ctx()), [], [], { transactions: new Map(), bills: new Map(), accounts: [cardPage(limit)] }, acc, { hmacKeyAvailable: true });
    expect(run(400).warnings.join()).toMatch(/LIMIT_DRIFT: o banco informa limite personalizado de R\$ 500.00/);
    const same = run(500);
    expect(same.warnings.join()).not.toMatch(/LIMIT_DRIFT/);
    expect(same.accountUpdates[0].payload['Limite Operacional Usado']).toBe(477.9);
  });
});
