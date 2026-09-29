import { canonicalizePropertyValue, findPropertyContract } from '../migration-runner/backfill-serializer';
import { applyRuleToProjection, findMatchingRule, ruleOutcome } from './rules';
import {
  AccountRole,
  ClassificationRule,
  LivePage,
  ProjectedBill,
  ProjectedTransaction,
  ProjectionResult,
  SqliteAccountRow,
  SqliteTransactionRow,
} from './types';

/**
 * Ownership-aware diff between the projected state and the live Notion pages (pure, no I/O).
 *
 * Transactions
 *  - created with the full projection (+ a matching classification rule, if any);
 *  - on existing pages only UPSTREAM/DERIVADO fields are patched (Data, Valor, Status, Categoria Pierre, Conta,
 *    Fatura Vinculada, Hash Canônico, …) — never the title, the classification or user fields (Revisado,
 *    Observações, Conta no orçamento, …);
 *  - an existing page is re-classified only while it is untouched and pending review (Status de Revisão =
 *    "Pendente Revisão", Revisado unchecked, no Natureza/Efeito/Categoria) and a rule now matches it.
 * Card bills: derived/upstream fields are refreshed; null projections never overwrite what a person filled in
 *  (Status da Fatura, valor oficial, liquidação, …). "Lançamentos do Ciclo" is maintained from the transaction
 *  side (dual relation "Fatura Vinculada").
 * Accounts: balances/limits are refreshed only when the source snapshot is at least as recent as the page's
 *  "Atualizado em", so an old local database can never regress newer values.
 * Nothing is ever deleted or archived.
 */

export const TX_ENV = 'NOTION_DS_TRANSACTIONS';
export const BILL_ENV = 'NOTION_DS_CARD_BILLS';
export const ACCOUNT_ENV = 'NOTION_DS_ACCOUNTS';

/** UPSTREAM + DERIVADO scalar fields the sync keeps in step with the source on existing pages. */
export const TX_SOURCE_FIELDS = [
  'Fonte',
  'ID da fonte',
  'Moeda',
  'Data',
  'Valor',
  'Valor Bruto da Fonte',
  'Movimento',
  'Status',
  'Categoria Pierre',
  'Descrição original',
  'Hash Canônico',
];
export const BILL_MANAGED_FIELDS = [
  'Fatura / Ciclo',
  'Fonte',
  'ID da Fatura na Fonte',
  'Qualidade da Identidade',
  'Moeda',
  'Início do Período',
  'Fim do Período',
  'Data de Fechamento',
  'Data de Vencimento',
  'Tipo de Ciclo',
  'Origem / Qualidade dos Dados',
  'Total de Compras no Ciclo',
  'Valor Pago',
];

/** Relation target that may not exist yet: resolved to a page id at apply time. */
export type RefTarget = { kind: 'page'; id: string } | { kind: 'tx'; stableId: string } | { kind: 'bill'; stableId: string };

export interface PlannedCreate {
  stableId: string;
  payload: Record<string, any>;
  relations: Record<string, RefTarget[]>;
  rule?: string;
}

export interface PlannedUpdate {
  stableId: string;
  pageId: string;
  kind: 'SOURCE' | 'RECLASSIFY';
  payload: Record<string, any>;
  relations: Record<string, RefTarget[]>;
  fields: string[];
  rule?: string;
}

export interface PlannedBillUpdate {
  stableId: string;
  /** Existing page id, or null when the bill is created in this same run. */
  pageId: string | null;
  payload: Record<string, any>;
  relations: Record<string, RefTarget[]>;
  fields: string[];
}

export interface PlannedAccountUpdate {
  pageId: string;
  name: string;
  payload: Record<string, any>;
  fields: string[];
}

export interface SyncPlan {
  billCreates: PlannedCreate[];
  txCreates: PlannedCreate[];
  txUpdates: PlannedUpdate[];
  billUpdates: PlannedBillUpdate[];
  accountUpdates: PlannedAccountUpdate[];
  fatal: string[];
  warnings: string[];
  stats: {
    projectedTransactions: number;
    projectedBills: number;
    unchangedTransactions: number;
    reclassified: number;
  };
}

export interface LiveState {
  transactions: Map<string, LivePage[]>;
  bills: Map<string, LivePage[]>;
  accounts: Array<LivePage & { name: string }>;
}

export interface AccountSourceContext {
  rows: SqliteAccountRow[];
  roles: Record<string, AccountRole>;
  /** Pierre account id → Notion account page id (same resolution as the projection). */
  pageBySourceId: Map<string, string>;
}

export interface ReconcileOptions {
  /** Without the HMAC key the projection holds "[OFUSCADO]", which must never overwrite a real pseudonym. */
  hmacKeyAvailable: boolean;
}

