import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import {
  DurableJournalCheckpointer,
  InMemoryCheckpointSink,
  decryptCheckpoint,
  restoreJournalFromDurableHead,
} from '../src/notion/migration-runner/journal-durability';
import {
  PLAN_ORIGIN_COMMIT_SHA,
  FROZEN_BACKFILL_PLAN_HASH,
  FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_STATE_HASH,
} from '../src/notion/migration-runner/backfill-constants';
import {
  BackfillExecutor,
  CANARY_RECOVERY_REASON_CODE,
} from '../src/notion/migration-runner/backfill-executor';
import { BackfillJournal, calculateJournalFingerprint } from '../src/notion/migration-runner/backfill-journal';
import {
  serializePayloadForNotion,
  calculatePropertiesFingerprint,
  calculateRecordFingerprint,
  normalizeCanonicalPropertiesForFingerprint,
} from '../src/notion/migration-runner/backfill-serializer';

/**
 * Fully synthetic canary-recovery hardening tests: in-memory plan, on-disk temp journal,
 * fake Notion adapter. No local artifacts, secrets or network required.
 */

const STABLE_ID = 'a2ce0416-1a27-4592-85be-bff2a9ce6f86';
const CANARY_PAGE_ID = '3e2a3ece-fa49-8119-929b-f4018367676e';
const EXPECTED_OP0_FINGERPRINT = 'b174467a107e377b81a27bee976f5a7a365a22d4ee3bf03b561cce4f4caab642';
const RUN_COMMIT = '5c973aaec44fd56428125c1cca24b770fa6f3ec9';
const RECOVERY_COMMIT = 'recovery-commit-sha-0001';

function liveCanaryProperties(): Record<string, any> {
  const rt = (v: string) => ({ type: 'rich_text', rich_text: [{ text: { content: v }, plain_text: v }] });
  const sel = (v: string) => ({ type: 'select', select: { name: v } });
  return {
    'Lançamento': { type: 'title', title: [{ text: { content: 'Pinggy.Io' }, plain_text: 'Pinggy.Io' }] },
    'Fonte': sel('Pierre'),
    'ID da fonte': rt(STABLE_ID),
    'Moeda': sel('BRL'),
    'Hash Canônico': rt('90a933ea5c9422db887d78c0d51f6c821822024b03e28c7b1e734d77df0f7ecb'),
    'Data': { type: 'date', date: { start: '2026-05-02', end: null } },
    'Valor': { type: 'number', number: 3.0 },
    'Valor Bruto da Fonte': { type: 'number', number: -3.0 },
    'Movimento': sel('Saída'),
    'Natureza': sel('Despesa'),
    'Efeito Orçamentário': sel('Despesa'),
    'Propósito de Alocação': sel('Caixa Operacional'),
    'Contribuição Meta Poupança': { type: 'number', number: 0 },
    'Status': sel('Confirmado'),
    'Status de Revisão': sel('Confirmado Auto'),
    'Motivo da Revisão': { type: 'rich_text', rich_text: [] },
    'Categoria Pierre': rt('Serviços digitais'),
    'Descrição original': rt('Pinggy.Io'),
    'HMAC Contraparte': rt('[OFUSCADO]'),
    'Conta': { type: 'relation', relation: [{ id: '3d8a3ece-fa49-8112-9399-c960be4f604a' }] },
    'Categoria': { type: 'relation', relation: [{ id: '3d7a3ece-fa49-81c9-955f-e26660d01670' }] },
    'Conta Destino': { type: 'relation', relation: [] },
    'Fatura Vinculada': { type: 'relation', relation: [] },
  };
}

