import { Data, Effect } from "effect";
import type { DatabaseError, DatabaseService } from "./database.js";
import { safeContentPartsForSkippedSegments } from "./session-content-redaction.js";

const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 100;
const DEFAULT_MAX_RAW_RECORDS = 10;
const DEFAULT_MAX_TURNS = 50;
const DEFAULT_MAX_SEGMENTS_PER_TURN = 5;
const MAX_RAW_RECORDS = 50;
const MAX_TURNS = 500;
const MAX_SEGMENTS_PER_TURN = 25;

type JsonRecord = Record<string, unknown>;
type TimestampValue = Date | string | null;

export interface ListRecentSessionRecordsInput {
  activeOnly?: boolean | undefined;
  harness?: string | undefined;
  limit?: number | undefined;
  workspaceId: string;
}

export interface RecentSessionRecord {
  activityInterval: SessionActivityIntervalMetadata | null;
  authorUser: SessionHostUserMetadata;
  counts: {
    activityIntervals: number;
    rawSessionRecords: number;
    segments: number;
    turns: number;
  };
  rawSessionRecord: SessionRawSessionRecordMetadata;
  session: SessionMetadata;
  sourceBinding: SessionSourceBindingMetadata;
}

export interface GetSessionDetailInput {
  id: string;
  includeRawBody?: boolean | undefined;
  maxRawRecords?: number | undefined;
  maxSegmentsPerTurn?: number | undefined;
  maxTurns?: number | undefined;
  workspaceId: string;
}

export interface SessionDetail {
  activeRawSessionRecord: SessionRawSessionRecordMetadata | null;
  activityIntervals: SessionDetailActivityInterval[];
  authorUser: SessionHostUserMetadata;
  limits: {
    includeRawBody: boolean;
    maxRawRecords: number;
    maxSegmentsPerTurn: number;
    maxTurns: number;
  };
  rawSessionRecords: SessionRawSessionRecordMetadata[];
  selectedRawSessionRecord: SessionRawSessionRecordMetadata | null;
  session: SessionMetadata;
  sourceBinding: SessionSourceBindingMetadata;
  truncated: {
    rawSessionRecords: boolean;
    segments: boolean;
    turns: boolean;
  };
}

export interface SessionDetailActivityInterval {
  activityInterval: SessionActivityIntervalMetadata;
  turns: SessionDetailTurn[];
}

export interface SessionDetailTurn {
  contentParts: unknown[];
  endedAt: Date | null;
  metadata: JsonRecord;
  rawEventIds: string[];
  rawSpan: JsonRecord;
  segments: SessionDetailSegment[];
  startedAt: Date | null;
  turn: SessionTurnMetadata;
}

export interface SessionDetailSegment extends SessionSegmentMetadata {
  metadata: JsonRecord;
  searchText: string;
}

export interface SessionMetadata {
  endedAt: Date | null;
  harness: string;
  harnessSessionId: string | null;
  id: string;
  lastActivityAt: Date | null;
  metadata: JsonRecord;
  model: string | null;
  provenance: JsonRecord;
  sourceBindingId: string;
  sourceLocator: string | null;
  startedAt: Date | null;
  status: string;
  title: string | null;
  workspaceId: string;
}

export interface SessionHostUserMetadata {
  displayName: string | null;
  externalSubject: string | null;
  handle: string;
  id: string;
  identitySource: string;
  metadata: JsonRecord;
}

export interface SessionSourceBindingMetadata {
  config: JsonRecord;
  displayName: string | null;
  enabled: boolean;
  id: string;
  sourceType: string;
  sourceUri: string;
}

export interface SessionActivityIntervalMetadata {
  endedAt: Date | null;
  id: string;
  metadata: JsonRecord;
  ordinal: number;
  sessionId: string;
  settledAt: Date | null;
  settlementReason: string | null;
  startedAt: Date;
  status: string;
}

export interface SessionRawSessionRecordMetadata {
  bodyJson?: unknown;
  bodyText?: string | null;
  capturedAt: Date;
  contentBytes: number | null;
  contentHash: string;
  contentType: string;
  harness: string;
  harnessSessionId: string | null;
  id: string;
  isActive: boolean;
  metadata: JsonRecord;
  provenance: JsonRecord;
  sessionId: string;
  snapshotOrdinal: number;
  sourceLocator: string | null;
  status: string;
}

export interface SessionTurnMetadata {
  actorKind: string;
  actorLabel: string | null;
  harnessTurnId: string | null;
  id: string;
  model: string | null;
  ordinal: number;
  role: string;
}

