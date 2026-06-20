import { RuntimeConfigLive } from "@saga/runtime";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
  assertMigrationsCurrent,
  DatabaseLive,
  DatabaseTag,
  EXPECTED_MIGRATION_COUNT,
  getMigrationStatus,
  makeDatabase,
  runMigrationsSafely,
  type DatabaseService,
} from "./database.js";

function serviceWithMigrationCount(
  count: number,
  options: { tableExists?: boolean } = {},
): DatabaseService {
  const tableExists = options.tableExists ?? true;
  return {
    close: () => Effect.void,
    db: undefined as never,
    sql: {
      unsafe: async (query: string) =>
        query.includes("to_regclass")
          ? [{ table_name: tableExists ? "drizzle.__drizzle_migrations" : null }]
          : [{ count: String(count) }],
    } as never,
  };
}

describe("makeDatabase", () => {
  test("requires DATABASE_URL", async () => {
    const result = await Effect.runPromiseExit(
      makeDatabase({
        databaseUrl: undefined,
        environment: "test",
        logLevel: "info",
        service: {
          host: "127.0.0.1",
          port: 4766,
        },
        secrets: {
          openaiApiKey: undefined,
        },
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("DATABASE_URL is required");
    }
  });
});

describe("DatabaseLive", () => {
  test("provides a closeable database service from runtime config", async () => {
    const program = Effect.gen(function* () {
      const database = yield* DatabaseTag;
      expect(database.db).toBeDefined();
      expect(database.sql).toBeDefined();
    }).pipe(
      Effect.provide(DatabaseLive()),
      Effect.provide(
        RuntimeConfigLive({
          env: { DATABASE_URL: "postgres://postgres:postgres@localhost:5432/saga_test" },
          envFiles: [],
        }),
      ),
    );

    await expect(Effect.runPromise(program)).resolves.toBeUndefined();
  });
});

describe("assertMigrationsCurrent", () => {
  test("fails when fewer than the expected migrations are applied", async () => {
    await expect(
      Effect.runPromise(
        assertMigrationsCurrent(serviceWithMigrationCount(EXPECTED_MIGRATION_COUNT - 1)),
      ),
    ).rejects.toMatchObject({
      message: `database migrations are not current: ${String(EXPECTED_MIGRATION_COUNT - 1)} applied; expected ${String(EXPECTED_MIGRATION_COUNT)}. Apply migrations before starting Saga.`,
    });
  });

  test("returns migration status when migrations are current", async () => {
    await expect(
      Effect.runPromise(
        assertMigrationsCurrent(serviceWithMigrationCount(EXPECTED_MIGRATION_COUNT)),
      ),
    ).resolves.toEqual({
      applied: EXPECTED_MIGRATION_COUNT,
      expected: EXPECTED_MIGRATION_COUNT,
    });
  });

  test("fails when the database has newer migrations than this build expects", async () => {
    await expect(
      Effect.runPromise(
        assertMigrationsCurrent(serviceWithMigrationCount(EXPECTED_MIGRATION_COUNT + 1)),
      ),
    ).rejects.toMatchObject({
      message: `database has newer migrations than this Saga build understands: ${String(EXPECTED_MIGRATION_COUNT + 1)} applied; expected ${String(EXPECTED_MIGRATION_COUNT)}. Upgrade Saga or restore a compatible backup before continuing.`,
    });
  });
});

describe("getMigrationStatus", () => {
  test("reports zero applied migrations when the drizzle table is missing", async () => {
    await expect(
      Effect.runPromise(getMigrationStatus(serviceWithMigrationCount(99, { tableExists: false }))),
    ).resolves.toEqual({
      applied: 0,
      expected: EXPECTED_MIGRATION_COUNT,
    });
  });
});

describe("runMigrationsSafely", () => {
  test("skips migration execution when migrations are already current", async () => {
    await expect(
      Effect.runPromise(runMigrationsSafely(serviceWithMigrationCount(EXPECTED_MIGRATION_COUNT))),
    ).resolves.toEqual({
      applied: EXPECTED_MIGRATION_COUNT,
      expected: EXPECTED_MIGRATION_COUNT,
    });
  });
});
