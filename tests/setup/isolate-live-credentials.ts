/**
 * Test isolation from live systems. Loaded through vitest `setupFiles`, i.e. before every test file.
 *
 * Several production classes fall back to `process.env` when no env is passed, and some tests import
 * `dotenv/config`. Without this file, a real NOTION_API_KEY (or Google OAuth token) present in the shell
 * or in a developer's `.env` would reach the live Notion workspace / Google Drive from the test suite.
 *
 *  1. `.env` is loaded first, then every live credential, mutation gate and live workspace identifier is
 *     set to '' (dotenv never overrides an existing variable, even an empty one, so a later
 *     `import 'dotenv/config'` cannot bring them back; the known credential names are pre-seeded even
 *     when absent). Local-only material (MIGRATION_BACKUP_KEY for the frozen encrypted fixtures, manifest
 *     paths, HMAC keys) is kept.
 *  2. Outbound network access to anything but loopback is refused with TEST_NETWORK_BLOCKED, for global
 *     fetch (Notion SDK, gaxios 7) and node http/https requests (gaxios 6 / node-fetch).
 */
import http from 'http';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config({ quiet: true } as dotenv.DotenvConfigOptions);

/** Pre-seeded even when absent, so no later dotenv file can introduce them. */
const LIVE_ENV_EXACT = [
  'NOTION_API_KEY',
  'NOTION_PARENT_PAGE_ID',
  'NOTION_WORKSPACE_PAGE_ID',
  'PIERRE_API_KEY',
  'SPREADSHEET_ID',
  'PRIVATE_DB_URL',
  'PRIVATE_DB_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'JOURNAL_CHECKPOINT_KEY',
  'JOURNAL_CHECKPOINT_NAMESPACE',
  'JOURNAL_CHECKPOINT_GOOGLE_REFRESH_TOKEN',
  'JOURNAL_CHECKPOINT_DRIVE_FOLDER_ID',
  'FINANCIAL_BACKFILL_ENABLED',
];
const LIVE_ENV_PREFIXES = ['NOTION_DS_', 'GOOGLE_', 'JOURNAL_CHECKPOINT_', 'FINANCIAL_BACKFILL_'];

export function isLiveEnvVar(name: string): boolean {
  return LIVE_ENV_EXACT.includes(name) || LIVE_ENV_PREFIXES.some((p) => name.startsWith(p));
}

for (const name of [...LIVE_ENV_EXACT, ...Object.keys(process.env).filter(isLiveEnvVar)]) {
  process.env[name] = '';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function assertLoopbackHost(hostname: string | null | undefined, what: string): void {
  const host = (hostname || 'localhost').toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`TEST_NETWORK_BLOCKED: ${what} to '${host}' is not allowed in tests (use a mock client).`);
  }
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  try {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assertLoopbackHost(url.hostname, 'fetch');
  } catch (err) {
    return Promise.reject(err);
  }
  return realFetch(input, init);
}) as typeof fetch;

function hostOf(args: any[]): string | undefined {
  const [first, second] = args;
  if (typeof first === 'string') return new URL(first).hostname;
  if (first instanceof URL) return first.hostname;
  const opts = first && typeof first === 'object' ? first : second;
  return opts?.hostname ?? opts?.host?.split(':')[0];
}

for (const mod of [http, https] as any[]) {
  const scheme = mod === https ? 'https' : 'http';
  for (const method of ['request', 'get']) {
    const real = mod[method];
    mod[method] = function guarded(this: unknown, ...args: any[]) {
      assertLoopbackHost(hostOf(args), `${scheme}.${method}`);
      return real.apply(this, args);
    };
  }
}
