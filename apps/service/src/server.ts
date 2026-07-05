import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { promisify } from 'node:util';

import { assertMigrationsCurrent, makeDatabase, recordJobRun } from '@saga/db';
import type { DatabaseService } from '@saga/db';
import type { RuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';

import { heartbeatJob } from './jobs/heartbeat.js';
import { startJobRunner } from './jobs/job-runner.js';
import type { Job, JobRunRecorder, JobStatus } from './jobs/job-runner.js';

export type SagaServiceHandle = {
  close: () => Promise<void>;
  host: string;
  port: number;
  url: string;
};

export type HealthJobStatus = {
  consecutiveFailures: number;
  lastOutcome: JobStatus['lastOutcome'];
  lastRunAt: string | null;
  name: string;
};

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
  // A DB-backed recorder needs a long-lived connection; only open one when the
  // caller has not supplied its own recorder (tests inject an in-memory one).
  let jobDatabase: DatabaseService | undefined;
  let recordRun = dependencies.recordRun;
  if (recordRun === undefined) {
    jobDatabase = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
    const service = jobDatabase;
    recordRun = (run) => recordJobRun(service, run).pipe(Effect.asVoid);
  }
  const runner = startJobRunner({ jobs, recordRun });

  const server = createServer((request, response) => {
    if (request.url === '/health') {
      const payload: HealthPayload = {
        jobs: runner.status().map(toHealthJobStatus),
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
    throw new Error('expected the service to be listening on a TCP address');
  }
  const host = address.address;
  const port = address.port;

  return {
    close: async () => {
      // Interrupt job fibers cleanly before releasing their connection and the port.
      await runner.stop();
      if (jobDatabase !== undefined) {
        await Effect.runPromise(jobDatabase.close());
      }
      await close(server);
    },
    host,
    port,
    url: `http://${host}:${port}`,
  };
}

function toHealthJobStatus(status: JobStatus): HealthJobStatus {
  return {
    consecutiveFailures: status.consecutiveFailures,
    lastOutcome: status.lastOutcome,
    lastRunAt: status.lastRunAt === null ? null : status.lastRunAt.toISOString(),
    name: status.name,
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
    throw new Error(`saga database is not ready: ${describeReadinessCause(cause)}`, { cause });
  } finally {
    await Effect.runPromise(service.close());
  }
}

// postgres.js reports connection refusal as an AggregateError with an empty
// message; unwrap it so the startup log names the unreachable target.
export function describeReadinessCause(cause: unknown): string {
  if (cause instanceof AggregateError && cause.errors.length > 0) {
    return cause.errors.map((error) => describeReadinessCause(error)).join('; ');
  }
  if (cause instanceof Error) {
    return cause.message === '' ? cause.name : cause.message;
  }
  return String(cause);
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
