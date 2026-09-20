import { Client } from '@notionhq/client';
import { NotionPageRecord, BaseSnapshotData, sanitizeNotionProperty } from './data-snapshot';
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

  getMutationCount(): number;
}

export interface SimulationFaultInjector {
  failNextCreate?: Error;
  failNextUpdate?: Error;
  uncertainWriteNextCreate?: Error;
  uncertainWriteNextUpdate?: Error;
  retryableErrorsCount?: number;
  retryableStatusCode?: number;
  retryAfterSeconds?: number;
  failStatusCodes?: number[];
}

/**
 * Simulated Notion Adapter for Phase 2B.
 * Populated strictly from frozen target snapshot bases.
 * Generates deterministic page IDs (sim-page-000001, sim-page-000002, ...).
 * Maintains dynamic dual relations synchronization in memory via TARGET_CONTRACT.
 */
export class SimulatedNotionAdapter implements BackfillNotionAdapter {
  private bases: Map<string, Map<string, NotionPageRecord>> = new Map();
  private baseMetadata: Map<string, { defaultTitle: string; dataSourceId: string }> = new Map();
  private pageIdToEnvKey: Map<string, string> = new Map();
  private pageCounter: number = 0;
  private faults: SimulationFaultInjector = {};
  private pageIdGenerator?: (index: number) => string;

  constructor(
    initialBases: Record<string, BaseSnapshotData> = {},
    options?: { pageIdGenerator?: (index: number) => string },
  ) {
    this.pageIdGenerator = options?.pageIdGenerator;
    this.initFromSnapshot(initialBases);
  }

