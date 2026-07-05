import { createHash } from 'node:crypto';

import { sql as drizzleSql } from 'drizzle-orm';
import { Data, Effect } from 'effect';

import type { DatabaseError, DatabaseService } from './database.js';
import { isPlainRecord, rowsFromExecute } from './raw-rows.js';
import { importRawSessionRecordInTransaction } from './raw-session-import.js';
import type {
  RawSessionContentType,
  RawSessionHarness,
  RawSessionImportResult,
} from './raw-session-import.js';

type JsonRecord = Record<string, unknown>;
type SqlTag = <T extends readonly object[]>(
  strings: TemplateStringsArray,
  ...parameters: readonly unknown[]
) => Promise<T>;
type NormalizedSessionRedactionPattern = {
  flags?: string | undefined;
  kind: 'literal' | 'regex';
  pattern: string;
  replacement: string;
};
export type SessionSafetyOriginClassification = 'api' | 'cli' | 'custom' | 'test';

export type DeleteSessionSafetyInput = {
  id: string;
  origin?: string | undefined;
  reason?: string | undefined;
  workspaceId: string;
};

export type DeleteSessionSafetyResult = {
  deletedAt: Date;
  operation: 'deleted';
  originClassification: SessionSafetyOriginClassification;
  reasonProvided: boolean;
  sessionId: string;
  workspaceId: string;
  deleted: {
    consolidationDispositions: number;
    consolidationEvidencePointers: number;
    consolidationFindings: number;
    consolidationRecords: number;
    embeddings: number;
    rawEvents: number;
    rawSessionRecords: number;
    segments: number;
    turns: number;
  };
};

export type SessionRedactionPattern = {
  flags?: string | undefined;
  kind: 'literal' | 'regex';
  pattern: string;
  replacement?: string | undefined;
};

export type RedactSessionSafetyInput = {
  id: string;
  origin?: string | undefined;
  patterns: readonly SessionRedactionPattern[];
  reason?: string | undefined;
  workspaceId: string;
};

export type RedactSessionSafetyResult = {
  operation: 'redacted';
  originClassification: SessionSafetyOriginClassification;
  patternCount: number;
  previousRawSessionRecordId: string;
  reasonProvided: boolean;
  redactedAt: Date;
  redactedRawEvents: number;
  replacementCount: number;
  rawSessionImport: RawSessionImportResult;
  sessionId: string;
  workspaceId: string;
};

export class SessionSafetyError extends Data.TaggedError('SessionSafetyError')<{
  readonly message: string;
}> {}

type SessionIdentityRow = {
  session_id: string;
};

type CountRow = {
  count: number | string;
};

type ActiveRawSessionRow = {
  author_display_name: string | null;
  author_external_subject: string | null;
  author_handle: string;
  raw_record_body_json: unknown;
  raw_record_body_text: string | null;
  raw_record_captured_at: Date | string;
  raw_record_content_hash: string;
  raw_record_content_type: string;
  raw_record_harness: string;
  raw_record_harness_session_id: string | null;
  raw_record_id: string;
  raw_record_metadata: JsonRecord;
  raw_record_provenance: JsonRecord;
  raw_record_snapshot_ordinal: number;
  raw_record_source_locator: string | null;
  session_id: string;
  session_model: string | null;
  session_status: string;
  session_title: string | null;
  source_binding_config: JsonRecord;
  source_binding_source_type: string;
  source_binding_source_uri: string;
};

