import { calculateCanonicalFingerprint } from '../../domain/types';
import { generateCounterpartyPseudonym, getLastDayOfMonth, isValidIsoDate } from '../migration-runner/backfill-planner';
import {
  ClassificationBranch,
  NotionAccountRef,
  ProjectedBill,
  ProjectedTransaction,
  ProjectionContext,
  ProjectionResult,
  SqliteAccountRow,
  SqliteTransactionRow,
} from './types';

/**
 * Deterministic projection of the local SQLite history into the desired Notion state.
 *
 * This is a faithful port of the classification, card-cycle and payment-allocation logic of the frozen
 * backfill planner (src/notion/migration-runner/backfill-planner.ts, sections 6–11), so that pages created
 * by the incremental sync are indistinguishable from the ones the backfill created. The parity test
 * (tests/notion-sync-parity.test.ts) proves it reproduces the frozen 159-operation plan exactly.
 *
 * The one deliberate difference: the category table is keyed by the Pierre category alone. The planner keyed
 * it by `category_mapped || category_pierre`, where `category_mapped` came from the Google Sheets config tab;
 * the historical data has exactly one mapping per Pierre category, so both keys resolve identically, and the
 * sync no longer depends on the spreadsheet.
 */

/** Pierre category (lower-case) → canonical Notion category name. Mirrors the planner's homologated table. */
export const PIERRE_CATEGORY_TABLE: Record<string, string> = {
  'pagamento de cartão de crédito': 'Transferências internas',
  'transferência mesma titularidade': 'Transferências internas',
  internet: 'Moradia',
  doações: 'Presentes e doações',
  'serviços automotivos': 'Transporte',
  serviços: 'Serviços e assinaturas',
  compras: 'Compras',
  moradia: 'Moradia',
  'postos de gasolina': 'Transporte',
  'táxi e transporte privado urbano': 'Transporte',
  'alimentos e bebidas': 'Alimentação',
  outros: 'Outros',
  vestuário: 'Compras',
  supermercado: 'Alimentação',
  'bem-estar': 'Saúde',
  'impostos sobre operações financeiras': 'Impostos e taxas',
  'serviços digitais': 'Serviços e assinaturas',
};

/** Pierre categories the spreadsheet mapped to "(Transferência)" — the planner's transfer family. */
const TRANSFER_FAMILY = new Set(['pagamento de cartão de crédito', 'transferência mesma titularidade', 'transferências']);

export const THIRD_PARTY_INCOMING_REASON =
  'Transferência recebida de terceiro pendente de classificação econômica definitiva e comprovação documental';
export const THIRD_PARTY_OUTGOING_REASON =
  'Transferência enviada para terceiro pendente de classificação de categoria e efeito orçamentário';

function parseRaw(tx: SqliteTransactionRow): any {
  try {
    return JSON.parse(tx.raw_json || '{}');
  } catch {
    return {};
  }
}

const lower = (v: string | null | undefined) => (v || '').toLowerCase().trim();

function isPaymentTx(tx: SqliteTransactionRow): boolean {
  return tx.description.toLowerCase().includes('pagamento') || Boolean(tx.category_pierre && tx.category_pierre.toLowerCase().includes('pagamento'));
}

/** Card "purchase" as used to derive cycle windows (negative, not a payment). */
function isCyclePurchase(tx: SqliteTransactionRow): boolean {
  return (
    Number(tx.amount) < 0 &&
    !tx.description.toLowerCase().includes('pagamento') &&
    (!tx.category_pierre || !tx.category_pierre.toLowerCase().includes('pagamento'))
  );
}

function resolvePage(accounts: NotionAccountRef[], sourceId: string | undefined, name: string): NotionAccountRef | undefined {
  return (sourceId && accounts.find((a) => a.sourceId && a.sourceId === sourceId)) || accounts.find((a) => a.name === name);
}