export interface SessionSegmentMetadata {
  charEnd: number | null;
  charStart: number | null;
  id: string;
  ordinal: number;
  segmentKind: string;
  snippet: string | null;
  tokenEnd: number | null;
  tokenStart: number | null;
}

export class SessionRecordQueryError extends Data.TaggedError("SessionRecordQueryError")<{
  readonly message: string;
}> {}

interface RecentSessionRecordRow extends CommonSessionRow {
  activity_interval_ended_at: TimestampValue;
  activity_interval_id: string | null;
  activity_interval_metadata: JsonRecord | null;
  activity_interval_ordinal: number | null;
  activity_interval_session_id: string | null;
  activity_interval_settled_at: TimestampValue;
  activity_interval_settlement_reason: string | null;
  activity_interval_started_at: TimestampValue;
  activity_interval_status: string | null;
  activity_intervals_count: number | string;
  raw_records_count: number | string;
  segments_count: number | string;
  turns_count: number | string;
}

interface CommonSessionRow {
  author_display_name: string | null;
  author_external_subject: string | null;
  author_handle: string;
  author_id: string;
  author_identity_source: string;
  author_metadata: JsonRecord;
  raw_record_body_json?: unknown;
  raw_record_body_text?: string | null;
  raw_record_captured_at: Date | string;
  raw_record_content_bytes: number | null;
  raw_record_content_hash: string;
  raw_record_content_type: string;
  raw_record_harness: string;
  raw_record_harness_session_id: string | null;
  raw_record_id: string;
  raw_record_is_active: boolean;
  raw_record_metadata: JsonRecord;
  raw_record_provenance: JsonRecord;
  raw_record_session_id: string;
  raw_record_snapshot_ordinal: number;
  raw_record_source_locator: string | null;
  raw_record_status: string;
  session_ended_at: TimestampValue;
  session_harness: string;
  session_harness_session_id: string | null;
  session_id: string;
  session_last_activity_at: TimestampValue;
  session_metadata: JsonRecord;
  session_model: string | null;
  session_provenance: JsonRecord;
  session_source_binding_id: string;
  session_source_locator: string | null;
  session_started_at: TimestampValue;
  session_status: string;
  session_title: string | null;
  session_workspace_id: string;
  source_binding_config: JsonRecord;
  source_binding_display_name: string | null;
  source_binding_enabled: boolean;
  source_binding_id: string;
  source_binding_source_type: string;
  source_binding_source_uri: string;
}

interface SessionIdentityRow {
  selected_raw_record_id: string | null;
  session_id: string;
}

interface SessionMetadataRow extends CommonSessionRow {}

interface ActivityIntervalRow {
  activity_interval_ended_at: TimestampValue;
  activity_interval_id: string;
  activity_interval_metadata: JsonRecord;
  activity_interval_ordinal: number;
  activity_interval_session_id: string;
  activity_interval_settled_at: TimestampValue;
  activity_interval_settlement_reason: string | null;
  activity_interval_started_at: Date | string;
  activity_interval_status: string;
}

interface TurnRow extends ActivityIntervalRow {
  turn_actor_kind: string;
  turn_actor_label: string | null;
  turn_content_parts: unknown[];
  turn_ended_at: TimestampValue;
  turn_harness_turn_id: string | null;
  turn_id: string;
  turn_metadata: JsonRecord;
  turn_model: string | null;
  turn_ordinal: number;
  turn_raw_event_ids: string[];
  turn_raw_session_record_id: string;
  turn_raw_span: JsonRecord;
  turn_role: string;
  turn_started_at: TimestampValue;
}

interface SegmentRow {
  segment_char_end: number | null;
  segment_char_start: number | null;
  segment_id: string;
  segment_kind: string;
  segment_metadata: JsonRecord;
  segment_ordinal: number;
  segment_search_text: string;
  segment_snippet: string | null;
  segment_token_end: number | null;
  segment_token_start: number | null;
  segment_turn_id: string;
  segment_rank: number | string;
}

