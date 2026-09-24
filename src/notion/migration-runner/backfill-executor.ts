import { Client } from '@notionhq/client';
import { execSync } from 'child_process';
import {
  PLAN_ORIGIN_COMMIT_SHA,
  FROZEN_BACKFILL_PLAN_HASH,
  FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_STATE_HASH,
  MAX_NEW_PAGES_BUDGET,
} from './backfill-constants';
import {
  BackfillJournal,
  BackfillOperationStatus,
  BackfillOperationRecord,
  calculateJournalFingerprint,
} from './backfill-journal';
import {
  BackfillNotionAdapter,
  SimulatedNotionAdapter,
  LiveNotionAdapter,
} from './backfill-adapter';
import { BackfillDryRunAnalyzer } from './backfill-dry-run';
import {
  serializePayloadForNotion,
  calculatePropertiesFingerprint,
  calculateRecordFingerprint,
  canonicalizePageRecord,
  findPropertyContract,
  resolveStableIdentitySpec,
} from './backfill-serializer';
import {
  BackfillPlanArtifact,
  BackfillOperation,
  BackfillSchemaConformanceEvidence,
  TargetDriftDifference,
} from './types';
import { calculateTargetStateHash, BaseSnapshotData, NotionPageRecord } from './data-snapshot';
import { TARGET_CONTRACT } from '../../domain/schema-contract';
import type { ResumePreflightArtifact } from './backfill-live-preflight';
import { DurableJournalCheckpointer, DurabilityGuardedAdapter } from './journal-durability';

export const DEFAULT_CONFORMANT_SCHEMA_EVIDENCE: BackfillSchemaConformanceEvidence = {
  totalDataSources: 13,
  verifiedDataSources: 13,
  missingPropertiesCount: 0,
  structuralMismatchesCount: 0,
};

export interface BackfillExecutorOptions {
  adapter: BackfillNotionAdapter;
  journal?: BackfillJournal;
  journalDbPath?: string;
  envVars?: Record<string, string | undefined>;
  commitSha?: string; // Current executor commit SHA (defaults to git rev-parse HEAD)
  planOriginCommitSha?: string; // Frozen plan origin commit SHA (defaults to PLAN_ORIGIN_COMMIT_SHA)
  targetSnapshotManifestPath?: string;
  sourceSnapshotManifestPath?: string;
  accountMappingPath?: string;
  schemaEvidence?: BackfillSchemaConformanceEvidence;
  skipWorktreeCleanCheck?: boolean;
  skipHeadInSyncCheck?: boolean;
  skipInitialDriftCheck?: boolean;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  canary?: number;
  resumeRunId?: string;
  isLive?: boolean;
  // Reproduces the frozen backfill plan for canary recovery (defaults to BackfillDryRunAnalyzer).
  planProvider?: () => Promise<BackfillPlanArtifact>;
  // Durable encrypted journal checkpoints. Mandatory when isLive: every Notion mutation is preceded
  // and followed by an acknowledged checkpoint (see journal-durability.ts).
  durability?: DurableJournalCheckpointer;
}

export interface BackfillExecutorReport {
  executorHeadCommitSha: string;
  executorParentCommitSha: string;
  planOriginCommitSha: string;
  frozenBackfillPlanHash: string;
  reproducedBackfillPlanHash: string;
  sourceSnapshotHash: string;
  targetSnapshotHash: string;
  targetStateHash: string;
  simulationRunId: string;
  status: 'COMPLETED' | 'FAILED' | 'PAUSED_AFTER_CANARY';
  semanticCreates: number;
  actualSimulatedCreateWrites: number;
  existingPageCreateNoOps: number;
  logicalRelationReferences: number;
  canonicalRelationPatchGroups: number;
  actualSimulatedRelationWrites: number;
  writeRequestsSent: number;
  retries: number;
  recoveredUncertainCreates: number;
  recoveredUncertainRelationWrites: number;
  journalFinal: Record<BackfillOperationStatus, number>;
  liveNotionMutations: number;
  readyForLiveApplyReview: boolean;
  readyForApply: false;
  reasons: string[];
  logicalCreates?: number;
  createHttpAttempts?: number;
  logicalRelationPatches?: number;
  relationPatchHttpAttempts?: number;
  pagesCreatedDuringRecovery?: number;
  recoveryOutcome?: 'RECOVERY_APPLIED' | 'RECOVERY_ALREADY_APPLIED';
}

export const CANARY_OPERATION_INDEX = 0;
export const CANARY_RECOVERY_REASON_CODE = 'RECOVERED_AFTER_CANONICAL_FINGERPRINT_FIX';

function sanitizeErrorMessage(msg: string): string {
  if (!msg) return 'UNKNOWN_ERROR';
  return msg
    .replace(/[a-f0-9]{64}/gi, '[HASH_REDACTED]')
    .replace(/secret_[a-zA-Z0-9]+/g, '[SECRET_REDACTED]')
    .substring(0, 300);
}

function isUncertainError(err: any): boolean {
  if (err?.isUncertain) return true;
  const msg = (err?.message || '').toLowerCase();
  if (msg.includes('uncertain_mutation')) return true;
  const status = err?.status;
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  return (
    msg.includes('timeout') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('network') ||
    msg.includes('socket') ||
    err?.code === 'ETIMEDOUT' ||
    err?.code === 'ECONNRESET' ||
    err?.code === 'service_unavailable' ||
    err?.code === 'internal_server_error'
  );
}

function parseRetryAfterMs(err: any, fallbackMs: number): number {
  const headerVal =
    err?.headers?.['retry-after'] ||
    err?.response?.headers?.['retry-after'] ||
    err?.headers?.get?.('retry-after');

  if (headerVal) {
    const parsedSec = parseFloat(String(headerVal));
    if (!isNaN(parsedSec) && parsedSec >= 0) {
      return Math.round(parsedSec * 1000);
    }
  }
  return fallbackMs;
}

/**
 * Projects the expected state upon resume from an in-progress run.
 * Pure shared function incorporating actual verified page creations,
 * EXISTING_PAGE_ID relations, relation patches, and dual relation effects.
 */
export function projectExpectedBackfillState(
  initialState: Record<string, BaseSnapshotData>,
  plan: BackfillPlanArtifact,
  journal: BackfillJournal,
  runId: string,
  extraRecoverableOps: BackfillOperationRecord[] = [],
): Record<string, BaseSnapshotData> {
  const projected: Record<string, BaseSnapshotData> = JSON.parse(JSON.stringify(initialState));

  const ops = journal.getOperations(runId);
  const combined = [
    ...ops.filter(
      (o) => o.status === 'VERIFIED' || o.status === 'NO_OP_VERIFIED' || o.status === 'APPLIED',
    ),
    ...extraRecoverableOps,
  ];

  const seenIndices = new Set<number>();
  const verifiedOrAppliedOps: BackfillOperationRecord[] = [];
  for (const op of combined) {
    if (!seenIndices.has(op.operationIndex)) {
      seenIndices.add(op.operationIndex);
      verifiedOrAppliedOps.push(op);
    }
  }

  const mappedPages = new Map<string, string>();
  for (const op of verifiedOrAppliedOps) {
    if (op.action === 'CREATE' && op.targetPageId) {
      mappedPages.set(op.stableId, op.targetPageId);
    }
  }

  // Apply creations
  for (const opRec of verifiedOrAppliedOps) {
    if (opRec.action !== 'CREATE' || !opRec.targetPageId) continue;
    const planOp = plan.operations[opRec.operationIndex];
    if (!planOp) continue;

    const existingRelations: Record<string, string[]> = {};
    for (const [propName, refList] of Object.entries(planOp.relations)) {
      const existingIds = refList.filter((r) => r.type === 'EXISTING_PAGE_ID').map((r) => r.target);
      if (existingIds.length > 0) existingRelations[propName] = existingIds;
    }

    const serialized = serializePayloadForNotion(
      planOp.targetDataSource.envKey,
      planOp.sanitizedPayload,
      existingRelations,
      true,
    );

    let base = projected[planOp.targetDataSource.envKey];
    if (!base) {
      base = {
        envKey: planOp.targetDataSource.envKey,
        defaultTitle: TARGET_CONTRACT[planOp.targetDataSource.envKey]?.defaultTitle || planOp.targetDataSource.envKey,
        dataSourceId: planOp.targetDataSource.envKey,
        recordCount: 0,
        records: [],
      };
      projected[planOp.targetDataSource.envKey] = base;
    }

    if (!base.records.some((r) => r.id === opRec.targetPageId)) {
      const nowIso = new Date().toISOString();
      base.records.push({
        id: opRec.targetPageId,
        createdTime: nowIso,
        lastEditedTime: nowIso,
        archived: false,
        url: `https://notion.so/${opRec.targetPageId.replace(/-/g, '')}`,
        properties: JSON.parse(JSON.stringify(serialized.notionProperties)),
      });
      base.recordCount = base.records.length;
    }
  }

  // Apply relation patches
  for (const opRec of verifiedOrAppliedOps) {
    if (opRec.action !== 'RELATION_PATCH' || !opRec.targetPageId) continue;
    const planOp =
      plan.operations.find((o) => o.stableId === opRec.stableId) ||
      plan.operations[opRec.operationIndex];
    if (!planOp) continue;

    const billBase = projected['NOTION_DS_CARD_BILLS'];
    const billRec = billBase?.records.find((r) => r.id === opRec.targetPageId);
    if (!billRec) continue;

    for (const [relProp, refList] of Object.entries(planOp.relations)) {
      const plannedRefs = refList.filter((r) => r.type === 'PLANNED_STABLE_ID');
      if (plannedRefs.length === 0) continue;

      const resolvedIds: string[] = [];
      for (const ref of plannedRefs) {
        const mapped = mappedPages.get(ref.target);
        if (mapped) resolvedIds.push(mapped);
      }
      resolvedIds.sort();
      billRec.properties[relProp] = { relation: resolvedIds.map((id) => ({ id })) };

      if (relProp === 'Lançamentos do Ciclo') {
        const txBase = projected['NOTION_DS_TRANSACTIONS'];
        if (txBase) {
          for (const txId of resolvedIds) {
            const txRec = txBase.records.find((r) => r.id === txId);
            if (txRec) {
              txRec.properties['Fatura Vinculada'] = { relation: [{ id: opRec.targetPageId! }] };
            }
          }
        }
      }
    }
  }

  return projected;
}

