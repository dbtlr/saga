import { describe, expect, test } from "vitest";
import { ingestCodexHook } from "./ingest.js";

describe("ingestCodexHook", () => {
  test("returns Codex hook-compatible JSON for record output", async () => {
    await expect(
      ingestCodexHook(
        {
          ascii: true,
          color: "never",
          format: "records",
          isTty: false,
        },
        {
          capture: async () => ({
            accepted: true,
            eventId: "event-id",
            mode: "captured",
            source: "codex",
          }),
          stdin: JSON.stringify({ hook_event_name: "Stop", session_id: "session-id" }),
        },
      ),
    ).resolves.toBe(JSON.stringify({ continue: true }));
  });

  test("returns non-blocking hook JSON when capture is skipped", async () => {
    await expect(
      ingestCodexHook(
        {
          ascii: true,
          color: "never",
          format: "records",
          isTty: false,
        },
        {
          capture: async () => ({
            accepted: true,
            error: "DATABASE_URL is required",
            mode: "skipped",
            source: "codex",
          }),
          stdin: "{}",
        },
      ),
    ).resolves.toBe(
      JSON.stringify({
        continue: true,
        systemMessage: "Saga Codex capture skipped: DATABASE_URL is required",
      }),
    );
  });

  test("supports structured CLI output", async () => {
    const output = await ingestCodexHook(
      {
        ascii: true,
        color: "never",
        format: "json",
        isTty: false,
      },
      {
        capture: async () => ({
          accepted: true,
          eventId: "event-id",
          mode: "captured",
          source: "codex",
        }),
        stdin: "{}",
      },
    );

    expect(JSON.parse(output)).toEqual({
      accepted: true,
      eventId: "event-id",
      mode: "captured",
      source: "codex",
    });
  });
});
