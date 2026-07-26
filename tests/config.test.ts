import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig } from '../src/config';

// loadConfig reads process.env fresh on each call, so tests mutate a saved
// snapshot and restore it afterwards.
const ENV_KEYS = [
  'PIERRE_API_KEY', 'PIERRE_API_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'DATA_DIR', 'DB_PATH', 'LOG_PATH', 'TOKENS_PATH', 'SPREADSHEET_ID',
  'HEADLESS', 'LOG_TO_FILE', 'STALE_HOURS',
];

let saved: Record<string, string | undefined>;
let tmpDir: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-config-'));
  process.env.PIERRE_API_KEY = 'pierre-key';
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.DATA_DIR = tmpDir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  test('requires the mandatory secrets', () => {
    delete process.env.PIERRE_API_KEY;
    expect(() => loadConfig()).toThrow(/PIERRE_API_KEY/);
  });

  test('derives all data paths from DATA_DIR', () => {
    const config = loadConfig();

    expect(config.dataDir).toBe(tmpDir);
    expect(config.dbPath).toBe(path.join(tmpDir, 'financial.db'));
    expect(config.logPath).toBe(path.join(tmpDir, 'sync.log'));
    expect(config.tokensPath).toBe(path.join(tmpDir, 'google-tokens.json'));
    expect(config.spreadsheetIdPath).toBe(path.join(tmpDir, 'spreadsheet-id.txt'));
  });

  test('explicit path overrides win over DATA_DIR', () => {
    process.env.DB_PATH = '/custom/db.sqlite';
    expect(loadConfig().dbPath).toBe('/custom/db.sqlite');
  });

  test('materializes a preset SPREADSHEET_ID to the id file', () => {
    process.env.SPREADSHEET_ID = '  sheet-123  ';

    const config = loadConfig();

    expect(fs.readFileSync(config.spreadsheetIdPath, 'utf8')).toBe('sheet-123');
  });

  test('does not create the id file when SPREADSHEET_ID is absent', () => {
    const config = loadConfig();
    expect(fs.existsSync(config.spreadsheetIdPath)).toBe(false);
  });

  test('HEADLESS=1 forces headless mode', () => {
    process.env.HEADLESS = '1';
    expect(loadConfig().headless).toBe(true);
  });

  test('logToFile defaults on and turns off with LOG_TO_FILE=0', () => {
    expect(loadConfig().logToFile).toBe(true);
    process.env.LOG_TO_FILE = '0';
    expect(loadConfig().logToFile).toBe(false);
  });

  test('staleHours defaults to 96 and honors the override', () => {
    expect(loadConfig().staleHours).toBe(96);
    process.env.STALE_HOURS = '48';
    expect(loadConfig().staleHours).toBe(48);
  });

  test('passes the Pierre base url through when set', () => {
    process.env.PIERRE_API_URL = 'https://api.pierre.example';
    expect(loadConfig().pierreApiUrl).toBe('https://api.pierre.example');
  });
});
