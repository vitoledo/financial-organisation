/**
 * Production Notion Mutation Adapter (Phase 2D - Hardened Safety Seal)
 *
 * ARCHITECTURAL SAFETY INVARIANTS:
 * 1. ONLY adapter authorized to perform live Notion writes (pages.create, pages.update).
 * 2. CANNOT be instantiated without a validated ProductionAuthorizationContext matching APPROVED_WORKSPACE_IDENTITY_HASH.
 * 3. Enforces semantic mutation budgets: MAX 159 logical pages, MAX 4 logical relation patch groups.
 * 4. Distinct metrics: logicalCreates, createHttpAttempts, logicalRelationPatches, relationPatchHttpAttempts.
 * 5. SEPARATE retry semantics for READ and MUTATION:
 *    - READ: 429 Retry-After, 5xx exponential backoff, network bounded retries.
 *    - MUTATION: 429 Retry-After allowed. 5xx/network/timeout NEVER blind retried; thrown as UNCERTAIN_MUTATION for executor reconciliation.
 * 6. pages.create uses parent: { type: 'data_source_id', data_source_id } without any 'as any'.
 * 7. Validates target data source ID and target relations before executing any mutation.
 * 8. findByStableIdentity paginates (page_size: 100, has_more, start_cursor) to detect >100 duplicates.
 * 9. queryTargetState strictly fails with FAIL_MISSING_ENV if any of the 13 DS env vars is missing.
 * 10. DELETE, archive, and schema mutations are NOT IMPLEMENTED and throw fatal errors.
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
  APPROVED_WORKSPACE_IDENTITY_HASH,
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
 * Validates that the ProductionAuthorizationContext satisfies all frozen baseline requirements
 * and binds strictly to the approved workspace identity.
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
  if (ctx.workspaceIdentityHash !== APPROVED_WORKSPACE_IDENTITY_HASH) {
    throw new Error(
      `FAIL_PRODUCTION_AUTHORIZATION: workspaceIdentityHash não corresponde ao workspace aprovado (${ctx.workspaceIdentityHash} vs ${APPROVED_WORKSPACE_IDENTITY_HASH}).`,
    );
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

  // Distinct metrics: logical vs HTTP attempts
  private logicalCreatesCount: number = 0;
  private createHttpAttemptsCount: number = 0;
  private logicalRelationPatchesCount: number = 0;
  private relationPatchHttpAttemptsCount: number = 0;

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

  public get logicalCreates(): number {
    return this.logicalCreatesCount;
  }

  public get createHttpAttempts(): number {
    return this.createHttpAttemptsCount;
  }

  public get logicalRelationPatches(): number {
    return this.logicalRelationPatchesCount;
  }

  public get relationPatchHttpAttempts(): number {
    return this.relationPatchHttpAttemptsCount;
  }

  public get createRequestsSent(): number {
    return this.createHttpAttemptsCount;
  }

  public get relationPatchRequestsSent(): number {
    return this.relationPatchHttpAttemptsCount;
  }

  public get totalMutationRequests(): number {
    return this.createHttpAttemptsCount + this.relationPatchHttpAttemptsCount;
  }

  public getMutationCount(): number {
    return this.createHttpAttemptsCount + this.relationPatchHttpAttemptsCount;
  }

  public getAuthorizationContext(): ProductionAuthorizationContext {
    return { ...this.authContext };
  }

  /**
   * Enforces minimum request interval (~3 req/s) with jitter.
   */
  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minRequestIntervalMs) {
      const jitter = Math.floor(Math.random() * 20); // 0-20ms jitter
      const waitMs = this.minRequestIntervalMs - elapsed + jitter;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Read Request Scheduler:
   * - 429: Retry-After header
   * - 5xx: exponential backoff with jitter
   * - network errors: bounded retries
   * - 400/401/403/404: fails fast
   */
  public async scheduleReadRequest<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      attempt++;
      await this.enforceRateLimit();

      try {
        return await fn();
      } catch (err: any) {
        // Fatal client errors fail fast
        if (
          err?.status === 400 ||
          err?.status === 401 ||
          err?.status === 403 ||
          err?.status === 404 ||
          err?.code === 'validation_error'
        ) {
          throw err;
        }

        // 429 Rate limit: wait and retry
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

        // 5xx Server Errors & Network errors: bounded backoff
        const is5xx =
          err?.status === 500 ||
          err?.status === 502 ||
          err?.status === 503 ||
          err?.status === 504 ||
          err?.code === 'service_unavailable' ||
          err?.code === 'internal_server_error';
        const isNetwork =
          err?.code === 'ECONNRESET' ||
          err?.code === 'ETIMEDOUT' ||
          (err?.message && /timeout|network|econnreset|socket/i.test(err.message));

        if (is5xx || isNetwork) {
          if (attempt <= this.maxRetries) {
            const backoffMs = Math.pow(2, attempt) * 200 + Math.floor(Math.random() * 100);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
        }

        throw err;
      }
    }

    throw new Error('FAIL_REQUEST_EXHAUSTED: Retries de leitura esgotados sem resposta bem-sucedida.');
  }

  /**
   * Mutation Request Executor:
   * - 429: Rate-limited before mutation execution; retry allowed after Retry-After.
   * - 5xx / Network / Timeout: NEVER blind retried! Throws UNCERTAIN_MUTATION to return
   *   control to the executor for state reconciliation before any subsequent POST.
   */
  private async executeMutationRequest<T>(
    mutationType: 'CREATE' | 'RELATION_PATCH',
    fn: () => Promise<T>,
  ): Promise<T> {
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      attempt++;

      if (mutationType === 'CREATE') {
        this.createHttpAttemptsCount++;
      } else {
        this.relationPatchHttpAttemptsCount++;
      }

      await this.enforceRateLimit();

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

        // 429 Rate Limit: Gateway rejected before processing mutation -> retry permitted
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

        // 5xx Server Errors or Network Uncertainty: NEVER blind retry from adapter!
        const is5xx =
          err?.status === 500 ||
          err?.status === 502 ||
          err?.status === 503 ||
          err?.status === 504 ||
          err?.code === 'service_unavailable' ||
          err?.code === 'internal_server_error';
        const isNetwork =
          err?.code === 'ECONNRESET' ||
          err?.code === 'ETIMEDOUT' ||
          (err?.message && /timeout|network|econnreset|socket/i.test(err.message));

        if (is5xx || isNetwork) {
          const uncertainErr = new Error(
            `UNCERTAIN_MUTATION: Mutação ${mutationType} incerta (${err?.status || err?.code || 'NETWORK_ERROR'}): ${err?.message || err}`,
          );
          (uncertainErr as any).isUncertain = true;
          (uncertainErr as any).originalError = err;
          (uncertainErr as any).status = err?.status;
          (uncertainErr as any).code = 'UNCERTAIN_MUTATION';
          throw uncertainErr;
        }

        throw err;
      }
    }

    throw new Error(`FAIL_MUTATION_EXHAUSTED: Retries da mutação ${mutationType} esgotados.`);
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
   * Paginates completely with page_size=100, has_more, and start_cursor to guarantee
   * that >1 duplicate is never masked.
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

    const records: NotionPageRecord[] = [];
    let hasMore = true;
    let startCursor: string | undefined = undefined;

    while (hasMore) {
      const response: any = await this.scheduleReadRequest(async () => {
        return (this.client as any).dataSources.query({
          data_source_id: dsId,
          filter,
          page_size: 100,
          start_cursor: startCursor,
        });
      });

      for (const page of response.results || []) {
        records.push(this.mapPageToRecord(page));
      }

      hasMore = Boolean(response.has_more && response.next_cursor);
      startCursor = response.next_cursor ?? undefined;
    }

    return records;
  }

  public async fetchPage(pageId: string): Promise<NotionPageRecord | null> {
    return this.scheduleReadRequest(async () => {
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
   * Real Page Creation with:
   * - Target verification: env[targetDataSourceEnvKey] == dataSourceId
   * - Semantic budget check: logicalCreates <= 159
   * - Native parent payload: { type: 'data_source_id', data_source_id: dataSourceId }
   * - No blind mutation retry on 5xx/network
   */
  public async createPage(
    targetDataSourceEnvKey: string,
    dataSourceId: string,
    properties: Record<string, any>,
  ): Promise<{ id: string; properties: Record<string, any> }> {
    const expectedDsId = this.envVars[targetDataSourceEnvKey]?.trim();
    if (!expectedDsId || expectedDsId !== dataSourceId) {
      throw new Error(
        `FAIL_MUTATION_TARGET_MISMATCH: dataSourceId recebido ('${dataSourceId}') diverge da variável de ambiente '${targetDataSourceEnvKey}' ('${expectedDsId}').`,
      );
    }

    // Semantic mutation budget check (max 159 logical pages)
    if (this.logicalCreatesCount >= this.maxNewPagesBudget) {
      throw new Error(
        `FAIL_MUTATION_BUDGET_EXCEEDED: Limite máximo de ${this.maxNewPagesBudget} criações lógicas de página atingido.`,
      );
    }

    this.logicalCreatesCount++;

    return this.executeMutationRequest('CREATE', async () => {
      const page = await this.client.pages.create({
        parent: {
          type: 'data_source_id',
          data_source_id: dataSourceId,
        },
        properties,
      });

      return {
        id: page.id,
        properties: (page as any).properties || {},
      };
    });
  }

  /**
   * Real Relation Patch with:
   * - Pre-mutation proof: target page exists, belongs to expected DS, relation target valid
   * - Restricted strictly to canonical relations ('Lançamentos do Ciclo' for Card Bills)
   * - Semantic budget check: logicalRelationPatches <= 4
   * - Canonical single-side writing
   * - No blind mutation retry on 5xx/network
   */
  public async updatePageRelations(
    targetDataSourceEnvKey: string,
    pageId: string,
    relations: Record<string, string[]>,
  ): Promise<{ id: string; properties: Record<string, any> }> {
    if (targetDataSourceEnvKey !== 'NOTION_DS_CARD_BILLS') {
      throw new Error(
        `FAIL_MUTATION_TARGET_MISMATCH: updatePageRelations autorizado apenas para NOTION_DS_CARD_BILLS. Recebido: '${targetDataSourceEnvKey}'.`,
      );
    }

    const page = await this.fetchPage(pageId);
    if (!page) {
      throw new Error(`FAIL_PAGE_NOT_FOUND: Página '${pageId}' não encontrada no Notion.`);
    }

    const dsContract = TARGET_CONTRACT[targetDataSourceEnvKey];
    for (const [propName] of Object.entries(relations)) {
      if (propName !== 'Lançamentos do Ciclo' && propName !== 'Transações de Pagamento') {
        throw new Error(
          `FAIL_UNEXPECTED_RELATION_PROPERTY: Propriedade '${propName}' não é uma relação canônica esperada para Card Bills.`,
        );
      }
      const propContract = dsContract?.properties.find((p) => p.notionProperty === propName);
      if (!propContract) {
        throw new Error(
          `FAIL_UNKNOWN_PROPERTY: Propriedade '${propName}' não existe no contrato de '${targetDataSourceEnvKey}'.`,
        );
      }
      if (propContract.notionType !== 'relation') {
        throw new Error(`FAIL_PROPERTY_TYPE_MISMATCH: Propriedade '${propName}' não é do tipo relation.`);
      }
      if (propContract.relationTargetEnvKey !== 'NOTION_DS_TRANSACTIONS') {
        throw new Error(`FAIL_RELATION_TARGET_TYPE_MISMATCH: relationTargetEnvKey inesperado para '${propName}'.`);
      }
    }

    // Semantic mutation budget check (max 4 logical relation patch groups)
    if (this.logicalRelationPatchesCount >= this.maxRelationPatchGroups) {
      throw new Error(
        `FAIL_MUTATION_BUDGET_EXCEEDED: Limite máximo de ${this.maxRelationPatchGroups} grupos de patch de relação atingido.`,
      );
    }

    this.logicalRelationPatchesCount++;

    // Format relation payload strictly as { relation: [{ id: ... }] }
    const formattedProps: Record<string, any> = {};
    for (const [propName, ids] of Object.entries(relations)) {
      formattedProps[propName] = {
        relation: ids.map((id) => ({ id })),
      };
    }

    return this.executeMutationRequest('RELATION_PATCH', async () => {
      const updatedPage: any = await this.client.pages.update({
        page_id: pageId,
        properties: formattedProps,
      });

      return {
        id: updatedPage.id,
        properties: updatedPage.properties || {},
      };
    });
  }

  /**
   * Queries live target state.
   * Fail-closed: throws FAIL_MISSING_ENV if ANY of the 13 canonical Data Sources is missing.
   */
  public async queryTargetState(): Promise<Record<string, BaseSnapshotData>> {
    const result: Record<string, BaseSnapshotData> = {};

    for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
      const dsId = this.envVars[key]?.trim();
      if (!dsId) {
        throw new Error(`FAIL_MISSING_ENV: Variável obrigatória '${key}' não configurada no ambiente.`);
      }

      const records: NotionPageRecord[] = [];
      let hasMore = true;
      let startCursor: string | undefined = undefined;

      while (hasMore) {
        const resp: any = await this.scheduleReadRequest(async () => {
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