export function deleteSessionSafety(
  service: DatabaseService,
  input: DeleteSessionSafetyInput,
): Effect.Effect<DeleteSessionSafetyResult, DatabaseError | SessionSafetyError> {
  return Effect.tryPromise({
    try: async () => {
      const workspaceId = normalizeRequired(input.workspaceId, 'workspaceId');
      const id = normalizeRequired(input.id, 'id');
      const origin = normalizeOptional(input.origin) ?? 'db-api';
      const reason = normalizeOptional(input.reason) ?? null;
      const originClassification = classifyOrigin(origin);
      const deletedAt = new Date();

      return service.sql.begin(async (tx) => {
        // The transaction handle exposes the same tagged-template SQL interface
        // as SqlTag, but postgres.js types `begin`'s callback arg as its own
        // TransactionSql; bridge it to the shared SqlTag the helpers expect.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- transaction handle is the same tagged-template SQL interface
        const txSql = tx as unknown as SqlTag;
        const identity = await findSessionIdentity(txSql, { id, workspaceId });
        if (identity === undefined) {
          throw new SessionSafetyError({
            message: `session or raw session record not found: ${id}`,
          });
        }

        const rawSessionRecordIds = await tx<{ id: string }[]>`
          select id
          from raw_session_records
          where workspace_id = ${workspaceId}
            and session_id = ${identity.session_id}
        `;
        const rawEventIds = await findAssociatedRawEventIds(txSql, {
          sessionId: identity.session_id,
          workspaceId,
        });
        const consolidation = await countConsolidationRows(txSql, {
          sessionId: identity.session_id,
          workspaceId,
        });
        const counts = {
          consolidationDispositions: consolidation.dispositions,
          consolidationEvidencePointers: consolidation.pointers,
          consolidationFindings: consolidation.findings,
          consolidationRecords: consolidation.records,
          embeddings:
            rawSessionRecordIds.length === 0
              ? 0
              : await countRows(txSql, 'session_segment_embeddings', {
                  rawSessionRecordIds: rawSessionRecordIds.map((record) => record.id),
                }),
          rawEvents: rawEventIds.length,
          rawSessionRecords: rawSessionRecordIds.length,
          segments: await countRows(txSql, 'session_segments', {
            sessionId: identity.session_id,
            workspaceId,
          }),
          turns: await countRows(txSql, 'session_turns', {
            sessionId: identity.session_id,
            workspaceId,
          }),
        };

        if (rawSessionRecordIds.length > 0) {
          await tx`
            delete from session_segment_embeddings
            where raw_session_record_id = any(${rawSessionRecordIds.map((record) => record.id)}::uuid[])
          `;
        }
        await tx`
          delete from session_segments
          where workspace_id = ${workspaceId}
            and session_id = ${identity.session_id}
        `;
        await tx`
          delete from session_turns
          where workspace_id = ${workspaceId}
            and session_id = ${identity.session_id}
        `;
        await tx`
          delete from raw_session_records
          where workspace_id = ${workspaceId}
            and session_id = ${identity.session_id}
        `;
        await tx`
          delete from sessions
          where workspace_id = ${workspaceId}
            and id = ${identity.session_id}
        `;
        if (rawEventIds.length > 0) {
          await tx`
            delete from raw_events
            where workspace_id = ${workspaceId}
              and id = any(${rawEventIds}::uuid[])
          `;
        }

        return {
          deleted: counts,
          deletedAt,
          operation: 'deleted',
          originClassification,
          reasonProvided: reason !== null,
          sessionId: identity.session_id,
          workspaceId,
        };
      });
    },
    catch: (cause) =>
      cause instanceof SessionSafetyError
        ? cause
        : new SessionSafetyError({ message: errorMessage(cause) }),
  });
}

