import { Duration, Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import type { CompletedJobRun, Job } from './job-runner.js';
import { startJobRunner } from './job-runner.js';

const TICK: Duration.DurationInput = Duration.millis(5);

async function waitUntil(
  predicate: () => boolean,
  { timeoutMs = 2000, stepMs = 5 }: { stepMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitUntil timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function recordInto(sink: CompletedJobRun[]) {
  return (run: CompletedJobRun): Effect.Effect<void> =>
    Effect.sync(() => {
      sink.push(run);
    });
}

describe('startJobRunner', () => {
  it('ticks a job repeatedly and records each successful run', async () => {
    const recorded: CompletedJobRun[] = [];
    let runs = 0;
    const runner = startJobRunner({
      jobs: [{ interval: TICK, name: 'counter', run: Effect.sync(() => void (runs += 1)) }],
      recordRun: recordInto(recorded),
    });

    try {
      await waitUntil(() => runs >= 3);
      const status = runner.status().find((entry) => entry.name === 'counter');
      expect(status?.lastOutcome).toBe('succeeded');
      expect(status?.lastRunAt).toBeInstanceOf(Date);
      expect(status?.consecutiveFailures).toBe(0);
      expect(recorded.filter((run) => run.jobName === 'counter').length).toBeGreaterThanOrEqual(3);
      expect(recorded.every((run) => run.outcome === 'succeeded')).toBe(true);
    } finally {
      await runner.stop();
    }
  });

  it('isolates a failing job from its siblings', async () => {
    const recorded: CompletedJobRun[] = [];
    const failing: Job = {
      interval: TICK,
      name: 'failing',
      run: Effect.fail(new Error('always down')),
    };
    const healthy: Job = { interval: TICK, name: 'healthy', run: Effect.void };
    const runner = startJobRunner({ jobs: [failing, healthy], recordRun: recordInto(recorded) });

    try {
      await waitUntil(
        () =>
          recorded.filter((run) => run.jobName === 'failing').length >= 3 &&
          recorded.filter((run) => run.jobName === 'healthy').length >= 3,
      );
      const status = runner.status();
      const failingStatus = status.find((entry) => entry.name === 'failing');
      const healthyStatus = status.find((entry) => entry.name === 'healthy');

      expect(failingStatus?.lastOutcome).toBe('failed');
      expect(failingStatus?.consecutiveFailures).toBeGreaterThanOrEqual(3);
      expect(healthyStatus?.lastOutcome).toBe('succeeded');
      expect(healthyStatus?.consecutiveFailures).toBe(0);

      const failedRecord = recorded.find((run) => run.jobName === 'failing');
      expect(failedRecord?.outcome).toBe('failed');
      expect(failedRecord?.error).toBe('always down');
    } finally {
      await runner.stop();
    }
  });

  it('resets consecutiveFailures after a success', async () => {
    const recorded: CompletedJobRun[] = [];
    let attempts = 0;
    // Fail the first two runs, then succeed forever.
    const flaky: Job = {
      interval: TICK,
      name: 'flaky',
      run: Effect.suspend(() => {
        attempts += 1;
        return attempts <= 2 ? Effect.fail(new Error('warming up')) : Effect.void;
      }),
    };
    const runner = startJobRunner({ jobs: [flaky], recordRun: recordInto(recorded) });

    try {
      await waitUntil(() => recorded.some((run) => run.outcome === 'failed'));
      await waitUntil(() => recorded.some((run) => run.outcome === 'succeeded'));
      await waitUntil(() => runner.status()[0]?.lastOutcome === 'succeeded');
      expect(runner.status()[0]?.consecutiveFailures).toBe(0);
    } finally {
      await runner.stop();
    }
  });

  it('stops ticking after the runner is stopped', async () => {
    const recorded: CompletedJobRun[] = [];
    let runs = 0;
    const runner = startJobRunner({
      jobs: [{ interval: TICK, name: 'counter', run: Effect.sync(() => void (runs += 1)) }],
      recordRun: recordInto(recorded),
    });

    await waitUntil(() => runs >= 2);
    await runner.stop();
    const afterStop = runs;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // No further ticks once interrupted.
    expect(runs).toBe(afterStop);
    await runner.stop();
  });

  it('keeps the fiber alive when recording a run fails', async () => {
    let runs = 0;
    const runner = startJobRunner({
      jobs: [{ interval: TICK, name: 'counter', run: Effect.sync(() => void (runs += 1)) }],
      recordRun: () => Effect.fail(new Error('recorder down')),
    });

    try {
      // The job body keeps executing despite every recorder call failing.
      await waitUntil(() => runs >= 3);
      expect(runner.status()[0]?.lastOutcome).toBe('succeeded');
    } finally {
      await runner.stop();
    }
  });
});
