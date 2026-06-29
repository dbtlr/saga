import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { assertMigrationsCurrent, makeDatabase } from '@saga/db';
import type { RuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';

export interface SagaServiceHandle {
  close: () => Promise<void>;
  host: string;
  port: number;
  url: string;
}

export interface HealthPayload {
  ok: true;
  service: 'saga';
  uptimeSeconds: number;
}

export interface SagaServiceDependencies {
  validateDatabase?: ((config: RuntimeConfig) => Promise<void>) | undefined;
}

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
  const address = server.address() as AddressInfo;
  const host = address.address;
  const port = address.port;

  return {
    close: () => close(server),
    host,
    port,
    url: `http://${host}:${port}`,
  };
}

export async function validateDatabaseReady(config: RuntimeConfig): Promise<void> {
  const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
  try {
    await service.sql`select 1`;
    await Effect.runPromise(assertMigrationsCurrent(service));
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

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}
