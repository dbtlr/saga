import { describe, expect, test } from "vitest";
import { renderStartReport, runStartCommand } from "./start.js";

const renderOptions = {
  ascii: true,
  color: "never" as const,
  format: "records" as const,
  isTty: false,
};

describe("renderStartReport", () => {
  test("renders service and control-plane endpoints", () => {
    expect(
      renderStartReport(
        {
          controlPlaneUrl: "http://127.0.0.1:4767",
          healthUrl: "http://127.0.0.1:4766/health",
          service: "started",
        },
        renderOptions,
      ),
    ).toContain("control  http://127.0.0.1:4767");
  });
});

describe("runStartCommand", () => {
  test("launches the control-plane dev server when the service is already running", async () => {
    const output: string[] = [];
    const exitCode = await runStartCommand([], renderOptions, (text) => output.push(text), {
      checkHealth: async () => "ok (http://127.0.0.1:4766/health)",
      cwd: process.cwd(),
      env: {},
      spawnControlPlane: async (input) => {
        expect(input.cwd).toBeTypeOf("string");
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    expect(output[0]).toContain("service  already running");
  });

  test("starts an embedded service when health is unreachable", async () => {
    const output: string[] = [];
    let closed = false;

    await expect(
      runStartCommand([], renderOptions, (text) => output.push(text), {
        checkHealth: async () => "unreachable",
        cwd: process.cwd(),
        env: {},
        spawnControlPlane: async () => 0,
        startService: async () => ({
          close: async () => {
            closed = true;
          },
          host: "127.0.0.1",
          port: 4766,
          url: "http://127.0.0.1:4766",
        }),
      }),
    ).resolves.toBe(0);

    expect(output[0]).toContain("service  started");
    expect(closed).toBe(true);
  });
});