// Hard redaction (ADR-0034): writes a new redacted snapshot and scrubs the superseded snapshot's
// body_text/body_json so the matched sensitive bytes are not recoverable from Saga's primary database
// via recall, raw-body debug access, or direct reads of the inactive row — only non-sensitive
// tombstone metadata is retained. Backups and external database snapshots are a separate operational
// retention concern: the primary database does not intentionally preserve the sensitive bytes, but
// scrubbing them from backups is out of scope here.
export function redactSessionSafety(
  service: DatabaseService,
  input: RedactSessionSafetyInput,
): Effect.Effect<RedactSessionSafetyResult, DatabaseError | SessionSafetyError> {
  return Effect.tryPromise({
    try: async () => {
      const workspaceId = normalizeRequired(input.workspaceId, 'workspaceId');
      const id = normalizeRequired(input.id, 'id');
      const origin = normalizeOptional(input.origin) ?? 'db-api';
      const reason = normalizeOptional(input.reason) ?? null;
      const originClassification = classifyOrigin(origin);
      const patterns = normalizePatterns(input.patterns);
      const activeRecord = await findActiveRawSessionRecord(service, { id, workspaceId });
      if (activeRecord === undefined) {
        throw new SessionSafetyError({
          message: `active session or raw session record not found: ${id}`,
        });
      }

      const rawContent = activeRecord.raw_record_body_text;
      if (rawContent === null) {
        throw new SessionSafetyError({ message: 'active raw session record has no raw body text' });
      }

      const redaction = applyRedactions(rawContent, patterns);
      if (redaction.replacementCount === 0) {
        throw new SessionSafetyError({ message: 'redaction patterns did not match the session' });
      }
      if (redaction.content === rawContent) {
        throw new SessionSafetyError({ message: 'redaction did not change the session body' });
      }
      validateRedactedContent({
        bodyJson: activeRecord.raw_record_body_json,
        contentType: parseContentType(activeRecord.raw_record_content_type),
        rawContent: redaction.content,
      });
      await assertRedactedSnapshotIsNew(service, {
        contentHash: sha256(redaction.content),
        sessionId: activeRecord.session_id,
        workspaceId,
      });

      const redactedAt = new Date();
      const auditMetadata = {
        operation: 'redacted',
        originClassification,
        patternCount: patterns.length,
        reasonProvided: reason !== null,
        redactedAt: redactedAt.toISOString(),
        replacementCount: redaction.replacementCount,
      };

      return service.db.transaction(async (tx) => {
        const rawEventIds = await findAssociatedRawEventIdsDb(tx as DatabaseService['db'], {
          sessionId: activeRecord.session_id,
          workspaceId,
        });
        const importResult = await Effect.runPromise(
          importRawSessionRecordInTransaction(tx as DatabaseService['db'], {
            author: {
              displayName: activeRecord.author_display_name ?? undefined,
              externalSubject: activeRecord.author_external_subject ?? undefined,
              handle: activeRecord.author_handle,
            },
            capturedAt: redactedAt,
            contentType: parseContentType(activeRecord.raw_record_content_type),
            harness: parseHarness(activeRecord.raw_record_harness),
            harnessSessionId: activeRecord.raw_record_harness_session_id ?? undefined,
            host: hostFromSourceBinding(activeRecord),
            locator: activeRecord.raw_record_source_locator ?? undefined,
            metadata: {
              redaction: {
                ...auditMetadata,
                previousSnapshotOrdinal: activeRecord.raw_record_snapshot_ordinal,
                redactedFromRawSessionRecordId: activeRecord.raw_record_id,
              },
            },
            model: activeRecord.session_model ?? undefined,
            provenance: {
              operation: 'redacted',
              originClassification,
              redactedAt: redactedAt.toISOString(),
              redactedBy: 'saga session safety',
              redactedFromRawSessionRecordId: activeRecord.raw_record_id,
            },
            rawContent: redaction.content,
            rawRecord: {
              inactivePrevious: {
                metadata: {
                  redactionTombstone: auditMetadata,
                },
                provenance: {
                  operation: 'redacted',
                  originClassification,
                  redactedAt: redactedAt.toISOString(),
                  redactedBy: 'saga session safety',
                },
                status: 'redacted',
              },
              expectedActiveRawSessionRecordId: activeRecord.raw_record_id,
              redactedFromRawSessionRecordId: activeRecord.raw_record_id,
              status: 'redacted',
            },
            status: parseSessionStatus(activeRecord.session_status),
            title: activeRecord.session_title ?? undefined,
            workspaceId,
          }),
        );

        // ADR-0034: scrub the body of every inactive snapshot of this session — not just the record
        // the import just superseded. A session updated before redaction accrues several inactive
        // snapshots (snapshotOrdinal 0,1,...), each holding the sensitive bytes; the new active
        // redacted snapshot keeps its (redacted) body, all superseded rows retain only their tombstone
        // metadata. Runs after the import so the just-superseded record is already is_active = false.
        await (tx as DatabaseService['db']).execute(drizzleSql`
          update raw_session_records
          set body_text = null, body_json = null
          where workspace_id = ${workspaceId}
            and session_id = ${activeRecord.session_id}
            and is_active = false
        `);

        const redactedRawEvents = await redactAssociatedRawEventsDb(tx as DatabaseService['db'], {
          auditMetadata,
          patterns,
          rawEventIds,
          redactedAt,
          workspaceId,
        });

        return {
          operation: 'redacted',
          originClassification,
          patternCount: patterns.length,
          previousRawSessionRecordId: activeRecord.raw_record_id,
          rawSessionImport: importResult,
          reasonProvided: reason !== null,
          redactedAt,
          redactedRawEvents,
          replacementCount: redaction.replacementCount,
          sessionId: activeRecord.session_id,
          workspaceId,
        };
      });
    },
    catch: (cause) =>
      cause instanceof SessionSafetyError
        ? cause
        : new SessionSafetyError({ message: errorMessage(cause) }),
  });
}

