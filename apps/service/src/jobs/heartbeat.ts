import { Duration, Effect } from 'effect';

import type { Job } from './job-runner.js';

export const HEARTBEAT_JOB_NAME = 'heartbeat';

// A slow, constant liveness tick. The run body is a no-op success; the runner's
// generic recording produces the job_runs row that proves the runner is alive.
export const HEARTBEAT_INTERVAL: Duration.Duration = Duration.minutes(5);

export const heartbeatJob: Job = {
  interval: HEARTBEAT_INTERVAL,
  name: HEARTBEAT_JOB_NAME,
  run: Effect.void,
};
