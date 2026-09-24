/**
 * Durable encrypted journal checkpoint operations (single authoritative copy outside the container).
 *
 *   pnpm notion:journal-durability status     -> durable head seq/digest vs local journal
 *   pnpm notion:journal-durability bootstrap  -> first checkpoint (#1) from the local journal; refused if a head exists
 *   pnpm notion:journal-durability restore    -> replace local journal with the durable head (authoritative)
 *   pnpm notion:journal-durability verify     -> fail unless local journal == durable head
 *   pnpm notion:journal-durability smoke      -> end-to-end check of the real sink (throwaway namespace)
 *
 * Journal path: .local/backfill-live-journal.db (same as backfill-live-apply). Configuration comes only
 * from the environment (see durabilityConfigFromEnv); secrets never live in files.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { BackfillJournal } from '../src/notion/migration-runner/backfill-journal';
import {
  DurableJournalCheckpointer,
  decryptCheckpoint,
  restoreJournalFromDurableHead,
} from '../src/notion/migration-runner/journal-durability';
import { durabilityConfigFromEnv, DurabilityEnvConfig } from '../src/notion/migration-runner/drive-checkpoint-sink';

export async function runJournalDurability(
  command: string,
  env: Record<string, string | undefined> = process.env,
  deps: { durability?: DurabilityEnvConfig; journalPath?: string } = {},
): Promise<void> {
  const journalPath = deps.journalPath || path.resolve(process.cwd(), '.local', 'backfill-live-journal.db');
  const cfg = deps.durability || durabilityConfigFromEnv(env);

  switch (command) {
    case 'status': {
      const head = await cfg.sink.head(cfg.namespace);
      const headHeader = head ? decryptCheckpoint(await cfg.sink.get(head), cfg.key).header : null;
      let localDigest: string | null = null;
      if (fs.existsSync(journalPath)) {
        const db = new Database(journalPath, { readonly: true });
        try {
          localDigest = new BackfillJournal(db).stateDigest();
        } finally {
          db.close();
        }
      }
      console.log(`namespace=${cfg.namespace}`);
      console.log(`durableHeadSeq=${head?.seq ?? 'NONE'} reason=${headHeader?.reason ?? '-'} createdAt=${headHeader?.createdAt ?? '-'}`);
      console.log(`durableHeadDigest=${headHeader?.stateDigest ?? 'NONE'}`);
      console.log(`localDigest=${localDigest ?? 'NO_LOCAL_JOURNAL'}`);
      console.log(`LOCAL_EQUALS_HEAD=${Boolean(headHeader && localDigest === headHeader.stateDigest)}`);
      return;
    }
    case 'bootstrap': {
      if (!fs.existsSync(journalPath)) {
        throw new Error(`FAIL_DURABILITY_BOOTSTRAP: Journal local não encontrado em '${journalPath}'.`);
      }
      const journal = new BackfillJournal(journalPath);
      try {
        const cp = await DurableJournalCheckpointer.open({ ...cfg, journal, bootstrap: true });
        console.log(`DURABILITY_BOOTSTRAPPED seq=${cp.getLastSeq()} digest=${journal.stateDigest()}`);
      } finally {
        journal.close();
      }
      return;
    }
    case 'restore': {
      const header = await restoreJournalFromDurableHead({ ...cfg, targetPath: journalPath });
      console.log(`JOURNAL_RESTORED seq=${header.seq} digest=${header.stateDigest} reason=${header.reason}`);
      return;
    }
    case 'verify': {
      const journal = new BackfillJournal(journalPath);
      try {
        const cp = await DurableJournalCheckpointer.open({ ...cfg, journal });
        console.log(`LOCAL_EQUALS_HEAD=true seq=${cp.getLastSeq()}`);
      } finally {
        journal.close();
      }
      return;
    }
    case 'smoke': {
      // End-to-end check of the real sink with a throwaway namespace and a synthetic journal.
      const ns = `smoke-${Date.now()}`;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fjcp-smoke-'));
      const journal = new BackfillJournal(path.join(dir, 'j.db'));
      try {
        journal.startRun({
          runId: ns, planHash: 'smoke', planOriginCommitSha: 'smoke', executorCommitSha: 'smoke',
          sourceSnapshotHash: 'smoke', targetSnapshotHash: 'smoke', targetStateHash: 'smoke',
        });
        const t0 = Date.now();
        const cp = await DurableJournalCheckpointer.open({ ...cfg, namespace: ns, journal, bootstrap: true });
        for (let i = 0; i < 3; i++) {
          journal.completeRun(ns, new Date(Date.now() + i).toISOString());
          await cp.checkpoint(`SMOKE_${i}`);
        }
        const perCheckpointMs = Math.round((Date.now() - t0) / 4);
        const restored = await restoreJournalFromDurableHead({ ...cfg, namespace: ns, targetPath: path.join(dir, 'r.db') });
        if (restored.seq !== 4 || restored.stateDigest !== journal.stateDigest()) {
          throw new Error('FAIL_DURABILITY_SMOKE: head restaurado diverge do estado confirmado.');
        }
        console.log(`DURABILITY_SMOKE_OK namespace=${ns} checkpoints=4 avgMsPerCheckpoint=${perCheckpointMs}`);
      } finally {
        journal.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return;
    }
    default:
      throw new Error(`Comando desconhecido '${command}'. Use: status | bootstrap | restore | verify | smoke.`);
  }
}

if (require.main === module) {
  runJournalDurability(process.argv[2] || 'status').catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
