import type { DispositionKind, FindingType } from '@saga/contracts';
import { and, asc, eq, inArray, sql as drizzleSql } from 'drizzle-orm';
import { Data, Effect } from 'effect';

import type { DatabaseError, DatabaseService } from './database.js';
import {
  activityIntervals,
  consolidationDispositions,
  consolidationEvidencePointers,
  consolidationFindings,
  consolidationRecords,
} from './schema.js';

type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];
type JsonRecord = Record<string, unknown>;

export type ConsolidationEvidencePointerInput = {
  activityIntervalOrdinal?: number | undefined;
  sessionId: string;
  turnOrdinal?: number | undefined;
};

export type ConsolidationFindingInput = {
  evidence: readonly ConsolidationEvidencePointerInput[];
  id: string;
  text: string;
  type: FindingType;
};

export type ConsolidationDispositionInput = {
  fromFindingId: string;
  kind: DispositionKind;
  toFindingId: string;
};

export type InsertConsolidationRecordInput = {
  activityIntervalId: string;
  authPath: string;
  dispositions?: readonly ConsolidationDispositionInput[] | undefined;
  findings: readonly ConsolidationFindingInput[];
  id?: string | undefined;
  metadata?: JsonRecord | undefined;
  modelId: string;
  narrative: string;
  sessionId: string;
  workspaceId: string;
};

export type ConsolidationEvidencePointer = {
  activityIntervalOrdinal: number | null;
  id: string;
  sessionId: string;
  turnOrdinal: number | null;
};

export type ConsolidationFinding = {
  evidence: ConsolidationEvidencePointer[];
  id: string;
  ordinal: number;
  text: string;
  type: FindingType;
};

export type ConsolidationDisposition = {
  fromFindingId: string;
  id: string;
  kind: DispositionKind;
  toFindingId: string;
};

export type ConsolidationRecordDetail = {
  activityIntervalId: string;
  authPath: string;
  createdAt: Date;
  dispositions: ConsolidationDisposition[];
  findings: ConsolidationFinding[];
  id: string;
  modelId: string;
  narrative: string;
  sessionId: string;
  workspaceId: string;
};

export type GetConsolidationRecordByIntervalInput = {
  activityIntervalId: string;
  workspaceId: string;
};

export type ListConsolidationRecordsBySessionInput = {
  sessionId: string;
  workspaceId: string;
};

export type DeleteConsolidationRecordsForSessionInput = {
  sessionId: string;
  workspaceId: string;
};

export class ConsolidationRecordError extends Data.TaggedError('ConsolidationRecordError')<{
  readonly message: string;
}> {}

/**
 * Insert one complete, immutable Consolidation Record (record + findings +
 * evidence pointers + disposition edges) in a single transaction.
 *
 * The write path is a safety boundary for the one rule the database cannot
 * express: a disposition may only target a finding in the same session or its
 * continuation lineage (sessions joined by explicit continuation evidence). The
 * unique-per-interval, finding-type, disposition-kind, and no-self-loop
 * guarantees are enforced by database constraints and are not re-checked here.
 */
export function insertConsolidationRecord(
  service: DatabaseService,
  input: InsertConsolidationRecordInput,
): Effect.Effect<ConsolidationRecordDetail, DatabaseError | ConsolidationRecordError> {
  return Effect.tryPromise({
    try: () =>
      service.db.transaction((tx) => insertConsolidationRecordUnsafe(tx as Tx, input)) as Promise<
        ConsolidationRecordDetail
      >,
    catch: (cause) =>
      cause instanceof ConsolidationRecordError
        ? cause
        : new ConsolidationRecordError({ message: errorMessage(cause) }),
  });
}

