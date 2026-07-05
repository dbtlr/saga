import type { Duration } from 'effect';
import { Cause, Effect, Exit, Fiber, Option, Schedule } from 'effect';
import type { RuntimeFiber } from 'effect/Fiber';

// A background job: a named unit of work run on a fixed interval. The runner
// forks one supervised fiber per job and drives it with Schedule.spaced, which
// gives sequential, non-overlapping runs by construction.
export type Job = {
  interval: Duration.DurationInput;
  name: string;
  run: Effect.Effect<void, unknown>;
};

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
    statuses.set(job.name, {
      consecutiveFailures: 0,
      lastOutcome: null,
      lastRunAt: null,
      name: job.name,
    });
  }

  const fibers: RuntimeFiber<void>[] = input.jobs.map((job) =>
    Effect.runFork(makeJobLoop(job, statuses, input.recordRun)),
  );

  return {
    status: () =>
      input.jobs.map((job) => {
        const current = statuses.get(job.name);
        return current === undefined
          ? { consecutiveFailures: 0, lastOutcome: null, lastRunAt: null, name: job.name }
          : { ...current };
      }),
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

    yield* recordRun({ error, finishedAt, jobName: job.name, outcome, startedAt }).pipe(
      // A failure writing the run record must not kill the fiber: log and continue.
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          process.stderr.write(`job "${job.name}" run record failed: ${describeCause(cause)}\n`);
        }),
      ),
    );
  });

  return Effect.repeat(runOnce, Schedule.spaced(job.interval)).pipe(Effect.asVoid);
}

function describeCause(cause: Cause.Cause<unknown>): string {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    return describeValue(failure.value);
  }
  const death = Cause.dieOption(cause);
  if (Option.isSome(death)) {
    return describeValue(death.value);
  }
  if (Cause.isInterruptedOnly(cause)) {
    return 'interrupted';
  }
  return Cause.pretty(cause);
}

function describeValue(value: unknown): string {
  if (value instanceof Error) {
    return value.message === '' ? value.name : value.message;
  }
  return String(value);
}
