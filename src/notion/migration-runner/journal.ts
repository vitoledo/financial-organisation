import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import {
  CompleteMigrationPlan,
  JournalRunEntry,
  JournalStepEntry,
  JournalStepStatus,
  MigrationOperation,
} from './types';

export class MigrationJournal {
  private db: Database.Database;

  constructor(dbOrPath: Database.Database | string) {
    if (typeof dbOrPath === 'string') {
      if (dbOrPath !== ':memory:') {
        const dir = path.dirname(path.resolve(dbOrPath));
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }
      this.db = new Database(dbOrPath);
    } else {
      this.db = dbOrPath;
    }
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migration_runs (
        run_id TEXT PRIMARY KEY,
        plan_hash TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        git_branch TEXT NOT NULL,
        status TEXT NOT NULL, -- 'IN_PROGRESS' | 'COMPLETED' | 'FAILED'
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error_sanitized TEXT
      );

      CREATE TABLE IF NOT EXISTS _migration_plans (
        plan_hash TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        git_branch TEXT NOT NULL,
        parent_page_id TEXT NOT NULL,
        live_snapshot_sha256 TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS _migration_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_hash TEXT NOT NULL,
        step_number INTEGER NOT NULL,
        operation TEXT NOT NULL,
        target_data_source TEXT NOT NULL,
        target_data_source_id TEXT,
        property_name TEXT,
        status TEXT NOT NULL, -- 'PENDING' | 'APPLIED' | 'VERIFIED' | 'NO_OP_VERIFIED' | 'FAILED'
        started_at TEXT NOT NULL,
        completed_at TEXT,
        created_id TEXT,
        metadata_json TEXT,
        error_sanitized TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        last_attempt_at TEXT,
        UNIQUE(plan_hash, step_number)
      );

      CREATE INDEX IF NOT EXISTS idx_journal_plan_step ON _migration_journal(plan_hash, step_number);
    `);

    // Ensure columns exist on older tables
    const tableInfo = this.db.pragma('table_info(_migration_journal)') as Array<{ name: string }>;
    const colNames = new Set(tableInfo.map((c) => c.name));
    if (!colNames.has('attempts')) {
      this.db.exec('ALTER TABLE _migration_journal ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;');
    }
    if (!colNames.has('last_attempt_at')) {
      this.db.exec('ALTER TABLE _migration_journal ADD COLUMN last_attempt_at TEXT;');
    }
  }

  public startRun(entry: {
    runId: string;
    planHash: string;
    commitSha: string;
    gitBranch: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO _migration_runs (run_id, plan_hash, commit_sha, git_branch, status, started_at)
      VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?)
    `);
    stmt.run(
      entry.runId,
      entry.planHash,
      entry.commitSha,
      entry.gitBranch,
      new Date().toISOString(),
    );
  }

  public completeRun(runId: string): void {
    const stmt = this.db.prepare(`
      UPDATE _migration_runs
      SET status = 'COMPLETED', completed_at = ?
      WHERE run_id = ?
    `);
    stmt.run(new Date().toISOString(), runId);
  }

  public failRun(runId: string, errorSanitized: string): void {
    const stmt = this.db.prepare(`
      UPDATE _migration_runs
      SET status = 'FAILED', completed_at = ?, error_sanitized = ?
      WHERE run_id = ?
    `);
    stmt.run(new Date().toISOString(), errorSanitized, runId);
  }

  public getRun(runId: string): JournalRunEntry | undefined {
    const stmt = this.db.prepare(`
      SELECT
        run_id as runId,
        plan_hash as planHash,
        commit_sha as commitSha,
        git_branch as gitBranch,
        status,
        started_at as startedAt,
        completed_at as completedAt,
        error_sanitized as errorSanitized
      FROM _migration_runs
      WHERE run_id = ?
    `);
    return stmt.get(runId) as JournalRunEntry | undefined;
  }

  public recordStepPending(entry: {
    planHash: string;
    stepNumber: number;
    operation: MigrationOperation;
    targetDataSource: string;
    targetDataSourceId?: string;
    propertyName?: string;
    metadata?: Record<string, any>;
  }): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO _migration_journal (
        plan_hash, step_number, operation, target_data_source,
        target_data_source_id, property_name, status, started_at, attempts, last_attempt_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, 1, ?, ?)
      ON CONFLICT(plan_hash, step_number) DO UPDATE SET
        status = CASE
          WHEN _migration_journal.status IN ('VERIFIED', 'NO_OP_VERIFIED') THEN _migration_journal.status
          ELSE 'PENDING'
        END,
        attempts = _migration_journal.attempts + 1,
        last_attempt_at = excluded.started_at,
        metadata_json = excluded.metadata_json,
        error_sanitized = CASE
          WHEN _migration_journal.status IN ('VERIFIED', 'NO_OP_VERIFIED') THEN _migration_journal.error_sanitized
          ELSE NULL
        END
    `);
    stmt.run(
      entry.planHash,
      entry.stepNumber,
      entry.operation,
      entry.targetDataSource,
      entry.targetDataSourceId ?? null,
      entry.propertyName ?? null,
      now,
      now,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    );
  }

  public recordStepApplied(
    planHash: string,
    stepNumber: number,
    createdId?: string,
    metadata?: Record<string, any>,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO _migration_journal (
        plan_hash, step_number, operation, target_data_source, status, started_at, created_id, metadata_json
      ) VALUES (?, ?, 'UNKNOWN', 'UNKNOWN', 'APPLIED', ?, ?, ?)
      ON CONFLICT(plan_hash, step_number) DO UPDATE SET
        status = 'APPLIED',
        created_id = COALESCE(excluded.created_id, _migration_journal.created_id),
        metadata_json = COALESCE(excluded.metadata_json, _migration_journal.metadata_json)
    `);
    stmt.run(
      planHash,
      stepNumber,
      new Date().toISOString(),
      createdId ?? null,
      metadata ? JSON.stringify(metadata) : null,
    );
  }

  public recordStepVerified(
    planHash: string,
    stepNumber: number,
    createdId?: string,
    metadata?: Record<string, any>,
  ): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO _migration_journal (
        plan_hash, step_number, operation, target_data_source, status, started_at, completed_at, created_id, metadata_json
      ) VALUES (?, ?, 'UNKNOWN', 'UNKNOWN', 'VERIFIED', ?, ?, ?, ?)
      ON CONFLICT(plan_hash, step_number) DO UPDATE SET
        status = 'VERIFIED',
        completed_at = excluded.completed_at,
        created_id = COALESCE(excluded.created_id, _migration_journal.created_id),
        metadata_json = COALESCE(excluded.metadata_json, _migration_journal.metadata_json),
        error_sanitized = NULL
    `);
    stmt.run(
      planHash,
      stepNumber,
      now,
      now,
      createdId ?? null,
      metadata ? JSON.stringify(metadata) : null,
    );
  }

  public recordStepNoOp(
    planHash: string,
    stepNumber: number,
    entry: {
      operation: MigrationOperation;
      targetDataSource: string;
      targetDataSourceId?: string;
      propertyName?: string;
      existingId?: string;
      metadata?: Record<string, any>;
    },
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO _migration_journal (
        plan_hash, step_number, operation, target_data_source,
        target_data_source_id, property_name, status, started_at, completed_at, created_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'NO_OP_VERIFIED', ?, ?, ?, ?)
      ON CONFLICT(plan_hash, step_number) DO UPDATE SET
        status = 'NO_OP_VERIFIED',
        completed_at = excluded.completed_at,
        created_id = COALESCE(excluded.created_id, _migration_journal.created_id),
        metadata_json = excluded.metadata_json,
        error_sanitized = NULL
    `);
    const now = new Date().toISOString();
    stmt.run(
      planHash,
      stepNumber,
      entry.operation,
      entry.targetDataSource,
      entry.targetDataSourceId ?? null,
      entry.propertyName ?? null,
      now,
      now,
      entry.existingId ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    );
  }

  public recordStepFailed(
    planHash: string,
    stepNumber: number,
    errorSanitized: string,
    metadata?: Record<string, any>,
  ): void {
    const stmt = this.db.prepare(`
      UPDATE _migration_journal
      SET status = 'FAILED', completed_at = ?, error_sanitized = ?, metadata_json = COALESCE(?, metadata_json)
      WHERE plan_hash = ? AND step_number = ?
    `);
    stmt.run(
      new Date().toISOString(),
      errorSanitized,
      metadata ? JSON.stringify(metadata) : null,
      planHash,
      stepNumber,
    );
  }

  public recordRevalidationFailed(
    planHash: string,
    stepNumber: number,
    errorSanitized: string,
    metadata?: Record<string, any>,
  ): void {
    const stmt = this.db.prepare(`
      UPDATE _migration_journal
      SET status = 'FAILED', completed_at = ?, error_sanitized = ?, metadata_json = COALESCE(?, metadata_json)
      WHERE plan_hash = ? AND step_number = ?
    `);
    stmt.run(
      new Date().toISOString(),
      errorSanitized,
      metadata ? JSON.stringify(metadata) : null,
      planHash,
      stepNumber,
    );
  }

  public getStepStatus(planHash: string, stepNumber: number): JournalStepEntry | undefined {
    const stmt = this.db.prepare(`
      SELECT
        id,
        plan_hash as planHash,
        step_number as stepNumber,
        operation,
        target_data_source as targetDataSource,
        target_data_source_id as targetDataSourceId,
        property_name as propertyName,
        status,
        started_at as startedAt,
        completed_at as completedAt,
        created_id as createdId,
        metadata_json as metadataJson,
        error_sanitized as errorSanitized,
        attempts,
        last_attempt_at as lastAttemptAt
      FROM _migration_journal
      WHERE plan_hash = ? AND step_number = ?
    `);
    return stmt.get(planHash, stepNumber) as JournalStepEntry | undefined;
  }

  public getAllSteps(planHash: string): JournalStepEntry[] {
    const stmt = this.db.prepare(`
      SELECT
        id,
        plan_hash as planHash,
        step_number as stepNumber,
        operation,
        target_data_source as targetDataSource,
        target_data_source_id as targetDataSourceId,
        property_name as propertyName,
        status,
        started_at as startedAt,
        completed_at as completedAt,
        created_id as createdId,
        metadata_json as metadataJson,
        error_sanitized as errorSanitized,
        attempts,
        last_attempt_at as lastAttemptAt
      FROM _migration_journal
      WHERE plan_hash = ?
      ORDER BY step_number ASC
    `);
    return stmt.all(planHash) as JournalStepEntry[];
  }

  public getCreatedDatabaseId(planHash: string): string | undefined {
    const stmt = this.db.prepare(`
      SELECT created_id
      FROM _migration_journal
      WHERE plan_hash = ? AND (operation = 'CREATE_DATABASE' OR step_number = 52) AND created_id IS NOT NULL AND status IN ('APPLIED', 'VERIFIED', 'NO_OP_VERIFIED')
      ORDER BY step_number DESC
    `);
    const row = stmt.get(planHash) as { created_id?: string } | undefined;
    return row?.created_id;
  }

  public getResolvedDataSourceId(planHash: string): string | undefined {
    const stmt = this.db.prepare(`
      SELECT created_id
      FROM _migration_journal
      WHERE plan_hash = ? AND (operation = 'RESOLVE_DATA_SOURCE_ID' OR step_number = 53) AND created_id IS NOT NULL AND status IN ('APPLIED', 'VERIFIED', 'NO_OP_VERIFIED')
      ORDER BY step_number DESC
    `);
    const row = stmt.get(planHash) as { created_id?: string } | undefined;
    return row?.created_id;
  }

  public savePlan(plan: CompleteMigrationPlan, gitBranch: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO _migration_plans (
        plan_hash, version, commit_sha, git_branch, parent_page_id,
        live_snapshot_sha256, plan_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_hash) DO NOTHING
    `);
    stmt.run(
      plan.planHash,
      plan.version,
      plan.inputFingerprint.commitSha,
      gitBranch,
      plan.inputFingerprint.parentPageId,
      plan.inputFingerprint.liveSnapshotSha256,
      JSON.stringify(plan),
      new Date().toISOString(),
    );
  }

  public getPlan(planHash: string): CompleteMigrationPlan | undefined {
    const stmt = this.db.prepare(`
      SELECT plan_json FROM _migration_plans WHERE plan_hash = ?
    `);
    const row = stmt.get(planHash) as { plan_json: string } | undefined;
    if (!row?.plan_json) return undefined;
    try {
      return JSON.parse(row.plan_json) as CompleteMigrationPlan;
    } catch {
      return undefined;
    }
  }

  public hasPlan(planHash: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM _migration_plans WHERE plan_hash = ?
    `);
    return !!stmt.get(planHash);
  }
}
