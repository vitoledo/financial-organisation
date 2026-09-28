import 'dotenv/config';
import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { PLAN_ORIGIN_COMMIT_SHA } from '../src/notion/migration-runner/backfill-constants';
import { BackfillDryRunAnalyzer } from '../src/notion/migration-runner/backfill-dry-run';
import { BackfillJournal } from '../src/notion/migration-runner/backfill-journal';
import { BackfillNotionAdapter, SimulatedNotionAdapter } from '../src/notion/migration-runner/backfill-adapter';
import {
  BackfillExecutor,
  DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
  evaluateResumeTargetState,
} from '../src/notion/migration-runner/backfill-executor';
import { BaseSnapshotData, NotionPageRecord, sanitizeNotionProperty } from '../src/notion/migration-runner/data-snapshot';
import {
  DurableJournalCheckpointer,
  InMemoryCheckpointSink,
} from '../src/notion/migration-runner/journal-durability';

/**
 * Regression coverage for the live resume drift gates.
 *
 * The in-memory SimulatedNotionAdapter stores created pages exactly as written (write payload format) and
 * does not maintain Notion's dual relations. Live Notion returns created pages in the sanitized read
 * format and adds back-references on the related pages (Categorias."Transações" for Transações."Categoria").
 * NotionShapedAdapter reproduces that behaviour on top of the simulator, so the resume gates are exercised
 * against the state shape the executor really observes in production.
 */
const WRITE_FORMAT_KEYS = ['title', 'rich_text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'relation', 'status'];

/** Live dual relations maintained by Notion itself: source property -> property on the related page. */
const NOTION_MAINTAINED_DUALS: Record<string, Record<string, { targetEnvKey: string; syncedProperty: string }>> = {
  NOTION_DS_TRANSACTIONS: { Categoria: { targetEnvKey: 'NOTION_DS_CATEGORIES', syncedProperty: 'Transações' } },
};

function toReadFormat(properties: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length === 1 && WRITE_FORMAT_KEYS.includes(keys[0])) {
        const read = sanitizeNotionProperty({ type: keys[0], ...value });
        out[name] = keys[0] === 'date' && read ? { start: read.start, end: read.end ?? null } : read;
        continue;
      }
    }
    out[name] = value;
  }
  return out;
}

class NotionShapedAdapter implements BackfillNotionAdapter {
  private readonly backRefs = new Map<string, { property: string; ids: Set<string> }>();
  private readonly createdIds = new Set<string>();

  constructor(public readonly inner: SimulatedNotionAdapter) {}

  private shape(rec: NotionPageRecord): NotionPageRecord {
    const copy: NotionPageRecord = JSON.parse(JSON.stringify(rec));
    if (this.createdIds.has(copy.id)) copy.properties = toReadFormat(copy.properties);
    const back = this.backRefs.get(copy.id);
    if (back) {
      const current = Array.isArray(copy.properties[back.property]) ? copy.properties[back.property] : [];
      copy.properties[back.property] = [...new Set([...current, ...back.ids])];
    }
    return copy;
  }

  async findByStableIdentity(envKey: string, prop: string, value: string): Promise<NotionPageRecord[]> {
    return (await this.inner.findByStableIdentity(envKey, prop, value)).map((r) => this.shape(r));
  }
  async fetchPage(pageId: string): Promise<NotionPageRecord | null> {
    const rec = await this.inner.fetchPage(pageId);
    return rec ? this.shape(rec) : null;
  }
  async queryTargetState(): Promise<Record<string, BaseSnapshotData>> {
    const state = await this.inner.queryTargetState();
    for (const base of Object.values(state)) base.records = base.records.map((r) => this.shape(r));
    return state;
  }
  async createPage(envKey: string, dataSourceId: string, properties: Record<string, any>) {
    const res = await this.inner.createPage(envKey, dataSourceId, properties);
    this.createdIds.add(res.id);
    for (const [prop, dual] of Object.entries(NOTION_MAINTAINED_DUALS[envKey] || {})) {
      for (const rel of properties[prop]?.relation || []) {
        const entry = this.backRefs.get(rel.id) || { property: dual.syncedProperty, ids: new Set<string>() };
        entry.ids.add(res.id);
        this.backRefs.set(rel.id, entry);
      }
    }
    return res;
  }
  async updatePageRelations(envKey: string, pageId: string, relations: Record<string, string[]>) {
    return this.inner.updatePageRelations(envKey, pageId, relations);
  }
  getMutationCount(): number {
    return this.inner.getMutationCount();
  }
  /** Simulates an external edit on a stored page (bypasses the executor). */
  mutateStored(pageId: string, mutate: (props: Record<string, any>) => void): void {
    const bases = (this.inner as any).bases as Map<string, Map<string, NotionPageRecord>>;
    for (const base of bases.values()) {
      const rec = base.get(pageId);
      if (rec) {
        mutate(rec.properties);
        return;
      }
    }
    throw new Error(`page ${pageId} not found`);
  }
  addForeignBackRef(pageId: string, property: string, foreignId: string): void {
    const entry = this.backRefs.get(pageId) || { property, ids: new Set<string>() };
    entry.ids.add(foreignId);
    this.backRefs.set(pageId, entry);
  }
}

