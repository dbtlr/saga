import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

const emptyJson = sql`'{}'::jsonb`;
const emptyJsonArray = sql`'[]'::jsonb`;
const pgVector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  fromDriver: (value) =>
    value
      .slice(1, -1)
      .split(',')
      .filter((part) => part !== '')
      .map((part) => Number(part)),
  toDriver: (value) => `[${value.join(',')}]`,
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    handle: text('handle').notNull(),
    displayName: text('display_name'),
    identitySource: text('identity_source').notNull(),
    externalSubject: text('external_subject'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    index('users_workspace_id_idx').on(table.workspaceId),
    uniqueIndex('users_id_workspace_unique').on(table.id, table.workspaceId),
    unique('users_workspace_identity_handle_external_unique')
      .on(table.workspaceId, table.identitySource, table.handle, table.externalSubject)
      .nullsNotDistinct(),
  ],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    handle: text('handle').notNull(),
    displayName: text('display_name'),
    ...timestamps,
  },
  (table) => [uniqueIndex('workspaces_handle_unique').on(table.handle)],
);

export const workspaceProfiles = pgTable('workspace_profiles', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  profile: jsonb('profile').$type<Record<string, unknown>>().notNull().default(emptyJson),
  summary: text('summary'),
  ...timestamps,
});

export const sourceBindings = pgTable(
  'source_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(),
    sourceUri: text('source_uri').notNull(),
    displayName: text('display_name'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default(emptyJson),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index('source_bindings_workspace_id_idx').on(table.workspaceId),
    uniqueIndex('source_bindings_id_workspace_unique').on(table.id, table.workspaceId),
    uniqueIndex('source_bindings_workspace_source_unique').on(
      table.workspaceId,
      table.sourceType,
      table.sourceUri,
    ),
  ],
);

export const rawEvents = pgTable(
  'raw_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceBindingId: uuid('source_binding_id')
      .notNull()
      .references(() => sourceBindings.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    actorId: text('actor_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
    eventType: text('event_type').notNull(),
    externalEventId: text('external_event_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(emptyJson),
    sessionId: text('session_id'),
    traceId: text('trace_id'),
    provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull().default(emptyJson),
    trustLevel: text('trust_level').notNull(),
    ...timestamps,
  },
  (table) => [
    index('raw_events_workspace_occurred_idx').on(table.workspaceId, table.occurredAt),
    index('raw_events_source_session_idx').on(table.sourceType, table.sourceId, table.sessionId),
    uniqueIndex('raw_events_id_workspace_unique').on(table.id, table.workspaceId),
    uniqueIndex('raw_events_source_external_unique').on(
      table.workspaceId,
      table.sourceType,
      table.sourceId,
      table.externalEventId,
    ),
  ],
);

export const claimEvents = pgTable(
  'claim_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    rawEventId: uuid('raw_event_id')
      .notNull()
      .references(() => rawEvents.id, { onDelete: 'cascade' }),
    claimKey: text('claim_key').notNull(),
    eventType: text('event_type').notNull(),
    claimKind: text('claim_kind').notNull(),
    claimText: text('claim_text').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default(emptyJson),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default(emptyJson),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    index('claim_events_workspace_occurred_idx').on(table.workspaceId, table.occurredAt),
    index('claim_events_claim_key_idx').on(table.workspaceId, table.claimKey),
    uniqueIndex('claim_events_raw_event_unique').on(
      table.workspaceId,
      table.eventType,
      table.claimKey,
      table.rawEventId,
    ),
  ],
);

export const currentClaims = pgTable(
  'current_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    latestEventId: uuid('latest_event_id')
      .notNull()
      .references(() => claimEvents.id, { onDelete: 'cascade' }),
    claimKey: text('claim_key').notNull(),
    claimKind: text('claim_kind').notNull(),
    claimText: text('claim_text').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    state: text('state').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default(emptyJson),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default(emptyJson),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    index('current_claims_workspace_state_idx').on(table.workspaceId, table.state),
    uniqueIndex('current_claims_workspace_key_unique').on(table.workspaceId, table.claimKey),
  ],
);

