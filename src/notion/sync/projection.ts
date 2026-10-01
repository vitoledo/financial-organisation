import { calculateCanonicalFingerprint } from '../../domain/types';
import { generateCounterpartyPseudonym, getLastDayOfMonth, isValidIsoDate } from '../migration-runner/backfill-planner';
import {
  ClassificationBranch,
  NotionAccountRef,
  OfficialBill,
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

/**
 * Card bill payment: Pierre's own category, or the bank's fixed descriptions ("Pagamento de fatura" on the
 * account, "Pagamento recebido" on the card). The planner matched "pagamento" anywhere in the description,
 * which also caught Pix to payment institutions ("… Instituição de Pagamento", "Nu Pagamentos"); every
 * payment in the migrated history matches this narrower test, so the frozen plan is unchanged.
 */
function isPaymentTx(tx: SqliteTransactionRow): boolean {
  const desc = lower(tx.description);
  return (
    lower(tx.category_pierre) === 'pagamento de cartão de crédito' ||
    desc.startsWith('pagamento de fatura') ||
    desc.startsWith('pagamento recebido')
  );
}

/** Card "purchase" as used to derive cycle windows (negative, not a payment). */
function isCyclePurchase(tx: SqliteTransactionRow): boolean {
  return Number(tx.amount) < 0 && !isPaymentTx(tx);
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
  /** Statement balance the bank reported for this bill (GET /get-bills), when known. */
  officialAmount: number | null;
}

/**
 * The bank's own calendar for the card, from the official bills: the latest known closing and due dates.
 * Later closings are projected by keeping the day of the month (the bank moves both together).
 */
interface CardAnchor {
  bills: Map<string, OfficialBill>;
  /** Official bills with a closing date, oldest first. */
  closings: OfficialBill[];
  lastClosing: string;
  lastDue: string | null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().substring(0, 10);
}

/** Same day of the month `months` later, clamped to the month's last day. */
function addMonthsKeepDay(iso: string, months: number): string {
  const [y, m, day] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const safeDay = Math.min(day, getLastDayOfMonth(ny, nm));
  return `${ny}-${String(nm).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
}

function buildAnchor(official: OfficialBill[] | undefined, cardAccountId: string | undefined): CardAnchor | null {
  const mine = (official ?? []).filter((b) => !cardAccountId || b.accountId === cardAccountId);
  const closings = mine.filter((b) => b.closingDate && isValidIsoDate(b.closingDate)).sort((a, b) => a.closingDate!.localeCompare(b.closingDate!));
  if (closings.length === 0) return null;
  const last = closings[closings.length - 1];
  return {
    bills: new Map(mine.map((b) => [b.id, b])),
    closings,
    lastClosing: last.closingDate!,
    lastDue: last.dueDate && isValidIsoDate(last.dueDate) ? last.dueDate : null,
  };
}

/** Index (k ≥ 1) of the projected closing after the last official one that a date falls into. */
function projectedCycleIndex(anchor: CardAnchor, day: string): number {
  let k = 1;
  while (addMonthsKeepDay(anchor.lastClosing, k) < day && k < 240) k++;
  return k;
}

const titleFor = (cardName: string, month: string, vencimento: string | null, open: boolean) =>
  `${cardName} - Ciclo ${month}${open ? ' Aberto' : ''}${vencimento ? ` (Venc ${vencimento.substring(8, 10)}/${vencimento.substring(5, 7)})` : ''}`;

/**
 * Builds the card cycles and returns, for each credit transaction, the cycle key it belongs to.
 *
 * Without official bills this is the planner's logic (cycles by upstream bill id, pending purchases grouped
 * by calendar month), which the parity test pins. With official bills (`anchor`):
 * - a bill the bank reported takes its closing and due dates from the bank, and its period runs from the
 *   previous official closing (+1 day) to its own closing;
 * - a bill id the bank has not reported yet (closed, not yet due) and pending purchases are placed on the
 *   bank's projected calendar. A pending purchase always belongs to an open bill: a closed bill's content is
 *   final, and a purchase still pending at closing is billed on the next one.
 */
function deriveCycles(
  creditTxs: SqliteTransactionRow[],
  cardName: string,
  defaultDueDay: number | undefined,
  anchor: CardAnchor | null,
): { cycles: Map<string, Cycle>; keyFor: (tx: SqliteTransactionRow) => string } {
  const cycles = new Map<string, Cycle>();
  const upstreamBillIds = new Set<string>();
  const periodMonths = new Set<string>();
  const billIdOf = (tx: SqliteTransactionRow): string | null => {
    const bId = parseRaw(tx).credit_card_data?.billId;
    return bId && typeof bId === 'string' && bId.trim().length > 0 ? bId.trim() : null;
  };

  for (const tx of creditTxs) {
    const bId = billIdOf(tx);
    if (bId) upstreamBillIds.add(bId);
    else if (isCyclePurchase(tx)) periodMonths.add(tx.date.substring(0, 7));
  }

  // Projected calendar slot k (≥ 1) → the cycle key that represents it (a not-yet-reported bill id, or a period).
  const slotKey = new Map<number, string>();

  for (const bId of upstreamBillIds) {
    const txsInBill = creditTxs.filter((t) => billIdOf(t) === bId);
    const purchases = txsInBill.filter(isCyclePurchase);
    const sortedTxs = [...txsInBill].sort((a, b) => a.date.localeCompare(b.date));
    const minDate = (purchases[0] || sortedTxs[0]).date.substring(0, 10);
    const maxDate = (purchases[purchases.length - 1] || sortedTxs[sortedTxs.length - 1]).date.substring(0, 10);
    let month = maxDate.substring(0, 7);

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

    let inicio = minDate;
    let fim = maxDate;
    let fechamento = maxDate;
    let qualidade = 'UPSTREAM_APPROXIMATE';
    let officialAmount: number | null = null;
    const ob = anchor?.bills.get(bId);
    if (anchor && ob) {
      if (ob.closingDate && isValidIsoDate(ob.closingDate)) {
        fechamento = ob.closingDate;
        const prev = anchor.closings.filter((b) => b.closingDate! < fechamento).pop();
        inicio = prev ? addDays(prev.closingDate!, 1) : minDate;
        fim = fechamento;
        month = fechamento.substring(0, 7);
      }
      if (ob.dueDate && isValidIsoDate(ob.dueDate)) vencimento = ob.dueDate;
      qualidade = 'UPSTREAM_OFFICIAL';
      officialAmount = ob.totalAmount;
    } else if (anchor && maxDate > anchor.lastClosing) {
      // Closed or open at the bank but not reported yet: the bank's projected calendar.
      const k = projectedCycleIndex(anchor, maxDate);
      fechamento = addMonthsKeepDay(anchor.lastClosing, k);
      inicio = addDays(addMonthsKeepDay(anchor.lastClosing, k - 1), 1);
      fim = fechamento;
      month = fechamento.substring(0, 7);
      if (anchor.lastDue) vencimento = addMonthsKeepDay(anchor.lastDue, k);
      if (!slotKey.has(k)) slotKey.set(k, `BILL_${bId}`);
    }

    cycles.set(`BILL_${bId}`, {
      key: `BILL_${bId}`,
      title: titleFor(cardName, month, vencimento, false),
      stableBillId: `nubank:bill:${bId}`,
      sourceBillId: bId,
      inicio,
      fim,
      fechamento,
      vencimento,
      origem: 'UPSTREAM_BILL_ID',
      qualidade,
      tipoCiclo: 'Ciclo Real Banco',
      purchases: [],
      payments: [],
      officialAmount,
    });
  }

  if (!anchor) {
    for (const month of Array.from(periodMonths).sort()) {
      const txsInMonth = creditTxs.filter((t) => !billIdOf(t) && t.date.startsWith(month));
      const sortedPurchases = txsInMonth.filter(isCyclePurchase).sort((a, b) => a.date.localeCompare(b.date));
      const [y, m] = month.split('-').map(Number);
      const monthEnd = `${month}-${String(getLastDayOfMonth(y, m)).padStart(2, '0')}`;
      const minDate = sortedPurchases.length > 0 ? sortedPurchases[0].date.substring(0, 10) : `${month}-01`;
      const maxDate = sortedPurchases.length > 0 ? sortedPurchases[sortedPurchases.length - 1].date.substring(0, 10) : monthEnd;
      const fechamento = monthEnd;

      let vencimento: string | null = null;
      if (typeof defaultDueDay === 'number') vencimento = nextMonthDue(month, defaultDueDay);
      if (!isValidIsoDate(minDate) || !isValidIsoDate(maxDate) || !isValidIsoDate(fechamento) || (vencimento !== null && !isValidIsoDate(vencimento))) {
        throw new Error(`FAIL_CLOSED_DATE_VALIDATION: Datas inválidas detectadas para ciclo de período ${month}`);
      }
      cycles.set(`PERIOD_${month}`, {
        key: `PERIOD_${month}`,
        title: titleFor(cardName, month, vencimento, true),
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
        officialAmount: null,
      });
    }
    return {
      cycles,
      keyFor: (tx) => {
        const bId = billIdOf(tx);
        return bId ? `BILL_${bId}` : `PERIOD_${tx.date.substring(0, 7)}`;
      },
    };
  }

  // Anchored: pending purchases go to the open slot of their date (never to a closed bill), sharing it with
  // an upstream bill id already placed on that slot.
  const pendingSlot = (tx: SqliteTransactionRow) => projectedCycleIndex(anchor, tx.date.substring(0, 10));
  for (const tx of creditTxs) {
    if (billIdOf(tx) || !isCyclePurchase(tx)) continue;
    const k = pendingSlot(tx);
    if (slotKey.has(k)) continue;
    const fechamento = addMonthsKeepDay(anchor.lastClosing, k);
    const month = fechamento.substring(0, 7);
    const vencimento = anchor.lastDue
      ? addMonthsKeepDay(anchor.lastDue, k)
      : typeof defaultDueDay === 'number'
        ? nextMonthDue(addMonthsKeepDay(anchor.lastClosing, k - 1).substring(0, 7), defaultDueDay)
        : null;
    const key = `PERIOD_${month}`;
    slotKey.set(k, key);
    cycles.set(key, {
      key,
      title: titleFor(cardName, month, vencimento, true),
      stableBillId: `nubank:cartao:${month}:cycle`,
      sourceBillId: '',
      inicio: addDays(addMonthsKeepDay(anchor.lastClosing, k - 1), 1),
      fim: fechamento,
      fechamento,
      vencimento,
      origem: 'PERIOD_ESTIMATED',
      qualidade: 'DERIVED',
      tipoCiclo: 'Ciclo Estimado',
      purchases: [],
      payments: [],
      officialAmount: null,
    });
  }
  return {
    cycles,
    keyFor: (tx) => {
      const bId = billIdOf(tx);
      if (bId) return `BILL_${bId}`;
      return slotKey.get(pendingSlot(tx)) ?? `PERIOD_${tx.date.substring(0, 7)}`;
    },
  };
}

/** Bill status (REGRA_AUTOMATICA) from the bank's dates and amounts; null when there is no evidence. */
function billStatus(cycle: Cycle, today: string | undefined, settledAfterClosing: number): string | null {
  if (!today) return null;
  if (cycle.qualidade === 'UPSTREAM_OFFICIAL' && cycle.officialAmount !== null) {
    if (cycle.officialAmount <= 0.005) return 'Paga Integralmente';
    if (cycle.vencimento && today <= cycle.vencimento) return 'Fechada a Vencer';
    if (settledAfterClosing >= cycle.officialAmount - 0.005) return 'Paga Integralmente';
    return settledAfterClosing > 0 ? 'Paga Parcialmente' : 'Vencida';
  }
  if (today <= cycle.fechamento) return 'Aberta em Curso';
  if (cycle.vencimento && today <= cycle.vencimento) return 'Fechada a Vencer';
  return null;
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
    (pierreLower === 'transferências'
      ? true // on the account a Pix sent; on the card a Pix paid with credit
      : !isCredit && TRANSFER_FAMILY.has(pierreLower) && descLower.startsWith('transferência enviada'))
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

  const anchor = buildAnchor(ctx.officialBills, creditIds[0]);
  const { cycles, keyFor } = deriveCycles(txs.filter((t) => t.account_type === 'CREDIT'), cardPage.name, ctx.defaultDueDay, anchor);

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
      const cycle = cycles.get(keyFor(tx));
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
  // The card balance Pierre reports is the bank's own figure for the open bill.
  const cardRow = accounts.find((a) => a.id === creditIds[0]);
  let openBillAmount: number | null = null;
  try {
    const balance = cardRow?.raw_json ? Number(JSON.parse(cardRow.raw_json).balance) : NaN;
    if (Number.isFinite(balance)) openBillAmount = Math.round(balance * 100) / 100;
  } catch {
    openBillAmount = null;
  }
  const bankPayments = txs.filter((t) => t.account_type === 'BANK' && isPaymentTx(t) && Number(t.amount) < 0);
  for (const cycle of cycles.values()) {
    const purchasesTotal = Math.round(cycle.purchases.reduce((s, p) => s + Math.abs(Number(p.amount)), 0) * 100) / 100;
    const paid = Math.round(cycle.payments.reduce((s, id) => s + Math.abs(Number(txById.get(id)?.amount ?? 0)), 0) * 100) / 100;
    let status: string | null = null;
    let openEstimate: number | null = null;
    if (anchor) {
      // Payments from the account after the closing, up to a few days past the due date, settle the statement.
      const settleUntil = cycle.vencimento ? addDays(cycle.vencimento, 5) : cycle.fechamento;
      const settled = bankPayments
        .filter((t) => t.date.substring(0, 10) > cycle.fechamento && t.date.substring(0, 10) <= settleUntil)
        .reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0);
      status = billStatus(cycle, ctx.today, Math.round(settled * 100) / 100);
      const isCurrent = ctx.today !== undefined && cycle.inicio <= ctx.today && ctx.today <= cycle.fechamento;
      if (isCurrent && cycle.qualidade !== 'UPSTREAM_OFFICIAL') openEstimate = openBillAmount;
    }
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
        'Status da Fatura': status,
        'Valor da Fatura Fechada (Oficial)': cycle.officialAmount,
        'Valor Estimado da Fatura Aberta': openEstimate,
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