export function listRecentSessionRecords(
  service: DatabaseService,
  input: ListRecentSessionRecordsInput,
): Effect.Effect<RecentSessionRecord[], DatabaseError | SessionRecordQueryError> {
  return Effect.tryPromise({
    try: async () => {
      const workspaceId = normalizeWorkspaceId(input.workspaceId);
      const harness = cleanOptional(input.harness);
      const limit = normalizePositiveInt(input.limit, {
        defaultValue: DEFAULT_RECENT_LIMIT,
        label: "limit",
        max: MAX_RECENT_LIMIT,
      });
      const activeOnly = input.activeOnly === true;

      const rows = await service.sql<RecentSessionRecordRow[]>`
        select
          s.id as session_id,
          s.workspace_id as session_workspace_id,
          s.source_binding_id as session_source_binding_id,
          s.harness as session_harness,
          s.harness_session_id as session_harness_session_id,
          s.source_locator as session_source_locator,
          s.title as session_title,
          s.model as session_model,
          s.status as session_status,
          s.started_at as session_started_at,
          s.last_activity_at as session_last_activity_at,
          s.ended_at as session_ended_at,
          s.metadata as session_metadata,
          s.provenance as session_provenance,
          u.id as author_id,
          u.handle as author_handle,
          u.display_name as author_display_name,
          u.identity_source as author_identity_source,
          u.external_subject as author_external_subject,
          u.metadata as author_metadata,
          sb.id as source_binding_id,
          sb.source_type as source_binding_source_type,
          sb.source_uri as source_binding_source_uri,
          sb.display_name as source_binding_display_name,
          sb.config as source_binding_config,
          sb.enabled as source_binding_enabled,
          r.id as raw_record_id,
          r.session_id as raw_record_session_id,
          r.snapshot_ordinal as raw_record_snapshot_ordinal,
          r.is_active as raw_record_is_active,
          r.status as raw_record_status,
          r.harness as raw_record_harness,
          r.harness_session_id as raw_record_harness_session_id,
          r.source_locator as raw_record_source_locator,
          r.content_type as raw_record_content_type,
          r.content_hash as raw_record_content_hash,
          r.content_bytes as raw_record_content_bytes,
          r.captured_at as raw_record_captured_at,
          r.provenance as raw_record_provenance,
          r.metadata as raw_record_metadata,
          ai.id as activity_interval_id,
          ai.session_id as activity_interval_session_id,
          ai.ordinal as activity_interval_ordinal,
          ai.status as activity_interval_status,
          ai.started_at as activity_interval_started_at,
          ai.ended_at as activity_interval_ended_at,
          ai.settled_at as activity_interval_settled_at,
          ai.settlement_reason as activity_interval_settlement_reason,
          ai.metadata as activity_interval_metadata,
          coalesce(count(distinct all_ai.id), 0)::int as activity_intervals_count,
          coalesce(count(distinct all_r.id), 0)::int as raw_records_count,
          coalesce(count(distinct st.id), 0)::int as turns_count,
          coalesce(count(distinct ss.id), 0)::int as segments_count
        from raw_session_records r
        inner join sessions s
          on s.id = r.session_id
          and s.workspace_id = r.workspace_id
        inner join users u
          on u.id = r.author_user_id
          and u.workspace_id = r.workspace_id
        inner join source_bindings sb
          on sb.id = r.source_binding_id
          and sb.workspace_id = r.workspace_id
        left join activity_intervals ai
          on ai.id = r.activity_interval_id
          and ai.workspace_id = r.workspace_id
        left join activity_intervals all_ai
          on all_ai.session_id = s.id
          and all_ai.workspace_id = s.workspace_id
        left join raw_session_records all_r
          on all_r.session_id = s.id
          and all_r.workspace_id = s.workspace_id
        left join session_turns st
          on st.raw_session_record_id = r.id
          and st.workspace_id = r.workspace_id
        left join session_segments ss
          on ss.raw_session_record_id = r.id
          and ss.workspace_id = r.workspace_id
        where r.workspace_id = ${workspaceId}
          and (${harness ?? null}::text is null or r.harness = ${harness ?? null})
          and (${activeOnly}::boolean = false or r.is_active = true)
          and (r.is_active = true or r.status <> 'redacted')
        group by
          s.id,
          u.id,
          sb.id,
          r.id,
          ai.id
        order by r.captured_at desc, r.created_at desc, r.id asc
        limit ${limit}
      `;

      return rows.map(mapRecentSessionRecordRow);
    },
    catch: (cause) =>
      cause instanceof SessionRecordQueryError
        ? cause
        : new SessionRecordQueryError({ message: errorMessage(cause) }),
  });
}