async function findSessionIdentity(
  sql: SqlTag,
  input: { id: string; workspaceId: string },
): Promise<SessionIdentityRow | undefined> {
  const rows = await sql<SessionIdentityRow[]>`
    select s.id as session_id
    from sessions s
    where s.workspace_id = ${input.workspaceId}
      and s.id::text = ${input.id}
    union all
    select r.session_id as session_id
    from raw_session_records r
    where r.workspace_id = ${input.workspaceId}
      and r.id::text = ${input.id}
    limit 1
  `;
  return rows[0];
}

async function findActiveRawSessionRecord(
  service: DatabaseService,
  input: { id: string; workspaceId: string },
): Promise<ActiveRawSessionRow | undefined> {
  const rows = await service.sql<ActiveRawSessionRow[]>`
    select
      s.id as session_id,
      s.title as session_title,
      s.model as session_model,
      s.status as session_status,
      u.handle as author_handle,
      u.display_name as author_display_name,
      u.external_subject as author_external_subject,
      sb.source_type as source_binding_source_type,
      sb.source_uri as source_binding_source_uri,
      sb.config as source_binding_config,
      r.id as raw_record_id,
      r.snapshot_ordinal as raw_record_snapshot_ordinal,
      r.harness as raw_record_harness,
      r.harness_session_id as raw_record_harness_session_id,
      r.source_locator as raw_record_source_locator,
      r.content_type as raw_record_content_type,
      r.content_hash as raw_record_content_hash,
      r.body_text as raw_record_body_text,
      r.body_json as raw_record_body_json,
      r.captured_at as raw_record_captured_at,
      r.metadata as raw_record_metadata,
      r.provenance as raw_record_provenance
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
    where r.workspace_id = ${input.workspaceId}
      and r.is_active = true
      and (s.id::text = ${input.id} or r.id::text = ${input.id})
    limit 1
  `;
  return rows[0];
}

