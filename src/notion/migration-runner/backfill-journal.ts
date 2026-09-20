import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

export type BackfillRunStatus = 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export type BackfillOperationStatus =
  | 'PENDING'
  | 'APPLIED'
  | 'VERIFIED'
  | 'NO_OP_VERIFIED'
  | 'FAILED';

export interface BackfillRunRecord {
  runId: string;
  planHash: string;
  planOriginCommitSha: string;
  executorCommitSha: string;
  sourceSnapshotHash: string;
  targetSnapshotHash: string;
  targetStateHash: string;
  startedAt: string;
  completedAt: string | null;
  status: BackfillRunStatus;
  errorSanitized?: string | null;
}

export interface BackfillOperationRecord {
  runId: string;
  operationIndex: number;
  stableId: string;
  stage: string;
  targetDataSource: string;
  action: string;
  status: BackfillOperationStatus;
  attempts: number;
  targetPageId: string | null;
  expectedPreFingerprint: string | null;
  expectedPostFingerprint: string | null;
  lastAttemptAt: string | null;
  errorSanitized: string | null;
}

export interface BackfillPageMapRecord {
  planHash: string;
  stableId: string;
  notionPageId: string;
  targetDataSource: string;
  createdAt: string;
}

export class BackfillJournal {
  private db: Database.Database;
  private readonly dbPath: string;

  constructor(dbOrPath: Database.Database | string = '.local/backfill-journal.db') {
    if (typeof dbOrPath === 'string') {
      this.dbPath = dbOrPath;
      if (dbOrPath !== ':memory:') {
        const fullPath = path.resolve(dbOrPath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }
      this.db = new Database(dbOrPath);
    } else {
      this.db = dbOrPath;
      this.dbPath = ':memory:';
    }

    this.initSchema();
  }

  private initSchema(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS backfill_runs (
        run_id TEXT PRIMARY KEY,
        plan_hash TEXT NOT NULL,
        plan_origin_commit_sha TEXT NOT NULL,
        executor_commit_sha TEXT NOT NULL,
        source_snapshot_hash TEXT NOT NULL,
        target_snapshot_hash TEXT NOT NULL,
        target_state_hash TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        error_sanitized TEXT
      );

      CREATE TABLE IF NOT EXISTS backfill_operations (
        run_id TEXT NOT NULL,
        operation_index INTEGER NOT NULL,
        stable_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        target_data_source TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        target_page_id TEXT,
        expected_pre_fingerprint TEXT,
        expected_post_fingerprint TEXT,
        last_attempt_at TEXT,
        error_sanitized TEXT,
        PRIMARY KEY (run_id, operation_index),
        FOREIGN KEY (run_id) REFERENCES backfill_runs(run_id)
      );

      CREATE INDEX IF NOT EXISTS idx_backfill_ops_status
        ON backfill_operations (run_id, status);

      CREATE INDEX IF NOT EXISTS idx_backfill_ops_stable_id
        ON backfill_operations (stable_id);

      CREATE TABLE IF NOT EXISTS backfill_page_map (
        plan_hash TEXT NOT NULL,
        stable_id TEXT NOT NULL,
        notion_page_id TEXT NOT NULL,
        target_data_source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (plan_hash, stable_id)
      );
    `);
  }

  public startRun(params: {
    runId: string;
    planHash: string;
    planOriginCommitSha: string;
    executorCommitSha: string;
    sourceSnapshotHash: string;
    targetSnapshotHash: string;
    targetStateHash: string;
    startedAt?: string;
  }): void {
    const startedAt = params.startedAt || new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO backfill_runs (
        run_id, plan_hash, plan_origin_commit_sha, executor_commit_sha,
        source_snapshot_hash, target_snapshot_hash, target_state_hash,
        started_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS')
    `);
    stmt.run(
      params.runId,
      params.planHash,
      params.planOriginCommitSha,
      params.executorCommitSha,
      params.sourceSnapshotHash,
      params.targetSnapshotHash,
      params.targetStateHash,
      startedAt,
    );
  }

