import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { describe, it, expect } from 'vitest';
import { evaluateHealth } from '../docker/healthcheck.mjs';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const base = { sheetsBeat: null, sheetsEnabled: false, staleHours: 30, now: NOW };

describe('container healthcheck', () => {
  it('is healthy after a recent Notion sync that wrote or had nothing to do', () => {
    expect(evaluateHealth({ ...base, notionBeat: { status: 'SUCCESS', finishedAt: hoursAgo(2) } })).toEqual([]);
    expect(evaluateHealth({ ...base, notionBeat: { status: 'NOTHING_TO_DO', finishedAt: hoursAgo(11) } })).toEqual([]);
  });

  it('is unhealthy before the first run, after a failure or partial run, and when the run is stale', () => {
    expect(evaluateHealth({ ...base, notionBeat: null })).toEqual(['notion-sync: no heartbeat yet']);
    expect(evaluateHealth({ ...base, notionBeat: { status: 'failure', finishedAt: hoursAgo(1), error: 'Pierre API error 401' } })[0]).toMatch(/failure: Pierre API error 401/);
    expect(evaluateHealth({ ...base, notionBeat: { status: 'PARTIAL', finishedAt: hoursAgo(1) } })[0]).toMatch(/PARTIAL/);
    expect(evaluateHealth({ ...base, notionBeat: { status: 'SUCCESS', finishedAt: hoursAgo(31) } })[0]).toMatch(/stale: 31\.0h/);
  });

  it('ignores the legacy Sheets heartbeat unless that job is enabled', () => {
    const notionBeat = { status: 'SUCCESS', finishedAt: hoursAgo(1) };
    const sheetsBeat = { status: 'failure', finishedAt: hoursAgo(1), error: 'invalid_grant' };
    expect(evaluateHealth({ ...base, notionBeat, sheetsBeat })).toEqual([]);
    expect(evaluateHealth({ ...base, notionBeat, sheetsBeat, sheetsEnabled: true })).toEqual(['sheets-sync: last run failure: invalid_grant']);
    expect(evaluateHealth({ ...base, notionBeat, sheetsBeat: { status: 'success', finishedAt: hoursAgo(3) }, sheetsEnabled: true })).toEqual([]);
  });

  it('runs as a script against the heartbeat files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthcheck-'));
    const run = () =>
      spawnSync(process.execPath, [path.resolve(__dirname, '../docker/healthcheck.mjs')], {
        env: { ...process.env, HEALTHCHECK_DATA_DIR: dir, ENABLE_GOOGLE_SHEETS_SYNC: '' },
        encoding: 'utf8',
      });
    expect(run().status).toBe(1);
    fs.writeFileSync(path.join(dir, 'last-notion-sync.json'), JSON.stringify({ status: 'NOTHING_TO_DO', finishedAt: new Date().toISOString() }));
    const ok = run();
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
  });
});