export function getSessionDetail(
  service: DatabaseService,
  input: GetSessionDetailInput,
): Effect.Effect<SessionDetail, DatabaseError | SessionRecordQueryError> {
  return Effect.tryPromise({
    try: async () => {
      const workspaceId = normalizeWorkspaceId(input.workspaceId);
      const id = cleanOptional(input.id);
      if (id === undefined) {
        throw new SessionRecordQueryError({
          message: "session or raw session record id is required",
        });
      }

      const maxRawRecords = normalizePositiveInt(input.maxRawRecords, {
        defaultValue: DEFAULT_MAX_RAW_RECORDS,
        label: "raw-records",
        max: MAX_RAW_RECORDS,
      });
      const maxTurns = normalizePositiveInt(input.maxTurns, {
        defaultValue: DEFAULT_MAX_TURNS,
        label: "turns",
        max: MAX_TURNS,
      });
      const maxSegmentsPerTurn = normalizePositiveInt(input.maxSegmentsPerTurn, {
        defaultValue: DEFAULT_MAX_SEGMENTS_PER_TURN,
        label: "segments",
        max: MAX_SEGMENTS_PER_TURN,
      });
      const includeRawBody = input.includeRawBody === true;

      const identityRows = await service.sql<SessionIdentityRow[]>`
        select s.id as session_id, null::uuid as selected_raw_record_id
        from sessions s
        where s.workspace_id = ${workspaceId}
          and s.id::text = ${id}
        union all
        select r.session_id as session_id, r.id as selected_raw_record_id
        from raw_session_records r
        where r.workspace_id = ${workspaceId}
          and r.id::text = ${id}
        limit 1
      `;
      const identity = identityRows[0];
      if (identity === undefined) {
        throw new SessionRecordQueryError({
          message: `session or raw session record not found: ${id}`,
        });
      }

      const metadataRows = await service.sql<SessionMetadataRow[]>`
        select
          s.id as session_id,
          s.workspace_id as session_workspace_id,
          s.source_binding_id as session_source_binding_id,
          s.harness as session_harness,
          s.harness_session_id as session_harness_session_id,
          s.source_locator as session_source_locator,
          s.title as session_title,
          s.model as session_model,
          s.status as session_status,
          s.started_at as session_started_at,
          s.last_activity_at as session_last_activity_at,
          s.ended_at as session_ended_at,
          s.metadata as session_metadata,
          s.provenance as session_provenance,
          u.id as author_id,
          u.handle as author_handle,
          u.display_name as author_display_name,
          u.identity_source as author_identity_source,
          u.external_subject as author_external_subject,
          u.metadata as author_metadata,
          sb.id as source_binding_id,
          sb.source_type as source_binding_source_type,
          sb.source_uri as source_binding_source_uri,
          sb.display_name as source_binding_display_name,
          sb.config as source_binding_config,
          sb.enabled as source_binding_enabled,
          r.id as raw_record_id,
          r.session_id as raw_record_session_id,
          r.snapshot_ordinal as raw_record_snapshot_ordinal,
          r.is_active as raw_record_is_active,
          r.status as raw_record_status,
          r.harness as raw_record_harness,
          r.harness_session_id as raw_record_harness_session_id,
          r.source_locator as raw_record_source_locator,
          r.content_type as raw_record_content_type,
          r.content_hash as raw_record_content_hash,
          r.content_bytes as raw_record_content_bytes,
          r.captured_at as raw_record_captured_at,
          r.provenance as raw_record_provenance,
          r.metadata as raw_record_metadata
        from sessions s
        inner join users u
          on u.id = s.author_user_id
          and u.workspace_id = s.workspace_id
        inner join source_bindings sb
          on sb.id = s.source_binding_id
          and sb.workspace_id = s.workspace_id
        inner join raw_session_records r
          on r.session_id = s.id
          and r.workspace_id = s.workspace_id
          and r.is_active = true
        where s.workspace_id = ${workspaceId}
          and s.id = ${identity.session_id}
        limit 1
      `;
      const metadata = metadataRows[0];
      if (metadata === undefined) {
        throw new SessionRecordQueryError({ message: `session not found: ${identity.session_id}` });
      }

      const rawRecordRows = await service.sql<CommonSessionRow[]>`
        select
          s.id as session_id,
          s.workspace_id as session_workspace_id,
          s.source_binding_id as session_source_binding_id,
          s.harness as session_harness,
          s.harness_session_id as session_harness_session_id,
          s.source_locator as session_source_locator,
          s.title as session_title,
          s.model as session_model,
          s.status as session_status,
          s.started_at as session_started_at,
          s.last_activity_at as session_last_activity_at,
          s.ended_at as session_ended_at,
          s.metadata as session_metadata,
          s.provenance as session_provenance,
          u.id as author_id,
          u.handle as author_handle,
          u.display_name as author_display_name,
          u.identity_source as author_identity_source,
          u.external_subject as author_external_subject,
          u.metadata as author_metadata,
          sb.id as source_binding_id,
          sb.source_type as source_binding_source_type,
          sb.source_uri as source_binding_source_uri,
          sb.display_name as source_binding_display_name,
          sb.config as source_binding_config,
          sb.enabled as source_binding_enabled,
          r.id as raw_record_id,
          r.session_id as raw_record_session_id,
          r.snapshot_ordinal as raw_record_snapshot_ordinal,
          r.is_active as raw_record_is_active,
          r.status as raw_record_status,
          r.harness as raw_record_harness,
          r.harness_session_id as raw_record_harness_session_id,
          r.source_locator as raw_record_source_locator,
          r.content_type as raw_record_content_type,
          r.content_hash as raw_record_content_hash,
          r.content_bytes as raw_record_content_bytes,
          r.captured_at as raw_record_captured_at,
          r.provenance as raw_record_provenance,
          r.metadata as raw_record_metadata,
          case when ${includeRawBody}::boolean and r.is_active = true then r.body_text else null end as raw_record_body_text,
          case when ${includeRawBody}::boolean and r.is_active = true then r.body_json else null end as raw_record_body_json
        from raw_session_records r
        inner join sessions s
          on s.id = r.session_id
          and s.workspace_id = r.workspace_id
        inner join users u
          on u.id = s.author_user_id
          and u.workspace_id = s.workspace_id
        inner join source_bindings sb
          on sb.id = s.source_binding_id
          and sb.workspace_id = s.workspace_id
        where r.workspace_id = ${workspaceId}
          and r.session_id = ${identity.session_id}
          and (r.is_active = true or r.status <> 'redacted')
        order by r.snapshot_ordinal desc, r.captured_at desc, r.id asc
        limit ${maxRawRecords + 1}
      `;
      const rawRecords = rawRecordRows
        .slice(0, maxRawRecords)
        .map((row) => mapRawSessionRecord(row, { includeRawBody }));
      const activeRawSessionRecord =
        rawRecords.find((record) => record.isActive) ??
        mapRawSessionRecord(metadata, { includeRawBody: false });
      let selectedRawSessionRecord =
        identity.selected_raw_record_id === null
          ? null
          : (rawRecords.find((record) => record.id === identity.selected_raw_record_id) ?? null);
      if (identity.selected_raw_record_id !== null && selectedRawSessionRecord === null) {
        const selectedRows = await service.sql<CommonSessionRow[]>`
          select
            s.id as session_id,
            s.workspace_id as session_workspace_id,
            s.source_binding_id as session_source_binding_id,
            s.harness as session_harness,
            s.harness_session_id as session_harness_session_id,
            s.source_locator as session_source_locator,
            s.title as session_title,
            s.model as session_model,
            s.status as session_status,
            s.started_at as session_started_at,
            s.last_activity_at as session_last_activity_at,
            s.ended_at as session_ended_at,
            s.metadata as session_metadata,
            s.provenance as session_provenance,
            u.id as author_id,
            u.handle as author_handle,
            u.display_name as author_display_name,
            u.identity_source as author_identity_source,
            u.external_subject as author_external_subject,
            u.metadata as author_metadata,
            sb.id as source_binding_id,
            sb.source_type as source_binding_source_type,
            sb.source_uri as source_binding_source_uri,
            sb.display_name as source_binding_display_name,
            sb.config as source_binding_config,
            sb.enabled as source_binding_enabled,
            r.id as raw_record_id,
            r.session_id as raw_record_session_id,
            r.snapshot_ordinal as raw_record_snapshot_ordinal,
            r.is_active as raw_record_is_active,
            r.status as raw_record_status,
            r.harness as raw_record_harness,
            r.harness_session_id as raw_record_harness_session_id,
            r.source_locator as raw_record_source_locator,
            r.content_type as raw_record_content_type,
            r.content_hash as raw_record_content_hash,
            r.content_bytes as raw_record_content_bytes,
            r.captured_at as raw_record_captured_at,
            r.provenance as raw_record_provenance,
            r.metadata as raw_record_metadata,
            case when ${includeRawBody}::boolean and r.is_active = true then r.body_text else null end as raw_record_body_text,
            case when ${includeRawBody}::boolean and r.is_active = true then r.body_json else null end as raw_record_body_json
          from raw_session_records r
          inner join sessions s
            on s.id = r.session_id
            and s.workspace_id = r.workspace_id
          inner join users u
            on u.id = s.author_user_id
            and u.workspace_id = s.workspace_id
          inner join source_bindings sb
            on sb.id = s.source_binding_id
            and sb.workspace_id = s.workspace_id
          where r.workspace_id = ${workspaceId}
            and r.session_id = ${identity.session_id}
            and r.id = ${identity.selected_raw_record_id}
            and (r.is_active = true or r.status <> 'redacted')
          limit 1
        `;
        selectedRawSessionRecord =
          selectedRows[0] === undefined
            ? null
            : mapRawSessionRecord(selectedRows[0], { includeRawBody });
      }
      const detailRawRecordId =
        selectedRawSessionRecord?.id ?? activeRawSessionRecord?.id ?? rawRecords[0]?.id;

      const activityIntervalRows = await service.sql<ActivityIntervalRow[]>`
        select
          ai.id as activity_interval_id,
          ai.session_id as activity_interval_session_id,
          ai.ordinal as activity_interval_ordinal,
          ai.status as activity_interval_status,
          ai.started_at as activity_interval_started_at,
          ai.ended_at as activity_interval_ended_at,
          ai.settled_at as activity_interval_settled_at,
          ai.settlement_reason as activity_interval_settlement_reason,
          ai.metadata as activity_interval_metadata
        from activity_intervals ai
        where ai.workspace_id = ${workspaceId}
          and ai.session_id = ${identity.session_id}
        order by ai.ordinal asc
      `;

      const turnRows =
        detailRawRecordId === undefined
          ? []
          : await service.sql<TurnRow[]>`
              select
                ai.id as activity_interval_id,
                ai.session_id as activity_interval_session_id,
                ai.ordinal as activity_interval_ordinal,
                ai.status as activity_interval_status,
                ai.started_at as activity_interval_started_at,
                ai.ended_at as activity_interval_ended_at,
                ai.settled_at as activity_interval_settled_at,
                ai.settlement_reason as activity_interval_settlement_reason,
                ai.metadata as activity_interval_metadata,
                st.id as turn_id,
                st.raw_session_record_id as turn_raw_session_record_id,
                st.ordinal as turn_ordinal,
                st.harness_turn_id as turn_harness_turn_id,
                st.role as turn_role,
                st.actor_kind as turn_actor_kind,
                st.actor_label as turn_actor_label,
                st.model as turn_model,
                st.started_at as turn_started_at,
                st.ended_at as turn_ended_at,
                st.content_parts as turn_content_parts,
                st.raw_event_ids as turn_raw_event_ids,
                st.raw_span as turn_raw_span,
                st.metadata as turn_metadata
              from session_turns st
              inner join activity_intervals ai
                on ai.id = st.activity_interval_id
                and ai.workspace_id = st.workspace_id
              where st.workspace_id = ${workspaceId}
                and st.session_id = ${identity.session_id}
                and st.raw_session_record_id = ${detailRawRecordId}
              order by st.ordinal asc
              limit ${maxTurns + 1}
            `;
      const visibleTurnRows = turnRows.slice(0, maxTurns);
      const turnIds = visibleTurnRows.map((row) => row.turn_id);

      const segmentRows =
        turnIds.length === 0
          ? []
          : await service.sql<SegmentRow[]>`
              select *
              from (
                select
                  ss.turn_id as segment_turn_id,
                  ss.id as segment_id,
                  ss.ordinal as segment_ordinal,
                  ss.segment_kind as segment_kind,
                  ss.search_text as segment_search_text,
                  ss.snippet as segment_snippet,
                  ss.token_start as segment_token_start,
                  ss.token_end as segment_token_end,
                  ss.char_start as segment_char_start,
                  ss.char_end as segment_char_end,
                  ss.metadata as segment_metadata,
                  row_number() over (partition by ss.turn_id order by ss.ordinal asc) as segment_rank
                from session_segments ss
                where ss.workspace_id = ${workspaceId}
                  and ss.turn_id = any(${turnIds}::uuid[])
              ) ranked_segments
              where segment_rank <= ${maxSegmentsPerTurn + 1}
              order by segment_turn_id asc, segment_ordinal asc
            `;
      const visibleSegmentRows = segmentRows.filter(
        (row) => Number(row.segment_rank) <= maxSegmentsPerTurn,
      );
      const skippedSegmentRows =
        turnIds.length === 0
          ? []
          : await service.sql<SegmentRow[]>`
              select
                ss.turn_id as segment_turn_id,
                ss.id as segment_id,
                ss.ordinal as segment_ordinal,
                ss.segment_kind as segment_kind,
                ss.search_text as segment_search_text,
                ss.snippet as segment_snippet,
                ss.token_start as segment_token_start,
                ss.token_end as segment_token_end,
                ss.char_start as segment_char_start,
                ss.char_end as segment_char_end,
                ss.metadata as segment_metadata,
                0 as segment_rank
              from session_segments ss
              where ss.workspace_id = ${workspaceId}
                and ss.turn_id = any(${turnIds}::uuid[])
                and (
                  ss.segment_kind in ('turn_skipped', 'tool_group_skipped')
                  or ss.metadata->>'segmentStatus' = 'skipped'
                  or ss.metadata->>'omittedSearchText' = 'true'
                )
              order by ss.turn_id asc, ss.ordinal asc
            `;

      return {
        activeRawSessionRecord,
        activityIntervals: groupActivityIntervals(
          activityIntervalRows,
          visibleTurnRows,
          visibleSegmentRows,
          skippedSegmentRows,
        ),
        authorUser: mapAuthor(metadata),
        limits: {
          includeRawBody,
          maxRawRecords,
          maxSegmentsPerTurn,
          maxTurns,
        },
        rawSessionRecords: rawRecords,
        selectedRawSessionRecord,
        session: mapSession(metadata),
        sourceBinding: mapSourceBinding(metadata),
        truncated: {
          rawSessionRecords: rawRecordRows.length > maxRawRecords,
          segments: segmentRows.some((row) => Number(row.segment_rank) > maxSegmentsPerTurn),
          turns: turnRows.length > maxTurns,
        },
      };
    },
    catch: (cause) =>
      cause instanceof SessionRecordQueryError
        ? cause
        : new SessionRecordQueryError({ message: errorMessage(cause) }),
  });
}

