import { describe, expect, test } from "vitest";
import { RuntimeConfigLive } from "@saga/runtime";
import { Effect } from "effect";
import { DatabaseLive, DatabaseTag, makeDatabase } from "./database.js";

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
