import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { promisify } from 'node:util';

import { assertMigrationsCurrent, makeDatabase } from '@saga/db';
import type { RuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';

export type SagaServiceHandle = {
  close: () => Promise<void>;
  host: string;
  port: number;
  url: string;
};

export type HealthPayload = {
  ok: true;
  service: 'saga';
  uptimeSeconds: number;
};

export type SagaServiceDependencies = {
  validateDatabase?: ((config: RuntimeConfig) => Promise<void>) | undefined;
};

export async function startSagaService(
  config: RuntimeConfig,
  dependencies: SagaServiceDependencies = {},
): Promise<SagaServiceHandle> {
  await (dependencies.validateDatabase ?? validateDatabaseReady)(config);
  const startedAt = Date.now();
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      const payload: HealthPayload = {
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
    close: () => close(server),
    host,
    port,
    url: `http://${host}:${port}`,
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
