import { Client } from '@notionhq/client';
import { NotionPageRecord, BaseSnapshotData } from './data-snapshot';
import { TARGET_CONTRACT } from '../../domain/schema-contract';
import { findPropertyContract } from './backfill-serializer';

export { NotionPageRecord };

export interface BackfillNotionAdapter {
  findByStableIdentity(
    targetDataSourceEnvKey: string,
    stableIdProperty: string,
    stableIdValue: string,
  ): Promise<NotionPageRecord[]>;

  fetchPage(pageId: string): Promise<NotionPageRecord | null>;

  queryTargetState(): Promise<Record<string, BaseSnapshotData>>;

  createPage(
    targetDataSourceEnvKey: string,
    dataSourceId: string,
    properties: Record<string, any>,
  ): Promise<{ id: string; properties: Record<string, any> }>;

  updatePageRelations(
    targetDataSourceEnvKey: string,
    pageId: string,
    relations: Record<string, string[]>,
  ): Promise<{ id: string; properties: Record<string, any> }>;
}

export interface SimulationFaultInjector {
  failNextCreate?: Error;
  failNextUpdate?: Error;
  uncertainWriteNextCreate?: Error;
  uncertainWriteNextUpdate?: Error;
  retryableErrorsCount?: number;
  retryableStatusCode?: number;
}

/**
 * Simulated Notion Adapter for Phase 2B.
 * Populated strictly from frozen target snapshot bases.
 * Generates deterministic page IDs (sim-page-000001, sim-page-000002, ...).
 * Maintains dual relations synchronization in memory.
 */
export class SimulatedNotionAdapter implements BackfillNotionAdapter {
  private bases: Map<string, Map<string, NotionPageRecord>> = new Map();
  private baseMetadata: Map<string, { defaultTitle: string; dataSourceId: string }> = new Map();
  private pageIdToEnvKey: Map<string, string> = new Map();
  private pageCounter: number = 0;
  private faults: SimulationFaultInjector = {};

  constructor(initialBases: Record<string, BaseSnapshotData> = {}) {
    this.initFromSnapshot(initialBases);
  }

  private initFromSnapshot(initialBases: Record<string, BaseSnapshotData>): void {
    for (const [key, baseData] of Object.entries(initialBases)) {
      this.baseMetadata.set(key, {
        defaultTitle: baseData.defaultTitle,
        dataSourceId: baseData.dataSourceId,
      });
      const recordsMap = new Map<string, NotionPageRecord>();
      for (const rec of baseData.records || []) {
        const clonedRec: NotionPageRecord = JSON.parse(JSON.stringify(rec));
        recordsMap.set(clonedRec.id, clonedRec);
        this.pageIdToEnvKey.set(clonedRec.id, key);
      }
      this.bases.set(key, recordsMap);
    }

    // Ensure all 13 canonical bases are represented
    for (const key of Object.keys(TARGET_CONTRACT)) {
      if (!this.bases.has(key)) {
        this.bases.set(key, new Map());
      }
    }
  }

  public setFaults(faults: SimulationFaultInjector): void {
    this.faults = { ...faults };
  }

  private generateDeterministicPageId(): string {
    this.pageCounter += 1;
    const padded = String(this.pageCounter).padStart(6, '0');
    return `sim-page-${padded}`;
  }

  public async findByStableIdentity(
    targetDataSourceEnvKey: string,
    stableIdProperty: string,
    stableIdValue: string,
  ): Promise<NotionPageRecord[]> {
    const baseMap = this.bases.get(targetDataSourceEnvKey);
    if (!baseMap) return [];

    const contract = findPropertyContract(targetDataSourceEnvKey, stableIdProperty);
    const resolvedPropName = contract ? contract.notionProperty : stableIdProperty;

    const matches: NotionPageRecord[] = [];
    for (const record of baseMap.values()) {
      if (record.archived) continue;
      const propVal =
        record.properties[resolvedPropName] !== undefined
          ? record.properties[resolvedPropName]
          : record.properties[stableIdProperty];
      let extractedStr = '';

      if (typeof propVal === 'string') {
        extractedStr = propVal;
      } else if (typeof propVal === 'number') {
        extractedStr = String(propVal);
      } else if (propVal && typeof propVal === 'object') {
        if ('rich_text' in propVal && Array.isArray(propVal.rich_text)) {
          extractedStr = propVal.rich_text.map((t: any) => t.plain_text || t.text?.content || '').join('');
        } else if ('title' in propVal && Array.isArray(propVal.title)) {
          extractedStr = propVal.title.map((t: any) => t.plain_text || t.text?.content || '').join('');
        } else if ('select' in propVal && propVal.select && typeof propVal.select === 'object' && 'name' in propVal.select) {
          extractedStr = propVal.select.name;
        } else if ('status' in propVal && propVal.status && typeof propVal.status === 'object' && 'name' in propVal.status) {
          extractedStr = propVal.status.name;
        } else if ('name' in propVal) {
          extractedStr = propVal.name;
        }
      }

      if (extractedStr.trim() === stableIdValue.trim()) {
        matches.push(JSON.parse(JSON.stringify(record)));
      }
    }

    return matches;
  }