async function insertConsolidationRecordUnsafe(
  tx: Tx,
  input: InsertConsolidationRecordInput,
): Promise<ConsolidationRecordDetail> {
  const findings = input.findings;
  const dispositions = input.dispositions ?? [];

  if (findings.length === 0 && dispositions.length > 0) {
    throw new ConsolidationRecordError({
      message: 'a record with dispositions must contain findings',
    });
  }

  const findingIds = new Set(findings.map((finding) => finding.id));
  if (findingIds.size !== findings.length) {
    throw new ConsolidationRecordError({ message: 'finding ids must be unique within a record' });
  }

  await validateDispositionLineage(tx, {
    dispositions,
    findingIds,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
  });

  const [recordRow] = await tx
    .insert(consolidationRecords)
    .values({
      activityIntervalId: input.activityIntervalId,
      authPath: input.authPath,
      id: input.id,
      metadata: input.metadata ?? {},
      modelId: input.modelId,
      narrative: input.narrative,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
    })
    .returning();
  if (recordRow === undefined) {
    throw new ConsolidationRecordError({ message: 'consolidation record insert returned no row' });
  }

  if (findings.length > 0) {
    await tx.insert(consolidationFindings).values(
      findings.map((finding, index) => ({
        findingType: finding.type,
        id: finding.id,
        ordinal: index,
        recordId: recordRow.id,
        sessionId: input.sessionId,
        text: finding.text,
        workspaceId: input.workspaceId,
      })),
    );

    const pointerValues = findings.flatMap((finding) =>
      finding.evidence.map((pointer) => ({
        activityIntervalOrdinal: pointer.activityIntervalOrdinal ?? null,
        findingId: finding.id,
        pointerSessionId: pointer.sessionId,
        turnOrdinal: pointer.turnOrdinal ?? null,
        workspaceId: input.workspaceId,
      })),
    );
    if (pointerValues.length > 0) {
      await tx.insert(consolidationEvidencePointers).values(pointerValues);
    }
  }

  if (dispositions.length > 0) {
    await tx.insert(consolidationDispositions).values(
      dispositions.map((disposition) => ({
        fromFindingId: disposition.fromFindingId,
        kind: disposition.kind,
        recordId: recordRow.id,
        sessionId: input.sessionId,
        toFindingId: disposition.toFindingId,
        workspaceId: input.workspaceId,
      })),
    );
  }

  return loadRecordDetails(tx, {
    recordIds: [recordRow.id],
    workspaceId: input.workspaceId,
  }).then((records) => {
    const record = records[0];
    if (record === undefined) {
      throw new ConsolidationRecordError({
        message: 'consolidation record disappeared after insert',
      });
    }
    return record;
  });
}

async function validateDispositionLineage(
  tx: Tx,
  input: {
    dispositions: readonly ConsolidationDispositionInput[];
    findingIds: ReadonlySet<string>;
    sessionId: string;
    workspaceId: string;
  },
): Promise<void> {
  if (input.dispositions.length === 0) {
    return;
  }

  for (const disposition of input.dispositions) {
    if (!input.findingIds.has(disposition.fromFindingId)) {
      throw new ConsolidationRecordError({
        message: `disposition source finding ${disposition.fromFindingId} is not part of this record`,
      });
    }
    if (disposition.fromFindingId === disposition.toFindingId) {
      throw new ConsolidationRecordError({
        message: 'a disposition may not reference the same finding as source and target',
      });
    }
  }

  // Targets inside this record are same-session by construction; only targets in
  // previously persisted records need the lineage check.
  const externalTargets = [
    ...new Set(
      input.dispositions
        .map((disposition) => disposition.toFindingId)
        .filter((id) => !input.findingIds.has(id)),
    ),
  ];
  if (externalTargets.length === 0) {
    return;
  }

  const lineage = await lineageSessionIds(tx, input.workspaceId, input.sessionId);
  const targetRows = await tx
    .select({ id: consolidationFindings.id, sessionId: consolidationFindings.sessionId })
    .from(consolidationFindings)
    .where(
      and(
        eq(consolidationFindings.workspaceId, input.workspaceId),
        inArray(consolidationFindings.id, externalTargets),
      ),
    );
  const targetSessionById = new Map(targetRows.map((row) => [row.id, row.sessionId]));

  for (const targetId of externalTargets) {
    const targetSessionId = targetSessionById.get(targetId);
    if (targetSessionId === undefined) {
      throw new ConsolidationRecordError({
        message: `disposition target finding ${targetId} was not found`,
      });
    }
    if (!lineage.has(targetSessionId)) {
      throw new ConsolidationRecordError({
        message: `disposition target finding ${targetId} is outside the continuation lineage of session ${input.sessionId}`,
      });
    }
  }
}

