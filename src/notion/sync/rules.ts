import { ClassificationRule, ProjectedTransaction, SqliteTransactionRow } from './types';

/**
 * "Regras de Classificação" (user-owned Notion data source) applied by the sync.
 *
 * A rule is eligible only when it is active, marked "Auto aplicar", has at least one condition and at least one
 * result. All present conditions must match (AND). Rules are evaluated by ascending "Prioridade" (then name) and
 * the first match wins. Text comparisons ignore case, accents and repeated spaces.
 */

type Props = Record<string, any>;

const text = (p: any): string | null => {
  if (!p) return null;
  const items = p.title ?? p.rich_text;
  if (Array.isArray(items)) {
    const s = items.map((t: any) => t.plain_text ?? t.text?.content ?? '').join('').trim();
    return s.length > 0 ? s : null;
  }
  return null;
};
const num = (p: any): number | null => (p && typeof p.number === 'number' ? p.number : null);
const check = (p: any): boolean => Boolean(p && p.checkbox === true);
const select = (p: any): string | null => (p && p.select && p.select.name ? String(p.select.name) : null);
const dateStart = (p: any): string | null => (p && p.date && p.date.start ? String(p.date.start).substring(0, 10) : null);
const firstRelation = (p: any): string | null => (p && Array.isArray(p.relation) && p.relation.length > 0 ? p.relation[0].id : null);

export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseRule(pageId: string, props: Props): ClassificationRule {
  const movement = select(props['Movimento esperado']);
  return {
    pageId,
    name: text(props['Regra']) ?? '(sem nome)',
    priority: num(props['Prioridade']) ?? 1000,
    active: check(props['Ativa']),
    autoApply: check(props['Auto aplicar']),
    requireReview: check(props['Exigir revisão']),
    counterpartyContains: text(props['Contraparte contém']),
    descriptionContains: text(props['Descrição contém']),
    pierreCategory: text(props['Categoria Pierre']),
    sourceAccountPageId: firstRelation(props['Conta origem']),
    expectedMovement: movement === 'Entrada' || movement === 'Saída' || movement === 'Qualquer' ? movement : null,
    exactValue: num(props['Valor exato']),
    tolerance: num(props['Tolerância']),
    minValue: num(props['Valor mínimo']),
    maxValue: num(props['Valor máximo']),
    minDay: num(props['Dia mínimo']),
    maxDay: num(props['Dia máximo']),
    validFrom: dateStart(props['Válida de']),
    validUntil: dateStart(props['Válida até']),
    resultNature: select(props['Natureza resultante']),
    resultEffect: select(props['Atribuir: Efeito Orçamento']),
    resultAllocation: select(props['Atribuir: Alocação']),
    resultCategoryPageId: firstRelation(props['Categoria resultante']),
    resultDestinationAccountPageId: firstRelation(props['Atribuir: Conta Destino']),
  };
}

function hasCondition(r: ClassificationRule): boolean {
  return [
    r.counterpartyContains,
    r.descriptionContains,
    r.pierreCategory,
    r.sourceAccountPageId,
    r.expectedMovement && r.expectedMovement !== 'Qualquer' ? r.expectedMovement : null,
    r.exactValue,
    r.minValue,
    r.maxValue,
    r.minDay,
    r.maxDay,
  ].some((v) => v !== null && v !== undefined);
}

function hasResult(r: ClassificationRule): boolean {
  return Boolean(r.resultNature || r.resultEffect || r.resultCategoryPageId);
}

export function isEligibleRule(r: ClassificationRule): boolean {
  return r.active && r.autoApply && hasCondition(r) && hasResult(r);
}

/** Every text that identifies the counterparty: the description and Pierre's payer/receiver/merchant names. */
function counterpartyTexts(tx: SqliteTransactionRow): string[] {
  let raw: any = {};
  try {
    raw = JSON.parse(tx.raw_json || '{}');
  } catch {
    raw = {};
  }
  const merchant = typeof raw.merchant === 'string' ? raw.merchant : raw.merchant?.name;
  return [tx.description, raw.payment_data?.payer?.name, raw.payment_data?.receiver?.name, merchant]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map(normalizeText);
}