  public async fetchPage(pageId: string): Promise<NotionPageRecord | null> {
    const envKey = this.pageIdToEnvKey.get(pageId);
    if (!envKey) return null;
    const baseMap = this.bases.get(envKey);
    if (!baseMap) return null;
    const record = baseMap.get(pageId);
    if (!record) return null;
    return JSON.parse(JSON.stringify(record));
  }

  public async queryTargetState(): Promise<Record<string, BaseSnapshotData>> {
    const result: Record<string, BaseSnapshotData> = {};
    for (const [key, baseMap] of this.bases.entries()) {
      const contract = TARGET_CONTRACT[key];
      const meta = this.baseMetadata.get(key);
      const records = Array.from(baseMap.values()).map((r) => JSON.parse(JSON.stringify(r)));
      result[key] = {
        envKey: key,
        defaultTitle: meta?.defaultTitle || contract?.defaultTitle || key,
        dataSourceId: meta?.dataSourceId || contract?.envKey || key,
        recordCount: records.length,
        records,
      };
    }
    return result;
  }

  public async createPage(
    targetDataSourceEnvKey: string,
    dataSourceId: string,
    properties: Record<string, any>,
  ): Promise<{ id: string; properties: Record<string, any> }> {
    // Check retryable errors simulation
    if (this.faults.retryableErrorsCount && this.faults.retryableErrorsCount > 0) {
      this.faults.retryableErrorsCount -= 1;
      const status = this.faults.retryableStatusCode || 429;
      const err: any = new Error(`Simulated Notion API error ${status}`);
      err.status = status;
      if (status === 429) err.headers = { 'retry-after': '0.01' };
      throw err;
    }

    // Check immediate failure injection
    if (this.faults.failNextCreate) {
      const err = this.faults.failNextCreate;
      this.faults.failNextCreate = undefined;
      throw err;
    }

    const nowIso = new Date().toISOString();
    const newId = this.generateDeterministicPageId();
    const newRecord: NotionPageRecord = {
      id: newId,
      createdTime: nowIso,
      lastEditedTime: nowIso,
      archived: false,
      url: `https://notion.so/${newId.replace(/-/g, '')}`,
      properties: JSON.parse(JSON.stringify(properties)),
    };

    let baseMap = this.bases.get(targetDataSourceEnvKey);
    if (!baseMap) {
      baseMap = new Map();
      this.bases.set(targetDataSourceEnvKey, baseMap);
    }
    baseMap.set(newId, newRecord);
    this.pageIdToEnvKey.set(newId, targetDataSourceEnvKey);

    // Check uncertain write simulation (page committed in backend, but timeout thrown to caller)
    if (this.faults.uncertainWriteNextCreate) {
      const err = this.faults.uncertainWriteNextCreate;
      this.faults.uncertainWriteNextCreate = undefined;
      throw err;
    }

    return {
      id: newId,
      properties: JSON.parse(JSON.stringify(newRecord.properties)),
    };
  }

  public async updatePageRelations(
    targetDataSourceEnvKey: string,
    pageId: string,
    relations: Record<string, string[]>,
  ): Promise<{ id: string; properties: Record<string, any> }> {
    if (this.faults.failNextUpdate) {
      const err = this.faults.failNextUpdate;
      this.faults.failNextUpdate = undefined;
      throw err;
    }

    const baseMap = this.bases.get(targetDataSourceEnvKey);
    if (!baseMap) {
      throw new Error(`FAIL_BASE_NOT_FOUND: Base '${targetDataSourceEnvKey}' não encontrada na simulação.`);
    }

    const record = baseMap.get(pageId);
    if (!record) {
      throw new Error(`FAIL_PAGE_NOT_FOUND: Página '${pageId}' não encontrada na base '${targetDataSourceEnvKey}'.`);
    }

    // Apply relations
    for (const [relName, targetIds] of Object.entries(relations)) {
      record.properties[relName] = {
        relation: targetIds.map((id) => ({ id })),
      };

      // Handle dual relation synchronization:
      // Faturas."Lançamentos do Ciclo" <-> Transações."Fatura Vinculada"
      if (targetDataSourceEnvKey === 'NOTION_DS_CARD_BILLS' && relName === 'Lançamentos do Ciclo') {
        const txBase = this.bases.get('NOTION_DS_TRANSACTIONS');
        if (txBase) {
          for (const txId of targetIds) {
            const txRecord = txBase.get(txId);
            if (txRecord) {
              txRecord.properties['Fatura Vinculada'] = {
                relation: [{ id: pageId }],
              };
            }
          }
        }
      }
    }

    if (this.faults.uncertainWriteNextUpdate) {
      const err = this.faults.uncertainWriteNextUpdate;
      this.faults.uncertainWriteNextUpdate = undefined;
      throw err;
    }

    return {
      id: pageId,
      properties: JSON.parse(JSON.stringify(record.properties)),
    };
  }
}

