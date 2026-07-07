export const packageName = '@saga/contracts';

export * from './consolidation.js';

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

// --- POST /v1/ingest (SGA-238) ---
// The single source of truth for the ingest wire types, imported by the service
// handler (@saga/service) and the client (@saga/api-client) so the two can never
// drift. @saga/contracts is effect-free and boundary-safe for both tiers.

export type IngestSnapshotActivity = {
  hookEventName?: string | undefined;
  sessionStartSource?: string | undefined;
};

// The session snapshot the service cannot reconstruct from the envelope + inserted
// raw-event row: the local-machine author/host identity and the transcript body/
// content-type/locator. capturedAt (the raw event's occurredAt) and the settlement
// trigger (the inserted raw event's id) are derived server-side, so they are absent.
export type IngestSnapshot = {
  activity?: IngestSnapshotActivity | undefined;
  author: {
    displayName?: string | undefined;
    externalSubject?: string | undefined;
    handle: string;
  };
  contentType: 'json' | 'jsonl' | 'text';
  harness: 'claude' | 'codex';
  harnessMetadata?: Record<string, unknown> | undefined;
  harnessSessionId?: string | undefined;
  host: {
    id: string;
    label?: string | undefined;
    projectRoot?: string | undefined;
  };
  locator?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  model?: string | undefined;
  provenance?: Record<string, unknown> | undefined;
  rawContent: string;
  status?: 'active' | 'completed' | undefined;
  title?: string | undefined;
};

export type IngestItem = {
  envelope: RawEventEnvelope;
  snapshot?: IngestSnapshot | undefined;
};

export type IngestRequest = {
  items: IngestItem[];
};

// A per-item ack. `index` is the item's position in the request array so a caller
// (e.g. a future spool) can map an ack back to its source even when externalEventId
// is empty or duplicated. `status` is 'stored' for a newly persisted item,
// 'duplicate' for an idempotent no-op, or 'error' when that one item failed (the
// batch is non-transactional). `rawEventId` is present whenever the raw event
// persisted — including on an 'error' ack whose failure came after the insert.
export type IngestItemResult = {
  code?: string | undefined;
  externalEventId: string;
  index: number;
  rawEventId?: string | undefined;
  rawSessionRecordId?: string | undefined;
  status: 'stored' | 'duplicate' | 'error';
};

export type IngestResponse = {
  results: IngestItemResult[];
};
