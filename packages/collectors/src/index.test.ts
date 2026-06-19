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
        codexSourceBinding: { id: "codex-source-binding-id" },
        workspace: { id: "workspace-id" },
      },
      new Date("2026-06-19T20:00:00.000Z"),
    );

    expect(event).toEqual({
      actorId: "codex",
      eventType: "codex.UserPromptSubmit",
      externalEventId:
        "codex:UserPromptSubmit:session-id:turn-id:/tmp/transcript.jsonl:f3114fba88c28a5fe9930f1ae6ca09bd3c925e42c35317342abad7d002107f14",
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
      sourceBindingId: "codex-source-binding-id",
      sourceId: "codex:local",
      sourceType: "codex",
      traceId: "turn-id",
      trustLevel: "raw",
      workspaceId: "workspace-id",
    });
  });
});