export function ruleMatches(rule: ClassificationRule, tx: SqliteTransactionRow, accountPageId: string | null): boolean {
  const amount = Number(tx.amount);
  const absValue = Math.abs(amount);
  const date = tx.date.substring(0, 10);
  const day = Number(date.substring(8, 10));

  if (rule.counterpartyContains) {
    const needle = normalizeText(rule.counterpartyContains);
    if (!counterpartyTexts(tx).some((t) => t.includes(needle))) return false;
  }
  if (rule.descriptionContains && !normalizeText(tx.description).includes(normalizeText(rule.descriptionContains))) return false;
  if (rule.pierreCategory && normalizeText(tx.category_pierre || '') !== normalizeText(rule.pierreCategory)) return false;
  if (rule.sourceAccountPageId && rule.sourceAccountPageId !== accountPageId) return false;
  if (rule.expectedMovement === 'Entrada' && !(amount > 0)) return false;
  if (rule.expectedMovement === 'Saída' && !(amount < 0)) return false;
  if (rule.exactValue !== null && Math.abs(absValue - rule.exactValue) > (rule.tolerance ?? 0.005)) return false;
  if (rule.minValue !== null && absValue < rule.minValue) return false;
  if (rule.maxValue !== null && absValue > rule.maxValue) return false;
  if (rule.minDay !== null || rule.maxDay !== null) {
    const min = rule.minDay ?? 1;
    const max = rule.maxDay ?? 31;
    const inWindow = min <= max ? day >= min && day <= max : day >= min || day <= max; // e.g. 28..5 wraps the month
    if (!inWindow) return false;
  }
  if (rule.validFrom && date < rule.validFrom) return false;
  if (rule.validUntil && date > rule.validUntil) return false;
  return true;
}

export function sortRules(rules: ClassificationRule[]): ClassificationRule[] {
  return rules.filter(isEligibleRule).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}

export function findMatchingRule(rules: ClassificationRule[], tx: SqliteTransactionRow, accountPageId: string | null): ClassificationRule | null {
  for (const rule of sortRules(rules)) {
    if (ruleMatches(rule, tx, accountPageId)) return rule;
  }
  return null;
}

/** Budget effect implied by an economic nature when the rule does not set one explicitly. */
export function effectFromNature(nature: string | null): string | null {
  switch (nature) {
    case 'Receita':
      return 'Receita';
    case 'Despesa':
      return 'Despesa';
    case 'Reembolso':
      return 'Estorno';
    case 'Transferência interna':
    case 'Aporte':
    case 'Resgate':
    case 'Pagamento de fatura':
    case 'Ajuste':
      return 'Neutro';
    default:
      return null;
  }
}

/** Classification fields a rule assigns (physical property names), plus the relations it sets. */
export interface RuleOutcome {
  fields: Record<string, any>;
  relations: Record<string, string[]>;
  rule: ClassificationRule;
}

export function ruleOutcome(rule: ClassificationRule, base: ProjectedTransaction): RuleOutcome {
  const nature = rule.resultNature ?? base.payload['Natureza'] ?? null;
  const effect = rule.resultEffect ?? effectFromNature(rule.resultNature) ?? base.payload['Efeito Orçamentário'] ?? null;
  const fields: Record<string, any> = {
    Natureza: nature,
    'Efeito Orçamentário': effect,
    'Status de Revisão': rule.requireReview ? 'Provável' : 'Confirmado Auto',
    'Motivo da Revisão': rule.requireReview ? `Classificada pela regra "${rule.name}"; confirme e marque Validado Manual.` : '',
  };
  if (rule.resultAllocation) fields['Propósito de Alocação'] = rule.resultAllocation;
  const relations: Record<string, string[]> = {};
  const category = rule.resultCategoryPageId ?? base.relations['Categoria']?.[0] ?? null;
  if (category) relations['Categoria'] = [category];
  if (rule.resultDestinationAccountPageId) relations['Conta Destino'] = [rule.resultDestinationAccountPageId];
  return { fields, relations, rule };
}

/** Applies a rule on top of the deterministic projection of a NEW transaction. */
export function applyRuleToProjection(rules: ClassificationRule[], tx: SqliteTransactionRow, projected: ProjectedTransaction): { projected: ProjectedTransaction; rule: ClassificationRule | null } {
  const rule = findMatchingRule(rules, tx, projected.accountPageId);
  if (!rule) return { projected, rule: null };
  const outcome = ruleOutcome(rule, projected);
  return {
    rule,
    projected: {
      ...projected,
      payload: { ...projected.payload, ...outcome.fields },
      relations: { ...projected.relations, ...outcome.relations },
    },
  };
}
