import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { loadNotionSyncConfig } from '../src/notion/sync/config';

function mappingFile(content: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-sync-config-'));
  const file = path.join(dir, 'account-mapping.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

const BASE = {
  NOTION_API_KEY: 'fake-key',
  NOTION_DS_TRANSACTIONS: 'ds-tx',
  NOTION_DS_CARD_BILLS: 'ds-bills',
  NOTION_DS_ACCOUNTS: 'ds-acc',
  NOTION_DS_CATEGORIES: 'ds-cat',
  NOTION_DS_RULES: 'ds-rules',
  NOTION_DS_SYNC_LOG: 'ds-log',
  GIT_COMMIT: 'abc1234',
};

describe('loadNotionSyncConfig', () => {
  it('fails closed listing every missing variable', () => {
    expect(() => loadNotionSyncConfig({ NOTION_API_KEY: 'x' })).toThrow(/FAIL_CLOSED_ENV: .*NOTION_DS_TRANSACTIONS.*NOTION_DS_SYNC_LOG/);
  });

  it('reads the backfill account mapping (roles + default due day) and defaults', () => {
    const file = mappingFile({ 'bank-1': 'CHECKING', 'card-1': 'CREDIT', defaultDueDay: 16 });
    const cfg = loadNotionSyncConfig({ ...BASE, ACCOUNT_MAPPING_PATH: file, COUNTERPARTY_HMAC_KEY: '', PIERRE_API_KEY: '' });
    expect(cfg.settings.accountRoles).toEqual({ 'bank-1': 'CHECKING', 'card-1': 'CREDIT' });
    expect(cfg.settings.defaultDueDay).toBe(16);
    expect(cfg.settings.checkingAccountName).toBe('Nubank Conta');
    expect(cfg.settings.creditAccountName).toBe('Nubank Cartão');
    expect(cfg.settings.maxCreates).toBe(300);
    expect(cfg.settings.workerVersion).toBe('abc1234');
    expect(cfg.pierreApiKey).toBeNull();
    expect(cfg.ds.syncLog).toBe('ds-log');
  });

  it('rejects an invalid role in the mapping file', () => {
    const file = mappingFile({ 'bank-1': 'SAVINGS' });
    expect(() => loadNotionSyncConfig({ ...BASE, ACCOUNT_MAPPING_PATH: file })).toThrow(/FAIL_CLOSED_ACCOUNT_MAPPING_CONFIG/);
  });

  it('rejects a weak counterparty HMAC key', () => {
    const file = mappingFile({ 'bank-1': 'CHECKING' });
    expect(() => loadNotionSyncConfig({ ...BASE, ACCOUNT_MAPPING_PATH: file, COUNTERPARTY_HMAC_KEY: 'short' })).toThrow(/FAIL_CLOSED_HMAC_KEY/);
  });
});
