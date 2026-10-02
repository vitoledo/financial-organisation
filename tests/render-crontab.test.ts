import path from 'path';
import { spawnSync } from 'child_process';
import { describe, it, expect } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../docker/render-crontab.sh');
const render = (env: Record<string, string> = {}) => {
  const clean = { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env };
  return spawnSync('sh', [SCRIPT], { env: clean, encoding: 'utf8' });
};
const jobs = (out: string) => out.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('CRON_TZ'));

describe('docker/render-crontab.sh', () => {
  it('schedules the Notion sync 4x a day by default, in Brazil time, and keeps the Sheets job gated', () => {
    const r = render();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CRON_TZ=America/Sao_Paulo');
    expect(jobs(r.stdout)).toEqual([
      '0 0,6,12,18 * * * node /app/dist/notion/sync/cli.js --apply',
      '30 6,18 * * * if [ "$ENABLE_GOOGLE_SHEETS_SYNC" = "true" ]; then node /app/dist/index.js; fi',
    ]);
  });

  it('takes both schedules from the environment', () => {
    const r = render({ NOTION_SYNC_SCHEDULE: '40 6,18 * * *', SHEETS_SYNC_SCHEDULE: '@daily' });
    expect(r.status).toBe(0);
    expect(jobs(r.stdout)[0]).toBe('40 6,18 * * * node /app/dist/notion/sync/cli.js --apply');
    expect(jobs(r.stdout)[1]).toMatch(/^@daily if \[/);
  });

  it('refuses a malformed schedule or anything that is not a cron expression', () => {
    for (const bad of ['every hour', '0 6', '0 6 * * * ; rm -rf /', '0 6 * * * $(id)', '@daily; id', '@every 1h']) {
      const r = render({ NOTION_SYNC_SCHEDULE: bad });
      expect(r.status, bad).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/render-crontab: NOTION_SYNC_SCHEDULE/);
    }
    expect(render({ SHEETS_SYNC_SCHEDULE: 'x' }).stderr).toMatch(/SHEETS_SYNC_SCHEDULE/);
  });
});
