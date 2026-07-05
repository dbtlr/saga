import { randomUUID } from 'node:crypto';

import { ConsolidationOutput } from '@saga/contracts';
import type {
  DispositionKind,
  EvidencePointer,
  FindingType,
  OutputDisposition,
  OutputFinding,
} from '@saga/contracts';
import { and, asc, eq, inArray, sql as drizzleSql } from 'drizzle-orm';
import { Data, Effect, Schema } from 'effect';

import type { DatabaseError, DatabaseService } from './database.js';
import { rowsFromExecute } from './raw-rows.js';
import {
  activityIntervals,
  consolidationDispositions,
  consolidationEvidencePointers,
  consolidationFindings,
  consolidationRecords,
} from './schema.js';

type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

// The write-path input types are the contract's extractor-facing shapes: the
// contract (not a hand-rolled duplicate) is the source of truth, and it runs at
// the persistence boundary via Schema.decodeUnknownSync below.
export type ConsolidationEvidencePointerInput = EvidencePointer;
export type ConsolidationFindingInput = OutputFinding;
export type ConsolidationDispositionInput = OutputDisposition;

export type InsertConsolidationRecordInput = {
  activityIntervalId: string;
  authPath: string;
  dispositions?: readonly ConsolidationDispositionInput[] | undefined;
  findings: readonly ConsolidationFindingInput[];
  id?: string | undefined;
  modelId: string;
  narrative: string;
  sessionId: string;
  workspaceId: string;
};

