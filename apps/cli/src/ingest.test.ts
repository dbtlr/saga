import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ingestCodexHook, ingestHook, runIngestCommand } from "./ingest.js";

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

  test("accepts manual hook input from a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "saga-ingest-"));
    const inputPath = join(dir, "hook.json");
    writeFileSync(inputPath, JSON.stringify({ hook_event_name: "Stop", session_id: "session-id" }));

    const output = await ingestCodexHook(
      {
        ascii: true,
        color: "never",
        format: "json",
        isTty: false,
      },
      {
        capture: async (input) => ({
          accepted: input.session_id === "session-id",
          eventId: "event-id",
          mode: "captured",
          source: "codex",
        }),
        inputPath,
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

describe("ingestHook", () => {
  test("returns Claude hook-compatible JSON for record output", async () => {
    await expect(
      ingestHook(
        "claude",
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
            source: "claude",
          }),
          stdin: JSON.stringify({ hook_event_name: "Stop", session_id: "session-id" }),
        },
      ),
    ).resolves.toBe(JSON.stringify({ continue: true }));
  });

  test("returns non-blocking Claude hook JSON when capture is skipped", async () => {
    await expect(
      ingestHook(
        "claude",
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
            source: "claude",
          }),
          stdin: "{}",
        },
      ),
    ).resolves.toBe(
      JSON.stringify({
        continue: true,
        systemMessage: "Saga Claude Code capture skipped: DATABASE_URL is required",
      }),
    );
  });

  test("dispatches claude-hook through the ingest command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "saga-ingest-claude-"));
    const inputPath = join(dir, "hook.json");
    writeFileSync(inputPath, JSON.stringify({ cwd: dir, hook_event_name: "Stop" }));

    const output = await runIngestCommand(["claude-hook", inputPath], {
      ascii: true,
      color: "never",
      format: "json",
      isTty: false,
    });

    expect(JSON.parse(output)).toMatchObject({
      accepted: true,
      mode: "skipped",
      source: "claude",
    });
  });
});
