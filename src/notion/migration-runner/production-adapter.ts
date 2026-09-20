/**
 * Production Notion Mutation Adapter (Phase 2D)
 *
 * ARCHITECTURAL SAFETY INVARIANTS:
 * 1. ONLY adapter authorized to perform live Notion writes (pages.create, pages.update).
 * 2. CANNOT be instantiated without a validated ProductionAuthorizationContext.
 * 3. Enforces physical mutation budget: MAX 159 pages, MAX 4 relation patch groups.
 * 4. Rate-limited to max ~3 requests/second with 429 Retry-After and 5xx exponential backoff.
 * 5. Builds filters according to TARGET_CONTRACT and strictly validates property types.
 * 6. DELETE, archive, and schema mutations are NOT IMPLEMENTED and throw fatal errors.
 */

import { Client } from '@notionhq/client';
import { BackfillNotionAdapter, NotionPageRecord } from './backfill-adapter';
import { BaseSnapshotData, sanitizeNotionProperty } from './data-snapshot';
import { TARGET_CONTRACT } from '../../domain/schema-contract';
import { findPropertyContract } from './backfill-serializer';
import { isPreflightValid, LivePreflightArtifact } from './backfill-live-preflight';
import {
  PLAN_ORIGIN_COMMIT_SHA,
  FROZEN_BACKFILL_PLAN_HASH,
  FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_STATE_HASH,
} from './backfill-constants';

export interface ProductionAuthorizationContext {
  planHash: string;
  planOriginCommitSha: string;
  executorCommitSha: string;
  sourceSnapshotHash: string;
  targetSnapshotHash: string;
  targetStateHash: string;
  workspaceIdentityHash: string;
  preflightGeneratedAt: string;
  preflightExpiresAt: string;
  journalPath: string;
}

export interface ProductionNotionAdapterOptions {
  maxNewPagesBudget?: number;
  maxRelationPatchGroups?: number;
  rateLimitDelayMs?: number;
  maxRetries?: number;
}

/**
 * Validates that the ProductionAuthorizationContext satisfies all frozen baseline requirements.
 * Throws FAIL_PRODUCTION_AUTHORIZATION if any check fails.
 */
export function validateProductionAuthorization(
  ctx: ProductionAuthorizationContext | undefined,
  expected?: {
    executorCommitSha?: string;
  },
): void {
  if (!ctx) {
    throw new Error('FAIL_PRODUCTION_AUTHORIZATION: ProductionAuthorizationContext não fornecido.');
  }

  if (ctx.planHash !== FROZEN_BACKFILL_PLAN_HASH) {
    throw new Error(
      `FAIL_PRODUCTION_AUTHORIZATION: planHash inválido (${ctx.planHash} vs ${FROZEN_BACKFILL_PLAN_HASH}).`,
    );
  }
  if (ctx.planOriginCommitSha !== PLAN_ORIGIN_COMMIT_SHA) {
    throw new Error(
      `FAIL_PRODUCTION_AUTHORIZATION: planOriginCommitSha inválido (${ctx.planOriginCommitSha} vs ${PLAN_ORIGIN_COMMIT_SHA}).`,
    );
  }
  if (ctx.sourceSnapshotHash !== FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256) {
    throw new Error(
      `FAIL_PRODUCTION_AUTHORIZATION: sourceSnapshotHash inválido (${ctx.sourceSnapshotHash} vs ${FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256}).`,
    );
  }
  if (ctx.targetSnapshotHash !== FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256) {
    throw new Error(
      `FAIL_PRODUCTION_AUTHORIZATION: targetSnapshotHash inválido (${ctx.targetSnapshotHash} vs ${FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256}).`,
    );
  }
  if (ctx.targetStateHash !== FROZEN_TARGET_STATE_HASH) {
    throw new Error(
      `FAIL_PRODUCTION_AUTHORIZATION: targetStateHash inválido (${ctx.targetStateHash} vs ${FROZEN_TARGET_STATE_HASH}).`,
    );
  }
  if (!ctx.workspaceIdentityHash || ctx.workspaceIdentityHash.trim().length === 0) {
    throw new Error('FAIL_PRODUCTION_AUTHORIZATION: workspaceIdentityHash ausente ou inválido.');
  }

  // Validate temporal validity of preflight
  const validity = isPreflightValid({
    generatedAt: ctx.preflightGeneratedAt,
    expiresAt: ctx.preflightExpiresAt,
  } as LivePreflightArtifact);
  if (!validity.valid) {
    throw new Error(`FAIL_PRODUCTION_AUTHORIZATION: Preflight inválido temporalmente: ${validity.reason}`);
  }

  if (expected?.executorCommitSha && ctx.executorCommitSha !== expected.executorCommitSha) {
    throw new Error(
      `FAIL_PRODUCTION_AUTHORIZATION: executorCommitSha diverge (${ctx.executorCommitSha} vs ${expected.executorCommitSha}).`,
    );
  }

  if (!ctx.journalPath || !ctx.journalPath.includes('.local')) {
    throw new Error('FAIL_PRODUCTION_AUTHORIZATION: journalPath deve apontar para diretório protegido (.local).');
  }
}

