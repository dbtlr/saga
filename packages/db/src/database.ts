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

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const DatabaseTag = Context.GenericTag<DatabaseService>("@saga/db/Database");

export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

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