export const contextIndexEntries = pgTable(
  'context_index_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceBindingId: uuid('source_binding_id')
      .notNull()
      .references(() => sourceBindings.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    externalId: text('external_id').notNull(),
    sagaLink: text('saga_link').notNull(),
    importance: doublePrecision('importance').notNull().default(0.5),
    includePolicy: text('include_policy').notNull().default('when_relevant'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    index('context_index_entries_workspace_include_idx').on(
      table.workspaceId,
      table.includePolicy,
      table.importance,
    ),
    index('context_index_entries_source_idx').on(table.sourceBindingId, table.externalId),
    uniqueIndex('context_index_entries_workspace_key_unique').on(table.workspaceId, table.key),
    uniqueIndex('context_index_entries_workspace_link_unique').on(
      table.workspaceId,
      table.sagaLink,
    ),
    uniqueIndex('context_index_entries_workspace_source_external_unique').on(
      table.workspaceId,
      table.sourceBindingId,
      table.externalId,
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceBindingId: uuid('source_binding_id')
      .notNull()
      .references(() => sourceBindings.id, { onDelete: 'cascade' }),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    harness: text('harness').notNull(),
    harnessSessionId: text('harness_session_id'),
    sourceLocator: text('source_locator'),
    sourceLocatorHash: text('source_locator_hash'),
    title: text('title'),
    model: text('model'),
    status: text('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(emptyJson),
    provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    index('sessions_workspace_started_idx').on(table.workspaceId, table.startedAt),
    index('sessions_author_started_idx').on(table.authorUserId, table.startedAt),
    index('sessions_source_binding_idx').on(table.sourceBindingId),
    uniqueIndex('sessions_id_workspace_unique').on(table.id, table.workspaceId),
    uniqueIndex('sessions_workspace_source_harness_session_unique')
      .on(table.workspaceId, table.sourceBindingId, table.harness, table.harnessSessionId)
      .where(sql`${table.harnessSessionId} is not null`),
    uniqueIndex('sessions_workspace_source_harness_locator_unique')
      .on(table.workspaceId, table.sourceBindingId, table.harness, table.sourceLocatorHash)
      .where(sql`${table.harnessSessionId} is null and ${table.sourceLocatorHash} is not null`),
    foreignKey({
      columns: [table.sourceBindingId, table.workspaceId],
      foreignColumns: [sourceBindings.id, sourceBindings.workspaceId],
      name: 'sessions_source_binding_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.authorUserId, table.workspaceId],
      foreignColumns: [users.id, users.workspaceId],
      name: 'sessions_author_workspace_fk',
    }).onDelete('restrict'),
  ],
);

export const activityIntervals = pgTable(
  'activity_intervals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    status: text('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    settlementReason: text('settlement_reason'),
    settlementTriggerRawEventId: uuid('settlement_trigger_raw_event_id').references(
      () => rawEvents.id,
      { onDelete: 'set null' },
    ),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    index('activity_intervals_workspace_started_idx').on(table.workspaceId, table.startedAt),
    index('activity_intervals_session_status_idx').on(table.sessionId, table.status),
    uniqueIndex('activity_intervals_id_workspace_unique').on(table.id, table.workspaceId),
    uniqueIndex('activity_intervals_session_ordinal_unique').on(table.sessionId, table.ordinal),
    check(
      'activity_intervals_settlement_reason_check',
      sql`${table.settlementReason} is null or ${table.settlementReason} in ('stop_event', 'idle_timeout', 'clear_context', 'manual')`,
    ),
    foreignKey({
      columns: [table.sessionId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.workspaceId],
      name: 'activity_intervals_session_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.settlementTriggerRawEventId, table.workspaceId],
      foreignColumns: [rawEvents.id, rawEvents.workspaceId],
      name: 'activity_intervals_settlement_raw_event_workspace_fk',
    }),
  ],
);

export const rawSessionRecords = pgTable(
  'raw_session_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    sourceBindingId: uuid('source_binding_id')
      .notNull()
      .references(() => sourceBindings.id, { onDelete: 'cascade' }),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    activityIntervalId: uuid('activity_interval_id').references(() => activityIntervals.id, {
      onDelete: 'set null',
    }),
    redactedFromRawSessionRecordId: uuid('redacted_from_raw_session_record_id').references(
      (): AnyPgColumn => rawSessionRecords.id,
      { onDelete: 'set null' },
    ),
    snapshotOrdinal: integer('snapshot_ordinal').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    status: text('status').notNull().default('captured'),
    harness: text('harness').notNull(),
    harnessSessionId: text('harness_session_id'),
    sourceLocator: text('source_locator'),
    contentType: text('content_type').notNull(),
    bodyText: text('body_text'),
    bodyJson: jsonb('body_json').$type<unknown>(),
    contentHash: text('content_hash').notNull(),
    contentBytes: integer('content_bytes'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull().default(emptyJson),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    index('raw_session_records_workspace_captured_idx').on(table.workspaceId, table.capturedAt),
    index('raw_session_records_session_idx').on(table.sessionId),
    index('raw_session_records_source_idx').on(table.sourceBindingId, table.harnessSessionId),
    uniqueIndex('raw_session_records_session_snapshot_unique').on(
      table.sessionId,
      table.snapshotOrdinal,
    ),
    uniqueIndex('raw_session_records_id_workspace_unique').on(table.id, table.workspaceId),
    uniqueIndex('raw_session_records_session_content_hash_unique').on(
      table.sessionId,
      table.contentHash,
    ),
    uniqueIndex('raw_session_records_one_active_per_session_idx')
      .on(table.sessionId)
      .where(sql`${table.isActive} = true`),
    check(
      'raw_session_records_content_type_check',
      sql`${table.contentType} in ('jsonl', 'json', 'text')`,
    ),
    foreignKey({
      columns: [table.sessionId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.workspaceId],
      name: 'raw_session_records_session_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.sourceBindingId, table.workspaceId],
      foreignColumns: [sourceBindings.id, sourceBindings.workspaceId],
      name: 'raw_session_records_source_binding_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.authorUserId, table.workspaceId],
      foreignColumns: [users.id, users.workspaceId],
      name: 'raw_session_records_author_workspace_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.activityIntervalId, table.workspaceId],
      foreignColumns: [activityIntervals.id, activityIntervals.workspaceId],
      name: 'raw_session_records_activity_interval_workspace_fk',
    }),
    foreignKey({
      columns: [table.redactedFromRawSessionRecordId, table.workspaceId],
      foreignColumns: [table.id, table.workspaceId],
      name: 'raw_session_records_redacted_from_workspace_fk',
    }),
  ],
);

export const sessionTurns = pgTable(
  'session_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    activityIntervalId: uuid('activity_interval_id')
      .notNull()
      .references(() => activityIntervals.id, { onDelete: 'cascade' }),
    rawSessionRecordId: uuid('raw_session_record_id')
      .notNull()
      .references(() => rawSessionRecords.id, { onDelete: 'cascade' }),
    parentTurnId: uuid('parent_turn_id').references((): AnyPgColumn => sessionTurns.id, {
      onDelete: 'set null',
    }),
    ordinal: integer('ordinal').notNull(),
    harnessTurnId: text('harness_turn_id'),
    role: text('role').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorLabel: text('actor_label'),
    model: text('model'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    contentParts: jsonb('content_parts').$type<unknown[]>().notNull().default(emptyJsonArray),
    rawEventIds: jsonb('raw_event_ids').$type<string[]>().notNull().default(emptyJsonArray),
    rawSpan: jsonb('raw_span').$type<Record<string, unknown>>().notNull().default(emptyJson),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    index('session_turns_session_ordinal_idx').on(table.sessionId, table.ordinal),
    index('session_turns_interval_ordinal_idx').on(table.activityIntervalId, table.ordinal),
    index('session_turns_raw_record_idx').on(table.rawSessionRecordId),
    uniqueIndex('session_turns_id_workspace_unique').on(table.id, table.workspaceId),
    uniqueIndex('session_turns_raw_record_ordinal_unique').on(
      table.rawSessionRecordId,
      table.ordinal,
    ),
    uniqueIndex('session_turns_harness_turn_unique')
      .on(table.sessionId, table.harnessTurnId)
      .where(sql`${table.harnessTurnId} is not null`),
    check(
      'session_turns_role_check',
      sql`${table.role} in ('user', 'assistant', 'tool', 'system', 'subagent')`,
    ),
    check(
      'session_turns_actor_kind_check',
      sql`${table.actorKind} in ('host_user', 'agent', 'tool', 'harness', 'subagent')`,
    ),
    foreignKey({
      columns: [table.sessionId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.workspaceId],
      name: 'session_turns_session_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.activityIntervalId, table.workspaceId],
      foreignColumns: [activityIntervals.id, activityIntervals.workspaceId],
      name: 'session_turns_activity_interval_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.rawSessionRecordId, table.workspaceId],
      foreignColumns: [rawSessionRecords.id, rawSessionRecords.workspaceId],
      name: 'session_turns_raw_record_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.parentTurnId, table.workspaceId],
      foreignColumns: [table.id, table.workspaceId],
      name: 'session_turns_parent_workspace_fk',
    }),
  ],
);

export const sessionRelationships = pgTable(
  'session_relationships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceSessionId: uuid('source_session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    targetSessionId: uuid('target_session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    sourceTurnId: uuid('source_turn_id').references(() => sessionTurns.id, {
      onDelete: 'set null',
    }),
    relationshipType: text('relationship_type').notNull(),
    confidence: text('confidence').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    index('session_relationships_workspace_idx').on(table.workspaceId),
    index('session_relationships_source_idx').on(table.sourceSessionId),
    index('session_relationships_target_idx').on(table.targetSessionId),
    uniqueIndex('session_relationships_id_workspace_unique').on(table.id, table.workspaceId),
    uniqueIndex('session_relationships_unique').on(
      table.workspaceId,
      table.sourceSessionId,
      table.targetSessionId,
      table.relationshipType,
    ),
    check(
      'session_relationships_type_check',
      sql`${table.relationshipType} in ('child', 'continuation')`,
    ),
    check(
      'session_relationships_confidence_check',
      sql`${table.confidence} in ('explicit', 'inferred')`,
    ),
    foreignKey({
      columns: [table.sourceSessionId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.workspaceId],
      name: 'session_relationships_source_session_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.targetSessionId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.workspaceId],
      name: 'session_relationships_target_session_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.sourceTurnId, table.workspaceId],
      foreignColumns: [sessionTurns.id, sessionTurns.workspaceId],
      name: 'session_relationships_source_turn_workspace_fk',
    }),
  ],
);

