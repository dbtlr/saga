// Wire (JSON-serialized) mirrors of the @saga/db read shapes. Dates cross the
// HTTP boundary as ISO-8601 strings, so every timestamp is typed `string` here
// rather than `Date`. These are defined locally on purpose: @saga/api-client is
// a client-tier package (ADR-0048) and must never depend on @saga/db. Promotion
// of the shared shapes into @saga/contracts can come when ingest lands; until
// then the parity tests pin these against the live db read functions.

import type { RawEventEnvelope, TrustLevel } from '@saga/contracts';

export type JsonRecord = Record<string, unknown>;

// --- /v1/info ---

export type ServiceInfo = {
  migrations: {
    applied: number;
    compatible: boolean;
    expected: number;
  };
  uptimeSeconds: number;
  version: string;
};

// --- Shared session vocabulary ---

export type SessionMetadata = {
  endedAt: string | null;
  harness: string;
  harnessSessionId: string | null;
  id: string;
  lastActivityAt: string | null;
  metadata: JsonRecord;
  model: string | null;
  provenance: JsonRecord;
  sourceBindingId: string;
  sourceLocator: string | null;
  startedAt: string | null;
  status: string;
  title: string | null;
  workspaceId: string;
};

export type HostUserMetadata = {
  displayName: string | null;
  externalSubject: string | null;
  handle: string;
  id: string;
  identitySource: string;
  metadata: JsonRecord;
};

export type SourceBindingMetadata = {
  config: JsonRecord;
  displayName: string | null;
  enabled: boolean;
  id: string;
  sourceType: string;
  sourceUri: string;
};

export type ActivityIntervalMetadata = {
  endedAt: string | null;
  id: string;
  metadata: JsonRecord;
  ordinal: number;
  sessionId: string;
  settledAt: string | null;
  settlementReason: string | null;
  startedAt: string;
  status: string;
};

export type RawBodyExposureMetadata = {
  mode: 'raw_forensic';
  requestedBy: 'includeRawBody';
  warning: string;
};

export type RawSessionRecordMetadata = {
  bodyJson?: unknown;
  bodyText?: string | null;
  capturedAt: string;
  contentBytes: number | null;
  contentHash: string;
  contentType: string;
  harness: string;
  harnessSessionId: string | null;
  id: string;
  isActive: boolean;
  metadata: JsonRecord;
  provenance: JsonRecord;
  rawBodyExposure?: RawBodyExposureMetadata;
  sessionId: string;
  snapshotOrdinal: number;
  sourceLocator: string | null;
  status: string;
};

export type TurnMetadata = {
  actorKind: string;
  actorLabel: string | null;
  harnessTurnId: string | null;
  id: string;
  model: string | null;
  ordinal: number;
  role: string;
};

export type SegmentMetadata = {
  charEnd: number | null;
  charStart: number | null;
  id: string;
  ordinal: number;
  segmentKind: string;
  snippet: string | null;
  tokenEnd: number | null;
  tokenStart: number | null;
};

// --- GET /v1/sessions ---

export type ListSessionsRequest = {
  activeOnly?: boolean | undefined;
  harness?: string | undefined;
  limit?: number | undefined;
  workspaceId: string;
};

export type RecentSessionRecord = {
  activityInterval: ActivityIntervalMetadata | null;
  authorUser: HostUserMetadata;
  counts: {
    activityIntervals: number;
    rawSessionRecords: number;
    segments: number;
    turns: number;
  };
  rawSessionRecord: RawSessionRecordMetadata;
  session: SessionMetadata;
  sourceBinding: SourceBindingMetadata;
};

// --- GET /v1/sessions/:id ---

export type GetSessionRequest = {
  includeRawBody?: boolean | undefined;
  maxRawRecords?: number | undefined;
  maxSegmentsPerTurn?: number | undefined;
  maxTurns?: number | undefined;
  workspaceId: string;
};

export type SessionDetailSegment = SegmentMetadata & {
  metadata: JsonRecord;
  searchText: string;
};

export type SessionDetailTurn = {
  contentParts: unknown[];
  endedAt: string | null;
  metadata: JsonRecord;
  rawEventIds: string[];
  rawSpan: JsonRecord;
  segments: SessionDetailSegment[];
  startedAt: string | null;
  turn: TurnMetadata;
};

export type SessionDetailActivityInterval = {
  activityInterval: ActivityIntervalMetadata;
  turns: SessionDetailTurn[];
};

export type SessionDetail = {
  activeRawSessionRecord: RawSessionRecordMetadata | null;
  activityIntervals: SessionDetailActivityInterval[];
  authorUser: HostUserMetadata;
  limits: {
    includeRawBody: boolean;
    maxRawRecords: number;
    maxSegmentsPerTurn: number;
    maxTurns: number;
  };
  rawSessionRecords: RawSessionRecordMetadata[];
  selectedRawSessionRecord: RawSessionRecordMetadata | null;
  session: SessionMetadata;
  sourceBinding: SourceBindingMetadata;
  truncated: {
    rawSessionRecords: boolean;
    segments: boolean;
    turns: boolean;
  };
};

// --- POST /v1/recall ---

// Only the lexical recall path is reachable in this slice: vector recall needs a
// query-embedding egress that arrives with the extraction job (a later slice), so
// no embedding provider crosses this boundary yet. `mode` is accepted for wire
// forward-compatibility but must be 'lexical' until then.
export type RecallMode = 'lexical';

export type RecallRequest = {
  activityIntervalId?: string | undefined;
  limit?: number | undefined;
  minTrigramScore?: number | undefined;
  mode?: RecallMode | undefined;
  query: string;
  rawSessionRecordId?: string | undefined;
  sessionId?: string | undefined;
  vectorCandidateLimit?: number | undefined;
  workspaceId: string;
};

