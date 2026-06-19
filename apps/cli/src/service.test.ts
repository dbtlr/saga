import { describe, expect, test } from "vitest";
import { renderServiceStatus, serviceStatus } from "./service.js";

describe("serviceStatus", () => {
  test("reports unreachable service", async () => {
    const output = await serviceStatus({
      ascii: true,
      color: "never",
      format: "records",
      isTty: false,
    });

    expect(output).toContain("Saga service status");
    expect(output).toContain("health");
  });
});

describe("renderServiceStatus", () => {
  test("reports observed running state", () => {
    expect(
      renderServiceStatus(
        {
          config: "127.0.0.1:4766",
          health: "ok (http://127.0.0.1:4766/health)",
          healthUrl: "http://127.0.0.1:4766/health",
          logs: "stdout/stderr",
          process: "running",
        },
        { ascii: true, color: "never", format: "records", isTty: false },
      ),
    ).toContain("process  running");
  });
});
