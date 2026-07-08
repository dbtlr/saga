import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { promisify } from 'node:util';

import { getRequestListener } from '@hono/node-server';
import { assertMigrationsCurrent, makeDatabase, recordJobRun } from '@saga/db';
import type { DatabaseService } from '@saga/db';
import type { RuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';

import { createSagaApp } from './app.js';
import type { HealthJobStatus } from './app.js';
import { describeError } from './errors.js';
import { extractionJobFactory } from './jobs/extraction.js';
import { heartbeatJobFactory } from './jobs/heartbeat.js';
import { startJobRunner } from './jobs/job-runner.js';
import type { JobFactory, JobRunnerHandle, JobRunRecorder, JobStatus } from './jobs/job-runner.js';
import { resolveServiceRecallEmbedding } from './recall-embedding.js';
import type { RecallEmbeddingResolver } from './recall-embedding.js';
import { VERSION } from './version.js';

export { describeError as describeReadinessCause } from './errors.js';
export type { HealthJobStatus, HealthPayload } from './app.js';

// Loopback-only bind (ADR-0051): until service auth exists, the service refuses
// to bind anything but a loopback host so an unauthenticated surface can never be
// reachable off-box. Auth arrives in a later phase; this gate lifts with it.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// The API database serves concurrent read handlers, so it needs more than the
// single connection the CLI opens per one-shot command.
const API_DATABASE_POOL_SIZE = 8;

export type SagaServiceHandle = {
  close: () => Promise<void>;
  host: string;
  port: number;
  url: string;
};

export type SagaServiceDependencies = {
  // Injectable API/recorder database connection (integration tests supply their
  // own so a request and a direct db call share one connection). When supplied,
  // the service uses it but does not own its lifecycle and will not close it.
  database?: DatabaseService | undefined;
  // Resolved post-listen, once the shared pool exists, so a job can reach it.
  jobs?: readonly JobFactory[] | undefined;
  recordRun?: JobRunRecorder | undefined;
  // Recall query-embedding resolver (SGA-253). Defaults to the real policy-gated
  // resolver; tests inject a deterministic one to exercise the vector path without
  // remote egress and independent of ambient credentials.
  resolveRecallEmbedding?: RecallEmbeddingResolver | undefined;
  validateDatabase?: ((config: RuntimeConfig) => Promise<void>) | undefined;
};

export async function startSagaService(
  config: RuntimeConfig,
  dependencies: SagaServiceDependencies = {},
): Promise<SagaServiceHandle> {
  assertLoopbackBind(config.service.host);
  await (dependencies.validateDatabase ?? validateDatabaseReady)(config);
  const startedAt = Date.now();

  const jobFactories = dependencies.jobs ?? [heartbeatJobFactory, extractionJobFactory];
  // The database connection and runner fibers are acquired only after the port
  // is bound, so a failed listen can never leak them. Until then /health reports
  // an empty jobs list and /v1 handlers get a clean 503. An injected database is
  // available immediately; a service-owned one is opened post-listen.
  let ownedDatabase: DatabaseService | undefined;
  let apiDatabase: DatabaseService | undefined = dependencies.database;
  let runner: JobRunnerHandle | undefined;

  const app = createSagaApp({
    getDatabase: () => apiDatabase,
    jobStatus: () => (runner === undefined ? [] : runner.status().map(toHealthJobStatus)),
    resolveRecallEmbedding:
      dependencies.resolveRecallEmbedding ?? ((query) => resolveServiceRecallEmbedding(query)),
    startedAt,
    version: VERSION,
  });
  const server = createServer(getRequestListener(app.fetch));

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
    // One long-lived connection backs both the /v1 read handlers and (unless the
    // caller injects its own recorder) the job-run recorder. Only open a
    // service-owned connection when the caller has not supplied one.
    if (apiDatabase === undefined) {
      ownedDatabase = await Effect.runPromise(
        makeDatabase(config, { postgres: { max: API_DATABASE_POOL_SIZE } }),
      );
      apiDatabase = ownedDatabase;
    }
    const database = apiDatabase;
    let recordRun = dependencies.recordRun;
    if (recordRun === undefined) {
      recordRun = (run) => recordJobRun(database, run).pipe(Effect.asVoid);
    }
    // Resolve jobs now that the shared pool exists, handing each factory the
    // same DatabaseService the /v1 handlers use.
    const jobs = jobFactories.map((make) => make({ database }));
    runner = startJobRunner({ jobs, recordRun });
  } catch (cause) {
    if (runner !== undefined) {
      await runner.stop();
    }
    if (ownedDatabase !== undefined) {
      await Effect.runPromise(ownedDatabase.close());
    }
    await close(server);
    throw cause;
  }

  const startedRunner = runner;
  return {
    close: async () => {
      // Every step runs even if an earlier one rejects, so the listening socket
      // is always released; the first error is surfaced after cleanup completes.
      // Order matters: stop the runner first (no job then needs the pool), then
      // drain the HTTP server so in-flight /v1 reads finish against a live pool,
      // and only then close the pool. Closing the pool before draining the server
      // would 500 requests still executing during shutdown.
      const errors: unknown[] = [];
      try {
        // Interrupt job fibers cleanly; they hold the pool the reads still need.
        await startedRunner.stop();
      } catch (cause) {
        errors.push(cause);
      }
      try {
        await close(server);
      } catch (cause) {
        errors.push(cause);
      }
      if (ownedDatabase !== undefined) {
        try {
          await Effect.runPromise(ownedDatabase.close());
        } catch (cause) {
          errors.push(cause);
        }
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

// Containers must bind 0.0.0.0 inside their own network namespace; there the
// exposure boundary is the port publish, not the bind. The deployment asserts
// that responsibility explicitly with this variable. Dies at the auth phase
// (ADR-0051, tracked as SGA-242): once auth exists this escape is deleted and
// non-loopback binds require auth instead.
const UNSAFE_BIND_ENV = 'SAGA_SERVICE_UNSAFE_ALLOW_NONLOOPBACK';

function assertLoopbackBind(host: string, env: NodeJS.ProcessEnv = process.env): void {
  if (LOOPBACK_HOSTS.has(host) || env[UNSAFE_BIND_ENV] === '1') {
    return;
  }
  throw new Error(
    `refusing to bind saga service to non-loopback host ${host}: only 127.0.0.1, ::1, or localhost are permitted until service auth exists (ADR-0051). Set SAGA_SERVICE_HOST to a loopback address, or set ${UNSAFE_BIND_ENV}=1 when the exposure boundary is external (e.g. a container port publish).`,
  );
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
