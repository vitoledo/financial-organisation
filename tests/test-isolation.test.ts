import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import { AddressInfo } from 'net';
import dotenv from 'dotenv';
import { describe, it, expect } from 'vitest';
import { Client } from '@notionhq/client';
import { isLiveEnvVar } from './setup/isolate-live-credentials';

/** Guards for tests/setup/isolate-live-credentials.ts: the suite must never reach live systems. */
describe('test isolation from live credentials and network', () => {
  it('neutralizes every live credential, mutation gate and workspace id', () => {
    for (const name of ['NOTION_API_KEY', 'PIERRE_API_KEY', 'NOTION_PARENT_PAGE_ID']) {
      expect(process.env[name]).toBe('');
    }
    const leaked = Object.keys(process.env).filter((k) => isLiveEnvVar(k) && process.env[k] !== '');
    expect(leaked).toEqual([]);
    expect(isLiveEnvVar('NOTION_DS_TRANSACTIONS')).toBe(true);
    expect(isLiveEnvVar('GOOGLE_CLIENT_SECRET')).toBe(true);
    expect(isLiveEnvVar('JOURNAL_CHECKPOINT_GOOGLE_REFRESH_TOKEN')).toBe(true);
    expect(isLiveEnvVar('FINANCIAL_BACKFILL_ENABLED')).toBe(true);
    expect(isLiveEnvVar('MIGRATION_BACKUP_KEY')).toBe(false);
  });

  it('a later dotenv load cannot reintroduce a real key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-'));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'NOTION_API_KEY=ntn_real_looking_key\nJOURNAL_CHECKPOINT_GOOGLE_REFRESH_TOKEN=real\n');
    try {
      dotenv.config({ path: envFile, quiet: true } as dotenv.DotenvConfigOptions);
      expect(process.env.NOTION_API_KEY).toBe('');
      expect(process.env.JOURNAL_CHECKPOINT_GOOGLE_REFRESH_TOKEN).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks the Notion SDK, fetch and https to external hosts', async () => {
    const notion = new Client({ auth: 'ntn_should_never_leave', notionVersion: '2026-03-11', maxRetries: 0 } as any);
    await expect(notion.users.me({})).rejects.toThrow(/TEST_NETWORK_BLOCKED/);
    await expect(fetch('https://api.notion.com/v1/users/me')).rejects.toThrow(/TEST_NETWORK_BLOCKED/);
    expect(() => https.request({ hostname: 'www.googleapis.com', path: '/drive/v3/files' })).toThrow(/TEST_NETWORK_BLOCKED/);
    expect(() => https.get('https://oauth2.googleapis.com/token')).toThrow(/TEST_NETWORK_BLOCKED/);
  });

  it('still allows loopback (local test servers)', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('ok');
    } finally {
      server.close();
    }
  });
});