export type ConsolidationEvidencePointer = {
  activityIntervalOrdinal: number | undefined;
  id: string;
  ordinal: number;
  sessionId: string;
  turnOrdinal: number | undefined;
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
  ordinal: number;
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

export type DeleteConsolidationRecordsForLineageInput = {
  sessionId: string;
  workspaceId: string;
};

export class ConsolidationRecordError extends Data.TaggedError('ConsolidationRecordError')<{
  readonly message: string;
}> {}

// A disposition resolved from local keys to minted/persisted finding UUIDs.
type ResolvedDisposition = {
  external: boolean;
  fromFindingId: string;
  kind: DispositionKind;
  toFindingId: string;
};

/**
 * Insert one complete, immutable Consolidation Record (record + findings +
 * evidence pointers + disposition edges) in a single transaction.
 *
 * The input is the extractor-facing {@link ConsolidationOutput} shape: findings
 * carry LOCAL keys, never row ids. This function mints the finding UUIDs, resolves
 * every local-key reference to a minted UUID, validates that cross-record targets
 * lie in the session's continuation lineage, and persists the resolved graph.
 *
 * Two validations live here because the database cannot express them:
 *   - duplicate local finding keys are rejected before minting (pre-mint dedup);
 *   - a cross-record disposition target must belong to the same session or its
 *     continuation lineage (sessions joined by explicit continuation evidence).
 *
 * The unique-per-interval, finding-type, disposition-kind, no-self-loop, and
 * unique-edge guarantees are owned by database constraints and are not re-checked.
 */
export function insertConsolidationRecord(
  service: DatabaseService,
  input: InsertConsolidationRecordInput,
): Effect.Effect<ConsolidationRecordDetail, DatabaseError | ConsolidationRecordError> {
  return Effect.tryPromise({
    try: () => service.db.transaction((tx) => insertConsolidationRecordUnsafe(tx, input)),
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
  const output = decodeOutput(input);

  // Mint one UUID per finding, rejecting duplicate local keys (a check the
  // database cannot do because it never sees the keys).
  const idByKey = new Map<string, string>();
  for (const finding of output.findings) {
    if (idByKey.has(finding.key)) {
      throw new ConsolidationRecordError({
        message: `duplicate finding key "${finding.key}" within the record`,
      });
    }
    idByKey.set(finding.key, randomUUID());
  }

  const resolvedDispositions = output.dispositions.map((disposition) =>
    resolveDisposition(disposition, idByKey),
  );

  await validateExternalTargets(tx, {
    externalTargets: [
      ...new Set(
        resolvedDispositions
          .filter((d) => d.external)
          .map((disposition) => disposition.toFindingId),
      ),
    ],
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
  });

  const [recordRow] = await tx
    .insert(consolidationRecords)
    .values({
      activityIntervalId: input.activityIntervalId,
      authPath: input.authPath,
      id: input.id,
      modelId: input.modelId,
      narrative: output.narrative,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
    })
    .returning();
  if (recordRow === undefined) {
    throw new ConsolidationRecordError({ message: 'consolidation record insert returned no row' });
  }

  const findingRows =
    output.findings.length === 0
      ? []
      : await tx
          .insert(consolidationFindings)
          .values(
            output.findings.map((finding, index) => ({
              findingType: finding.type,
              id: idByKey.get(finding.key),
              ordinal: index,
              recordId: recordRow.id,
              sessionId: input.sessionId,
              text: finding.text,
              workspaceId: input.workspaceId,
            })),
          )
          .returning();

  const pointerValues = output.findings.flatMap((finding) =>
    finding.evidence.map((pointer, ordinal) => ({
      activityIntervalOrdinal: pointer.activityIntervalOrdinal ?? null,
      findingId: idByKey.get(finding.key) ?? '',
      ordinal,
      pointerSessionId: pointer.sessionId,
      turnOrdinal: pointer.turnOrdinal ?? null,
      workspaceId: input.workspaceId,
    })),
  );
  const pointerRows =
    pointerValues.length === 0
      ? []
      : await tx.insert(consolidationEvidencePointers).values(pointerValues).returning();

  const dispositionRows =
    resolvedDispositions.length === 0
      ? []
      : await tx
          .insert(consolidationDispositions)
          .values(
            resolvedDispositions.map((disposition, ordinal) => ({
              fromFindingId: disposition.fromFindingId,
              kind: disposition.kind,
              ordinal,
              recordId: recordRow.id,
              sessionId: input.sessionId,
              toFindingId: disposition.toFindingId,
              workspaceId: input.workspaceId,
            })),
          )
          .returning();

  // Assemble the returned detail straight from the transaction's writes rather
  // than issuing four more SELECTs (parity with loadRecordDetails is asserted by test).
  const detail = buildRecordDetails([recordRow], findingRows, pointerRows, dispositionRows)[0];
  if (detail === undefined) {
    throw new ConsolidationRecordError({
      message: 'consolidation record disappeared after insert',
    });
  }
  return detail;
}

function decodeOutput(input: InsertConsolidationRecordInput): ConsolidationOutput {
  try {
    return Schema.decodeUnknownSync(ConsolidationOutput)({
      narrative: input.narrative,
      findings: input.findings,
      dispositions: input.dispositions ?? [],
    });
  } catch (cause) {
    throw new ConsolidationRecordError({
      message: `invalid consolidation output: ${errorMessage(cause)}`,
    });
  }
}

function resolveDisposition(
  disposition: OutputDisposition,
  idByKey: ReadonlyMap<string, string>,
): ResolvedDisposition {
  const fromFindingId = idByKey.get(disposition.fromKey);
  if (fromFindingId === undefined) {
    throw new ConsolidationRecordError({
      message: `disposition source key "${disposition.fromKey}" is not a finding in this record`,
    });
  }
  if ('toKey' in disposition) {
    const toFindingId = idByKey.get(disposition.toKey);
    if (toFindingId === undefined) {
      throw new ConsolidationRecordError({
        message: `disposition target key "${disposition.toKey}" is not a finding in this record`,
      });
    }
    return { external: false, fromFindingId, kind: disposition.kind, toFindingId };
  }
  return {
    external: true,
    fromFindingId,
    kind: disposition.kind,
    toFindingId: disposition.toFindingId,
  };
}

async function validateExternalTargets(
  tx: Tx,
  input: { externalTargets: readonly string[]; sessionId: string; workspaceId: string },
): Promise<void> {
  if (input.externalTargets.length === 0) {
    return;
  }

  const lineage = await lineageSessionIds(tx, input.workspaceId, input.sessionId);
  const targetRows = await tx
    .select({ id: consolidationFindings.id, sessionId: consolidationFindings.sessionId })
    .from(consolidationFindings)
    .where(
      and(
        eq(consolidationFindings.workspaceId, input.workspaceId),
        inArray(consolidationFindings.id, [...input.externalTargets]),
      ),
    );
  const targetSessionById = new Map(targetRows.map((row) => [row.id, row.sessionId]));

  for (const targetId of input.externalTargets) {
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
 * transitively. Shared by disposition validation and lineage invalidation so both
 * see the same set. A depth cap bounds a pathological continuation graph.
 */
async function lineageSessionIds(
  tx: Tx,
  workspaceId: string,
  sessionId: string,
): Promise<Set<string>> {
  const rows = rowsFromExecute<{ session_id: string }>(
    await tx.execute(drizzleSql`
      with recursive lineage(session_id, depth) as (
        select ${sessionId}::uuid as session_id, 0 as depth
        union
        select
          case
            when sr.source_session_id = l.session_id then sr.target_session_id
            else sr.source_session_id
          end as session_id,
          l.depth + 1 as depth
        from session_relationships sr
        inner join lineage l
          on sr.source_session_id = l.session_id
          or sr.target_session_id = l.session_id
        where sr.workspace_id = ${workspaceId}
          and sr.relationship_type = 'continuation'
          and sr.confidence = 'explicit'
          and l.depth < 64
      )
      select distinct session_id::text as session_id from lineage
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
 * Chain-delete every Consolidation Record for the continuation lineage of a
 * session — the session itself and every session joined to it by explicit
 * continuation evidence. Chain invalidation operates on the lineage, not a single
 * session, because cross-session disposition edges cannot be rebuilt by per-session
 * regeneration: dropping one session's chain would leave dangling edges (or, once
 * regenerated, no way to reproduce them). Cascades remove the records' findings,
 * evidence pointers, and disposition edges. Returns the number of records deleted.
 */
export function deleteConsolidationRecordsForLineage(
  service: DatabaseService,
  input: DeleteConsolidationRecordsForLineageInput,
): Effect.Effect<number, DatabaseError | ConsolidationRecordError> {
  return Effect.tryPromise({
    try: () =>
      service.db.transaction(async (tx) => {
        const lineage = await lineageSessionIds(tx, input.workspaceId, input.sessionId);
        const sessionIds = [...lineage];
        if (sessionIds.length === 0) {
          return 0;
        }
        const deleted = await tx
          .delete(consolidationRecords)
          .where(
            and(
              eq(consolidationRecords.workspaceId, input.workspaceId),
              inArray(consolidationRecords.sessionId, sessionIds),
            ),
          )
          .returning({ id: consolidationRecords.id });
        return deleted.length;
      }),
    catch: (cause) =>
      cause instanceof ConsolidationRecordError
        ? cause
        : new ConsolidationRecordError({ message: errorMessage(cause) }),
  });
}

type RecordRow = typeof consolidationRecords.$inferSelect;
type FindingRow = typeof consolidationFindings.$inferSelect;
type PointerRow = typeof consolidationEvidencePointers.$inferSelect;
type DispositionRow = typeof consolidationDispositions.$inferSelect;

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
          .orderBy(
            asc(consolidationEvidencePointers.findingId),
            asc(consolidationEvidencePointers.ordinal),
          );

  const dispositionRows = await db
    .select()
    .from(consolidationDispositions)
    .where(
      and(
        eq(consolidationDispositions.workspaceId, input.workspaceId),
        inArray(consolidationDispositions.recordId, [...input.recordIds]),
      ),
    )
    .orderBy(asc(consolidationDispositions.recordId), asc(consolidationDispositions.ordinal));

  return buildRecordDetails(recordRows, findingRows, pointerRows, dispositionRows);
}

// Single assembler shared by the write path (from `.returning()` rows) and the
// read path (from SELECTed rows), so the two are provably identical in shape and
// order. Ordering is by the persisted ordinals, so input row order is irrelevant.
function buildRecordDetails(
  recordRows: readonly RecordRow[],
  findingRows: readonly FindingRow[],
  pointerRows: readonly PointerRow[],
  dispositionRows: readonly DispositionRow[],
): ConsolidationRecordDetail[] {
  const pointersByFinding = new Map<string, ConsolidationEvidencePointer[]>();
  for (const row of [...pointerRows].toSorted((a, b) => a.ordinal - b.ordinal)) {
    const existing = pointersByFinding.get(row.findingId) ?? [];
    existing.push({
      activityIntervalOrdinal: row.activityIntervalOrdinal ?? undefined,
      id: row.id,
      ordinal: row.ordinal,
      sessionId: row.pointerSessionId,
      turnOrdinal: row.turnOrdinal ?? undefined,
    });
    pointersByFinding.set(row.findingId, existing);
  }

  const findingsByRecord = new Map<string, ConsolidationFinding[]>();
  for (const row of [...findingRows].toSorted((a, b) => a.ordinal - b.ordinal)) {
    const existing = findingsByRecord.get(row.recordId) ?? [];
    existing.push({
      evidence: pointersByFinding.get(row.id) ?? [],
      id: row.id,
      ordinal: row.ordinal,
      text: row.text,
      type: row.findingType,
    });
    findingsByRecord.set(row.recordId, existing);
  }

  const dispositionsByRecord = new Map<string, ConsolidationDisposition[]>();
  for (const row of [...dispositionRows].toSorted((a, b) => a.ordinal - b.ordinal)) {
    const existing = dispositionsByRecord.get(row.recordId) ?? [];
    existing.push({
      fromFindingId: row.fromFindingId,
      id: row.id,
      kind: row.kind,
      ordinal: row.ordinal,
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
