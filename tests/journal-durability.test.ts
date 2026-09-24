import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { BackfillJournal } from '../src/notion/migration-runner/backfill-journal';
import {
  CHECKPOINT_MAGIC,
  DurabilityGuardedAdapter,
  DurableJournalCheckpointer,
  InMemoryCheckpointSink,
  decryptCheckpoint,
  digestOfJournalImage,
  encryptCheckpoint,
  parseCheckpointKey,
  restoreJournalFromDurableHead,
} from '../src/notion/migration-runner/journal-durability';
import { BackfillExecutor } from '../src/notion/migration-runner/backfill-executor';
import { durabilityConfigFromEnv } from '../src/notion/migration-runner/drive-checkpoint-sink';
import { runJournalDurability } from '../scripts/journal-durability';

const STABLE_ID = 'a2ce0416-1a27-4592-85be-bff2a9ce6f86';
const NS = 'run-1789950411040-gsznfr';

function seedJournal(journal: BackfillJournal, runId = NS) {
  journal.startRun({
    runId,
    planHash: 'p'.repeat(64),
    planOriginCommitSha: 'o'.repeat(40),
    executorCommitSha: 'e'.repeat(40),
    sourceSnapshotHash: 's'.repeat(64),
    targetSnapshotHash: 't'.repeat(64),
    targetStateHash: 'x'.repeat(64),
  });
  journal.registerOperation({
    runId,
    operationIndex: 0,
    stableId: STABLE_ID,
    stage: 'STAGE_1_PAGE_CREATION',
    targetDataSource: 'NOTION_DS_TRANSACTIONS',
    action: 'CREATE',
    expectedPostFingerprint: 'f'.repeat(64),
  });
}