function mapRecentSessionRecordRow(row: RecentSessionRecordRow): RecentSessionRecord {
  return {
    activityInterval:
      row.activity_interval_id === null ? null : mapActivityInterval(row as ActivityIntervalRow),
    authorUser: mapAuthor(row),
    counts: {
      activityIntervals: Number(row.activity_intervals_count),
      rawSessionRecords: Number(row.raw_records_count),
      segments: Number(row.segments_count),
      turns: Number(row.turns_count),
    },
    rawSessionRecord: mapRawSessionRecord(row),
    session: mapSession(row),
    sourceBinding: mapSourceBinding(row),
  };
}

function groupActivityIntervals(
  intervalRows: readonly ActivityIntervalRow[],
  turnRows: readonly TurnRow[],
  segmentRows: readonly SegmentRow[],
  skippedSegmentRows: readonly SegmentRow[],
): SessionDetailActivityInterval[] {
  const segmentsByTurn = new Map<string, SessionDetailSegment[]>();
  for (const row of segmentRows) {
    const existing = segmentsByTurn.get(row.segment_turn_id) ?? [];
    existing.push(mapSegment(row));
    segmentsByTurn.set(row.segment_turn_id, existing);
  }

  const skippedSegmentsByTurn = new Map<string, SessionDetailSegment[]>();
  for (const row of skippedSegmentRows) {
    const existing = skippedSegmentsByTurn.get(row.segment_turn_id) ?? [];
    existing.push(mapSegment(row));
    skippedSegmentsByTurn.set(row.segment_turn_id, existing);
  }

  const turnsByInterval = new Map<string, SessionDetailTurn[]>();
  for (const row of turnRows) {
    const existing = turnsByInterval.get(row.activity_interval_id) ?? [];
    const segments = segmentsByTurn.get(row.turn_id) ?? [];
    existing.push({
      contentParts: safeContentPartsForSkippedSegments(
        row.turn_content_parts,
        skippedSegmentsByTurn.get(row.turn_id) ?? segments,
      ),
      endedAt: normalizeNullableTimestamp(row.turn_ended_at, "turn.endedAt"),
      metadata: row.turn_metadata,
      rawEventIds: row.turn_raw_event_ids,
      rawSpan: row.turn_raw_span,
      segments,
      startedAt: normalizeNullableTimestamp(row.turn_started_at, "turn.startedAt"),
      turn: mapTurn(row),
    });
    turnsByInterval.set(row.activity_interval_id, existing);
  }

  return intervalRows.map((row) => ({
    activityInterval: mapActivityInterval(row),
    turns: turnsByInterval.get(row.activity_interval_id) ?? [],
  }));
}

