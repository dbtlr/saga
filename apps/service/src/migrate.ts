import { makeDatabase, runMigrationsSafely } from '@saga/db';
import { loadRuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';

const config = await Effect.runPromise(loadRuntimeConfig());
const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));

try {
  const status = await Effect.runPromise(runMigrationsSafely(service));
  process.stdout.write(
    `Saga database migrations current: ${String(status.applied)}/${String(status.expected)} applied\n`,
  );
} finally {
  await Effect.runPromise(service.close());
}
