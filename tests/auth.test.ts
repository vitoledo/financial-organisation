import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Mock googleapis so no real OAuth client is constructed.
// ---------------------------------------------------------------------------

const refreshAccessToken = vi.fn();
const setCredentials = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials = setCredentials;
        refreshAccessToken = refreshAccessToken;
        generateAuthUrl = vi.fn(() => 'https://consent.example');
        getToken = vi.fn();
      },
    },
  },
}));

import { getAuthClient } from '../src/sheets/auth';

const noopLogger = { info: vi.fn(), warn: vi.fn() };
let tmpDir: string;
let tokensPath: string;

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    clientId: 'id',
    clientSecret: 'secret',
    tokensPath,
    logger: noopLogger,
    ...overrides,
  };
}

function writeTokens(tokens: Record<string, unknown>): void {
  fs.writeFileSync(tokensPath, JSON.stringify(tokens));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-auth-'));
  tokensPath = path.join(tmpDir, 'google-tokens.json');
  refreshAccessToken.mockReset();
  setCredentials.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getAuthClient — headless guard', () => {
  test('throws with a provisioning hint when no tokens exist headless', async () => {
    await expect(getAuthClient(baseConfig({ headless: true }))).rejects.toThrow(
      /sem navegador \(headless\)/,
    );
  });
});

describe('getAuthClient — existing tokens', () => {
  test('loads valid tokens without refreshing', async () => {
    writeTokens({
      access_token: 'valid',
      refresh_token: 'r1',
      expiry_date: Date.now() + 60 * 60 * 1000, // 1h ahead
    });

    await getAuthClient(baseConfig());

    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(setCredentials).toHaveBeenCalled();
  });

  test('refreshes expired tokens and preserves the refresh_token', async () => {
    writeTokens({
      access_token: 'stale',
      refresh_token: 'keep-me',
      expiry_date: Date.now() - 1000, // already expired
    });
    // A refresh response omits refresh_token — the stored one must survive.
    refreshAccessToken.mockResolvedValue({
      credentials: { access_token: 'fresh', expiry_date: Date.now() + 3_600_000 },
    });

    await getAuthClient(baseConfig({ headless: true }));

    expect(refreshAccessToken).toHaveBeenCalledOnce();
    const saved = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    expect(saved.access_token).toBe('fresh');
    expect(saved.refresh_token).toBe('keep-me');
  });

  test('surfaces an actionable error when refresh fails', async () => {
    writeTokens({ access_token: 'stale', refresh_token: 'dead', expiry_date: Date.now() - 1000 });
    refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));

    await expect(getAuthClient(baseConfig({ headless: true }))).rejects.toThrow(
      /refresh_token revogado ou expirado.*invalid_grant/s,
    );
  });

  test('treats tokens without expiry_date as expired', async () => {
    writeTokens({ access_token: 'x', refresh_token: 'r' });
    refreshAccessToken.mockResolvedValue({ credentials: { access_token: 'fresh' } });

    await getAuthClient(baseConfig({ headless: true }));

    expect(refreshAccessToken).toHaveBeenCalledOnce();
  });
});
