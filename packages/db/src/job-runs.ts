import { desc, sql } from 'drizzle-orm';
import { Data, Effect } from 'effect';

import type { DatabaseService } from './database.js';
import { errorMessage } from './error-message.js';
import { jobRuns } from './schema.js';
import type { JobRun } from './schema.js';

// Retain only the most recent runs per job; older rows are pruned in the same
// transaction that records a new run, so growth is bounded without a cleanup job.
export const JOB_RUN_RETENTION = 50;

export type JobRunOutcome = 'succeeded' | 'failed';

export type RecordJobRunInput = {
  error?: string | null | undefined;
  finishedAt: Date;
  jobName: string;
  outcome: JobRunOutcome;
  startedAt: Date;
};

export class JobRunError extends Data.TaggedError('JobRunError')<{
  readonly message: string;
}> {}

export function recordJobRun(
  service: DatabaseService,
  input: RecordJobRunInput,
): Effect.Effect<JobRun, JobRunError> {
  return Effect.tryPromise({
    try: () =>
      service.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(jobRuns)
          .values({
            error: input.error ?? null,
            finishedAt: input.finishedAt,
            jobName: input.jobName,
            outcome: input.outcome,
            startedAt: input.startedAt,
          })
          .returning();
        if (row === undefined) {
          throw new JobRunError({ message: 'job run insert returned no row' });
        }

        // Keep the newest JOB_RUN_RETENTION rows for this job by finished_at,
        // tie-breaking on id so the cut is deterministic when timestamps match.
        await tx.execute(sql`
          delete from job_runs
          where job_name = ${input.jobName}
            and id not in (
              select id
              from job_runs
              where job_name = ${input.jobName}
              order by finished_at desc, id desc
              limit ${JOB_RUN_RETENTION}
            )
        `);

        return row;
      }),
    catch: (cause) =>
      cause instanceof JobRunError ? cause : new JobRunError({ message: errorMessage(cause) }),
  });
}

// Deliberate substrate for a later doctor surface: the newest run per job, one
// row each. selectDistinctOn keeps the first row per job_name under the matching
// order, so lead the ordering with job_name then newest-first.
export function listLatestJobRuns(service: DatabaseService): Effect.Effect<JobRun[], JobRunError> {
  return Effect.tryPromise({
    try: () =>
      service.db
        .selectDistinctOn([jobRuns.jobName])
        .from(jobRuns)
        .orderBy(jobRuns.jobName, desc(jobRuns.finishedAt), desc(jobRuns.id)),
    catch: (cause) => new JobRunError({ message: errorMessage(cause) }),
  });
}