describe('Resume drift gates against the live (Notion-shaped) state', { timeout: 60000 }, () => {
  const testEnv: Record<string, string | undefined> = {
    NOTION_API_KEY: '',
    NOTION_DS_ACCOUNTS: 'fake-acc-ds',
    NOTION_DS_CATEGORIES: 'fake-cat-ds',
    NOTION_DS_TRANSACTIONS: 'fake-tx-ds',
    NOTION_DS_CARD_BILLS: 'fake-bills-ds',
    NOTION_DS_MONTHLY_BUDGET: 'fake-budget-ds',
    NOTION_TARGET_SNAPSHOT_MANIFEST: 'backups/notion-data-snapshot-20260913T190702-0a3af05c.json.enc.manifest.json',
    SOURCE_SQLITE_SNAPSHOT_MANIFEST: 'backups/financial-backup-20260914T023409-a6df794b.db.enc.manifest.json',
    BACKFILL_ACCOUNT_MAPPING_PATH: 'data/account-mapping.json',
    MIGRATION_BACKUP_KEY: process.env.MIGRATION_BACKUP_KEY,
  };

  function getFrozenTargetBases(): Record<string, BaseSnapshotData> {
    const analyzer = new BackfillDryRunAnalyzer({ envVars: testEnv });
    const session = analyzer.prepareValidatedTargetSnapshot();
    const bases = JSON.parse(JSON.stringify(session.payload.bases));
    session.cleanup();
    return bases;
  }

  function newExecutor(
    adapter: BackfillNotionAdapter,
    journal: BackfillJournal,
    extra: Record<string, any> = {},
    env: Record<string, string | undefined> = testEnv,
  ): BackfillExecutor {
    return new BackfillExecutor({
      adapter,
      journal,
      envVars: env,
      planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
      schemaEvidence: DEFAULT_CONFORMANT_SCHEMA_EVIDENCE,
      skipWorktreeCleanCheck: true,
      ...extra,
    });
  }

  async function runCanary(): Promise<{ adapter: NotionShapedAdapter; journal: BackfillJournal; runId: string; canaryPageId: string }> {
    const adapter = new NotionShapedAdapter(new SimulatedNotionAdapter(getFrozenTargetBases()));
    const journal = new BackfillJournal(new Database(':memory:'));
    const report = await newExecutor(adapter, journal, { canary: 1 }).execute();
    expect(report.status).toBe('PAUSED_AFTER_CANARY');
    const op0 = journal.getOperation(report.simulationRunId, 0)!;
    return { adapter, journal, runId: report.simulationRunId, canaryPageId: op0.targetPageId! };
  }

  it('the live state after the canary really differs in shape from the write payload (precondition)', async () => {
    const { adapter, canaryPageId } = await runCanary();
    const live = await adapter.fetchPage(canaryPageId);
    expect(typeof live!.properties['Lançamento']).toBe('string');
    const state = await adapter.queryTargetState();
    const withBackRef = state['NOTION_DS_CATEGORIES'].records.filter(
      (r) => Array.isArray(r.properties['Transações']) && r.properties['Transações'].includes(canaryPageId),
    );
    expect(withBackRef).toHaveLength(1);
  });

  it('resume after canary completes against the live-shaped state (no false EXTERNAL_DRIFT_DURING_BACKFILL)', async () => {
    const { adapter, journal, runId } = await runCanary();
    const report = await newExecutor(adapter, journal, { resumeRunId: runId }).execute();
    expect(report.status).toBe('COMPLETED');
    expect(report.actualSimulatedCreateWrites).toBe(158);
    expect(report.actualSimulatedRelationWrites).toBe(4);
    expect(report.journalFinal.FAILED).toBe(0);
    expect(journal.getRun(runId)!.status).toBe('COMPLETED');

    const state = await adapter.queryTargetState();
    expect(state['NOTION_DS_TRANSACTIONS'].recordCount).toBe(155);
    expect(state['NOTION_DS_CARD_BILLS'].recordCount).toBe(4);
  });

  it('a resume interrupted in Stage 2 resumes cleanly against the live-shaped state', async () => {
    const { adapter, journal, runId } = await runCanary();
    const original = adapter.updatePageRelations.bind(adapter);
    let patches = 0;
    adapter.updatePageRelations = async (...args: [string, string, Record<string, string[]>]) => {
      patches++;
      if (patches === 2) throw new Error('SIMULATED_CRASH_IN_STAGE_2');
      return original(...args);
    };
    await expect(newExecutor(adapter, journal, { resumeRunId: runId, maxRetries: 1 }).execute()).rejects.toThrow(
      /SIMULATED_CRASH_IN_STAGE_2/,
    );
    adapter.updatePageRelations = original;

    // The crashed op is FAILED with attempts > 0; reopen is not involved: the run itself stayed IN_PROGRESS.
    expect(journal.getRun(runId)!.status).not.toBe('FAILED');
    const report = await newExecutor(adapter, journal, { resumeRunId: runId }).execute();
    expect(report.status).toBe('COMPLETED');
    expect(report.journalFinal.FAILED).toBe(0);
  });

  it('still detects external drift on a pre-existing record (0 writes, run FAILED)', async () => {
    const { adapter, journal, runId } = await runCanary();
    const state = await adapter.queryTargetState();
    const category = state['NOTION_DS_CATEGORIES'].records[0];
    adapter.mutateStored(category.id, (p) => {
      p['Grupo'] = 'EXTERNAL_EDIT';
    });
    const before = journal.countByStatus(runId);
    await expect(newExecutor(adapter, journal, { resumeRunId: runId }).execute()).rejects.toThrow(
      /EXTERNAL_DRIFT_DURING_BACKFILL/,
    );
    expect(journal.countByStatus(runId)).toEqual(before);
    expect(journal.getRun(runId)!.status).toBe('FAILED');
  });

  it('rejects a back-reference that does not come from a page created by this run', async () => {
    const { adapter, journal, runId, canaryPageId } = await runCanary();
    const state = await adapter.queryTargetState();
    const category = state['NOTION_DS_CATEGORIES'].records.find((r) =>
      (r.properties['Transações'] || []).includes(canaryPageId),
    )!;
    adapter.addForeignBackRef(category.id, 'Transações', 'foreign-page-id');
    await expect(newExecutor(adapter, journal, { resumeRunId: runId }).execute()).rejects.toThrow(
      /EXTERNAL_DRIFT_DURING_BACKFILL/,
    );
  });

  it('rejects an external edit on a page created by this run', async () => {
    const { adapter, journal, runId, canaryPageId } = await runCanary();
    adapter.mutateStored(canaryPageId, (p) => {
      p['Valor'] = { number: 999999.99 };
    });
    await expect(newExecutor(adapter, journal, { resumeRunId: runId }).execute()).rejects.toThrow(
      /EXTERNAL_DRIFT_DURING_BACKFILL.*FAIL_CREATED_PAGE_CONTENT_DRIFT/,
    );
  });

  it('rejects a created page that disappeared from the live state', async () => {
    const { adapter, journal, runId, canaryPageId } = await runCanary();
    adapter.mutateStored(canaryPageId, () => undefined);
    const bases = (adapter.inner as any).bases as Map<string, Map<string, NotionPageRecord>>;
    bases.get('NOTION_DS_TRANSACTIONS')!.delete(canaryPageId);
    await expect(newExecutor(adapter, journal, { resumeRunId: runId }).execute()).rejects.toThrow(
      /EXTERNAL_DRIFT_DURING_BACKFILL.*FAIL_CREATED_PAGE_MISSING/,
    );
  });

  it('evaluateResumeTargetState is exact on the simulator shape too (write format, no back-references)', async () => {
    const adapter = new SimulatedNotionAdapter(getFrozenTargetBases());
    const journal = new BackfillJournal(new Database(':memory:'));
    const report = await newExecutor(adapter, journal, { canary: 1 }).execute();
    const executor = newExecutor(adapter, journal, { resumeRunId: report.simulationRunId });
    const pre = await executor.preflight();
    const res = evaluateResumeTargetState(
      pre.preflightBases,
      pre.planArtifact,
      journal,
      report.simulationRunId,
      await adapter.queryTargetState(),
    );
    expect(res.violations).toEqual([]);
    expect(res.projectedHash).toBe(res.observedHash);
  });

  describe('reopening a run failed by a false drift gate', () => {
    const reopenEnv = (runId: string) => ({ ...testEnv, FINANCIAL_BACKFILL_REOPEN_RUN_ID: runId });

    async function failedByFalseDrift() {
      const ctx = await runCanary();
      // Reproduce the production incident: the old gate marked the run FAILED without any write.
      ctx.journal.failRun(ctx.runId, 'EXTERNAL_DRIFT_DURING_BACKFILL');
      return ctx;
    }

    async function withDurability(journal: BackfillJournal) {
      const sink = new InMemoryCheckpointSink();
      const namespace = `test-${crypto.randomUUID()}`;
      const durability = await DurableJournalCheckpointer.open({
        journal,
        sink,
        key: crypto.randomBytes(32),
        namespace,
        bootstrap: true,
      });
      return { durability, sink, namespace };
    }

    it('reopens FAILED -> IN_PROGRESS atomically with an audit event and a durable checkpoint, then resume completes', async () => {
      const { adapter, journal, runId } = await failedByFalseDrift();
      const { durability, sink, namespace } = await withDurability(journal);
      const executor = newExecutor(adapter, journal, { resumeRunId: runId, isLive: true, durability }, reopenEnv(runId));

      const res = await executor.reopenRunAfterFalseDrift(runId);
      expect(res.previousStatus).toBe('FAILED');
      expect(res.newStatus).toBe('IN_PROGRESS');
      expect(res.liveNotionMutations).toBe(0);
      expect(res.observedTargetStateHash).toBe(res.projectedTargetStateHash);

      const run = journal.getRun(runId)!;
      expect(run.status).toBe('IN_PROGRESS');
      expect(run.errorSanitized ?? null).toBeNull();
      const events = journal.getOperationEvents(runId);
      expect(events[events.length - 1]).toMatchObject({
        operationIndex: -1,
        previousStatus: 'FAILED',
        newStatus: 'IN_PROGRESS',
        reasonCode: 'RUN_REOPENED_AFTER_FALSE_DRIFT',
      });
      expect((await sink.head(namespace))!.seq).toBe(2);
      expect(durability.isCurrentStateAcked()).toBe(true);

      const report = await newExecutor(adapter, journal, { resumeRunId: runId }).execute();
      expect(report.status).toBe('COMPLETED');
    });

    it('refuses without the explicit FINANCIAL_BACKFILL_REOPEN_RUN_ID gate', async () => {
      const { adapter, journal, runId } = await failedByFalseDrift();
      const executor = newExecutor(adapter, journal, { resumeRunId: runId });
      await expect(executor.reopenRunAfterFalseDrift(runId)).rejects.toThrow(/FAIL_REOPEN_AUTHORIZATION/);
      expect(journal.getRun(runId)!.status).toBe('FAILED');
    });

    it('refuses when the run failed for another reason', async () => {
      const { adapter, journal, runId } = await runCanary();
      journal.failRun(runId, 'STAGE_1_INCOMPLETE');
      const executor = newExecutor(adapter, journal, { resumeRunId: runId }, reopenEnv(runId));
      await expect(executor.reopenRunAfterFalseDrift(runId)).rejects.toThrow(/FAIL_REOPEN_RUN_STATE_INVALID/);
      expect(journal.getRun(runId)!.status).toBe('FAILED');
    });

    it('refuses when the run is not FAILED', async () => {
      const { adapter, journal, runId } = await runCanary();
      const executor = newExecutor(adapter, journal, { resumeRunId: runId }, reopenEnv(runId));
      await expect(executor.reopenRunAfterFalseDrift(runId)).rejects.toThrow(/FAIL_REOPEN_RUN_STATE_INVALID/);
      expect(journal.getRun(runId)!.status).toBe('PAUSED_AFTER_CANARY');
    });

    it('refuses when an operation is not settled (uncertain write)', async () => {
      const { adapter, journal, runId } = await failedByFalseDrift();
      journal.registerOperation({
        runId,
        operationIndex: 1,
        stableId: 'uncertain-op',
        stage: 'STAGE_1_PAGE_CREATION',
        targetDataSource: 'NOTION_DS_TRANSACTIONS',
        action: 'CREATE',
      });
      journal.recordAttempt(runId, 1);
      const executor = newExecutor(adapter, journal, { resumeRunId: runId }, reopenEnv(runId));
      await expect(executor.reopenRunAfterFalseDrift(runId)).rejects.toThrow(/FAIL_REOPEN_OPERATIONS_NOT_SETTLED/);
      expect(journal.getRun(runId)!.status).toBe('FAILED');
    });

    it('refuses when the drift is real (0 journal changes)', async () => {
      const { adapter, journal, runId } = await failedByFalseDrift();
      const state = await adapter.queryTargetState();
      adapter.mutateStored(state['NOTION_DS_CATEGORIES'].records[0].id, (p) => {
        p['Grupo'] = 'EXTERNAL_EDIT';
      });
      const digest = journal.stateDigest();
      const executor = newExecutor(adapter, journal, { resumeRunId: runId }, reopenEnv(runId));
      await expect(executor.reopenRunAfterFalseDrift(runId)).rejects.toThrow(/FAIL_REOPEN_REAL_DRIFT/);
      expect(journal.stateDigest()).toBe(digest);
    });
  });
});