export class BackfillExecutor {
  private adapter: BackfillNotionAdapter;
  private journal: BackfillJournal;
  private options: BackfillExecutorOptions;
  private envVars: Record<string, string | undefined>;
  private ownJournal: boolean = false;

  constructor(options: BackfillExecutorOptions) {
    this.options = options;
    this.adapter = options.durability
      ? new DurabilityGuardedAdapter(options.adapter, options.durability)
      : options.adapter;
    this.envVars = options.envVars || (process.env as Record<string, string | undefined>);

    if (options.journal) {
      this.journal = options.journal;
    } else {
      this.journal = new BackfillJournal(options.journalDbPath || '.local/backfill-journal.db');
      this.ownJournal = true;
    }
  }

  public getJournal(): BackfillJournal {
    return this.journal;
  }

  private assertDurabilityForLive(): void {
    if (this.options.isLive && !this.options.durability) {
      throw new Error(
        'FAIL_DURABILITY_NOT_CONFIGURED: Execução live exige checkpoint durável do journal antes e depois de cada mutação.',
      );
    }
  }

  /** Persists the current journal state durably and waits for the acknowledgment (no-op without durability). */
  private async durableBarrier(reason: string): Promise<void> {
    if (this.options.durability) {
      await this.options.durability.checkpoint(reason);
    }
  }