async function findAssociatedRawEventIds(
  sql: SqlTag,
  input: { sessionId: string; workspaceId: string },
): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    with target_session as (
      select id, source_binding_id, harness, harness_session_id
      from sessions
      where workspace_id = ${input.workspaceId}
        and id = ${input.sessionId}
      limit 1
    ),
    explicit_raw_event_ids as (
      select ai.settlement_trigger_raw_event_id::text as id
      from activity_intervals ai
      where ai.workspace_id = ${input.workspaceId}
        and ai.session_id = ${input.sessionId}
        and ai.settlement_trigger_raw_event_id is not null
      union
      select r.provenance->>'rawEventId' as id
      from raw_session_records r
      where r.workspace_id = ${input.workspaceId}
        and r.session_id = ${input.sessionId}
        and r.provenance ? 'rawEventId'
      union
      select r.metadata->>'triggerRawEventId' as id
      from raw_session_records r
      where r.workspace_id = ${input.workspaceId}
        and r.session_id = ${input.sessionId}
        and r.metadata ? 'triggerRawEventId'
      union
      select jsonb_array_elements_text(st.raw_event_ids) as id
      from session_turns st
      where st.workspace_id = ${input.workspaceId}
        and st.session_id = ${input.sessionId}
    )
    select distinct re.id::text as id
    from raw_events re
    inner join target_session s on true
    where re.workspace_id = ${input.workspaceId}
      and (
        re.session_id = s.id::text
        or (
          s.harness_session_id is not null
          and re.source_binding_id = s.source_binding_id
          and re.source_type = s.harness
          and re.session_id = s.harness_session_id
        )
        or re.id::text in (
          select id
          from explicit_raw_event_ids
          where id is not null and id <> ''
        )
      )
  `;
  return rows.map((row) => row.id);
}

async function findAssociatedRawEventIdsDb(
  db: DatabaseService['db'],
  input: { sessionId: string; workspaceId: string },
): Promise<string[]> {
  const rows = rowsFromExecute<{ id: string }>(
    await db.execute(drizzleSql`
      with target_session as (
        select id, source_binding_id, harness, harness_session_id
        from sessions
        where workspace_id = ${input.workspaceId}
          and id = ${input.sessionId}
        limit 1
      ),
      explicit_raw_event_ids as (
        select ai.settlement_trigger_raw_event_id::text as id
        from activity_intervals ai
        where ai.workspace_id = ${input.workspaceId}
          and ai.session_id = ${input.sessionId}
          and ai.settlement_trigger_raw_event_id is not null
        union
        select r.provenance->>'rawEventId' as id
        from raw_session_records r
        where r.workspace_id = ${input.workspaceId}
          and r.session_id = ${input.sessionId}
          and r.provenance ? 'rawEventId'
        union
        select r.metadata->>'triggerRawEventId' as id
        from raw_session_records r
        where r.workspace_id = ${input.workspaceId}
          and r.session_id = ${input.sessionId}
          and r.metadata ? 'triggerRawEventId'
        union
        select jsonb_array_elements_text(st.raw_event_ids) as id
        from session_turns st
        where st.workspace_id = ${input.workspaceId}
          and st.session_id = ${input.sessionId}
      )
      select distinct re.id::text as id
      from raw_events re
      inner join target_session s on true
      where re.workspace_id = ${input.workspaceId}
        and (
          re.session_id = s.id::text
          or (
            s.harness_session_id is not null
            and re.source_binding_id = s.source_binding_id
            and re.source_type = s.harness
            and re.session_id = s.harness_session_id
          )
          or re.id::text in (
            select id
            from explicit_raw_event_ids
            where id is not null and id <> ''
          )
        )
    `),
  );
  return rows.map((row) => row.id);
}

async function redactAssociatedRawEventsDb(
  db: DatabaseService['db'],
  input: {
    auditMetadata: JsonRecord;
    patterns: readonly NormalizedSessionRedactionPattern[];
    rawEventIds: readonly string[];
    redactedAt: Date;
    workspaceId: string;
  },
): Promise<number> {
  if (input.rawEventIds.length === 0) {
    return 0;
  }

  const rows = rowsFromExecute<{
    actor_id: string;
    external_event_id: string;
    id: string;
    payload: JsonRecord;
    provenance: JsonRecord;
    session_id: string | null;
    source_id: string;
    trace_id: string | null;
  }>(
    await db.execute(drizzleSql`
      select id::text,
        actor_id,
        external_event_id,
        payload,
        provenance,
        session_id,
        source_id,
        trace_id
      from raw_events
      where workspace_id = ${input.workspaceId}
        and id = any(${uuidArraySql(input.rawEventIds)})
    `),
  );

  let redacted = 0;
  for (const row of rows) {
    const actorRedaction = applyRedactions(row.actor_id, input.patterns);
    const externalRedaction = applyRedactions(row.external_event_id, input.patterns);
    const payloadRedaction = redactJsonValue(row.payload, input.patterns);
    const provenanceRedaction = redactJsonValue(row.provenance, input.patterns);
    const sessionRedaction =
      row.session_id === null
        ? { content: null, replacementCount: 0 }
        : applyRedactions(row.session_id, input.patterns);
    const sourceRedaction = applyRedactions(row.source_id, input.patterns);
    const traceRedaction =
      row.trace_id === null
        ? { content: null, replacementCount: 0 }
        : applyRedactions(row.trace_id, input.patterns);
    const replacementCount =
      actorRedaction.replacementCount +
      externalRedaction.replacementCount +
      payloadRedaction.replacementCount +
      provenanceRedaction.replacementCount +
      sessionRedaction.replacementCount +
      sourceRedaction.replacementCount +
      traceRedaction.replacementCount;
    if (replacementCount === 0) {
      continue;
    }

    redacted += 1;
    await invalidateClaimProjectionsForRawEventDb(db, {
      rawEventId: row.id,
      redactedAt: input.redactedAt,
      workspaceId: input.workspaceId,
    });
    await db.execute(drizzleSql`
      update raw_events
      set actor_id = ${actorRedaction.content},
        external_event_id = ${
          externalRedaction.replacementCount === 0
            ? row.external_event_id
            : `redacted:${row.id}:external-event`
        },
        payload = ${JSON.stringify(payloadRedaction.value)}::jsonb,
        provenance = ${JSON.stringify({
          ...asRecord(provenanceRedaction.value),
          sagaSessionSafety: {
            ...input.auditMetadata,
            rawEventId: row.id,
            rawEventReplacementCount: replacementCount,
          },
        })}::jsonb,
        session_id = ${sessionRedaction.content},
        source_id = ${
          sourceRedaction.replacementCount === 0 ? row.source_id : `redacted:${row.id}:source`
        },
        trace_id = ${traceRedaction.content},
        updated_at = ${input.redactedAt.toISOString()}
      where workspace_id = ${input.workspaceId}
        and id = ${row.id}
    `);
  }
  return redacted;
}

async function invalidateClaimProjectionsForRawEventDb(
  db: DatabaseService['db'],
  input: { rawEventId: string; redactedAt: Date; workspaceId: string },
): Promise<void> {
  const claimRows = rowsFromExecute<{ claim_key: string; event_id: string }>(
    await db.execute(drizzleSql`
      select claim_key, id::text as event_id
      from claim_events
      where workspace_id = ${input.workspaceId}
        and raw_event_id = ${input.rawEventId}
    `),
  );
  if (claimRows.length === 0) {
    return;
  }

  const claimKeys = [...new Set(claimRows.map((row) => row.claim_key))];
  await db.execute(drizzleSql`
    delete from current_claims
    where workspace_id = ${input.workspaceId}
      and claim_key in (${drizzleSql.join(
        claimKeys.map((claimKey) => drizzleSql`${claimKey}`),
        drizzleSql`, `,
      )})
  `);
  await db.execute(drizzleSql`
    update claim_events
    set claim_text = '[REDACTED]',
      evidence = ${JSON.stringify(redactedClaimTombstone(input))}::jsonb,
      attributes = ${JSON.stringify(redactedClaimTombstone(input))}::jsonb,
      updated_at = ${input.redactedAt.toISOString()}
    where workspace_id = ${input.workspaceId}
      and raw_event_id = ${input.rawEventId}
  `);
}

function redactedClaimTombstone(input: { rawEventId: string; redactedAt: Date }): JsonRecord {
  return {
    operation: 'redacted',
    rawEventId: input.rawEventId,
    redactedAt: input.redactedAt.toISOString(),
  };
}

async function assertRedactedSnapshotIsNew(
  service: DatabaseService,
  input: { contentHash: string; sessionId: string; workspaceId: string },
): Promise<void> {
  const rows = await service.sql<{ id: string }[]>`
    select id
    from raw_session_records
    where workspace_id = ${input.workspaceId}
      and session_id = ${input.sessionId}
      and content_hash = ${input.contentHash}
    limit 1
  `;
  if (rows[0] !== undefined) {
    throw new SessionSafetyError({
      message: 'redacted content duplicates an existing raw session snapshot',
    });
  }
}

async function countRows(
  sql: SqlTag,
  table: 'session_segment_embeddings' | 'session_segments' | 'session_turns',
  input: { rawSessionRecordIds: readonly string[] } | { sessionId: string; workspaceId: string },
): Promise<number> {
  if ('rawSessionRecordIds' in input) {
    if (input.rawSessionRecordIds.length === 0) {
      return 0;
    }
    const rows = await sql<CountRow[]>`
      select count(*)::int as count
      from session_segment_embeddings
      where raw_session_record_id = any(${input.rawSessionRecordIds}::uuid[])
    `;
    return Number(rows[0]?.count ?? 0);
  }

  const rows =
    table === 'session_segments'
      ? await sql<CountRow[]>`
          select count(*)::int as count
          from session_segments
          where workspace_id = ${input.workspaceId}
            and session_id = ${input.sessionId}
        `
      : await sql<CountRow[]>`
          select count(*)::int as count
          from session_turns
          where workspace_id = ${input.workspaceId}
            and session_id = ${input.sessionId}
        `;
  return Number(rows[0]?.count ?? 0);
}

async function countConsolidationRows(
  sql: SqlTag,
  input: { sessionId: string; workspaceId: string },
): Promise<{ dispositions: number; findings: number; pointers: number; records: number }> {
  const rows = await sql<
    {
      dispositions: number | string;
      findings: number | string;
      pointers: number | string;
      records: number | string;
    }[]
  >`
    select
      (
        select count(*)
        from consolidation_records
        where workspace_id = ${input.workspaceId}
          and session_id = ${input.sessionId}
      )::int as records,
      (
        select count(*)
        from consolidation_findings
        where workspace_id = ${input.workspaceId}
          and session_id = ${input.sessionId}
      )::int as findings,
      (
        select count(*)
        from consolidation_dispositions
        where workspace_id = ${input.workspaceId}
          and session_id = ${input.sessionId}
      )::int as dispositions,
      (
        select count(*)
        from consolidation_evidence_pointers ep
        inner join consolidation_findings f
          on f.id = ep.finding_id
          and f.workspace_id = ep.workspace_id
        where f.workspace_id = ${input.workspaceId}
          and f.session_id = ${input.sessionId}
      )::int as pointers
  `;
  const row = rows[0];
  return {
    dispositions: Number(row?.dispositions ?? 0),
    findings: Number(row?.findings ?? 0),
    pointers: Number(row?.pointers ?? 0),
    records: Number(row?.records ?? 0),
  };
}

function normalizePatterns(
  patterns: readonly SessionRedactionPattern[],
): readonly NormalizedSessionRedactionPattern[] {
  if (patterns.length === 0) {
    throw new SessionSafetyError({ message: 'at least one redaction pattern is required' });
  }
  return patterns.map((pattern) => {
    const normalized = normalizeRequired(pattern.pattern, 'redaction pattern');
    if (pattern.kind !== 'literal' && pattern.kind !== 'regex') {
      throw new SessionSafetyError({ message: 'redaction pattern kind must be literal or regex' });
    }
    return {
      kind: pattern.kind,
      pattern: normalized,
      replacement: pattern.replacement ?? '[REDACTED]',
      ...(pattern.flags === undefined ? {} : { flags: pattern.flags }),
    };
  });
}

function applyRedactions(
  content: string,
  patterns: readonly NormalizedSessionRedactionPattern[],
): { content: string; replacementCount: number } {
  let redactedContent = content;
  let replacementCount = 0;
  for (const [index, pattern] of patterns.entries()) {
    if (pattern.kind === 'literal') {
      const pieces = redactedContent.split(pattern.pattern);
      const matches = pieces.length - 1;
      replacementCount += matches;
      redactedContent = pieces.join(pattern.replacement);
      continue;
    }

    const regex = compileRedactionRegex(pattern, index);
    redactedContent = redactedContent.replace(regex, () => {
      replacementCount += 1;
      return pattern.replacement;
    });
  }
  return { content: redactedContent, replacementCount };
}

function redactJsonValue(
  value: unknown,
  patterns: readonly NormalizedSessionRedactionPattern[],
): { replacementCount: number; value: unknown } {
  if (typeof value === 'string') {
    const redaction = applyRedactions(value, patterns);
    return { replacementCount: redaction.replacementCount, value: redaction.content };
  }
  if (Array.isArray(value)) {
    let replacementCount = 0;
    const redacted = value.map((entry) => {
      const result = redactJsonValue(entry, patterns);
      replacementCount += result.replacementCount;
      return result.value;
    });
    return { replacementCount, value: redacted };
  }
  if (isPlainRecord(value)) {
    let replacementCount = 0;
    const redacted: JsonRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      const keyRedaction = applyRedactions(key, patterns);
      const valueRedaction = redactJsonValue(entry, patterns);
      replacementCount += keyRedaction.replacementCount + valueRedaction.replacementCount;
      redacted[keyRedaction.content] = valueRedaction.value;
    }
    return { replacementCount, value: redacted };
  }
  return { replacementCount: 0, value };
}

function compileRedactionRegex(pattern: NormalizedSessionRedactionPattern, index: number): RegExp {
  const flags = redactionRegexFlags(pattern.flags);
  try {
    // Validation probe: constructing with an empty source isolates a flags-only
    // failure from a pattern-syntax failure; the instance is intentionally discarded.
    // oxlint-disable-next-line no-new
    new RegExp('', flags);
  } catch {
    throw invalidRedactionRegexError(index, 'flags');
  }

  try {
    return new RegExp(pattern.pattern, flags);
  } catch {
    throw invalidRedactionRegexError(index, 'syntax');
  }
}

function redactionRegexFlags(value: string | undefined): string {
  const flags = new Set(value);
  flags.add('g');
  return [...flags].join('');
}

function invalidRedactionRegexError(index: number, reason: 'flags' | 'syntax'): SessionSafetyError {
  return new SessionSafetyError({
    message: `invalid redaction regex pattern at index ${index + 1}: invalid ${reason}`,
  });
}

function validateRedactedContent(input: {
  bodyJson: unknown;
  contentType: RawSessionContentType;
  rawContent: string;
}): void {
  if (input.bodyJson === null || input.bodyJson === undefined || input.contentType === 'text') {
    return;
  }
  if (input.contentType === 'json') {
    parseJson(input.rawContent, 'redacted JSON body');
    return;
  }
  for (const line of input.rawContent.split(/\r?\n/u)) {
    if (line.trim() === '') {
      continue;
    }
    parseJson(line, 'redacted JSONL line');
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new SessionSafetyError({ message: `${label} must remain valid JSON` });
  }
}

function hostFromSourceBinding(row: ActiveRawSessionRow): {
  id: string;
  label?: string | undefined;
  projectRoot?: string | undefined;
} {
  const config = asRecord(row.source_binding_config);
  const hostId = typeof config.hostId === 'string' ? config.hostId : row.source_binding_source_uri;
  return {
    id: hostId,
    label: typeof config.hostLabel === 'string' ? config.hostLabel : undefined,
    projectRoot: typeof config.projectRoot === 'string' ? config.projectRoot : undefined,
  };
}

function parseHarness(value: string): RawSessionHarness {
  if (value === 'claude' || value === 'codex') {
    return value;
  }
  throw new SessionSafetyError({ message: `unsupported raw session harness: ${value}` });
}

function parseContentType(value: string): RawSessionContentType {
  if (value === 'json' || value === 'jsonl' || value === 'text') {
    return value;
  }
  throw new SessionSafetyError({ message: `unsupported raw session content type: ${value}` });
}

function parseSessionStatus(value: string): 'active' | 'completed' | undefined {
  if (value === 'active' || value === 'completed') {
    return value;
  }
  return undefined;
}

function normalizeRequired(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === '') {
    throw new SessionSafetyError({ message: `${label} is required` });
  }
  return trimmed;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function classifyOrigin(value: string): SessionSafetyOriginClassification {
  if (value === 'db-api') {
    return 'api';
  }
  if (value === 'test') {
    return 'test';
  }
  if (value.startsWith('saga sessions ')) {
    return 'cli';
  }
  return 'custom';
}

function asRecord(value: unknown): JsonRecord {
  return isPlainRecord(value) ? value : {};
}

function uuidArraySql(values: readonly string[]) {
  return drizzleSql`array[${drizzleSql.join(
    values.map((value) => drizzleSql`${value}`),
    drizzleSql`, `,
  )}]::uuid[]`;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
