import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RuntimeConfigTag } from '@saga/runtime';
import type { RuntimeConfig } from '@saga/runtime';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { Context, Data, Effect, Layer } from 'effect';
import postgres from 'postgres';
import type { Options, PostgresType, Sql } from 'postgres';

import { schema } from './schema.js';
import type { SagaSchema } from './schema.js';

export type SagaDatabase = PostgresJsDatabase<SagaSchema>;
export type SagaSql = Sql<Record<string, PostgresType>>;

export type DatabaseService = {
  db: SagaDatabase;
  sql: SagaSql;
  close: () => Effect.Effect<void, DatabaseError>;
};

export type MigrationStatus = {
  applied: number;
  compatible: boolean;
  expected: number;
  mismatch?:
    | {
        appliedHash: string;
        expectedHash: string;
        index: number;
        tag: string;
      }
    | undefined;
};

export class DatabaseError extends Data.TaggedError('DatabaseError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const DatabaseTag = Context.GenericTag<DatabaseService>('@saga/db/Database');

export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));
export const EXPECTED_MIGRATION_COUNT =
  readExpectedMigrationHashes(DEFAULT_MIGRATIONS_FOLDER).length;

export type MakeDatabaseOptions = {
  postgres?: Options<Record<string, PostgresType>>;
};

export function makeDatabase(
  config: RuntimeConfig,
  options: MakeDatabaseOptions = {},
): Effect.Effect<DatabaseService, DatabaseError> {
  return Effect.try({
    try: () => {
      if (config.databaseUrl === undefined) {
        throw new DatabaseError({ message: 'DATABASE_URL is required' });
      }

      const sql = postgres(config.databaseUrl, options.postgres);
      return makeDatabaseService(sql);
    },
    catch: (cause) =>
      cause instanceof DatabaseError
        ? cause
        : new DatabaseError({ message: 'failed to create database client', cause }),
  });
}

export function DatabaseLive(
  options: MakeDatabaseOptions = {},
): Layer.Layer<DatabaseService, DatabaseError, RuntimeConfig> {
  return Layer.scoped(
    DatabaseTag,
    // oxlint-disable-next-line func-names -- Effect.gen takes an anonymous generator
    Effect.gen(function* () {
      const config = yield* RuntimeConfigTag;
      const service = yield* makeDatabase(config, options);
      yield* Effect.addFinalizer(() => service.close().pipe(Effect.catchAll(() => Effect.void)));
      return service;
    }),
  );
}

export function runMigrations(
  service: DatabaseService,
  migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
): Effect.Effect<void, DatabaseError> {
  return Effect.tryPromise({
    try: () => migrate(service.db, { migrationsFolder }),
    catch: (cause) =>
      new DatabaseError({
        message: `failed to run database migrations: ${errorMessage(cause)}`,
        cause,
      }),
  });
}

export function runMigrationsSafely(
  service: DatabaseService,
  migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
): Effect.Effect<MigrationStatus, DatabaseError> {
  return getMigrationStatus(service, migrationsFolder).pipe(
    Effect.flatMap((status) => {
      if (status.applied > status.expected) {
        return Effect.fail(newerMigrationError(status));
      }
      if (!status.compatible) {
        return Effect.fail(incompatibleMigrationError(status));
      }
      if (status.applied === status.expected) {
        return Effect.succeed(status);
      }
      return runMigrations(service, migrationsFolder).pipe(
        Effect.flatMap(() => getMigrationStatus(service, migrationsFolder)),
      );
    }),
  );
}

export function getMigrationStatus(
  service: DatabaseService,
  migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
): Effect.Effect<MigrationStatus, DatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      const expectedMigrations = readExpectedMigrationHashes(migrationsFolder);
      const table = await service.sql.unsafe(
        "select to_regclass('drizzle.__drizzle_migrations')::text as table_name",
      );
      if (table[0]?.table_name === null || table[0]?.table_name === undefined) {
        return {
          applied: 0,
          compatible: true,
          expected: expectedMigrations.length,
        };
      }

      const migrations = await service.sql.unsafe(
        'select hash from drizzle.__drizzle_migrations order by created_at asc, id asc',
      );
      const appliedHashes = migrations.flatMap((row) =>
        typeof row.hash === 'string' ? [row.hash] : [],
      );
      const mismatchIndex = appliedHashes.findIndex((hash, index) => {
        const expected = expectedMigrations[index];
        return expected !== undefined && hash !== expected.hash;
      });
      const mismatch =
        mismatchIndex === -1 || expectedMigrations[mismatchIndex] === undefined
          ? undefined
          : {
              appliedHash: appliedHashes[mismatchIndex] ?? '',
              expectedHash: expectedMigrations[mismatchIndex].hash,
              index: mismatchIndex,
              tag: expectedMigrations[mismatchIndex].tag,
            };
      return {
        applied: appliedHashes.length,
        compatible: mismatch === undefined && appliedHashes.length <= expectedMigrations.length,
        expected: expectedMigrations.length,
        mismatch,
      };
    },
    catch: (cause) =>
      new DatabaseError({
        message: `failed to inspect database migrations: ${errorMessage(cause)}`,
        cause,
      }),
  });
}

export function assertMigrationsCurrent(
  service: DatabaseService,
  migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
): Effect.Effect<MigrationStatus, DatabaseError> {
  return getMigrationStatus(service, migrationsFolder).pipe(
    Effect.flatMap((status) =>
      status.applied > status.expected
        ? Effect.fail(newerMigrationError(status))
        : !status.compatible
          ? Effect.fail(incompatibleMigrationError(status))
          : status.applied < status.expected
            ? Effect.fail(
                new DatabaseError({
                  message: `database migrations are not current: ${String(status.applied)} applied; expected ${String(status.expected)}. Apply migrations before starting Saga.`,
                }),
              )
            : Effect.succeed(status),
    ),
  );
}

function newerMigrationError(status: MigrationStatus): DatabaseError {
  return new DatabaseError({
    message: `database has newer migrations than this Saga build understands: ${String(status.applied)} applied; expected ${String(status.expected)}. Upgrade Saga or restore a compatible backup before continuing.`,
  });
}

function incompatibleMigrationError(status: MigrationStatus): DatabaseError {
  const mismatch = status.mismatch;
  return new DatabaseError({
    message:
      mismatch === undefined
        ? 'database migrations do not match this Saga build. Restore a compatible backup or run a matching Saga build before continuing.'
        : `database migration ${String(mismatch.index)} (${mismatch.tag}) does not match this Saga build. Restore a compatible backup or run a matching Saga build before continuing.`,
  });
}

export function readExpectedMigrationHashes(
  migrationsFolder: string,
): { hash: string; tag: string }[] {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'));
  if (!isMigrationJournal(journal)) {
    throw new Error(`invalid Drizzle migration journal: ${migrationsFolder}`);
  }

  return journal.entries.map((entry) => {
    const sql = readFileSync(join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
    return {
      hash: createHash('sha256').update(sql).digest('hex'),
      tag: entry.tag,
    };
  });
}

function isMigrationJournal(value: unknown): value is { entries: { tag: string }[] } {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { entries?: unknown }).entries) &&
    (value as { entries: unknown[] }).entries.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as { tag?: unknown }).tag === 'string',
    )
  );
}

function makeDatabaseService(sql: SagaSql): DatabaseService {
  return {
    db: drizzle(sql, { schema }),
    sql,
    close: () =>
      Effect.tryPromise({
        try: async () => {
          await sql.end({ timeout: 5 });
        },
        catch: (cause) => new DatabaseError({ message: 'failed to close database client', cause }),
      }),
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