function mapSession(row: CommonSessionRow): SessionMetadata {
  return {
    endedAt: normalizeNullableTimestamp(row.session_ended_at, "session.endedAt"),
    harness: row.session_harness,
    harnessSessionId: row.session_harness_session_id,
    id: row.session_id,
    lastActivityAt: normalizeNullableTimestamp(
      row.session_last_activity_at,
      "session.lastActivityAt",
    ),
    metadata: row.session_metadata,
    model: row.session_model,
    provenance: row.session_provenance,
    sourceBindingId: row.session_source_binding_id,
    sourceLocator: row.session_source_locator,
    startedAt: normalizeNullableTimestamp(row.session_started_at, "session.startedAt"),
    status: row.session_status,
    title: row.session_title,
    workspaceId: row.session_workspace_id,
  };
}

function mapAuthor(row: CommonSessionRow): SessionHostUserMetadata {
  return {
    displayName: row.author_display_name,
    externalSubject: row.author_external_subject,
    handle: row.author_handle,
    id: row.author_id,
    identitySource: row.author_identity_source,
    metadata: row.author_metadata,
  };
}

function mapSourceBinding(row: CommonSessionRow): SessionSourceBindingMetadata {
  return {
    config: row.source_binding_config,
    displayName: row.source_binding_display_name,
    enabled: row.source_binding_enabled,
    id: row.source_binding_id,
    sourceType: row.source_binding_source_type,
    sourceUri: row.source_binding_source_uri,
  };
}

