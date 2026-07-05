import { sql } from 'drizzle-orm';
import { Data, Effect } from 'effect';

import type { DatabaseError, DatabaseService } from './database.js';
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
): Effect.Effect<JobRun, DatabaseError | JobRunError> {
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

export function listLatestJobRuns(service: DatabaseService): Effect.Effect<JobRun[], JobRunError> {
  return Effect.tryPromise({
    try: async () => {
      const rows = await service.sql<JobRunRow[]>`
        select distinct on (job_name)
          id,
          job_name,
          started_at,
          finished_at,
          outcome,
          error
        from job_runs
        order by job_name, finished_at desc, id desc
      `;
      return rows.map(mapJobRunRow);
    },
    catch: (cause) => new JobRunError({ message: errorMessage(cause) }),
  });
}

type JobRunRow = {
  error: string | null;
  finished_at: Date | string;
  id: string;
  job_name: string;
  outcome: string;
  started_at: Date | string;
};

// postgres.js hands raw timestamptz columns back as strings; the JobRun contract
// (Drizzle's $inferSelect) is Date, so coerce here to keep the boundary honest.
function mapJobRunRow(row: JobRunRow): JobRun {
  return {
    error: row.error,
    finishedAt: new Date(row.finished_at),
    id: row.id,
    jobName: row.job_name,
    outcome: row.outcome,
    startedAt: new Date(row.started_at),
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
