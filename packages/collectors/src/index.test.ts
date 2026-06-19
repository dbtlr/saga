import { describe, expect, test } from "vitest";
import { rawEventFromCodexHook } from "./index.js";

describe("rawEventFromCodexHook", () => {
  test("normalizes Codex hook input into a raw event envelope", () => {
    const event = rawEventFromCodexHook(
      {
        cwd: "/repo",
        hook_event_name: "UserPromptSubmit",
        model: "gpt-5.5",
        permission_mode: "dontAsk",
        session_id: "session-id",
        transcript_path: "/tmp/transcript.jsonl",
        turn_id: "turn-id",
      },
      {
        sourceBinding: { id: "source-id" },
        workspace: { id: "workspace-id" },
      },
      new Date("2026-06-19T20:00:00.000Z"),
    );

    expect(event).toEqual({
      actorId: "codex",
      eventType: "codex.UserPromptSubmit",
      occurredAt: "2026-06-19T20:00:00.000Z",
      payload: {
        cwd: "/repo",
        hook_event_name: "UserPromptSubmit",
        model: "gpt-5.5",
        permission_mode: "dontAsk",
        session_id: "session-id",
        transcript_path: "/tmp/transcript.jsonl",
        turn_id: "turn-id",
      },
      provenance: {
        cwd: "/repo",
        hookEventName: "UserPromptSubmit",
        model: "gpt-5.5",
        permissionMode: "dontAsk",
        transcriptPath: "/tmp/transcript.jsonl",
      },
      sessionId: "session-id",
      sourceId: "source-id",
      sourceType: "codex",
      traceId: "turn-id",
      trustLevel: "raw",
      workspaceId: "workspace-id",
    });
  });
});
