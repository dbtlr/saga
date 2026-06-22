import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { rawEventFromClaudeHook, rawEventFromCodexHook } from "./index.js";

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

  test("copies manual ingest markers into payload and provenance", () => {
    const event = rawEventFromCodexHook(
      {
        captureMode: "manual",
        hook_event_name: "UserPromptSubmit",
        ingestOrigin: "saga ingest codex-hook <file>",
        manual: true,
        sagaManualIngest: true,
        session_id: "session-id",
      },
      {
        codexSourceBinding: { id: "codex-source-binding-id" },
        workspace: { id: "workspace-id" },
      },
      new Date("2026-06-19T20:00:00.000Z"),
    );

    expect(event.payload).toMatchObject({
      captureMode: "manual",
      ingestOrigin: "saga ingest codex-hook <file>",
      manual: true,
      sagaManualIngest: true,
    });
    expect(event.provenance).toMatchObject({
      captureMode: "manual",
      ingestOrigin: "saga ingest codex-hook <file>",
      manual: true,
      sagaManualIngest: true,
    });
  });
});

describe("rawEventFromClaudeHook", () => {
  test("normalizes Claude hook input into a raw event envelope", () => {
    const event = rawEventFromClaudeHook(
      {
        cwd: "/repo",
        hook_event_name: "UserPromptSubmit",
        model: "claude-sonnet-4-5",
        permission_mode: "default",
        session_id: "session-id",
        transcript_path: "/tmp/claude-transcript.jsonl",
      },
      {
        sourceBinding: { id: "claude-source-binding-id" },
        workspace: { id: "workspace-id" },
      },
      new Date("2026-06-19T20:00:00.000Z"),
    );

    expect(event).toEqual({
      actorId: "claude",
      eventType: "claude.UserPromptSubmit",
      externalEventId:
        "claude:UserPromptSubmit:session-id::/tmp/claude-transcript.jsonl:580067387a6c1f7fc87f2193673f807bb7f3784aa22d3ab4ab2a68dfed9a651d",
      occurredAt: "2026-06-19T20:00:00.000Z",
      payload: {
        cwd: "/repo",
        hook_event_name: "UserPromptSubmit",
        model: "claude-sonnet-4-5",
        permission_mode: "default",
        session_id: "session-id",
        transcript_path: "/tmp/claude-transcript.jsonl",
      },
      provenance: {
        cwd: "/repo",
        hookEventName: "UserPromptSubmit",
        model: "claude-sonnet-4-5",
        permissionMode: "default",
        transcriptPath: "/tmp/claude-transcript.jsonl",
      },
      sessionId: "session-id",
      sourceBindingId: "claude-source-binding-id",
      sourceId: "claude:local",
      sourceType: "claude",
      traceId: undefined,
      trustLevel: "raw",
      workspaceId: "workspace-id",
    });
  });

  test("distinguishes repeated identical Claude prompts with transcript occurrence", () => {
    const dir = mkdtempSync(join(tmpdir(), "saga-claude-transcript-"));
    const transcriptPath = join(dir, "transcript.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          message: {
            content: [{ text: "Repeat this prompt", type: "text" }],
          },
          session_id: "session-id",
          type: "user",
        }),
        JSON.stringify({
          message: {
            content: [{ text: "Repeat this prompt", type: "text" }],
          },
          session_id: "session-id",
          type: "user",
        }),
      ].join("\n"),
    );

    const event = rawEventFromClaudeHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "Repeat this prompt",
        session_id: "session-id",
        transcript_path: transcriptPath,
      },
      {
        sourceBinding: { id: "claude-source-binding-id" },
        workspace: { id: "workspace-id" },
      },
      new Date("2026-06-19T20:00:00.000Z"),
    );

    expect(event.externalEventId).toContain(":transcript-2:");
  });
});
