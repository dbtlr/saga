import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATABASE_URL_ENV, RuntimeConfigTag } from '@saga/runtime';
import type { RuntimeConfig } from '@saga/runtime';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { Context, Data, Effect, Layer } from 'effect';
import postgres from 'postgres';
import type { Options, PostgresType, Sql } from 'postgres';

import { embeddedJournal, embeddedSql } from './embedded-migrations.js';
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

// In a from-source (Node/tsx) run the migrations live next to this module on
// disk and DEFAULT_MIGRATIONS_FOLDER points at them. In a compiled
// single-binary (bun --compile) run there is no repo tree: expected migration
// hashes are derived directly from the literals in `embedded-migrations.ts`
// (the filesystem is never consulted, so nothing on disk can be preseeded or
// trusted), and `runMigrations` materializes the literals into a fresh private
// per-process temp dir only for the duration of drizzle's folder-based
// `migrate()`. A drift-lock unit test keeps the literals byte-identical to
// packages/db/drizzle. Importing this module performs no filesystem writes.
export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

export function expectedMigrationHashes(): { hash: string; tag: string }[] {
  return embeddedJournal.entries.map((entry) => {
    const sql = embeddedSql[entry.tag];
    if (sql === undefined) {
      throw new Error(`embedded migrations are missing sql for journal tag: ${entry.tag}`);
    }
    return {
      hash: createHash('sha256').update(sql).digest('hex'),
      tag: entry.tag,
    };
  });
}

export const EXPECTED_MIGRATION_COUNT = expectedMigrationHashes().length;

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
        throw new DatabaseError({ message: `${DATABASE_URL_ENV} is required` });
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
  migrationsFolder?: string,
): Effect.Effect<void, DatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      if (migrationsFolder !== undefined) {
        await migrate(service.db, { migrationsFolder });
        return;
      }
      if (existsSync(join(DEFAULT_MIGRATIONS_FOLDER, 'meta', '_journal.json'))) {
        await migrate(service.db, { migrationsFolder: DEFAULT_MIGRATIONS_FOLDER });
        return;
      }
      // Compiled binary: materialize the embedded literals into a fresh
      // private per-process dir (mkdtemp: unpredictable name, mode 0700) for
      // this call only — never shared, never reused, never read back for
      // hashing, so there is no window for another process to race or preseed.
      const dir = mkdtempSync(join(tmpdir(), 'saga-migrations-'));
      try {
        mkdirSync(join(dir, 'meta'), { recursive: true });
        writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(embeddedJournal));
        for (const [tag, sql] of Object.entries(embeddedSql)) {
          writeFileSync(join(dir, `${tag}.sql`), sql);
        }
        await migrate(service.db, { migrationsFolder: dir });
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    },
    catch: (cause) =>
      new DatabaseError({
        message: `failed to run database migrations: ${errorMessage(cause)}`,
        cause,
      }),
  });
}

export function runMigrationsSafely(
  service: DatabaseService,
  migrationsFolder?: string,
): Effect.Effect<MigrationStatus, DatabaseError> {
  return getMigrationStatus(service, migrationsFolder).pipe(
    Effect.flatMap((status) => {
      // A hash mismatch in the shared prefix is a genuine incompatibility — the
      // applied history diverges from what this build understands. Refuse.
      if (status.mismatch !== undefined) {
        return Effect.fail(incompatibleMigrationError(status));
      }
      // Current or ahead: tolerate. A database ahead of this binary is benign —
      // the migration norm is additive, so an older binary simply doesn't touch
      // newer surface (ADR-0045, asymmetric skew). Never re-run when nothing is
      // pending; return the observed status.
      if (status.applied >= status.expected) {
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
  migrationsFolder?: string,
): Effect.Effect<MigrationStatus, DatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      // Default expectation comes from the embedded literals — no disk read,
      // so the compiled binary and the from-source run agree by construction.
      const expectedMigrations =
        migrationsFolder === undefined
          ? expectedMigrationHashes()
          : readExpectedMigrationHashes(migrationsFolder);
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

/**
 * At-least-current gate (ADR-0045). Version skew is tolerated asymmetrically:
 * a database *behind* this binary refuses (self-update is the remedy), a hash
 * *mismatch* in the shared prefix refuses (genuine incompatibility), and a
 * database *current or ahead* succeeds — an older binary running against a
 * newer additive schema is benign. Self-update is the one sanctioned moment
 * DDL runs; everywhere else keeps this refuse-posture.
 */
export function assertMigrationsCurrent(
  service: DatabaseService,
  migrationsFolder?: string,
): Effect.Effect<MigrationStatus, DatabaseError> {
  return getMigrationStatus(service, migrationsFolder).pipe(
    Effect.flatMap((status) => {
      if (status.mismatch !== undefined) {
        return Effect.fail(incompatibleMigrationError(status));
      }
      if (status.applied < status.expected) {
        return Effect.fail(
          new DatabaseError({
            message: `database migrations are behind this Saga build: ${String(status.applied)} applied; expected ${String(status.expected)}. Run \`saga self-update\` to converge the binary, schema, and service.`,
          }),
        );
      }
      return Effect.succeed(status);
    }),
  );
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
  if (value === null || typeof value !== 'object' || !('entries' in value)) {
    return false;
  }
  const { entries } = value;
  return (
    Array.isArray(entries) &&
    entries.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        'tag' in entry &&
        typeof entry.tag === 'string',
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
