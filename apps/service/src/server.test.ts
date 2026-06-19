import { describe, expect, test } from "vitest";
import { startSagaService } from "./server.js";

describe("startSagaService", () => {
  test("serves health", async () => {
    const service = await startSagaService({
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
    });

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
});