export const sessionSegments = pgTable(
  'session_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    activityIntervalId: uuid('activity_interval_id')
      .notNull()
      .references(() => activityIntervals.id, { onDelete: 'cascade' }),
    turnId: uuid('turn_id')
      .notNull()
      .references(() => sessionTurns.id, { onDelete: 'cascade' }),
    rawSessionRecordId: uuid('raw_session_record_id')
      .notNull()
      .references(() => rawSessionRecords.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    segmentKind: text('segment_kind').notNull().default('turn'),
    searchText: text('search_text').notNull(),
    snippet: text('snippet'),
    tokenStart: integer('token_start'),
    tokenEnd: integer('token_end'),
    charStart: integer('char_start'),
    charEnd: integer('char_end'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    index('session_segments_session_ordinal_idx').on(table.sessionId, table.ordinal),
    index('session_segments_interval_ordinal_idx').on(table.activityIntervalId, table.ordinal),
    index('session_segments_turn_idx').on(table.turnId),
    index('session_segments_raw_record_idx').on(table.rawSessionRecordId),
    index('session_segments_search_tsv_idx').using(
      'gin',
      sql`to_tsvector('english', ${table.searchText})`,
    ),
    index('session_segments_search_trgm_idx').using('gin', table.searchText.op('gin_trgm_ops')),
    uniqueIndex('session_segments_id_workspace_unique').on(table.id, table.workspaceId),
    uniqueIndex('session_segments_raw_record_ordinal_unique').on(
      table.rawSessionRecordId,
      table.ordinal,
    ),
    foreignKey({
      columns: [table.sessionId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.workspaceId],
      name: 'session_segments_session_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.activityIntervalId, table.workspaceId],
      foreignColumns: [activityIntervals.id, activityIntervals.workspaceId],
      name: 'session_segments_activity_interval_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.turnId, table.workspaceId],
      foreignColumns: [sessionTurns.id, sessionTurns.workspaceId],
      name: 'session_segments_turn_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.rawSessionRecordId, table.workspaceId],
      foreignColumns: [rawSessionRecords.id, rawSessionRecords.workspaceId],
      name: 'session_segments_raw_record_workspace_fk',
    }).onDelete('cascade'),
  ],
);

export const sessionSegmentEmbeddings = pgTable(
  'session_segment_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    segmentId: uuid('segment_id')
      .notNull()
      .references(() => sessionSegments.id, { onDelete: 'cascade' }),
    rawSessionRecordId: uuid('raw_session_record_id')
      .notNull()
      .references(() => rawSessionRecords.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    embedding: pgVector('embedding').notNull(),
    inputHash: text('input_hash').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    index('session_segment_embeddings_workspace_idx').on(table.workspaceId),
    index('session_segment_embeddings_raw_record_idx').on(table.rawSessionRecordId),
    uniqueIndex('session_segment_embeddings_segment_model_unique').on(
      table.segmentId,
      table.provider,
      table.model,
      table.dimensions,
    ),
    check(
      'session_segment_embeddings_dimensions_check',
      sql`vector_dims(${table.embedding}) = ${table.dimensions}`,
    ),
    foreignKey({
      columns: [table.segmentId, table.workspaceId],
      foreignColumns: [sessionSegments.id, sessionSegments.workspaceId],
      name: 'session_segment_embeddings_segment_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.rawSessionRecordId, table.workspaceId],
      foreignColumns: [rawSessionRecords.id, rawSessionRecords.workspaceId],
      name: 'session_segment_embeddings_raw_record_workspace_fk',
    }).onDelete('cascade'),
  ],
);

export const workspaceRelations = relations(workspaces, ({ many, one }) => ({
  activityIntervals: many(activityIntervals),
  claimEvents: many(claimEvents),
  contextIndexEntries: many(contextIndexEntries),
  currentClaims: many(currentClaims),
  profile: one(workspaceProfiles),
  rawEvents: many(rawEvents),
  rawSessionRecords: many(rawSessionRecords),
  sessionRelationships: many(sessionRelationships),
  sessionSegmentEmbeddings: many(sessionSegmentEmbeddings),
  sessionSegments: many(sessionSegments),
  sessionTurns: many(sessionTurns),
  sessions: many(sessions),
  sourceBindings: many(sourceBindings),
  users: many(users),
}));

export const userRelations = relations(users, ({ many, one }) => ({
  rawSessionRecords: many(rawSessionRecords),
  sessions: many(sessions),
  workspace: one(workspaces, {
    fields: [users.workspaceId],
    references: [workspaces.id],
  }),
}));

export const workspaceProfileRelations = relations(workspaceProfiles, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceProfiles.workspaceId],
    references: [workspaces.id],
  }),
}));