  private getGitCommitSha(): string {
    if (this.options.commitSha) return this.options.commitSha;
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    } catch {
      return '0'.repeat(40);
    }
  }

  private getGitParentSha(): string {
    try {
      return execSync('git rev-parse HEAD^', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    } catch {
      return '0'.repeat(40);
    }
  }

  private isWorktreeClean(): boolean {
    if (this.options.skipWorktreeCleanCheck) return true;
    try {
      const out = execSync('git status --porcelain', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      return out.length === 0;
    } catch {
      return false;
    }
  }

  /**
   * Section 13 Preflight Check:
   * Reproduces the frozen plan artifact using PLAN_ORIGIN_COMMIT_SHA.
   * Validates all 5 cryptographic baseline hashes, schema 13/13, 159 CREATE, 0 UPDATE.
   */
  public async preflight(): Promise<{
    planArtifact: BackfillPlanArtifact;
    reproducedPlanHash: string;
    targetStateHash: string;
    sourceSnapshotHash: string;
    targetSnapshotHash: string;
    preflightBases: Record<string, BaseSnapshotData>;
  }> {
    const planOriginSha = this.options.planOriginCommitSha || PLAN_ORIGIN_COMMIT_SHA;

    if (!this.isWorktreeClean()) {
      throw new Error('PREFLIGHT_FAIL_WORKTREE_DIRTY: Working tree possui alterações não commitadas.');
    }

    // Fail closed if schemaEvidence was not provided
    if (!this.options.schemaEvidence) {
      throw new Error('FAIL_SCHEMA_EVIDENCE_MISSING: Evidência de conformidade de schema (13/13) não fornecida ao executor.');
    }

    // Validate schema evidence conformance
    const evidence = this.options.schemaEvidence;
    if (
      evidence.missingPropertiesCount > 0 ||
      evidence.structuralMismatchesCount > 0 ||
      evidence.verifiedDataSources !== 13
    ) {
      throw new Error('FAIL_SCHEMA_NON_CONFORMANT: Schema Notion não cumpre conformidade integral 13/13.');
    }

    // Assert dual relation contract in TARGET_CONTRACT
    const billContract = TARGET_CONTRACT['NOTION_DS_CARD_BILLS'];
    const cicloProp = billContract?.properties.find((p) => p.notionProperty === 'Lançamentos do Ciclo');
    if (!cicloProp || !cicloProp.isBidirectionalRelation || cicloProp.syncedPropertyName !== 'Fatura Vinculada') {
      throw new Error(
        'FAIL_SCHEMA_CONTRACT_ASSERTION: Relação dual Faturas.Lançamentos do Ciclo <-> Transações.Fatura Vinculada não configurada no TARGET_CONTRACT.',
      );
    }

    // Prepare validated target snapshot to obtain frozen baseline bases for plan artifact reproduction
    const targetAnalyzer = new BackfillDryRunAnalyzer({
      envVars: this.envVars,
      commitSha: planOriginSha,
      targetSnapshotManifestPath: this.options.targetSnapshotManifestPath,
      sourceSnapshotManifestPath: this.options.sourceSnapshotManifestPath,
      schemaEvidence: evidence,
    });
    const targetSession = targetAnalyzer.prepareValidatedTargetSnapshot();
    const frozenBases: Record<string, BaseSnapshotData> = JSON.parse(JSON.stringify(targetSession.payload.bases));
    targetSession.cleanup();

    // Reproduce plan strictly with planOriginSha from frozen snapshot baseline
    const analyzer = new BackfillDryRunAnalyzer({
      envVars: this.envVars,
      commitSha: planOriginSha,
      targetSnapshotManifestPath: this.options.targetSnapshotManifestPath,
      sourceSnapshotManifestPath: this.options.sourceSnapshotManifestPath,
      schemaEvidence: evidence,
      liveBases: frozenBases,
    });

    const report = await analyzer.runAnalysis();
    const artifact = report.planArtifact;

    // 1. Verify Plan Hash
    if (artifact.backfillPlanHash !== FROZEN_BACKFILL_PLAN_HASH) {
      throw new Error(
        `FAIL_FROZEN_PLAN_MISMATCH: Hash do plano reproduzido (${artifact.backfillPlanHash}) diverge da baseline congelada (${FROZEN_BACKFILL_PLAN_HASH}).`,
      );
    }

    // 2. Verify Snapshot Hashes
    const sourcePlaintextSha = artifact.explicitSnapshots.sourceSnapshotPlaintextSha256;
    if (sourcePlaintextSha !== FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256) {
      throw new Error(
        `FAIL_SOURCE_SNAPSHOT_HASH_MISMATCH: Hash do snapshot de origem (${sourcePlaintextSha}) diverge de ${FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256}.`,
      );
    }

    const targetPlaintextSha = artifact.explicitSnapshots.targetNotionSnapshotSha256;
    if (targetPlaintextSha !== FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256) {
      throw new Error(
        `FAIL_TARGET_SNAPSHOT_HASH_MISMATCH: Hash do snapshot alvo (${targetPlaintextSha}) diverge de ${FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256}.`,
      );
    }

    // 3. Verify Target State Hash
    const targetStateHash = artifact.explicitSnapshots.targetStateHash;
    if (targetStateHash !== FROZEN_TARGET_STATE_HASH) {
      throw new Error(
        `FAIL_TARGET_STATE_HASH_MISMATCH: Target state hash (${targetStateHash}) diverge de ${FROZEN_TARGET_STATE_HASH}.`,
      );
    }

    // 4. Verify Operation counts
    if (artifact.summary.executableCreateCount !== 159 || artifact.summary.executableUpdateCount !== 0) {
      throw new Error(
        `FAIL_OPERATION_COUNTS_INVALID: Esperado 159 CREATE e 0 UPDATE, obtido ${artifact.summary.executableCreateCount} CREATE e ${artifact.summary.executableUpdateCount} UPDATE.`,
      );
    }

    // 5. Verify Schema Conformance & Readiness
    const checks = artifact.readiness.checks;
    if (!checks.schemaConformant13Of13 || !checks.missingPropertiesZero || !checks.structuralMismatchesZero) {
      throw new Error('FAIL_SCHEMA_NON_CONFORMANT: Schema Notion não cumpre conformidade integral 13/13.');
    }

    // 6. Verify Blockers (accounting for test flags)
    const activeBlockers = artifact.readiness.blockers.filter((b) => {
      if (this.options.skipWorktreeCleanCheck && (b.startsWith('WORKTREE_DIRTY') || b.startsWith('HEAD_NOT_IN_SYNC'))) {
        return false;
      }
      if (this.options.skipHeadInSyncCheck && b.startsWith('HEAD_NOT_IN_SYNC')) {
        return false;
      }
      if (this.options.skipInitialDriftCheck && b.startsWith('TARGET_DRIFT_DETECTED')) {
        return false;
      }
      return true;
    });

    if (activeBlockers.length > 0) {
      throw new Error(
        `FAIL_NOT_READY_FOR_EXECUTOR: Plano não está pronto para implementação do executor: ${activeBlockers.join('; ')}`,
      );
    }

    return {
      planArtifact: artifact,
      reproducedPlanHash: artifact.backfillPlanHash,
      targetStateHash,
      sourceSnapshotHash: sourcePlaintextSha,
      targetSnapshotHash: targetPlaintextSha,
      preflightBases: frozenBases,
    };
  }

  /**
   * Projects the fully applied state of the frozen plan (State B).
   * Used for initial drift check in idempotent re-executions.
   */
  public projectFullyAppliedState(
    initialState: Record<string, BaseSnapshotData>,
    plan: BackfillPlanArtifact,
    pageIdResolver?: (stableId: string, index: number) => string,
  ): Record<string, BaseSnapshotData> {
    const projected: Record<string, BaseSnapshotData> = JSON.parse(JSON.stringify(initialState));

    const simulatedPageIds = new Map<string, string>();
    let counter = 0;

    // Stage 1 Creations
    for (const op of plan.operations) {
      if (op.operationType !== 'CREATE') continue;
      counter++;
      const mapping = this.journal.getPageMapping(plan.backfillPlanHash, op.stableId);
      const pageId =
        pageIdResolver?.(op.stableId, counter) ||
        mapping?.notionPageId ||
        `sim-page-${String(counter).padStart(6, '0')}`;
      simulatedPageIds.set(op.stableId, pageId);

      const existingRelations: Record<string, string[]> = {};
      for (const [propName, refList] of Object.entries(op.relations)) {
        const existingIds = refList.filter((r) => r.type === 'EXISTING_PAGE_ID').map((r) => r.target);
        if (existingIds.length > 0) existingRelations[propName] = existingIds;
      }

      const serialized = serializePayloadForNotion(
        op.targetDataSource.envKey,
        op.sanitizedPayload,
        existingRelations,
        true,
      );

      let base = projected[op.targetDataSource.envKey];
      if (!base) {
        base = {
          envKey: op.targetDataSource.envKey,
          defaultTitle: TARGET_CONTRACT[op.targetDataSource.envKey]?.defaultTitle || op.targetDataSource.envKey,
          dataSourceId: op.targetDataSource.envKey,
          recordCount: 0,
          records: [],
        };
        projected[op.targetDataSource.envKey] = base;
      }

      const nowIso = new Date().toISOString();
      const rec: NotionPageRecord = {
        id: pageId,
        createdTime: nowIso,
        lastEditedTime: nowIso,
        archived: false,
        url: `https://notion.so/${pageId.replace(/-/g, '')}`,
        properties: JSON.parse(JSON.stringify(serialized.notionProperties)),
      };
      base.records.push(rec);
      base.recordCount = base.records.length;
    }

    // Stage 2 Relation Patches
    const billOps = plan.operations.filter((o) => o.targetDataSource.envKey === 'NOTION_DS_CARD_BILLS');
    for (const billOp of billOps) {
      const billPageId = simulatedPageIds.get(billOp.stableId);
      if (!billPageId) continue;
      const billBase = projected['NOTION_DS_CARD_BILLS'];
      const billRec = billBase?.records.find((r) => r.id === billPageId);
      if (!billRec) continue;

      for (const [relProp, refList] of Object.entries(billOp.relations)) {
        const plannedRefs = refList.filter((r) => r.type === 'PLANNED_STABLE_ID');
        if (plannedRefs.length === 0) continue;

        const resolvedIds: string[] = [];
        for (const ref of plannedRefs) {
          const mapped = simulatedPageIds.get(ref.target);
          if (mapped) resolvedIds.push(mapped);
        }
        resolvedIds.sort();
        billRec.properties[relProp] = { relation: resolvedIds.map((id) => ({ id })) };

        if (relProp === 'Lançamentos do Ciclo') {
          const txBase = projected['NOTION_DS_TRANSACTIONS'];
          if (txBase) {
            for (const txId of resolvedIds) {
              const txRec = txBase.records.find((r) => r.id === txId);
              if (txRec) {
                txRec.properties['Fatura Vinculada'] = { relation: [{ id: billPageId }] };
              }
            }
          }
        }
      }
    }

    return projected;
  }

  public projectExpectedStateOnResume(
    initialState: Record<string, BaseSnapshotData>,
    plan: BackfillPlanArtifact,
    runId: string,
  ): Record<string, BaseSnapshotData> {
    return projectExpectedBackfillState(initialState, plan, this.journal, runId);
  }

  private buildRelationPatchesForBill(
    billOp: BackfillOperation,
    planHash: string,
  ): Record<string, string[]> {
    const patches: Record<string, string[]> = {};
    for (const [relProp, refList] of Object.entries(billOp.relations)) {
      const plannedRefs = refList.filter((r) => r.type === 'PLANNED_STABLE_ID');
      if (plannedRefs.length === 0) continue;

      const resolvedIds: string[] = [];
      for (const ref of plannedRefs) {
        const mapping = this.journal.getPageMapping(planHash, ref.target);
        if (!mapping) {
          throw new Error(
            `FAIL_UNRESOLVED_PLANNED_RELATION: Stable ID '${ref.target}' referenciado em '${relProp}' não foi resolvido.`,
          );
        }
        if (mapping.targetDataSource !== 'NOTION_DS_TRANSACTIONS') {
          throw new Error(
            `FAIL_RELATION_TARGET_TYPE_MISMATCH: Stable ID '${ref.target}' referenciado em '${relProp}' pertence a '${mapping.targetDataSource}' em vez de NOTION_DS_TRANSACTIONS.`,
          );
        }
        resolvedIds.push(mapping.notionPageId);
      }
      patches[relProp] = resolvedIds.sort();
    }
    return patches;
  }

  /**
   * Executes the full idempotent simulation with persistent journal.
   * With durability: the final journal state is checkpointed before returning; on error a best-effort
   * checkpoint is attempted (the durable head is always a safe restore point either way).
   */
  public async execute(): Promise<BackfillExecutorReport> {
    this.assertDurabilityForLive();
    let report: BackfillExecutorReport;
    try {
      report = await this.executeInner();
    } catch (err) {
      try {
        await this.durableBarrier('RUN_ERROR');
      } catch {
        // The durable head predates this state; restoring it is safe (uncertain writes reconcile).
      }
      throw err;
    }
    await this.durableBarrier('RUN_EXIT');
    return report;
  }

  private async executeInner(): Promise<BackfillExecutorReport> {
    const planOriginSha = this.options.planOriginCommitSha || PLAN_ORIGIN_COMMIT_SHA;
    const executorCommitSha = this.getGitCommitSha();
    const executorParentCommitSha = this.getGitParentSha();

    // 1. Run Preflight
    const preflightRes = await this.preflight();
    const plan = preflightRes.planArtifact;

    // Validate logical relation references count (must be exactly 320)
    let logicalRelationReferences = 0;
    for (const op of plan.operations) {
      for (const refs of Object.values(op.relations)) {
        logicalRelationReferences += refs.length;
      }
    }
    if (logicalRelationReferences !== 320) {
      throw new Error(
        `FAIL_LOGICAL_RELATIONS_COUNT: Esperado 320 referências lógicas de relação no plano, obtido ${logicalRelationReferences}.`,
      );
    }

    // 2. Query initial adapter target state
    const currentTargetState = await this.adapter.queryTargetState();
    const currentTargetHash = calculateTargetStateHash(currentTargetState);

    // 3. Determine runId (new run vs resume)
    let runId: string;
    let isResume = false;
    const isLive = Boolean(
      this.options.isLive ||
      (this.adapter as any).isProductionMutationAuthorized ||
      (this.adapter as any).totalMutationRequests !== undefined
    );

    if (isLive && !this.options.resumeRunId && this.journal.hasAnyRuns()) {
      throw new Error(
        'FAIL_INITIAL_RUN_JOURNAL_EXISTS: Journal já possui execuções registradas. Execução live exige a flag explícita --resume <run_id> para continuar.',
      );
    }

    const existingRun = this.options.resumeRunId
      ? this.journal.getRun(this.options.resumeRunId)
      : this.journal.getLatestRun();

    if (this.options.resumeRunId && !existingRun) {
      throw new Error(`FAIL_RESUME_NO_RUN_FOUND: Run '${this.options.resumeRunId}' não encontrado no journal.`);
    }

    if (
      existingRun &&
      (existingRun.status === 'IN_PROGRESS' || existingRun.status === 'PAUSED_AFTER_CANARY') &&
      existingRun.planHash === plan.backfillPlanHash
    ) {
      runId = existingRun.runId;
      isResume = true;
      // Fail closed if journal binding diverges from frozen baseline
      this.journal.validateRunMetadata(runId, {
        planHash: plan.backfillPlanHash,
        planOriginCommitSha: planOriginSha,
        sourceSnapshotHash: preflightRes.sourceSnapshotHash,
        targetSnapshotHash: preflightRes.targetSnapshotHash,
        targetStateHash: preflightRes.targetStateHash,
      });
    } else {
      // Item 12: For initial run in live mode, journal must not contain preexisting runs unless explicit resume
      if (this.journal.hasAnyRuns() && isLive && !isResume) {
        throw new Error('FAIL_INITIAL_RUN_JOURNAL_EXISTS: Journal já possui execuções registradas. Novo run inicial requer journal limpo ou flag explícita de resume.');
      }

      // Item 14: Initial live run requires --canary 1
      if (isLive && !isResume && this.options.canary !== 1) {
        throw new Error('CANARY_REQUIRED_FOR_INITIAL_RUN: A execução inicial em ambiente live exige o parâmetro --canary 1 para verificação controlada.');
      }

      runId = `run-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      this.journal.startRun({
        runId,
        planHash: plan.backfillPlanHash,
        planOriginCommitSha: planOriginSha,
        executorCommitSha,
        sourceSnapshotHash: preflightRes.sourceSnapshotHash,
        targetSnapshotHash: preflightRes.targetSnapshotHash,
        targetStateHash: preflightRes.targetStateHash,
      });
    }

    // Metrics counters
    let semanticCreates = 0;
    let actualSimulatedCreateWrites = 0;
    let existingPageCreateNoOps = 0;
    let canonicalRelationPatchGroups = 0;
    let actualSimulatedRelationWrites = 0;
    let writeRequestsSent = 0;
    let retries = 0;
    let recoveredUncertainCreates = 0;
    let recoveredUncertainRelationWrites = 0;

    const maxRetries = this.options.maxRetries ?? 3;
    const retryDelay = this.options.retryBaseDelayMs ?? 5;

    // =========================================================================
    // 4. RECONCILIATION: Check for uncertain writes from previous crash (if resume)
    // =========================================================================
    if (isResume) {
      const uncertainOps = this.journal.getUncertainOperations(runId);
      for (const uOp of uncertainOps) {
        if (uOp.action === 'CREATE') {
          const matchingPlanOp = plan.operations[uOp.operationIndex];
          const idSpec = resolveStableIdentitySpec(
            matchingPlanOp || { targetDataSource: uOp.targetDataSource, stableId: uOp.stableId },
          );
          const existingMatches = await this.adapter.findByStableIdentity(
            uOp.targetDataSource,
            idSpec.physicalProperty,
            uOp.stableId,
          );

          if (existingMatches.length === 1) {
            const match = existingMatches[0];
            const matchFingerprint = calculateRecordFingerprint(uOp.targetDataSource, match.properties);
            if (matchFingerprint === uOp.expectedPostFingerprint) {
              this.journal.recordVerified(runId, uOp.operationIndex, match.id, false);
              this.journal.savePageMapping(plan.backfillPlanHash, uOp.stableId, match.id, uOp.targetDataSource);
              recoveredUncertainCreates++;
            } else {
              this.journal.recordFailed(runId, uOp.operationIndex, 'FAIL_CONFLICTING_EXISTING_PAGE');
              throw new Error(
                `FAIL_CONFLICTING_EXISTING_PAGE: Recuperação de incerteza detectou página com dados conflitantes para '${uOp.stableId}'.`,
              );
            }
          } else if (existingMatches.length > 1) {
            this.journal.recordFailed(runId, uOp.operationIndex, 'FAIL_DUPLICATE_STABLE_ID');
            throw new Error(
              `FAIL_DUPLICATE_STABLE_ID: Múltiplas páginas encontradas com mesmo stableId '${uOp.stableId}'.`,
            );
          }
        } else if (uOp.action === 'RELATION_PATCH') {
          const billPageId =
            uOp.targetPageId || this.journal.getPageMapping(plan.backfillPlanHash, uOp.stableId)?.notionPageId;
          if (!billPageId) {
            this.journal.recordFailed(runId, uOp.operationIndex, 'FAIL_PAGE_NOT_FOUND');
            throw new Error(`FAIL_PAGE_NOT_FOUND: Fatura para patch de relação '${uOp.stableId}' não mapeada.`);
          }

          const page = await this.adapter.fetchPage(billPageId);
          if (!page) {
            this.journal.recordFailed(runId, uOp.operationIndex, 'FAIL_PAGE_NOT_FOUND');
            throw new Error(`FAIL_PAGE_NOT_FOUND: Página '${billPageId}' não encontrada para reconciliação.`);
          }

          const planOp =
            plan.operations.find((o) => o.stableId === uOp.stableId) ||
            plan.operations[uOp.operationIndex];
          if (!planOp) {
            this.journal.recordFailed(runId, uOp.operationIndex, 'FAIL_OPERATION_NOT_FOUND');
            throw new Error(`FAIL_OPERATION_NOT_FOUND: Operação do plano para '${uOp.stableId}' não encontrada.`);
          }
          const expectedPatches = this.buildRelationPatchesForBill(planOp, plan.backfillPlanHash);
          let exactMatch = true;
          let hasForeign = false;

          for (const [propName, expectedIds] of Object.entries(expectedPatches)) {
            const curIds = (page.properties[propName]?.relation || []).map((r: any) => r.id || r).sort();
            const expSet = new Set(expectedIds);
            for (const cid of curIds) {
              if (!expSet.has(cid)) hasForeign = true;
            }
            if (JSON.stringify(curIds) !== JSON.stringify(expectedIds)) {
              exactMatch = false;
            }
          }

          if (hasForeign) {
            this.journal.recordFailed(runId, uOp.operationIndex, 'FAIL_RELATION_CONFLICT');
            throw new Error(`FAIL_RELATION_CONFLICT: Relação estranha detectada na fatura '${billPageId}'.`);
          }

          if (exactMatch) {
            this.journal.recordVerified(runId, uOp.operationIndex, billPageId, false);
            recoveredUncertainRelationWrites++;
          }
        }
      }
    }

    // 5. Initial Drift Check (State A = pristine, State B = fully applied, or Resume = projected)
    if (!this.options.skipInitialDriftCheck) {
      if (isResume) {
        const projectedResumeState = this.projectExpectedStateOnResume(preflightRes.preflightBases, plan, runId);
        const projectedResumeHash = calculateTargetStateHash(projectedResumeState);
        if (currentTargetHash !== projectedResumeHash) {
          this.journal.failRun(runId, 'EXTERNAL_DRIFT_DURING_BACKFILL');
          throw new Error(
            `EXTERNAL_DRIFT_DURING_BACKFILL: Target state durante resume (${currentTargetHash}) diverge do estado esperado projetado (${projectedResumeHash}). 0 writes executados.`,
          );
        }
      } else {
        const fullyAppliedState = this.projectFullyAppliedState(preflightRes.preflightBases, plan);
        const fullyAppliedHash = calculateTargetStateHash(fullyAppliedState);

        const isPristine = currentTargetHash === FROZEN_TARGET_STATE_HASH;
        const isFullyApplied = currentTargetHash === fullyAppliedHash;

        if (!isPristine && !isFullyApplied) {
          this.journal.failRun(runId, 'TARGET_DRIFT_DETECTED');
          throw new Error(
            `TARGET_DRIFT_DETECTED: Live/simulated target state (${currentTargetHash}) diverge do snapshot congelado (${FROZEN_TARGET_STATE_HASH}) e do estado totalmente aplicado (${fullyAppliedHash}). 0 writes executados.`,
          );
        }
      }
    }

    // =========================================================================
    // STAGE 1: Page Creation (155 Transações + 4 Faturas = 159 pages)
    // =========================================================================
    for (let i = 0; i < plan.operations.length; i++) {
      const op = plan.operations[i];
      if (op.operationType !== 'CREATE') continue;
      semanticCreates++;

      const idSpec = resolveStableIdentitySpec(op);
      const stableIdProp = idSpec.physicalProperty;

      // Pre-create validation: validate all EXISTING_PAGE_ID relations against target state
      for (const [propName, refList] of Object.entries(op.relations)) {
        const propContract = findPropertyContract(op.targetDataSource.envKey, propName);
        const targetEnvKey = propContract?.relationTargetEnvKey;
        if (!targetEnvKey) {
          this.journal.recordFailed(runId, i, 'FAIL_RELATION_TARGET_TYPE_MISMATCH');
          throw new Error(
            `FAIL_RELATION_TARGET_TYPE_MISMATCH: Propriedade '${propName}' não possui relationTargetEnvKey configurado no TARGET_CONTRACT.`,
          );
        }

        for (const ref of refList) {
          if (ref.type === 'EXISTING_PAGE_ID') {
            const targetBase = currentTargetState[targetEnvKey];
            if (!targetBase) {
              this.journal.recordFailed(runId, i, 'FAIL_RELATION_TARGET_MISSING');
              throw new Error(
                `FAIL_RELATION_TARGET_MISSING: Base alvo '${targetEnvKey}' referenciada em '${propName}' não encontrada no target state.`,
              );
            }
            const targetRecord = targetBase.records.find((r) => r.id === ref.target);
            if (!targetRecord) {
              this.journal.recordFailed(runId, i, 'FAIL_RELATION_TARGET_MISSING');
              throw new Error(
                `FAIL_RELATION_TARGET_MISSING: Página alvo '${ref.target}' referenciada em '${propName}' não existe na base '${targetEnvKey}'.`,
              );
            }
          }
        }
      }

      // Separate EXISTING_PAGE_ID relations from PLANNED_STABLE_ID
      const existingRelations: Record<string, string[]> = {};
      for (const [propName, refList] of Object.entries(op.relations)) {
        const existingIds = refList
          .filter((r) => r.type === 'EXISTING_PAGE_ID')
          .map((r) => r.target);
        if (existingIds.length > 0) {
          existingRelations[propName] = existingIds;
        }
      }

      // Serialize payload for Stage 1 (scalars + existing relations)
      const serialized = serializePayloadForNotion(
        op.targetDataSource.envKey,
        op.sanitizedPayload,
        existingRelations,
        true,
      );
      const expectedPostFingerprint = calculatePropertiesFingerprint(
        op.targetDataSource.envKey,
        serialized.canonicalProperties,
      );

      // Register operation in journal if not already present
      this.journal.registerOperation({
        runId,
        operationIndex: i,
        stableId: op.stableId,
        stage: 'STAGE_1_PAGE_CREATION',
        targetDataSource: op.targetDataSource.envKey,
        action: 'CREATE',
        expectedPostFingerprint,
      });

      const journalEntry = this.journal.getOperation(runId, i);
      if (journalEntry && (journalEntry.status === 'VERIFIED' || journalEntry.status === 'NO_OP_VERIFIED')) {
        if (journalEntry.targetPageId) {
          this.journal.savePageMapping(plan.backfillPlanHash, op.stableId, journalEntry.targetPageId, op.targetDataSource.envKey);
        }
        if (journalEntry.status === 'NO_OP_VERIFIED') {
          existingPageCreateNoOps++;
        }
        continue;
      }

      // Check stable identity before create (idempotency check)
      const existingPages = await this.adapter.findByStableIdentity(
        op.targetDataSource.envKey,
        stableIdProp,
        op.stableId,
      );

      if (existingPages.length > 1) {
        this.journal.recordFailed(runId, i, 'FAIL_DUPLICATE_STABLE_ID');
        throw new Error(
          `FAIL_DUPLICATE_STABLE_ID: Encontradas ${existingPages.length} páginas com stableId '${op.stableId}'.`,
        );
      }

      if (existingPages.length === 1) {
        const existingRec = existingPages[0];
        const existingFingerprint = calculateRecordFingerprint(
          op.targetDataSource.envKey,
          existingRec.properties,
        );

        let matchesPlan = existingFingerprint === expectedPostFingerprint;

        if (!matchesPlan) {
          const canonicalExisting = canonicalizePageRecord(op.targetDataSource.envKey, existingRec.properties);
          let allStage1PropsMatch = true;

          for (const [k, expectedVal] of Object.entries(serialized.canonicalProperties)) {
            if (JSON.stringify(canonicalExisting[k]) !== JSON.stringify(expectedVal)) {
              allStage1PropsMatch = false;
              break;
            }
          }

          if (allStage1PropsMatch) {
            const allowedDeferredRelations = Object.entries(op.relations)
              .filter(([_, refs]) => refs.some((r) => r.type === 'PLANNED_STABLE_ID'))
              .map(([propName]) => propName);
            allowedDeferredRelations.push(
              'Fatura Vinculada',
              'Lançamentos do Ciclo',
              'Transações de Pagamento',
            );

            let hasUnexpectedExtraProps = false;
            for (const extraKey of Object.keys(canonicalExisting)) {
              if (
                !(extraKey in serialized.canonicalProperties) &&
                !allowedDeferredRelations.includes(extraKey)
              ) {
                hasUnexpectedExtraProps = true;
                break;
              }
            }
            if (!hasUnexpectedExtraProps) {
              matchesPlan = true;
            }
          }
        }

        if (matchesPlan) {
          this.journal.recordVerified(runId, i, existingRec.id, true);
          this.journal.savePageMapping(plan.backfillPlanHash, op.stableId, existingRec.id, op.targetDataSource.envKey);
          existingPageCreateNoOps++;
          if (this.options.canary === 1) {
            this.journal.pauseAfterCanary(runId);
            return {
              executorHeadCommitSha: executorCommitSha,
              executorParentCommitSha,
              planOriginCommitSha: planOriginSha,
              frozenBackfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
              reproducedBackfillPlanHash: plan.backfillPlanHash,
              sourceSnapshotHash: preflightRes.sourceSnapshotHash,
              targetSnapshotHash: preflightRes.targetSnapshotHash,
              targetStateHash: preflightRes.targetStateHash,
              simulationRunId: runId,
              status: 'PAUSED_AFTER_CANARY',
              semanticCreates: 1,
              actualSimulatedCreateWrites,
              existingPageCreateNoOps,
              logicalRelationReferences: 320,
              canonicalRelationPatchGroups: 0,
              actualSimulatedRelationWrites: 0,
              writeRequestsSent,
              retries,
              recoveredUncertainCreates,
              recoveredUncertainRelationWrites,
              journalFinal: this.journal.countByStatus(runId),
              liveNotionMutations: this.adapter.getMutationCount(),
              readyForLiveApplyReview: true,
              readyForApply: false,
              reasons: ['PAUSED_AFTER_CANARY: Execução canary de 1 operação CREATE concluída com sucesso e pausada para auditoria.'],
            };
          }
          continue;
        } else {
          this.journal.recordFailed(runId, i, 'FAIL_CONFLICTING_EXISTING_PAGE');
          throw new Error(
            `FAIL_CONFLICTING_EXISTING_PAGE: Página existente '${existingRec.id}' com stableId '${op.stableId}' possui conteúdo conflitante com o plano.`,
          );
        }
      }

      // Enforce absolute mutation budget limit (max 159 pages)
      const currentNewPagesCount = actualSimulatedCreateWrites;
      if (currentNewPagesCount >= MAX_NEW_PAGES_BUDGET) {
        this.journal.recordFailed(runId, i, 'EXCEEDED_MUTATION_BUDGET');
        throw new Error(`EXCEEDED_MUTATION_BUDGET: Tentativa de exceder o limite de ${MAX_NEW_PAGES_BUDGET} novas páginas.`);
      }

      // Execute CREATE with retry and uncertain write recovery
      let createdPageId: string | null = null;
      let attemptCount = 0;

      while (attemptCount < maxRetries) {
        attemptCount++;
        this.journal.recordAttempt(runId, i);
        await this.durableBarrier('PRE_MUTATION_CREATE');
        writeRequestsSent++;

        try {
          const createRes = await this.adapter.createPage(
            op.targetDataSource.envKey,
            op.targetDataSource.dataSourceId,
            serialized.notionProperties,
          );
          createdPageId = createRes.id;
          this.journal.recordApplied(runId, i, createdPageId);
          break;
        } catch (err: any) {
          // Fail fast without retry on 400, 401, 403, 404, REAL_DML_DISABLED, validation_error
          if (
            err?.status === 400 ||
            err?.status === 401 ||
            err?.status === 403 ||
            err?.status === 404 ||
            (err?.message && err.message.includes('REAL_DML_DISABLED')) ||
            (err?.message && err.message.includes('FAIL_MUTATION_WITHOUT_DURABLE_CHECKPOINT')) ||
            (err?.message && err.message.includes('validation_error'))
          ) {
            this.journal.recordFailed(runId, i, sanitizeErrorMessage(err.message));
            throw err;
          }

          // Check uncertain write: reconcile by stable identity before blind retry
          if (isUncertainError(err)) {
            const reconcile = await this.adapter.findByStableIdentity(
              op.targetDataSource.envKey,
              stableIdProp,
              op.stableId,
            );
            if (reconcile.length === 1) {
              const recFp = calculateRecordFingerprint(op.targetDataSource.envKey, reconcile[0].properties);
              if (recFp === expectedPostFingerprint) {
                createdPageId = reconcile[0].id;
                this.journal.recordApplied(runId, i, createdPageId);
                recoveredUncertainCreates++;
                break;
              }
            }
          }

          if (attemptCount < maxRetries) {
            retries++;
            // If 429, respect Retry-After
            if (err?.status === 429) {
              const waitMs = parseRetryAfterMs(err, retryDelay * 10);
              await new Promise((r) => setTimeout(r, waitMs));
            } else {
              // 5xx exponential backoff with jitter
              const backoff = Math.min(retryDelay * Math.pow(2, attemptCount - 1) + Math.random() * 5, 2000);
              await new Promise((r) => setTimeout(r, backoff));
            }
          } else {
            this.journal.recordFailed(runId, i, sanitizeErrorMessage(err.message));
            throw err;
          }
        }
      }

      if (!createdPageId) {
        this.journal.recordFailed(runId, i, 'FAIL_CREATION_FAILED');
        throw new Error(`FAIL_CREATION_FAILED: Falha na criação da página para '${op.stableId}'.`);
      }

      // Obligatory read-back verification and fingerprint check
      const readBack = await this.adapter.fetchPage(createdPageId);
      if (!readBack) {
        this.journal.recordFailed(runId, i, 'FAIL_READ_BACK_NOT_FOUND');
        throw new Error(`FAIL_READ_BACK_NOT_FOUND: Read-back falhou para página '${createdPageId}'.`);
      }

      const readBackFingerprint = calculateRecordFingerprint(op.targetDataSource.envKey, readBack.properties);
      if (readBackFingerprint !== expectedPostFingerprint) {
        this.journal.recordFailed(runId, i, 'FAIL_READ_BACK_FINGERPRINT_MISMATCH');
        throw new Error(
          `FAIL_READ_BACK_FINGERPRINT_MISMATCH: Fingerprint do read-back (${readBackFingerprint}) diverge do esperado (${expectedPostFingerprint}).`,
        );
      }

      this.journal.recordVerified(runId, i, createdPageId, false);
      this.journal.savePageMapping(plan.backfillPlanHash, op.stableId, createdPageId, op.targetDataSource.envKey);
      await this.durableBarrier('POST_MUTATION_CREATE_VERIFIED');
      actualSimulatedCreateWrites++;

      if (this.options.canary === 1) {
        this.journal.pauseAfterCanary(runId);
        return {
          executorHeadCommitSha: executorCommitSha,
          executorParentCommitSha,
          planOriginCommitSha: planOriginSha,
          frozenBackfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
          reproducedBackfillPlanHash: plan.backfillPlanHash,
          sourceSnapshotHash: preflightRes.sourceSnapshotHash,
          targetSnapshotHash: preflightRes.targetSnapshotHash,
          targetStateHash: preflightRes.targetStateHash,
          simulationRunId: runId,
          status: 'PAUSED_AFTER_CANARY',
          semanticCreates: 1,
          actualSimulatedCreateWrites,
          existingPageCreateNoOps,
          logicalRelationReferences: 320,
          canonicalRelationPatchGroups: 0,
          actualSimulatedRelationWrites: 0,
          writeRequestsSent,
          retries,
          recoveredUncertainCreates,
          recoveredUncertainRelationWrites,
          journalFinal: this.journal.countByStatus(runId),
          liveNotionMutations: this.adapter.getMutationCount(),
          readyForLiveApplyReview: true,
          readyForApply: false,
          reasons: ['PAUSED_AFTER_CANARY: Execução canary de 1 operação CREATE concluída com sucesso e pausada para auditoria.'],
        };
      }
    }

    // Verify Stage 1 completeness: all 159 operations must be VERIFIED or NO_OP_VERIFIED
    const stage1Ops = this.journal
      .getOperations(runId)
      .filter((o) => o.stage === 'STAGE_1_PAGE_CREATION');
    const unverifiedStage1 = stage1Ops.filter(
      (o) => o.status !== 'VERIFIED' && o.status !== 'NO_OP_VERIFIED',
    );
    if (unverifiedStage1.length > 0) {
      this.journal.failRun(runId, 'STAGE_1_INCOMPLETE');
      throw new Error(
        `STAGE_1_INCOMPLETE: ${unverifiedStage1.length} operações do Stage 1 não atingiram estado VERIFIED. Stage 2 não autorizado.`,
      );
    }

    // Item 18: Checkpoint antes do Stage 2: recalcular estado esperado pelo journal e comparar com live
    if (!this.options.skipInitialDriftCheck) {
      const projectedStage1State = this.projectExpectedStateOnResume(preflightRes.preflightBases, plan, runId);
      const projectedStage1Hash = calculateTargetStateHash(projectedStage1State);
      const currentLiveState = await this.adapter.queryTargetState();
      const currentLiveHash = calculateTargetStateHash(currentLiveState);

      const fullyAppliedState = this.projectFullyAppliedState(preflightRes.preflightBases, plan);
      const fullyAppliedHash = calculateTargetStateHash(fullyAppliedState);

      if (currentLiveHash !== projectedStage1Hash && currentLiveHash !== fullyAppliedHash) {
        this.journal.failRun(runId, 'EXTERNAL_DRIFT_DURING_BACKFILL');
        throw new Error(
          `EXTERNAL_DRIFT_DURING_BACKFILL: Target state após Stage 1 (${currentLiveHash}) diverge do estado esperado projetado pelo journal (${projectedStage1Hash}). Stage 2 abortado.`,
        );
      }
    }

    // =========================================================================
    // STAGE 2: Canonical Relation Patch Groups
    // =========================================================================
    const cardBillOps = plan.operations.filter((o) => o.targetDataSource.envKey === 'NOTION_DS_CARD_BILLS');
    canonicalRelationPatchGroups = cardBillOps.length;

    for (let bIdx = 0; bIdx < cardBillOps.length; bIdx++) {
      const billOp = cardBillOps[bIdx];
      const opIdx = 159 + bIdx;

      const mapping = this.journal.getPageMapping(plan.backfillPlanHash, billOp.stableId);
      const billPageId = mapping?.notionPageId;
      if (!billPageId) {
        throw new Error(`FAIL_UNRESOLVED_PLANNED_RELATION: ID da fatura '${billOp.stableId}' não resolvido.`);
      }
      if (mapping.targetDataSource !== 'NOTION_DS_CARD_BILLS') {
        throw new Error(
          `FAIL_MUTATION_TARGET_MISMATCH: Mapeamento da fatura '${billOp.stableId}' pertence a '${mapping.targetDataSource}' em vez de NOTION_DS_CARD_BILLS.`,
        );
      }

      this.journal.registerOperation({
        runId,
        operationIndex: opIdx,
        stableId: billOp.stableId,
        stage: 'STAGE_2_RELATION_PATCHING',
        targetDataSource: billOp.targetDataSource.envKey,
        action: 'RELATION_PATCH',
      });

      const existingJournalOp = this.journal.getOperation(runId, opIdx);
      if (existingJournalOp && (existingJournalOp.status === 'VERIFIED' || existingJournalOp.status === 'NO_OP_VERIFIED')) {
        continue;
      }

      const relationPatches = this.buildRelationPatchesForBill(billOp, plan.backfillPlanHash);

      const isAlreadyApplied = existingJournalOp?.status === 'APPLIED';

      if (!isAlreadyApplied) {
        // Check current relations on the bill page for idempotency
        const currentBillPage = await this.adapter.fetchPage(billPageId);
        if (!currentBillPage) {
          throw new Error(`FAIL_PAGE_NOT_FOUND: Fatura '${billPageId}' não encontrada.`);
        }

        let isPatchRequired = false;
        for (const [relProp, targetIds] of Object.entries(relationPatches)) {
          const rawCurrent = currentBillPage.properties[relProp];
          let currentIds: string[] = [];
          if (rawCurrent && typeof rawCurrent === 'object' && Array.isArray(rawCurrent.relation)) {
            currentIds = rawCurrent.relation.map((r: any) => r.id || r).sort();
          }

          const targetSet = new Set(targetIds);

          for (const cId of currentIds) {
            if (!targetSet.has(cId)) {
              this.journal.recordFailed(runId, opIdx, 'FAIL_RELATION_CONFLICT');
              throw new Error(
                `FAIL_RELATION_CONFLICT: Relação externa inesperada '${cId}' detectada na propriedade '${relProp}' da fatura '${billPageId}'.`,
              );
            }
          }

          if (currentIds.length !== targetIds.length) {
            isPatchRequired = true;
          }
        }

        if (!isPatchRequired) {
          this.journal.recordVerified(runId, opIdx, billPageId, true);
          continue;
        }

        // Execute mutation with retry policy
        let patchSuccess = false;
        let attemptCount = 0;

        while (attemptCount < maxRetries) {
          attemptCount++;
          this.journal.recordAttempt(runId, opIdx);
          await this.durableBarrier('PRE_MUTATION_RELATION_PATCH');
          writeRequestsSent++;

          try {
            await this.adapter.updatePageRelations(
              billOp.targetDataSource.envKey,
              billPageId,
              relationPatches,
            );
            this.journal.recordApplied(runId, opIdx, billPageId);
            patchSuccess = true;
            actualSimulatedRelationWrites++;
            break;
          } catch (err: any) {
            if (
              err?.status === 400 ||
              err?.status === 401 ||
              err?.status === 403 ||
              err?.status === 404 ||
              (err?.message && err.message.includes('REAL_DML_DISABLED')) ||
              (err?.message && err.message.includes('FAIL_MUTATION_WITHOUT_DURABLE_CHECKPOINT')) ||
              (err?.message && err.message.includes('validation_error'))
            ) {
              this.journal.recordFailed(runId, opIdx, sanitizeErrorMessage(err.message));
              throw err;
            }

            if (isUncertainError(err)) {
              const checkPage = await this.adapter.fetchPage(billPageId);
              if (checkPage) {
                let reconciledAll = true;
                for (const [pName, tIds] of Object.entries(relationPatches)) {
                  const rawVal = checkPage.properties[pName];
                  const pCur = Array.isArray(rawVal)
                    ? rawVal.map((r: any) => r.id || r).sort()
                    : (rawVal?.relation || []).map((r: any) => r.id || r).sort();
                  if (JSON.stringify(pCur) !== JSON.stringify(tIds)) {
                    reconciledAll = false;
                    break;
                  }
                }
                if (reconciledAll) {
                  this.journal.recordApplied(runId, opIdx, billPageId);
                  patchSuccess = true;
                  recoveredUncertainRelationWrites++;
                  actualSimulatedRelationWrites++;
                  break;
                }
              }
            }

            if (attemptCount < maxRetries) {
              retries++;
              if (err?.status === 429) {
                const waitMs = parseRetryAfterMs(err, retryDelay * 10);
                await new Promise((r) => setTimeout(r, waitMs));
              } else {
                const backoff = Math.min(retryDelay * Math.pow(2, attemptCount - 1) + Math.random() * 5, 2000);
                await new Promise((r) => setTimeout(r, backoff));
              }
            } else {
              this.journal.recordFailed(runId, opIdx, sanitizeErrorMessage(err.message));
              throw err;
            }
          }
        }

        if (!patchSuccess) {
          this.journal.recordFailed(runId, opIdx, 'FAIL_RELATION_PATCH_FAILED');
          throw new Error(`FAIL_RELATION_PATCH_FAILED: Falha ao aplicar patch de relações na fatura '${billPageId}'.`);
        }
      }

      // Stage 2 Verification Order: mutation -> APPLIED -> fetchPage -> verify relation sets -> verify dual relation -> VERIFIED
      const verifiedBillPage = await this.adapter.fetchPage(billPageId);
      if (!verifiedBillPage) {
        this.journal.recordFailed(runId, opIdx, 'FAIL_PAGE_NOT_FOUND');
        throw new Error(`FAIL_PAGE_NOT_FOUND: Fatura pós-patch '${billPageId}' não encontrada.`);
      }

      for (const [relProp, expectedIds] of Object.entries(relationPatches)) {
        const rawLive = verifiedBillPage.properties[relProp];
        const liveIds = (Array.isArray(rawLive) ? rawLive : (rawLive?.relation || [])).map((r: any) => r.id || r).sort();
        if (JSON.stringify(liveIds) !== JSON.stringify(expectedIds)) {
          this.journal.recordFailed(runId, opIdx, 'FAIL_RELATION_VERIFICATION_MISMATCH');
          throw new Error(
            `FAIL_RELATION_VERIFICATION_MISMATCH: Propriedade '${relProp}' da fatura diverge do esperado após patch.`,
          );
        }
      }

      // Verify dual relations on all 20 purchase transactions
      const purchaseIds = relationPatches['Lançamentos do Ciclo'] || [];
      for (const txId of purchaseIds) {
        const txPage = await this.adapter.fetchPage(txId);
        if (!txPage) {
          this.journal.recordFailed(runId, opIdx, 'FAIL_DUAL_RELATION_VERIFICATION');
          throw new Error(`FAIL_DUAL_RELATION_VERIFICATION: Transação de compra '${txId}' não encontrada.`);
        }
        const rawLinked = txPage.properties['Fatura Vinculada'];
        const linkedBills = (Array.isArray(rawLinked) ? rawLinked : (rawLinked?.relation || [])).map((r: any) => r.id || r);
        if (!linkedBills.includes(billPageId)) {
          this.journal.recordFailed(runId, opIdx, 'FAIL_DUAL_RELATION_VERIFICATION');
          throw new Error(
            `FAIL_DUAL_RELATION_VERIFICATION: Transação '${txId}' não possui vínculo dual com a fatura '${billPageId}'.`,
          );
        }
      }

      this.journal.recordVerified(runId, opIdx, billPageId, false);
      await this.durableBarrier('POST_MUTATION_RELATION_PATCH_VERIFIED');
    }

    // Complete run in journal
    this.journal.completeRun(runId);
    const finalCounts = this.journal.countByStatus(runId);

    // Live Notion mutations check: derived strictly from adapter
    const liveNotionMutations = this.adapter.getMutationCount();
    if (!isLive && liveNotionMutations !== 0) {
      throw new Error(`FAIL_LIVE_MUTATIONS_DETECTED: Detectadas ${liveNotionMutations} mutações live na Notion API em modo simulação.`);
    }

    const totalVerified = finalCounts.VERIFIED + finalCounts.NO_OP_VERIFIED;
    const isSuccess = finalCounts.FAILED === 0 && totalVerified === 163;
    const readyForLiveApplyReview = isSuccess && (!isLive ? liveNotionMutations === 0 : true);

    return {
      executorHeadCommitSha: executorCommitSha,
      executorParentCommitSha,
      planOriginCommitSha: planOriginSha,
      frozenBackfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
      reproducedBackfillPlanHash: plan.backfillPlanHash,
      sourceSnapshotHash: preflightRes.sourceSnapshotHash,
      targetSnapshotHash: preflightRes.targetSnapshotHash,
      targetStateHash: preflightRes.targetStateHash,
      simulationRunId: runId,
      status: 'COMPLETED',
      semanticCreates,
      actualSimulatedCreateWrites,
      existingPageCreateNoOps,
      logicalRelationReferences: 320,
      canonicalRelationPatchGroups,
      actualSimulatedRelationWrites,
      writeRequestsSent,
      retries,
      recoveredUncertainCreates,
      recoveredUncertainRelationWrites,
      journalFinal: finalCounts,
      liveNotionMutations,
      readyForLiveApplyReview,
      readyForApply: false,
      reasons: [],
    };
  }

  /**
   * Mode: --recover-canary-only (Item 10)
   * Strictly read-only on Notion API (0 HTTP mutations permitted).
   * Reconciles Canary Op #0 from FAILED -> VERIFIED using the existing live page and, in a single
   * atomic journal transaction, records the audit event, confirms the page mapping and sets the run
   * to PAUSED_AFTER_CANARY. Never proceeds to operation #1.
   *
   * Fail-closed preconditions (all validated before any Notion read or journal write):
   *  - plan.backfillPlanHash == FROZEN_BACKFILL_PLAN_HASH == run.planHash == preflight.backfillPlanHash;
   *  - run IN_PROGRESS; op0 exists, CREATE, NOTION_DS_TRANSACTIONS, FAILED, attempts == 1, targetPageId != null;
   *  - live stable-identity match is unique and liveRecord.id == op0.targetPageId.
   * A second invocation after a successful recovery is a no-op (RECOVERY_ALREADY_APPLIED).
   */
  public async executeRecoverCanaryOnly(
    resumeRunId: string,
    preflightArtifact: ResumePreflightArtifact,
  ): Promise<BackfillExecutorReport> {
    this.assertDurabilityForLive();

    // 1. Validate run in journal
    const run = this.journal.getRun(resumeRunId);
    if (!run) {
      throw new Error(`FAIL_RESUME_NO_RUN_FOUND: Run '${resumeRunId}' não encontrado no journal.`);
    }

    const executorCommitSha = this.getGitCommitSha();
    const planOriginSha = this.options.planOriginCommitSha || PLAN_ORIGIN_COMMIT_SHA;

    // 2. Validate cross-commit gates if cross-commit (Item 9)
    if (run.executorCommitSha !== executorCommitSha) {
      const gateFromCommit = this.envVars.FINANCIAL_BACKFILL_RECOVERY_FROM_COMMIT?.trim();
      const gateRunId = this.envVars.FINANCIAL_BACKFILL_RECOVERY_RUN_ID?.trim();
      if (gateFromCommit !== run.executorCommitSha || gateRunId !== resumeRunId) {
        throw new Error(
          `FAIL_CROSS_COMMIT_RECOVERY_AUTHORIZATION: Recovery cross-commit (${run.executorCommitSha} -> ${executorCommitSha}) exige FINANCIAL_BACKFILL_RECOVERY_FROM_COMMIT='${run.executorCommitSha}' e FINANCIAL_BACKFILL_RECOVERY_RUN_ID='${resumeRunId}'.`,
        );
      }
    }

    // 3. Reproduce plan and bind all four plan hashes
    const plan = this.options.planProvider
      ? await this.options.planProvider()
      : (await new BackfillDryRunAnalyzer({ envVars: this.envVars, commitSha: planOriginSha }).runAnalysis())
          .planArtifact;

    if (
      plan.backfillPlanHash !== FROZEN_BACKFILL_PLAN_HASH ||
      run.planHash !== FROZEN_BACKFILL_PLAN_HASH ||
      preflightArtifact.backfillPlanHash !== FROZEN_BACKFILL_PLAN_HASH
    ) {
      throw new Error(
        `FAIL_RECOVERY_PLAN_HASH_MISMATCH: plan=${plan.backfillPlanHash}, frozen=${FROZEN_BACKFILL_PLAN_HASH}, run=${run.planHash}, preflight=${preflightArtifact.backfillPlanHash}.`,
      );
    }

    const op0 = plan.operations[CANARY_OPERATION_INDEX];
    if (!op0) {
      throw new Error('FAIL_RECOVERY_OP_STATE_INVALID: Plano reproduzido não contém a operação 0.');
    }
    const journalOp0 = this.journal.getOperation(resumeRunId, CANARY_OPERATION_INDEX);

    // 4. Idempotency: a completed recovery is a safe no-op (no event, no journal write, no Notion call)
    if (
      run.status === 'PAUSED_AFTER_CANARY' &&
      journalOp0 &&
      journalOp0.status === 'VERIFIED' &&
      journalOp0.targetPageId &&
      journalOp0.stableId === op0.stableId &&
      this.journal.getPageMapping(plan.backfillPlanHash, op0.stableId)?.notionPageId === journalOp0.targetPageId &&
      this.journal
        .getOperationEvents(resumeRunId)
        .some(
          (e) =>
            e.operationIndex === CANARY_OPERATION_INDEX &&
            e.previousStatus === 'FAILED' &&
            e.newStatus === 'VERIFIED' &&
            e.reasonCode === CANARY_RECOVERY_REASON_CODE,
        )
    ) {
      return this.buildRecoveryReport({
        runId: resumeRunId,
        executorCommitSha,
        planOriginSha,
        reproducedPlanHash: plan.backfillPlanHash,
        outcome: 'RECOVERY_ALREADY_APPLIED',
      });
    }

    // 5. Exact journal state required for recovery (ops 1..158 may not exist yet)
    if (run.status !== 'IN_PROGRESS') {
      throw new Error(
        `FAIL_RECOVERY_RUN_STATE_INVALID: Run '${resumeRunId}' deve estar IN_PROGRESS para recovery (atual: ${run.status}).`,
      );
    }
    if (!journalOp0) {
      throw new Error(`FAIL_OPERATION_NOT_FOUND: Operação 0 não registrada no journal para run '${resumeRunId}'.`);
    }
    const stateViolations: string[] = [];
    if (journalOp0.action !== 'CREATE') stateViolations.push(`action=${journalOp0.action}`);
    if (journalOp0.targetDataSource !== 'NOTION_DS_TRANSACTIONS') {
      stateViolations.push(`targetDataSource=${journalOp0.targetDataSource}`);
    }
    if (journalOp0.status !== 'FAILED') stateViolations.push(`status=${journalOp0.status}`);
    if (journalOp0.attempts !== 1) stateViolations.push(`attempts=${journalOp0.attempts}`);
    if (!journalOp0.targetPageId) stateViolations.push('targetPageId=null');
    if (journalOp0.stableId !== op0.stableId) stateViolations.push('stableId diverge do plano');
    if (op0.operationType !== 'CREATE' || op0.targetDataSource.envKey !== journalOp0.targetDataSource) {
      stateViolations.push('operação 0 do plano diverge do journal');
    }
    if (!journalOp0.expectedPostFingerprint) stateViolations.push('expectedPostFingerprint=null');
    if (stateViolations.length > 0) {
      throw new Error(
        `FAIL_RECOVERY_OP_STATE_INVALID: Operação 0 fora do estado exato exigido para recovery: ${stateViolations.join(', ')}.`,
      );
    }

    // 6. Validate journal fingerprint against resume preflight
    const currentJournalFp = calculateJournalFingerprint(this.journal, resumeRunId);
    if (preflightArtifact.journalFingerprint !== currentJournalFp) {
      throw new Error(
        `FAIL_RESUME_PREFLIGHT_BINDING: journalFingerprint do artefato (${preflightArtifact.journalFingerprint}) diverge do journal atual (${currentJournalFp}).`,
      );
    }

    // 7. Query live stable identity for Op #0 (read-only)
    const idSpec = resolveStableIdentitySpec(op0);
    const existingMatches = await this.adapter.findByStableIdentity(
      op0.targetDataSource.envKey,
      idSpec.physicalProperty,
      op0.stableId,
    );

    if (existingMatches.length === 0) {
      throw new Error(
        `FAIL_CANARY_RECOVERY_PAGE_NOT_FOUND: Nenhuma página encontrada no Notion para stableId '${op0.stableId}'.`,
      );
    }
    if (existingMatches.length > 1) {
      throw new Error(
        `FAIL_DUPLICATE_STABLE_ID: Múltiplas páginas (${existingMatches.length}) encontradas com stableId '${op0.stableId}'.`,
      );
    }

    const liveRecord = existingMatches[0];
    if (liveRecord.id !== journalOp0.targetPageId) {
      throw new Error(
        `FAIL_CANARY_RECOVERY_PAGE_ID_MISMATCH: Página live (${liveRecord.id}) diverge do targetPageId do journal (${journalOp0.targetPageId}).`,
      );
    }

    const normalizedFingerprint = calculateRecordFingerprint(
      op0.targetDataSource.envKey,
      liveRecord.properties,
    );
    if (normalizedFingerprint !== journalOp0.expectedPostFingerprint) {
      throw new Error(
        `FAIL_READ_BACK_FINGERPRINT_MISMATCH: Fingerprint normalizado (${normalizedFingerprint}) diverge do esperado (${journalOp0.expectedPostFingerprint}).`,
      );
    }

    // Strict invariant: verify 0 mutations occurred during recovery
    const mutationCount = this.adapter.getMutationCount();
    if (mutationCount !== 0) {
      throw new Error(`FAIL_MUTATION_DURING_RECOVERY: Recovery executou ${mutationCount} mutações no Notion. Permitido: 0.`);
    }

    // 8. Atomic FAILED -> VERIFIED + audit event + page mapping + PAUSED_AFTER_CANARY (Item 11)
    this.journal.applyCanaryRecoveryAtomically({
      runId: resumeRunId,
      operationIndex: CANARY_OPERATION_INDEX,
      targetPageId: liveRecord.id,
      planHash: plan.backfillPlanHash,
      stableId: op0.stableId,
      targetDataSource: op0.targetDataSource.envKey,
      executorCommitSha,
      reasonCode: CANARY_RECOVERY_REASON_CODE,
    });
    await this.durableBarrier('RECOVERY_APPLIED');

    return this.buildRecoveryReport({
      runId: resumeRunId,
      executorCommitSha,
      planOriginSha,
      reproducedPlanHash: plan.backfillPlanHash,
      outcome: 'RECOVERY_APPLIED',
    });
  }

  private buildRecoveryReport(params: {
    runId: string;
    executorCommitSha: string;
    planOriginSha: string;
    reproducedPlanHash: string;
    outcome: 'RECOVERY_APPLIED' | 'RECOVERY_ALREADY_APPLIED';
  }): BackfillExecutorReport {
    const applied = params.outcome === 'RECOVERY_APPLIED';
    return {
      executorHeadCommitSha: params.executorCommitSha,
      executorParentCommitSha: this.getGitParentSha(),
      planOriginCommitSha: params.planOriginSha,
      frozenBackfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
      reproducedBackfillPlanHash: params.reproducedPlanHash,
      sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
      targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
      targetStateHash: FROZEN_TARGET_STATE_HASH,
      simulationRunId: params.runId,
      status: 'PAUSED_AFTER_CANARY',
      semanticCreates: 1,
      actualSimulatedCreateWrites: 0,
      existingPageCreateNoOps: applied ? 1 : 0,
      logicalRelationReferences: 320,
      canonicalRelationPatchGroups: 0,
      actualSimulatedRelationWrites: 0,
      writeRequestsSent: 0,
      retries: 0,
      recoveredUncertainCreates: applied ? 1 : 0,
      recoveredUncertainRelationWrites: 0,
      logicalCreates: 0,
      createHttpAttempts: 0,
      logicalRelationPatches: 0,
      relationPatchHttpAttempts: 0,
      pagesCreatedDuringRecovery: 0,
      journalFinal: this.journal.countByStatus(params.runId),
      liveNotionMutations: this.adapter.getMutationCount(),
      readyForLiveApplyReview: true,
      readyForApply: false,
      recoveryOutcome: params.outcome,
      reasons: [
        applied
          ? 'PAUSED_AFTER_CANARY: Canary recuperado com sucesso e journal atualizado para PAUSED_AFTER_CANARY.'
          : 'RECOVERY_ALREADY_APPLIED: Recovery do canary já aplicado; nenhuma escrita realizada.',
      ],
    };
  }

  public close(): void {
    if (this.ownJournal) {
      this.journal.close();
    }
  }
}