function canonicalValue(envKey: string, physical: string, value: any): any {
  if (value === null || value === undefined) return null;
  const contract = findPropertyContract(envKey, physical);
  if (!contract) throw new Error(`FAIL_UNKNOWN_PROPERTY: '${physical}' não está no contrato de ${envKey}.`);
  return canonicalizePropertyValue(contract, value);
}

function liveValue(envKey: string, physical: string, live: LivePage): any {
  const contract = findPropertyContract(envKey, physical);
  if (!contract) throw new Error(`FAIL_UNKNOWN_PROPERTY: '${physical}' não está no contrato de ${envKey}.`);
  const v = live.canonical[contract.notionProperty];
  if (contract.notionType === 'relation') return Array.isArray(v) ? [...v].sort() : [];
  return v === undefined ? null : v;
}

const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

function rawCheckbox(live: LivePage, name: string): boolean {
  return Boolean(live.raw?.[name]?.checkbox);
}

/** A pending page nobody has touched yet — the only kind of existing page a rule may re-classify. */
export function isUntouchedPending(live: LivePage): boolean {
  return (
    liveValue(TX_ENV, 'Status de Revisão', live) === 'Pendente Revisão' &&
    !rawCheckbox(live, 'Revisado') &&
    liveValue(TX_ENV, 'Natureza', live) === null &&
    liveValue(TX_ENV, 'Efeito Orçamentário', live) === null &&
    liveValue(TX_ENV, 'Categoria', live).length === 0
  );
}

const pageRefs = (ids: string[]): RefTarget[] => ids.map((id) => ({ kind: 'page', id }));

function reconcileTransactions(
  projection: ProjectionResult,
  rows: Map<string, SqliteTransactionRow>,
  rules: ClassificationRule[],
  live: LiveState,
  options: ReconcileOptions,
  plan: SyncPlan,
): void {
  const sourceFields = options.hmacKeyAvailable ? [...TX_SOURCE_FIELDS, 'HMAC Contraparte'] : TX_SOURCE_FIELDS;

  for (const base of projection.transactions) {
    const row = rows.get(base.stableId)!;
    const pages = live.transactions.get(base.stableId) ?? [];
    if (pages.length > 1) {
      plan.fatal.push(`DUPLICATE_STABLE_ID: ${pages.length} páginas em Transações com ID da fonte ${base.stableId}.`);
      continue;
    }

    if (pages.length === 0) {
      const { projected, rule } = applyRuleToProjection(rules, row, base);
      const payload = options.hmacKeyAvailable ? projected.payload : { ...projected.payload, 'HMAC Contraparte': null };
      const relations: Record<string, RefTarget[]> = {};
      for (const [k, ids] of Object.entries(projected.relations)) if (ids.length > 0) relations[k] = pageRefs(ids);
      if (projected.billStableId) relations['Fatura Vinculada'] = [{ kind: 'bill', stableId: projected.billStableId }];
      plan.txCreates.push({ stableId: base.stableId, payload, relations, rule: rule?.name });
      continue;
    }

    const page = pages[0];
    const payload: Record<string, any> = {};
    const relations: Record<string, RefTarget[]> = {};
    const fields: string[] = [];

    for (const f of sourceFields) {
      const desired = canonicalValue(TX_ENV, f, base.payload[f]);
      if (desired === null) continue;
      if (!same(desired, liveValue(TX_ENV, f, page))) {
        payload[f] = base.payload[f];
        fields.push(f);
      }
    }
    const desiredConta = base.relations['Conta'] ?? [];
    if (desiredConta.length > 0 && !same([...desiredConta].sort(), liveValue(TX_ENV, 'Conta', page))) {
      relations['Conta'] = pageRefs(desiredConta);
      fields.push('Conta');
    }
    const liveBill = liveValue(TX_ENV, 'Fatura Vinculada', page) as string[];
    if (base.billStableId) {
      const livePageForBill = live.bills.get(base.billStableId)?.[0]?.pageId;
      if (!livePageForBill || !same([livePageForBill], liveBill)) {
        relations['Fatura Vinculada'] = [{ kind: 'bill', stableId: base.billStableId }];
        fields.push('Fatura Vinculada');
      }
    } else if (liveBill.length > 0) {
      plan.warnings.push(`KEEP_BILL_LINK: ${base.stableId} tem Fatura Vinculada no Notion, mas a projeção não o associa a um ciclo; vínculo mantido.`);
    }

    let kind: PlannedUpdate['kind'] = 'SOURCE';
    let ruleName: string | undefined;
    if (isUntouchedPending(page)) {
      const rule = findMatchingRule(rules, row, base.accountPageId);
      if (rule) {
        const outcome = ruleOutcome(rule, base);
        for (const [k, v] of Object.entries(outcome.fields)) {
          payload[k] = v;
          fields.push(k);
        }
        for (const [k, ids] of Object.entries(outcome.relations)) {
          relations[k] = pageRefs(ids);
          fields.push(k);
        }
        kind = 'RECLASSIFY';
        ruleName = rule.name;
        plan.stats.reclassified++;
      }
    }

    if (fields.length === 0) {
      plan.stats.unchangedTransactions++;
    } else {
      plan.txUpdates.push({ stableId: base.stableId, pageId: page.pageId, kind, payload, relations, fields, rule: ruleName });
    }
  }
}