export const sourceBindingRelations = relations(sourceBindings, ({ many, one }) => ({
  rawSessionRecords: many(rawSessionRecords),
  sessions: many(sessions),
  workspace: one(workspaces, {
    fields: [sourceBindings.workspaceId],
    references: [workspaces.id],
  }),
}));

export const rawEventRelations = relations(rawEvents, ({ one }) => ({
  sourceBinding: one(sourceBindings, {
    fields: [rawEvents.sourceBindingId],
    references: [sourceBindings.id],
  }),
  workspace: one(workspaces, {
    fields: [rawEvents.workspaceId],
    references: [workspaces.id],
  }),
}));

export const claimEventRelations = relations(claimEvents, ({ one }) => ({
  rawEvent: one(rawEvents, {
    fields: [claimEvents.rawEventId],
    references: [rawEvents.id],
  }),
  workspace: one(workspaces, {
    fields: [claimEvents.workspaceId],
    references: [workspaces.id],
  }),
}));

export const currentClaimRelations = relations(currentClaims, ({ one }) => ({
  latestEvent: one(claimEvents, {
    fields: [currentClaims.latestEventId],
    references: [claimEvents.id],
  }),
  workspace: one(workspaces, {
    fields: [currentClaims.workspaceId],
    references: [workspaces.id],
  }),
}));

