import { describe, expect, test } from "vitest";
import { startSagaService } from "./server.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("startSagaService", () => {
  test("serves health", async () => {
    const service = await startSagaService(
      {
        databaseUrl: "postgres://test/saga",
        environment: "test",
        logLevel: "info",
        service: {
          host: "127.0.0.1",
          port: 0,
        },
        secrets: {
          openaiApiKey: undefined,
        },
      },
      {
        validateDatabase: async () => undefined,
      },
    );

    try {
      const response = await fetch(`${service.url}/health`);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        service: "saga",
      });
    } finally {
      await service.close();
    }
  });

  test("fails startup when database config is missing", async () => {
    await expect(
      startSagaService({
        databaseUrl: undefined,
        environment: "test",
        logLevel: "info",
        service: {
          host: "127.0.0.1",
          port: 0,
        },
        secrets: {
          openaiApiKey: undefined,
        },
      }),
    ).rejects.toThrow("DATABASE_URL is required");
  });
});

describe("service entrypoint", () => {
  test("loads runtime config and starts the foreground service", () => {
    const entrypoint = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");

    expect(entrypoint).toContain("loadRuntimeConfig");
    expect(entrypoint).toContain("startSagaService");
    expect(entrypoint).toContain("SIGTERM");
  });

  test("exposes an explicit migration entrypoint", () => {
    const entrypoint = readFileSync(
      fileURLToPath(new URL("./migrate.ts", import.meta.url)),
      "utf8",
    );

    expect(entrypoint).toContain("loadRuntimeConfig");
    expect(entrypoint).toContain("runMigrationsSafely");
    expect(entrypoint).toContain("Saga database migrations current");
  });
});

describe("deploy targets", () => {
  test("systemd target runs the service package entrypoint", () => {
    const unit = readFileSync(join(workspaceRoot, "deploy", "systemd", "saga.service"), "utf8");

    expect(unit).toContain("EnvironmentFile=/etc/saga/saga.env");
    expect(unit).toContain("pnpm --dir /opt/saga --filter @saga/service migrate");
    expect(unit).toContain("pnpm --dir /opt/saga --filter @saga/service start");
  });

  test("hosted target documents file-backed secrets", () => {
    const env = readFileSync(
      join(workspaceRoot, "deploy", "hosted", "service.env.example"),
      "utf8",
    );

    expect(env).toContain("DATABASE_URL_FILE=/run/secrets/saga_database_url");
    expect(env).toContain("SAGA_SERVICE_HOST=0.0.0.0");
  });
});
