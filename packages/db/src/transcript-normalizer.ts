export type NormalizedTurnRole = "assistant" | "subagent" | "system" | "tool" | "user";
export type NormalizedActorKind = "agent" | "harness" | "host_user" | "subagent" | "tool";

export interface TranscriptImportHints {
  cwd?: string | undefined;
  harnessSessionId?: string | undefined;
  model?: string | undefined;
}

export interface TranscriptNormalization {
  activityInterval: {
    endedAt?: Date | undefined;
    metadata: Record<string, unknown>;
    startedAt?: Date | undefined;
    status?: "active" | "settled" | undefined;
  };
  metadata: Record<string, unknown>;
  session: {
    endedAt?: Date | undefined;
    lastActivityAt?: Date | undefined;
    metadata: Record<string, unknown>;
    model?: string | undefined;
    startedAt?: Date | undefined;
    status?: "active" | "completed" | undefined;
    title?: string | undefined;
  };
  turns: NormalizedTranscriptTurn[];
}

export interface NormalizedTranscriptTurn {
  actorKind: NormalizedActorKind;
  actorLabel?: string | undefined;
  codexTurnId?: string | undefined;
  contentParts: Record<string, unknown>[];
  endedAt?: Date | undefined;
  harnessTurnId?: string | undefined;
  metadata: Record<string, unknown>;
  model?: string | undefined;
  rawSpan: Record<string, unknown>;
  role: NormalizedTurnRole;
  searchText: string;
  startedAt?: Date | undefined;
}