export const contextIndexEntryRelations = relations(contextIndexEntries, ({ one }) => ({
  sourceBinding: one(sourceBindings, {
    fields: [contextIndexEntries.sourceBindingId],
    references: [sourceBindings.id],
  }),
  workspace: one(workspaces, {
    fields: [contextIndexEntries.workspaceId],
    references: [workspaces.id],
  }),
}));

export const sessionRelations = relations(sessions, ({ many, one }) => ({
  activityIntervals: many(activityIntervals),
  authorUser: one(users, {
    fields: [sessions.authorUserId],
    references: [users.id],
  }),
  rawSessionRecords: many(rawSessionRecords),
  sourceBinding: one(sourceBindings, {
    fields: [sessions.sourceBindingId],
    references: [sourceBindings.id],
  }),
  workspace: one(workspaces, {
    fields: [sessions.workspaceId],
    references: [workspaces.id],
  }),
}));

export const activityIntervalRelations = relations(activityIntervals, ({ many, one }) => ({
  rawSessionRecords: many(rawSessionRecords),
  segments: many(sessionSegments),
  session: one(sessions, {
    fields: [activityIntervals.sessionId],
    references: [sessions.id],
  }),
  settlementTriggerRawEvent: one(rawEvents, {
    fields: [activityIntervals.settlementTriggerRawEventId],
    references: [rawEvents.id],
  }),
  turns: many(sessionTurns),
  workspace: one(workspaces, {
    fields: [activityIntervals.workspaceId],
    references: [workspaces.id],
  }),
}));

