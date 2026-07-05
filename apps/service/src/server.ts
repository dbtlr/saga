import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { promisify } from 'node:util';

import { assertMigrationsCurrent, makeDatabase, recordJobRun } from '@saga/db';
import type { DatabaseService } from '@saga/db';
import type { RuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';

import { describeError } from './errors.js';
import { heartbeatJob } from './jobs/heartbeat.js';
import { startJobRunner } from './jobs/job-runner.js';
import type { Job, JobRunnerHandle, JobRunRecorder, JobStatus } from './jobs/job-runner.js';

export { describeError as describeReadinessCause } from './errors.js';

export type SagaServiceHandle = {
  close: () => Promise<void>;
  host: string;
  port: number;
  url: string;
};

export type HealthJobStatus = Omit<JobStatus, 'lastRunAt'> & { lastRunAt: string | null };

export type HealthPayload = {
  jobs: HealthJobStatus[];
  ok: true;
  service: 'saga';
  uptimeSeconds: number;
};

export type SagaServiceDependencies = {
  jobs?: readonly Job[] | undefined;
  recordRun?: JobRunRecorder | undefined;
  validateDatabase?: ((config: RuntimeConfig) => Promise<void>) | undefined;
};

export async function startSagaService(
  config: RuntimeConfig,
  dependencies: SagaServiceDependencies = {},
): Promise<SagaServiceHandle> {
  await (dependencies.validateDatabase ?? validateDatabaseReady)(config);
  const startedAt = Date.now();

  const jobs = dependencies.jobs ?? [heartbeatJob];
  // The job database connection and runner fibers are acquired only after the
  // port is bound, so a failed listen can never leak them. Until then /health
  // reports an empty jobs list.
  let jobDatabase: DatabaseService | undefined;
  let runner: JobRunnerHandle | undefined;

  const server = createServer((request, response) => {
    if (request.url === '/health') {
      const payload: HealthPayload = {
        jobs: runner === undefined ? [] : runner.status().map(toHealthJobStatus),
        ok: true,
        service: 'saga',
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });

  await listen(server, config.service.port, config.service.host);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await close(server);
    throw new Error('expected the service to be listening on a TCP address');
  }
  const host = address.address;
  const port = address.port;

  // Post-listen acquisition: on any failure, release whatever was acquired and
  // the bound port before rethrowing so startup never leaks resources.
  try {
    // A DB-backed recorder needs a long-lived connection; only open one when the
    // caller has not supplied its own recorder (tests inject an in-memory one).
    let recordRun = dependencies.recordRun;
    if (recordRun === undefined) {
      jobDatabase = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
      const service = jobDatabase;
      recordRun = (run) => recordJobRun(service, run).pipe(Effect.asVoid);
    }
    runner = startJobRunner({ jobs, recordRun });
  } catch (cause) {
    if (runner !== undefined) {
      await runner.stop();
    }
    if (jobDatabase !== undefined) {
      await Effect.runPromise(jobDatabase.close());
    }
    await close(server);
    throw cause;
  }

  const startedRunner = runner;
  return {
    close: async () => {
      // Every step runs even if an earlier one rejects, so the listening socket
      // is always released; the first error is surfaced after cleanup completes.
      const errors: unknown[] = [];
      try {
        // Interrupt job fibers cleanly before releasing their connection.
        await startedRunner.stop();
      } catch (cause) {
        errors.push(cause);
      }
      if (jobDatabase !== undefined) {
        try {
          await Effect.runPromise(jobDatabase.close());
        } catch (cause) {
          errors.push(cause);
        }
      }
      try {
        await close(server);
      } catch (cause) {
        errors.push(cause);
      }
      if (errors.length > 0) {
        throw errors[0];
      }
    },
    host,
    port,
    url: `http://${host}:${port}`,
  };
}

function toHealthJobStatus(status: JobStatus): HealthJobStatus {
  return {
    ...status,
    lastRunAt: status.lastRunAt === null ? null : status.lastRunAt.toISOString(),
  };
}

// Bounded so a wrong or filtered database target fails startup with a clear
// error instead of hanging on postgres.js's 30s default before binding the port.
const DATABASE_READY_CONNECT_TIMEOUT_SECONDS = 5;

export async function validateDatabaseReady(config: RuntimeConfig): Promise<void> {
  const service = await Effect.runPromise(
    makeDatabase(config, {
      postgres: { connect_timeout: DATABASE_READY_CONNECT_TIMEOUT_SECONDS, max: 1 },
    }),
  );
  try {
    await service.sql`select 1`;
    await Effect.runPromise(assertMigrationsCurrent(service));
  } catch (cause) {
    throw new Error(`saga database is not ready: ${describeError(cause)}`, { cause });
  } finally {
    await Effect.runPromise(service.close());
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function close(server: Server): Promise<void> {
  await promisify(server.close.bind(server))();
}
