import type { EmbeddingProviderBoundary } from '@saga/runtime';
import { Data, Effect } from 'effect';

import type { DatabaseError, DatabaseService } from './database.js';
import {
  safeContentPartsForSkippedSegments,
  summarizeSkippedSegments,
} from './session-content-redaction.js';
import {
  redactAgentFacingJsonRecord,
  redactAgentFacingSourceLocator,
  redactAgentFacingSessionArray,
  redactAgentFacingSessionText,
} from './session-output-redaction.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_TRIGRAM_THRESHOLD = 0.3;
const DEFAULT_CONTEXT_WINDOW_TURNS = 2;
const MAX_CONTEXT_WINDOW_TURNS = 20;

type JsonRecord = Record<string, unknown>;

export type RecallSearchInput = {
  activityIntervalId?: string | undefined;
  // EGRESS SEAM: when set, the query text is sent to this provider for a query embedding.
  // @saga/db is policy-agnostic, so callers MUST gate this on installation embedding policy
  // (ADR 0032) before supplying it — only pass an embeddingProvider/queryEmbedding when
  // remote embeddings are enabled. The CLI gates via resolveQueryEmbedding; SGA-154 must do
  // the same when it makes MCP vector-aware.
  embeddingProvider?: RecallQueryEmbeddingProvider | undefined;
  limit?: number | undefined;
  minTrigramScore?: number | undefined;
  query: string;
  queryEmbedding?: RecallQueryEmbedding | undefined;
  rawSessionRecordId?: string | undefined;
  sessionId?: string | undefined;
  vectorCandidateLimit?: number | undefined;
  workspaceId: string;
};

export type RecallQueryEmbedding = {
  dimensions: number;
  model: string;
  provider: string;
  vector: readonly number[];
};

export type RecallQueryEmbeddingProvider = {
  embedQuery: (input: { query: string }) => Promise<readonly number[]>;
  provider: EmbeddingProviderBoundary;
};

export type RecallSearchResult = {
  intervals: RecallSearchActivityIntervalGroup[];
  matchCount: number;
  query: string;
  searchedAt: string;
  sessions: RecallSearchSessionGroup[];
  workspaceId: string;
};

export type RecallSearchSessionGroup = {
  activityIntervals: RecallSearchActivityIntervalGroup[];
  matches: RecallSegmentMatch[];
  session: RecallSessionMetadata;
};

export type RecallSearchActivityIntervalGroup = {
  activityInterval: RecallActivityIntervalMetadata;
  matches: RecallSegmentMatch[];
  sessionId: string;
};

export type RecallSegmentMatch = {
  activityInterval: RecallActivityIntervalMetadata;
  combinedScore: number;
  rawSessionRecord: RecallRawSessionRecordMetadata;
  segment: RecallSegmentPointer;
  session: RecallSessionMetadata;
  snippet: string;
  sourceBinding: RecallSourceBindingMetadata;
  scores: {
    combined: number;
    lexical: number;
    trigram: number;
    vector?: number | undefined;
  };
  turn: RecallTurnPointer;
};

export type RecallContextExpansionInput = {
  afterTurns?: number | undefined;
  beforeTurns?: number | undefined;
  segmentId: string;
  windowTurns?: number | undefined;
  workspaceId: string;
};

export type RecallContextExpansion = {
  activityInterval: RecallActivityIntervalMetadata;
  anchor: RecallContextAnchor;
  afterTurns: number;
  beforeTurns: number;
  rawSessionRecord: RecallRawSessionRecordMetadata;
  session: RecallSessionMetadata;
  sourceBinding: RecallSourceBindingMetadata;
  turns: RecallExpandedTurn[];
  // Content that is withheld or transformed stays explicit here rather than being silently
  // replaced with indexed text (ADR 0036): skipped payloads keep an inline `omitted`
  // placeholder in the turn content, and each is also surfaced as an aggregate warning so a
  // consumer can tell at a glance whether the expansion is complete.
  warnings: RecallExpansionWarning[];
  windowTurns: number;
  workspaceId: string;
};

export type RecallExpansionWarningKind = 'skipped_content' | 'hard_redacted';

export type RecallExpansionWarning = {
  detail: string;
  kind: RecallExpansionWarningKind;
  scope: 'record' | 'turn';
  turnId?: string | undefined;
};

export type RecallContextAnchor = {
  segment: RecallSegmentPointer;
  turn: RecallTurnPointer;
};

export type RecallExpandedTurn = {
  contentParts: unknown[];
  endedAt: Date | null;
  metadata: JsonRecord;
  rawEventIds: string[];
  rawSpan: JsonRecord;
  segments: RecallExpandedSegment[];
  startedAt: Date | null;
} & RecallTurnPointer;

export type RecallExpandedSegment = {
  metadata: JsonRecord;
  searchText: string;
} & RecallSegmentPointer;

export type RecallSessionMetadata = {
  authorUser: RecallHostUserMetadata;
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
};

export type RecallHostUserMetadata = {
  displayName: string | null;
  externalSubject: string | null;
  handle: string;
  id: string;
  identitySource: string;
  metadata: JsonRecord;
};

export type RecallSourceBindingMetadata = {
  config: JsonRecord;
  displayName: string | null;
  enabled: boolean;
  id: string;
  sourceType: string;
  sourceUri: string;
};

export type RecallActivityIntervalMetadata = {
  endedAt: Date | null;
  id: string;
  metadata: JsonRecord;
  ordinal: number;
  sessionId: string;
  settledAt: Date | null;
  settlementReason: string | null;
  startedAt: Date;
  status: string;
};

