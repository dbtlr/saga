import { describe, expect, test } from "vitest";
import { ingestCodexHook } from "./ingest.js";

describe("ingestCodexHook", () => {
  test("returns Codex hook-compatible JSON for record output", async () => {
    await expect(
      ingestCodexHook({
        ascii: true,
        color: "never",
        format: "records",
        isTty: false,
      }),
    ).resolves.toBe(JSON.stringify({ continue: true }));
  });

  test("supports structured CLI output", async () => {
    const output = await ingestCodexHook({
      ascii: true,
      color: "never",
      format: "json",
      isTty: false,
    });

    expect(JSON.parse(output)).toEqual({
      accepted: true,
      mode: "noop",
      source: "codex",
    });
  });
});