/**
 * Live Notion Adapter for Phase 2B.
 * Read-only methods query the real Notion API for preflight / drift detection.
 * Mutation methods (createPage, updatePageRelations) are STRICTLY DISABLED and throw REAL_DML_DISABLED_PHASE_2B.
 */
export class LiveNotionAdapter implements BackfillNotionAdapter {
  private client: Client;
  private envVars: Record<string, string | undefined>;

  constructor(client?: Client, envVars?: Record<string, string | undefined>) {
    this.envVars = envVars || (process.env as Record<string, string | undefined>);
    const apiKey = this.envVars.NOTION_API_KEY?.trim();
    this.client =
      client ||
      new Client({
        auth: apiKey,
        notionVersion: '2026-03-11',
      });
  }

  public async findByStableIdentity(
    targetDataSourceEnvKey: string,
    stableIdProperty: string,
    stableIdValue: string,
  ): Promise<NotionPageRecord[]> {
    const dsId = this.envVars[targetDataSourceEnvKey]?.trim();
    if (!dsId) {
      throw new Error(`FAIL_MISSING_ENV: Variável '${targetDataSourceEnvKey}' não configurada.`);
    }

    try {
      const response = await (this.client as any).dataSources.query({
        data_source_id: dsId,
        filter: {
          property: stableIdProperty,
          rich_text: {
            equals: stableIdValue,
          },
        },
      });

      return (response.results || []).map((page: any) => ({
        id: page.id,
        createdTime: page.created_time || new Date().toISOString(),
        lastEditedTime: page.last_edited_time || new Date().toISOString(),
        archived: Boolean(page.archived),
        url: page.url || `https://notion.so/${(page.id || '').replace(/-/g, '')}`,
        properties: page.properties || {},
      }));
    } catch {
      return [];
    }
  }

  public async fetchPage(pageId: string): Promise<NotionPageRecord | null> {
    try {
      const page: any = await this.client.pages.retrieve({ page_id: pageId });
      return {
        id: page.id,
        createdTime: page.created_time || new Date().toISOString(),
        lastEditedTime: page.last_edited_time || new Date().toISOString(),
        archived: Boolean(page.archived),
        url: page.url || `https://notion.so/${(page.id || '').replace(/-/g, '')}`,
        properties: page.properties || {},
      };
    } catch {
      return null;
    }
  }

  public async queryTargetState(): Promise<Record<string, BaseSnapshotData>> {
    // Read-only state retrieval across canonical bases
    const result: Record<string, BaseSnapshotData> = {};
    for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
      const dsId = this.envVars[key]?.trim();
      if (!dsId) continue;
      try {
        const resp = await (this.client as any).dataSources.query({ data_source_id: dsId });
        result[key] = {
          envKey: key,
          defaultTitle: contract.defaultTitle,
          dataSourceId: dsId,
          recordCount: (resp.results || []).length,
          records: resp.results || [],
        };
      } catch {
        // offline or unverified
      }
    }
    return result;
  }

  public async createPage(
    _targetDataSourceEnvKey: string,
    _dataSourceId: string,
    _properties: Record<string, any>,
  ): Promise<{ id: string; properties: Record<string, any> }> {
    throw new Error(
      'REAL_DML_DISABLED_PHASE_2B: Mutation methods are strictly disabled in Phase 2B. Live DML writes are not authorized.',
    );
  }

  public async updatePageRelations(
    _targetDataSourceEnvKey: string,
    _pageId: string,
    _relations: Record<string, string[]>,
  ): Promise<{ id: string; properties: Record<string, any> }> {
    throw new Error(
      'REAL_DML_DISABLED_PHASE_2B: Mutation methods are strictly disabled in Phase 2B. Live DML writes are not authorized.',
    );
  }
}
