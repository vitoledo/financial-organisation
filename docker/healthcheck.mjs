// Container healthcheck. A cron job is idle between runs, so health is derived
// from the heartbeats the CLIs write on every terminal path: unhealthy if the
// last run failed, or if it is older than the expected cadence plus a margin.
//
// - Notion sync (data/last-notion-sync.json): always checked. SUCCESS and
//   NOTHING_TO_DO are healthy; PARTIAL (some writes failed) and failure are not.
// - Google Sheets sync (data/last-run.json): checked only when
//   ENABLE_GOOGLE_SHEETS_SYNC=true, because the cron job is off otherwise.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HEALTHY_NOTION = new Set(['SUCCESS', 'NOTHING_TO_DO']);

function ageProblem(label, beat, staleHours, now) {
  const ageHours = (now - new Date(beat.finishedAt).getTime()) / 3_600_000;
  if (Number.isNaN(ageHours) || ageHours > staleHours) {
    return `${label}: heartbeat stale: ${Number.isNaN(ageHours) ? '?' : ageHours.toFixed(1)}h (limit ${staleHours}h)`;
  }
  return null;
}

/** Pure decision: returns the list of problems (empty = healthy). Heartbeats are parsed objects or null. */
export function evaluateHealth({ notionBeat, sheetsBeat, sheetsEnabled, staleHours, now }) {
  const problems = [];
  if (!notionBeat) {
    problems.push('notion-sync: no heartbeat yet');
  } else if (!HEALTHY_NOTION.has(notionBeat.status)) {
    problems.push(`notion-sync: last run ${notionBeat.status}: ${notionBeat.error ?? 'see the container logs'}`);
  } else {
    const stale = ageProblem('notion-sync', notionBeat, staleHours, now);
    if (stale) problems.push(stale);
  }
  if (sheetsEnabled) {
    if (!sheetsBeat) {
      problems.push('sheets-sync: no heartbeat yet');
    } else if (sheetsBeat.status !== 'success') {
      problems.push(`sheets-sync: last run ${sheetsBeat.status}: ${sheetsBeat.error ?? 'unknown error'}`);
    } else {
      const stale = ageProblem('sheets-sync', sheetsBeat, staleHours, now);
      if (stale) problems.push(stale);
    }
  }
  return problems;
}

function readBeat(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = process.env.HEALTHCHECK_DATA_DIR ?? '/app/data';
  const problems = evaluateHealth({
    notionBeat: readBeat(`${dataDir}/last-notion-sync.json`),
    sheetsBeat: readBeat(`${dataDir}/last-run.json`),
    sheetsEnabled: process.env.ENABLE_GOOGLE_SHEETS_SYNC === 'true',
    staleHours: Number(process.env.STALE_HOURS ?? 30), // 2x/day + margin
    now: Date.now(),
  });
  for (const p of problems) console.error(p);
  process.exit(problems.length === 0 ? 0 : 1);
}