function syntheticPlan(planHash: string = FROZEN_BACKFILL_PLAN_HASH): any {
  return {
    backfillPlanHash: planHash,
    operations: [
      {
        operationType: 'CREATE',
        classification: 'EXECUTABLE_MIGRATION',
        stage: 'STAGE_1_PAGE_CREATION',
        stableId: STABLE_ID,
        targetDataSource: { envKey: 'NOTION_DS_TRANSACTIONS', dataSourceId: 'ds-tx', name: 'Transações' },
        sanitizedPayload: {},
        relations: {},
        dependencies: [],
        reason: 'synthetic',
      },
    ],
  };
}

interface Scenario {
  journal: BackfillJournal;
  dbPath: string;
  runId: string;
  adapter: any;
  preflight: any;
}

describe('Canary recovery hardening (synthetic, fail-closed)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-recovery-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(opts: {
    runPlanHash?: string;
    op0Status?: 'FAILED' | 'PENDING' | 'APPLIED' | 'VERIFIED';
    attempts?: number;
    targetPageId?: string | null;
    liveRecordId?: string;
    extraPendingOps?: number;
    dbName?: string;
  } = {}): Scenario {
    const dbPath = path.join(tmpDir, opts.dbName ?? 'backfill-live-journal.db');
    const journal = new BackfillJournal(dbPath);
    const runId = 'run-1789950411040-gsznfr';

    journal.startRun({
      runId,
      planHash: opts.runPlanHash ?? FROZEN_BACKFILL_PLAN_HASH,
      planOriginCommitSha: PLAN_ORIGIN_COMMIT_SHA,
      executorCommitSha: RUN_COMMIT,
      sourceSnapshotHash: FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
      targetSnapshotHash: FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
      targetStateHash: FROZEN_TARGET_STATE_HASH,
    });
    journal.registerOperation({
      runId,
      operationIndex: 0,
      stableId: STABLE_ID,
      stage: 'STAGE_1_PAGE_CREATION',
      targetDataSource: 'NOTION_DS_TRANSACTIONS',
      action: 'CREATE',
      expectedPostFingerprint: EXPECTED_OP0_FINGERPRINT,
    });
    for (let i = 1; i <= (opts.extraPendingOps ?? 0); i++) {
      journal.registerOperation({
        runId,
        operationIndex: i,
        stableId: `stable-${i}`,
        stage: 'STAGE_1_PAGE_CREATION',
        targetDataSource: 'NOTION_DS_TRANSACTIONS',
        action: 'CREATE',
      });
    }

    // Reproduce the real canary sequence: attempt -> applied(pageId) -> read-back mismatch -> FAILED
    const attempts = opts.attempts ?? 1;
    for (let i = 0; i < attempts; i++) journal.recordAttempt(runId, 0);
    const pageId = opts.targetPageId === undefined ? CANARY_PAGE_ID : opts.targetPageId;
    if (pageId) journal.recordApplied(runId, 0, pageId);
    const status = opts.op0Status ?? 'FAILED';
    if (status === 'FAILED') journal.recordFailed(runId, 0, 'FAIL_READ_BACK_FINGERPRINT_MISMATCH');
    if (status === 'VERIFIED') journal.recordVerified(runId, 0, pageId || CANARY_PAGE_ID);
    if (status === 'PENDING') {
      // Force PENDING directly (e.g. uncertain write that never reached APPLIED)
      (journal as any).db.prepare("UPDATE backfill_operations SET status='PENDING' WHERE run_id=? AND operation_index=0").run(runId);
    }

    const adapter: any = {
      getMutationCount: vi.fn().mockReturnValue(0),
      findByStableIdentity: vi.fn().mockResolvedValue([
        { id: opts.liveRecordId ?? CANARY_PAGE_ID, properties: liveCanaryProperties() },
      ]),
      createPage: vi.fn().mockRejectedValue(new Error('NO_MUTATION_ALLOWED')),
      updatePage: vi.fn().mockRejectedValue(new Error('NO_MUTATION_ALLOWED')),
    };

    const preflight: any = {
      backfillPlanHash: FROZEN_BACKFILL_PLAN_HASH,
      journalFingerprint: calculateJournalFingerprint(journal, runId),
    };

    return { journal, dbPath, runId, adapter, preflight };
  }

  function makeExecutor(s: Scenario, plan: any = syntheticPlan()): BackfillExecutor {
    return new BackfillExecutor({
      adapter: s.adapter,
      journal: s.journal,
      commitSha: RECOVERY_COMMIT,
      planProvider: async () => plan,
      envVars: {
        FINANCIAL_BACKFILL_RECOVERY_FROM_COMMIT: RUN_COMMIT,
        FINANCIAL_BACKFILL_RECOVERY_RUN_ID: 'run-1789950411040-gsznfr',
      },
    });
  }

  function snapshotJournal(s: Scenario) {
    const db = (s.journal as any).db;
    return JSON.stringify({
      runs: db.prepare('SELECT * FROM backfill_runs ORDER BY run_id').all(),
      ops: db.prepare('SELECT * FROM backfill_operations ORDER BY run_id, operation_index').all(),
      map: db.prepare('SELECT * FROM backfill_page_map ORDER BY plan_hash, stable_id').all(),
      events: db.prepare('SELECT * FROM backfill_operation_events ORDER BY id').all(),
    });
  }

  async function expectBlockedWithZeroWrites(s: Scenario, exec: BackfillExecutor, code: RegExp) {
    const before = snapshotJournal(s);
    await expect(exec.executeRecoverCanaryOnly(s.runId, s.preflight)).rejects.toThrow(code);
    expect(snapshotJournal(s)).toBe(before);
    expect(s.adapter.createPage).not.toHaveBeenCalled();
    expect(s.adapter.updatePage).not.toHaveBeenCalled();
  }

  it('fixture sanity: normalized live canary fingerprint == frozen op0 expected fingerprint', () => {
    expect(calculateRecordFingerprint('NOTION_DS_TRANSACTIONS', liveCanaryProperties())).toBe(EXPECTED_OP0_FINGERPRINT);
  });

  describe('1. four-way plan hash binding', () => {
    it('reproduced plan hash mismatch -> FAIL_RECOVERY_PLAN_HASH_MISMATCH, 0 writes, 0 Notion reads', async () => {
      const s = setup();
      try {
        await expectBlockedWithZeroWrites(s, makeExecutor(s, syntheticPlan('f'.repeat(64))), /FAIL_RECOVERY_PLAN_HASH_MISMATCH/);
        expect(s.adapter.findByStableIdentity).not.toHaveBeenCalled();
      } finally {
        s.journal.close();
      }
    });

    it('run.planHash mismatch -> FAIL_RECOVERY_PLAN_HASH_MISMATCH, 0 writes', async () => {
      const s = setup({ runPlanHash: 'e'.repeat(64) });
      try {
        await expectBlockedWithZeroWrites(s, makeExecutor(s), /FAIL_RECOVERY_PLAN_HASH_MISMATCH/);
        expect(s.adapter.findByStableIdentity).not.toHaveBeenCalled();
      } finally {
        s.journal.close();
      }
    });

    it('preflight.backfillPlanHash mismatch -> FAIL_RECOVERY_PLAN_HASH_MISMATCH, 0 writes', async () => {
      const s = setup();
      try {
        s.preflight.backfillPlanHash = 'd'.repeat(64);
        await expectBlockedWithZeroWrites(s, makeExecutor(s), /FAIL_RECOVERY_PLAN_HASH_MISMATCH/);
        expect(s.adapter.findByStableIdentity).not.toHaveBeenCalled();
      } finally {
        s.journal.close();
      }
    });
  });

  describe('2. exact op0 / run state', () => {
    it.each(['PENDING', 'APPLIED', 'VERIFIED'] as const)('op0 status %s (!= FAILED) -> blocked, 0 writes', async (st) => {
      const s = setup({ op0Status: st });
      try {
        await expectBlockedWithZeroWrites(s, makeExecutor(s), /FAIL_RECOVERY_OP_STATE_INVALID/);
        expect(s.adapter.findByStableIdentity).not.toHaveBeenCalled();
      } finally {
        s.journal.close();
      }
    });

    it.each([0, 2, 3])('attempts == %i (!= 1) -> blocked, 0 writes', async (attempts) => {
      const s = setup({ attempts });
      try {
        await expectBlockedWithZeroWrites(s, makeExecutor(s), /FAIL_RECOVERY_OP_STATE_INVALID/);
      } finally {
        s.journal.close();
      }
    });

    it('op0.targetPageId == null -> blocked, 0 writes', async () => {
      const s = setup({ targetPageId: null });
      try {
        await expectBlockedWithZeroWrites(s, makeExecutor(s), /FAIL_RECOVERY_OP_STATE_INVALID: .*targetPageId=null/);
      } finally {
        s.journal.close();
      }
    });

    it('op0 absent -> blocked, 0 writes', async () => {
      const s = setup();
      try {
        (s.journal as any).db.prepare('DELETE FROM backfill_operations WHERE run_id = ?').run(s.runId);
        s.preflight.journalFingerprint = calculateJournalFingerprint(s.journal, s.runId);
        await expectBlockedWithZeroWrites(s, makeExecutor(s), /FAIL_OPERATION_NOT_FOUND/);
      } finally {
        s.journal.close();
      }
    });

    it('op0 wrong action / target data source -> blocked, 0 writes', async () => {
      const s = setup();
      try {
        (s.journal as any).db
          .prepare("UPDATE backfill_operations SET action='RELATION_PATCH', target_data_source='NOTION_DS_CARD_BILLS' WHERE run_id=? AND operation_index=0")
          .run(s.runId);
        s.preflight.journalFingerprint = calculateJournalFingerprint(s.journal, s.runId);
        await expectBlockedWithZeroWrites(s, makeExecutor(s), /FAIL_RECOVERY_OP_STATE_INVALID: .*action=RELATION_PATCH.*targetDataSource=NOTION_DS_CARD_BILLS/);
      } finally {
        s.journal.close();
      }
    });

    it('run not IN_PROGRESS (FAILED) -> FAIL_RECOVERY_RUN_STATE_INVALID, 0 writes', async () => {
      const s = setup();
      try {
        s.journal.failRun(s.runId, 'x');
        await expectBlockedWithZeroWrites(s, makeExecutor(s), /FAIL_RECOVERY_RUN_STATE_INVALID/);
      } finally {
        s.journal.close();
      }
    });

    it('does NOT require ops 1..158 to exist or be PENDING (succeeds with only op0, and with pending ops present)', async () => {
      for (const extra of [0, 3]) {
        const s = setup({ extraPendingOps: extra, dbName: `journal-${extra}.db` });
        try {
          const report = await makeExecutor(s).executeRecoverCanaryOnly(s.runId, s.preflight);
          expect(report.recoveryOutcome).toBe('RECOVERY_APPLIED');
          expect(s.journal.getOperations(s.runId).filter((o) => o.operationIndex > 0).every((o) => o.status === 'PENDING')).toBe(true);
        } finally {
          s.journal.close();
        }
      }
    });
  });

  describe('3. live page identity binding', () => {
    it('liveRecord.id != journal op0.targetPageId -> FAIL_CANARY_RECOVERY_PAGE_ID_MISMATCH, 0 writes', async () => {
      const s = setup({ liveRecordId: '11111111-2222-3333-4444-555555555555' });
      try {
        await expectBlockedWithZeroWrites(s, makeExecutor(s), /FAIL_CANARY_RECOVERY_PAGE_ID_MISMATCH/);
      } finally {
        s.journal.close();
      }
    });

    it('live fingerprint drift -> FAIL_READ_BACK_FINGERPRINT_MISMATCH, 0 writes', async () => {
      const s = setup();
      try {
        const props = liveCanaryProperties();
        props['Valor'] = { type: 'number', number: 4.0 };
        s.adapter.findByStableIdentity.mockResolvedValue([{ id: CANARY_PAGE_ID, properties: props }]);
        await expectBlockedWithZeroWrites(s, makeExecutor(s), /FAIL_READ_BACK_FINGERPRINT_MISMATCH/);
      } finally {
        s.journal.close();
      }
    });

    it('duplicate stable identity in Notion -> FAIL_DUPLICATE_STABLE_ID, 0 writes', async () => {
      const s = setup();
      try {
        s.adapter.findByStableIdentity.mockResolvedValue([
          { id: CANARY_PAGE_ID, properties: liveCanaryProperties() },
          { id: 'dup', properties: liveCanaryProperties() },
        ]);
        await expectBlockedWithZeroWrites(s, makeExecutor(s), /FAIL_DUPLICATE_STABLE_ID/);
      } finally {
        s.journal.close();
      }
    });

    it('stale preflight journal fingerprint -> FAIL_RESUME_PREFLIGHT_BINDING, 0 writes', async () => {
      const s = setup();
      try {
        s.preflight.journalFingerprint = '0'.repeat(64);
        await expectBlockedWithZeroWrites(s, makeExecutor(s), /FAIL_RESUME_PREFLIGHT_BINDING/);
      } finally {
        s.journal.close();
      }
    });
  });

  describe('4. atomic SQLite recovery', () => {
    it('success -> event, op VERIFIED, page mapping and run PAUSED_AFTER_CANARY committed together; 0 Notion mutations', async () => {
      const s = setup();
      try {
        const report = await makeExecutor(s).executeRecoverCanaryOnly(s.runId, s.preflight);
        expect(report.status).toBe('PAUSED_AFTER_CANARY');
        expect(report.recoveryOutcome).toBe('RECOVERY_APPLIED');
        expect(report.liveNotionMutations).toBe(0);
        expect(s.adapter.createPage).not.toHaveBeenCalled();
        expect(s.adapter.updatePage).not.toHaveBeenCalled();

        const op0 = s.journal.getOperation(s.runId, 0)!;
        expect(op0.status).toBe('VERIFIED');
        expect(op0.targetPageId).toBe(CANARY_PAGE_ID);
        expect(op0.attempts).toBe(1);
        expect(op0.errorSanitized).toBeNull();
        expect(s.journal.getRun(s.runId)?.status).toBe('PAUSED_AFTER_CANARY');
        expect(s.journal.getPageMapping(FROZEN_BACKFILL_PLAN_HASH, STABLE_ID)?.notionPageId).toBe(CANARY_PAGE_ID);
        const events = s.journal.getOperationEvents(s.runId);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          operationIndex: 0,
          previousStatus: 'FAILED',
          newStatus: 'VERIFIED',
          reasonCode: CANARY_RECOVERY_REASON_CODE,
          executorCommitSha: RECOVERY_COMMIT,
        });
        expect(s.journal.getOperation(s.runId, 1)).toBeNull();
      } finally {
        s.journal.close();
      }
    });

    it('persists across reopen of the on-disk journal (durable commit)', async () => {
      const s = setup();
      await makeExecutor(s).executeRecoverCanaryOnly(s.runId, s.preflight);
      s.journal.close();
      const reopened = new BackfillJournal(s.dbPath);
      try {
        expect(reopened.getRun(s.runId)?.status).toBe('PAUSED_AFTER_CANARY');
        expect(reopened.getOperation(s.runId, 0)?.status).toBe('VERIFIED');
        expect(reopened.getOperationEvents(s.runId)).toHaveLength(1);
      } finally {
        reopened.close();
      }
    });

    it.each([
      ['recordOperationEvent'],
      ['savePageMapping'],
      ['transitionRunStatus'],
    ])('injected failure in %s -> full rollback (no event, op FAILED, no mapping, run IN_PROGRESS)', async (method) => {
      const s = setup();
      try {
        const before = snapshotJournal(s);
        vi.spyOn(s.journal as any, method).mockImplementation(() => {
          throw new Error(`INJECTED_CRASH_${method}`);
        });
        await expect(makeExecutor(s).executeRecoverCanaryOnly(s.runId, s.preflight)).rejects.toThrow(`INJECTED_CRASH_${method}`);
        vi.restoreAllMocks();
        expect(snapshotJournal(s)).toBe(before);
        expect(s.journal.getOperation(s.runId, 0)?.status).toBe('FAILED');
        expect(s.journal.getRun(s.runId)?.status).toBe('IN_PROGRESS');
        expect(s.journal.getOperationEvents(s.runId)).toHaveLength(0);
        expect(s.journal.getPageMapping(FROZEN_BACKFILL_PLAN_HASH, STABLE_ID)).toBeNull();
      } finally {
        s.journal.close();
      }
    });

    it('pre-existing conflicting page mapping -> FAIL_PAGE_MAPPING_CONFLICT and full rollback', async () => {
      const s = setup();
      try {
        s.journal.savePageMapping(FROZEN_BACKFILL_PLAN_HASH, STABLE_ID, 'other-page', 'NOTION_DS_TRANSACTIONS');
        const before = snapshotJournal(s);
        await expect(makeExecutor(s).executeRecoverCanaryOnly(s.runId, s.preflight)).rejects.toThrow(/FAIL_PAGE_MAPPING_CONFLICT/);
        expect(snapshotJournal(s)).toBe(before);
      } finally {
        s.journal.close();
      }
    });

    it('hard process crash mid-transaction (process.exit before COMMIT) -> on-disk journal fully rolled back', () => {
      const s = setup();
      const before = snapshotJournal(s);
      s.journal.close();

      const childScript = `
        const { BackfillJournal } = require(${JSON.stringify(path.resolve(__dirname, '../src/notion/migration-runner/backfill-journal'))});
        const j = new BackfillJournal(${JSON.stringify(s.dbPath)});
        // Event + op + mapping are written inside the transaction; die before the run transition/COMMIT.
        j.transitionRunStatus = () => { process.exit(137); };
        j.applyCanaryRecoveryAtomically({
          runId: ${JSON.stringify(s.runId)}, operationIndex: 0, targetPageId: ${JSON.stringify(CANARY_PAGE_ID)},
          planHash: ${JSON.stringify(FROZEN_BACKFILL_PLAN_HASH)}, stableId: ${JSON.stringify(STABLE_ID)},
          targetDataSource: 'NOTION_DS_TRANSACTIONS', executorCommitSha: 'crash', reasonCode: 'CRASH',
        });
        process.exit(0);
      `;
      const res = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', childScript], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        timeout: 60000,
      });
      expect(res.status).toBe(137);

      const reopened = new BackfillJournal(s.dbPath);
      try {
        s.journal = reopened;
        expect(snapshotJournal(s)).toBe(before);
        expect(reopened.getOperation(s.runId, 0)?.status).toBe('FAILED');
        expect(reopened.getRun(s.runId)?.status).toBe('IN_PROGRESS');
        expect(reopened.getOperationEvents(s.runId)).toHaveLength(0);
      } finally {
        reopened.close();
      }
    }, 90000);
  });

  describe('4b. durable checkpoint after recovery', () => {
    async function durableExecutor(s: Scenario, sink: InMemoryCheckpointSink, key: Buffer) {
      const durability = await DurableJournalCheckpointer.open({
        journal: s.journal, sink, key, namespace: s.runId, bootstrap: true,
      });
      const exec = new BackfillExecutor({
        adapter: s.adapter,
        journal: s.journal,
        commitSha: RECOVERY_COMMIT,
        planProvider: async () => syntheticPlan(),
        isLive: true,
        durability,
        envVars: {
          FINANCIAL_BACKFILL_RECOVERY_FROM_COMMIT: RUN_COMMIT,
          FINANCIAL_BACKFILL_RECOVERY_RUN_ID: 'run-1789950411040-gsznfr',
        },
      });
      return { exec, durability };
    }

    it('success -> recovered state is the acknowledged durable head (RECOVERY_APPLIED)', async () => {
      const s = setup();
      const sink = new InMemoryCheckpointSink();
      const key = crypto.randomBytes(32);
      try {
        const { exec, durability } = await durableExecutor(s, sink, key);
        await exec.executeRecoverCanaryOnly(s.runId, s.preflight);
        expect(durability.isCurrentStateAcked()).toBe(true);
        const head = (await sink.head(s.runId))!;
        const { header } = decryptCheckpoint(await sink.get(head), key);
        expect(header.reason).toBe('RECOVERY_APPLIED');
        expect(header.stateDigest).toBe(s.journal.stateDigest());
      } finally {
        s.journal.close();
      }
    });

    it('checkpoint not acknowledged -> recovery fails closed; durable head still holds pre-recovery FAILED state', async () => {
      const s = setup();
      const sink = new InMemoryCheckpointSink();
      const key = crypto.randomBytes(32);
      try {
        const { exec } = await durableExecutor(s, sink, key);
        sink.failNextPut = new Error('drive unavailable');
        await expect(exec.executeRecoverCanaryOnly(s.runId, s.preflight)).rejects.toThrow(/FAIL_DURABLE_CHECKPOINT_NOT_ACKNOWLEDGED/);
        const restored = path.join(tmpDir, 'restored.db');
        await restoreJournalFromDurableHead({ sink, key, namespace: s.runId, targetPath: restored });
        const r = new BackfillJournal(restored);
        try {
          expect(r.getOperation(s.runId, 0)?.status).toBe('FAILED');
          expect(r.getRun(s.runId)?.status).toBe('IN_PROGRESS');
        } finally {
          r.close();
        }
      } finally {
        s.journal.close();
      }
    });
  });

  describe('5. idempotency', () => {
    it('second recovery -> RECOVERY_ALREADY_APPLIED, no duplicate event, no journal writes, no Notion call', async () => {
      const s = setup();
      try {
        await makeExecutor(s).executeRecoverCanaryOnly(s.runId, s.preflight);
        const afterFirst = snapshotJournal(s);
        s.adapter.findByStableIdentity.mockClear();

        // Both with the stale preflight and with a freshly regenerated one
        for (const fp of [s.preflight.journalFingerprint, calculateJournalFingerprint(s.journal, s.runId)]) {
          const report = await makeExecutor(s).executeRecoverCanaryOnly(s.runId, { ...s.preflight, journalFingerprint: fp });
          expect(report.recoveryOutcome).toBe('RECOVERY_ALREADY_APPLIED');
          expect(report.status).toBe('PAUSED_AFTER_CANARY');
          expect(report.reasons[0]).toMatch(/^RECOVERY_ALREADY_APPLIED/);
        }
        expect(snapshotJournal(s)).toBe(afterFirst);
        expect(s.journal.getOperationEvents(s.runId)).toHaveLength(1);
        expect(s.adapter.findByStableIdentity).not.toHaveBeenCalled();
      } finally {
        s.journal.close();
      }
    });

    it('second recovery still enforces the plan hash binding', async () => {
      const s = setup();
      try {
        await makeExecutor(s).executeRecoverCanaryOnly(s.runId, s.preflight);
        await expectBlockedWithZeroWrites(s, makeExecutor(s, syntheticPlan('a'.repeat(64))), /FAIL_RECOVERY_PLAN_HASH_MISMATCH/);
      } finally {
        s.journal.close();
      }
    });

    it('direct atomic call on already-recovered op -> fails closed without duplicate event', async () => {
      const s = setup();
      try {
        await makeExecutor(s).executeRecoverCanaryOnly(s.runId, s.preflight);
        const afterFirst = snapshotJournal(s);
        expect(() =>
          s.journal.applyCanaryRecoveryAtomically({
            runId: s.runId,
            operationIndex: 0,
            targetPageId: CANARY_PAGE_ID,
            planHash: FROZEN_BACKFILL_PLAN_HASH,
            stableId: STABLE_ID,
            targetDataSource: 'NOTION_DS_TRANSACTIONS',
            executorCommitSha: RECOVERY_COMMIT,
            reasonCode: CANARY_RECOVERY_REASON_CODE,
          }),
        ).toThrow(/FAIL_RECOVERY_RUN_STATE_INVALID/);
        expect(snapshotJournal(s)).toBe(afterFirst);
      } finally {
        s.journal.close();
      }
    });
  });

  describe('6. canonical property collision in fingerprint normalization', () => {
    it('canonical name + alias/domainField resolving to the same property -> FAIL_AMBIGUOUS_CANONICAL_PROPERTY', () => {
      // canonical 'ID da Fonte', alias 'ID da fonte' and domainField 'sourceTransactionId' are the same property
      expect(() =>
        normalizeCanonicalPropertiesForFingerprint('NOTION_DS_TRANSACTIONS', {
          'ID da Fonte': 'a',
          sourceTransactionId: 'b',
        }),
      ).toThrow(/FAIL_AMBIGUOUS_CANONICAL_PROPERTY/);
      expect(() =>
        normalizeCanonicalPropertiesForFingerprint('NOTION_DS_TRANSACTIONS', { 'ID da Fonte': 'a', 'ID da fonte': 'a' }),
      ).toThrow(/FAIL_AMBIGUOUS_CANONICAL_PROPERTY/);
      expect(() =>
        calculatePropertiesFingerprint('NOTION_DS_TRANSACTIONS', { sourceTransactionId: 'x', 'ID da fonte': 'x' }),
      ).toThrow(/FAIL_AMBIGUOUS_CANONICAL_PROPERTY/);
    });

    it('collision is detected even when one of the values is null or an empty relation', () => {
      expect(() =>
        normalizeCanonicalPropertiesForFingerprint('NOTION_DS_TRANSACTIONS', { 'ID da fonte': null, sourceTransactionId: 'b' }),
      ).toThrow(/FAIL_AMBIGUOUS_CANONICAL_PROPERTY/);
    });

    it('serializer: canonical + alias for the same property in payload -> FAIL_AMBIGUOUS_CANONICAL_PROPERTY', () => {
      expect(() =>
        serializePayloadForNotion('NOTION_DS_TRANSACTIONS', { 'Lançamento': 'x', 'ID da Fonte': 'a', 'ID da fonte': 'b' }),
      ).toThrow(/FAIL_AMBIGUOUS_CANONICAL_PROPERTY/);
    });

    it('serializer: same relation provided in payload and relations -> FAIL_AMBIGUOUS_CANONICAL_PROPERTY', () => {
      expect(() =>
        serializePayloadForNotion(
          'NOTION_DS_TRANSACTIONS',
          { 'Lançamento': 'x', 'Conta Destino': ['p1'] },
          { 'Conta Destino': ['p2'] },
        ),
      ).toThrow(/FAIL_AMBIGUOUS_CANONICAL_PROPERTY/);
    });

    it('non-colliding input keeps previous semantics (empty relation omitted, 0/false/"" material)', () => {
      const out = normalizeCanonicalPropertiesForFingerprint('NOTION_DS_TRANSACTIONS', {
        'ID da fonte': 'abc',
        'Valor': 0,
        'Conta Destino': [],
        'Motivo da Revisão': '',
        'Data': null,
      });
      expect(out).toEqual({ 'ID da Fonte': 'abc', 'Valor': 0, 'Motivo da Revisão': '' });
    });
  });
});