  public setPageIdGenerator(generator?: (index: number) => string): void {
    this.pageIdGenerator = generator;
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

  public getMutationCount(): number {
    // In Phase 2B simulation mode, zero live Notion mutations occur
    return 0;
  }

  private generateDeterministicPageId(): string {
    this.pageCounter += 1;
    if (this.pageIdGenerator) {
      return this.pageIdGenerator(this.pageCounter);
    }
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
    // Check failStatusCodes injection
    if (this.faults.failStatusCodes && this.faults.failStatusCodes.length > 0) {
      const status = this.faults.failStatusCodes.shift()!;
      const err: any = new Error(`Simulated Notion API error ${status}`);
      err.status = status;
      if (status === 429) {
        err.headers = { 'retry-after': String(this.faults.retryAfterSeconds ?? 0.01) };
      }
      throw err;
    }

    // Check retryable errors simulation
    if (this.faults.retryableErrorsCount && this.faults.retryableErrorsCount > 0) {
      this.faults.retryableErrorsCount -= 1;
      const status = this.faults.retryableStatusCode || 429;
      const err: any = new Error(`Simulated Notion API error ${status}`);
      err.status = status;
      if (status === 429) {
        err.headers = { 'retry-after': String(this.faults.retryAfterSeconds ?? 0.01) };
      }
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
    // Check failStatusCodes injection
    if (this.faults.failStatusCodes && this.faults.failStatusCodes.length > 0) {
      const status = this.faults.failStatusCodes.shift()!;
      const err: any = new Error(`Simulated Notion API error ${status}`);
      err.status = status;
      if (status === 429) {
        err.headers = { 'retry-after': String(this.faults.retryAfterSeconds ?? 0.01) };
      }
      throw err;
    }

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

      // Dynamic dual relation synchronization via TARGET_CONTRACT
      const propContract = TARGET_CONTRACT[targetDataSourceEnvKey]?.properties.find(
        (p) => p.notionProperty === relName || (p.aliases && p.aliases.includes(relName)),
      );
      if (
        propContract?.isBidirectionalRelation &&
        propContract.relationTargetEnvKey &&
        propContract.syncedPropertyName
      ) {
        const targetBase = this.bases.get(propContract.relationTargetEnvKey);
        if (targetBase) {
          for (const targetId of targetIds) {
            const targetRec = targetBase.get(targetId);
            if (targetRec) {
              const existingRel = targetRec.properties[propContract.syncedPropertyName]?.relation || [];
              const alreadyLinked = existingRel.some((r: any) => (r.id || r) === pageId);
              if (!alreadyLinked) {
                targetRec.properties[propContract.syncedPropertyName] = {
                  relation: [...existingRel, { id: pageId }],
                };
              }
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
 * Read-only methods query the real Notion API for preflight / drift detection with fail-closed behavior.
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

  public getMutationCount(): number {
    // In Phase 2B, mutations on live adapter are strictly disabled and count is always 0
    return 0;
  }

  private handleLiveNotionError(err: any, operation: string): never {
    const status = err?.status || err?.code;
    const msg = err?.message || String(err);
    if (status === 401 || status === 403) {
      throw new Error(
        `FAIL_NOTION_AUTH: Autenticação/autorização falhou na Notion API (${status}) em ${operation}: ${msg}`,
      );
    }
    if (status === 400 || (msg && msg.includes('validation_error'))) {
      throw new Error(
        `FAIL_NOTION_VALIDATION: Validação da requisição Notion falhou (${status}) em ${operation}: ${msg}`,
      );
    }
    throw new Error(
      `READ_UNCERTAIN: Erro de leitura ou rede na Notion API (${status || 'NETWORK_ERROR'}) em ${operation}: ${msg}`,
    );
  }

  private mapPageToRecord(page: any): NotionPageRecord {
    const sanitizedProperties: Record<string, any> = {};
    for (const [propName, propVal] of Object.entries(page.properties || {})) {
      sanitizedProperties[propName] = sanitizeNotionProperty(propVal);
    }
    return {
      id: page.id,
      createdTime: page.created_time || new Date().toISOString(),
      lastEditedTime: page.last_edited_time || new Date().toISOString(),
      archived: Boolean(page.is_archived || page.in_trash || page.archived),
      url: page.url || `https://notion.so/${(page.id || '').replace(/-/g, '')}`,
      properties: sanitizedProperties,
    };
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

    const contract = findPropertyContract(targetDataSourceEnvKey, stableIdProperty);
    const resolvedPropName = contract ? contract.notionProperty : stableIdProperty;

    try {
      const response = await (this.client as any).dataSources.query({
        data_source_id: dsId,
        filter: {
          property: resolvedPropName,
          rich_text: {
            equals: stableIdValue,
          },
        },
      });

      return (response.results || []).map((page: any) => this.mapPageToRecord(page));
    } catch (err: any) {
      this.handleLiveNotionError(err, `findByStableIdentity(${targetDataSourceEnvKey})`);
    }
  }

  public async fetchPage(pageId: string): Promise<NotionPageRecord | null> {
    try {
      const page: any = await this.client.pages.retrieve({ page_id: pageId });
      return this.mapPageToRecord(page);
    } catch (err: any) {
      if (err?.status === 404 || err?.code === 'object_not_found') {
        return null;
      }
      this.handleLiveNotionError(err, `fetchPage(${pageId})`);
    }
  }

  public async queryTargetState(): Promise<Record<string, BaseSnapshotData>> {
    const result: Record<string, BaseSnapshotData> = {};
    for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
      const dsId = this.envVars[key]?.trim();
      if (!dsId) {
        if (contract.isExisting) {
          throw new Error(`FAIL_MISSING_ENV: Variável obrigatória '${key}' não configurada no ambiente.`);
        } else {
          // 13th base (Faturas) is not yet created prior to DDL apply
          result[key] = {
            envKey: key,
            defaultTitle: contract.defaultTitle,
            dataSourceId: key,
            recordCount: 0,
            records: [],
          };
          continue;
        }
      }

      try {
        const records: NotionPageRecord[] = [];
        let hasMore = true;
        let startCursor: string | undefined = undefined;

        while (hasMore) {
          const resp: any = await (this.client as any).dataSources.query({
            data_source_id: dsId,
            page_size: 100,
            start_cursor: startCursor,
          });

          for (const page of resp.results || []) {
            records.push(this.mapPageToRecord(page));
          }

          hasMore = Boolean(resp.has_more && resp.next_cursor);
          startCursor = resp.next_cursor ?? undefined;
        }

        result[key] = {
          envKey: key,
          defaultTitle: contract.defaultTitle,
          dataSourceId: dsId,
          recordCount: records.length,
          records,
        };
      } catch (err: any) {
        this.handleLiveNotionError(err, `queryTargetState(${key})`);
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
      'REAL_DML_DISABLED_PRE_APPLY: Mutation methods are strictly disabled in pre-apply / Phase 2C (REAL_DML_DISABLED_PHASE_2B). Live DML writes are not authorized.',
    );
  }

  public async updatePageRelations(
    _targetDataSourceEnvKey: string,
    _pageId: string,
    _relations: Record<string, string[]>,
  ): Promise<{ id: string; properties: Record<string, any> }> {
    throw new Error(
      'REAL_DML_DISABLED_PRE_APPLY: Mutation methods are strictly disabled in pre-apply / Phase 2C (REAL_DML_DISABLED_PHASE_2B). Live DML writes are not authorized.',
    );
  }
}
