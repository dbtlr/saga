import { readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Duration, Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { describeReadinessCause, startSagaService, validateDatabaseReady } from './server.js';

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('startSagaService', () => {
  it('serves health', async () => {
    const service = await startSagaService(
      {
        databaseUrl: 'postgres://test/saga',
        databaseUrlSource: 'environment',
        environment: 'test',
        logLevel: 'info',
        service: {
          host: '127.0.0.1',
          port: 0,
        },
        secrets: {
          openaiApiKey: undefined,
        },
      },
      {
        recordRun: () => Effect.void,
        validateDatabase: async () => undefined,
      },
    );

    try {
      const response = await fetch(`${service.url}/health`);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        service: 'saga',
      });
    } finally {
      await service.close();
    }
  });

  it('reports the job runner status on /health after a tick', async () => {
    const service = await startSagaService(
      {
        databaseUrl: 'postgres://test/saga',
        databaseUrlSource: 'environment',
        environment: 'test',
        logLevel: 'info',
        service: {
          host: '127.0.0.1',
          port: 0,
        },
        secrets: {
          openaiApiKey: undefined,
        },
      },
      {
        jobs: [{ interval: Duration.millis(5), name: 'heartbeat', run: Effect.void }],
        recordRun: () => Effect.void,
        validateDatabase: async () => undefined,
      },
    );

    try {
      const deadline = Date.now() + 2000;
      let jobs: unknown[] = [];
      // Poll /health until the heartbeat has ticked at least once.
      while (Date.now() < deadline) {
        const response = await fetch(`${service.url}/health`);
        const payload = (await response.json()) as {
          jobs: { lastOutcome: string | null; name: string }[];
        };
        jobs = payload.jobs;
        if (payload.jobs.some((job) => job.name === 'heartbeat' && job.lastOutcome !== null)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(jobs).toContainEqual(
        expect.objectContaining({
          consecutiveFailures: 0,
          lastOutcome: 'succeeded',
          name: 'heartbeat',
        }),
      );
    } finally {
      await service.close();
    }
  });

  it('starts no job fibers when the port is already taken', async () => {
    // Occupy an ephemeral port so listen() rejects with EADDRINUSE.
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as AddressInfo).port;

    let recordCalls = 0;
    const recordRun = () =>
      Effect.sync(() => {
        recordCalls += 1;
      });

    try {
      await expect(
        startSagaService(
          {
            databaseUrl: 'postgres://test/saga',
            databaseUrlSource: 'environment',
            environment: 'test',
            logLevel: 'info',
            service: { host: '127.0.0.1', port: taken },
            secrets: { openaiApiKey: undefined },
          },
          {
            jobs: [{ interval: Duration.millis(1), name: 'counter', run: Effect.void }],
            recordRun,
            validateDatabase: async () => undefined,
          },
        ),
      ).rejects.toThrow(/EADDRINUSE/);

      // A millisecond-interval job would have recorded many times by now had any
      // fiber been forked; a failed bind must never start the runner.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(recordCalls).toBe(0);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('fails startup when database config is missing', async () => {
    await expect(
      startSagaService({
        databaseUrl: undefined,
        databaseUrlSource: 'missing',
        environment: 'test',
        logLevel: 'info',
        service: {
          host: '127.0.0.1',
          port: 0,
        },
        secrets: {
          openaiApiKey: undefined,
        },
      }),
    ).rejects.toThrow('DATABASE_URL is required');
  });
});

describe('validateDatabaseReady', () => {
  it('fails readiness with an actionable error when the database is unreachable', async () => {
    await expect(
      validateDatabaseReady({
        databaseUrl: 'postgres://127.0.0.1:9/saga',
        databaseUrlSource: 'environment',
        environment: 'test',
        logLevel: 'info',
        service: {
          host: '127.0.0.1',
          port: 0,
        },
        secrets: {
          openaiApiKey: undefined,
        },
      }),
    ).rejects.toThrow(/database is not ready: .*ECONNREFUSED/);
  }, 15_000);
});

describe('describeReadinessCause', () => {
  it('unwraps the empty-message AggregateError postgres.js throws on refusal', () => {
    const refused = new AggregateError(
      [
        new Error('connect ECONNREFUSED ::1:55433'),
        new Error('connect ECONNREFUSED 127.0.0.1:55433'),
      ],
      // oxlint-disable-next-line unicorn/error-message -- replicates postgres.js's empty-message refusal error
      '',
    );

    expect(describeReadinessCause(refused)).toBe(
      'connect ECONNREFUSED ::1:55433; connect ECONNREFUSED 127.0.0.1:55433',
    );
  });

  it('falls back to the error name when the message is empty', () => {
    // oxlint-disable-next-line unicorn/error-message -- the empty message is the case under test
    expect(describeReadinessCause(new Error(''))).toBe('Error');
  });

  it('stringifies non-error causes', () => {
    expect(describeReadinessCause('boom')).toBe('boom');
  });
});

describe('service entrypoint', () => {
  it('loads runtime config and starts the foreground service', () => {
    const entrypoint = readFileSync(fileURLToPath(new URL('main.ts', import.meta.url)), 'utf8');

    expect(entrypoint).toContain('loadRuntimeConfig');
    expect(entrypoint).toContain('startSagaService');
    expect(entrypoint).toContain('SIGTERM');
  });

  it('exposes an explicit migration entrypoint', () => {
    const entrypoint = readFileSync(fileURLToPath(new URL('migrate.ts', import.meta.url)), 'utf8');

    expect(entrypoint).toContain('loadRuntimeConfig');
    expect(entrypoint).toContain('runMigrationsSafely');
    expect(entrypoint).toContain('Saga database migrations current');
  });
});

describe('deploy targets', () => {
  it('systemd target runs the service package entrypoint', () => {
    const unit = readFileSync(join(workspaceRoot, 'deploy', 'systemd', 'saga.service'), 'utf8');

    expect(unit).toContain('EnvironmentFile=/etc/saga/saga.env');
    expect(unit).not.toContain('ExecStartPre');
    expect(unit).toContain('bun run --cwd /opt/saga --filter @saga/service start');
  });

  it('systemd docs make migrations an explicit deploy step', () => {
    const docs = readFileSync(join(workspaceRoot, 'docs', 'deployable-service.md'), 'utf8');

    expect(docs).toContain('Run migrations explicitly before first start');
    expect(docs).toContain('sudo -u saga bun run --cwd /opt/saga --filter @saga/service migrate');
  });

  it('hosted target documents file-backed secrets', () => {
    const env = readFileSync(
      join(workspaceRoot, 'deploy', 'hosted', 'service.env.example'),
      'utf8',
    );

    expect(env).toContain('DATABASE_URL_FILE=/run/secrets/saga_database_url');
    expect(env).toContain('SAGA_SERVICE_HOST=0.0.0.0');
  });
});