/**
 * The continuation lineage of a session: the session itself plus every session
 * reachable through explicit continuation evidence, in either direction,
 * transitively.
 */
async function lineageSessionIds(
  tx: Tx,
  workspaceId: string,
  sessionId: string,
): Promise<Set<string>> {
  const rows = rowsFromExecute<{ session_id: string }>(
    await tx.execute(drizzleSql`
      with recursive lineage(session_id) as (
        select ${sessionId}::uuid as session_id
        union
        select
          case
            when sr.source_session_id = l.session_id then sr.target_session_id
            else sr.source_session_id
          end as session_id
        from session_relationships sr
        inner join lineage l
          on sr.source_session_id = l.session_id
          or sr.target_session_id = l.session_id
        where sr.workspace_id = ${workspaceId}
          and sr.relationship_type = 'continuation'
          and sr.confidence = 'explicit'
      )
      select session_id::text as session_id from lineage
    `),
  );
  return new Set(rows.map((row) => row.session_id));
}

export function getConsolidationRecordByInterval(
  service: DatabaseService,
  input: GetConsolidationRecordByIntervalInput,
): Effect.Effect<ConsolidationRecordDetail | null, DatabaseError | ConsolidationRecordError> {
  return Effect.tryPromise({
    try: async () => {
      const recordRows = await service.db
        .select({ id: consolidationRecords.id })
        .from(consolidationRecords)
        .where(
          and(
            eq(consolidationRecords.workspaceId, input.workspaceId),
            eq(consolidationRecords.activityIntervalId, input.activityIntervalId),
          ),
        )
        .limit(1);
      const recordId = recordRows[0]?.id;
      if (recordId === undefined) {
        return null;
      }
      const records = await loadRecordDetails(service.db, {
        recordIds: [recordId],
        workspaceId: input.workspaceId,
      });
      return records[0] ?? null;
    },
    catch: (cause) =>
      cause instanceof ConsolidationRecordError
        ? cause
        : new ConsolidationRecordError({ message: errorMessage(cause) }),
  });
}

export function listConsolidationRecordsBySession(
  service: DatabaseService,
  input: ListConsolidationRecordsBySessionInput,
): Effect.Effect<ConsolidationRecordDetail[], DatabaseError | ConsolidationRecordError> {
  return Effect.tryPromise({
    try: async () => {
      const orderedRecords = await service.db
        .select({ id: consolidationRecords.id, ordinal: activityIntervals.ordinal })
        .from(consolidationRecords)
        .innerJoin(
          activityIntervals,
          and(
            eq(activityIntervals.id, consolidationRecords.activityIntervalId),
            eq(activityIntervals.workspaceId, consolidationRecords.workspaceId),
          ),
        )
        .where(
          and(
            eq(consolidationRecords.workspaceId, input.workspaceId),
            eq(consolidationRecords.sessionId, input.sessionId),
          ),
        )
        .orderBy(asc(activityIntervals.ordinal));
      const recordIds = orderedRecords.map((row) => row.id);
      if (recordIds.length === 0) {
        return [];
      }
      const details = await loadRecordDetails(service.db, {
        recordIds,
        workspaceId: input.workspaceId,
      });
      const byId = new Map(details.map((detail) => [detail.id, detail]));
      return recordIds.flatMap((id) => {
        const detail = byId.get(id);
        return detail === undefined ? [] : [detail];
      });
    },
    catch: (cause) =>
      cause instanceof ConsolidationRecordError
        ? cause
        : new ConsolidationRecordError({ message: errorMessage(cause) }),
  });
}

/**
 * Chain-delete every Consolidation Record for a session. Cascades remove the
 * records' findings, evidence pointers, and disposition edges (including
 * cross-record dispositions that targeted those findings). The future redaction
 * cascade calls this to invalidate a session's whole record chain.
 */