describe('Durable encrypted journal checkpoint protocol', () => {
  let tmp: string;
  let key: Buffer;
  let sink: InMemoryCheckpointSink;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-durability-'));
    key = crypto.randomBytes(32);
    sink = new InMemoryCheckpointSink();
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function newJournal(name = 'journal.db'): BackfillJournal {
    const j = new BackfillJournal(path.join(tmp, name));
    seedJournal(j);
    return j;
  }

  describe('AES-256-GCM checkpoint format', () => {
    it('round-trips and never contains raw journal bytes or financial identifiers', () => {
      const j = newJournal();
      try {
        const image = j.serializeSnapshot();
        const header: any = {
          formatVersion: 1, namespace: NS, seq: 1, prevSeq: 0, writerId: 'w', reason: 'T',
          stateDigest: j.stateDigest(), plaintextSha256: crypto.createHash('sha256').update(image).digest('hex'),
          createdAt: new Date().toISOString(),
        };
        const blob = encryptCheckpoint(image, key, header);
        expect(blob.subarray(0, CHECKPOINT_MAGIC.length).equals(CHECKPOINT_MAGIC)).toBe(true);
        expect(blob.includes(Buffer.from('SQLite format 3'))).toBe(false);
        expect(blob.includes(Buffer.from(STABLE_ID))).toBe(false);
        const out = decryptCheckpoint(blob, key);
        expect(out.plaintext.equals(image)).toBe(true);
        expect(digestOfJournalImage(out.plaintext)).toBe(j.stateDigest());
      } finally {
        j.close();
      }
    });

    it('tampered header (AAD), tampered ciphertext or wrong key -> FAIL_DURABILITY_CHECKPOINT_CORRUPTED', () => {
      const plaintext = Buffer.from('journal-image');
      const header: any = {
        formatVersion: 1, namespace: NS, seq: 7, prevSeq: 6, writerId: 'w', reason: 'T', stateDigest: 'd',
        plaintextSha256: crypto.createHash('sha256').update(plaintext).digest('hex'), createdAt: 'now',
      };
      const blob = encryptCheckpoint(plaintext, key, header);
      const seqPos = blob.indexOf(Buffer.from('"seq":7'));
      const tamperedHeader = Buffer.from(blob);
      tamperedHeader[seqPos + 6] = '8'.charCodeAt(0);
      expect(() => decryptCheckpoint(tamperedHeader, key)).toThrow(/FAIL_DURABILITY_CHECKPOINT_CORRUPTED/);
      const tamperedBody = Buffer.from(blob);
      tamperedBody[tamperedBody.length - 1] ^= 0xff;
      expect(() => decryptCheckpoint(tamperedBody, key)).toThrow(/FAIL_DURABILITY_CHECKPOINT_CORRUPTED/);
      expect(() => decryptCheckpoint(blob, crypto.randomBytes(32))).toThrow(/FAIL_DURABILITY_CHECKPOINT_CORRUPTED/);
    });

    it('key must be exactly 32 bytes', () => {
      expect(() => parseCheckpointKey('abc')).toThrow(/FAIL_DURABILITY_KEY_INVALID/);
      expect(parseCheckpointKey('a'.repeat(64)).length).toBe(32);
      expect(parseCheckpointKey(crypto.randomBytes(32).toString('base64')).length).toBe(32);
    });

    it('snapshot includes committed WAL frames (not only the main db file)', () => {
      const p = path.join(tmp, 'wal.db');
      const j = new BackfillJournal(p);
      try {
        seedJournal(j);
        expect(fs.statSync(`${p}-wal`).size).toBeGreaterThan(0);
        expect(digestOfJournalImage(j.serializeSnapshot())).toBe(j.stateDigest());
      } finally {
        j.close();
      }
    });
  });

  describe('checkpointer (acknowledgment, single writer, fail closed)', () => {
    it('bootstrap -> seq 1; unchanged state -> no new checkpoint; changed state -> seq 2', async () => {
      const j = newJournal();
      try {
        const cp = await DurableJournalCheckpointer.open({ journal: j, sink, key, namespace: NS, bootstrap: true });
        expect(cp.getLastSeq()).toBe(1);
        expect(cp.isCurrentStateAcked()).toBe(true);
        await cp.checkpoint('NOOP');
        expect(sink.objects).toHaveLength(1);
        j.recordAttempt(NS, 0);
        expect(cp.isCurrentStateAcked()).toBe(false);
        await cp.checkpoint('PRE_MUTATION_CREATE');
        expect(cp.getLastSeq()).toBe(2);
        expect(cp.isCurrentStateAcked()).toBe(true);
      } finally {
        j.close();
      }
    });

    it('open without head and without bootstrap -> FAIL_DURABILITY_NO_HEAD; bootstrap over existing head -> refused', async () => {
      const j = newJournal();
      try {
        await expect(DurableJournalCheckpointer.open({ journal: j, sink, key, namespace: NS })).rejects.toThrow(/FAIL_DURABILITY_NO_HEAD/);
        await DurableJournalCheckpointer.open({ journal: j, sink, key, namespace: NS, bootstrap: true });
        await expect(
          DurableJournalCheckpointer.open({ journal: j, sink, key, namespace: NS, bootstrap: true }),
        ).rejects.toThrow(/FAIL_DURABILITY_ALREADY_BOOTSTRAPPED/);
      } finally {
        j.close();
      }
    });

    it('local journal diverging from durable head -> FAIL_DURABILITY_HEAD_MISMATCH', async () => {
      const j = newJournal();
      try {
        await DurableJournalCheckpointer.open({ journal: j, sink, key, namespace: NS, bootstrap: true });
        j.recordAttempt(NS, 0); // local-only change, never acknowledged
        await expect(DurableJournalCheckpointer.open({ journal: j, sink, key, namespace: NS })).rejects.toThrow(
          /FAIL_DURABILITY_HEAD_MISMATCH/,
        );
      } finally {
        j.close();
      }
    });

    it('sink put failure or bad acknowledgment -> FAIL_DURABLE_CHECKPOINT_NOT_ACKNOWLEDGED and state stays un-acked', async () => {
      const j = newJournal();
      try {
        const cp = await DurableJournalCheckpointer.open({ journal: j, sink, key, namespace: NS, bootstrap: true });
        j.recordAttempt(NS, 0);
        sink.failNextPut = new Error('network down');
        await expect(cp.checkpoint('PRE')).rejects.toThrow(/FAIL_DURABLE_CHECKPOINT_NOT_ACKNOWLEDGED/);
        expect(cp.isCurrentStateAcked()).toBe(false);
        expect(cp.getLastSeq()).toBe(1);

        sink.corruptNextAck = true;
        await expect(cp.checkpoint('PRE')).rejects.toThrow(/FAIL_DURABLE_CHECKPOINT_NOT_ACKNOWLEDGED/);
        expect(cp.isCurrentStateAcked()).toBe(false);
      } finally {
        j.close();
      }
    });

    it('second writer advancing the head -> FAIL_DURABILITY_WRITER_CONFLICT on the first writer', async () => {
      const j1 = newJournal('a.db');
      try {
        const cp1 = await DurableJournalCheckpointer.open({ journal: j1, sink, key, namespace: NS, bootstrap: true, maxHeadRetries: 0 });
        // Second machine restores the head and writes
        const p2 = path.join(tmp, 'b.db');
        await restoreJournalFromDurableHead({ sink, key, namespace: NS, targetPath: p2 });
        const j2 = new BackfillJournal(p2);
        const cp2 = await DurableJournalCheckpointer.open({ journal: j2, sink, key, namespace: NS });
        j2.recordAttempt(NS, 0);
        await cp2.checkpoint('OTHER_WRITER');
        j2.close();

        j1.recordAttempt(NS, 0);
        await expect(cp1.checkpoint('PRE')).rejects.toThrow(/FAIL_DURABILITY_WRITER_CONFLICT/);
        expect(cp1.isCurrentStateAcked()).toBe(false);
      } finally {
        j1.close();
      }
    });

    it('duplicate sequence number in the sink -> FAIL_DURABILITY_WRITER_CONFLICT', async () => {
      const j = newJournal();
      try {
        const cp = await DurableJournalCheckpointer.open({ journal: j, sink, key, namespace: NS, bootstrap: true });
        const realPut = sink.put.bind(sink);
        vi.spyOn(sink, 'put').mockImplementation(async (ns: string, seq: number, blob: Buffer) => {
          await realPut(ns, seq, Buffer.from('racing-writer')); // concurrent object with same seq
          return realPut(ns, seq, blob);
        });
        j.recordAttempt(NS, 0);
        await expect(cp.checkpoint('PRE')).rejects.toThrow(/FAIL_DURABILITY_WRITER_CONFLICT/);
        expect(cp.isCurrentStateAcked()).toBe(false);
      } finally {
        j.close();
      }
    });
  });

  describe('restore (durable head is authoritative)', () => {
    it('crash after PRE_MUTATION ack -> restored journal has attempts=1 (uncertain write reconciled on resume)', async () => {
      const j = newJournal();
      const cp = await DurableJournalCheckpointer.open({ journal: j, sink, key, namespace: NS, bootstrap: true });
      j.recordAttempt(NS, 0);
      await cp.checkpoint('PRE_MUTATION_CREATE');
      j.recordApplied(NS, 0, 'page-1'); // mutation happened, container dies before POST checkpoint
      j.close();

      const restoredPath = path.join(tmp, 'fresh-container', '.local', 'backfill-live-journal.db');
      const header = await restoreJournalFromDurableHead({ sink, key, namespace: NS, targetPath: restoredPath });
      expect(header.seq).toBe(2);
      const r = new BackfillJournal(restoredPath);
      try {
        const op0 = r.getOperation(NS, 0)!;
        expect(op0.attempts).toBe(1);
        expect(op0.status).toBe('PENDING');
        expect(r.getUncertainOperations(NS).map((o) => o.operationIndex)).toEqual([0]);
      } finally {
        r.close();
      }
    });

    it('divergent local file is kept as .superseded-* and replaced by the head', async () => {
      const j = newJournal();
      await DurableJournalCheckpointer.open({ journal: j, sink, key, namespace: NS, bootstrap: true });
      const headDigest = j.stateDigest();
      j.recordAttempt(NS, 0);
      j.close();
      const p = path.join(tmp, 'journal.db');
      for (const suffix of ['-wal', '-shm']) if (fs.existsSync(p + suffix)) fs.rmSync(p + suffix);
      await restoreJournalFromDurableHead({ sink, key, namespace: NS, targetPath: p });
      const r = new BackfillJournal(p);
      try {
        expect(r.stateDigest()).toBe(headDigest);
      } finally {
        r.close();
      }
      expect(fs.readdirSync(tmp).some((f) => f.startsWith('journal.db.superseded-'))).toBe(true);
    });

    it('corrupted head -> restore refused and local file untouched', async () => {
      const j = newJournal();
      await DurableJournalCheckpointer.open({ journal: j, sink, key, namespace: NS, bootstrap: true });
      j.close();
      const p = path.join(tmp, 'journal.db');
      const before = fs.readFileSync(p);
      sink.objects[0].blob[sink.objects[0].blob.length - 1] ^= 0xff;
      await expect(restoreJournalFromDurableHead({ sink, key, namespace: NS, targetPath: p })).rejects.toThrow(
        /FAIL_DURABILITY_CHECKPOINT_CORRUPTED/,
      );
      expect(fs.readFileSync(p).equals(before)).toBe(true);
    });
  });

  describe('DurabilityGuardedAdapter (invariant I1 enforced structurally)', () => {
    function innerAdapter() {
      return {
        findByStableIdentity: vi.fn().mockResolvedValue([]),
        fetchPage: vi.fn().mockResolvedValue(null),
        queryTargetState: vi.fn().mockResolvedValue({}),
        createPage: vi.fn().mockResolvedValue({ id: 'p', properties: {} }),
        updatePageRelations: vi.fn().mockResolvedValue({ id: 'p', properties: {} }),
        getMutationCount: vi.fn().mockReturnValue(0),
        isProductionMutationAuthorized: true,
      };
    }

    it('mutation with un-acknowledged journal state is refused and never reaches Notion', async () => {
      const j = newJournal();
      try {
        const cp = await DurableJournalCheckpointer.open({ journal: j, sink, key, namespace: NS, bootstrap: true });
        const inner = innerAdapter();
        const guarded = new DurabilityGuardedAdapter(inner as any, cp);
        expect(guarded.isProductionMutationAuthorized).toBe(true);

        j.recordAttempt(NS, 0); // attempt recorded but not yet durable
        await expect(guarded.createPage('NOTION_DS_TRANSACTIONS', 'ds', {})).rejects.toThrow(
          /FAIL_MUTATION_WITHOUT_DURABLE_CHECKPOINT/,
        );
        await expect(guarded.updatePageRelations('NOTION_DS_CARD_BILLS', 'p', {})).rejects.toThrow(
          /FAIL_MUTATION_WITHOUT_DURABLE_CHECKPOINT/,
        );
        expect(inner.createPage).not.toHaveBeenCalled();
        expect(inner.updatePageRelations).not.toHaveBeenCalled();

        await cp.checkpoint('PRE_MUTATION_CREATE');
        await guarded.createPage('NOTION_DS_TRANSACTIONS', 'ds', {});
        expect(inner.createPage).toHaveBeenCalledTimes(1);

        // Reads are never blocked
        await guarded.findByStableIdentity('NOTION_DS_TRANSACTIONS', 'ID da Fonte', 'x');
        j.recordApplied(NS, 0, 'p');
        await guarded.fetchPage('p');
        expect(inner.fetchPage).toHaveBeenCalled();
      } finally {
        j.close();
      }
    });
  });

  describe('executor + CLI wiring', () => {
    it('live execute / recovery without durability -> FAIL_DURABILITY_NOT_CONFIGURED before any journal write', async () => {
      const j = newJournal();
      try {
        const before = j.stateDigest();
        const adapter: any = { getMutationCount: () => 0, findByStableIdentity: vi.fn(), queryTargetState: vi.fn() };
        const exec = new BackfillExecutor({ adapter, journal: j, isLive: true, commitSha: 'x', envVars: {} });
        await expect(exec.execute()).rejects.toThrow(/FAIL_DURABILITY_NOT_CONFIGURED/);
        await expect(exec.executeRecoverCanaryOnly(NS, {} as any)).rejects.toThrow(/FAIL_DURABILITY_NOT_CONFIGURED/);
        expect(j.stateDigest()).toBe(before);
        expect(adapter.queryTargetState).not.toHaveBeenCalled();
      } finally {
        j.close();
      }
    });

    it('durability env config fails closed when any variable is missing', () => {
      expect(() => durabilityConfigFromEnv({})).toThrow(
        /FAIL_DURABILITY_NOT_CONFIGURED: .*JOURNAL_CHECKPOINT_KEY.*JOURNAL_CHECKPOINT_GOOGLE_REFRESH_TOKEN/,
      );
    });

    it('CLI bootstrap -> verify -> restore round trip', async () => {
      const p = path.join(tmp, '.local', 'backfill-live-journal.db');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const j = new BackfillJournal(p);
      seedJournal(j);
      const digest = j.stateDigest();
      j.close();
      const deps = { durability: { sink, key, namespace: NS }, journalPath: p };
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runJournalDurability('bootstrap', {}, deps);
        await runJournalDurability('verify', {}, deps);
        await expect(runJournalDurability('bootstrap', {}, deps)).rejects.toThrow(/FAIL_DURABILITY_ALREADY_BOOTSTRAPPED/);
        fs.rmSync(path.dirname(p), { recursive: true, force: true });
        await runJournalDurability('restore', {}, deps);
        const r = new BackfillJournal(p);
        expect(r.stateDigest()).toBe(digest);
        r.close();
        await runJournalDurability('smoke', {}, { durability: { sink, key, namespace: NS } });
        await runJournalDurability('status', {}, deps);
        expect(log.mock.calls.flat().join('\n')).toMatch(/LOCAL_EQUALS_HEAD=true/);
        expect(log.mock.calls.flat().join('\n')).toMatch(/DURABILITY_SMOKE_OK/);
      } finally {
        log.mockRestore();
      }
    });
  });
});
