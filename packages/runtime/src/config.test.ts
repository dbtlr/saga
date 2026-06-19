import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import {
  ConfigError,
  RuntimeConfigLive,
  RuntimeConfigTag,
  loadLocalEnv,
  loadRuntimeConfig,
  parseRuntimeConfig,
  redactRuntimeConfig,
} from "./config.js";

describe("parseRuntimeConfig", () => {
  test("applies defaults and reads known environment values", () => {
    const { config, issues } = parseRuntimeConfig({
      DATABASE_URL: "postgres://localhost/saga",
      OPENAI_API_KEY: "sk-test",
      SAGA_ENV: "test",
      SAGA_LOG_LEVEL: "debug",
    });

    expect(issues).toEqual([]);
    expect(config).toEqual({
      databaseUrl: "postgres://localhost/saga",
      environment: "test",
      logLevel: "debug",
      secrets: {
        openaiApiKey: "sk-test",
      },
    });
  });

  test("returns validation issues for invalid enum values", () => {
    const { config, issues } = parseRuntimeConfig({
      SAGA_ENV: "local",
      SAGA_LOG_LEVEL: "trace",
    });

    expect(config.environment).toBe("development");
    expect(config.logLevel).toBe("info");
    expect(issues).toEqual([
      { key: "SAGA_ENV", message: "expected one of development, test, production" },
      { key: "SAGA_LOG_LEVEL", message: "expected one of debug, info, warn, error" },
    ]);
  });
});

describe("redactRuntimeConfig", () => {
  test("redacts secret-bearing values", () => {
    const { config } = parseRuntimeConfig({
      DATABASE_URL: "postgres://localhost/saga",
      OPENAI_API_KEY: "sk-test",
    });

    expect(redactRuntimeConfig(config)).toEqual({
      databaseUrl: "<redacted>",
      environment: "development",
      logLevel: "info",
      secrets: {
        openaiApiKey: "<redacted>",
      },
    });
  });
});

describe("loadLocalEnv", () => {
  test("loads configured env files in order", () => {
    const cwd = mkdtempSync(join(tmpdir(), "saga-config-"));
    writeFileSync(join(cwd, ".env"), "SAGA_LOG_LEVEL=debug\nDATABASE_URL=postgres://env\n");
    writeFileSync(join(cwd, ".env.local"), "SAGA_LOG_LEVEL=warn\nOPENAI_API_KEY=local\n");

    expect(loadLocalEnv(cwd)).toEqual({
      DATABASE_URL: "postgres://env",
      OPENAI_API_KEY: "local",
      SAGA_LOG_LEVEL: "warn",
    });
  });
});

describe("loadRuntimeConfig", () => {
  test("exposes validation failures as Effect errors", async () => {
    const result = await Effect.runPromiseExit(
      loadRuntimeConfig({
        env: { SAGA_ENV: "bad" },
        envFiles: [],
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("ConfigError");
    }
  });

  test("loads explicit env over local env files", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "saga-config-"));
    writeFileSync(join(cwd, ".env"), "SAGA_LOG_LEVEL=debug\n");

    const config = await Effect.runPromise(
      loadRuntimeConfig({
        cwd,
        env: { SAGA_LOG_LEVEL: "error" },
      }),
    );

    expect(config.logLevel).toBe("error");
  });
});

describe("RuntimeConfigLive", () => {
  test("provides runtime config through an Effect layer", async () => {
    const program = Effect.gen(function* () {
      return yield* RuntimeConfigTag;
    }).pipe(
      Effect.provide(
        RuntimeConfigLive({
          env: { SAGA_ENV: "test" },
          envFiles: [],
        }),
      ),
    );

    await expect(Effect.runPromise(program)).resolves.toMatchObject({
      environment: "test",
    });
  });
});

test("ConfigError carries structured issues", () => {
  const error = new ConfigError({ issues: [{ key: "SAGA_ENV", message: "bad" }] });

  expect(error.issues).toEqual([{ key: "SAGA_ENV", message: "bad" }]);
});