export function deleteConsolidationRecordsForSession(
  service: DatabaseService,
  input: DeleteConsolidationRecordsForSessionInput,
): Effect.Effect<number, DatabaseError | ConsolidationRecordError> {
  return Effect.tryPromise({
    try: async () => {
      const deleted = await service.db
        .delete(consolidationRecords)
        .where(
          and(
            eq(consolidationRecords.workspaceId, input.workspaceId),
            eq(consolidationRecords.sessionId, input.sessionId),
          ),
        )
        .returning({ id: consolidationRecords.id });
      return deleted.length;
    },
    catch: (cause) =>
      cause instanceof ConsolidationRecordError
        ? cause
        : new ConsolidationRecordError({ message: errorMessage(cause) }),
  });
}

async function loadRecordDetails(
  db: DatabaseService['db'] | Tx,
  input: { recordIds: readonly string[]; workspaceId: string },
): Promise<ConsolidationRecordDetail[]> {
  if (input.recordIds.length === 0) {
    return [];
  }

  const recordRows = await db
    .select()
    .from(consolidationRecords)
    .where(
      and(
        eq(consolidationRecords.workspaceId, input.workspaceId),
        inArray(consolidationRecords.id, [...input.recordIds]),
      ),
    );

  const findingRows = await db
    .select()
    .from(consolidationFindings)
    .where(
      and(
        eq(consolidationFindings.workspaceId, input.workspaceId),
        inArray(consolidationFindings.recordId, [...input.recordIds]),
      ),
    )
    .orderBy(asc(consolidationFindings.recordId), asc(consolidationFindings.ordinal));

  const findingIds = findingRows.map((row) => row.id);
  const pointerRows =
    findingIds.length === 0
      ? []
      : await db
          .select()
          .from(consolidationEvidencePointers)
          .where(
            and(
              eq(consolidationEvidencePointers.workspaceId, input.workspaceId),
              inArray(consolidationEvidencePointers.findingId, findingIds),
            ),
          )
          .orderBy(asc(consolidationEvidencePointers.createdAt), asc(consolidationEvidencePointers.id));

  const dispositionRows = await db
    .select()
    .from(consolidationDispositions)
    .where(
      and(
        eq(consolidationDispositions.workspaceId, input.workspaceId),
        inArray(consolidationDispositions.recordId, [...input.recordIds]),
      ),
    )
    .orderBy(asc(consolidationDispositions.createdAt), asc(consolidationDispositions.id));

  const pointersByFinding = new Map<string, ConsolidationEvidencePointer[]>();
  for (const row of pointerRows) {
    const existing = pointersByFinding.get(row.findingId) ?? [];
    existing.push({
      activityIntervalOrdinal: row.activityIntervalOrdinal,
      id: row.id,
      sessionId: row.pointerSessionId,
      turnOrdinal: row.turnOrdinal,
    });
    pointersByFinding.set(row.findingId, existing);
  }

  const findingsByRecord = new Map<string, ConsolidationFinding[]>();
  for (const row of findingRows) {
    const existing = findingsByRecord.get(row.recordId) ?? [];
    existing.push({
      evidence: pointersByFinding.get(row.id) ?? [],
      id: row.id,
      ordinal: row.ordinal,
      text: row.text,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- finding_type is check-constrained to FindingType at the database
      type: row.findingType as FindingType,
    });
    findingsByRecord.set(row.recordId, existing);
  }

  const dispositionsByRecord = new Map<string, ConsolidationDisposition[]>();
  for (const row of dispositionRows) {
    const existing = dispositionsByRecord.get(row.recordId) ?? [];
    existing.push({
      fromFindingId: row.fromFindingId,
      id: row.id,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- kind is check-constrained to DispositionKind at the database
      kind: row.kind as DispositionKind,
      toFindingId: row.toFindingId,
    });
    dispositionsByRecord.set(row.recordId, existing);
  }

  return recordRows.map((row) => ({
    activityIntervalId: row.activityIntervalId,
    authPath: row.authPath,
    createdAt: row.createdAt,
    dispositions: dispositionsByRecord.get(row.id) ?? [],
    findings: findingsByRecord.get(row.id) ?? [],
    id: row.id,
    modelId: row.modelId,
    narrative: row.narrative,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
  }));
}

function rowsFromExecute<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- raw driver rows; T is the caller-declared row shape
    return value as T[];
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'rows' in value &&
    Array.isArray((value as { rows: unknown }).rows)
  ) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- raw driver rows; T is the caller-declared row shape
    return (value as { rows: T[] }).rows;
  }
  return [];
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
