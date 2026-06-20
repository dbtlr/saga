import { describe, expect, test } from "vitest";
import {
  candidateClaimKey,
  extractCandidateClaimsFromRawEvents,
  type ClaimExtractionRawEvent,
} from "./index.js";

function rawEvent(input: Partial<ClaimExtractionRawEvent> = {}): ClaimExtractionRawEvent {
  return {
    eventType: "codex.UserPromptSubmit",
    externalEventId: "codex:UserPromptSubmit:session:turn:transcript:hash",
    id: "raw-event-id",
    occurredAt: "2026-06-19T20:00:00.000Z",
    payload: {
      prompt: "Agreed. We should compile Active Context from claims before MCP exposes it.",
    },
    sessionId: "session",
    sourceId: "codex:local",
    sourceType: "codex",
    traceId: "turn",
    workspaceId: "workspace-id",
    ...input,
  };
}

describe("extractCandidateClaimsFromRawEvents", () => {
  test("extracts deterministic candidates from Codex user prompts", () => {
    const [claim] = extractCandidateClaimsFromRawEvents([rawEvent()]);

    expect(claim).toMatchObject({
      confidence: 0.72,
      kind: "decision",
      text: "We should compile Active Context from claims before MCP exposes it.",
      workspaceId: "workspace-id",
    });
    expect(claim?.evidence).toMatchObject({
      eventType: "codex.UserPromptSubmit",
      quote: "Agreed. We should compile Active Context from claims before MCP exposes it.",
      rawEventId: "raw-event-id",
      sessionId: "session",
    });
  });

  test("classifies preferences and follow-ups", () => {
    const claims = extractCandidateClaimsFromRawEvents([
      rawEvent({
        payload: {
          prompt: [
            "My bias is to keep this deterministic for now.",
            "We should queue LLM extraction for later.",
          ].join("\n"),
        },
      }),
    ]);

    expect(claims.map((claim) => claim.kind)).toEqual(["preference", "follow_up"]);
  });

  test("extracts deterministic candidates from Claude user prompts", () => {
    const [claim] = extractCandidateClaimsFromRawEvents([
      rawEvent({
        eventType: "claude.UserPromptSubmit",
        externalEventId: "claude:UserPromptSubmit:session::transcript:hash",
        sourceId: "claude:local",
        sourceType: "claude",
        traceId: undefined,
      }),
    ]);

    expect(claim).toMatchObject({
      evidence: {
        eventType: "claude.UserPromptSubmit",
        sourceId: "claude:local",
        sourceType: "claude",
      },
      text: "We should compile Active Context from claims before MCP exposes it.",
    });
  });

  test("ignores events without user prompts", () => {
    expect(
      extractCandidateClaimsFromRawEvents([
        rawEvent({
          eventType: "codex.Stop",
          payload: { hook_event_name: "Stop" },
        }),
      ]),
    ).toEqual([]);
  });

  test("computes stable candidate keys", () => {
    const [claim] = extractCandidateClaimsFromRawEvents([rawEvent()]);
    if (claim === undefined) throw new Error("expected claim");

    expect(candidateClaimKey(claim)).toBe(candidateClaimKey({ ...claim }));
    expect(
      candidateClaimKey({
        ...claim,
        evidence: {
          ...claim.evidence,
          externalEventId: "different-event",
          rawEventId: "different-raw-event",
        },
      }),
    ).toBe(candidateClaimKey(claim));
  });
});
