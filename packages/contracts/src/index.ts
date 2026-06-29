export const packageName = '@saga/contracts';

export type TrustLevel = 'raw' | 'trusted';

export type RawEventEnvelope = {
  actorId: string;
  eventType: string;
  externalEventId: string;
  ingestedAt?: string | undefined;
  occurredAt: string;
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
  sessionId?: string | undefined;
  sourceBindingId: string;
  sourceId: string;
  sourceType: string;
  traceId?: string | undefined;
  trustLevel: TrustLevel;
  workspaceId: string;
};