export class ProductionNotionAdapter implements BackfillNotionAdapter {
  private client: Client;
  private authContext: ProductionAuthorizationContext;
  private envVars: Record<string, string | undefined>;
  private maxNewPagesBudget: number;
  private maxRelationPatchGroups: number;
  private minRequestIntervalMs: number;
  private maxRetries: number;
  private lastRequestTime: number = 0;

  // Request & mutation metrics
  private createRequestsSentCount: number = 0;
  private relationPatchRequestsSentCount: number = 0;
  private totalMutationRequestsCount: number = 0;

  constructor(
    client: Client,
    authContext: ProductionAuthorizationContext,
    envVars: Record<string, string | undefined> = {},
    options?: ProductionNotionAdapterOptions,
  ) {
    validateProductionAuthorization(authContext);

    this.client = client;
    this.authContext = authContext;
    this.envVars = envVars;
    this.maxNewPagesBudget = options?.maxNewPagesBudget ?? 159;
    this.maxRelationPatchGroups = options?.maxRelationPatchGroups ?? 4;
    this.minRequestIntervalMs = options?.rateLimitDelayMs ?? 334; // ~3 req/s
    this.maxRetries = options?.maxRetries ?? 3;
  }

  public get createRequestsSent(): number {
    return this.createRequestsSentCount;
  }

  public get relationPatchRequestsSent(): number {
    return this.relationPatchRequestsSentCount;
  }

  public get totalMutationRequests(): number {
    return this.totalMutationRequestsCount;
  }

  public getMutationCount(): number {
    return this.totalMutationRequestsCount;
  }

  public getAuthorizationContext(): ProductionAuthorizationContext {
    return { ...this.authContext };
  }

  /**
   * Rate-limited request scheduler enforcing ~3 requests/second with 429 Retry-After and 5xx backoff.
   */
  private async scheduleRequest<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      attempt++;

      // Enforce rate limiter spacing
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      if (elapsed < this.minRequestIntervalMs) {
        const jitter = Math.floor(Math.random() * 20); // 0-20ms jitter
        const waitMs = this.minRequestIntervalMs - elapsed + jitter;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      this.lastRequestTime = Date.now();

      try {
        return await fn();
      } catch (err: any) {
        // Fatal client/validation errors -> fail fast without retry
        if (
          err?.status === 400 ||
          err?.status === 401 ||
          err?.status === 403 ||
          err?.status === 404 ||
          err?.code === 'validation_error'
        ) {
          throw err;
        }

        // 429 Rate Limit: Respect Retry-After header
        if (err?.status === 429) {
          const retryAfterSec = err.headers?.get?.('retry-after')
            ? parseFloat(err.headers.get('retry-after'))
            : err.retry_after ?? 1;
          const waitTimeMs = Math.max(1000, retryAfterSec * 1000) + 100;
          if (attempt <= this.maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, waitTimeMs));
            continue;
          }
        }

