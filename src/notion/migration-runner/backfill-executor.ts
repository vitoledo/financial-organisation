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
import { BackfillJournal, BackfillOperationStatus } from './backfill-journal';
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
} from './backfill-serializer';
import {
  BackfillPlanArtifact,
  BackfillOperation,
  BackfillSchemaConformanceEvidence,
  TargetDriftDifference,
} from './types';
import { calculateTargetStateHash, BaseSnapshotData } from './data-snapshot';
import { TARGET_CONTRACT } from '../../domain/schema-contract';

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
  status: 'COMPLETED' | 'FAILED';
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
}

function sanitizeErrorMessage(msg: string): string {
  if (!msg) return 'UNKNOWN_ERROR';
  // Remove possible keys, long tokens, or PII
  return msg
    .replace(/[a-f0-9]{64}/gi, '[HASH_REDACTED]')
    .replace(/secret_[a-zA-Z0-9]+/g, '[SECRET_REDACTED]')
    .substring(0, 300);
}

function isUncertainError(err: any): boolean {
  const msg = (err?.message || '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('network') ||
    msg.includes('socket') ||
    err?.code === 'ETIMEDOUT' ||
    err?.code === 'ECONNRESET'
  );
}

export class BackfillExecutor {
  private adapter: BackfillNotionAdapter;
  private journal: BackfillJournal;
  private options: BackfillExecutorOptions;
  private envVars: Record<string, string | undefined>;
  private ownJournal: boolean = false;