function reconcileBills(projection: ProjectionResult, live: LiveState, txPageId: Map<string, string>, plan: SyncPlan): void {
  const projectedIds = new Set(projection.bills.map((b) => b.stableId));
  // Transactions whose bill link this plan already points elsewhere.
  const relinked = new Set(plan.txUpdates.filter((u) => 'Fatura Vinculada' in u.relations).map((u) => u.pageId));
  const stillLinkedTo = (billPageId: string) =>
    [...live.transactions.values()].some((pages) =>
      pages.some((t) => !relinked.has(t.pageId) && (liveValue(TX_ENV, 'Fatura Vinculada', t) as string[]).includes(billPageId)),
    );
  for (const [stableId, pages] of live.bills) {
    if (pages.length > 1) plan.fatal.push(`DUPLICATE_STABLE_ID: ${pages.length} páginas em Faturas com ID Estável ${stableId}.`);
    if (projectedIds.has(stableId)) continue;
    const page = pages[0];
    // An estimated cycle whose purchases the bank has since assigned to its official bill: its derived
    // totals would double-count them, so they are zeroed. The page and the user's fields stay.
    if (pages.length === 1 && liveValue(BILL_ENV, 'Tipo de Ciclo', page) === 'Ciclo Estimado' && !stillLinkedTo(page.pageId)) {
      const payload: Record<string, any> = {};
      const relations: Record<string, RefTarget[]> = {};
      const fields: string[] = [];
      for (const f of ['Total de Compras no Ciclo', 'Valor Pago']) {
        if (!same(canonicalValue(BILL_ENV, f, 0), liveValue(BILL_ENV, f, page))) {
          payload[f] = 0;
          fields.push(f);
        }
      }
      if ((liveValue(BILL_ENV, 'Transações de Pagamento', page) as string[]).length > 0) {
        relations['Transações de Pagamento'] = [];
        fields.push('Transações de Pagamento');
      }
      if (fields.length > 0) plan.billUpdates.push({ stableId, pageId: page.pageId, payload, relations, fields });
      plan.warnings.push(
        `SUPERSEDED_ESTIMATED_BILL: o ciclo estimado ${stableId} foi substituído pela fatura oficial do banco; totais zerados e página mantida (pode ser apagada manualmente).`,
      );
      continue;
    }
    plan.warnings.push(`STALE_BILL: a fatura ${stableId} existe no Notion mas não é mais derivada da fonte; mantida intacta.`);
  }

  for (const bill of projection.bills) {
    const pages = live.bills.get(bill.stableId) ?? [];
    if (pages.length > 1) continue;
    const paymentRefs: RefTarget[] = bill.paymentIds.map((id) => ({ kind: 'tx', stableId: id }));

    if (pages.length === 0) {
      const payload: Record<string, any> = {};
      for (const [k, v] of Object.entries(bill.payload)) if (v !== null && v !== undefined) payload[k] = v;
      plan.billCreates.push({ stableId: bill.stableId, payload, relations: { 'Cartão Vinculado': pageRefs([bill.cardPageId]) } });
      if (paymentRefs.length > 0) {
        plan.billUpdates.push({ stableId: bill.stableId, pageId: null, payload: {}, relations: { 'Transações de Pagamento': paymentRefs }, fields: ['Transações de Pagamento'] });
      }
      continue;
    }

    const page = pages[0];
    const payload: Record<string, any> = {};
    const relations: Record<string, RefTarget[]> = {};
    const fields: string[] = [];
    for (const f of BILL_MANAGED_FIELDS) {
      const desired = canonicalValue(BILL_ENV, f, bill.payload[f]);
      if (desired === null) continue; // a null projection never erases a value someone filled in
      if (!same(desired, liveValue(BILL_ENV, f, page))) {
        payload[f] = bill.payload[f];
        fields.push(f);
      }
    }
    if (!same([bill.cardPageId], liveValue(BILL_ENV, 'Cartão Vinculado', page))) {
      relations['Cartão Vinculado'] = pageRefs([bill.cardPageId]);
      fields.push('Cartão Vinculado');
    }
    // Payments: compared against the live page ids of the allocated transactions (new ones never match yet).
    const livePayments = liveValue(BILL_ENV, 'Transações de Pagamento', page) as string[];
    const knownPaymentPages = bill.paymentIds.map((id) => txPageId.get(id) ?? null);
    const desiredResolved = knownPaymentPages.every((p) => p !== null) ? (knownPaymentPages as string[]).sort() : null;
    if (bill.paymentIds.length > 0 && (desiredResolved === null || !same(desiredResolved, livePayments))) {
      relations['Transações de Pagamento'] = paymentRefs;
      fields.push('Transações de Pagamento');
    }
    if (fields.length > 0) plan.billUpdates.push({ stableId: bill.stableId, pageId: page.pageId, payload, relations, fields });
  }
}