export const rawSessionRecordRelations = relations(rawSessionRecords, ({ many, one }) => ({
  activityInterval: one(activityIntervals, {
    fields: [rawSessionRecords.activityIntervalId],
    references: [activityIntervals.id],
  }),
  authorUser: one(users, {
    fields: [rawSessionRecords.authorUserId],
    references: [users.id],
  }),
  embeddings: many(sessionSegmentEmbeddings),
  segments: many(sessionSegments),
  session: one(sessions, {
    fields: [rawSessionRecords.sessionId],
    references: [sessions.id],
  }),
  sourceBinding: one(sourceBindings, {
    fields: [rawSessionRecords.sourceBindingId],
    references: [sourceBindings.id],
  }),
  turns: many(sessionTurns),
  workspace: one(workspaces, {
    fields: [rawSessionRecords.workspaceId],
    references: [workspaces.id],
  }),
}));

export const sessionTurnRelations = relations(sessionTurns, ({ many, one }) => ({
  activityInterval: one(activityIntervals, {
    fields: [sessionTurns.activityIntervalId],
    references: [activityIntervals.id],
  }),
  rawSessionRecord: one(rawSessionRecords, {
    fields: [sessionTurns.rawSessionRecordId],
    references: [rawSessionRecords.id],
  }),
  segments: many(sessionSegments),
  session: one(sessions, {
    fields: [sessionTurns.sessionId],
    references: [sessions.id],
  }),
  workspace: one(workspaces, {
    fields: [sessionTurns.workspaceId],
    references: [workspaces.id],
  }),
}));

export const sessionRelationshipRelations = relations(sessionRelationships, ({ one }) => ({
  sourceSession: one(sessions, {
    fields: [sessionRelationships.sourceSessionId],
    references: [sessions.id],
  }),
  sourceTurn: one(sessionTurns, {
    fields: [sessionRelationships.sourceTurnId],
    references: [sessionTurns.id],
  }),
  targetSession: one(sessions, {
    fields: [sessionRelationships.targetSessionId],
    references: [sessions.id],
  }),
  workspace: one(workspaces, {
    fields: [sessionRelationships.workspaceId],
    references: [workspaces.id],
  }),
}));

