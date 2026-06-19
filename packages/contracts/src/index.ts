export const packageName = "@saga/contracts";

export type TrustLevel = "raw" | "trusted";

export interface RawEventEnvelope {
  actorId: string;
  eventType: string;
  ingestedAt?: string | undefined;
  occurredAt: string;
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
  sessionId?: string | undefined;
  sourceId: string;
  sourceType: string;
  traceId?: string | undefined;
  trustLevel: TrustLevel;
  workspaceId: string;
}