export type RecallSessionMetadata = SessionMetadata & {
  authorUser: HostUserMetadata;
};

export type RecallRawSessionRecordMetadata = {
  capturedAt: string;
  contentHash: string;
  contentType: string;
  harness: string;
  harnessSessionId: string | null;
  id: string;
  isActive: boolean;
  metadata: JsonRecord;
  provenance: JsonRecord;
  snapshotOrdinal: number;
  sourceLocator: string | null;
  status: string;
};

export type RecallSegmentMatch = {
  activityInterval: ActivityIntervalMetadata;
  combinedScore: number;
  rawSessionRecord: RecallRawSessionRecordMetadata;
  scores: {
    combined: number;
    lexical: number;
    trigram: number;
    vector?: number | undefined;
  };
  segment: SegmentMetadata;
  session: RecallSessionMetadata;
  snippet: string;
  sourceBinding: SourceBindingMetadata;
  turn: TurnMetadata;
};

export type RecallSearchActivityIntervalGroup = {
  activityInterval: ActivityIntervalMetadata;
  matches: RecallSegmentMatch[];
  sessionId: string;
};

export type RecallSearchSessionGroup = {
  activityIntervals: RecallSearchActivityIntervalGroup[];
  matches: RecallSegmentMatch[];
  session: RecallSessionMetadata;
};

export type RecallSearchResult = {
  intervals: RecallSearchActivityIntervalGroup[];
  matchCount: number;
  query: string;
  searchedAt: string;
  sessions: RecallSearchSessionGroup[];
  workspaceId: string;
};

// --- GET /v1/sessions/:id/context ---

// `:id` is the anchor SEGMENT id (the same key expandRecallContext / the MCP
// get_session_context handler expand around), not a session id.
export type GetSessionContextRequest = {
  afterTurns?: number | undefined;
  beforeTurns?: number | undefined;
  windowTurns?: number | undefined;
  workspaceId: string;
};

export type RecallExpansionWarning = {
  detail: string;
  kind: 'skipped_content' | 'hard_redacted';
  scope: 'record' | 'turn';
  turnId?: string | undefined;
};

export type RecallExpandedSegment = SegmentMetadata & {
  metadata: JsonRecord;
  searchText: string;
};

export type RecallExpandedTurn = {
  actorKind: string;
  actorLabel: string | null;
  contentParts: unknown[];
  endedAt: string | null;
  harnessTurnId: string | null;
  id: string;
  metadata: JsonRecord;
  model: string | null;
  ordinal: number;
  rawEventIds: string[];
  rawSpan: JsonRecord;
  role: string;
  segments: RecallExpandedSegment[];
  startedAt: string | null;
};

export type RecallContextAnchor = {
  segment: SegmentMetadata;
  turn: TurnMetadata;
};

export type RecallContextExpansion = {
  activityInterval: ActivityIntervalMetadata;
  afterTurns: number;
  anchor: RecallContextAnchor;
  beforeTurns: number;
  rawSessionRecord: RecallRawSessionRecordMetadata;
  session: RecallSessionMetadata;
  sourceBinding: SourceBindingMetadata;
  turns: RecallExpandedTurn[];
  warnings: RecallExpansionWarning[];
  windowTurns: number;
  workspaceId: string;
};

// --- GET /v1/events ---

export type ListEventsRequest = {
  limit?: number | undefined;
  workspaceId: string;
};

export type RawEvent = {
  actorId: string;
  createdAt: string;
  eventType: string;
  externalEventId: string;
  id: string;
  ingestedAt: string;
  occurredAt: string;
  payload: JsonRecord;
  provenance: JsonRecord;
  sessionId: string | null;
  sourceBindingId: string;
  sourceId: string;
  sourceType: string;
  traceId: string | null;
  trustLevel: TrustLevel;
  updatedAt: string;
  workspaceId: string;
};

// --- POST /v1/ingest ---

// The write path (SGA-238). Each item is a raw event (always stored) plus an
// optional session snapshot. The snapshot carries the fields the service cannot
// reconstruct from the envelope + inserted raw-event row: the local-machine
// author/host identity and the transcript body/content-type/locator. The service
// derives capturedAt (from the raw event's occurredAt) and the settlement trigger
// (the inserted raw event's id) itself, so they are absent here. Ingest STORES
// only; the extraction job derives turns/segments asynchronously.
export type IngestSnapshotActivity = {
  hookEventName?: string | undefined;
  sessionStartSource?: string | undefined;
};

export type IngestSnapshot = {
  activity?: IngestSnapshotActivity | undefined;
  author: {
    displayName?: string | undefined;
    externalSubject?: string | undefined;
    handle: string;
  };
  contentType: 'json' | 'jsonl' | 'text';
  harness: 'claude' | 'codex';
  harnessMetadata?: JsonRecord | undefined;
  harnessSessionId?: string | undefined;
  host: {
    id: string;
    label?: string | undefined;
    projectRoot?: string | undefined;
  };
  locator?: string | undefined;
  metadata?: JsonRecord | undefined;
  model?: string | undefined;
  provenance?: JsonRecord | undefined;
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

// A per-item ack. `status` is 'stored' for a newly persisted item, 'duplicate'
// for an idempotent no-op, or 'error' when that one item failed (the batch is
// non-transactional, so siblings still succeed). Acks mean STORED, not derived.
export type IngestItemResult = {
  code?: string | undefined;
  externalEventId: string;
  rawEventId?: string | undefined;
  rawSessionRecordId?: string | undefined;
  status: 'stored' | 'duplicate' | 'error';
};

export type IngestResponse = {
  results: IngestItemResult[];
};

// --- Errors ---

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
};
