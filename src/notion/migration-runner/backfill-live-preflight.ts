/**
 * Fase 2C — Preflight Real Read-Only e Verificação Rigorosa do Ambiente Live Notion
 *
 * REGRA CENTRAL:
 * ZERO CREATE live
 * ZERO UPDATE live
 * ZERO DELETE live
 * ZERO archive live
 * readyForApply = false
 *
 * Este módulo prova que o ambiente real do Notion está 100% em conformidade com o
 * plano congelado e pronto para a homologação de auditoria prévia à Fase 2D.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { Client } from '@notionhq/client';
import { TARGET_CONTRACT } from '../../domain/schema-contract';
import {
  findPropertyContract,
  serializePayloadForNotion,
  resolveStableIdentitySpec,
  calculateRecordFingerprint,
} from './backfill-serializer';
import { BackfillJournal, BackfillOperationRecord, calculateJournalFingerprint } from './backfill-journal';
import { NotionSchemaValidator } from '../schema-validator';
import { LiveNotionAdapter } from './backfill-adapter';
import { calculateTargetStateHash, BaseSnapshotData, NotionPageRecord } from './data-snapshot';
import { BackfillDryRunAnalyzer } from './backfill-dry-run';
import {
  PLAN_ORIGIN_COMMIT_SHA,
  FROZEN_BACKFILL_PLAN_HASH,
  FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_STATE_HASH,
  APPROVED_WORKSPACE_IDENTITY_HASH,
} from './backfill-constants';
import { projectExpectedBackfillState } from './backfill-executor';
import { BackfillSchemaConformanceEvidence, BackfillOperation, TypedRelationReference } from './types';

export interface LivePreflightOptions {
  client?: Client;
  envVars?: Record<string, string | undefined>;
  planOriginCommitSha?: string;
  artifactPath?: string;
  journalPath?: string;
  ttlMinutes?: number;
}

export interface ResumePreflightOptions {
  client?: Client;
  envVars?: Record<string, string | undefined>;
  runId?: string;
  planOriginCommitSha?: string;
  artifactPath?: string;
  journalPath?: string;
  ttlMinutes?: number;
}

export interface LivePreflightArtifact {
  preflightVersion: string;
  timestamp: string;
  generatedAt: string;
  expiresAt: string;
  ttlMinutes: number;
  executorCommitSha: string;
  executorParentCommitSha: string;
  planOriginCommitSha: string;
  backfillPlanHash: string;
  sourceSnapshotHash: string;
  targetSnapshotHash: string;
  frozenTargetStateHash: string;
  liveTargetStateHash: string;
  workspaceIdentityHash: string;
  actorType: string;
  schema: {
    total: number;
    verified: number;
    missing: number;
    mismatches: number;
  };
  targets: {
    transactions: number;
    bills: number;
  };
  stableIdentityConflicts: number;
  relationTargetErrors: number;
  liveMutations: number;
  readyForLiveApplyReview: boolean;
  readyForApply: boolean;
  reasons: string[];
  rowCountsByDataSource: Record<string, number>;
  existingRelationsSummary: {
    total: number;
    verified: number;
    missing: number;
    wrongTarget: number;
  };
  stableIdentitiesSummary: {
    totalChecked: number;
    conflicts: number;
    duplicates: number;
  };
  journalStatus: {
    path: string;
    exists: boolean;
    writable: boolean;
    gitIgnored: boolean;
    existingRunsCount?: number;
  };
  structuralDiff?: Array<{
    envKey: string;
    pageIdPseudonym: string;
    property: string;
    differenceType: string;
  }>;
  mutationWriteSurfaceCompatibility?: {
    executableOperationsChecked: number;
    incompatibleOperations: number;
    missingPhysicalProperties: number;
    typeMismatches: number;
    invalidSelectOptions: number;
    relationTargetMismatches: number;
  };
  canaryOperation?: {
    operationIndex: number;
    targetDataSource: string;
    physicalPropertyKeys: string[];
    everyPhysicalPropertyExists: boolean;
    stableIdentityPhysicalProperty: string;
    stableIdentityQueryValidated: boolean;
    matches: number;
    validationError: number;
  };
}

export class BackfillLivePreflight {
  private client?: Client;
  private envVars: Record<string, string | undefined>;
  private planOriginSha: string;
  private artifactPath: string;
  private journalPath: string;
  private ttlMinutes: number;

  constructor(options: LivePreflightOptions = {}) {
    this.envVars = options.envVars || (process.env as Record<string, string | undefined>);
    this.planOriginSha = options.planOriginCommitSha || PLAN_ORIGIN_COMMIT_SHA;
    this.artifactPath = options.artifactPath || path.resolve(process.cwd(), '.local', 'backfill-live-preflight.json');
    this.journalPath = options.journalPath || path.resolve(process.cwd(), '.local', 'backfill-live-journal.db');
    this.ttlMinutes = options.ttlMinutes ?? 15;

    const apiKey = this.envVars.NOTION_API_KEY?.trim();
    this.client =
      options.client ||
      (apiKey
        ? new Client({
            auth: apiKey,
            notionVersion: '2026-03-11',
          })
        : undefined);
  }

  private getGitCommitSha(): string {
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown-executor-sha';
    }
  }

  private getGitParentSha(): string {
    try {
      return execSync('git rev-parse HEAD~1', { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown-parent-sha';
    }
  }

  /**
   * Executes full Phase 2C read-only preflight against the live Notion workspace.
   */
  public async executePreflight(): Promise<LivePreflightArtifact> {
    const reasons: string[] = [];
    const now = new Date();
    const generatedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.ttlMinutes * 60 * 1000).toISOString();

    const executorCommitSha = this.getGitCommitSha();
    const executorParentCommitSha = this.getGitParentSha();

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Conectividade e Identidade do Workspace (Item 3)
    // ─────────────────────────────────────────────────────────────────────────
    if (!this.client) {
      throw new Error('FAIL_NOTION_AUTH: NOTION_API_KEY ausente ou cliente Notion não inicializado.');
    }

    let actorType = 'unknown';
    let workspaceIdentityHash = '';

    try {
      const me = await this.client.users.me({});
      actorType = me.type || (me as any).object || 'bot';
      const rawWorkspaceId = (me as any).bot?.workspace_id || (me as any).bot?.workspace_name || me.id;
      workspaceIdentityHash = crypto.createHash('sha256').update(rawWorkspaceId).digest('hex');
    } catch (err: any) {
      const status = err?.status || err?.code;
      if (status === 401 || status === 403) {
        throw new Error(
          `FAIL_NOTION_AUTH: Autenticação/autorização falhou na Notion API (${status}): ${err.message}`,
        );
      }
      throw new Error(`FAIL_LIVE_TARGET_READ: Conectividade com Notion API falhou: ${err.message}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Validação Real do Schema LIVE (Item 5)
    // ─────────────────────────────────────────────────────────────────────────
    const apiKey = this.envVars.NOTION_API_KEY?.trim() || '';
    const schemaValidator = new NotionSchemaValidator(apiKey, '2026-03-11', this.client);
    const introspectionReport = await schemaValidator.runIntrospection(this.envVars, { treatAllAsExisting: true });

    let missingPropertiesCount = 0;
    let structuralMismatchesCount = 0;

    for (const [key, dDiff] of Object.entries(introspectionReport.results)) {
      if (dDiff.status === 'MISSING_ENV_ID' || dDiff.status === 'API_ERROR' || dDiff.status === 'UNVERIFIED_NO_KEY') {
        reasons.push(`FAIL_SCHEMA_NON_CONFORMANT: Data source ${key} com status de conexão inválido: ${dDiff.status}`);
      }
      for (const p of dDiff.properties) {
        if (p.status === 'MISSING') {
          missingPropertiesCount++;
        } else if (
          p.status === 'STRUCTURAL_MISMATCH' ||
          p.status === 'TYPE_MISMATCH' ||
          p.status === 'RENAME_STRUCTURAL_MISMATCH' ||
          p.status === 'RENAME_TYPE_MISMATCH'
        ) {
          structuralMismatchesCount++;
        }
      }
    }

    // Validação explícita da dual relation: Faturas."Lançamentos do Ciclo" <-> Transações."Fatura Vinculada"
    const billsDiff = introspectionReport.results['NOTION_DS_CARD_BILLS'];
    const txDiff = introspectionReport.results['NOTION_DS_TRANSACTIONS'];
    const cycleRel = billsDiff?.properties.find((p) => p.notionProperty === 'Lançamentos do Ciclo');
    const billRel = txDiff?.properties.find((p) => p.notionProperty === 'Fatura Vinculada');

    if (!cycleRel || cycleRel.status !== 'EXACT_MATCH' || cycleRel.structuralDetails?.actualRelationType !== 'dual_property') {
      reasons.push(
        'FAIL_SCHEMA_NON_CONFORMANT: Relação dual "Lançamentos do Ciclo" na base de Faturas não é dual_property exata.',
      );
      structuralMismatchesCount++;
    }

    if (!billRel || (billRel.status !== 'EXACT_MATCH' && billRel.status !== 'RENAME_CANDIDATE')) {
      reasons.push('FAIL_SCHEMA_NON_CONFORMANT: Relação "Fatura Vinculada" na base de Transações divergente do contrato.');
      structuralMismatchesCount++;
    }

    const schemaEvidence: BackfillSchemaConformanceEvidence = {
      totalDataSources: introspectionReport.totalCanonical,
      verifiedDataSources: introspectionReport.verifiedCount,
      missingPropertiesCount,
      structuralMismatchesCount,
    };

    if (schemaEvidence.verifiedDataSources !== 13 || schemaEvidence.missingPropertiesCount > 0 || schemaEvidence.structuralMismatchesCount > 0) {
      reasons.push(
        `FAIL_SCHEMA_NON_CONFORMANT: Schema live diverge do TARGET_CONTRACT (${schemaEvidence.verifiedDataSources}/13 verificadas, ${missingPropertiesCount} ausentes, ${structuralMismatchesCount} mismatches).`,
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Leitura das 13 Bases Reais com Paginação Completa (Item 4)
    // ─────────────────────────────────────────────────────────────────────────
    const liveAdapter = new LiveNotionAdapter(this.client, this.envVars);
    let liveTargetBases: Record<string, BaseSnapshotData>;

    try {
      liveTargetBases = await liveAdapter.queryTargetState();
    } catch (err: any) {
      throw new Error(`FAIL_LIVE_TARGET_READ: Falha na leitura paginada das 13 bases live: ${err.message}`);
    }

    const liveBasesKeys = Object.keys(liveTargetBases);
    if (liveBasesKeys.length !== 13) {
      throw new Error(`FAIL_LIVE_TARGET_READ: Esperado 13 bases no Notion live, obtido ${liveBasesKeys.length}.`);
    }

    const rowCountsByDataSource: Record<string, number> = {};
    for (const [k, baseData] of Object.entries(liveTargetBases)) {
      rowCountsByDataSource[k] = baseData.recordCount;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Confirmar Estado Pristine das Bases que Receberão DML (Item 7)
    // ─────────────────────────────────────────────────────────────────────────
    const txRowCount = liveTargetBases['NOTION_DS_TRANSACTIONS']?.recordCount ?? 0;
    const billsRowCount = liveTargetBases['NOTION_DS_CARD_BILLS']?.recordCount ?? 0;

    if (txRowCount > 0 || billsRowCount > 0) {
      reasons.push(
        `PREEXISTING_BACKFILL_TARGET_DATA: Bases de escrita contêm dados prévios (Transações: ${txRowCount}, Faturas: ${billsRowCount}). O apply real exige 0 linhas.`,
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Comparar Estado Live com Snapshot Congelado (Item 6)
    // ─────────────────────────────────────────────────────────────────────────
    const liveTargetStateHash = calculateTargetStateHash(liveTargetBases);
    const structuralDiff: Array<{
      envKey: string;
      pageIdPseudonym: string;
      property: string;
      differenceType: string;
    }> = [];

    if (liveTargetStateHash !== FROZEN_TARGET_STATE_HASH) {
      reasons.push(
        `TARGET_DRIFT_DETECTED: liveTargetStateHash (${liveTargetStateHash}) diverge do snapshot congelado (${FROZEN_TARGET_STATE_HASH}).`,
      );

      // Gerar diff estrutural sanitizado sem dados financeiros
      for (const [key, baseData] of Object.entries(liveTargetBases)) {
        if (key === 'NOTION_DS_TRANSACTIONS' || key === 'NOTION_DS_CARD_BILLS') {
          if (baseData.recordCount > 0) {
            for (const r of baseData.records) {
              structuralDiff.push({
                envKey: key,
                pageIdPseudonym: crypto.createHash('sha256').update(r.id).digest('hex').substring(0, 12),
                property: '__RECORD__',
                differenceType: 'UNEXPECTED_PREEXISTING_PAGE',
              });
            }
          }
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Reproduzir o BackfillPlan a partir dos Snapshots Congelados (Item 8)
    // ─────────────────────────────────────────────────────────────────────────
    const targetAnalyzer = new BackfillDryRunAnalyzer({
      envVars: this.envVars,
      commitSha: this.planOriginSha,
      schemaEvidence,
    });
    const targetSession = targetAnalyzer.prepareValidatedTargetSnapshot();
    const frozenBases: Record<string, BaseSnapshotData> = JSON.parse(JSON.stringify(targetSession.payload.bases));
    targetSession.cleanup();

    const analyzer = new BackfillDryRunAnalyzer({
      envVars: this.envVars,
      commitSha: this.planOriginSha,
      schemaEvidence,
      liveBases: frozenBases,
    });

    const analysisReport = await analyzer.runAnalysis();
    const plan = analysisReport.planArtifact;

    if (plan.backfillPlanHash !== FROZEN_BACKFILL_PLAN_HASH) {
      reasons.push(
        `FAIL_FROZEN_PLAN_MISMATCH: reproducedBackfillPlanHash (${plan.backfillPlanHash}) diverge do hash congelado (${FROZEN_BACKFILL_PLAN_HASH}).`,
      );
    }

    if (plan.summary.executableCreateCount !== 159 || plan.summary.executableUpdateCount !== 0) {
      reasons.push(
        `FAIL_PLAN_COUNTS_MISMATCH: Esperado 159 CREATE e 0 UPDATE, obtido ${plan.summary.executableCreateCount} / ${plan.summary.executableUpdateCount}.`,
      );
    }

    let totalLogicalRelations = 0;
    for (const op of plan.operations as BackfillOperation[]) {
      for (const refs of Object.values(op.relations) as TypedRelationReference[][]) {
        totalLogicalRelations += refs.length;
      }
    }
    if (totalLogicalRelations !== 320) {
      reasons.push(
        `FAIL_LOGICAL_RELATIONS_COUNT: Esperado 320 referências lógicas de relação, obtido ${totalLogicalRelations}.`,
      );
    }

    const cardBillOps = (plan.operations as BackfillOperation[]).filter(
      (o: BackfillOperation) => o.targetDataSource.envKey === 'NOTION_DS_CARD_BILLS',
    );
    if (cardBillOps.length !== 4) {
      reasons.push(`FAIL_RELATION_PATCH_GROUPS: Esperado 4 grupos de patch de fatura, obtido ${cardBillOps.length}.`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Validar todas as EXISTING_PAGE_ID contra o Notion Live (Item 9)
    // ─────────────────────────────────────────────────────────────────────────
    let existingRelationReferences = 0;
    let verifiedExistingRelationReferences = 0;
    let missingExistingRelationReferences = 0;
    let wrongTargetRelationReferences = 0;

    for (const op of plan.operations as BackfillOperation[]) {
      for (const [relProp, refList] of Object.entries(op.relations) as [string, TypedRelationReference[]][]) {
        for (const ref of refList) {
          if (ref.type === 'EXISTING_PAGE_ID') {
            existingRelationReferences++;
            const contractProp = findPropertyContract(op.targetDataSource.envKey, relProp);
            const expectedTargetEnvKey = contractProp?.relationTargetEnvKey;

            if (!expectedTargetEnvKey || !liveTargetBases[expectedTargetEnvKey]) {
              wrongTargetRelationReferences++;
              reasons.push(
                `FAIL_RELATION_TARGET_CONFIG: Propriedade ${relProp} em ${op.targetDataSource.envKey} aponta para base inexistente ${expectedTargetEnvKey}.`,
              );
              continue;
            }

            const targetBase = liveTargetBases[expectedTargetEnvKey];
            const targetPage = targetBase.records.find((r) => r.id === ref.target);

            if (!targetPage || targetPage.archived) {
              missingExistingRelationReferences++;
              reasons.push(
                `FAIL_RELATION_TARGET_MISSING: Página referenciada ${ref.target} em ${expectedTargetEnvKey} não existe ou está arquivada no Notion live.`,
              );
            } else {
              verifiedExistingRelationReferences++;
            }
          }
        }
      }
    }

    if (missingExistingRelationReferences > 0 || wrongTargetRelationReferences > 0) {
      reasons.push(
        `FAIL_EXISTING_RELATIONS: ${missingExistingRelationReferences} páginas de relação ausentes e ${wrongTargetRelationReferences} alvos incorretos detectados.`,
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. Validar Stable Identities antes do Apply (Item 10)
    // ─────────────────────────────────────────────────────────────────────────
    let stableIdentityConflicts = 0;
    let duplicateStableIds = 0;

    const txBase = liveTargetBases['NOTION_DS_TRANSACTIONS'];
    const billsBase = liveTargetBases['NOTION_DS_CARD_BILLS'];

    for (const op of plan.operations) {
      const idSpec = resolveStableIdentitySpec(op);
      if (op.targetDataSource.envKey === 'NOTION_DS_TRANSACTIONS') {
        const matches = txBase.records.filter(
          (r) =>
            r.properties[idSpec.physicalProperty] === op.stableId ||
            r.properties[idSpec.canonicalProperty] === op.stableId,
        );
        if (matches.length === 1) {
          stableIdentityConflicts++;
          reasons.push(`PREEXISTING_STABLE_ID: ${idSpec.physicalProperty} '${op.stableId}' já existe no Notion live.`);
        } else if (matches.length > 1) {
          duplicateStableIds++;
          reasons.push(
            `DUPLICATE_STABLE_ID: ${idSpec.physicalProperty} '${op.stableId}' duplicado (${matches.length} páginas) no Notion live.`,
          );
        }
      } else if (op.targetDataSource.envKey === 'NOTION_DS_CARD_BILLS') {
        const matches = billsBase.records.filter(
          (r) =>
            r.properties[idSpec.physicalProperty] === op.stableId ||
            r.properties[idSpec.canonicalProperty] === op.stableId,
        );
        if (matches.length === 1) {
          stableIdentityConflicts++;
          reasons.push(`PREEXISTING_STABLE_ID: ${idSpec.physicalProperty} '${op.stableId}' já existe no Notion live.`);
        } else if (matches.length > 1) {
          duplicateStableIds++;
          reasons.push(
            `DUPLICATE_STABLE_ID: ${idSpec.physicalProperty} '${op.stableId}' duplicado (${matches.length} páginas) no Notion live.`,
          );
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8.1. Exact Write Surface Check: mutationWriteSurfaceCompatibility (Fase 2D)
    // ─────────────────────────────────────────────────────────────────────────
    let executableOperationsChecked = 0;
    let incompatibleOperations = 0;
    let missingPhysicalProperties = 0;
    let typeMismatches = 0;
    let invalidSelectOptions = 0;
    let relationTargetMismatches = 0;

    const liveSchemaByEnvKey: Record<string, Record<string, any>> = {};
    const writeTargetKeys = ['NOTION_DS_TRANSACTIONS', 'NOTION_DS_CARD_BILLS'];

    for (const targetKey of writeTargetKeys) {
      const targetDsId = this.envVars[targetKey]?.trim();
      if (targetDsId) {
        try {
          liveSchemaByEnvKey[targetKey] = await schemaValidator.fetchDataSourceProperties(targetDsId);
        } catch (err: any) {
          if (this.client || apiKey) {
            reasons.push(
              `FAIL_SCHEMA_INTROSPECTION: Não foi possível obter schema físico de ${targetKey}: ${err.message}`,
            );
          }
        }
      }
    }

    for (const op of plan.operations as BackfillOperation[]) {
      if (op.operationType !== 'CREATE') continue;
      executableOperationsChecked++;

      const envKey = op.targetDataSource.envKey;
      const liveSchema = liveSchemaByEnvKey[envKey];

      if (liveSchema) {
        const existingRelations: Record<string, string[]> = {};
        for (const [propName, refList] of Object.entries(op.relations)) {
          const existingIds = (refList as any[])
            .filter((r) => r.type === 'EXISTING_PAGE_ID')
            .map((r) => r.target);
          if (existingIds.length > 0) {
            existingRelations[propName] = existingIds;
          }
        }

        let serialized: { notionProperties: Record<string, any> };
        try {
          serialized = serializePayloadForNotion(
            envKey,
            op.sanitizedPayload,
            existingRelations,
            true,
          );
        } catch (err: any) {
          incompatibleOperations++;
          reasons.push(
            `FAIL_SERIALIZE_STAGE1: Falha ao serializar payload da op ${op.stableId}: ${err.message}`,
          );
          continue;
        }

        let opHasIncompatibility = false;

        for (const [propKey, propVal] of Object.entries(serialized.notionProperties)) {
          const liveProp = liveSchema[propKey];
          if (!liveProp) {
            missingPhysicalProperties++;
            opHasIncompatibility = true;
            continue;
          }

          let expectedNotionType = 'unknown';
          if ('title' in propVal) expectedNotionType = 'title';
          else if ('rich_text' in propVal) expectedNotionType = 'rich_text';
          else if ('number' in propVal) expectedNotionType = 'number';
          else if ('select' in propVal) expectedNotionType = 'select';
          else if ('multi_select' in propVal) expectedNotionType = 'multi_select';
          else if ('date' in propVal) expectedNotionType = 'date';
          else if ('checkbox' in propVal) expectedNotionType = 'checkbox';
          else if ('relation' in propVal) expectedNotionType = 'relation';

          if (liveProp.type !== expectedNotionType) {
            typeMismatches++;
            opHasIncompatibility = true;
          }

          if (expectedNotionType === 'select' && propVal.select && propVal.select.name) {
            const optName = propVal.select.name;
            if (liveProp.selectOptions && !liveProp.selectOptions.includes(optName)) {
              invalidSelectOptions++;
              opHasIncompatibility = true;
            }
          }

          if (expectedNotionType === 'relation') {
            const contractProp = findPropertyContract(envKey, propKey);
            const expTargetKey = contractProp?.relationTargetEnvKey;
            if (expTargetKey) {
              const expTargetDsId = this.envVars[expTargetKey]?.trim().replace(/-/g, '').toLowerCase();
              const actualDsId = liveProp.relationDataSourceId?.replace(/-/g, '').toLowerCase();
              const actualDbId = liveProp.relationDatabaseId?.replace(/-/g, '').toLowerCase();
              if (
                expTargetDsId &&
                actualDsId !== expTargetDsId &&
                actualDbId !== expTargetDsId
              ) {
                relationTargetMismatches++;
                opHasIncompatibility = true;
              }
            }
          }
        }

        if (opHasIncompatibility) {
          incompatibleOperations++;
        }
      }
    }

    if (
      incompatibleOperations > 0 ||
      missingPhysicalProperties > 0 ||
      typeMismatches > 0 ||
      invalidSelectOptions > 0 ||
      relationTargetMismatches > 0
    ) {
      reasons.push(
        `FAIL_WRITE_SURFACE_INCOMPATIBLE: Exact write surface check falhou (${incompatibleOperations} ops incompatíveis, ${missingPhysicalProperties} props ausentes, ${typeMismatches} types divergentes, ${invalidSelectOptions} opções inválidas, ${relationTargetMismatches} relation targets incorretos).`,
      );
    }

    const mutationWriteSurfaceCompatibility = {
      executableOperationsChecked,
      incompatibleOperations,
      missingPhysicalProperties,
      typeMismatches,
      invalidSelectOptions,
      relationTargetMismatches,
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 8.2. Operation 0 Read-Only Identity Query Test (Canary Safe Read)
    // ─────────────────────────────────────────────────────────────────────────
    const op0 = (plan.operations as BackfillOperation[])[0];
    const op0EnvKey = op0.targetDataSource.envKey;
    const op0IdSpec = resolveStableIdentitySpec(op0);

    const op0ExistingRelations: Record<string, string[]> = {};
    for (const [propName, refList] of Object.entries(op0.relations)) {
      const existingIds = (refList as any[])
        .filter((r) => r.type === 'EXISTING_PAGE_ID')
        .map((r) => r.target);
      if (existingIds.length > 0) {
        op0ExistingRelations[propName] = existingIds;
      }
    }

    const op0Serialized = serializePayloadForNotion(
      op0EnvKey,
      op0.sanitizedPayload,
      op0ExistingRelations,
      true,
    );

    const op0PhysicalPropertyKeys = Object.keys(op0Serialized.notionProperties).sort();
    const op0LiveSchema = liveSchemaByEnvKey[op0EnvKey] || {};
    const op0EveryPhysicalPropertyExists =
      Object.keys(op0LiveSchema).length > 0
        ? op0PhysicalPropertyKeys.every((k) => op0LiveSchema[k] !== undefined)
        : true;

    let op0Matches = 0;
    let op0ValidationError = 0;
    let op0QueryValidated = false;

    try {
      const matches = await liveAdapter.findByStableIdentity(
        op0EnvKey,
        op0IdSpec.physicalProperty,
        op0.stableId,
      );
      op0Matches = matches.length;
      op0QueryValidated = true;
    } catch (err: any) {
      op0ValidationError++;
      reasons.push(
        `FAIL_CANARY_STABLE_IDENTITY_QUERY: Erro na query read-only da op 0 com property '${op0IdSpec.physicalProperty}': ${err.message}`,
      );
    }

    if (!op0EveryPhysicalPropertyExists) {
      const missingKeys = op0PhysicalPropertyKeys.filter((k) => op0LiveSchema[k] === undefined);
      reasons.push(
        `FAIL_CANARY_PHYSICAL_PROPERTIES_MISSING: Propriedades da op 0 ausentes no schema live: [${missingKeys.join(', ')}].`,
      );
    }

    if (op0Matches > 0) {
      reasons.push(
        `PREEXISTING_CANARY_PAGE: Query read-only da op 0 retornou ${op0Matches} páginas existentes para stableId '${op0.stableId}'.`,
      );
    }

    const canaryOperation = {
      operationIndex: 0,
      targetDataSource: op0EnvKey,
      physicalPropertyKeys: op0PhysicalPropertyKeys,
      everyPhysicalPropertyExists: op0EveryPhysicalPropertyExists,
      stableIdentityPhysicalProperty: op0IdSpec.physicalProperty,
      stableIdentityQueryValidated: op0QueryValidated,
      matches: op0Matches,
      validationError: op0ValidationError,
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 9. Validar Journal de Produção Vazio / Segregado (Item 14)
    // ─────────────────────────────────────────────────────────────────────────
    const journalDir = path.dirname(this.journalPath);
    if (!fs.existsSync(journalDir)) {
      fs.mkdirSync(journalDir, { recursive: true });
    }

    // Testar se o diretório é gravável
    let isDirWritable = false;
    try {
      const probeFile = path.join(journalDir, `.probe-${Date.now()}`);
      fs.writeFileSync(probeFile, 'probe');
      fs.unlinkSync(probeFile);
      isDirWritable = true;
    } catch {
      isDirWritable = false;
      reasons.push(`FAIL_JOURNAL_PATH: Diretório do journal ${journalDir} não possui permissão de escrita.`);
    }

    // Checar se .local/ está no .gitignore
    const gitignorePath = path.resolve(process.cwd(), '.gitignore');
    let isGitIgnored = false;
    if (fs.existsSync(gitignorePath)) {
      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
      isGitIgnored = gitignoreContent.includes('.local') || gitignoreContent.includes('.local/');
    }
    if (!isGitIgnored) {
      reasons.push(`FAIL_JOURNAL_SECURITY: O diretório do journal ${journalDir} não está coberto pelo .gitignore.`);
    }

    const journalExists = fs.existsSync(this.journalPath);
    let existingRunsCount: number | undefined = undefined;

    if (journalExists) {
      try {
        const db = new Database(this.journalPath, { readonly: true });
        const row = db.prepare('SELECT count(*) as count FROM sqlite_master WHERE type="table" AND name="backfill_runs"').get() as any;
        if (row?.count > 0) {
          const runCountRow = db.prepare('SELECT count(*) as count FROM backfill_runs').get() as any;
          existingRunsCount = runCountRow?.count ?? 0;
        }
        db.close();
      } catch (err: any) {
        reasons.push(`FAIL_JOURNAL_READ: Não foi possível ler o journal existente em ${this.journalPath}: ${err.message}`);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 10. Mutações Live (Item 2 & 11: devem ser estritamente 0)
    // ─────────────────────────────────────────────────────────────────────────
    const liveMutations = liveAdapter.getMutationCount();
    if (liveMutations !== 0) {
      reasons.push(`FAIL_LIVE_MUTATIONS_DETECTED: Detectadas ${liveMutations} mutações live.`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 11. Conclusão Final e Artefato de Autorização Read-Only (Itens 15, 16, 17, 18)
    // ─────────────────────────────────────────────────────────────────────────
    const readyForLiveApplyReview = reasons.length === 0 && liveMutations === 0;
    const readyForApply = false; // Estritamente false durante toda a Fase 2C

    const artifact: LivePreflightArtifact = {
      preflightVersion: '1.0.0',
      timestamp: generatedAt,
      generatedAt,
      expiresAt,
      ttlMinutes: this.ttlMinutes,
      executorCommitSha,
      executorParentCommitSha,
      planOriginCommitSha: this.planOriginSha,
      backfillPlanHash: plan.backfillPlanHash,
      sourceSnapshotHash: plan.sourceSnapshotHash,
      targetSnapshotHash: plan.targetNotionSnapshotHash,
      frozenTargetStateHash: FROZEN_TARGET_STATE_HASH,
      liveTargetStateHash,
      workspaceIdentityHash,
      actorType,
      schema: {
        total: schemaEvidence.totalDataSources,
        verified: schemaEvidence.verifiedDataSources,
        missing: schemaEvidence.missingPropertiesCount,
        mismatches: schemaEvidence.structuralMismatchesCount,
      },
      targets: {
        transactions: txRowCount,
        bills: billsRowCount,
      },
      stableIdentityConflicts: stableIdentityConflicts + duplicateStableIds,
      relationTargetErrors: missingExistingRelationReferences + wrongTargetRelationReferences,
      liveMutations,
      readyForLiveApplyReview,
      readyForApply,
      reasons,
      rowCountsByDataSource,
      existingRelationsSummary: {
        total: existingRelationReferences,
        verified: verifiedExistingRelationReferences,
        missing: missingExistingRelationReferences,
        wrongTarget: wrongTargetRelationReferences,
      },
      stableIdentitiesSummary: {
        totalChecked: 159,
        conflicts: stableIdentityConflicts,
        duplicates: duplicateStableIds,
      },
      journalStatus: {
        path: this.journalPath,
        exists: journalExists,
        writable: isDirWritable,
        gitIgnored: isGitIgnored,
        existingRunsCount,
      },
      structuralDiff: structuralDiff.length > 0 ? structuralDiff : undefined,
      mutationWriteSurfaceCompatibility,
      canaryOperation,
    };

    // Gravação segura e atômica do artefato .local/backfill-live-preflight.json
    const artifactDir = path.dirname(this.artifactPath);
    if (!fs.existsSync(artifactDir)) {
      fs.mkdirSync(artifactDir, { recursive: true });
    }
    fs.writeFileSync(this.artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

    return artifact;
  }
}

/**
 * Valida se um artefato de preflight ainda está dentro de sua janela de TTL (Item 4).
 */
export function isPreflightValid(
  artifact: LivePreflightArtifact,
  maxAgeMs: number = 15 * 60 * 1000,
): { valid: boolean; reason?: string } {
  if (!artifact.generatedAt || !artifact.expiresAt) {
    return { valid: false, reason: 'LIVE_PREFLIGHT_INVALID_TIME: generatedAt ou expiresAt ausentes no artefato.' };
  }

  const generatedTime = new Date(artifact.generatedAt).getTime();
  const expiresTime = new Date(artifact.expiresAt).getTime();

  if (isNaN(generatedTime) || isNaN(expiresTime)) {
    return { valid: false, reason: 'LIVE_PREFLIGHT_INVALID_TIME: Formato de timestamp ISO inválido no artefato.' };
  }

  const now = Date.now();
  const CLOCK_TOLERANCE_MS = 60 * 1000; // 60s tolerância para clock skew

  // 1. generatedAt no futuro além da tolerância
  if (generatedTime > now + CLOCK_TOLERANCE_MS) {
    return { valid: false, reason: 'LIVE_PREFLIGHT_INVALID_TIME: generatedAt no futuro detectado além da tolerância permitida (60s).' };
  }

  // 2. expiresAt já passou
  if (expiresTime <= now) {
    return { valid: false, reason: 'LIVE_PREFLIGHT_EXPIRED: O preflight expirou (expiresAt <= now). Novo preflight read-only exigido.' };
  }

  // 3. Idade desde generatedAt excede maxAgeMs
  if (now - generatedTime > maxAgeMs) {
    return { valid: false, reason: 'LIVE_PREFLIGHT_EXPIRED: O preflight expirou (> 15 minutos). Novo preflight read-only exigido.' };
  }

  // 4. Consistência do intervalo expiresAt - generatedAt
  const ttlWindow = expiresTime - generatedTime;
  if (ttlWindow <= 0 || ttlWindow > maxAgeMs + CLOCK_TOLERANCE_MS) {
    return { valid: false, reason: 'LIVE_PREFLIGHT_INVALID_TIME: Janela de expiração (expiresAt - generatedAt) inconsistente ou adulterada.' };
  }

  return { valid: true };
}

/**
 * Valida a integridade criptográfica de binding do artefato contra a baseline congelada (Item 17).
 */
export function validatePreflightBinding(
  artifact: LivePreflightArtifact,
  expected: {
    executorCommitSha?: string;
    planOriginCommitSha?: string;
    backfillPlanHash?: string;
    sourceSnapshotHash?: string;
    targetSnapshotHash?: string;
    targetStateHash?: string;
    workspaceIdentityHash?: string;
  } = {},
): { valid: boolean; reason?: string } {
  // Exigir estritamente que o artefato esteja GREEN antes de qualquer autorização de write
  if (artifact.readyForLiveApplyReview !== true) {
    return { valid: false, reason: 'FAIL_PREFLIGHT_NOT_REVIEW_READY: Artefato de preflight não está marcado como readyForLiveApplyReview === true.' };
  }
  if (artifact.readyForApply !== false) {
    return { valid: false, reason: 'FAIL_PREFLIGHT_INVALID_APPLY_FLAG: Artefato de preflight deve ter readyForApply === false.' };
  }
  if (!Array.isArray(artifact.reasons) || artifact.reasons.length > 0) {
    return { valid: false, reason: `FAIL_PREFLIGHT_REASONS_NOT_EMPTY: Preflight contém razões de bloqueio (${(artifact.reasons || []).join(', ')}).` };
  }
  if (artifact.liveMutations === undefined || artifact.liveMutations !== 0) {
    return { valid: false, reason: `FAIL_PREFLIGHT_MUTATIONS_NOT_ZERO: Preflight registrou mutações live (${artifact.liveMutations}).` };
  }
  if (
    !artifact.schema ||
    artifact.schema.total !== 13 ||
    artifact.schema.verified !== 13 ||
    artifact.schema.missing !== 0 ||
    artifact.schema.mismatches !== 0
  ) {
    return {
      valid: false,
      reason: `FAIL_PREFLIGHT_SCHEMA_NOT_CLEAN: Schema ausente ou verificação incompleta/com erros (total: ${artifact.schema?.total}, verified: ${artifact.schema?.verified}, missing: ${artifact.schema?.missing}, mismatches: ${artifact.schema?.mismatches}).`,
    };
  }
  if (artifact.stableIdentityConflicts === undefined || artifact.stableIdentityConflicts !== 0) {
    return { valid: false, reason: `FAIL_PREFLIGHT_IDENTITY_CONFLICTS: Preflight detectou ${artifact.stableIdentityConflicts} conflitos de stable identity.` };
  }
  if (artifact.relationTargetErrors === undefined || artifact.relationTargetErrors !== 0) {
    return { valid: false, reason: `FAIL_PREFLIGHT_RELATION_ERRORS: Preflight detectou ${artifact.relationTargetErrors} erros de relation target.` };
  }
  if (!artifact.targets || artifact.targets.transactions !== 0 || artifact.targets.bills !== 0) {
    return { valid: false, reason: `FAIL_PREFLIGHT_TARGETS_NOT_PRISTINE: Targets ausentes ou não pristine (transactions: ${artifact.targets?.transactions}, bills: ${artifact.targets?.bills}).` };
  }

  if (!artifact.mutationWriteSurfaceCompatibility) {
    return {
      valid: false,
      reason: 'FAIL_PREFLIGHT_WRITE_SURFACE_INCOMPATIBLE: mutationWriteSurfaceCompatibility é obrigatório no artefato de preflight.',
    };
  }
  if (
    artifact.mutationWriteSurfaceCompatibility.incompatibleOperations !== 0 ||
    artifact.mutationWriteSurfaceCompatibility.missingPhysicalProperties !== 0 ||
    artifact.mutationWriteSurfaceCompatibility.typeMismatches !== 0 ||
    artifact.mutationWriteSurfaceCompatibility.invalidSelectOptions !== 0 ||
    artifact.mutationWriteSurfaceCompatibility.relationTargetMismatches !== 0
  ) {
    return {
      valid: false,
      reason: `FAIL_PREFLIGHT_WRITE_SURFACE_INCOMPATIBLE: mutationWriteSurfaceCompatibility possui erros (${artifact.mutationWriteSurfaceCompatibility.incompatibleOperations} incompatíveis, ${artifact.mutationWriteSurfaceCompatibility.missingPhysicalProperties} props ausentes).`,
    };
  }

  if (!artifact.canaryOperation) {
    return {
      valid: false,
      reason: 'FAIL_PREFLIGHT_CANARY_OP_INVALID: canaryOperation é obrigatório no artefato de preflight.',
    };
  }
  if (
    !artifact.canaryOperation.everyPhysicalPropertyExists ||
    !artifact.canaryOperation.stableIdentityQueryValidated ||
    artifact.canaryOperation.matches !== 0 ||
    artifact.canaryOperation.validationError !== 0
  ) {
    return {
      valid: false,
      reason: `FAIL_PREFLIGHT_CANARY_OP_INVALID: canaryOperation falhou na validação prévia (matches: ${artifact.canaryOperation.matches}, validationError: ${artifact.canaryOperation.validationError}).`,
    };
  }

  const expPlanOrigin = expected.planOriginCommitSha || PLAN_ORIGIN_COMMIT_SHA;
  const expPlanHash = expected.backfillPlanHash || FROZEN_BACKFILL_PLAN_HASH;
  const expSource = expected.sourceSnapshotHash || FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256;
  const expTarget = expected.targetSnapshotHash || FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256;
  const expState = expected.targetStateHash || FROZEN_TARGET_STATE_HASH;

  if (artifact.planOriginCommitSha !== expPlanOrigin) {
    return { valid: false, reason: `FAIL_PREFLIGHT_BINDING_MISMATCH: planOriginCommitSha diverge (${artifact.planOriginCommitSha} vs ${expPlanOrigin}).` };
  }
  if (artifact.backfillPlanHash !== expPlanHash) {
    return { valid: false, reason: `FAIL_PREFLIGHT_BINDING_MISMATCH: backfillPlanHash diverge (${artifact.backfillPlanHash} vs ${expPlanHash}).` };
  }
  if (artifact.sourceSnapshotHash !== expSource) {
    return { valid: false, reason: `FAIL_PREFLIGHT_BINDING_MISMATCH: sourceSnapshotHash diverge (${artifact.sourceSnapshotHash} vs ${expSource}).` };
  }
  if (artifact.targetSnapshotHash !== expTarget) {
    return { valid: false, reason: `FAIL_PREFLIGHT_BINDING_MISMATCH: targetSnapshotHash diverge (${artifact.targetSnapshotHash} vs ${expTarget}).` };
  }
  if (artifact.frozenTargetStateHash !== expState) {
    return { valid: false, reason: `FAIL_PREFLIGHT_BINDING_MISMATCH: frozenTargetStateHash diverge (${artifact.frozenTargetStateHash} vs ${expState}).` };
  }
  if (expected.workspaceIdentityHash && artifact.workspaceIdentityHash !== expected.workspaceIdentityHash) {
    return { valid: false, reason: `FAIL_PREFLIGHT_BINDING_MISMATCH: workspaceIdentityHash diverge (${artifact.workspaceIdentityHash} vs ${expected.workspaceIdentityHash}).` };
  }
  if (expected.executorCommitSha && artifact.executorCommitSha !== expected.executorCommitSha) {
    return { valid: false, reason: `FAIL_PREFLIGHT_BINDING_MISMATCH: executorCommitSha diverge (${artifact.executorCommitSha} vs ${expected.executorCommitSha}).` };
  }

  return { valid: true };
}

export interface ReconciliationPreviewItem {
  operationIndex: number;
  action: string;
  currentJournalStatus: string;
  attempts: number;
  targetPageId: string | null;
  stableIdentityMatches: number;
  expectedFingerprint: string | null;
  actualNormalizedFingerprint: string | null;
  recoverable: boolean;
  previewStatus: 'RECOVERABLE_VERIFIED_PREVIEW' | 'UNRECOVERABLE';
  reason?: string;
}

export interface ResumePreflightArtifact {
  preflightVersion: string;
  type: 'RESUME_PREFLIGHT';
  timestamp: string;
  generatedAt: string;
  expiresAt: string;
  ttlMinutes: number;
  runId: string;
  runExecutorCommitSha: string;
  recoveryExecutorCommitSha: string;
  executorCommitSha: string;
  planOriginCommitSha: string;
  backfillPlanHash: string;
  journalFingerprint: string;
  projectedTargetStateHash: string;
  liveTargetStateHash: string;
  workspaceIdentityHash: string;
  actorType: string;
  verifiedOperationsCount: number;
  recoverableOperationsCount: number;
  reconciliationPreview: ReconciliationPreviewItem[];
  targets: {
    transactions: number;
    bills: number;
  };
  readyForLiveApplyReview: boolean;
  readyForApply: boolean;
  reasons: string[];
}

export { calculateJournalFingerprint } from './backfill-journal';

export class BackfillLiveResumePreflight {
  private client?: Client;
  private envVars: Record<string, string | undefined>;
  private planOriginSha: string;
  private artifactPath: string;
  private journalPath: string;
  private ttlMinutes: number;
  private runId?: string;

  constructor(options: ResumePreflightOptions = {}) {
    this.envVars = options.envVars || (process.env as Record<string, string | undefined>);
    this.planOriginSha = options.planOriginCommitSha || PLAN_ORIGIN_COMMIT_SHA;
    this.artifactPath =
      options.artifactPath || path.resolve(process.cwd(), '.local', 'backfill-live-resume-preflight.json');
    this.journalPath = options.journalPath || path.resolve(process.cwd(), '.local', 'backfill-live-journal.db');
    this.ttlMinutes = options.ttlMinutes ?? 15;
    this.runId = options.runId;

    const apiKey = this.envVars.NOTION_API_KEY?.trim();
    this.client =
      options.client ||
      (apiKey
        ? new Client({
            auth: apiKey,
            notionVersion: '2026-03-11',
          })
        : undefined);
  }

  private getGitCommitSha(): string {
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown-executor-sha';
    }
  }

  public async executeResumePreflight(): Promise<ResumePreflightArtifact> {
    const reasons: string[] = [];
    const now = new Date();
    const generatedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.ttlMinutes * 60 * 1000).toISOString();
    const recoveryExecutorCommitSha = this.getGitCommitSha();

    if (!fs.existsSync(this.journalPath)) {
      throw new Error(`FAIL_RESUME_NO_JOURNAL: Journal não encontrado em '${this.journalPath}'.`);
    }

    const journal = new BackfillJournal(this.journalPath);
    try {
      const run = this.runId ? journal.getRun(this.runId) : journal.getLatestRun();

    if (!run) {
      throw new Error('FAIL_RESUME_NO_RUN_FOUND: Nenhuma execução encontrada no journal para resume.');
    }

    if (run.status !== 'IN_PROGRESS' && run.status !== 'PAUSED_AFTER_CANARY') {
      reasons.push(
        `FAIL_RESUME_STATUS_INVALID: Status do run '${run.runId}' é '${run.status}', esperado 'PAUSED_AFTER_CANARY' ou 'IN_PROGRESS'.`,
      );
    }

    if (run.planHash !== FROZEN_BACKFILL_PLAN_HASH) {
      reasons.push(`FAIL_RESUME_PLAN_HASH_MISMATCH: planHash no journal (${run.planHash}) diverge de ${FROZEN_BACKFILL_PLAN_HASH}.`);
    }

    // 1. Workspace Identity
    let workspaceIdentityHash = 'unknown-workspace';
    let actorType = 'unknown';
    if (this.client) {
      try {
        const botUser: any = await this.client.users.me({});
        actorType = botUser?.type || 'unknown';
        const wsId = botUser?.bot?.workspace_id || botUser?.id || 'unknown';
        workspaceIdentityHash = crypto.createHash('sha256').update(wsId).digest('hex');
      } catch (err: any) {
        reasons.push(`FAIL_LIVE_WORKSPACE_AUTH: Falha na autenticação Notion: ${err.message}`);
      }
    }

    // 2. Load frozen bases and reproduce plan
    const analyzer = new BackfillDryRunAnalyzer({
      envVars: this.envVars,
      commitSha: this.planOriginSha,
    });
    const targetSession = analyzer.prepareValidatedTargetSnapshot();
    const frozenBases: Record<string, BaseSnapshotData> = JSON.parse(JSON.stringify(targetSession.payload.bases));
    targetSession.cleanup();

    const planReport = await analyzer.runAnalysis();
    const plan = planReport.planArtifact;

    // 3. Reconcile uncertain/failed writes read-only (Item 6 & 7)
    const liveAdapter = new LiveNotionAdapter(this.client || ({} as any), this.envVars);
    const ops = journal.getOperations(run.runId);
    const verifiedOps = ops.filter(
      (o) => o.status === 'VERIFIED' || o.status === 'NO_OP_VERIFIED' || o.status === 'APPLIED',
    );

    const reconciliationPreview: ReconciliationPreviewItem[] = [];
    const recoverableOps: BackfillOperationRecord[] = [];

    const uncertainOrFailed = ops.filter(
      (o) => o.status !== 'VERIFIED' && o.status !== 'NO_OP_VERIFIED' && o.attempts > 0,
    );

    for (const uOp of uncertainOrFailed) {
      if (uOp.action === 'CREATE') {
        const planOp = plan.operations[uOp.operationIndex];
        if (!planOp) continue;
        const idSpec = resolveStableIdentitySpec(planOp);
        let matches: NotionPageRecord[] = [];
        try {
          matches = await liveAdapter.findByStableIdentity(
            planOp.targetDataSource.envKey,
            idSpec.physicalProperty,
            planOp.stableId,
          );
        } catch (err: any) {
          reasons.push(`FAIL_RECOVERY_QUERY_ERROR: Erro ao consultar stable identity para op ${uOp.operationIndex}: ${err.message}`);
        }

        let actualNormalizedFingerprint: string | null = null;
        let isRecoverable = false;
        let previewReason: string | undefined = undefined;

        if (matches.length === 1) {
          actualNormalizedFingerprint = calculateRecordFingerprint(
            planOp.targetDataSource.envKey,
            matches[0].properties,
          );
          if (actualNormalizedFingerprint === uOp.expectedPostFingerprint) {
            isRecoverable = true;
            recoverableOps.push({
              ...uOp,
              status: 'VERIFIED',
              targetPageId: matches[0].id,
            });
          } else {
            previewReason = `FAIL_READ_BACK_FINGERPRINT_MISMATCH: Fingerprint live (${actualNormalizedFingerprint}) diverge do esperado (${uOp.expectedPostFingerprint}).`;
            reasons.push(`FAIL_RECOVERY_FINGERPRINT_MISMATCH: Operação ${uOp.operationIndex} tem fingerprint divergente.`);
          }
        } else if (matches.length === 0) {
          previewReason = 'FAIL_PAGE_NOT_FOUND: Nenhuma página encontrada com stableId no Notion live.';
          reasons.push(`FAIL_RECOVERY_PAGE_NOT_FOUND: Nenhuma página encontrada para op ${uOp.operationIndex} no Notion.`);
        } else {
          previewReason = `FAIL_DUPLICATE_STABLE_ID: ${matches.length} páginas encontradas com mesmo stableId.`;
          reasons.push(`FAIL_RECOVERY_DUPLICATE: Múltiplas páginas para op ${uOp.operationIndex} no Notion.`);
        }

        reconciliationPreview.push({
          operationIndex: uOp.operationIndex,
          action: uOp.action,
          currentJournalStatus: uOp.status,
          attempts: uOp.attempts,
          targetPageId: uOp.targetPageId || (matches[0] ? matches[0].id : null),
          stableIdentityMatches: matches.length,
          expectedFingerprint: uOp.expectedPostFingerprint,
          actualNormalizedFingerprint,
          recoverable: isRecoverable,
          previewStatus: isRecoverable ? 'RECOVERABLE_VERIFIED_PREVIEW' : 'UNRECOVERABLE',
          reason: previewReason,
        });
      }
    }

    const journalFingerprint = calculateJournalFingerprint(journal, run.runId);

    // 4. Query live Notion state
    let liveTargetBases: Record<string, BaseSnapshotData> = {};
    try {
      liveTargetBases = await liveAdapter.queryTargetState();
    } catch (err: any) {
      throw new Error(`FAIL_LIVE_TARGET_READ: Falha ao ler bases live para resume: ${err.message}`);
    }

    // 5. Project expected state incorporating verified operations and preview-recoverable operations
    const projectedExpectedState: Record<string, BaseSnapshotData> = JSON.parse(JSON.stringify(frozenBases));
    const allExpectedOps = [...verifiedOps, ...recoverableOps];

    for (const opRec of allExpectedOps) {
      if (opRec.action === 'CREATE' && opRec.targetPageId) {
        const planOp = plan.operations[opRec.operationIndex];
        if (!planOp) continue;
        const targetEnvKey = planOp.targetDataSource.envKey;
        const targetBase = projectedExpectedState[targetEnvKey];

        const liveRecord = liveTargetBases[targetEnvKey]?.records.find((r) => r.id === opRec.targetPageId);
        if (liveRecord && targetBase) {
          if (!targetBase.records.some((r) => r.id === liveRecord.id)) {
            targetBase.records.push(JSON.parse(JSON.stringify(liveRecord)));
            targetBase.recordCount = targetBase.records.length;
          }
        }

        // Update dual relations on target database records (e.g. Categoria."Transações")
        for (const [relProp, refList] of Object.entries(planOp.relations)) {
          const contractProp = findPropertyContract(targetEnvKey, relProp);
          const targetDs = contractProp?.relationTargetEnvKey;
          if (targetDs && projectedExpectedState[targetDs]) {
            for (const ref of refList) {
              if (ref.type === 'EXISTING_PAGE_ID') {
                const targetRec = projectedExpectedState[targetDs].records.find((r) => r.id === ref.target);
                if (targetRec) {
                  for (const [propName, propVal] of Object.entries(targetRec.properties)) {
                    if (propName === 'Transações' || propName === 'Lançamentos' || propName === 'Itens') {
                      const curVal = Array.isArray(propVal) ? propVal : [];
                      if (!curVal.includes(opRec.targetPageId)) {
                        targetRec.properties[propName] = [...curVal, opRec.targetPageId].sort();
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    const projectedTargetStateHash = calculateTargetStateHash(projectedExpectedState);
    const liveTargetStateHash = calculateTargetStateHash(liveTargetBases);

    // 6. Compare actual live with projected expected
    if (liveTargetStateHash !== projectedTargetStateHash) {
      reasons.push(
        `TARGET_DRIFT_DETECTED: liveTargetStateHash (${liveTargetStateHash}) diverge do estado esperado projetado pelo journal (${projectedTargetStateHash}).`,
      );
    }

    const readyForLiveApplyReview = reasons.length === 0;
    const readyForApply = false;

    const artifact: ResumePreflightArtifact = {
      preflightVersion: '1.0.0',
      type: 'RESUME_PREFLIGHT',
      timestamp: generatedAt,
      generatedAt,
      expiresAt,
      ttlMinutes: this.ttlMinutes,
      runId: run.runId,
      runExecutorCommitSha: run.executorCommitSha,
      recoveryExecutorCommitSha,
      executorCommitSha: recoveryExecutorCommitSha,
      planOriginCommitSha: this.planOriginSha,
      backfillPlanHash: plan.backfillPlanHash,
      journalFingerprint,
      projectedTargetStateHash,
      liveTargetStateHash,
      workspaceIdentityHash,
      actorType,
      verifiedOperationsCount: verifiedOps.length,
      recoverableOperationsCount: recoverableOps.length,
      reconciliationPreview,
      targets: {
        transactions: liveTargetBases['NOTION_DS_TRANSACTIONS']?.records.length ?? 0,
        bills: liveTargetBases['NOTION_DS_CARD_BILLS']?.records.length ?? 0,
      },
      readyForLiveApplyReview,
      readyForApply,
      reasons,
    };

      const dir = path.dirname(this.artifactPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

      return artifact;
    } finally {
      journal.close();
    }
  }
}

export function isResumePreflightValid(
  artifact: ResumePreflightArtifact,
  maxAgeMs: number = 15 * 60 * 1000,
): { valid: boolean; reason?: string } {
  if (!artifact.generatedAt || !artifact.expiresAt) {
    return { valid: false, reason: 'LIVE_PREFLIGHT_INVALID_TIME: generatedAt ou expiresAt ausentes no artefato.' };
  }

  const generatedTime = new Date(artifact.generatedAt).getTime();
  const expiresTime = new Date(artifact.expiresAt).getTime();

  if (isNaN(generatedTime) || isNaN(expiresTime)) {
    return { valid: false, reason: 'LIVE_PREFLIGHT_INVALID_TIME: Formato de timestamp ISO inválido no artefato.' };
  }

  const now = Date.now();
  const CLOCK_TOLERANCE_MS = 60 * 1000;

  if (generatedTime > now + CLOCK_TOLERANCE_MS) {
    return { valid: false, reason: 'LIVE_PREFLIGHT_INVALID_TIME: generatedAt no futuro detectado além da tolerância permitida (60s).' };
  }
  if (expiresTime <= now) {
    return { valid: false, reason: 'LIVE_PREFLIGHT_EXPIRED: O preflight expirou (expiresAt <= now). Novo preflight exigido.' };
  }
  if (now - generatedTime > maxAgeMs) {
    return { valid: false, reason: 'LIVE_PREFLIGHT_EXPIRED: O preflight expirou (> 15 minutos). Novo preflight exigido.' };
  }

  const ttlWindow = expiresTime - generatedTime;
  if (ttlWindow <= 0 || ttlWindow > maxAgeMs + CLOCK_TOLERANCE_MS) {
    return { valid: false, reason: 'LIVE_PREFLIGHT_INVALID_TIME: Janela de expiração inconsistente ou adulterada.' };
  }

  return { valid: true };
}

export function validateResumePreflightBinding(
  artifact: ResumePreflightArtifact,
  expected: {
    runId?: string;
    executorCommitSha?: string;
    backfillPlanHash?: string;
    projectedTargetStateHash?: string;
    workspaceIdentityHash?: string;
    journalFingerprint?: string;
    envVars?: Record<string, string | undefined>;
  } = {},
): { valid: boolean; reason?: string } {
  if (artifact.readyForLiveApplyReview !== true) {
    return { valid: false, reason: 'FAIL_PREFLIGHT_NOT_REVIEW_READY: Resume preflight não está marcado como readyForLiveApplyReview === true.' };
  }
  if (artifact.readyForApply !== false) {
    return { valid: false, reason: 'FAIL_PREFLIGHT_INVALID_APPLY_FLAG: Resume preflight deve ter readyForApply === false.' };
  }
  if (!Array.isArray(artifact.reasons) || artifact.reasons.length > 0) {
    return { valid: false, reason: `FAIL_PREFLIGHT_REASONS_NOT_EMPTY: Resume preflight contém razões de bloqueio (${(artifact.reasons || []).join(', ')}).` };
  }
  if (!artifact.journalFingerprint || typeof artifact.journalFingerprint !== 'string') {
    return { valid: false, reason: 'FAIL_RESUME_PREFLIGHT_BINDING: journalFingerprint ausente ou inválido no artefato.' };
  }
  if (!artifact.projectedTargetStateHash || typeof artifact.projectedTargetStateHash !== 'string') {
    return { valid: false, reason: 'FAIL_RESUME_PREFLIGHT_BINDING: projectedTargetStateHash ausente ou inválido no artefato.' };
  }
  if (!artifact.liveTargetStateHash || typeof artifact.liveTargetStateHash !== 'string') {
    return { valid: false, reason: 'FAIL_RESUME_PREFLIGHT_BINDING: liveTargetStateHash ausente ou inválido no artefato.' };
  }
  if (artifact.liveTargetStateHash !== artifact.projectedTargetStateHash) {
    return { valid: false, reason: `FAIL_RESUME_PREFLIGHT_BINDING: liveTargetStateHash (${artifact.liveTargetStateHash}) diverge de projectedTargetStateHash (${artifact.projectedTargetStateHash}).` };
  }

  const expPlanHash = expected.backfillPlanHash || FROZEN_BACKFILL_PLAN_HASH;

  if (artifact.backfillPlanHash !== expPlanHash) {
    return { valid: false, reason: `FAIL_RESUME_PREFLIGHT_BINDING: backfillPlanHash diverge (${artifact.backfillPlanHash} vs ${expPlanHash}).` };
  }
  if (expected.runId && artifact.runId !== expected.runId) {
    return { valid: false, reason: `FAIL_RESUME_PREFLIGHT_BINDING: runId diverge (${artifact.runId} vs ${expected.runId}).` };
  }
  if (expected.executorCommitSha && artifact.executorCommitSha !== expected.executorCommitSha && artifact.recoveryExecutorCommitSha !== expected.executorCommitSha) {
    return { valid: false, reason: `FAIL_RESUME_PREFLIGHT_BINDING: executorCommitSha diverge (${artifact.recoveryExecutorCommitSha || artifact.executorCommitSha} vs ${expected.executorCommitSha}).` };
  }
  if (expected.projectedTargetStateHash && artifact.projectedTargetStateHash !== expected.projectedTargetStateHash) {
    return { valid: false, reason: `FAIL_RESUME_PREFLIGHT_BINDING: projectedTargetStateHash diverge (${artifact.projectedTargetStateHash} vs ${expected.projectedTargetStateHash}).` };
  }
  if (expected.workspaceIdentityHash && artifact.workspaceIdentityHash !== expected.workspaceIdentityHash) {
    return { valid: false, reason: `FAIL_RESUME_PREFLIGHT_BINDING: workspaceIdentityHash diverge (${artifact.workspaceIdentityHash} vs ${expected.workspaceIdentityHash}).` };
  }
  if (expected.journalFingerprint && artifact.journalFingerprint !== expected.journalFingerprint) {
    return { valid: false, reason: `FAIL_RESUME_PREFLIGHT_BINDING: journalFingerprint diverge (${artifact.journalFingerprint} vs ${expected.journalFingerprint}).` };
  }

  // Cross-commit recovery gate enforcement (Item 9)
  if (
    artifact.runExecutorCommitSha &&
    artifact.recoveryExecutorCommitSha &&
    artifact.runExecutorCommitSha !== artifact.recoveryExecutorCommitSha
  ) {
    const env = expected.envVars || (process.env as Record<string, string | undefined>);
    const recoveryFromCommit = env.FINANCIAL_BACKFILL_RECOVERY_FROM_COMMIT?.trim();
    const recoveryRunId = env.FINANCIAL_BACKFILL_RECOVERY_RUN_ID?.trim();

    if (recoveryFromCommit !== artifact.runExecutorCommitSha || recoveryRunId !== artifact.runId) {
      return {
        valid: false,
        reason: `FAIL_CROSS_COMMIT_RECOVERY_AUTHORIZATION: Recovery cross-commit (${artifact.runExecutorCommitSha} -> ${artifact.recoveryExecutorCommitSha}) exige FINANCIAL_BACKFILL_RECOVERY_FROM_COMMIT='${artifact.runExecutorCommitSha}' e FINANCIAL_BACKFILL_RECOVERY_RUN_ID='${artifact.runId}'.`,
      };
    }
  }

  return { valid: true };
}