function mapActivityInterval(row: ActivityIntervalRow): SessionActivityIntervalMetadata {
  return {
    endedAt: normalizeNullableTimestamp(row.activity_interval_ended_at, "activityInterval.endedAt"),
    id: row.activity_interval_id,
    metadata: row.activity_interval_metadata,
    ordinal: row.activity_interval_ordinal,
    sessionId: row.activity_interval_session_id,
    settledAt: normalizeNullableTimestamp(
      row.activity_interval_settled_at,
      "activityInterval.settledAt",
    ),
    settlementReason: row.activity_interval_settlement_reason,
    startedAt: normalizeRequiredTimestamp(
      row.activity_interval_started_at,
      "activityInterval.startedAt",
    ),
    status: row.activity_interval_status,
  };
}

function mapRawSessionRecord(
  row: CommonSessionRow,
  options: { includeRawBody?: boolean } = {},
): SessionRawSessionRecordMetadata {
  return {
    ...(options.includeRawBody === true && Object.hasOwn(row, "raw_record_body_json")
      ? { bodyJson: row.raw_record_body_json }
      : {}),
    ...(options.includeRawBody === true && Object.hasOwn(row, "raw_record_body_text")
      ? { bodyText: row.raw_record_body_text }
      : {}),
    capturedAt: normalizeRequiredTimestamp(
      row.raw_record_captured_at,
      "rawSessionRecord.capturedAt",
    ),
    contentBytes: row.raw_record_content_bytes,
    contentHash: row.raw_record_content_hash,
    contentType: row.raw_record_content_type,
    harness: row.raw_record_harness,
    harnessSessionId: row.raw_record_harness_session_id,
    id: row.raw_record_id,
    isActive: row.raw_record_is_active,
    metadata: row.raw_record_metadata,
    provenance: row.raw_record_provenance,
    sessionId: row.raw_record_session_id,
    snapshotOrdinal: row.raw_record_snapshot_ordinal,
    sourceLocator: row.raw_record_source_locator,
    status: row.raw_record_status,
  };
}

