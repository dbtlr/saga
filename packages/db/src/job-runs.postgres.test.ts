import { Effect } from 'effect';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { makeDatabase, runMigrations } from './database.js';
import type { DatabaseService } from './database.js';
import { JOB_RUN_RETENTION, listLatestJobRuns, recordJobRun } from './job-runs.js';
import { jobRuns } from './schema.js';

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL ?? process.env.SAGA_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres('job_runs persistence', () => {
  const databaseName = `saga_test_jobs_${Date.now().toString(36)}`;
  const adminSql = postgres(databaseUrl ?? '', { max: 1 });
  let service: DatabaseService | undefined;

  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    const testDatabaseUrl = new URL(databaseUrl ?? '');
    testDatabaseUrl.pathname = `/${databaseName}`;

    service = await Effect.runPromise(
      makeDatabase(
        {
          databaseUrl: testDatabaseUrl.toString(),
          databaseUrlSource: 'environment',
          environment: 'test',
          logLevel: 'info',
          service: { host: '127.0.0.1', port: 4766 },
          secrets: { openaiApiKey: undefined },
        },
        { postgres: { max: 1 } },
      ),
    );
    await Effect.runPromise(runMigrations(service));
  });

  afterAll(async () => {
    if (service !== undefined) {
      await Effect.runPromise(service.close());
    }
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 5 });
  });

  test('records a completed run and reads it back as the latest for the job', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }

    const startedAt = new Date('2026-07-04T00:00:00.000Z');
    const finishedAt = new Date('2026-07-04T00:00:01.000Z');
    const recorded = await Effect.runPromise(
      recordJobRun(service, {
        finishedAt,
        jobName: 'reads-back',
        outcome: 'succeeded',
        startedAt,
      }),
    );

    expect(recorded.jobName).toBe('reads-back');
    expect(recorded.outcome).toBe('succeeded');
    expect(recorded.error).toBeNull();

    const latest = await Effect.runPromise(listLatestJobRuns(service));
    const forJob = latest.find((run) => run.jobName === 'reads-back');
    expect(forJob?.id).toBe(recorded.id);
    expect(forJob?.finishedAt.toISOString()).toBe(finishedAt.toISOString());
  });

  test('stores a failed outcome with its error message', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }

    const recorded = await Effect.runPromise(
      recordJobRun(service, {
        error: 'boom',
        finishedAt: new Date('2026-07-04T01:00:01.000Z'),
        jobName: 'records-failure',
        outcome: 'failed',
        startedAt: new Date('2026-07-04T01:00:00.000Z'),
      }),
    );

    expect(recorded.outcome).toBe('failed');
    expect(recorded.error).toBe('boom');
  });

  test('returns one latest row per job', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }

    for (let index = 0; index < 3; index += 1) {
      await Effect.runPromise(
        recordJobRun(service, {
          finishedAt: new Date(Date.UTC(2026, 6, 4, 2, 0, index)),
          jobName: 'multi-run-a',
          outcome: 'succeeded',
          startedAt: new Date(Date.UTC(2026, 6, 4, 2, 0, index)),
        }),
      );
    }
    const latestB = await Effect.runPromise(
      recordJobRun(service, {
        finishedAt: new Date(Date.UTC(2026, 6, 4, 3, 0, 5)),
        jobName: 'multi-run-b',
        outcome: 'failed',
        startedAt: new Date(Date.UTC(2026, 6, 4, 3, 0, 5)),
      }),
    );

    const latest = await Effect.runPromise(listLatestJobRuns(service));
    const a = latest.filter((run) => run.jobName === 'multi-run-a');
    const b = latest.filter((run) => run.jobName === 'multi-run-b');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.finishedAt.toISOString()).toBe(
      new Date(Date.UTC(2026, 6, 4, 2, 0, 2)).toISOString(),
    );
    expect(b[0]?.id).toBe(latestB.id);
  });

  test('prunes rows beyond the retention cap, keeping the most recent', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }

    const total = JOB_RUN_RETENTION + 5;
    for (let index = 0; index < total; index += 1) {
      await Effect.runPromise(
        recordJobRun(service, {
          finishedAt: new Date(Date.UTC(2026, 6, 4, 10, 0, index)),
          jobName: 'pruned',
          outcome: 'succeeded',
          startedAt: new Date(Date.UTC(2026, 6, 4, 10, 0, index)),
        }),
      );
    }

    const rows = await service.sql<{ finished_at: Date | string }[]>`
      select finished_at from job_runs where job_name = 'pruned' order by finished_at asc
    `;
    expect(rows).toHaveLength(JOB_RUN_RETENTION);
    // The oldest surviving row is index (total - retention); everything before pruned.
    expect(new Date(rows[0]?.finished_at ?? 0).toISOString()).toBe(
      new Date(Date.UTC(2026, 6, 4, 10, 0, total - JOB_RUN_RETENTION)).toISOString(),
    );
    expect(new Date(rows.at(-1)?.finished_at ?? 0).toISOString()).toBe(
      new Date(Date.UTC(2026, 6, 4, 10, 0, total - 1)).toISOString(),
    );

    // Pruning is scoped to the job: other jobs are untouched.
    const others = await service.db.select().from(jobRuns);
    expect(others.some((run) => run.jobName === 'multi-run-a')).toBe(true);
  });
});
