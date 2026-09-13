import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NotionLiveDataSnapshotManager } from '../src/notion/migration-runner/data-snapshot';
import { TARGET_CONTRACT } from '../src/domain/schema-contract';

const VALID_KEY_HEX = crypto.randomBytes(32).toString('hex');

describe('NotionLiveDataSnapshotManager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-data-snapshot-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid or missing backup keys', () => {
    expect(() => {
      (new NotionLiveDataSnapshotManager({
        backupKey: 'too-short',
        apiKey: 'test-key',
      }) as any).deriveKey();
    }).toThrow();
  });

  it('captures full data snapshot, encrypts with AES-256-GCM, verifies restoration, and writes manifest', async () => {
    const fakePagesByDs: Record<string, any[]> = {};
    const testEnvVars: Record<string, string> = {
      NOTION_API_KEY: 'test-api-key',
    };

    for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
      const fakeDsId = `ds-id-${contract.envKey}`;
      testEnvVars[contract.envKey] = fakeDsId;
      fakePagesByDs[fakeDsId] = [
        {
          id: `page-${contract.envKey}-1`,
          created_time: '2026-09-13T10:00:00.000Z',
          last_edited_time: '2026-09-13T10:30:00.000Z',
          is_archived: false,
          url: `https://notion.so/page-${contract.envKey}-1`,
          properties: {
            Name: {
              type: 'title',
              title: [{ plain_text: `Test Entry in ${contract.defaultTitle}` }],
            },
          },
        },
      ];
    }

    const fakeClient: any = {
      dataSources: {
        query: async (args: { data_source_id: string }) => {
          return {
            results: fakePagesByDs[args.data_source_id] || [],
            has_more: false,
          };
        },
      },
    };

    const manager = new NotionLiveDataSnapshotManager({
      client: fakeClient,
      backupKey: VALID_KEY_HEX,
      backupDir: tempDir,
      envVars: testEnvVars,
    });

    const result = await manager.captureLiveSnapshot();

    expect(result.verifiedRestoration).toBe(true);
    expect(result.metadata.totalBases).toBe(13);
    expect(result.metadata.totalRecordsAllBases).toBe(13);
    expect(fs.existsSync(result.backupPath)).toBe(true);
    expect(fs.existsSync(result.manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    expect(manifest.format).toBe('FIN_ENC_V1');
    expect(manifest.algorithm).toBe('aes-256-gcm');
    expect(manifest.verifiedRestoration).toBe(true);
    expect(manifest.totalBases).toBe(13);
    expect(manifest.totalRecordsAllBases).toBe(13);
    expect(manifest.commitSha).toBeDefined();
    expect(manifest.dataSourceIds).toBeDefined();
    expect(Object.keys(manifest.dataSourceIds)).toHaveLength(13);
    expect(manifest.schemaHashByBase).toBeDefined();
    expect(Object.keys(manifest.schemaHashByBase)).toHaveLength(13);
    expect(manifest.rowCountByBase).toBeDefined();
    expect(Object.keys(manifest.rowCountByBase)).toHaveLength(13);

    // Test restoreAndValidateToTempDir
    const restoreTargetDir = path.join(tempDir, 'restore-test');
    const restoreResult = manager.restoreAndValidateToTempDir(result.backupPath, restoreTargetDir, VALID_KEY_HEX);
    expect(restoreResult.valid).toBe(true);
    expect(restoreResult.totalRecordsValidated).toBe(13);
    expect(fs.existsSync(restoreResult.restoredJsonPath)).toBe(true);
    expect(Object.keys(restoreResult.basesSummary)).toHaveLength(13);
  });

  it('restores real snapshot and verifies all 23 live records if backup exists', () => {
    const backupKey = process.env.MIGRATION_BACKUP_KEY?.trim();
    if (!backupKey) return;
    const backupDir = path.resolve('backups');
    if (!fs.existsSync(backupDir)) return;
    const files = fs.readdirSync(backupDir).filter((f) => f.startsWith('notion-data-snapshot-') && f.endsWith('.json.enc'));
    if (files.length === 0) return;
    const latestBackup = path.join(backupDir, files.sort().reverse()[0]);
    const manager = new NotionLiveDataSnapshotManager({ backupKey, client: {} as any });
    const res = manager.restoreAndValidateToTempDir(latestBackup, tempDir);
    expect(res.valid).toBe(true);
    expect(res.totalRecordsValidated).toBe(23);
    expect(res.basesSummary['NOTION_DS_ACCOUNTS'].recordCount).toBe(3);
    expect(res.basesSummary['NOTION_DS_CATEGORIES'].recordCount).toBe(16);
    expect(res.basesSummary['NOTION_DS_RULES'].recordCount).toBe(3);
    expect(res.basesSummary['NOTION_DS_MONTHLY_BUDGET'].recordCount).toBe(1);
  });
});