        // 5xx Server Errors: Exponential backoff with jitter
        if (
          err?.status === 500 ||
          err?.status === 502 ||
          err?.status === 503 ||
          err?.status === 504 ||
          err?.code === 'service_unavailable' ||
          err?.code === 'internal_server_error'
        ) {
          if (attempt <= this.maxRetries) {
            const backoffMs = Math.pow(2, attempt) * 200 + Math.floor(Math.random() * 100);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
        }

        throw err;
      }
    }

    throw new Error('FAIL_REQUEST_EXHAUSTED: Retries esgotados sem resposta bem-sucedida.');
  }

  private mapPageToRecord(page: any): NotionPageRecord {
    const sanitizedProperties: Record<string, any> = {};
    for (const [propName, propVal] of Object.entries(page.properties || {})) {
      sanitizedProperties[propName] = sanitizeNotionProperty(propVal);
    }
    return {
      id: page.id,
      createdTime: page.created_time || page.createdTime || new Date().toISOString(),
      lastEditedTime: page.last_edited_time || page.lastEditedTime || new Date().toISOString(),
      url: page.url || `https://notion.so/${(page.id || '').replace(/-/g, '')}`,
      archived: Boolean(page.is_archived || page.in_trash || page.archived),
      properties: sanitizedProperties,
    };
  }

  /**
   * Queries stable identity building filter strictly according to TARGET_CONTRACT.
   * Throws FAIL_STABLE_ID_PROPERTY_TYPE if live property type doesn't conform.
   */
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
    const expectedType = contract?.notionType || 'rich_text';

    // Item 8: Explicitly validate contract type for ID da Fonte and ID Estável da Fatura
    if (stableIdProperty === 'ID da Fonte' || stableIdProperty === 'ID Estável da Fatura') {
      if (expectedType !== 'rich_text') {
        throw new Error(
          `FAIL_STABLE_ID_PROPERTY_TYPE: Propriedade '${stableIdProperty}' deve ser do tipo 'rich_text' no TARGET_CONTRACT. Encontrado: '${expectedType}'.`,
        );
      }
    }

    let filter: any;
    if (expectedType === 'rich_text') {
      filter = {
        property: resolvedPropName,
        rich_text: { equals: stableIdValue },
      };
    } else if (expectedType === 'title') {
      filter = {
        property: resolvedPropName,
        title: { equals: stableIdValue },
      };
    } else if (expectedType === 'number') {
      filter = {
        property: resolvedPropName,
        number: { equals: Number(stableIdValue) },
      };
    } else {
      throw new Error(
        `FAIL_STABLE_ID_PROPERTY_TYPE: Tipo não suportado para query de identidade estável: '${expectedType}'.`,
      );
    }

    return this.scheduleRequest(async () => {
      const response = await (this.client as any).dataSources.query({
        data_source_id: dsId,
        filter,
      });
      return (response.results || []).map((page: any) => this.mapPageToRecord(page));
    });
  }

  public async fetchPage(pageId: string): Promise<NotionPageRecord | null> {
    return this.scheduleRequest(async () => {
      try {
        const page: any = await this.client.pages.retrieve({ page_id: pageId });
        return this.mapPageToRecord(page);
      } catch (err: any) {
        if (err?.status === 404 || err?.code === 'object_not_found') {
          return null;
        }
        throw err;
      }
    });
  }

  /**
   * Real Page Creation with budget enforcement and rate limiting (Item 9 & 19).
   */
  public async createPage(
    _targetDataSourceEnvKey: string,
    dataSourceId: string,
    properties: Record<string, any>,
  ): Promise<{ id: string; properties: Record<string, any> }> {
    // Physical mutation budget check (max 159 pages)
    if (this.createRequestsSentCount >= this.maxNewPagesBudget) {
      throw new Error(
        `FAIL_MUTATION_BUDGET_EXCEEDED: Limite máximo de ${this.maxNewPagesBudget} criações de página atingido.`,
      );
    }

    this.createRequestsSentCount++;
    this.totalMutationRequestsCount++;

    return this.scheduleRequest(async () => {
      const page: any = await this.client.pages.create({
        parent: { database_id: dataSourceId } as any,
        properties,
      });

      return {
        id: page.id,
        properties: page.properties || {},
      };
    });
  }

  /**
   * Real Relation Patch with budget enforcement, rate limiting, and canonical single-side writing (Item 10 & 19).
   */
  public async updatePageRelations(
    _targetDataSourceEnvKey: string,
    pageId: string,
    relations: Record<string, string[]>,
  ): Promise<{ id: string; properties: Record<string, any> }> {
    // Physical mutation budget check (max 4 relation patch groups)
    if (this.relationPatchRequestsSentCount >= this.maxRelationPatchGroups) {
      throw new Error(
        `FAIL_MUTATION_BUDGET_EXCEEDED: Limite máximo de ${this.maxRelationPatchGroups} grupos de patch de relação atingido.`,
      );
    }

    this.relationPatchRequestsSentCount++;
    this.totalMutationRequestsCount++;

    // Format relation payload strictly as { relation: [{ id: ... }] }
    const formattedProps: Record<string, any> = {};
    for (const [propName, ids] of Object.entries(relations)) {
      formattedProps[propName] = {
        relation: ids.map((id) => ({ id })),
      };
    }

    return this.scheduleRequest(async () => {
      const page: any = await this.client.pages.update({
        page_id: pageId,
        properties: formattedProps,
      });

      return {
        id: page.id,
        properties: page.properties || {},
      };
    });
  }

  public async queryTargetState(): Promise<Record<string, BaseSnapshotData>> {
    const result: Record<string, BaseSnapshotData> = {};

    for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
      const dsId = this.envVars[key]?.trim();
      if (!dsId) {
        result[key] = {
          envKey: key,
          defaultTitle: contract.defaultTitle,
          dataSourceId: key,
          recordCount: 0,
          records: [],
        };
        continue;
      }

      const records: NotionPageRecord[] = [];
      let hasMore = true;
      let startCursor: string | undefined = undefined;

      while (hasMore) {
        const resp: any = await this.scheduleRequest(async () => {
          return (this.client as any).dataSources.query({
            data_source_id: dsId,
            page_size: 100,
            start_cursor: startCursor,
          });
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
    }

    return result;
  }

  // Strict fail-closed: DELETE, archive, and schema mutations are not supported
  public async deletePage(): Promise<never> {
    throw new Error('NOT_SUPPORTED_MUTATION: DELETE não é suportado pelo ProductionNotionAdapter.');
  }

  public async archivePage(): Promise<never> {
    throw new Error('NOT_SUPPORTED_MUTATION: archive não é suportado pelo ProductionNotionAdapter.');
  }
}