  public getRun(runId: string): BackfillRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM backfill_runs WHERE run_id = ?')
      .get(runId) as any;
    if (!row) return null;
    return {
      runId: row.run_id,
      planHash: row.plan_hash,
      planOriginCommitSha: row.plan_origin_commit_sha,
      executorCommitSha: row.executor_commit_sha,
      sourceSnapshotHash: row.source_snapshot_hash,
      targetSnapshotHash: row.target_snapshot_hash,
      targetStateHash: row.target_state_hash,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      status: row.status as BackfillRunStatus,
      errorSanitized: row.error_sanitized,
    };
  }

  public getLatestRun(): BackfillRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM backfill_runs ORDER BY started_at DESC LIMIT 1')
      .get() as any;
    if (!row) return null;
    return {
      runId: row.run_id,
      planHash: row.plan_hash,
      planOriginCommitSha: row.plan_origin_commit_sha,
      executorCommitSha: row.executor_commit_sha,
      sourceSnapshotHash: row.source_snapshot_hash,
      targetSnapshotHash: row.target_snapshot_hash,
      targetStateHash: row.target_state_hash,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      status: row.status as BackfillRunStatus,
      errorSanitized: row.error_sanitized,
    };
  }

  public completeRun(runId: string, completedAt: string = new Date().toISOString()): void {
    this.db
      .prepare(
        "UPDATE backfill_runs SET status = 'COMPLETED', completed_at = ? WHERE run_id = ?",
      )
      .run(completedAt, runId);
  }

  public failRun(
    runId: string,
    errorSanitized: string,
    completedAt: string = new Date().toISOString(),
  ): void {
    this.db
      .prepare(
        "UPDATE backfill_runs SET status = 'FAILED', completed_at = ?, error_sanitized = ? WHERE run_id = ?",
      )
      .run(completedAt, errorSanitized, runId);
  }

  public registerOperation(params: {
    runId: string;
    operationIndex: number;
    stableId: string;
    stage: string;
    targetDataSource: string;
    action: string;
    expectedPreFingerprint?: string | null;
    expectedPostFingerprint?: string | null;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO backfill_operations (
        run_id, operation_index, stable_id, stage, target_data_source,
        action, status, attempts, expected_pre_fingerprint, expected_post_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)
      ON CONFLICT(run_id, operation_index) DO NOTHING
    `);
    stmt.run(
      params.runId,
      params.operationIndex,
      params.stableId,
      params.stage,
      params.targetDataSource,
      params.action,
      params.expectedPreFingerprint || null,
      params.expectedPostFingerprint || null,
    );
  }

  /**
   * Must be called immediately BEFORE sending a network mutation.
   * Increments attempts and persists lastAttemptAt timestamp.
   * Ensures that crash or network loss leaves status=PENDING + attempts > 0 (uncertain write).
   */
  public recordAttempt(runId: string, operationIndex: number, attemptTime: string = new Date().toISOString()): number {
    const stmt = this.db.prepare(`
      UPDATE backfill_operations
      SET attempts = attempts + 1, last_attempt_at = ?
      WHERE run_id = ? AND operation_index = ?
    `);
    stmt.run(attemptTime, runId, operationIndex);

    const row = this.db
      .prepare('SELECT attempts FROM backfill_operations WHERE run_id = ? AND operation_index = ?')
      .get(runId, operationIndex) as any;
    return row?.attempts ?? 1;
  }

  public recordApplied(runId: string, operationIndex: number, targetPageId?: string): void {
    const stmt = this.db.prepare(`
      UPDATE backfill_operations
      SET status = 'APPLIED', target_page_id = COALESCE(?, target_page_id)
      WHERE run_id = ? AND operation_index = ?
    `);
    stmt.run(targetPageId || null, runId, operationIndex);
  }

  public recordVerified(
    runId: string,
    operationIndex: number,
    targetPageId: string,
    isNoOp: boolean = false,
  ): void {
    const status: BackfillOperationStatus = isNoOp ? 'NO_OP_VERIFIED' : 'VERIFIED';
    const stmt = this.db.prepare(`
      UPDATE backfill_operations
      SET status = ?, target_page_id = ?
      WHERE run_id = ? AND operation_index = ?
    `);
    stmt.run(status, targetPageId, runId, operationIndex);
  }

  public recordFailed(runId: string, operationIndex: number, errorSanitized: string): void {
    const stmt = this.db.prepare(`
      UPDATE backfill_operations
      SET status = 'FAILED', error_sanitized = ?
      WHERE run_id = ? AND operation_index = ?
    `);
    stmt.run(errorSanitized, runId, operationIndex);
  }

  public getOperation(runId: string, operationIndex: number): BackfillOperationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM backfill_operations WHERE run_id = ? AND operation_index = ?')
      .get(runId, operationIndex) as any;
    if (!row) return null;
    return {
      runId: row.run_id,
      operationIndex: row.operation_index,
      stableId: row.stable_id,
      stage: row.stage,
      targetDataSource: row.target_data_source,
      action: row.action,
      status: row.status as BackfillOperationStatus,
      attempts: row.attempts,
      targetPageId: row.target_page_id,
      expectedPreFingerprint: row.expected_pre_fingerprint,
      expectedPostFingerprint: row.expected_post_fingerprint,
      lastAttemptAt: row.last_attempt_at,
      errorSanitized: row.error_sanitized,
    };
  }

  public getOperations(runId: string): BackfillOperationRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM backfill_operations WHERE run_id = ? ORDER BY operation_index ASC')
      .all(runId) as any[];
    return rows.map((row) => ({
      runId: row.run_id,
      operationIndex: row.operation_index,
      stableId: row.stable_id,
      stage: row.stage,
      targetDataSource: row.target_data_source,
      action: row.action,
      status: row.status as BackfillOperationStatus,
      attempts: row.attempts,
      targetPageId: row.target_page_id,
      expectedPreFingerprint: row.expected_pre_fingerprint,
      expectedPostFingerprint: row.expected_post_fingerprint,
      lastAttemptAt: row.last_attempt_at,
      errorSanitized: row.error_sanitized,
    }));
  }

  /**
   * Returns operations that were initiated (attempts > 0) but never reached APPLIED or VERIFIED.
   * These are potential uncertain writes requiring stable-identity reconciliation.
   */
  public getUncertainOperations(runId: string): BackfillOperationRecord[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM backfill_operations
        WHERE run_id = ? AND (
          status NOT IN ('VERIFIED', 'NO_OP_VERIFIED') AND (attempts > 0 OR status = 'APPLIED')
        )
        ORDER BY operation_index ASC
      `)
      .all(runId) as any[];
    return rows.map((row) => ({
      runId: row.run_id,
      operationIndex: row.operation_index,
      stableId: row.stable_id,
      stage: row.stage,
      targetDataSource: row.target_data_source,
      action: row.action,
      status: row.status as BackfillOperationStatus,
      attempts: row.attempts,
      targetPageId: row.target_page_id,
      expectedPreFingerprint: row.expected_pre_fingerprint,
      expectedPostFingerprint: row.expected_post_fingerprint,
      lastAttemptAt: row.last_attempt_at,
      errorSanitized: row.error_sanitized,
    }));
  }

  public savePageMapping(
    planHash: string,
    stableId: string,
    notionPageId: string,
    targetDataSource: string,
    createdAt: string = new Date().toISOString(),
  ): void {
    const existing = this.db
      .prepare('SELECT notion_page_id FROM backfill_page_map WHERE plan_hash = ? AND stable_id = ?')
      .get(planHash, stableId) as any;

    if (existing) {
      if (existing.notion_page_id !== notionPageId) {
        throw new Error(
          `FAIL_PAGE_MAPPING_CONFLICT: Conflito de mapeamento para stableId '${stableId}' no plano '${planHash}'. Existente: '${existing.notion_page_id}', Tentado: '${notionPageId}'.`,
        );
      }
      return;
    }

    const stmt = this.db.prepare(`
      INSERT INTO backfill_page_map (plan_hash, stable_id, notion_page_id, target_data_source, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(planHash, stableId, notionPageId, targetDataSource, createdAt);
  }

  public getPageMapping(planHash: string, stableId: string): BackfillPageMapRecord | null {
    const row = this.db
      .prepare('SELECT * FROM backfill_page_map WHERE plan_hash = ? AND stable_id = ?')
      .get(planHash, stableId) as any;
    if (!row) return null;
    return {
      planHash: row.plan_hash,
      stableId: row.stable_id,
      notionPageId: row.notion_page_id,
      targetDataSource: row.target_data_source,
      createdAt: row.created_at,
    };
  }

  public getAllPageMappings(planHash: string): Map<string, string> {
    const rows = this.db
      .prepare('SELECT stable_id, notion_page_id FROM backfill_page_map WHERE plan_hash = ?')
      .all(planHash) as any[];
    const map = new Map<string, string>();
    for (const r of rows) {
      map.set(r.stable_id, r.notion_page_id);
    }
    return map;
  }

  public validateRunMetadata(
    runId: string,
    expected: {
      planHash: string;
      planOriginCommitSha: string;
      sourceSnapshotHash: string;
      targetSnapshotHash: string;
      targetStateHash: string;
    },
  ): void {
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(`FAIL_JOURNAL_BINDING_MISMATCH: Run '${runId}' não encontrado no journal.`);
    }

    if (
      run.planHash !== expected.planHash ||
      run.planOriginCommitSha !== expected.planOriginCommitSha ||
      run.sourceSnapshotHash !== expected.sourceSnapshotHash ||
      run.targetSnapshotHash !== expected.targetSnapshotHash ||
      run.targetStateHash !== expected.targetStateHash
    ) {
      throw new Error(
        `FAIL_JOURNAL_BINDING_MISMATCH: Metadados do run no journal divergem dos hashes de baseline congelados da execução.`,
      );
    }
  }

  public countByStatus(runId: string): Record<BackfillOperationStatus, number> {
    const rows = this.db
      .prepare('SELECT status, count(*) as count FROM backfill_operations WHERE run_id = ? GROUP BY status')
      .all(runId) as any[];

    const result: Record<BackfillOperationStatus, number> = {
      PENDING: 0,
      APPLIED: 0,
      VERIFIED: 0,
      NO_OP_VERIFIED: 0,
      FAILED: 0,
    };

    for (const r of rows) {
      const st = r.status as BackfillOperationStatus;
      if (result[st] !== undefined) {
        result[st] = r.count;
      }
    }
    return result;
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}