function normalizeNullableTimestamp(value: TimestampValue, label: string): Date | null {
  if (value === null) return null;
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return value;
  } else if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new SessionRecordQueryError({ message: `${label} must be a valid timestamp` });
}

function normalizeRequiredTimestamp(value: Date | string | null, label: string): Date {
  const normalized = normalizeNullableTimestamp(value, label);
  if (normalized === null) {
    throw new SessionRecordQueryError({ message: `${label} is required` });
  }
  return normalized;
}

function mapTurn(row: TurnRow): SessionTurnMetadata {
  return {
    actorKind: row.turn_actor_kind,
    actorLabel: row.turn_actor_label,
    harnessTurnId: row.turn_harness_turn_id,
    id: row.turn_id,
    model: row.turn_model,
    ordinal: row.turn_ordinal,
    role: row.turn_role,
  };
}

function mapSegment(row: SegmentRow): SessionDetailSegment {
  return {
    charEnd: row.segment_char_end,
    charStart: row.segment_char_start,
    id: row.segment_id,
    metadata: row.segment_metadata,
    ordinal: row.segment_ordinal,
    searchText: row.segment_search_text,
    segmentKind: row.segment_kind,
    snippet: row.segment_snippet,
    tokenEnd: row.segment_token_end,
    tokenStart: row.segment_token_start,
  };
}

function normalizeWorkspaceId(value: string): string {
  const workspaceId = value.trim();
  if (workspaceId === "") {
    throw new SessionRecordQueryError({ message: "workspaceId is required" });
  }
  return workspaceId;
}

function normalizePositiveInt(
  value: number | undefined,
  input: { defaultValue: number; label: string; max: number },
): number {
  if (value === undefined) return input.defaultValue;
  if (!Number.isInteger(value) || value < 1) {
    throw new SessionRecordQueryError({ message: `${input.label} must be a positive integer` });
  }
  return Math.min(value, input.max);
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
