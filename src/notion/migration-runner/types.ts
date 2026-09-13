/**
 * Types and interfaces for the Notion Migration Runner.
 * Supports deterministic schema planning (DDL) and backfill planning (DML),
 * strictly read-only preflight checks, AES-256-GCM backups, and plan hashing.
 */

export type MigrationOperation =
  | 'CREATE_PROPERTY'
  | 'ALTER_SELECT_OPTIONS'
  | 'CREATE_DATABASE'
  | 'RESOLVE_DATA_SOURCE_ID'
  | 'CREATE_DUAL_RELATION';

export type MigrationRisk = 'LOW' | 'MEDIUM' | 'HIGH';

export interface TargetDataSource {
  envKey: string;
  name: string;
  id?: string;
}

export interface MigrationStep {
  stepNumber: number;
  operation: MigrationOperation;
  targetDataSource: TargetDataSource;
  property?: string;
  precondition: string;
  sanitizedPayload: Record<string, any>;
  postcondition: string;
  risk: MigrationRisk;
  rollback: string;
  dependsOnStep?: number;
  metadata?: Record<string, any>;
}

export interface SchemaPlanSummary {
  totalSteps: number;
  createPropertyCount: number;
  alterOptionsCount: number;
  createDatabaseCount: number;
  resolveDataSourceCount: number;
  dualRelationCount: number;
  byDataSource: Record<string, number>;
}

export interface SchemaPlan {
  version: string;
  notionApiVersion: string;
  summary: SchemaPlanSummary;
  steps: MigrationStep[];
}

export interface BackfillPipeline {
  id: string;
  name: string;
  targetDataSource: {
    envKey: string;
    name: string;
  };
  mode: 'IDEMPOTENT_CHECKPOINTED';
  description: string;
  readStrategy: string;
  transformStrategy: string;
  writeStrategy: string;
  verificationStrategy: string;
  dependencies: string[];
}

export interface BackfillPlan {
  version: string;
  totalPipelines: number;
  pipelines: BackfillPipeline[];
}

export type AccountResolutionState =
  | 'SOURCE_ACCOUNT_ID'
  | 'LEGACY_ACCOUNT_MAPPING'
  | 'DETERMINISTIC_RULE'
  | 'UNRESOLVED';

export interface TransactionResolutionAudit {
  sourceTransactionId: string;
  date: string;
  amount: number;
  sanitizedDescription: string;
  flowDirection: 'Entrada' | 'Saída';
  originalAccountId: string;
  resolvedAccountName: string;
  resolvedAccountPageId: string;
  resolutionMethod: AccountResolutionState;
  confidenceStatus: 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'UNRESOLVED';
}

export type RelationReferenceType = 'EXISTING_PAGE_ID' | 'PLANNED_STABLE_ID';

export interface TypedRelationReference {
  type: RelationReferenceType;
  target: string;
}

export type BackfillExecutionStage = 'STAGE_1_PAGE_CREATION' | 'STAGE_2_RELATION_PATCHING';

export type PaymentLegRole = 'BANK_CASH_LEG' | 'CARD_LIABILITY_LEG' | 'UNPAIRED_PAYMENT';

export interface PaymentLegAuditItem {
  txId: string;
  account: string;
  accountType: 'BANK' | 'CREDIT';
  date: string;
  signedAmount: number;
  sourceId: string;
  possiblePairId: string | null;
  role: PaymentLegRole;
  targetBillStableId?: string;
  description: string;
}

export type InflowCategoryClassification =
  | 'FAMILY_TRANSFER'
  | 'THIRD_PARTY_TRANSFER'
  | 'SAME_OWNERSHIP_TRANSFER'
  | 'SALARY_INCOME'
  | 'REIMBURSEMENT'
  | 'UNCLASSIFIED_INFLOW';

export interface IncomingTransferAuditItem {
  txId: string;
  date: string;
  amount: number;
  description: string;
  counterpartyName: string;
  counterpartyType: InflowCategoryClassification;
  economicNature: string;
  budgetEffect: string;
  reviewStatus: 'Confirmado Auto' | 'Pendente Revisão';
  reviewReason: string | null;
  hasDocumentaryProof: boolean;
}

export interface CardBillFieldProvenance {
  title: 'DERIVED';
  source: 'SOURCE' | 'CONFIGURED';
  sourceBillId: 'SOURCE' | 'CONFIGURED';
  stableBillId: 'DERIVED';
  identityQuality: 'SOURCE' | 'CONFIGURED';
  cycleType: 'SOURCE' | 'CONFIGURED';
  valueQuality: 'DERIVED' | 'CONFIGURED';
  status: 'DERIVED' | 'CONFIGURED';
  dates: 'SOURCE' | 'DERIVED' | 'CONFIGURED';
  purchasesTotal: 'DERIVED';
  paidAmount: 'DERIVED' | 'CONFIGURED';
  settlementDate: 'DERIVED' | 'CONFIGURED';
}

export type BackfillOperationType = 'CREATE' | 'UPDATE';

