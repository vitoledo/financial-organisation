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

export type WorktreeStatus = 'WORKTREE_CLEAN' | 'WORKTREE_DIRTY';

export interface SchemaConformanceResult {
  typeMismatches: number;
  renameTypeMismatches: number;
  renameStructuralMismatches: number;
  heuristicSuggestions: number;
  structuralMismatches: number;
  structuralMismatchProperty?: string;
  missingCount: number;
  unexpectedMissingProperties: string[];
  isConformant: boolean;
}

export interface MigrationReadiness {
  dryRunValid: boolean;
  applyReady: boolean;
  worktreeStatus: WorktreeStatus;
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
