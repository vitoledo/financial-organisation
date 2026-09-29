import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { BackfillDryRunAnalyzer } from '../src/notion/migration-runner/backfill-dry-run';
import { resolvePlannerConfig } from '../src/notion/migration-runner/backfill-planner';
import { BackfillOperation } from '../src/notion/migration-runner/types';
import { projectNotionState } from '../src/notion/sync/projection';
import { readSqliteRows } from '../src/notion/sync/engine';

/**
 * The incremental sync must produce pages indistinguishable from the ones the backfill created. This runs the
 * sync projection over the frozen source snapshot and asserts it reproduces the frozen 159-operation plan
 * (155 transactions + 4 card bills) field by field, relation by relation.
 */
describe('Notion sync projection parity with the frozen backfill plan', () => {
  it('reproduces every transaction and card-bill operation of the frozen plan', { timeout: 60000 }, async () => {
    // Offline: fake data source ids, no API key (never the shell's real credentials).
    const testEnv = {
      NOTION_API_KEY: '',
      NOTION_DS_ACCOUNTS: 'fake-acc-ds',
      NOTION_DS_CATEGORIES: 'fake-cat-ds',
      NOTION_DS_TRANSACTIONS: 'fake-tx-ds',
      NOTION_DS_CARD_BILLS: 'fake-bills-ds',
      NOTION_TARGET_SNAPSHOT_MANIFEST: 'backups/notion-data-snapshot-20260913T190702-0a3af05c.json.enc.manifest.json',
      SOURCE_SQLITE_SNAPSHOT_MANIFEST: 'backups/financial-backup-20260914T023409-a6df794b.db.enc.manifest.json',
      BACKFILL_ACCOUNT_MAPPING_PATH: 'data/account-mapping.json',
      MIGRATION_BACKUP_KEY: process.env.MIGRATION_BACKUP_KEY,
    };
    const analyzer = new BackfillDryRunAnalyzer({ envVars: testEnv, commitSha: '92187f7f712178aac634d23e53e22aa9dededb7c' });
    const plan = (await analyzer.runAnalysis()).planArtifact;
    const ops = plan.operations as BackfillOperation[];
    expect(ops.length).toBe(159);

    const target = analyzer.prepareValidatedTargetSnapshot();
    const source = analyzer.prepareValidatedSourceDatabase();
    try {
      const db = new Database(source.restoredDbPath, { readonly: true });
      const rows = readSqliteRows(db);
      db.close();

      const { effectiveConfig } = resolvePlannerConfig(undefined, testEnv);
      const projection = projectNotionState(rows.accounts, rows.transactions, {
        accountRoles: effectiveConfig.sourceAccountMapping,
        defaultDueDay: effectiveConfig.defaultDueDay,
        notionAccounts: target.notionAccounts.map((a: any) => ({ id: a.id, name: a.name })),
        categoryIdByName: new Map(target.notionCategories.map((c: any) => [String(c.name).toLowerCase().trim(), c.id])),
        hmacKey: effectiveConfig.counterpartyHmacKey,
        hmacKeyVersion: effectiveConfig.hmacKeyVersion || 'v1',
        sameOwnershipKeywords: effectiveConfig.sameOwnershipCategoryKeywords || ['mesma titularidade'],
        checkingAccountName: 'Nubank Conta',
        creditAccountName: 'Nubank Cartão',
      });

      const txOps = ops.filter((o) => o.targetDataSource.envKey === 'NOTION_DS_TRANSACTIONS');
      const billOps = ops.filter((o) => o.targetDataSource.envKey === 'NOTION_DS_CARD_BILLS');
      expect(projection.transactions.length).toBe(txOps.length);
      expect(projection.bills.length).toBe(billOps.length);
      expect(projection.unresolvedAccountIds).toEqual([]);

      const txById = new Map(projection.transactions.map((t) => [t.stableId, t]));
      for (const op of txOps) {
        const t = txById.get(op.stableId);
        expect(t, op.stableId).toBeDefined();
        expect(t!.payload).toEqual(op.sanitizedPayload);
        const existing = (prop: string) => (op.relations[prop] || []).filter((r) => r.type === 'EXISTING_PAGE_ID').map((r) => r.target);
        expect(t!.relations['Conta']).toEqual(existing('Conta'));
        expect(t!.relations['Categoria']).toEqual(existing('Categoria'));
        const plannedBill = (op.relations['Fatura Vinculada'] || []).map((r) => r.target);
        expect(t!.billStableId ? [t!.billStableId] : []).toEqual(plannedBill);
      }

      const billById = new Map(projection.bills.map((b) => [b.stableId, b]));
      for (const op of billOps) {
        const b = billById.get(op.stableId);
        expect(b, op.stableId).toBeDefined();
        expect(b!.payload).toEqual(op.sanitizedPayload);
        expect(b!.purchaseIds).toEqual(op.relations['Lançamentos do Ciclo'].map((r) => r.target));
        expect(b!.paymentIds).toEqual(op.relations['Transações de Pagamento'].map((r) => r.target));
        expect([b!.cardPageId]).toEqual(op.relations['Cartão Vinculado'].map((r) => r.target));
      }
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });
});
