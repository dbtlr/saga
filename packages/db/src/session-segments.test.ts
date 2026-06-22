import { describe, expect, test } from "vitest";
import { deriveSessionSegmentsFromTurns } from "./session-segments.js";
import type { SessionTurn } from "./schema.js";

describe("deriveSessionSegmentsFromTurns", () => {
  test("keeps duplicate same-call tool call parts and matching result standalone", () => {
    const turns = [
      makeTurn(0, [
        {
          type: "tool_call",
          name: "shell",
          callId: "call-duplicate",
          arguments: { command: "printf first" },
        },
        {
          type: "tool_call",
          name: "shell",
          callId: "call-duplicate",
          arguments: { command: "printf second" },
        },
      ]),
      makeTurn(1, [
        {
          type: "tool_result",
          name: "shell",
          callId: "call-duplicate",
          output: "DUPLICATE_RESULT",
        },
      ]),
    ];

    const segments = deriveSessionSegmentsFromTurns(turns);

    expect(segments.map((segment) => segment.segmentKind)).toEqual(["turn", "turn"]);
    expect(segments.map((segment) => segment.turnId)).toEqual(turns.map((turn) => turn.id));
    expect(segments.map((segment) => metadataToolGroup(segment.metadata))).toEqual([
      undefined,
      undefined,
    ]);
  });

  test("keeps multiple distinct tool call ids in one turn standalone", () => {
    const turns = [
      makeTurn(0, [
        {
          type: "tool_call",
          name: "shell",
          callId: "call-a",
          arguments: { command: "printf alpha" },
        },
        {
          type: "tool_call",
          name: "shell",
          callId: "call-b",
          arguments: { command: "printf beta" },
        },
      ]),
      makeTurn(1, [
        {
          type: "tool_result",
          name: "shell",
          callId: "call-a",
          output: "ALPHA_RESULT",
        },
      ]),
      makeTurn(2, [
        {
          type: "tool_result",
          name: "shell",
          callId: "call-b",
          output: "BETA_RESULT",
        },
      ]),
    ];

    const segments = deriveSessionSegmentsFromTurns(turns);

    expect(segments.map((segment) => segment.segmentKind)).toEqual(["turn", "turn", "turn"]);
    expect(segments.map((segment) => metadataToolGroup(segment.metadata))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("keeps mixed tool call and result parts in one turn standalone", () => {
    const turns = [
      makeTurn(0, [
        {
          type: "tool_call",
          name: "shell",
          callId: "call-mixed",
          arguments: { command: "printf mixed" },
        },
      ]),
      makeTurn(1, [
        {
          type: "tool_call",
          name: "shell",
          callId: "call-other",
          arguments: { command: "printf other" },
        },
        {
          type: "tool_result",
          name: "shell",
          callId: "call-mixed",
          output: "MIXED_RESULT",
        },
      ]),
    ];

    const segments = deriveSessionSegmentsFromTurns(turns);

    expect(segments.map((segment) => segment.segmentKind)).toEqual(["turn", "turn"]);
    expect(segments.map((segment) => metadataToolGroup(segment.metadata))).toEqual([
      undefined,
      undefined,
    ]);
  });

  test("groups adjacent and interleaved one-part tool turns by call id", () => {
    const turns = [
      makeTurn(0, [
        {
          type: "tool_call",
          name: "shell",
          callId: "call-a",
          arguments: { command: "printf alpha" },
        },
      ]),
      makeTurn(1, [
        {
          type: "tool_call",
          name: "shell",
          callId: "call-b",
          arguments: { command: "printf beta" },
        },
      ]),
      makeTurn(2, [
        {
          type: "tool_result",
          name: "shell",
          callId: "call-a",
          output: "ALPHA_RESULT",
        },
      ]),
      makeTurn(3, [
        {
          type: "tool_result",
          name: "shell",
          callId: "call-b",
          output: "BETA_RESULT",
        },
      ]),
    ];

    const segments = deriveSessionSegmentsFromTurns(turns);

    expect(segments.map((segment) => segment.segmentKind)).toEqual([
      "tool_group_call",
      "tool_group_call",
      "tool_group_result",
      "tool_group_result",
    ]);
    expect(segments.map((segment) => metadataToolGroup(segment.metadata)?.callId)).toEqual([
      "call-a",
      "call-b",
      "call-a",
      "call-b",
    ]);
  });

  test("keeps ambiguous tool-bearing turns in the grouping window without grouping them", () => {
    const turns = [
      makeTurn(0, [
        {
          type: "tool_call",
          name: "shell",
          callId: "call-a",
          arguments: { command: "printf alpha-call" },
        },
      ]),
      makeTurn(1, [
        {
          type: "tool_call",
          name: "shell",
          callId: "call-ambiguous-one",
          arguments: { command: "printf ambiguous-one" },
        },
        {
          type: "tool_call",
          name: "shell",
          callId: "call-ambiguous-two",
          arguments: { command: "printf ambiguous-two" },
        },
      ]),
      makeTurn(2, [
        {
          type: "tool_result",
          name: "shell",
          callId: "call-a",
          output: "ALPHA_RESULT_NEEDLE",
        },
      ]),
    ];

    const segments = deriveSessionSegmentsFromTurns(turns);
    const segmentsByTurnId = new Map(segments.map((segment) => [segment.turnId, segment]));

    expect(segments).toHaveLength(3);
    expect(segments.map((segment) => segment.ordinal)).toEqual([0, 1, 2]);
    expect(segments.map((segment) => segment.turnId)).toEqual(turns.map((turn) => turn.id));
    expect(segments.map((segment) => segment.segmentKind)).toEqual([
      "tool_group_call",
      "turn",
      "tool_group_result",
    ]);
    expect(segments.map((segment) => metadataToolGroup(segment.metadata)?.callId)).toEqual([
      "call-a",
      undefined,
      "call-a",
    ]);
    expect(segments[0]?.metadata).toMatchObject({
      groupedTurnIds: [turns[0]?.id, turns[2]?.id],
      groupedTurnOrdinals: [0, 2],
      toolGroup: {
        callId: "call-a",
        memberIndex: 0,
        turnIds: [turns[0]?.id, turns[2]?.id],
        turnOrdinals: [0, 2],
      },
    });
    expect(segments[1]?.metadata).toMatchObject({
      groupedTurnIds: [turns[1]?.id],
      groupedTurnOrdinals: [1],
      segmentTurnId: turns[1]?.id,
    });
    expect(metadataToolGroup(segments[1]?.metadata)).toBeUndefined();
    expect(segments[2]?.metadata).toMatchObject({
      segmentTurnId: turns[2]?.id,
      toolGroup: {
        callId: "call-a",
        memberIndex: 1,
      },
    });

    expect(segmentsByTurnId.get(turns[0]?.id ?? "")?.ordinal).toBe(0);
    expect(segmentsByTurnId.get(turns[1]?.id ?? "")?.ordinal).toBe(1);
    expect(segmentsByTurnId.get(turns[2]?.id ?? "")?.ordinal).toBe(2);
    expect(segmentsByTurnId.get(turns[0]?.id ?? "")?.searchText).toContain("printf alpha-call");
    expect(segmentsByTurnId.get(turns[0]?.id ?? "")?.searchText).not.toContain(
      "ALPHA_RESULT_NEEDLE",
    );
    expect(segmentsByTurnId.get(turns[1]?.id ?? "")?.searchText).toContain("printf ambiguous-one");
    expect(segmentsByTurnId.get(turns[2]?.id ?? "")?.searchText).toContain("ALPHA_RESULT_NEEDLE");
  });
});

function makeTurn(ordinal: number, contentParts: unknown[]): SessionTurn {
  const now = new Date("2026-06-22T00:00:00.000Z");
  return {
    activityIntervalId: "00000000-0000-0000-0000-000000000003",
    actorKind: "tool",
    actorLabel: null,
    contentParts,
    createdAt: now,
    endedAt: now,
    harnessTurnId: `turn-${ordinal}`,
    id: `00000000-0000-0000-0000-${ordinal.toString().padStart(12, "0")}`,
    metadata: {},
    model: null,
    ordinal,
    parentTurnId: null,
    rawEventIds: [],
    rawSessionRecordId: "00000000-0000-0000-0000-000000000004",
    rawSpan: {},
    role: "tool",
    sessionId: "00000000-0000-0000-0000-000000000002",
    startedAt: now,
    updatedAt: now,
    workspaceId: "00000000-0000-0000-0000-000000000001",
  };
}

function metadataToolGroup(metadata: unknown): { callId?: string } | undefined {
  if (metadata === null || typeof metadata !== "object" || !("toolGroup" in metadata)) {
    return undefined;
  }
  const toolGroup = metadata.toolGroup;
  if (toolGroup === null || typeof toolGroup !== "object") return undefined;
  return toolGroup;
}