function reconcileAccounts(ctx: AccountSourceContext, live: LiveState, plan: SyncPlan): void {
  for (const row of ctx.rows) {
    const role = ctx.roles[row.id];
    const pageId = ctx.pageBySourceId.get(row.id);
    if (!role || !pageId) continue;
    const page = live.accounts.find((a) => a.pageId === pageId);
    if (!page) continue;

    const sourceDate = row.last_synced_at ? row.last_synced_at.substring(0, 10) : null;
    const liveDate = (liveValue(ACCOUNT_ENV, 'Atualizado em', page) as { start: string } | null)?.start?.substring(0, 10) ?? null;
    if (!sourceDate) continue;
    if (liveDate && sourceDate < liveDate) {
      plan.warnings.push(`STALE_SOURCE_ACCOUNT: ${page.name} no Notion (${liveDate}) é mais recente que a fonte local (${sourceDate}); saldo/limites mantidos.`);
      continue;
    }

    const desired: Record<string, any> = { 'Atualizado em': { start: sourceDate, end: null } };
    if (role === 'CHECKING' && row.type === 'BANK') {
      desired['Saldo'] = row.closing_balance;
    } else if (role === 'CREDIT' && row.type === 'CREDIT') {
      desired['Limite contratado'] = row.credit_limit;
      desired['Limite disponível'] = row.available_credit;
      if (row.credit_limit !== null && row.available_credit !== null) {
        desired['Limite Usado da Fonte (Bruto)'] = Math.round((row.credit_limit - row.available_credit) * 100) / 100;
      }
      const personal = liveValue(ACCOUNT_ENV, 'Limite personalizado', page);
      if (typeof personal === 'number' && row.available_credit !== null) {
        // "Limite personalizado" is canonicalised in minor units (real format).
        const personalValue = personal / 100;
        desired['Limite Operacional Usado'] = Math.max(0, Math.round((personalValue - row.available_credit) * 100) / 100);
      }
    } else {
      continue;
    }

    const payload: Record<string, any> = {};
    const fields: string[] = [];
    for (const [f, v] of Object.entries(desired)) {
      const d = canonicalValue(ACCOUNT_ENV, f, v);
      if (d === null) continue;
      if (!same(d, liveValue(ACCOUNT_ENV, f, page))) {
        payload[f] = v;
        fields.push(f);
      }
    }
    if (fields.length > 0) plan.accountUpdates.push({ pageId, name: page.name, payload, fields });
  }
}

export function reconcile(
  projection: ProjectionResult,
  rows: SqliteTransactionRow[],
  rules: ClassificationRule[],
  live: LiveState,
  accounts: AccountSourceContext,
  options: ReconcileOptions,
): SyncPlan {
  const plan: SyncPlan = {
    billCreates: [],
    txCreates: [],
    txUpdates: [],
    billUpdates: [],
    accountUpdates: [],
    fatal: [],
    warnings: [],
    stats: { projectedTransactions: projection.transactions.length, projectedBills: projection.bills.length, unchangedTransactions: 0, reclassified: 0 },
  };
  const txPageId = new Map<string, string>();
  for (const [stableId, pages] of live.transactions) if (pages.length === 1) txPageId.set(stableId, pages[0].pageId);

  if (projection.unresolvedAccountIds.length > 0) {
    plan.warnings.push(`UNMAPPED_SOURCE_ACCOUNT: contas do Pierre sem papel no arquivo de mapeamento: ${projection.unresolvedAccountIds.join(', ')}.`);
  }
  // Pages whose source row is not in the local history (manual entries, other sources) are never touched.
  reconcileTransactions(projection, new Map(rows.map((r) => [r.id, r])), rules, live, options, plan);
  reconcileBills(projection, live, txPageId, plan);
  reconcileAccounts(accounts, live, plan);
  return plan;
}

export type { ProjectedTransaction, ProjectedBill };
