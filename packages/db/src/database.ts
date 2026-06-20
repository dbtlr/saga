import { fileURLToPath } from "node:url";
import { RuntimeConfigTag, type RuntimeConfig } from "@saga/runtime";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Context, Data, Effect, Layer } from "effect";
import postgres, { type Options, type PostgresType, type Sql } from "postgres";
import { schema, type SagaSchema } from "./schema.js";

export type SagaDatabase = PostgresJsDatabase<SagaSchema>;
export type SagaSql = Sql<Record<string, PostgresType>>;

export interface DatabaseService {
  db: SagaDatabase;
  sql: SagaSql;
  close: () => Effect.Effect<void, DatabaseError>;
}

export interface MigrationStatus {
  applied: number;
  expected: number;
}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const DatabaseTag = Context.GenericTag<DatabaseService>("@saga/db/Database");

export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));
export const EXPECTED_MIGRATION_COUNT = 4;

export interface MakeDatabaseOptions {
  postgres?: Options<Record<string, PostgresType>>;
}

export function makeDatabase(
  config: RuntimeConfig,
  options: MakeDatabaseOptions = {},
): Effect.Effect<DatabaseService, DatabaseError> {
  return Effect.try({
    try: () => {
      if (config.databaseUrl === undefined) {
        throw new DatabaseError({ message: "DATABASE_URL is required" });
      }

      const sql = postgres(config.databaseUrl, options.postgres);
      return makeDatabaseService(sql);
    },
    catch: (cause) =>
      cause instanceof DatabaseError
        ? cause
        : new DatabaseError({ message: "failed to create database client", cause }),
  });
}

export function DatabaseLive(
  options: MakeDatabaseOptions = {},
): Layer.Layer<DatabaseService, DatabaseError, RuntimeConfig> {
  return Layer.scoped(
    DatabaseTag,
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
  return getMigrationStatus(service).pipe(
    Effect.flatMap((status) => {
      if (status.applied > status.expected) {
        return Effect.fail(newerMigrationError(status));
      }
      if (status.applied === status.expected) return Effect.succeed(status);
      return runMigrations(service, migrationsFolder).pipe(
        Effect.flatMap(() => getMigrationStatus(service)),
      );
    }),
  );
}

export function getMigrationStatus(
  service: DatabaseService,
): Effect.Effect<MigrationStatus, DatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      const table = await service.sql.unsafe(
        "select to_regclass('drizzle.__drizzle_migrations')::text as table_name",
      );
      if (table[0]?.table_name === null || table[0]?.table_name === undefined) {
        return {
          applied: 0,
          expected: EXPECTED_MIGRATION_COUNT,
        };
      }

      const migrations = await service.sql.unsafe(
        "select count(*)::text as count from drizzle.__drizzle_migrations",
      );
      return {
        applied: Number.parseInt(String(migrations[0]?.count ?? "0"), 10),
        expected: EXPECTED_MIGRATION_COUNT,
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
): Effect.Effect<MigrationStatus, DatabaseError> {
  return getMigrationStatus(service).pipe(
    Effect.flatMap((status) =>
      status.applied > status.expected
        ? Effect.fail(newerMigrationError(status))
        : status.applied < status.expected
          ? Effect.fail(
              new DatabaseError({
                message: `database migrations are not current: ${String(status.applied)} applied; expected ${String(status.expected)}. Run saga init to apply migrations.`,
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

function makeDatabaseService(sql: SagaSql): DatabaseService {
  return {
    db: drizzle(sql, { schema }),
    sql,
    close: () =>
      Effect.tryPromise({
        try: async () => {
          await sql.end({ timeout: 5 });
        },
        catch: (cause) => new DatabaseError({ message: "failed to close database client", cause }),
      }),
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
