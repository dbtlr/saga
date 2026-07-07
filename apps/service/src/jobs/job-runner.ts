import type { DatabaseService } from '@saga/db';
import type { Duration } from 'effect';
import { Cause, Effect, Exit, Fiber, Option, Schedule } from 'effect';
import type { RuntimeFiber } from 'effect/Fiber';

import { describeError } from '../errors.js';

// A background job: a named unit of work run on a fixed interval. The runner
// forks one supervised fiber per job and drives it with Schedule.spaced, which
// gives sequential, non-overlapping runs by construction.
export type Job = {
  interval: Duration.DurationInput;
  name: string;
  run: Effect.Effect<void, unknown>;
};

// A job is built from a context resolved only after the shared pool exists, so a
// future extraction job can reach the same DatabaseService the /v1 handlers use.
// The service resolves these post-listen; job internals stay pool-agnostic.
export type JobFactory = (ctx: { database: DatabaseService }) => Job;

export type JobOutcome = 'succeeded' | 'failed';

// A completed run handed to the recorder so it can be persisted. The recorder's
// own failures never propagate back into the job fiber.
export type CompletedJobRun = {
  error: string | null;
  finishedAt: Date;
  jobName: string;
  outcome: JobOutcome;
  startedAt: Date;
};

export type JobRunRecorder = (run: CompletedJobRun) => Effect.Effect<void, unknown>;

// In-memory, honestly-null-before-first-tick view of each job's health.
export type JobStatus = {
  consecutiveFailures: number;
  // Consecutive times the recorder rejected while the job itself kept running;
  // non-zero means the ledger is silently falling behind the in-memory status.
  consecutiveRecordFailures: number;
  lastOutcome: JobOutcome | null;
  lastRunAt: Date | null;
  name: string;
};

export type JobRunnerHandle = {
  status: () => JobStatus[];
  stop: () => Promise<void>;
};

export function startJobRunner(input: {
  jobs: readonly Job[];
  recordRun: JobRunRecorder;
}): JobRunnerHandle {
  // Mutable status is updated only inside Effect.sync steps on each job fiber;
  // JS is single-threaded per fiber step, so status() reads a consistent snapshot.
  const statuses = new Map<string, JobStatus>();
  for (const job of input.jobs) {
    if (statuses.has(job.name)) {
      // Two jobs sharing a name would collide on one status entry and interleave
      // their counters and retention window; reject the ambiguity at startup.
      throw new Error(`duplicate job name: ${job.name}`);
    }
    statuses.set(job.name, {
      consecutiveFailures: 0,
      consecutiveRecordFailures: 0,
      lastOutcome: null,
      lastRunAt: null,
      name: job.name,
    });
  }

  const fibers: RuntimeFiber<void>[] = input.jobs.map((job) =>
    Effect.runFork(makeJobLoop(job, statuses, input.recordRun)),
  );

  return {
    status: () => [...statuses.values()].map(copyStatus),
    stop: () => Effect.runPromise(Fiber.interruptAll(fibers)),
  };
}

// The per-job loop is total: every run is wrapped so neither the job's own
// failure nor a recorder failure can make the loop effect fail, so the fiber
// never dies and Schedule.spaced keeps repeating it forever.
function makeJobLoop(
  job: Job,
  statuses: Map<string, JobStatus>,
  recordRun: JobRunRecorder,
): Effect.Effect<void> {
  const runOnce = Effect.gen(function* runOnce() {
    const startedAt = new Date();
    const exit = yield* Effect.exit(job.run);
    const finishedAt = new Date();

    const failed = Exit.isFailure(exit);
    const error = failed ? describeCause(exit.cause) : null;
    const outcome: JobOutcome = failed ? 'failed' : 'succeeded';

    yield* Effect.sync(() => {
      const current = statuses.get(job.name);
      if (current !== undefined) {
        current.lastRunAt = finishedAt;
        current.lastOutcome = outcome;
        current.consecutiveFailures = failed ? current.consecutiveFailures + 1 : 0;
      }
    });

    if (failed) {
      yield* Effect.sync(() => {
        process.stderr.write(`job "${job.name}" run failed: ${error ?? 'unknown error'}\n`);
      });
    }

    // A failure writing the run record must not kill the fiber; capture the exit
    // so the loop continues, but track the failure so /health can see the ledger
    // is falling behind while the job itself keeps succeeding.
    const recordExit = yield* Effect.exit(
      recordRun({ error, finishedAt, jobName: job.name, outcome, startedAt }),
    );
    yield* Effect.sync(() => {
      const current = statuses.get(job.name);
      if (current === undefined) {
        return;
      }
      if (Exit.isFailure(recordExit)) {
        current.consecutiveRecordFailures += 1;
        process.stderr.write(
          `job "${job.name}" run record failed: ${describeCause(recordExit.cause)}\n`,
        );
      } else {
        current.consecutiveRecordFailures = 0;
      }
    });
  });

  return Effect.repeat(runOnce, Schedule.spaced(job.interval)).pipe(Effect.asVoid);
}

// Hand callers a defensive copy so a status() snapshot can't mutate the live map.
function copyStatus(status: JobStatus): JobStatus {
  return { ...status };
}

function describeCause(cause: Cause.Cause<unknown>): string {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    return describeError(failure.value);
  }
  const death = Cause.dieOption(cause);
  if (Option.isSome(death)) {
    return describeError(death.value);
  }
  if (Cause.isInterruptedOnly(cause)) {
    return 'interrupted';
  }
  return Cause.pretty(cause);
}