export type RecallRawSessionRecordMetadata = {
  capturedAt: Date;
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

export type RecallTurnPointer = {
  actorKind: string;
  actorLabel: string | null;
  harnessTurnId: string | null;
  id: string;
  model: string | null;
  ordinal: number;
  role: string;
};

export type RecallSegmentPointer = {
  charEnd: number | null;
  charStart: number | null;
  id: string;
  ordinal: number;
  segmentKind: string;
  snippet: string | null;
  tokenEnd: number | null;
  tokenStart: number | null;
};

export class RecallSearchError extends Data.TaggedError('RecallSearchError')<{
  readonly message: string;
}> {}

type RecallSearchRow = {
  activity_interval_ended_at: Date | null;
  activity_interval_id: string;
  activity_interval_metadata: JsonRecord;
  activity_interval_ordinal: number;
  activity_interval_session_id: string;
  activity_interval_settled_at: Date | null;
  activity_interval_settlement_reason: string | null;
  activity_interval_started_at: Date;
  activity_interval_status: string;
  author_display_name: string | null;
  author_external_subject: string | null;
  author_handle: string;
  author_id: string;
  author_identity_source: string;
  author_metadata: JsonRecord;
  combined_score: number | string;
  lexical_score: number | string;
  match_snippet: string | null;
  raw_record_captured_at: Date;
  raw_record_content_hash: string;
  raw_record_content_type: string;
  raw_record_harness: string;
  raw_record_harness_session_id: string | null;
  raw_record_id: string;
  raw_record_is_active: boolean;
  raw_record_metadata: JsonRecord;
  raw_record_provenance: JsonRecord;
  raw_record_snapshot_ordinal: number;
  raw_record_source_locator: string | null;
  raw_record_status: string;
  segment_char_end: number | null;
  segment_char_start: number | null;
  segment_id: string;
  segment_kind: string;
  segment_ordinal: number;
  segment_snippet: string | null;
  segment_token_end: number | null;
  segment_token_start: number | null;
  session_ended_at: Date | null;
  session_harness: string;
  session_harness_session_id: string | null;
  session_id: string;
  session_last_activity_at: Date | null;
  session_metadata: JsonRecord;
  session_model: string | null;
  session_provenance: JsonRecord;
  session_source_binding_id: string;
  session_source_locator: string | null;
  session_started_at: Date | null;
  session_status: string;
  session_title: string | null;
  session_workspace_id: string;
  source_binding_config: JsonRecord;
  source_binding_display_name: string | null;
  source_binding_enabled: boolean;
  source_binding_id: string;
  source_binding_source_type: string;
  source_binding_source_uri: string;
  trigram_score: number | string;
  turn_actor_kind: string;
  turn_actor_label: string | null;
  turn_harness_turn_id: string | null;
  turn_id: string;
  turn_model: string | null;
  turn_ordinal: number;
  turn_role: string;
  vector_score: number | string | null;
};

type RecallContextRow = {
  expanded_segment_char_end: number | null;
  expanded_segment_char_start: number | null;
  expanded_segment_id: string | null;
  expanded_segment_kind: string | null;
  expanded_segment_metadata: JsonRecord | null;
  expanded_segment_ordinal: number | null;
  expanded_segment_search_text: string | null;
  expanded_segment_snippet: string | null;
  expanded_segment_token_end: number | null;
  expanded_segment_token_start: number | null;
  expanded_turn_actor_kind: string;
  expanded_turn_actor_label: string | null;
  expanded_turn_content_parts: unknown[];
  expanded_turn_ended_at: Date | null;
  expanded_turn_harness_turn_id: string | null;
  expanded_turn_id: string;
  expanded_turn_metadata: JsonRecord;
  expanded_turn_model: string | null;
  expanded_turn_ordinal: number;
  expanded_turn_raw_event_ids: string[];
  expanded_turn_raw_span: JsonRecord;
  expanded_turn_role: string;
  expanded_turn_started_at: Date | null;
} & RecallSearchRow;

type ResolvedRecallQueryEmbedding = {
  candidateLimit: number;
  dimensions: number;
  model: string;
  provider: string;
  vectorLiteral: string;
};

export function searchSessionRecall(
  service: DatabaseService,
  input: RecallSearchInput,
): Effect.Effect<RecallSearchResult, DatabaseError | RecallSearchError> {
  return Effect.tryPromise({
    try: async () => {
      const query = normalizeQuery(input.query);
      const limit = normalizeLimit(input.limit);
      const minTrigramScore = normalizeTrigramScore(input.minTrigramScore);
      const queryEmbedding = await resolveRecallQueryEmbedding(input, query, limit);
      if (queryEmbedding !== undefined) {
        const rows = await service.sql<RecallSearchRow[]>`
          with recall_settings as (
            select
              set_config('pg_trgm.similarity_threshold', ${minTrigramScore.toString()}, true),
              set_config('pg_trgm.word_similarity_threshold', ${minTrigramScore.toString()}, true)
          ),
          recall_query as (
            select
              websearch_to_tsquery('english', ${query}) as ts_query,
              ${query}::text as query_text,
              ${minTrigramScore}::double precision as min_trigram_score
            from recall_settings
          ),
          eligible_segments as (
            select
              ss.id,
              ss.workspace_id,
              ss.session_id,
              ss.activity_interval_id,
              ss.turn_id,
              ss.raw_session_record_id,
              ss.ordinal,
              ss.segment_kind,
              ss.search_text,
              ss.snippet,
              ss.token_start,
              ss.token_end,
              ss.char_start,
              ss.char_end,
              recall_query.ts_query,
              recall_query.query_text,
              recall_query.min_trigram_score,
              to_tsvector('english', ss.search_text) @@ recall_query.ts_query as lexical_match
            from session_segments ss
            cross join recall_query
            inner join sessions s
              on s.id = ss.session_id
              and s.workspace_id = ss.workspace_id
            inner join source_bindings sb
              on sb.id = s.source_binding_id
              and sb.workspace_id = s.workspace_id
              and sb.enabled = true
            inner join raw_session_records r
              on r.id = ss.raw_session_record_id
              and r.workspace_id = ss.workspace_id
              and r.is_active = true
            where ss.workspace_id = ${input.workspaceId}
              and (${input.sessionId ?? null}::uuid is null or ss.session_id = ${input.sessionId ?? null}::uuid)
              and (${input.activityIntervalId ?? null}::uuid is null or ss.activity_interval_id = ${input.activityIntervalId ?? null}::uuid)
              and (${input.rawSessionRecordId ?? null}::uuid is null or ss.raw_session_record_id = ${input.rawSessionRecordId ?? null}::uuid)
          ),
          lexical_candidates as (
            select id
            from eligible_segments
            where lexical_match
              or search_text % query_text
              or query_text <% search_text
          ),
          vector_candidates as (
            select
              e.segment_id as id,
              greatest(
                0::double precision,
                (1 - (e.embedding <=> ${queryEmbedding.vectorLiteral}::vector))::double precision
              ) as vector_score
            from session_segment_embeddings e
            inner join eligible_segments es
              on es.id = e.segment_id
              and es.workspace_id = e.workspace_id
            where e.provider = ${queryEmbedding.provider}
              and e.model = ${queryEmbedding.model}
              and e.dimensions = ${queryEmbedding.dimensions}
            order by e.embedding <=> ${queryEmbedding.vectorLiteral}::vector, e.segment_id asc
            limit ${queryEmbedding.candidateLimit}
          ),
          candidate_segments as (
            select
              eligible_segments.*,
              vector_candidates.vector_score
            from eligible_segments
            left join vector_candidates
              on vector_candidates.id = eligible_segments.id
            where eligible_segments.id in (select id from lexical_candidates)
              or vector_candidates.id is not null
          ),
          scored as (
            select
              candidate_segments.id as segment_id,
              candidate_segments.workspace_id as segment_workspace_id,
              candidate_segments.session_id as segment_session_id,
              candidate_segments.activity_interval_id as segment_activity_interval_id,
              candidate_segments.turn_id as segment_turn_id,
              candidate_segments.raw_session_record_id as segment_raw_session_record_id,
              candidate_segments.ordinal as segment_ordinal,
              candidate_segments.segment_kind as segment_kind,
              candidate_segments.search_text as segment_search_text,
              candidate_segments.snippet as segment_snippet,
              candidate_segments.token_start as segment_token_start,
              candidate_segments.token_end as segment_token_end,
              candidate_segments.char_start as segment_char_start,
              candidate_segments.char_end as segment_char_end,
              candidate_segments.lexical_match,
              ts_rank_cd(to_tsvector('english', candidate_segments.search_text), candidate_segments.ts_query)::double precision as lexical_score,
              greatest(
                similarity(candidate_segments.search_text, candidate_segments.query_text),
                word_similarity(candidate_segments.query_text, candidate_segments.search_text)
              )::double precision as trigram_score,
              candidate_segments.vector_score,
              case
                when candidate_segments.lexical_match then
                  ts_headline(
                    'english',
                    candidate_segments.search_text,
                    candidate_segments.ts_query,
                    'MaxWords=24, MinWords=8, ShortWord=3, HighlightAll=false'
                  )
                else coalesce(
                  candidate_segments.snippet,
                  substring(
                    candidate_segments.search_text
                    from greatest(1, strpos(lower(candidate_segments.search_text), lower(candidate_segments.query_text)) - 80)
                    for 280
                  )
                )
              end as match_snippet
            from candidate_segments
          )
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
            ai.id as activity_interval_id,
            ai.session_id as activity_interval_session_id,
            ai.ordinal as activity_interval_ordinal,
            ai.status as activity_interval_status,
            ai.started_at as activity_interval_started_at,
            ai.ended_at as activity_interval_ended_at,
            ai.settled_at as activity_interval_settled_at,
            ai.settlement_reason as activity_interval_settlement_reason,
            ai.metadata as activity_interval_metadata,
            r.id as raw_record_id,
            r.snapshot_ordinal as raw_record_snapshot_ordinal,
            r.is_active as raw_record_is_active,
            r.status as raw_record_status,
            r.harness as raw_record_harness,
            r.harness_session_id as raw_record_harness_session_id,
            r.source_locator as raw_record_source_locator,
            r.content_type as raw_record_content_type,
            r.content_hash as raw_record_content_hash,
            r.captured_at as raw_record_captured_at,
            r.metadata as raw_record_metadata,
            r.provenance as raw_record_provenance,
            st.id as turn_id,
            st.ordinal as turn_ordinal,
            st.harness_turn_id as turn_harness_turn_id,
            st.role as turn_role,
            st.actor_kind as turn_actor_kind,
            st.actor_label as turn_actor_label,
            st.model as turn_model,
            scored.segment_id,
            scored.segment_ordinal,
            scored.segment_kind,
            scored.segment_snippet,
            scored.segment_token_start,
            scored.segment_token_end,
            scored.segment_char_start,
            scored.segment_char_end,
            scored.match_snippet,
            scored.lexical_score,
            scored.trigram_score,
            scored.vector_score,
            (
              scored.lexical_score
              + (scored.trigram_score * 0.35)
              + (coalesce(scored.vector_score, 0) * 0.75)
            )::double precision as combined_score
          from scored
          inner join sessions s
            on s.id = scored.segment_session_id
            and s.workspace_id = scored.segment_workspace_id
          inner join users u
            on u.id = s.author_user_id
            and u.workspace_id = s.workspace_id
          inner join source_bindings sb
            on sb.id = s.source_binding_id
            and sb.workspace_id = s.workspace_id
            and sb.enabled = true
          inner join activity_intervals ai
            on ai.id = scored.segment_activity_interval_id
            and ai.workspace_id = scored.segment_workspace_id
          inner join raw_session_records r
            on r.id = scored.segment_raw_session_record_id
            and r.workspace_id = scored.segment_workspace_id
            and r.is_active = true
          inner join session_turns st
            on st.id = scored.segment_turn_id
            and st.workspace_id = scored.segment_workspace_id
          where scored.lexical_match
            or scored.trigram_score >= ${minTrigramScore}
            or scored.vector_score is not null
          order by
            (
              scored.lexical_score
              + (scored.trigram_score * 0.35)
              + (coalesce(scored.vector_score, 0) * 0.75)
            ) desc,
            scored.lexical_score desc,
            scored.trigram_score desc,
            scored.vector_score desc nulls last,
            coalesce(s.last_activity_at, s.started_at, r.captured_at) desc,
            s.id asc,
            ai.ordinal asc,
            st.ordinal asc,
            scored.segment_ordinal asc
          limit ${limit}
        `;

        return groupRecallMatches({
          matches: rows.map(mapSearchRowToMatch),
          query,
          searchedAt: new Date().toISOString(),
          workspaceId: input.workspaceId,
        });
      }

      const rows = await service.sql<RecallSearchRow[]>`
        with recall_settings as (
          select
            set_config('pg_trgm.similarity_threshold', ${minTrigramScore.toString()}, true),
            set_config('pg_trgm.word_similarity_threshold', ${minTrigramScore.toString()}, true)
        ),
        recall_query as (
          select
            websearch_to_tsquery('english', ${query}) as ts_query,
            ${query}::text as query_text,
            ${minTrigramScore}::double precision as min_trigram_score
          from recall_settings
        ),
        candidate_segments as (
          select
            ss.id,
            ss.workspace_id,
            ss.session_id,
            ss.activity_interval_id,
            ss.turn_id,
            ss.raw_session_record_id,
            ss.ordinal,
            ss.segment_kind,
            ss.search_text,
            ss.snippet,
            ss.token_start,
            ss.token_end,
            ss.char_start,
            ss.char_end,
            recall_query.ts_query,
            recall_query.query_text,
            recall_query.min_trigram_score,
            to_tsvector('english', ss.search_text) @@ recall_query.ts_query as lexical_match
          from session_segments ss
          cross join recall_query
          inner join sessions s
            on s.id = ss.session_id
            and s.workspace_id = ss.workspace_id
          inner join source_bindings sb
            on sb.id = s.source_binding_id
            and sb.workspace_id = s.workspace_id
            and sb.enabled = true
          inner join raw_session_records r
            on r.id = ss.raw_session_record_id
            and r.workspace_id = ss.workspace_id
            and r.is_active = true
          where ss.workspace_id = ${input.workspaceId}
            and (${input.sessionId ?? null}::uuid is null or ss.session_id = ${input.sessionId ?? null}::uuid)
            and (${input.activityIntervalId ?? null}::uuid is null or ss.activity_interval_id = ${input.activityIntervalId ?? null}::uuid)
            and (${input.rawSessionRecordId ?? null}::uuid is null or ss.raw_session_record_id = ${input.rawSessionRecordId ?? null}::uuid)
            and (
              to_tsvector('english', ss.search_text) @@ recall_query.ts_query
              or ss.search_text % recall_query.query_text
              or recall_query.query_text <% ss.search_text
            )
        ),
        scored as (
          select
            candidate_segments.id as segment_id,
            candidate_segments.workspace_id as segment_workspace_id,
            candidate_segments.session_id as segment_session_id,
            candidate_segments.activity_interval_id as segment_activity_interval_id,
            candidate_segments.turn_id as segment_turn_id,
            candidate_segments.raw_session_record_id as segment_raw_session_record_id,
            candidate_segments.ordinal as segment_ordinal,
            candidate_segments.segment_kind as segment_kind,
            candidate_segments.search_text as segment_search_text,
            candidate_segments.snippet as segment_snippet,
            candidate_segments.token_start as segment_token_start,
            candidate_segments.token_end as segment_token_end,
            candidate_segments.char_start as segment_char_start,
            candidate_segments.char_end as segment_char_end,
            candidate_segments.lexical_match,
            ts_rank_cd(to_tsvector('english', candidate_segments.search_text), candidate_segments.ts_query)::double precision as lexical_score,
            greatest(
              similarity(candidate_segments.search_text, candidate_segments.query_text),
              word_similarity(candidate_segments.query_text, candidate_segments.search_text)
            )::double precision as trigram_score,
            case
              when candidate_segments.lexical_match then
                ts_headline(
                  'english',
                  candidate_segments.search_text,
                  candidate_segments.ts_query,
                  'MaxWords=24, MinWords=8, ShortWord=3, HighlightAll=false'
                )
              else coalesce(
                candidate_segments.snippet,
                substring(
                  candidate_segments.search_text
                  from greatest(1, strpos(lower(candidate_segments.search_text), lower(candidate_segments.query_text)) - 80)
                  for 280
                )
              )
            end as match_snippet
          from candidate_segments
        )
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
          ai.id as activity_interval_id,
          ai.session_id as activity_interval_session_id,
          ai.ordinal as activity_interval_ordinal,
          ai.status as activity_interval_status,
          ai.started_at as activity_interval_started_at,
          ai.ended_at as activity_interval_ended_at,
          ai.settled_at as activity_interval_settled_at,
          ai.settlement_reason as activity_interval_settlement_reason,
          ai.metadata as activity_interval_metadata,
          r.id as raw_record_id,
          r.snapshot_ordinal as raw_record_snapshot_ordinal,
          r.is_active as raw_record_is_active,
          r.status as raw_record_status,
          r.harness as raw_record_harness,
          r.harness_session_id as raw_record_harness_session_id,
          r.source_locator as raw_record_source_locator,
          r.content_type as raw_record_content_type,
          r.content_hash as raw_record_content_hash,
          r.captured_at as raw_record_captured_at,
          r.metadata as raw_record_metadata,
          r.provenance as raw_record_provenance,
          st.id as turn_id,
          st.ordinal as turn_ordinal,
          st.harness_turn_id as turn_harness_turn_id,
          st.role as turn_role,
          st.actor_kind as turn_actor_kind,
          st.actor_label as turn_actor_label,
          st.model as turn_model,
          scored.segment_id,
          scored.segment_ordinal,
          scored.segment_kind,
          scored.segment_snippet,
          scored.segment_token_start,
          scored.segment_token_end,
          scored.segment_char_start,
          scored.segment_char_end,
          scored.match_snippet,
          scored.lexical_score,
          scored.trigram_score,
          null::double precision as vector_score,
          (scored.lexical_score + (scored.trigram_score * 0.35))::double precision as combined_score
        from scored
        inner join sessions s
          on s.id = scored.segment_session_id
          and s.workspace_id = scored.segment_workspace_id
        inner join users u
          on u.id = s.author_user_id
          and u.workspace_id = s.workspace_id
        inner join source_bindings sb
          on sb.id = s.source_binding_id
          and sb.workspace_id = s.workspace_id
          and sb.enabled = true
        inner join activity_intervals ai
          on ai.id = scored.segment_activity_interval_id
          and ai.workspace_id = scored.segment_workspace_id
        inner join raw_session_records r
          on r.id = scored.segment_raw_session_record_id
          and r.workspace_id = scored.segment_workspace_id
          and r.is_active = true
        inner join session_turns st
          on st.id = scored.segment_turn_id
          and st.workspace_id = scored.segment_workspace_id
        where scored.lexical_match
          or scored.trigram_score >= ${minTrigramScore}
        order by
          (scored.lexical_score + (scored.trigram_score * 0.35)) desc,
          scored.lexical_score desc,
          scored.trigram_score desc,
          coalesce(s.last_activity_at, s.started_at, r.captured_at) desc,
          s.id asc,
          ai.ordinal asc,
          st.ordinal asc,
          scored.segment_ordinal asc
        limit ${limit}
      `;

      return groupRecallMatches({
        matches: rows.map(mapSearchRowToMatch),
        query,
        searchedAt: new Date().toISOString(),
        workspaceId: input.workspaceId,
      });
    },
    catch: (cause) =>
      cause instanceof RecallSearchError
        ? cause
        : new RecallSearchError({ message: errorMessage(cause) }),
  });
}

export function expandRecallContext(
  service: DatabaseService,
  input: RecallContextExpansionInput,
): Effect.Effect<RecallContextExpansion, DatabaseError | RecallSearchError> {
  return Effect.tryPromise({
    try: async () => {
      const contextWindow = normalizeContextWindow(input);
      const rows = await service.sql<RecallContextRow[]>`
        with anchor as (
          select
            ss.id as segment_id,
            ss.workspace_id as segment_workspace_id,
            ss.session_id as segment_session_id,
            ss.activity_interval_id as segment_activity_interval_id,
            ss.turn_id as segment_turn_id,
            ss.raw_session_record_id as segment_raw_session_record_id,
            ss.ordinal as segment_ordinal,
            ss.segment_kind as segment_kind,
            ss.snippet as segment_snippet,
            ss.token_start as segment_token_start,
            ss.token_end as segment_token_end,
            ss.char_start as segment_char_start,
            ss.char_end as segment_char_end,
            st.ordinal as anchor_turn_ordinal
          from session_segments ss
          inner join session_turns st
            on st.id = ss.turn_id
            and st.workspace_id = ss.workspace_id
          inner join sessions s
            on s.id = ss.session_id
            and s.workspace_id = ss.workspace_id
          inner join source_bindings sb
            on sb.id = s.source_binding_id
            and sb.workspace_id = s.workspace_id
            and sb.enabled = true
          inner join raw_session_records r
            on r.id = ss.raw_session_record_id
            and r.workspace_id = ss.workspace_id
            and r.is_active = true
          where ss.workspace_id = ${input.workspaceId}
            and ss.id = ${input.segmentId}
          limit 1
        ),
        expanded_turns as (
          select st.*
          from session_turns st
          inner join anchor
            on st.workspace_id = anchor.segment_workspace_id
            and st.session_id = anchor.segment_session_id
            and st.activity_interval_id = anchor.segment_activity_interval_id
            and st.raw_session_record_id = anchor.segment_raw_session_record_id
          where st.ordinal between anchor.anchor_turn_ordinal - ${contextWindow.beforeTurns}
            and anchor.anchor_turn_ordinal + ${contextWindow.afterTurns}
        )
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
          ai.id as activity_interval_id,
          ai.session_id as activity_interval_session_id,
          ai.ordinal as activity_interval_ordinal,
          ai.status as activity_interval_status,
          ai.started_at as activity_interval_started_at,
          ai.ended_at as activity_interval_ended_at,
          ai.settled_at as activity_interval_settled_at,
          ai.settlement_reason as activity_interval_settlement_reason,
          ai.metadata as activity_interval_metadata,
          r.id as raw_record_id,
          r.snapshot_ordinal as raw_record_snapshot_ordinal,
          r.is_active as raw_record_is_active,
          r.status as raw_record_status,
          r.harness as raw_record_harness,
          r.harness_session_id as raw_record_harness_session_id,
          r.source_locator as raw_record_source_locator,
          r.content_type as raw_record_content_type,
          r.content_hash as raw_record_content_hash,
          r.captured_at as raw_record_captured_at,
          r.metadata as raw_record_metadata,
          r.provenance as raw_record_provenance,
          anchor.segment_id,
          anchor.segment_ordinal,
          anchor.segment_kind,
          anchor.segment_snippet,
          anchor.segment_token_start,
          anchor.segment_token_end,
          anchor.segment_char_start,
          anchor.segment_char_end,
          anchor.segment_snippet as match_snippet,
          0::double precision as lexical_score,
          0::double precision as trigram_score,
          null::double precision as vector_score,
          0::double precision as combined_score,
          anchor_turn.id as turn_id,
          anchor_turn.ordinal as turn_ordinal,
          anchor_turn.harness_turn_id as turn_harness_turn_id,
          anchor_turn.role as turn_role,
          anchor_turn.actor_kind as turn_actor_kind,
          anchor_turn.actor_label as turn_actor_label,
          anchor_turn.model as turn_model,
          expanded_turns.id as expanded_turn_id,
          expanded_turns.ordinal as expanded_turn_ordinal,
          expanded_turns.harness_turn_id as expanded_turn_harness_turn_id,
          expanded_turns.role as expanded_turn_role,
          expanded_turns.actor_kind as expanded_turn_actor_kind,
          expanded_turns.actor_label as expanded_turn_actor_label,
          expanded_turns.model as expanded_turn_model,
          expanded_turns.started_at as expanded_turn_started_at,
          expanded_turns.ended_at as expanded_turn_ended_at,
          expanded_turns.content_parts as expanded_turn_content_parts,
          expanded_turns.raw_event_ids as expanded_turn_raw_event_ids,
          expanded_turns.raw_span as expanded_turn_raw_span,
          expanded_turns.metadata as expanded_turn_metadata,
          expanded_segments.id as expanded_segment_id,
          expanded_segments.ordinal as expanded_segment_ordinal,
          expanded_segments.segment_kind as expanded_segment_kind,
          expanded_segments.search_text as expanded_segment_search_text,
          expanded_segments.snippet as expanded_segment_snippet,
          expanded_segments.token_start as expanded_segment_token_start,
          expanded_segments.token_end as expanded_segment_token_end,
          expanded_segments.char_start as expanded_segment_char_start,
          expanded_segments.char_end as expanded_segment_char_end,
          expanded_segments.metadata as expanded_segment_metadata
        from anchor
        inner join sessions s
          on s.id = anchor.segment_session_id
          and s.workspace_id = anchor.segment_workspace_id
        inner join users u
          on u.id = s.author_user_id
          and u.workspace_id = s.workspace_id
        inner join source_bindings sb
          on sb.id = s.source_binding_id
          and sb.workspace_id = s.workspace_id
          and sb.enabled = true
        inner join activity_intervals ai
          on ai.id = anchor.segment_activity_interval_id
          and ai.workspace_id = anchor.segment_workspace_id
        inner join raw_session_records r
          on r.id = anchor.segment_raw_session_record_id
          and r.workspace_id = anchor.segment_workspace_id
          and r.is_active = true
        inner join session_turns anchor_turn
          on anchor_turn.id = anchor.segment_turn_id
          and anchor_turn.workspace_id = anchor.segment_workspace_id
        inner join expanded_turns on true
        left join session_segments expanded_segments
          on expanded_segments.turn_id = expanded_turns.id
          and expanded_segments.workspace_id = expanded_turns.workspace_id
          and expanded_segments.session_id = expanded_turns.session_id
          and expanded_segments.activity_interval_id = expanded_turns.activity_interval_id
          and expanded_segments.raw_session_record_id = expanded_turns.raw_session_record_id
        order by expanded_turns.ordinal asc, expanded_segments.ordinal asc nulls last
      `;

      if (rows.length === 0) {
        throw new RecallSearchError({ message: 'recall segment was not found in workspace' });
      }

      return mapContextRows(rows, {
        afterTurns: contextWindow.afterTurns,
        beforeTurns: contextWindow.beforeTurns,
        windowTurns: contextWindow.windowTurns,
        workspaceId: input.workspaceId,
      });
    },
    catch: (cause) =>
      cause instanceof RecallSearchError
        ? cause
        : new RecallSearchError({ message: errorMessage(cause) }),
  });
}

function groupRecallMatches(input: {
  matches: RecallSegmentMatch[];
  query: string;
  searchedAt: string;
  workspaceId: string;
}): RecallSearchResult {
  const sessions = new Map<string, RecallSearchSessionGroup>();
  const intervals = new Map<string, RecallSearchActivityIntervalGroup>();

  for (const match of input.matches) {
    let sessionGroup = sessions.get(match.session.id);
    if (sessionGroup === undefined) {
      sessionGroup = {
        activityIntervals: [],
        matches: [],
        session: match.session,
      };
      sessions.set(match.session.id, sessionGroup);
    }
    sessionGroup.matches.push(match);

    let intervalGroup = intervals.get(match.activityInterval.id);
    if (intervalGroup === undefined) {
      intervalGroup = {
        activityInterval: match.activityInterval,
        matches: [],
        sessionId: match.session.id,
      };
      intervals.set(match.activityInterval.id, intervalGroup);
      sessionGroup.activityIntervals.push(intervalGroup);
    }
    intervalGroup.matches.push(match);
  }

  return {
    intervals: [...intervals.values()],
    matchCount: input.matches.length,
    query: input.query,
    searchedAt: input.searchedAt,
    sessions: [...sessions.values()],
    workspaceId: input.workspaceId,
  };
}

function mapContextRows(
  rows: RecallContextRow[],
  input: { afterTurns: number; beforeTurns: number; windowTurns: number; workspaceId: string },
): RecallContextExpansion {
  const first = rows[0];
  if (first === undefined) {
    throw new RecallSearchError({ message: 'recall segment was not found in workspace' });
  }

  const turns = new Map<string, RecallExpandedTurn>();
  for (const row of rows) {
    let turn = turns.get(row.expanded_turn_id);
    if (turn === undefined) {
      turn = {
        actorKind: row.expanded_turn_actor_kind,
        actorLabel: row.expanded_turn_actor_label,
        contentParts: row.expanded_turn_content_parts,
        endedAt: row.expanded_turn_ended_at,
        harnessTurnId: row.expanded_turn_harness_turn_id,
        id: row.expanded_turn_id,
        metadata: redactAgentFacingJsonRecord(row.expanded_turn_metadata),
        model: row.expanded_turn_model,
        ordinal: row.expanded_turn_ordinal,
        rawEventIds: row.expanded_turn_raw_event_ids,
        rawSpan: redactAgentFacingJsonRecord(row.expanded_turn_raw_span),
        role: row.expanded_turn_role,
        segments: [],
        startedAt: row.expanded_turn_started_at,
      };
      turns.set(turn.id, turn);
    }

    if (row.expanded_segment_id !== null && row.expanded_segment_ordinal !== null) {
      turn.segments.push({
        charEnd: row.expanded_segment_char_end,
        charStart: row.expanded_segment_char_start,
        id: row.expanded_segment_id,
        metadata: redactAgentFacingJsonRecord(row.expanded_segment_metadata ?? {}),
        ordinal: row.expanded_segment_ordinal,
        searchText: redactAgentFacingSessionText(row.expanded_segment_search_text ?? ''),
        segmentKind: row.expanded_segment_kind ?? 'turn',
        snippet:
          row.expanded_segment_snippet === null
            ? null
            : redactAgentFacingSessionText(row.expanded_segment_snippet),
        tokenEnd: row.expanded_segment_token_end,
        tokenStart: row.expanded_segment_token_start,
      });
    }
  }

  const rawSessionRecord = mapRawSessionRecord(first);
  const warnings: RecallExpansionWarning[] = [];
  // Record-scope first: the anchor's active raw record is itself the hard-redacted
  // (scrubbed) snapshot when its status is 'redacted' (ADR 0034).
  if (rawSessionRecord.status === 'redacted') {
    warnings.push({
      detail:
        'The anchor raw session record was hard-redacted (ADR 0034); expansion shows the scrubbed content.',
      kind: 'hard_redacted',
      scope: 'record',
    });
  }

  for (const turn of turns.values()) {
    // Detect skips before replacing content parts, so the warning and the inline `omitted`
    // placeholder describe the same withheld payload.
    const skipped = summarizeSkippedSegments(turn.segments);
    turn.contentParts = redactAgentFacingSessionArray(
      safeContentPartsForSkippedSegments(turn.contentParts, turn.segments, skipped),
    );
    if (skipped !== undefined) {
      const reasons =
        skipped.filterReasons.length > 0 ? skipped.filterReasons.join(', ') : 'skipped';
      warnings.push({
        detail: `Turn payload omitted (${reasons}); ${String(skipped.skippedSegmentCount)} segment(s) withheld.`,
        kind: 'skipped_content',
        scope: 'turn',
        turnId: turn.id,
      });
    }
  }

  return {
    activityInterval: mapActivityInterval(first),
    anchor: {
      segment: mapSegment(first),
      turn: mapTurn(first),
    },
    afterTurns: input.afterTurns,
    beforeTurns: input.beforeTurns,
    rawSessionRecord,
    session: mapSession(first),
    sourceBinding: mapSourceBinding(first),
    turns: [...turns.values()],
    warnings,
    windowTurns: input.windowTurns,
    workspaceId: input.workspaceId,
  };
}

function mapSearchRowToMatch(row: RecallSearchRow): RecallSegmentMatch {
  const lexicalScore = toNumber(row.lexical_score);
  const trigramScore = toNumber(row.trigram_score);
  const vectorScore = row.vector_score === null ? undefined : toNumber(row.vector_score);
  const combinedScore = toNumber(row.combined_score);
  return {
    activityInterval: mapActivityInterval(row),
    combinedScore,
    rawSessionRecord: mapRawSessionRecord(row),
    scores:
      vectorScore === undefined
        ? {
            combined: combinedScore,
            lexical: lexicalScore,
            trigram: trigramScore,
          }
        : {
            combined: combinedScore,
            lexical: lexicalScore,
            trigram: trigramScore,
            vector: vectorScore,
          },
    segment: mapSegment(row),
    session: mapSession(row),
    snippet: redactAgentFacingSessionText(row.match_snippet ?? row.segment_snippet ?? ''),
    sourceBinding: mapSourceBinding(row),
    turn: mapTurn(row),
  };
}

function mapSession(row: RecallSearchRow): RecallSessionMetadata {
  return {
    authorUser: {
      displayName: row.author_display_name,
      externalSubject: row.author_external_subject,
      handle: row.author_handle,
      id: row.author_id,
      identitySource: row.author_identity_source,
      metadata: redactAgentFacingJsonRecord(row.author_metadata),
    },
    endedAt: row.session_ended_at,
    harness: row.session_harness,
    harnessSessionId: row.session_harness_session_id,
    id: row.session_id,
    lastActivityAt: row.session_last_activity_at,
    metadata: redactAgentFacingJsonRecord(row.session_metadata),
    model: row.session_model,
    provenance: redactAgentFacingJsonRecord(row.session_provenance),
    sourceBindingId: row.session_source_binding_id,
    sourceLocator: redactAgentFacingSourceLocator(row.session_source_locator),
    startedAt: row.session_started_at,
    status: row.session_status,
    title: row.session_title,
    workspaceId: row.session_workspace_id,
  };
}

function mapSourceBinding(row: RecallSearchRow): RecallSourceBindingMetadata {
  return {
    config: redactAgentFacingJsonRecord(row.source_binding_config),
    displayName: row.source_binding_display_name,
    enabled: row.source_binding_enabled,
    id: row.source_binding_id,
    sourceType: row.source_binding_source_type,
    sourceUri: row.source_binding_source_uri,
  };
}

function mapActivityInterval(row: RecallSearchRow): RecallActivityIntervalMetadata {
  return {
    endedAt: row.activity_interval_ended_at,
    id: row.activity_interval_id,
    metadata: redactAgentFacingJsonRecord(row.activity_interval_metadata),
    ordinal: row.activity_interval_ordinal,
    sessionId: row.activity_interval_session_id,
    settledAt: row.activity_interval_settled_at,
    settlementReason: row.activity_interval_settlement_reason,
    startedAt: row.activity_interval_started_at,
    status: row.activity_interval_status,
  };
}

function mapRawSessionRecord(row: RecallSearchRow): RecallRawSessionRecordMetadata {
  return {
    capturedAt: row.raw_record_captured_at,
    contentHash: row.raw_record_content_hash,
    contentType: row.raw_record_content_type,
    harness: row.raw_record_harness,
    harnessSessionId: row.raw_record_harness_session_id,
    id: row.raw_record_id,
    isActive: row.raw_record_is_active,
    metadata: redactAgentFacingJsonRecord(row.raw_record_metadata),
    provenance: redactAgentFacingJsonRecord(row.raw_record_provenance),
    snapshotOrdinal: row.raw_record_snapshot_ordinal,
    sourceLocator: redactAgentFacingSourceLocator(row.raw_record_source_locator),
    status: row.raw_record_status,
  };
}

function mapTurn(row: RecallSearchRow): RecallTurnPointer {
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

function mapSegment(row: RecallSearchRow): RecallSegmentPointer {
  return {
    charEnd: row.segment_char_end,
    charStart: row.segment_char_start,
    id: row.segment_id,
    ordinal: row.segment_ordinal,
    segmentKind: row.segment_kind,
    snippet:
      row.segment_snippet === null ? null : redactAgentFacingSessionText(row.segment_snippet),
    tokenEnd: row.segment_token_end,
    tokenStart: row.segment_token_start,
  };
}

function normalizeQuery(query: string): string {
  const normalized = query.trim();
  if (normalized === '') {
    throw new RecallSearchError({ message: 'recall query is required' });
  }
  return normalized;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RecallSearchError({ message: 'recall limit must be a positive integer' });
  }
  return Math.min(limit, MAX_LIMIT);
}

function normalizeContextWindow(input: RecallContextExpansionInput): {
  afterTurns: number;
  beforeTurns: number;
  windowTurns: number;
} {
  const baseWindow =
    normalizeWindowTurns(input.windowTurns, 'window') ?? DEFAULT_CONTEXT_WINDOW_TURNS;
  const beforeTurns = normalizeWindowTurns(input.beforeTurns, 'before') ?? baseWindow;
  const afterTurns = normalizeWindowTurns(input.afterTurns, 'after') ?? baseWindow;
  return {
    afterTurns,
    beforeTurns,
    windowTurns: Math.max(beforeTurns, afterTurns),
  };
}

function normalizeWindowTurns(windowTurns: number | undefined, label: string): number | undefined {
  if (windowTurns === undefined) {
    return undefined;
  }
  if (!Number.isInteger(windowTurns) || windowTurns < 0) {
    throw new RecallSearchError({
      message: `recall context ${label} window must be a non-negative integer`,
    });
  }
  return Math.min(windowTurns, MAX_CONTEXT_WINDOW_TURNS);
}

async function resolveRecallQueryEmbedding(
  input: RecallSearchInput,
  query: string,
  limit: number,
): Promise<ResolvedRecallQueryEmbedding | undefined> {
  if (input.queryEmbedding !== undefined) {
    validateRecallEmbeddingVector(input.queryEmbedding.vector, input.queryEmbedding.dimensions);
    return {
      candidateLimit: normalizeVectorCandidateLimit(input.vectorCandidateLimit, limit),
      dimensions: input.queryEmbedding.dimensions,
      model: input.queryEmbedding.model,
      provider: input.queryEmbedding.provider,
      vectorLiteral: toVectorLiteral(input.queryEmbedding.vector),
    };
  }

  if (input.embeddingProvider === undefined) {
    return undefined;
  }

  const vector = await input.embeddingProvider.embedQuery({ query });
  validateRecallEmbeddingVector(vector, input.embeddingProvider.provider.dimensions);
  return {
    candidateLimit: normalizeVectorCandidateLimit(input.vectorCandidateLimit, limit),
    dimensions: input.embeddingProvider.provider.dimensions,
    model: input.embeddingProvider.provider.model,
    provider: input.embeddingProvider.provider.id,
    vectorLiteral: toVectorLiteral(vector),
  };
}

function normalizeTrigramScore(score: number | undefined): number {
  if (score === undefined) {
    return DEFAULT_TRIGRAM_THRESHOLD;
  }
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new RecallSearchError({ message: 'minimum trigram score must be between 0 and 1' });
  }
  return score;
}

function normalizeVectorCandidateLimit(limit: number | undefined, searchLimit: number): number {
  if (limit === undefined) {
    return Math.min(Math.max(searchLimit * 5, searchLimit), 500);
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RecallSearchError({ message: 'vector candidate limit must be a positive integer' });
  }
  return Math.min(limit, 1_000);
}

function validateRecallEmbeddingVector(vector: readonly number[], dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new RecallSearchError({
      message: 'query embedding dimensions must be a positive integer',
    });
  }
  if (vector.length !== dimensions) {
    throw new RecallSearchError({
      message: `query embedding has ${String(vector.length)} dimensions; expected ${String(dimensions)}`,
    });
  }
  if (!vector.every(Number.isFinite)) {
    throw new RecallSearchError({ message: 'query embedding contains a non-finite value' });
  }
}

function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => value.toString()).join(',')}]`;
}

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