export type BackfillOperationClassification =
  | 'EXECUTABLE_MIGRATION'
  | 'PROPOSED_DERIVED_UPDATE_REQUIRES_REVIEW';

export interface BackfillOperation {
  operationType: BackfillOperationType;
  classification: BackfillOperationClassification;
  stage: BackfillExecutionStage;
  stableId: string;
  targetDataSource: {
    envKey: string;
    dataSourceId: string;
    name: string;
  };
  sanitizedPayload: Record<string, any>;
  relations: Record<string, TypedRelationReference[]>;
  dependencies: TypedRelationReference[];
  reason: string;
  expectedPriorState?: Record<string, any>;
}

export interface CardBillAuditItem {
  stableBillId: string;
  cartao: string;
  inicio: string;
  fim: string;
  fechamento: string;
  vencimento: string;
  dataLiquidacao: string | null;
  status: string;
  origem: string;
  qualidade: string;
  tipoCiclo: string;
  nCompras: number;
  somaCompras: number;
  valorOficial: number | null;
  valorAproximado: number;
  componentesAdicionais: number;
  diferenca: number;
  fieldProvenance: CardBillFieldProvenance;
}

export interface CategoryReconciliationItem {
  categoriaLegado: string;
  categoriaCanonica: string;
  quantidade: number;
  soma: number;
  metodoMapeamento: string;
}

export interface ProposedDerivedUpdateAudit {
  targetBase: string;
  pageId: string;
  title: string;
  field: string;
  currentValue: any;
  proposedValue: any;
  difference: string;
  formulaSource: string;
  timestampFreshness: string;
  rationale: string;
  status: 'OUT_OF_SCOPE_NOT_EXECUTED' | 'PROPOSED_DERIVED_UPDATE_REQUIRES_REVIEW';
}

export interface BackfillPlanArtifact {
  version: string;
  mappingVersion: string;
  generatedAt: string;
  commitSha: string;
  sourceSnapshotHash: string;
  targetNotionSnapshotHash: string;
  backfillPlanHash: string;
  explicitSnapshots: {
    sourceDbPath: string;
    sourceDbSha256: string;
    targetNotionManifestPath: string;
    targetNotionSnapshotSha256: string;
  };
  executionPlan: {
    stage1CreationsCount: number;
    stage2RelationPatchesCount: number;
  };
  summary: {
    totalOperations: number;
    executableCreateCount: number;
    executableUpdateCount: number;
    proposedReviewCount: number;
    totalRelations: number;
    byTargetDataSource: Record<string, number>;
  };
  operations: BackfillOperation[];
  readiness: {
    readyForApply: boolean;
    blockers: string[];
    checks: {
      schemaConformant13Of13: boolean;
      missingPropertiesZero: boolean;
      structuralMismatchesZero: boolean;
      duplicatesZero: boolean;
      unresolvedAccountsZero: boolean;
      unresolvedCategoriesZero: boolean;
      financialDiscrepancyZero: boolean;
      identityCollisionsZero: boolean;
      targetSnapshotValid: boolean;
      sourceBackupValid: boolean;
      worktreeClean: boolean;
      headInSyncWithRemote: boolean;
      planHashReproducible: boolean;
    };
  };
  securityGates: {
    enabledVar: 'FINANCIAL_BACKFILL_ENABLED';
    expectedEnabledValue: 'I_UNDERSTAND_BACKFILL_MUTATIONS';
    planHashVar: 'FINANCIAL_BACKFILL_PLAN_HASH';
    commitShaVar: 'FINANCIAL_BACKFILL_COMMIT_SHA';
  };
}

export interface InputFingerprint {
  commitSha: string;
  notionApiVersion: string;
  parentPageId: string;
  dataSourceIds: Record<string, string>;
  liveSnapshotSha256: string;
}

export interface CompleteMigrationPlan {
  version: string;
  planHash: string;
  inputFingerprint: InputFingerprint;
  schemaPlan: SchemaPlan;
  backfillPlan: BackfillPlan;
}

export interface DataSourcePreflight {
  envKey: string;
  name: string;
  id?: string;
  accessible: boolean;
  status: 'VERIFIED' | 'MISSING_ENV' | 'API_ERROR' | 'PROPOSED_NEW';
  propertyCount?: number;
  errorMessage?: string;
}

export interface ParentPagePreflight {
  pageId?: string;
  status: 'CONFIGURED' | 'NOT_CONFIGURED' | 'ERROR';
  accessible: boolean;
  note: string;
}

export interface RelationTargetPreflight {
  fromDataSource: string;
  property: string;
  targetEnvKey: string;
  targetDataSourceId?: string;
  valid: boolean;
  note?: string;
}

export interface PreflightCheckResult {
  valid: boolean;
  apiVersion: string;
  dataSources: DataSourcePreflight[];
  parentPage: ParentPagePreflight;
  relationTargets: RelationTargetPreflight[];
  liveSnapshot: Record<string, Record<string, any>>;
  liveSnapshotSha256: string;
  permissions: 'UNVERIFIED_UNTIL_APPLY';
  warnings: string[];
  errors: string[];
}

