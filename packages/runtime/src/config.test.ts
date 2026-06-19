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
      service: {
        host: "127.0.0.1",
        port: 4766,
      },
      secrets: {
        openaiApiKey: "sk-test",
      },
    });
  });

  test("parses service host and port", () => {
    const { config, issues } = parseRuntimeConfig({
      SAGA_SERVICE_HOST: "0.0.0.0",
      SAGA_SERVICE_PORT: "5000",
    });

    expect(issues).toEqual([]);
    expect(config.service).toEqual({
      host: "0.0.0.0",
      port: 5000,
    });
  });

  test("returns validation issues for invalid enum values", () => {
    const { config, issues } = parseRuntimeConfig({
      SAGA_ENV: "local",
      SAGA_LOG_LEVEL: "trace",
      SAGA_SERVICE_PORT: "nope",
    });

    expect(config.environment).toBe("development");
    expect(config.logLevel).toBe("info");
    expect(issues).toEqual([
      { key: "SAGA_ENV", message: "expected one of development, test, production" },
      { key: "SAGA_LOG_LEVEL", message: "expected one of debug, info, warn, error" },
      { key: "SAGA_SERVICE_PORT", message: "expected an integer from 1 to 65535" },
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
      service: {
        host: "127.0.0.1",
        port: 4766,
      },
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
