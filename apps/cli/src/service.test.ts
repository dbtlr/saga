import { describe, expect, test } from "vitest";
import { serviceStatus } from "./service.js";

describe("serviceStatus", () => {
  test("reports unreachable service", async () => {
    const output = await serviceStatus({ ascii: true, color: "never", isTty: false });

    expect(output).toContain("Saga service status");
    expect(output).toContain("health");
  });
});
