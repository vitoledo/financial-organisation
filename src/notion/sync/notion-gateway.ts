import { Client } from '@notionhq/client';
import { TARGET_CONTRACT } from '../../domain/schema-contract';
import { canonicalizePropertyValue } from '../migration-runner/backfill-serializer';
import { parseRule } from './rules';
import { ClassificationRule, LivePage } from './types';
import { LiveState } from './reconcile';

/**
 * The only component of the sync that talks to Notion. Surface: dataSources.retrieve/query (reads),
 * pages.create/update (writes). Requests are throttled (~3 req/s, Notion's limit) and retried with backoff on
 * rate limits, conflicts and 5xx. Pages are never archived or deleted.
 */

export interface SyncDataSources {
  transactions: string;
  bills: string;
  accounts: string;
  categories: string;
  rules: string;
  syncLog: string;
}

export interface GatewayOptions {
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

type NotionLike = Pick<Client, 'dataSources' | 'pages'>;

const RETRYABLE_CODES = new Set(['rate_limited', 'conflict_error', 'service_unavailable', 'internal_server_error', 'gateway_timeout']);

export function isRetryableNotionError(err: any): boolean {
  const status = Number(err?.status);
  return RETRYABLE_CODES.has(err?.code) || status === 429 || status === 409 || (status >= 500 && status < 600);
}

/**
 * Lenient version of canonicalizePageRecord: same value parsing and canonical form, but select options that a
 * person added in Notion (outside the contract's expected list) are read instead of aborting the sync.
 */
export function canonicalizeLive(envKey: string, props: Record<string, any>): Record<string, any> {
  const ds = TARGET_CONTRACT[envKey];
  const out: Record<string, any> = {};
  for (const contract of ds.properties) {
    const key = [contract.notionProperty, ...(contract.aliases || [])].find((k) => props[k] !== undefined);
    if (!key) continue;
    const raw = props[key];
    let parsed: any = null;
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.title)) parsed = raw.title.map((t: any) => t.plain_text ?? t.text?.content ?? '').join('');
      else if (Array.isArray(raw.rich_text)) parsed = raw.rich_text.map((t: any) => t.plain_text ?? t.text?.content ?? '').join('');
      else if ('number' in raw) parsed = raw.number;
      else if ('select' in raw) parsed = raw.select?.name ?? null;
      else if ('date' in raw) parsed = raw.date ? { start: raw.date.start, end: raw.date.end ?? null } : null;
      else if ('checkbox' in raw) parsed = raw.checkbox;
      else if (Array.isArray(raw.relation)) parsed = raw.relation.map((r: any) => r.id);
      else if (Array.isArray(raw.multi_select)) parsed = raw.multi_select.map((m: any) => m.name);
    }
    if (parsed === null || parsed === undefined) continue;
    if (contract.notionType === 'relation' && Array.isArray(parsed) && parsed.length === 0) continue;
    out[contract.notionProperty] = canonicalizePropertyValue({ ...contract, expectedOptions: undefined, allowExtraOptions: true }, parsed);
  }
  return out;
}

const plainText = (p: any): string =>
  (p?.title ?? p?.rich_text ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? '').join('').trim();

export interface LoadedNotionState {
  live: LiveState;
  categories: Array<{ id: string; name: string }>;
  rules: ClassificationRule[];
  /** Transactions pages whose "ID da fonte" is empty (manual entries): counted, never touched. */
  unkeyedTransactions: number;
  pendingReview: number;
}

export class NotionSyncGateway {
  private lastRequestAt = 0;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  public writes = 0;

  constructor(
    private readonly client: NotionLike,
    public readonly ds: SyncDataSources,
    options: GatewayOptions = {},
  ) {
    this.minIntervalMs = options.minIntervalMs ?? 350;
    this.maxRetries = options.maxRetries ?? 5;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
      try {
        return await fn();
      } catch (err: any) {
        if (!isRetryableNotionError(err) || attempt >= this.maxRetries) throw err;
        const retryAfter = Number(err?.headers?.get?.('retry-after') ?? err?.headers?.['retry-after']);
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 30_000));
      }
    }
  }

  async queryAll(dataSourceId: string): Promise<any[]> {
    const pages: any[] = [];
    let cursor: string | undefined;
    do {
      const res: any = await this.call(() => (this.client.dataSources as any).query({ data_source_id: dataSourceId, page_size: 100, start_cursor: cursor }));
      pages.push(...res.results);
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
    return pages;
  }

  async retrieveSchema(dataSourceId: string): Promise<Record<string, any>> {
    const res: any = await this.call(() => (this.client.dataSources as any).retrieve({ data_source_id: dataSourceId }));
    return res.properties as Record<string, any>;
  }

  async loadState(): Promise<LoadedNotionState> {
    const [txPages, billPages, accountPages, categoryPages, rulePages] = [
      await this.queryAll(this.ds.transactions),
      await this.queryAll(this.ds.bills),
      await this.queryAll(this.ds.accounts),
      await this.queryAll(this.ds.categories),
      await this.queryAll(this.ds.rules),
    ];

    const transactions = new Map<string, LivePage[]>();
    let unkeyedTransactions = 0;
    let pendingReview = 0;
    for (const p of txPages) {
      if (p.in_trash || p.archived) continue;
      const stableId = plainText(p.properties['ID da fonte']);
      if (p.properties['Status de Revisão']?.select?.name === 'Pendente Revisão') pendingReview++;
      if (!stableId) {
        unkeyedTransactions++;
        continue;
      }
      const list = transactions.get(stableId) ?? [];
      list.push({ pageId: p.id, canonical: canonicalizeLive('NOTION_DS_TRANSACTIONS', p.properties), raw: p.properties });
      transactions.set(stableId, list);
    }

    const bills = new Map<string, LivePage[]>();
    for (const p of billPages) {
      if (p.in_trash || p.archived) continue;
      const stableId = plainText(p.properties['ID Estável da Fatura']);
      if (!stableId) continue;
      const list = bills.get(stableId) ?? [];
      list.push({ pageId: p.id, canonical: canonicalizeLive('NOTION_DS_CARD_BILLS', p.properties), raw: p.properties });
      bills.set(stableId, list);
    }

    const accounts = accountPages
      .filter((p) => !p.in_trash && !p.archived)
      .map((p) => ({
        pageId: p.id,
        name: plainText(p.properties['Conta']),
        sourceId: plainText(p.properties['ID da fonte']) || null,
        canonical: canonicalizeLive('NOTION_DS_ACCOUNTS', p.properties),
        raw: p.properties,
      }));

    const categories = categoryPages
      .filter((p) => !p.in_trash && !p.archived)
      .map((p) => ({ id: p.id, name: plainText(p.properties['Categoria']) }))
      .filter((c) => c.name.length > 0);

    const rules = rulePages.filter((p) => !p.in_trash && !p.archived).map((p) => parseRule(p.id, p.properties));

    return { live: { transactions, bills, accounts }, categories, rules, unkeyedTransactions, pendingReview };
  }

  async createPage(dataSourceId: string, properties: Record<string, any>): Promise<string> {
    const res: any = await this.call(() =>
      (this.client.pages as any).create({ parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties }),
    );
    this.writes++;
    return res.id as string;
  }

  async updatePage(pageId: string, properties: Record<string, any>): Promise<void> {
    await this.call(() => (this.client.pages as any).update({ page_id: pageId, properties }));
    this.writes++;
  }
}
