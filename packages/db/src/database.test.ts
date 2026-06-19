import { RuntimeConfigLive } from "@saga/runtime";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
  assertMigrationsCurrent,
  DatabaseLive,
  DatabaseTag,
  EXPECTED_MIGRATION_COUNT,
  makeDatabase,
  type DatabaseService,
} from "./database.js";

function serviceWithMigrationCount(count: number): DatabaseService {
  return {
    close: () => Effect.void,
    db: undefined as never,
    sql: {
      unsafe: async () => [{ count: String(count) }],
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
      message: `database migrations are not current: ${String(EXPECTED_MIGRATION_COUNT - 1)} applied; expected ${String(EXPECTED_MIGRATION_COUNT)}. Run saga init to apply migrations.`,
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
});
