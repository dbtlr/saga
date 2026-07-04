export const packageName = '@saga/claims';

// The claim vocabulary shared with the @saga/db claim event ledger. Extraction
// itself is deferred to Phase 2 consolidation (ADR 0041): no extractor lives
// here until consolidation writes real claims.
export type ClaimKind = 'decision' | 'follow_up' | 'observation' | 'preference';

export type ClaimEvidence = {
  eventType: string;
  externalEventId: string;
  occurredAt: string;
  quote: string;
  rawEventId: string;
  sessionId?: string | undefined;
  sourceId: string;
  sourceType: string;
  traceId?: string | undefined;
};