export const sessionSegmentRelations = relations(sessionSegments, ({ many, one }) => ({
  activityInterval: one(activityIntervals, {
    fields: [sessionSegments.activityIntervalId],
    references: [activityIntervals.id],
  }),
  embeddings: many(sessionSegmentEmbeddings),
  rawSessionRecord: one(rawSessionRecords, {
    fields: [sessionSegments.rawSessionRecordId],
    references: [rawSessionRecords.id],
  }),
  session: one(sessions, {
    fields: [sessionSegments.sessionId],
    references: [sessions.id],
  }),
  turn: one(sessionTurns, {
    fields: [sessionSegments.turnId],
    references: [sessionTurns.id],
  }),
  workspace: one(workspaces, {
    fields: [sessionSegments.workspaceId],
    references: [workspaces.id],
  }),
}));

export const sessionSegmentEmbeddingRelations = relations(sessionSegmentEmbeddings, ({ one }) => ({
  rawSessionRecord: one(rawSessionRecords, {
    fields: [sessionSegmentEmbeddings.rawSessionRecordId],
    references: [rawSessionRecords.id],
  }),
  segment: one(sessionSegments, {
    fields: [sessionSegmentEmbeddings.segmentId],
    references: [sessionSegments.id],
  }),
  workspace: one(workspaces, {
    fields: [sessionSegmentEmbeddings.workspaceId],
    references: [workspaces.id],
  }),
}));

export const schema = {
  activityIntervalRelations,
  activityIntervals,
  claimEventRelations,
  claimEvents,
  contextIndexEntries,
  contextIndexEntryRelations,
  currentClaimRelations,
  currentClaims,
  rawEventRelations,
  rawEvents,
  rawSessionRecordRelations,
  rawSessionRecords,
  sessionRelations,
  sessionRelationshipRelations,
  sessionRelationships,
  sessionSegmentEmbeddingRelations,
  sessionSegmentEmbeddings,
  sessionSegmentRelations,
  sessionSegments,
  sessionTurnRelations,
  sessionTurns,
  sessions,
  sourceBindingRelations,
  sourceBindings,
  userRelations,
  users,
  workspaceProfileRelations,
  workspaceProfiles,
  workspaceRelations,
  workspaces,
};

export type SagaSchema = typeof schema;

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceProfile = typeof workspaceProfiles.$inferSelect;
export type NewWorkspaceProfile = typeof workspaceProfiles.$inferInsert;
export type SourceBinding = typeof sourceBindings.$inferSelect;
export type NewSourceBinding = typeof sourceBindings.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RawEvent = typeof rawEvents.$inferSelect;
export type NewRawEvent = typeof rawEvents.$inferInsert;
export type ClaimEvent = typeof claimEvents.$inferSelect;
export type NewClaimEvent = typeof claimEvents.$inferInsert;
export type CurrentClaim = typeof currentClaims.$inferSelect;
export type NewCurrentClaim = typeof currentClaims.$inferInsert;
export type ContextIndexEntry = typeof contextIndexEntries.$inferSelect;
export type NewContextIndexEntry = typeof contextIndexEntries.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type ActivityInterval = typeof activityIntervals.$inferSelect;
export type NewActivityInterval = typeof activityIntervals.$inferInsert;
export type RawSessionRecord = typeof rawSessionRecords.$inferSelect;
export type NewRawSessionRecord = typeof rawSessionRecords.$inferInsert;
export type SessionTurn = typeof sessionTurns.$inferSelect;
export type NewSessionTurn = typeof sessionTurns.$inferInsert;
export type SessionRelationship = typeof sessionRelationships.$inferSelect;
export type NewSessionRelationship = typeof sessionRelationships.$inferInsert;
export type SessionSegment = typeof sessionSegments.$inferSelect;
export type NewSessionSegment = typeof sessionSegments.$inferInsert;
export type SessionSegmentEmbedding = typeof sessionSegmentEmbeddings.$inferSelect;
export type NewSessionSegmentEmbedding = typeof sessionSegmentEmbeddings.$inferInsert;