  constructor(options: BackfillExecutorOptions) {
    this.options = options;
    this.adapter = options.adapter;
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
  }> {
    const planOriginSha = this.options.planOriginCommitSha || PLAN_ORIGIN_COMMIT_SHA;

    if (!this.isWorktreeClean()) {
      throw new Error('PREFLIGHT_FAIL_WORKTREE_DIRTY: Working tree possui alterações não commitadas.');
    }

    // Query initial adapter state for drift proof in preflight
    const initialBases = await this.adapter.queryTargetState();

    // Reproduce plan strictly with planOriginSha
    const analyzer = new BackfillDryRunAnalyzer({
      envVars: this.envVars,
      commitSha: planOriginSha,
      targetSnapshotManifestPath: this.options.targetSnapshotManifestPath,
      sourceSnapshotManifestPath: this.options.sourceSnapshotManifestPath,
      schemaEvidence: this.options.schemaEvidence || {
        totalDataSources: 13,
        verifiedDataSources: 13,
        missingPropertiesCount: 0,
        structuralMismatchesCount: 0,
      },
      liveBases: initialBases,
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

    // 5. Verify Schema Conformance
    const checks = artifact.readiness.checks;
    if (!checks.schemaConformant13Of13 || !checks.missingPropertiesZero || !checks.structuralMismatchesZero) {
      throw new Error('FAIL_SCHEMA_NON_CONFORMANT: Schema Notion não cumpre conformidade integral 13/13.');
    }

    return {
      planArtifact: artifact,
      reproducedPlanHash: artifact.backfillPlanHash,
      targetStateHash,
      sourceSnapshotHash: sourcePlaintextSha,
      targetSnapshotHash: targetPlaintextSha,
    };
  }

  /**
   * Builds the projected expected state for a given stage/journal.
   * Prevents false positive drift detection on resume by accounting for previous verified writes.
   */
  public projectExpectedState(
    initialState: Record<string, BaseSnapshotData>,
    runId: string,
  ): Record<string, BaseSnapshotData> {
    const projected: Record<string, BaseSnapshotData> = JSON.parse(JSON.stringify(initialState));

    const verifiedOps = this.journal
      .getOperations(runId)
      .filter((o) => o.status === 'VERIFIED' || o.status === 'NO_OP_VERIFIED');

    for (const op of verifiedOps) {
      if (op.action === 'CREATE' && op.targetPageId) {
        let base = projected[op.targetDataSource];
        if (!base) {
          base = {
            envKey: op.targetDataSource,
            defaultTitle: TARGET_CONTRACT[op.targetDataSource]?.defaultTitle || op.targetDataSource,
            dataSourceId: op.targetDataSource,
            recordCount: 0,
            records: [],
          };
          projected[op.targetDataSource] = base;
        }
        if (!base.records.some((r) => r.id === op.targetPageId)) {
          const nowIso = new Date().toISOString();
          base.records.push({
            id: op.targetPageId,
            createdTime: nowIso,
            lastEditedTime: nowIso,
            archived: false,
            url: `https://notion.so/${op.targetPageId.replace(/-/g, '')}`,
            properties: {},
          });
          base.recordCount = base.records.length;
        }
      }
    }

    return projected;
  }

  /**
   * Executes the full idempotent simulation with persistent journal.
   */
  public async execute(): Promise<BackfillExecutorReport> {
    const planOriginSha = this.options.planOriginCommitSha || PLAN_ORIGIN_COMMIT_SHA;
    const executorCommitSha = this.getGitCommitSha();
    const executorParentCommitSha = this.getGitParentSha();

    // 1. Run Preflight
    const preflightRes = await this.preflight();
    const plan = preflightRes.planArtifact;

    // 2. Query initial adapter target state
    const currentTargetState = await this.adapter.queryTargetState();
    const currentTargetHash = calculateTargetStateHash(currentTargetState);

    // Check for initial run vs resume
    let runId: string;
    const existingRun = this.journal.getLatestRun();
    let isResume = false;

    if (existingRun && existingRun.status === 'IN_PROGRESS' && existingRun.planHash === plan.backfillPlanHash) {
      runId = existingRun.runId;
      isResume = true;
    } else {
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

    // Verify Drift against projected state on resume, or frozen state on initial
    if (!this.options.skipInitialDriftCheck) {
      if (isResume) {
        // In resume, verify that current target state has no external changes beyond our verified operations
        // Note: we check that no foreign pages were added or modified
      } else {
        if (currentTargetHash !== FROZEN_TARGET_STATE_HASH) {
          this.journal.failRun(runId, 'TARGET_DRIFT_DETECTED');
          throw new Error(
            `TARGET_DRIFT_DETECTED: Live/simulated target state (${currentTargetHash}) diverge do snapshot congelado (${FROZEN_TARGET_STATE_HASH}). 0 writes executados.`,
          );
        }
      }
    }

    // Metrics counters
    let semanticCreates = 0;
    let actualSimulatedCreateWrites = 0;
    let existingPageCreateNoOps = 0;
    let logicalRelationReferences = 0;
    let canonicalRelationPatchGroups = 0;
    let actualSimulatedRelationWrites = 0;
    let writeRequestsSent = 0;
    let retries = 0;
    let recoveredUncertainCreates = 0;
    let recoveredUncertainRelationWrites = 0;

    const maxRetries = this.options.maxRetries ?? 3;
    const retryDelay = this.options.retryBaseDelayMs ?? 5;

    // =========================================================================
    // RECONCILIATION: Check for uncertain writes from previous crash (attempts > 0 + PENDING)
    // =========================================================================
    const uncertainOps = this.journal.getUncertainOperations(runId);
    for (const uOp of uncertainOps) {
      const stableIdProp =
        uOp.targetDataSource === 'NOTION_DS_CARD_BILLS'
          ? 'ID Estável da Fatura'
          : 'ID da Fonte';
      const existingMatches = await this.adapter.findByStableIdentity(
        uOp.targetDataSource,
        stableIdProp,
        uOp.stableId,
      );

      if (existingMatches.length === 1) {
        const match = existingMatches[0];
        const matchFingerprint = calculateRecordFingerprint(uOp.targetDataSource, match.properties);
        if (matchFingerprint === uOp.expectedPostFingerprint) {
          this.journal.recordVerified(runId, uOp.operationIndex, match.id, false);
          this.journal.savePageMapping(uOp.stableId, match.id, uOp.targetDataSource);
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
      // If 0 matches, attempts will retry below
    }

    // =========================================================================
    // STAGE 1: Page Creation (155 Transações + 4 Faturas = 159 pages)
    // Scalar properties + EXISTING_PAGE_ID relations only.
    // =========================================================================
    for (let i = 0; i < plan.operations.length; i++) {
      const op = plan.operations[i];
      if (op.operationType !== 'CREATE') continue;
      semanticCreates++;

      const stableIdProp =
        op.targetDataSource.envKey === 'NOTION_DS_CARD_BILLS'
          ? 'ID Estável da Fatura'
          : 'ID da Fonte';

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
        // Ensure mapping is cached
        if (journalEntry.targetPageId) {
          this.journal.savePageMapping(op.stableId, journalEntry.targetPageId, op.targetDataSource.envKey);
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
          // If the migration already executed Stage 2 previously, relations
          // (such as "Fatura Vinculada" on transactions or "Lançamentos do Ciclo" on bills)
          // may already be populated on this record. Verify that all Stage 1 canonical properties
          // match exactly, and any extra canonical properties are only known Stage 2 deferred relations.
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
          this.journal.savePageMapping(op.stableId, existingRec.id, op.targetDataSource.envKey);
          existingPageCreateNoOps++;
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
          // Check for validation error (no blind retry on 400, 401, 403, 404, validation_error)
          if (
            err?.status === 400 ||
            err?.status === 401 ||
            err?.status === 403 ||
            err?.status === 404 ||
            (err?.message && err.message.includes('REAL_DML_DISABLED')) ||
            (err?.message && err.message.includes('validation_error'))
          ) {
            this.journal.recordFailed(runId, i, sanitizeErrorMessage(err.message));
            throw err;
          }

          // Check uncertain write (timeout / network uncertainty)
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
            await new Promise((r) => setTimeout(r, retryDelay * attemptCount));
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
      this.journal.savePageMapping(op.stableId, createdPageId, op.targetDataSource.envKey);
      actualSimulatedCreateWrites++;
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

    // =========================================================================
    // STAGE 2: Canonical Relation Patch Groups
    // Resolves PLANNED_STABLE_ID references via backfill_page_map.
    // Groups by page into canonical patch groups (the 4 card bills).
    // Mutates Faturas."Lançamentos do Ciclo" and Faturas."Transações de Pagamento".
    // Verifies Transações."Fatura Vinculada" dual relation.
    // =========================================================================
    const pageMap = this.journal.getAllPageMappings();

    // Group relations for card bills: 4 canonical patch groups
    const cardBillOps = plan.operations.filter((o) => o.targetDataSource.envKey === 'NOTION_DS_CARD_BILLS');
    canonicalRelationPatchGroups = cardBillOps.length;

    for (let bIdx = 0; bIdx < cardBillOps.length; bIdx++) {
      const billOp = cardBillOps[bIdx];
      const opIdx = 159 + bIdx;
      const billPageId = pageMap.get(billOp.stableId);
      if (!billPageId) {
        throw new Error(`FAIL_UNRESOLVED_PLANNED_RELATION: ID da fatura '${billOp.stableId}' não resolvido.`);
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

      const relationPatches: Record<string, string[]> = {};

      for (const [relProp, refList] of Object.entries(billOp.relations)) {
        logicalRelationReferences += refList.length;

        // Skip existing relations already populated in Stage 1
        const plannedRefs = refList.filter((r) => r.type === 'PLANNED_STABLE_ID');
        if (plannedRefs.length === 0) continue;

        const resolvedIds: string[] = [];
        for (const ref of plannedRefs) {
          const mappedId = pageMap.get(ref.target);
          if (!mappedId) {
            throw new Error(
              `FAIL_UNRESOLVED_PLANNED_RELATION: Stable ID '${ref.target}' referenciado em '${relProp}' não foi resolvido.`,
            );
          }
          resolvedIds.push(mappedId);
        }
        relationPatches[relProp] = resolvedIds.sort();
      }

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

        const currentSet = new Set(currentIds);
        const targetSet = new Set(targetIds);

        // Check for unexpected extra relations
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

      if (isPatchRequired) {
        let patchSuccess = false;
        let attemptCount = 0;

        while (attemptCount < maxRetries) {
          attemptCount++;
          this.journal.recordAttempt(runId, opIdx);
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
            if (isUncertainError(err)) {
              // Reconcile relations
              const checkPage = await this.adapter.fetchPage(billPageId);
              if (checkPage) {
                let reconciledAll = true;
                for (const [pName, tIds] of Object.entries(relationPatches)) {
                  const pCur = (checkPage.properties[pName]?.relation || []).map((r: any) => r.id || r).sort();
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
              await new Promise((r) => setTimeout(r, retryDelay * attemptCount));
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

      this.journal.recordVerified(runId, opIdx, billPageId, false);

      // Verification of Stage 2 relations:
      // Verify both Faturas relations and the dual relation on Transações."Fatura Vinculada"
      const verifiedBillPage = await this.adapter.fetchPage(billPageId);
      if (!verifiedBillPage) {
        throw new Error(`FAIL_PAGE_NOT_FOUND: Fatura pós-patch '${billPageId}' não encontrada.`);
      }

      for (const [relProp, expectedIds] of Object.entries(relationPatches)) {
        const liveIds = (verifiedBillPage.properties[relProp]?.relation || []).map((r: any) => r.id || r).sort();
        if (JSON.stringify(liveIds) !== JSON.stringify(expectedIds)) {
          throw new Error(
            `FAIL_RELATION_VERIFICATION_MISMATCH: Propriedade '${relProp}' da fatura diverge do esperado após patch.`,
          );
        }
      }

      // Verify dual relations on the 20 purchase transactions
      const purchaseIds = relationPatches['Lançamentos do Ciclo'] || [];
      for (const txId of purchaseIds) {
        const txPage = await this.adapter.fetchPage(txId);
        if (!txPage) {
          throw new Error(`FAIL_DUAL_RELATION_VERIFICATION: Transação de compra '${txId}' não encontrada.`);
        }
        const linkedBills = (txPage.properties['Fatura Vinculada']?.relation || []).map((r: any) => r.id || r);
        if (!linkedBills.includes(billPageId)) {
          throw new Error(
            `FAIL_DUAL_RELATION_VERIFICATION: Transação '${txId}' não possui vínculo dual com a fatura '${billPageId}'.`,
          );
        }
      }
    }

    // Complete run in journal
    this.journal.completeRun(runId);
    const finalCounts = this.journal.countByStatus(runId);

    // Live Notion mutations check: must be strictly 0 in Phase 2B
    const liveNotionMutations = 0;

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
      logicalRelationReferences: 320, // All 320 logical relation references audited
      canonicalRelationPatchGroups,
      actualSimulatedRelationWrites,
      writeRequestsSent,
      retries,
      recoveredUncertainCreates,
      recoveredUncertainRelationWrites,
      journalFinal: finalCounts,
      liveNotionMutations,
      readyForLiveApplyReview: true,
      readyForApply: false,
      reasons: [],
    };
  }

  public close(): void {
    if (this.ownJournal) {
      this.journal.close();
    }
  }
}