function nextMonthDue(month: string, dueDay: number): string {
  const [y, m] = month.split('-').map(Number);
  let dueYear = y;
  let dueMonth = m + 1;
  if (dueMonth > 12) {
    dueMonth = 1;
    dueYear += 1;
  }
  const safeDay = Math.min(dueDay, getLastDayOfMonth(dueYear, dueMonth));
  return `${dueYear}-${String(dueMonth).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
}

interface Cycle {
  key: string;
  title: string;
  stableBillId: string;
  sourceBillId: string;
  inicio: string;
  fim: string;
  fechamento: string;
  vencimento: string | null;
  origem: 'UPSTREAM_BILL_ID' | 'PERIOD_ESTIMATED';
  qualidade: string;
  tipoCiclo: string;
  purchases: SqliteTransactionRow[];
  payments: string[];
}

function deriveCycles(creditTxs: SqliteTransactionRow[], cardName: string, defaultDueDay?: number): Map<string, Cycle> {
  const cycles = new Map<string, Cycle>();
  const upstreamBillIds = new Set<string>();
  const periodMonths = new Set<string>();

  for (const tx of creditTxs) {
    const bId = parseRaw(tx).credit_card_data?.billId;
    if (bId && typeof bId === 'string' && bId.trim().length > 0) upstreamBillIds.add(bId.trim());
    else if (isCyclePurchase(tx)) periodMonths.add(tx.date.substring(0, 7));
  }

  for (const bId of upstreamBillIds) {
    const txsInBill = creditTxs.filter((t) => parseRaw(t).credit_card_data?.billId === bId);
    const purchases = txsInBill.filter(isCyclePurchase);
    const sortedTxs = [...txsInBill].sort((a, b) => a.date.localeCompare(b.date));
    const minDate = (purchases[0] || sortedTxs[0]).date.substring(0, 10);
    const maxDate = (purchases[purchases.length - 1] || sortedTxs[sortedTxs.length - 1]).date.substring(0, 10);
    const month = maxDate.substring(0, 7);

    // Due date precedence: bill metadata → card account due day → configured default.
    let vencimento: string | null = null;
    for (const t of txsInBill) {
      const raw = parseRaw(t);
      const due = raw.bill_due_date || raw.credit_card_data?.bill_due_date;
      if (due && typeof due === 'string' && isValidIsoDate(due.substring(0, 10))) {
        vencimento = due.substring(0, 10);
        break;
      }
    }
    if (!vencimento) {
      let dueDay: number | null = null;
      for (const t of txsInBill) {
        const accDue = parseRaw(t).account_credit_data?.balanceDueDate;
        if (accDue && typeof accDue === 'string' && isValidIsoDate(accDue.substring(0, 10))) {
          dueDay = Number(accDue.substring(8, 10));
          break;
        }
      }
      if (dueDay === null && typeof defaultDueDay === 'number') dueDay = defaultDueDay;
      vencimento = dueDay !== null ? nextMonthDue(month, dueDay) : null;
    }
    if (!isValidIsoDate(minDate) || !isValidIsoDate(maxDate) || (vencimento !== null && !isValidIsoDate(vencimento))) {
      throw new Error(`FAIL_CLOSED_DATE_VALIDATION: Datas inválidas detectadas para fatura upstream ${bId}`);
    }
    const title =
      vencimento !== null
        ? `${cardName} - Ciclo ${month} (Venc ${vencimento.substring(8, 10)}/${vencimento.substring(5, 7)})`
        : `${cardName} - Ciclo ${month}`;
    cycles.set(`BILL_${bId}`, {
      key: `BILL_${bId}`,
      title,
      stableBillId: `nubank:bill:${bId}`,
      sourceBillId: bId,
      inicio: minDate,
      fim: maxDate,
      fechamento: maxDate,
      vencimento,
      origem: 'UPSTREAM_BILL_ID',
      qualidade: 'UPSTREAM_APPROXIMATE',
      tipoCiclo: 'Ciclo Real Banco',
      purchases: [],
      payments: [],
    });
  }

  for (const month of Array.from(periodMonths).sort()) {
    const txsInMonth = creditTxs.filter((t) => !parseRaw(t).credit_card_data?.billId && t.date.startsWith(month));
    const sortedPurchases = txsInMonth.filter(isCyclePurchase).sort((a, b) => a.date.localeCompare(b.date));
    const [y, m] = month.split('-').map(Number);
    const monthEnd = `${month}-${String(getLastDayOfMonth(y, m)).padStart(2, '0')}`;
    const minDate = sortedPurchases.length > 0 ? sortedPurchases[0].date.substring(0, 10) : `${month}-01`;
    const maxDate = sortedPurchases.length > 0 ? sortedPurchases[sortedPurchases.length - 1].date.substring(0, 10) : monthEnd;
    const fechamento = monthEnd;

    let vencimento: string | null = null;
    let title = `${cardName} - Ciclo ${month} Aberto`;
    if (typeof defaultDueDay === 'number') {
      vencimento = nextMonthDue(month, defaultDueDay);
      title = `${cardName} - Ciclo ${month} Aberto (Venc ${vencimento.substring(8, 10)}/${vencimento.substring(5, 7)})`;
    }
    if (!isValidIsoDate(minDate) || !isValidIsoDate(maxDate) || !isValidIsoDate(fechamento) || (vencimento !== null && !isValidIsoDate(vencimento))) {
      throw new Error(`FAIL_CLOSED_DATE_VALIDATION: Datas inválidas detectadas para ciclo de período ${month}`);
    }
    cycles.set(`PERIOD_${month}`, {
      key: `PERIOD_${month}`,
      title,
      stableBillId: `nubank:cartao:${month}:cycle`,
      sourceBillId: '',
      inicio: minDate,
      fim: maxDate,
      fechamento,
      vencimento,
      origem: 'PERIOD_ESTIMATED',
      qualidade: 'DERIVED',
      tipoCiclo: 'Ciclo Estimado',
      purchases: [],
      payments: [],
    });
  }
  return cycles;
}

const isBatchTimestamp = (date: string) => date.includes('03:00:00') || date.endsWith('03:00:00.000Z');

/** Pairs bank/card payment legs and allocates each payment event to a cycle (planner section 10). */
function allocatePayments(txs: SqliteTransactionRow[], cycles: Map<string, Cycle>): void {
  const bankPayments = txs.filter((t) => t.account_type === 'BANK' && isPaymentTx(t));
  const cardPayments = txs.filter((t) => t.account_type === 'CREDIT' && isPaymentTx(t));
  const pairedCardIds = new Set<string>();
  const events: Array<{ repId: string; amount: number; date: string; explicitBillId: string | null; isShadow: boolean }> = [];

  for (const b of bankPayments) {
    const bTime = new Date(b.date).getTime();
    const bAmt = Math.abs(Number(b.amount));
    const candidates = cardPayments.filter(
      (c) =>
        !pairedCardIds.has(c.id) &&
        Math.abs(Math.abs(Number(c.amount)) - bAmt) < 0.001 &&
        Math.abs(new Date(c.date).getTime() - bTime) <= 48 * 3600 * 1000,
    );
    let best: SqliteTransactionRow | null = null;
    if (candidates.length === 1) {
      best = candidates[0];
    } else if (candidates.length > 1) {
      const immediate = candidates.filter((c) => Math.abs(new Date(c.date).getTime() - bTime) < 10 * 60 * 1000 && !isBatchTimestamp(c.date));
      if (immediate.length === 1) {
        best = immediate[0];
      } else {
        let bestDiff = Infinity;
        for (const c of candidates) {
          const diff = Math.abs(new Date(c.date).getTime() - bTime);
          if (diff < bestDiff) {
            bestDiff = diff;
            best = c;
          }
        }
      }
    }
    if (best) {
      pairedCardIds.add(best.id);
      events.push({ repId: b.id, amount: bAmt, date: b.date, explicitBillId: parseRaw(best).credit_card_data?.billId || null, isShadow: false });
    } else {
      events.push({ repId: b.id, amount: bAmt, date: b.date, explicitBillId: null, isShadow: false });
    }
  }

  for (const c of cardPayments) {
    if (pairedCardIds.has(c.id)) continue;
    const cTime = new Date(c.date).getTime();
    const cAmt = Math.abs(Number(c.amount));
    const matchingReal =
      events.find((pe) => !pe.isShadow && Math.abs(pe.amount - cAmt) < 0.001 && Math.abs(new Date(pe.date).getTime() - cTime) <= 36 * 3600 * 1000) ||
      cardPayments.find(
        (o) =>
          o.id !== c.id &&
          !isBatchTimestamp(o.date) &&
          Math.abs(Math.abs(Number(o.amount)) - cAmt) < 0.001 &&
          Math.abs(new Date(o.date).getTime() - cTime) <= 36 * 3600 * 1000,
      );
    const isShadow = isBatchTimestamp(c.date) && Boolean(matchingReal);
    events.push({ repId: c.id, amount: cAmt, date: c.date, explicitBillId: isShadow ? null : parseRaw(c).credit_card_data?.billId || null, isShadow });
  }

  const all = Array.from(cycles.values());
  for (const event of events) {
    if (event.isShadow) continue;
    let target: Cycle | undefined;
    if (event.explicitBillId) {
      target = all.find((cy) => cy.sourceBillId === event.explicitBillId);
    } else {
      const pDate = event.date.substring(0, 10);
      let matching = all.filter((cy) => pDate >= cy.inicio && pDate <= (cy.vencimento || cy.fechamento));
      if (matching.length > 1) {
        const periodOnly = matching.filter((cy) => cy.origem === 'PERIOD_ESTIMATED');
        if (periodOnly.length > 0) matching = periodOnly;
      }
      if (matching.length === 1) target = matching[0];
    }
    if (target) target.payments.push(event.repId);
  }
}

export interface ClassificationResult {
  economicNature: string | null;
  budgetEffect: string | null;
  reviewStatus: 'Confirmado Auto' | 'Pendente Revisão';
  reviewReason: string | null;
  categoryName: string | null;
  branch: ClassificationBranch;
}

/** The planner's six mutually exclusive classification branches (section 9.2). */
export function classifyTransaction(tx: SqliteTransactionRow, sameOwnershipKeywords: string[]): ClassificationResult {
  const raw = parseRaw(tx);
  const amount = Number(tx.amount);
  const isCredit = tx.account_type === 'CREDIT';
  const isPayment = isPaymentTx(tx);
  const descLower = tx.description.trim().toLowerCase();
  const pierreLower = lower(tx.category_pierre);
  const rawCatLower = lower(raw.category as string);
  const canonical = PIERRE_CATEGORY_TABLE[pierreLower] ?? null;
  const isSameOwnership =
    pierreLower.includes('mesma titularidade') ||
    rawCatLower.includes('mesma titularidade') ||
    sameOwnershipKeywords.some((k) => pierreLower.includes(k) || rawCatLower.includes(k));

  if (amount > 0 && !isSameOwnership) {
    return { economicNature: null, budgetEffect: null, reviewStatus: 'Pendente Revisão', reviewReason: THIRD_PARTY_INCOMING_REASON, categoryName: null, branch: 'THIRD_PARTY_INCOMING' };
  }
  if (amount > 0 && isSameOwnership) {
    return { economicNature: 'Transferência interna', budgetEffect: 'Neutro', reviewStatus: 'Confirmado Auto', reviewReason: null, categoryName: canonical, branch: 'SAME_OWNERSHIP_INCOMING' };
  }
  if (amount < 0 && isPayment) {
    return { economicNature: 'Pagamento de fatura', budgetEffect: 'Neutro', reviewStatus: 'Confirmado Auto', reviewReason: null, categoryName: canonical, branch: 'CARD_BILL_PAYMENT' };
  }
  if (amount < 0 && isSameOwnership) {
    return { economicNature: 'Transferência interna', budgetEffect: 'Neutro', reviewStatus: 'Confirmado Auto', reviewReason: null, categoryName: canonical, branch: 'SAME_OWNERSHIP_OUTGOING' };
  }
  if (
    amount < 0 &&
    !isCredit &&
    (pierreLower === 'transferências' || (TRANSFER_FAMILY.has(pierreLower) && descLower.startsWith('transferência enviada')))
  ) {
    return { economicNature: null, budgetEffect: null, reviewStatus: 'Pendente Revisão', reviewReason: THIRD_PARTY_OUTGOING_REASON, categoryName: null, branch: 'THIRD_PARTY_OUTGOING' };
  }
  if (canonical) {
    return { economicNature: 'Despesa', budgetEffect: 'Despesa', reviewStatus: 'Confirmado Auto', reviewReason: null, categoryName: canonical, branch: 'STANDARD_EXPENSE' };
  }
  return {
    economicNature: null,
    budgetEffect: null,
    reviewStatus: 'Pendente Revisão',
    reviewReason: `UNRESOLVED_CATEGORY: Categoria do Pierre sem mapeamento homologado (${tx.category_pierre ?? ''})`,
    categoryName: null,
    branch: 'UNRESOLVED_CATEGORY',
  };
}

/**
 * Projects every SQLite transaction (ordered by date ASC, id ASC, as the planner did) and every card cycle.
 * Pure: no I/O, no clock.
 */
export function projectNotionState(
  accounts: SqliteAccountRow[],
  transactions: SqliteTransactionRow[],
  ctx: ProjectionContext,
): ProjectionResult {
  // Binary ordering, identical to the planner's `ORDER BY date ASC, id ASC`.
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const txs = [...transactions].sort((a, b) => cmp(a.date, b.date) || cmp(a.id, b.id));

  // Account resolution (planner section 6): mapped role + matching source type → Notion account page.
  const creditIds = Object.entries(ctx.accountRoles).filter(([, r]) => r === 'CREDIT').map(([id]) => id);
  const checkingIds = Object.entries(ctx.accountRoles).filter(([, r]) => r === 'CHECKING').map(([id]) => id);
  if (creditIds.length > 1 || checkingIds.length > 1) {
    throw new Error('FAIL_CLOSED_ACCOUNT_MAPPING: Mais de uma conta por papel (CHECKING/CREDIT) ainda não é suportado pela sincronização.');
  }
  const cardPage = resolvePage(ctx.notionAccounts, creditIds[0], ctx.creditAccountName);
  const checkingPage = resolvePage(ctx.notionAccounts, checkingIds[0], ctx.checkingAccountName);
  if (!cardPage || !checkingPage) {
    throw new Error(
      `FAIL_CLOSED_ACCOUNT_MAPPING: Páginas de conta não encontradas no Notion (${ctx.checkingAccountName} / ${ctx.creditAccountName}).`,
    );
  }
  const accountPageById = new Map<string, string>();
  for (const acc of accounts) {
    const role = ctx.accountRoles[acc.id];
    if (role === 'CHECKING' && acc.type === 'BANK') accountPageById.set(acc.id, checkingPage.id);
    else if (role === 'CREDIT' && acc.type === 'CREDIT') accountPageById.set(acc.id, cardPage.id);
  }

  const cycles = deriveCycles(txs.filter((t) => t.account_type === 'CREDIT'), cardPage.name, ctx.defaultDueDay);

  const projected: ProjectedTransaction[] = [];
  const unresolved = new Set<string>();
  for (const tx of txs) {
    const raw = parseRaw(tx);
    const amount = Number(tx.amount);
    const isCredit = tx.account_type === 'CREDIT';
    const isPurchase = isCredit && !isPaymentTx(tx);
    const accountPageId = accountPageById.get(tx.account_id) ?? null;
    if (!accountPageId) unresolved.add(tx.account_id);

    const desc = tx.description.trim();
    const counterpartyName = desc.includes('|') ? desc.split('|')[1].trim() : desc;
    const cls = classifyTransaction(tx, ctx.sameOwnershipKeywords);
    const categoryPageId = cls.categoryName ? ctx.categoryIdByName.get(cls.categoryName.toLowerCase().trim()) || '' : '';

    let billStableId: string | null = null;
    if (isCredit) {
      const upstreamBillId = raw.credit_card_data?.billId;
      const cycle = cycles.get(upstreamBillId ? `BILL_${upstreamBillId}` : `PERIOD_${tx.date.substring(0, 7)}`);
      if (cycle) {
        billStableId = cycle.stableBillId;
        if (isPurchase) cycle.purchases.push(tx);
      }
    }

    const payload: Record<string, any> = {
      Lançamento: desc,
      Fonte: 'Pierre',
      'ID da fonte': tx.id,
      Moeda: 'BRL',
      'Hash Canônico': calculateCanonicalFingerprint({
        source: 'PIERRE',
        sourceAccountId: tx.account_id,
        sourceTransactionId: tx.id,
        amountMinor: BigInt(Math.round(amount * 100)),
        currency: 'BRL',
        scale: 2,
        dateIso: tx.date,
        status: (tx.status || 'CONFIRMED').toUpperCase(),
        description: tx.description,
        rawCategory: tx.category_mapped || tx.category_pierre || '',
        direction: tx.direction,
      }),
      Data: { start: tx.date.substring(0, 10), end: null },
      Valor: Math.abs(amount),
      'Valor Bruto da Fonte': amount,
      Movimento: amount > 0 ? 'Entrada' : 'Saída',
      Natureza: cls.economicNature,
      'Efeito Orçamentário': cls.budgetEffect,
      'Propósito de Alocação': 'Caixa Operacional',
      'Contribuição Meta Poupança': 0,
      Status: tx.status === 'POSTED' ? 'Confirmado' : 'Pendente',
      'Status de Revisão': cls.reviewStatus,
      'Motivo da Revisão': cls.reviewReason || '',
      'Categoria Pierre': tx.category_pierre || '',
      'Descrição original': tx.description,
      'HMAC Contraparte': generateCounterpartyPseudonym(counterpartyName, ctx.hmacKey, ctx.hmacKeyVersion),
    };

    const relations: Record<string, string[]> = {
      Conta: accountPageId ? [accountPageId] : [],
      Categoria: categoryPageId ? [categoryPageId] : [],
    };

    projected.push({
      stableId: tx.id,
      payload,
      relations,
      billStableId: isPurchase ? billStableId : null,
      branch: cls.branch,
      counterpartyName,
      accountPageId,
    });
  }

  allocatePayments(txs, cycles);

  const bills: ProjectedBill[] = [];
  const txById = new Map(txs.map((t) => [t.id, t]));
  for (const cycle of cycles.values()) {
    const purchasesTotal = Math.round(cycle.purchases.reduce((s, p) => s + Math.abs(Number(p.amount)), 0) * 100) / 100;
    const paid = Math.round(cycle.payments.reduce((s, id) => s + Math.abs(Number(txById.get(id)?.amount ?? 0)), 0) * 100) / 100;
    bills.push({
      stableId: cycle.stableBillId,
      cardPageId: cardPage.id,
      purchaseIds: cycle.purchases.map((p) => p.id),
      paymentIds: [...cycle.payments],
      payload: {
        'Fatura / Ciclo': cycle.title,
        Fonte: 'Pierre',
        'ID da Fatura na Fonte': cycle.sourceBillId,
        'ID Estável da Fatura': cycle.stableBillId,
        'Qualidade da Identidade': cycle.origem === 'UPSTREAM_BILL_ID' ? 'SOURCE_ID' : 'PERIOD_FALLBACK',
        Moeda: 'BRL',
        'Início do Período': { start: cycle.inicio, end: null },
        'Fim do Período': { start: cycle.fim, end: null },
        'Data de Fechamento': { start: cycle.fechamento, end: null },
        'Data de Vencimento': cycle.vencimento ? { start: cycle.vencimento, end: null } : null,
        'Tipo de Ciclo': cycle.tipoCiclo,
        'Origem / Qualidade dos Dados': cycle.qualidade,
        'Status da Fatura': null,
        'Valor da Fatura Fechada (Oficial)': null,
        'Valor Estimado da Fatura Aberta': null,
        'Total de Compras no Ciclo': purchasesTotal,
        'Componentes Adicionais da Fatura': null,
        'Divergência Não Explicada': null,
        'Valor Pago': paid,
        'Data de Liquidação': null,
      },
    });
  }

  return { transactions: projected, bills, unresolvedAccountIds: Array.from(unresolved) };
}