export interface BackupResult {
  backupPath: string;
  manifestPath: string;
  encryptedHashSha256: string;
  originalDbSha256: string;
  originalSize: number;
  encryptedSize: number;
  timestamp: string;
  verifiedRestoration: boolean;
  localDatabaseScope: 'LOCAL_FINANCIAL_DB_ONLY';
  notionWorkspaceReconciliationNote: string;
}

export type WorktreeStatus = 'WORKTREE_CLEAN' | 'WORKTREE_DIRTY' | 'GIT_STATE_UNVERIFIED';

export interface SchemaConformanceResult {
  typeMismatches: number;
  renameTypeMismatches: number;
  renameStructuralMismatches: number;
  heuristicSuggestions: number;
  structuralMismatches: number;
  structuralMismatchProperty?: string;
  missingCount: number;
  unexpectedMissingProperties: string[];
  expectedMissingButPresent: string[];
  isConformant: boolean;
}

export interface MigrationReadiness {
  dryRunValid: boolean;
  applyReady: boolean;
  worktreeStatus: WorktreeStatus;
  gitBranch?: string;
  gitCommitSha?: string;
  dirtyFiles?: string[];
  schemaConformance?: SchemaConformanceResult;
  reasons: string[];
}

export interface DryRunReport {
  mode: 'dry-run';
  timestamp: string;
  readiness: MigrationReadiness;
  preflight: PreflightCheckResult;
  backup: BackupResult;
  plan: CompleteMigrationPlan;
  mutationsExecuted: 0;
}

export interface RecoveryEligibilityResult {
  eligible: boolean;
  recoveryPhase?: 'INITIAL_RECOVERY' | 'RESUME_RECOVERY';
  frontierStepNumber?: number;
  frontierStepStatus?: string;
  reasons: string[];
  planHashMatch: boolean;
  originalCommitMatch: boolean;
  parentCommitMatch: boolean;
  patchCommitConfirmed: boolean;
  worktreeClean: boolean;
  upstreamInSync: boolean;
  journalStateValid: boolean;
  liveStateMatchesProjection: boolean;
  gatesConfigured: boolean;
}

export interface ApplyReport {
  mode: 'apply';
  timestamp: string;
  planHash: string;
  runId: string;
  summary: DdlApplyExecutionSummary;
  mutationsExecuted: number;
  plan: CompleteMigrationPlan;
}

export interface RecoveryPreflightReport {
  mode: 'recovery-preflight';
  timestamp: string;
  planHash: string;
  originalCommitSha: string;
  currentCommitSha: string;
  parentCommitSha?: string;
  eligibility: RecoveryEligibilityResult;
  recoveryPhase: 'INITIAL_RECOVERY' | 'RESUME_RECOVERY';
  journalStepsCompleted: number;
  frontierStepNumber: number;
  frontierStepOperation?: MigrationOperation;
  frontierStepProperty?: string;
  frontierStepStatus?: string;
  preflight: PreflightCheckResult;
  mutationsExecuted: 0;
}

export type MigrationReport = DryRunReport | ApplyReport | RecoveryPreflightReport;

export type JournalStepStatus =
  | 'PENDING'
  | 'APPLIED'
  | 'VERIFIED'
  | 'NO_OP_VERIFIED'
  | 'FAILED';

export interface JournalStepEntry {
  id?: number;
  planHash: string;
  stepNumber: number;
  operation: MigrationOperation;
  targetDataSource: string;
  targetDataSourceId?: string;
  propertyName?: string;
  status: JournalStepStatus;
  startedAt: string;
  completedAt?: string;
  createdId?: string;
  metadataJson?: string;
  errorSanitized?: string;
  attempts?: number;
  lastAttemptAt?: string;
}

export interface StoredMigrationPlan {
  planHash: string;
  version: string;
  commitSha: string;
  gitBranch: string;
  parentPageId: string;
  liveSnapshotSha256: string;
  planJson: string;
  createdAt: string;
}

export interface JournalRunEntry {
  runId: string;
  planHash: string;
  commitSha: string;
  gitBranch: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  startedAt: string;
  completedAt?: string;
  errorSanitized?: string;
}

export interface DdlStepExecutionResult {
  stepNumber: number;
  operation: MigrationOperation;
  status: 'VERIFIED' | 'NO_OP_VERIFIED';
  targetDataSource: string;
  property?: string;
  createdId?: string;
  detail: string;
  durationMs: number;
  isPhysicalWrite?: boolean;
}

export interface DdlApplyExecutionSummary {
  runId: string;
  planHash: string;
  commitSha: string;
  gitBranch: string;
  totalSteps: number;
  verifiedCount: number;
  noOpCount: number;
  physicalWritesExecuted: number;
  startedAt: string;
  completedAt: string;
  stepResults: DdlStepExecutionResult[];
}
