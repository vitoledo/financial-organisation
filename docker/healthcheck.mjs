// Container healthcheck. A cron job is idle between runs, so health is derived
// from the heartbeat the CLI writes on every terminal path: unhealthy if the
// last run failed, or if it is older than the expected cadence plus a margin.
import { readFileSync } from 'node:fs';

const STALE_HOURS = Number(process.env.STALE_HOURS ?? 30); // 2x/day + margin
const HEARTBEAT = '/app/data/last-run.json';

try {
  const beat = JSON.parse(readFileSync(HEARTBEAT, 'utf8'));

  if (beat.status !== 'success') {
    console.error(`last run ${beat.status}: ${beat.error ?? 'unknown error'}`);
    process.exit(1);
  }

  const ageHours = (Date.now() - new Date(beat.finishedAt).getTime()) / 3_600_000;
  if (Number.isNaN(ageHours) || ageHours > STALE_HOURS) {
    console.error(`heartbeat stale: ${ageHours.toFixed(1)}h (limit ${STALE_HOURS}h)`);
    process.exit(1);
  }

  process.exit(0);
} catch {
  console.error('no heartbeat yet');
  process.exit(1);
}
