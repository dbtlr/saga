import { RuntimeConfigLive } from '@saga/runtime';
import { Effect, Exit } from 'effect';
import { assert, describe, expect, test } from 'vitest';

import {
  assertMigrationsCurrent,
  DatabaseLive,
  DatabaseTag,
  DEFAULT_MIGRATIONS_FOLDER,
  EXPECTED_MIGRATION_COUNT,
  getMigrationStatus,
  makeDatabase,
  readExpectedMigrationHashes,
  runMigrationsSafely,
} from './database.js';
import type { DatabaseService } from './database.js';

const expectedHashes = readExpectedMigrationHashes(DEFAULT_MIGRATIONS_FOLDER).map(
  (migration) => migration.hash,
);

function serviceWithMigrationCount(
  count: number,
  options: { tableExists?: boolean; wrongHashAt?: number } = {},
): DatabaseService {
  const tableExists = options.tableExists ?? true;
  return {
    close: () => Effect.void,
    db: undefined as never,
    sql: {
      unsafe: async (query: string) => {
        if (query.includes('to_regclass')) {
          return [{ table_name: tableExists ? 'drizzle.__drizzle_migrations' : null }];
        }

        return Array.from({ length: count }, (_, index) => {
          if (options.wrongHashAt === index) {
            return { hash: 'wrong-hash' };
          }
          return {
            hash:
              index < expectedHashes.length ? expectedHashes[index] : `newer-hash-${String(index)}`,
          };
        });
      },
    } as never,
  };
}

describe('makeDatabase', () => {
  test('requires DATABASE_URL', async () => {
    const result = await Effect.runPromiseExit(
      makeDatabase({
        databaseUrl: undefined,
        environment: 'test',
        logLevel: 'info',
        service: {
          host: '127.0.0.1',
          port: 4766,
        },
        secrets: {
          openaiApiKey: undefined,
        },
      }),
    );

    assert(Exit.isFailure(result));
    expect(result.cause.toString()).toContain('DATABASE_URL is required');
  });
});

describe('databaseLive', () => {
  test('provides a closeable database service from runtime config', async () => {
    const program = Effect.gen(function* program() {
      const database = yield* DatabaseTag;
      expect(database.db).toBeDefined();
      expect(database.sql).toBeDefined();
    }).pipe(
      Effect.provide(DatabaseLive()),
      Effect.provide(
        RuntimeConfigLive({
          env: { DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/saga_test' },
          envFiles: [],
        }),
      ),
    );

    await expect(Effect.runPromise(program)).resolves.toBeUndefined();
  });
});

describe('assertMigrationsCurrent', () => {
  test('fails when fewer than the expected migrations are applied', async () => {
    await expect(
      Effect.runPromise(
        assertMigrationsCurrent(serviceWithMigrationCount(EXPECTED_MIGRATION_COUNT - 1)),
      ),
    ).rejects.toMatchObject({
      message: `database migrations are not current: ${String(EXPECTED_MIGRATION_COUNT - 1)} applied; expected ${String(EXPECTED_MIGRATION_COUNT)}. Apply migrations before starting Saga.`,
    });
  });

  test('returns migration status when migrations are current', async () => {
    await expect(
      Effect.runPromise(
        assertMigrationsCurrent(serviceWithMigrationCount(EXPECTED_MIGRATION_COUNT)),
      ),
    ).resolves.toStrictEqual({
      applied: EXPECTED_MIGRATION_COUNT,
      compatible: true,
      expected: EXPECTED_MIGRATION_COUNT,
      mismatch: undefined,
    });
  });

  test('fails when an applied migration hash differs from this build', async () => {
    await expect(
      Effect.runPromise(
        assertMigrationsCurrent(
          serviceWithMigrationCount(EXPECTED_MIGRATION_COUNT, { wrongHashAt: 1 }),
        ),
      ),
    ).rejects.toMatchObject({
      message:
        'database migration 1 (0001_graceful_sebastian_shaw) does not match this Saga build. Restore a compatible backup or run a matching Saga build before continuing.',
    });
  });

  test('fails when the database has newer migrations than this build expects', async () => {
    await expect(
      Effect.runPromise(
        assertMigrationsCurrent(serviceWithMigrationCount(EXPECTED_MIGRATION_COUNT + 1)),
      ),
    ).rejects.toMatchObject({
      message: `database has newer migrations than this Saga build understands: ${String(EXPECTED_MIGRATION_COUNT + 1)} applied; expected ${String(EXPECTED_MIGRATION_COUNT)}. Upgrade Saga or restore a compatible backup before continuing.`,
    });
  });
});

describe('getMigrationStatus', () => {
  test('reports zero applied migrations when the drizzle table is missing', async () => {
    await expect(
      Effect.runPromise(getMigrationStatus(serviceWithMigrationCount(99, { tableExists: false }))),
    ).resolves.toStrictEqual({
      applied: 0,
      compatible: true,
      expected: EXPECTED_MIGRATION_COUNT,
    });
  });
});

describe('runMigrationsSafely', () => {
  test('skips migration execution when migrations are already current', async () => {
    await expect(
      Effect.runPromise(runMigrationsSafely(serviceWithMigrationCount(EXPECTED_MIGRATION_COUNT))),
    ).resolves.toStrictEqual({
      applied: EXPECTED_MIGRATION_COUNT,
      compatible: true,
      expected: EXPECTED_MIGRATION_COUNT,
      mismatch: undefined,
    });
  });
});
