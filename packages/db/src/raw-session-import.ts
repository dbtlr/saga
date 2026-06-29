import { createHash } from 'node:crypto';

import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { Data, Effect } from 'effect';

import {
  extractClaudeTranscriptImportHints,
  normalizeClaudeTranscript,
} from './claude-transcript-normalizer.js';
import {
  extractCodexTranscriptImportHints,
  normalizeCodexTranscript,
} from './codex-transcript-normalizer.js';
import type { DatabaseError, DatabaseService } from './database.js';
import {
  activityIntervals,
  rawSessionRecords,
  sessionSegmentEmbeddings,
  sessionRelationships,
  sessionSegments,
  sessionTurns,
  sessions,
  sourceBindings,
  users,
  workspaces,
} from './schema.js';
import type { ActivityInterval, RawSessionRecord, Session, SourceBinding, User } from './schema.js';
import { insertDerivedSessionSegments, sessionSegmentsAreCurrent } from './session-segments.js';
import type {
  NormalizedTranscriptTurn,
  TranscriptImportHints,
  TranscriptNormalization,
} from './transcript-normalizer.js';

export type RawSessionHarness = 'claude' | 'codex';
export type RawSessionContentType = 'json' | 'jsonl' | 'text';
export type RawSessionImportStatus = 'inserted' | 'unchanged';
type JsonBody = boolean | null | number | string | JsonBody[] | { [key: string]: JsonBody };
const SESSION_RELATIONSHIP_IMPORT_DERIVATION = 'session-relationship-import-v1';
type ActivityIntervalSettlementReason = 'clear_context' | 'idle_timeout' | 'manual' | 'stop_event';

const ACTIVITY_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export type RawSessionImportInput = {
  activity?: RawSessionImportActivityInput | undefined;
  author: {
    displayName?: string | undefined;
    handle: string;
    externalSubject?: string | undefined;
  };
  capturedAt?: Date | string | undefined;
  contentType: RawSessionContentType;
  harness: RawSessionHarness;
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
  rawRecord?:
    | {
        inactivePrevious?:
          | {
              metadata?: Record<string, unknown> | undefined;
              provenance?: Record<string, unknown> | undefined;
              status?: string | undefined;
            }
          | undefined;
        expectedActiveRawSessionRecordId?: string | undefined;
        redactedFromRawSessionRecordId?: string | undefined;
        status?: string | undefined;
      }
    | undefined;
  rawContent: string;
  sourceBindingId?: string | undefined;
  status?: 'active' | 'completed' | undefined;
  title?: string | undefined;
  workspaceId: string;
};

export type RawSessionImportActivityInput = {
  hookEventName?: string | undefined;
  sessionStartSource?: string | undefined;
  settlementTriggerRawEventId?: string | undefined;
};

export type RawSessionImportResult = {
  activityInterval: ActivityInterval;
  authorUser: User;
  contentHash: string;
  operation: RawSessionImportStatus;
  rawSessionRecord: RawSessionRecord;
  session: Session;
  sourceBinding: SourceBinding;
};

// operation: "opened" = new interval opened (incl. fresh SessionStart shell);
//            "settled" = active interval settled (Stop); "settled_opened" = settle old + open new (clear/compact/idle);
//            "updated" = session touched, no interval boundary; "unchanged" = idempotent no-op for this rawEventId.
export type LifecycleBoundaryOperation =
  | 'opened'
  | 'settled'
  | 'settled_opened'
  | 'updated'
  | 'unchanged';

export type LifecycleBoundaryInput = {
  activity: {
    hookEventName?: string | undefined;
    sessionStartSource?: string | undefined;
    settlementTriggerRawEventId: string;
  };
  author: {
    displayName?: string | undefined;
    handle: string;
    externalSubject?: string | undefined;
  };
  capturedAt: Date | string;
  harness: RawSessionHarness;
  harnessMetadata?: Record<string, unknown> | undefined;
  harnessSessionId?: string | undefined;
  host: { id: string; label?: string | undefined; projectRoot?: string | undefined };
  locator?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  model?: string | undefined;
  provenance?: Record<string, unknown> | undefined;
  sourceBindingId?: string | undefined;
  status?: 'active' | 'completed' | undefined;
  title?: string | undefined;
  workspaceId: string;
};

export type LifecycleBoundaryResult = {
  activityInterval: ActivityInterval;
  authorUser: User;
  operation: LifecycleBoundaryOperation;
  session: Session;
  sourceBinding: SourceBinding;
  // NOTE: deliberately NO rawSessionRecord field — ADR-0030.
};

export class RawSessionImportError extends Data.TaggedError('RawSessionImportError')<{
  readonly message: string;
}> {}

export function importRawSessionRecord(
  service: DatabaseService,
  input: RawSessionImportInput,
): Effect.Effect<RawSessionImportResult, DatabaseError | RawSessionImportError> {
  return Effect.tryPromise({
    try: () => importRawSessionRecordWithConflictRetry(service, normalizeInput(input)),
    catch: (cause) =>
      cause instanceof RawSessionImportError
        ? cause
        : new RawSessionImportError({ message: errorMessage(cause) }),
  });
}

export function importRawSessionRecordInTransaction(
  tx: DatabaseService['db'],
  input: RawSessionImportInput,
): Effect.Effect<RawSessionImportResult, DatabaseError | RawSessionImportError> {
  return Effect.tryPromise({
    try: () => importRawSessionRecordInTransactionUnsafe(tx, normalizeInput(input)),
    catch: (cause) =>
      cause instanceof RawSessionImportError
        ? cause
        : new RawSessionImportError({ message: errorMessage(cause) }),
  });
}

export function importLifecycleBoundaryEvent(
  service: DatabaseService,
  input: LifecycleBoundaryInput,
): Effect.Effect<LifecycleBoundaryResult, DatabaseError | RawSessionImportError> {
  return Effect.tryPromise({
    try: () =>
      service.db.transaction((tx) =>
        importLifecycleBoundaryEventInTransactionUnsafe(
          tx as DatabaseService['db'],
          normalizeLifecycleInput(input),
        ),
      ),
    catch: (cause) =>
      cause instanceof RawSessionImportError
        ? cause
        : new RawSessionImportError({ message: errorMessage(cause) }),
  });
}

async function importRawSessionRecordWithConflictRetry(
  service: DatabaseService,
  input: NormalizedRawSessionImportInput,
): Promise<RawSessionImportResult> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await importRawSessionRecordUnsafe(service, input);
    } catch (cause) {
      if (attempt === maxAttempts || !isRetryableImportConflict(cause)) {
        throw cause;
      }
    }
  }
  throw new RawSessionImportError({ message: 'raw session import retry exhausted' });
}

async function importRawSessionRecordUnsafe(
  service: DatabaseService,
  input: NormalizedRawSessionImportInput,
): Promise<RawSessionImportResult> {
  return service.db.transaction((tx) =>
    importRawSessionRecordInTransactionUnsafe(tx as DatabaseService['db'], input),
  );
}

async function importRawSessionRecordInTransactionUnsafe(
  tx: DatabaseService['db'],
  input: NormalizedRawSessionImportInput,
): Promise<RawSessionImportResult> {
  const [workspace] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);

  if (workspace === undefined) {
    throw new RawSessionImportError({
      message: 'workspace binding is required before importing raw sessions',
    });
  }

  const now = new Date();
  const transcriptNormalization = normalizeTranscript(input);
  const noopImport = await findCurrentNoopRawSessionImport(tx, {
    input,
    now,
    transcriptNormalization,
  });
  if (noopImport !== undefined) {
    const relationshipSession = await deriveSessionRelationships(tx, {
      input,
      session: noopImport.session,
    });
    return {
      ...noopImport,
      session: relationshipSession,
    };
  }

  const authorUser = await upsertHostAuthor(tx, { input, now });
  const sourceBinding = await resolveRawSessionSourceBinding(tx, { input, now });

  const session = await resolveSession(tx, {
    authorUserId: authorUser.id,
    input,
    sourceBindingId: sourceBinding.id,
  });

  const [activeRecord] = await tx
    .select()
    .from(rawSessionRecords)
    .where(
      and(
        eq(rawSessionRecords.workspaceId, input.workspaceId),
        eq(rawSessionRecords.sessionId, session.id),
        eq(rawSessionRecords.isActive, true),
      ),
    )
    .limit(1);
  assertExpectedActiveRawSessionRecord(input, activeRecord);

  const existingRecord = await findRawSessionRecordByContentHash(tx, {
    contentHash: input.contentHash,
    sessionId: session.id,
  });
  if (existingRecord !== undefined) {
    const existing = await reuseExistingRawSessionRecord(tx, {
      existingRecord,
      input,
      now,
      session,
      transcriptNormalization,
    });
    const relationshipSession = await deriveSessionRelationships(tx, {
      input,
      session: existing.session,
    });
    return {
      activityInterval: existing.activityInterval,
      authorUser,
      contentHash: input.contentHash,
      operation: 'unchanged',
      rawSessionRecord: existing.rawSessionRecord,
      session: relationshipSession,
      sourceBinding,
    };
  }

  const [maxSnapshot] = await tx
    .select({ snapshotOrdinal: rawSessionRecords.snapshotOrdinal })
    .from(rawSessionRecords)
    .where(eq(rawSessionRecords.sessionId, session.id))
    .orderBy(desc(rawSessionRecords.snapshotOrdinal))
    .limit(1);

  const activityResolution = await resolveActivityInterval(tx, {
    input,
    now,
    session,
    transcriptNormalization,
  });
  const activityInterval = activityResolution.activityInterval;
  const nextSnapshotOrdinal = (maxSnapshot?.snapshotOrdinal ?? -1) + 1;
  if (activeRecord !== undefined) {
    const inactivePrevious = input.rawRecord?.inactivePrevious;
    const [inactiveRawSessionRecord] = await tx
      .update(rawSessionRecords)
      .set({
        isActive: false,
        metadata:
          inactivePrevious?.metadata === undefined
            ? activeRecord.metadata
            : {
                ...asRecord(activeRecord.metadata),
                ...inactivePrevious.metadata,
              },
        provenance:
          inactivePrevious?.provenance === undefined
            ? activeRecord.provenance
            : {
                ...asRecord(activeRecord.provenance),
                ...inactivePrevious.provenance,
              },
        status: inactivePrevious?.status ?? activeRecord.status,
        updatedAt: now,
      })
      .where(
        and(
          eq(rawSessionRecords.workspaceId, input.workspaceId),
          eq(rawSessionRecords.id, activeRecord.id),
          eq(rawSessionRecords.isActive, true),
        ),
      )
      .returning({ id: rawSessionRecords.id });
    if (inactiveRawSessionRecord === undefined) {
      if (input.rawRecord?.expectedActiveRawSessionRecordId === undefined) {
        const racedRecord = await findRawSessionRecordByContentHash(tx, {
          contentHash: input.contentHash,
          sessionId: session.id,
        });
        if (racedRecord !== undefined) {
          const existing = await reuseExistingRawSessionRecord(tx, {
            existingRecord: racedRecord,
            input,
            now,
            session,
            transcriptNormalization,
          });
          const relationshipSession = await deriveSessionRelationships(tx, {
            input,
            session: existing.session,
          });
          return {
            activityInterval: existing.activityInterval,
            authorUser,
            contentHash: input.contentHash,
            operation: 'unchanged',
            rawSessionRecord: existing.rawSessionRecord,
            session: relationshipSession,
            sourceBinding,
          };
        }
      }
      throw new RawSessionImportError({
        message: 'active raw session record changed during import',
      });
    }
  }

  const rawBody = buildRawBody(input);
  const [insertedRawSessionRecord] = await tx
    .insert(rawSessionRecords)
    .values({
      activityIntervalId: activityInterval.id,
      authorUserId: authorUser.id,
      bodyJson: rawBody.bodyJson,
      bodyText: rawBody.bodyText,
      capturedAt: input.capturedAt,
      contentBytes: input.contentBytes,
      contentHash: input.contentHash,
      contentType: input.contentType,
      harness: input.harness,
      harnessSessionId: input.harnessSessionId,
      isActive: true,
      metadata: {
        ...input.metadata,
        contentBytes: input.contentBytes,
        harness: input.harnessMetadata,
        normalization: transcriptNormalization?.metadata,
        sourceLocatorHash: input.sourceLocatorHash,
      },
      provenance: input.provenance,
      redactedFromRawSessionRecordId: input.rawRecord?.redactedFromRawSessionRecordId,
      sessionId: session.id,
      snapshotOrdinal: nextSnapshotOrdinal,
      sourceBindingId: sourceBinding.id,
      sourceLocator: input.locator,
      status: input.rawRecord?.status ?? 'captured',
      workspaceId: input.workspaceId,
    })
    .onConflictDoNothing({
      target: [rawSessionRecords.sessionId, rawSessionRecords.contentHash],
    })
    .returning();
  if (insertedRawSessionRecord === undefined) {
    const racedRecord = await findRawSessionRecordByContentHash(tx, {
      contentHash: input.contentHash,
      sessionId: session.id,
    });
    if (racedRecord === undefined) {
      throw new RawSessionImportError({ message: 'raw session record insert returned no row' });
    }
    const existing = await reuseExistingRawSessionRecord(tx, {
      existingRecord: racedRecord,
      input,
      now,
      session,
      transcriptNormalization,
    });
    const relationshipSession = await deriveSessionRelationships(tx, {
      input,
      session: existing.session,
    });
    return {
      activityInterval: existing.activityInterval,
      authorUser,
      contentHash: input.contentHash,
      operation: 'unchanged',
      rawSessionRecord: existing.rawSessionRecord,
      session: relationshipSession,
      sourceBinding,
    };
  }

  const updated = await refreshSessionAndActivityInterval(tx, {
    activityInterval,
    input,
    now,
    rawSessionRecordId: insertedRawSessionRecord.id,
    settlement: activityResolution.settlement,
    session,
    transcriptNormalization,
  });

  await regenerateDerivedSessionRecords(tx, {
    activityIntervalId: activityInterval.id,
    input,
    transcriptNormalization,
    rawSessionRecordId: insertedRawSessionRecord.id,
    sessionId: session.id,
  });

  await deriveSessionRelationships(tx, {
    input,
    session: updated.session,
  });

  return {
    activityInterval: updated.activityInterval,
    authorUser,
    contentHash: input.contentHash,
    operation: 'inserted',
    rawSessionRecord: insertedRawSessionRecord,
    session: updated.session,
    sourceBinding,
  };
}

async function findCurrentNoopRawSessionImport(
  tx: DatabaseService['db'],
  input: {
    input: NormalizedRawSessionImportInput;
    now: Date;
    transcriptNormalization?: TranscriptNormalization | undefined;
  },
): Promise<RawSessionImportResult | undefined> {
  const sourceBinding = await findCurrentRawSessionSourceBinding(tx, input.input);
  if (sourceBinding === undefined) {
    return undefined;
  }

  const session = await findSessionWithoutAdoption(tx, {
    input: input.input,
    sourceBindingId: sourceBinding.id,
  });
  if (session === undefined) {
    return undefined;
  }

  const [activeRecord] = await tx
    .select()
    .from(rawSessionRecords)
    .where(
      and(
        eq(rawSessionRecords.workspaceId, input.input.workspaceId),
        eq(rawSessionRecords.sessionId, session.id),
        eq(rawSessionRecords.isActive, true),
      ),
    )
    .limit(1);
  assertExpectedActiveRawSessionRecord(input.input, activeRecord);

  const existingRecord = await findRawSessionRecordByContentHash(tx, {
    contentHash: input.input.contentHash,
    sessionId: session.id,
  });
  if (
    existingRecord === undefined ||
    !existingRecord.isActive ||
    activeRecord?.id !== existingRecord.id ||
    existingRecord.activityIntervalId === null
  ) {
    return undefined;
  }

  const activityInterval = await findActivityIntervalById(tx, {
    id: existingRecord.activityIntervalId,
    workspaceId: input.input.workspaceId,
  });
  // ADR-0031: the record and the Turns/Segments it produced stay in their producing interval, which
  // an earlier same-content boundary may have settled. The session's current active interval — the
  // freshly opened, possibly empty one — is what an idempotent boundary reimport should observe and
  // return, even though the active record itself sits in the prior (settled) interval.
  const activeInterval =
    (await findActiveActivityInterval(tx, {
      sessionId: session.id,
      workspaceId: input.input.workspaceId,
    })) ?? activityInterval;
  const authorUser = await findCurrentHostUser(tx, input.input);
  if (authorUser === undefined || session.authorUserId !== authorUser.id) {
    return undefined;
  }

  if (
    session.sourceBindingId !== sourceBinding.id ||
    existingRecord.sourceBindingId !== sourceBinding.id ||
    existingRecord.authorUserId !== authorUser.id
  ) {
    return undefined;
  }

  if (
    activityIntervalBoundaryRequiredForExistingRawSessionRecord({
      activityInterval,
      input: input.input,
      session,
      transcriptNormalization: input.transcriptNormalization,
    })
  ) {
    return undefined;
  }

  if (
    !(await rawSessionRecordIsCurrent(tx, {
      activityIntervalId: activityInterval.id,
      existingRecord,
      input: input.input,
      sessionId: session.id,
      transcriptNormalization: input.transcriptNormalization,
    }))
  ) {
    return undefined;
  }

  const repeatedBoundaryAlreadySatisfied =
    repeatedActivityIntervalBoundaryAlreadySatisfiedForExistingRawSessionRecord({
      activityInterval: activeInterval,
      input: input.input,
      session,
    });

  const settlement = settlementForExistingRawSessionRecord({
    activityInterval: activeInterval,
    input: input.input,
    now: input.now,
    transcriptNormalization: input.transcriptNormalization,
  });
  if (
    !sessionIsCurrentForRefresh({
      input: input.input,
      rawSessionRecordId: existingRecord.id,
      session,
      sessionLastActivityAt: repeatedBoundaryAlreadySatisfied ? input.input.capturedAt : undefined,
      settlement,
      transcriptNormalization: input.transcriptNormalization,
    }) ||
    !activityIntervalIsCurrentForRefresh({
      activityInterval: activeInterval,
      activityIntervalStartedAt: repeatedBoundaryAlreadySatisfied
        ? input.input.capturedAt
        : undefined,
      settlement,
      transcriptNormalization: input.transcriptNormalization,
    })
  ) {
    return undefined;
  }

  return {
    activityInterval: activeInterval,
    authorUser,
    contentHash: input.input.contentHash,
    operation: 'unchanged',
    rawSessionRecord: existingRecord,
    session,
    sourceBinding,
  };
}

async function reuseExistingRawSessionRecord(
  tx: DatabaseService['db'],
  input: {
    existingRecord: RawSessionRecord;
    input: NormalizedRawSessionImportInput;
    now: Date;
    session: Session;
    transcriptNormalization?: TranscriptNormalization | undefined;
  },
): Promise<{
  activityInterval: ActivityInterval;
  rawSessionRecord: RawSessionRecord;
  session: Session;
}> {
  // ADR-0031: the record stays in its producing interval, which an earlier same-content boundary
  // may have settled. A boundary in THIS event acts on the session's current active interval, so
  // evaluate boundary work against that active interval — not the record's (possibly settled) one.
  // Derived rows still home to the record's producing interval (derivedHomeIntervalId below).
  const boundaryBaseInterval =
    (await findActiveActivityInterval(tx, {
      sessionId: input.session.id,
      workspaceId: input.input.workspaceId,
    })) ??
    (input.existingRecord.activityIntervalId === null
      ? undefined
      : await findActivityIntervalById(tx, {
          id: input.existingRecord.activityIntervalId,
          workspaceId: input.input.workspaceId,
        }));
  const requiresBoundaryWork =
    input.existingRecord.isActive &&
    boundaryBaseInterval !== undefined &&
    activityIntervalBoundaryRequiredForExistingRawSessionRecord({
      activityInterval: boundaryBaseInterval,
      input: input.input,
      session: input.session,
      transcriptNormalization: input.transcriptNormalization,
    });
  const resolvedInterval =
    requiresBoundaryWork || boundaryBaseInterval === undefined
      ? await resolveActivityInterval(tx, {
          input: input.input,
          now: input.now,
          session: input.session,
          transcriptNormalization: input.transcriptNormalization,
        }).then((resolution) => resolution.activityInterval)
      : boundaryBaseInterval;
  const boundaryAlreadySatisfied =
    !requiresBoundaryWork &&
    repeatedActivityIntervalBoundaryAlreadySatisfiedForExistingRawSessionRecord({
      activityInterval: resolvedInterval,
      input: input.input,
      session: input.session,
    });
  // ADR-0031: a same-content boundary may settle the old interval and open a new empty one, but
  // the existing record and the Turns/Segments its snapshot produced stay in the interval whose
  // snapshot produced them — they are never reassigned to the freshly opened interval. Only an
  // unattributed record adopts the resolved interval.
  const derivedHomeIntervalId = input.existingRecord.activityIntervalId ?? resolvedInterval.id;
  const intervalAdjustedRecord =
    requiresBoundaryWork && input.existingRecord.activityIntervalId === null
      ? await updateActiveRawSessionRecordActivityInterval(tx, {
          activityIntervalId: derivedHomeIntervalId,
          existingRecord: input.existingRecord,
          now: input.now,
        })
      : input.existingRecord;
  const repairedRecord =
    intervalAdjustedRecord.isActive && input.transcriptNormalization !== undefined
      ? await repairActiveRawSessionRecordDerivedRows(tx, {
          activityIntervalId: derivedHomeIntervalId,
          existingRecord: intervalAdjustedRecord,
          input: input.input,
          sessionId: input.session.id,
          transcriptNormalization: input.transcriptNormalization,
        })
      : intervalAdjustedRecord;
  const existingSettlement = settlementForExistingRawSessionRecord({
    activityInterval: resolvedInterval,
    input: input.input,
    now: input.now,
    transcriptNormalization: input.transcriptNormalization,
  });
  const boundaryAlreadySatisfiedAndCurrent =
    boundaryAlreadySatisfied &&
    sessionIsCurrentForRefresh({
      input: input.input,
      rawSessionRecordId: repairedRecord.id,
      session: input.session,
      sessionLastActivityAt: input.input.capturedAt,
      settlement: existingSettlement,
      transcriptNormalization: input.transcriptNormalization,
    }) &&
    activityIntervalIsCurrentForRefresh({
      activityInterval: resolvedInterval,
      activityIntervalStartedAt: input.input.capturedAt,
      settlement: existingSettlement,
      transcriptNormalization: input.transcriptNormalization,
    });
  const refreshed =
    repairedRecord.isActive &&
    ((input.transcriptNormalization !== undefined && !boundaryAlreadySatisfiedAndCurrent) ||
      existingSettlement !== undefined ||
      requiresBoundaryWork ||
      (boundaryAlreadySatisfied && !boundaryAlreadySatisfiedAndCurrent))
      ? await refreshSessionAndActivityInterval(tx, {
          activityInterval: resolvedInterval,
          activityIntervalStartedAt:
            requiresBoundaryWork || boundaryAlreadySatisfied ? input.input.capturedAt : undefined,
          input: input.input,
          now: input.now,
          rawSessionRecordId: repairedRecord.id,
          settlement: existingSettlement,
          session: input.session,
          sessionLastActivityAt:
            requiresBoundaryWork || boundaryAlreadySatisfied ? input.input.capturedAt : undefined,
          transcriptNormalization: input.transcriptNormalization,
        })
      : { activityInterval: resolvedInterval, session: input.session };
  return {
    activityInterval: refreshed.activityInterval,
    rawSessionRecord: repairedRecord,
    session: refreshed.session,
  };
}

async function deriveSessionRelationships(
  tx: DatabaseService['db'],
  input: {
    input: NormalizedRawSessionImportInput;
    session: Session;
  },
): Promise<Session> {
  await deriveChildRelationshipsForSession(tx, {
    childSession: input.session,
    input: input.input,
  });

  if (input.session.harnessSessionId === null) {
    return input.session;
  }

  const peerSessions = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.workspaceId, input.input.workspaceId),
        eq(sessions.harness, input.input.harness),
        eq(sessions.sourceBindingId, input.session.sourceBindingId),
      ),
    );
  for (const peerSession of peerSessions) {
    if (peerSession.id === input.session.id) {
      continue;
    }
    const parentCandidates = relationshipParentCandidates(peerSession);
    if (
      !parentCandidates.some(
        (candidate) => candidate.parentHarnessSessionId === input.session.harnessSessionId,
      )
    ) {
      continue;
    }
    await insertOrRefreshChildRelationship(tx, {
      childSession: peerSession,
      input: input.input,
      parentSession: input.session,
      relationshipEvidence: relationshipEvidenceForCandidate(
        parentCandidates.find(
          (candidate) => candidate.parentHarnessSessionId === input.session.harnessSessionId,
        ),
        peerSession,
      ),
    });
  }

  return input.session;
}

async function deriveChildRelationshipsForSession(
  tx: DatabaseService['db'],
  input: {
    childSession: Session;
    input: NormalizedRawSessionImportInput;
  },
): Promise<void> {
  const candidates = relationshipParentCandidates(input.childSession);
  const desiredRelationships: {
    parentSession: Session;
    relationshipEvidence: Record<string, unknown>;
  }[] = [];

  for (const candidate of candidates) {
    const parentSession = await findParentSessionForRelationship(tx, {
      childSession: input.childSession,
      input: input.input,
      parentHarnessSessionId: candidate.parentHarnessSessionId,
    });
    if (parentSession === undefined) {
      continue;
    }
    desiredRelationships.push({
      parentSession,
      relationshipEvidence: relationshipEvidenceForCandidate(candidate, input.childSession),
    });
  }

  for (const desiredRelationship of desiredRelationships) {
    await insertOrRefreshChildRelationship(tx, {
      childSession: input.childSession,
      input: input.input,
      parentSession: desiredRelationship.parentSession,
      relationshipEvidence: desiredRelationship.relationshipEvidence,
    });
  }

  await deleteStaleChildRelationships(tx, {
    childSession: input.childSession,
    desiredParentSessionIds: desiredRelationships.map(
      (desiredRelationship) => desiredRelationship.parentSession.id,
    ),
    input: input.input,
  });
}

async function findParentSessionForRelationship(
  tx: DatabaseService['db'],
  input: {
    childSession: Session;
    input: NormalizedRawSessionImportInput;
    parentHarnessSessionId: string;
  },
): Promise<Session | undefined> {
  const [parentSession] = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.workspaceId, input.input.workspaceId),
        eq(sessions.harness, input.input.harness),
        eq(sessions.harnessSessionId, input.parentHarnessSessionId),
        eq(sessions.sourceBindingId, input.childSession.sourceBindingId),
      ),
    )
    .limit(1);
  if (parentSession === undefined || parentSession.id === input.childSession.id) {
    return undefined;
  }
  return parentSession;
}

async function insertOrRefreshChildRelationship(
  tx: DatabaseService['db'],
  input: {
    childSession: Session;
    input: NormalizedRawSessionImportInput;
    parentSession: Session;
    relationshipEvidence: Record<string, unknown>;
  },
): Promise<void> {
  const sourceTurnId =
    (await findRelationshipSourceTurnId(tx, {
      parentSession: input.parentSession,
      relationshipEvidence: input.relationshipEvidence,
    })) ?? null;
  const [existingRelationship] = await tx
    .select()
    .from(sessionRelationships)
    .where(
      and(
        eq(sessionRelationships.workspaceId, input.input.workspaceId),
        eq(sessionRelationships.sourceSessionId, input.parentSession.id),
        eq(sessionRelationships.targetSessionId, input.childSession.id),
        eq(sessionRelationships.relationshipType, 'child'),
      ),
    )
    .limit(1);

  if (existingRelationship === undefined) {
    await tx
      .insert(sessionRelationships)
      .values({
        confidence: 'explicit',
        evidence: input.relationshipEvidence,
        relationshipType: 'child',
        sourceSessionId: input.parentSession.id,
        sourceTurnId,
        targetSessionId: input.childSession.id,
        workspaceId: input.input.workspaceId,
      })
      .onConflictDoNothing({
        target: [
          sessionRelationships.workspaceId,
          sessionRelationships.sourceSessionId,
          sessionRelationships.targetSessionId,
          sessionRelationships.relationshipType,
        ],
      });
    return;
  }

  if (!isImportedChildRelationshipEvidence(existingRelationship.evidence)) {
    return;
  }

  if (
    existingRelationship.sourceTurnId === sourceTurnId &&
    jsonEqual(existingRelationship.evidence, input.relationshipEvidence)
  ) {
    return;
  }

  await tx
    .update(sessionRelationships)
    .set({
      evidence: input.relationshipEvidence,
      sourceTurnId,
      updatedAt: new Date(),
    })
    .where(eq(sessionRelationships.id, existingRelationship.id));
}

async function deleteStaleChildRelationships(
  tx: DatabaseService['db'],
  input: {
    childSession: Session;
    desiredParentSessionIds: string[];
    input: NormalizedRawSessionImportInput;
  },
): Promise<void> {
  const baseConditions = [
    eq(sessionRelationships.workspaceId, input.input.workspaceId),
    eq(sessionRelationships.targetSessionId, input.childSession.id),
    eq(sessionRelationships.relationshipType, 'child'),
    sql`${sessionRelationships.evidence}->>'derivation' = ${SESSION_RELATIONSHIP_IMPORT_DERIVATION}`,
  ];

  await tx
    .delete(sessionRelationships)
    .where(
      and(
        ...baseConditions,
        ...(input.desiredParentSessionIds.length === 0
          ? []
          : [notInArray(sessionRelationships.sourceSessionId, input.desiredParentSessionIds)]),
      ),
    );
}

async function findRelationshipSourceTurnId(
  tx: DatabaseService['db'],
  input: {
    parentSession: Session;
    relationshipEvidence: Record<string, unknown>;
  },
): Promise<string | undefined> {
  const sourceToolUseId = cleanOptional(readString(input.relationshipEvidence.sourceToolUseID));
  const parentTurnId = cleanOptional(readString(input.relationshipEvidence.parentTurnId));
  const harnessTurnIds = [sourceToolUseId, parentTurnId].filter(
    (value): value is string => value !== undefined,
  );
  if (harnessTurnIds.length > 0) {
    const [turn] = await tx
      .select({ id: sessionTurns.id })
      .from(sessionTurns)
      .where(
        and(
          eq(sessionTurns.workspaceId, input.parentSession.workspaceId),
          eq(sessionTurns.sessionId, input.parentSession.id),
          inArray(sessionTurns.harnessTurnId, harnessTurnIds),
        ),
      )
      .limit(1);
    if (turn !== undefined) {
      return turn.id;
    }
  }

  if (parentTurnId === undefined) {
    return undefined;
  }
  const [codexTurn] = await tx
    .select({ id: sessionTurns.id })
    .from(sessionTurns)
    .where(
      and(
        eq(sessionTurns.workspaceId, input.parentSession.workspaceId),
        eq(sessionTurns.sessionId, input.parentSession.id),
        sql`${sessionTurns.metadata}->>'codexTurnId' = ${parentTurnId}`,
      ),
    )
    .limit(1);
  return codexTurn?.id;
}

type RelationshipParentCandidate = {
  evidence: Record<string, unknown>;
  parentHarnessSessionId: string;
};

function relationshipParentCandidates(session: Session): RelationshipParentCandidate[] {
  const metadata = asRecord(session.metadata);
  const parentHarnessSessionId = cleanOptional(readString(metadata.parentHarnessSessionId));
  const subagentEvidence = arrayRecords(metadata.subagentEvidence);
  const parentEvidence =
    subagentEvidence.find(
      (evidence) =>
        readString(evidence.sourceToolUseID) !== undefined ||
        readString(evidence.sourceToolAssistantUUID) !== undefined,
    ) ??
    subagentEvidence.find((evidence) => readString(evidence.agentId) !== undefined) ??
    subagentEvidence[0];
  const candidates: RelationshipParentCandidate[] =
    parentHarnessSessionId === undefined
      ? []
      : [
          {
            evidence: { ...parentEvidence, parentHarnessSessionId },
            parentHarnessSessionId,
          },
        ];

  for (const evidence of subagentEvidence) {
    const codexParentThreadId = cleanOptional(readString(evidence.parent_thread_id));
    if (codexParentThreadId !== undefined && isCodexSubagentEvidence(evidence)) {
      candidates.push({
        evidence,
        parentHarnessSessionId: codexParentThreadId,
      });
    }
  }

  return dedupeRelationshipCandidates(candidates);
}

function relationshipEvidenceForCandidate(
  candidate: RelationshipParentCandidate | undefined,
  childSession: Session,
): Record<string, unknown> {
  const evidence = asRecord(candidate?.evidence);
  const threadSpawn = optionalRecord(evidence.source_subagent_thread_spawn);
  return compactRecord({
    agentId: readString(evidence.agentId),
    agentRole: readString(evidence.agent_role),
    childHarnessSessionId: childSession.harnessSessionId,
    derivation: SESSION_RELATIONSHIP_IMPORT_DERIVATION,
    parentHarnessSessionId: candidate?.parentHarnessSessionId,
    parentThreadId: readString(evidence.parent_thread_id),
    parentTurnId: readString(threadSpawn?.parent_turn_id),
    sourceLocatorKind: readString(evidence.sourceLocatorKind),
    sourceRecordType: readString(evidence.sourceRecordType),
    sourceToolAssistantUUID: readString(evidence.sourceToolAssistantUUID),
    sourceToolUseID: readString(evidence.sourceToolUseID),
    threadSource: readString(evidence.thread_source),
  });
}

function isImportedChildRelationshipEvidence(evidence: unknown): boolean {
  return asRecord(evidence).derivation === SESSION_RELATIONSHIP_IMPORT_DERIVATION;
}

function isCodexSubagentEvidence(evidence: Record<string, unknown>): boolean {
  return (
    readString(evidence.agent_role) === 'subagent' ||
    readString(evidence.thread_source) === 'subagent' ||
    optionalRecord(evidence.source_subagent_thread_spawn) !== undefined
  );
}

function dedupeRelationshipCandidates(
  candidates: readonly RelationshipParentCandidate[],
): RelationshipParentCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.parentHarnessSessionId)) {
      return false;
    }
    seen.add(candidate.parentHarnessSessionId);
    return true;
  });
}

async function refreshSessionAndActivityInterval(
  tx: DatabaseService['db'],
  input: {
    activityInterval: ActivityInterval;
    activityIntervalStartedAt?: Date | undefined;
    input: NormalizedRawSessionImportInput;
    now: Date;
    rawSessionRecordId: string;
    settlement?: ActivityIntervalSettlement | undefined;
    session: Session;
    sessionLastActivityAt?: Date | undefined;
    transcriptNormalization?: TranscriptNormalization | undefined;
  },
): Promise<{ activityInterval: ActivityInterval; session: Session }> {
  const [updatedSession] = await tx
    .update(sessions)
    .set({
      endedAt:
        input.transcriptNormalization?.session.endedAt ??
        (input.settlement?.reason === 'stop_event' ? input.settlement.endedAt : undefined),
      lastActivityAt:
        input.sessionLastActivityAt ??
        input.transcriptNormalization?.session.lastActivityAt ??
        input.input.capturedAt,
      metadata: {
        ...sessionMetadataBaseForRefresh({
          existingMetadata: input.session.metadata,
          transcriptNormalization: input.transcriptNormalization,
        }),
        ...input.transcriptNormalization?.session.metadata,
        latestRawSessionRecordId: input.rawSessionRecordId,
      },
      model:
        input.transcriptNormalization?.session.model ?? input.input.model ?? input.session.model,
      startedAt: input.transcriptNormalization?.session.startedAt ?? input.session.startedAt,
      status:
        input.transcriptNormalization?.session.status ??
        input.input.status ??
        (input.settlement?.reason === 'stop_event' ? 'completed' : input.session.status),
      title:
        input.transcriptNormalization?.session.title ?? input.input.title ?? input.session.title,
      updatedAt: input.now,
    })
    .where(eq(sessions.id, input.session.id))
    .returning();
  if (updatedSession === undefined) {
    throw new RawSessionImportError({ message: 'session update returned no row' });
  }

  const [updatedActivityInterval] = await tx
    .update(activityIntervals)
    .set({
      endedAt: input.settlement?.endedAt ?? input.transcriptNormalization?.activityInterval.endedAt,
      metadata: {
        ...asRecord(input.activityInterval.metadata),
        ...input.transcriptNormalization?.activityInterval.metadata,
        ...input.settlement?.metadata,
      },
      settledAt: input.settlement?.settledAt,
      settlementReason: input.settlement?.reason,
      settlementTriggerRawEventId: input.settlement?.triggerRawEventId,
      startedAt:
        input.activityIntervalStartedAt ??
        input.transcriptNormalization?.activityInterval.startedAt ??
        input.activityInterval.startedAt,
      status:
        input.settlement === undefined
          ? (input.transcriptNormalization?.activityInterval.status ??
            input.activityInterval.status)
          : 'settled',
      updatedAt: input.now,
    })
    .where(eq(activityIntervals.id, input.activityInterval.id))
    .returning();
  if (updatedActivityInterval === undefined) {
    throw new RawSessionImportError({ message: 'activity interval update returned no row' });
  }

  return { activityInterval: updatedActivityInterval, session: updatedSession };
}

function sessionIsCurrentForRefresh(input: {
  input: NormalizedRawSessionImportInput;
  rawSessionRecordId: string;
  session: Session;
  sessionLastActivityAt?: Date | undefined;
  settlement?: ActivityIntervalSettlement | undefined;
  transcriptNormalization?: TranscriptNormalization | undefined;
}): boolean {
  const expectedEndedAt =
    input.transcriptNormalization?.session.endedAt ??
    (input.settlement?.reason === 'stop_event' ? input.settlement.endedAt : input.session.endedAt);
  const expectedMetadata = {
    ...sessionMetadataBaseForRefresh({
      existingMetadata: input.session.metadata,
      transcriptNormalization: input.transcriptNormalization,
    }),
    ...input.transcriptNormalization?.session.metadata,
    latestRawSessionRecordId: input.rawSessionRecordId,
  };

  return (
    nullableDatesEqual(input.session.endedAt, expectedEndedAt) &&
    nullableDatesEqual(
      input.session.lastActivityAt,
      input.sessionLastActivityAt ??
        input.transcriptNormalization?.session.lastActivityAt ??
        input.input.capturedAt,
    ) &&
    jsonEqual(input.session.metadata, expectedMetadata) &&
    input.session.model ===
      (input.transcriptNormalization?.session.model ?? input.input.model ?? input.session.model) &&
    nullableDatesEqual(
      input.session.startedAt,
      input.transcriptNormalization?.session.startedAt ?? input.session.startedAt,
    ) &&
    input.session.status ===
      (input.transcriptNormalization?.session.status ??
        input.input.status ??
        (input.settlement?.reason === 'stop_event' ? 'completed' : input.session.status)) &&
    input.session.title ===
      (input.transcriptNormalization?.session.title ?? input.input.title ?? input.session.title)
  );
}

function activityIntervalIsCurrentForRefresh(input: {
  activityInterval: ActivityInterval;
  activityIntervalStartedAt?: Date | undefined;
  settlement?: ActivityIntervalSettlement | undefined;
  transcriptNormalization?: TranscriptNormalization | undefined;
}): boolean {
  const expectedEndedAt =
    input.settlement?.endedAt ??
    input.transcriptNormalization?.activityInterval.endedAt ??
    input.activityInterval.endedAt;
  const expectedSettledAt = input.settlement?.settledAt ?? input.activityInterval.settledAt;
  const expectedSettlementReason =
    input.settlement?.reason ?? input.activityInterval.settlementReason;
  const expectedSettlementTriggerRawEventId =
    input.settlement?.triggerRawEventId ?? input.activityInterval.settlementTriggerRawEventId;
  const expectedMetadata = {
    ...asRecord(input.activityInterval.metadata),
    ...input.transcriptNormalization?.activityInterval.metadata,
    ...input.settlement?.metadata,
  };

  return (
    nullableDatesEqual(input.activityInterval.endedAt, expectedEndedAt) &&
    jsonEqual(input.activityInterval.metadata, expectedMetadata) &&
    nullableDatesEqual(input.activityInterval.settledAt, expectedSettledAt) &&
    input.activityInterval.settlementReason === expectedSettlementReason &&
    input.activityInterval.settlementTriggerRawEventId === expectedSettlementTriggerRawEventId &&
    input.activityInterval.startedAt.getTime() ===
      (
        input.activityIntervalStartedAt ??
        input.transcriptNormalization?.activityInterval.startedAt ??
        input.activityInterval.startedAt
      ).getTime() &&
    input.activityInterval.status ===
      (input.settlement === undefined
        ? (input.transcriptNormalization?.activityInterval.status ?? input.activityInterval.status)
        : 'settled')
  );
}

function sessionMetadataBaseForRefresh(input: {
  existingMetadata: unknown;
  transcriptNormalization?: TranscriptNormalization | undefined;
}): Record<string, unknown> {
  const metadata = asRecord(input.existingMetadata);
  if (input.transcriptNormalization === undefined) {
    return metadata;
  }

  const refreshedMetadata = { ...metadata };
  delete refreshedMetadata.parentHarnessSessionId;
  delete refreshedMetadata.subagentEvidence;
  return refreshedMetadata;
}

async function rawSessionRecordIsCurrent(
  tx: DatabaseService['db'],
  input: {
    activityIntervalId: string;
    existingRecord: RawSessionRecord;
    input: NormalizedRawSessionImportInput;
    sessionId: string;
    transcriptNormalization?: TranscriptNormalization | undefined;
  },
): Promise<boolean> {
  const rawRecordMetadata = asRecord(input.existingRecord.metadata);
  const rawRecordCurrent =
    (input.input.harnessSessionId === undefined ||
      input.existingRecord.harnessSessionId === input.input.harnessSessionId) &&
    (input.transcriptNormalization === undefined ||
      jsonEqual(rawRecordMetadata.normalization, input.transcriptNormalization.metadata));
  if (!rawRecordCurrent) {
    return false;
  }

  if (input.transcriptNormalization !== undefined) {
    return transcriptDerivedRowsAreCurrent(tx, {
      activityIntervalId: input.activityIntervalId,
      input: input.input,
      rawSessionRecordId: input.existingRecord.id,
      sessionId: input.sessionId,
      transcriptNormalization: input.transcriptNormalization,
    });
  }

  return sessionSegmentsAreCurrent(tx, {
    rawSessionRecordId: input.existingRecord.id,
    sessionId: input.sessionId,
    workspaceId: input.input.workspaceId,
  });
}

async function repairActiveRawSessionRecordDerivedRows(
  tx: DatabaseService['db'],
  input: {
    activityIntervalId: string;
    existingRecord: RawSessionRecord;
    input: NormalizedRawSessionImportInput;
    sessionId: string;
    transcriptNormalization: TranscriptNormalization;
  },
): Promise<RawSessionRecord> {
  const derivedRowsCurrent = await transcriptDerivedRowsAreCurrent(tx, {
    activityIntervalId: input.activityIntervalId,
    input: input.input,
    rawSessionRecordId: input.existingRecord.id,
    sessionId: input.sessionId,
    transcriptNormalization: input.transcriptNormalization,
  });
  const rawRecordMetadata = asRecord(input.existingRecord.metadata);
  const rawRecordCurrent =
    (input.input.harnessSessionId === undefined ||
      input.existingRecord.harnessSessionId === input.input.harnessSessionId) &&
    jsonEqual(rawRecordMetadata.normalization, input.transcriptNormalization.metadata);

  if (derivedRowsCurrent && rawRecordCurrent) {
    return input.existingRecord;
  }

  if (!derivedRowsCurrent) {
    await regenerateDerivedSessionRecords(tx, {
      activityIntervalId: input.activityIntervalId,
      input: input.input,
      rawSessionRecordId: input.existingRecord.id,
      sessionId: input.sessionId,
      transcriptNormalization: input.transcriptNormalization,
    });
  }

  const [rawSessionRecord] = await tx
    .update(rawSessionRecords)
    .set({
      ...(input.input.harnessSessionId !== undefined
        ? { harnessSessionId: input.input.harnessSessionId }
        : {}),
      metadata: {
        ...rawRecordMetadata,
        normalization: input.transcriptNormalization.metadata,
      },
      updatedAt: new Date(),
    })
    .where(eq(rawSessionRecords.id, input.existingRecord.id))
    .returning();
  if (rawSessionRecord === undefined) {
    throw new RawSessionImportError({ message: 'raw session record repair returned no row' });
  }
  return rawSessionRecord;
}

async function transcriptDerivedRowsAreCurrent(
  tx: DatabaseService['db'],
  input: {
    activityIntervalId: string;
    input: NormalizedRawSessionImportInput;
    rawSessionRecordId: string;
    sessionId: string;
    transcriptNormalization: TranscriptNormalization;
  },
): Promise<boolean> {
  const turnRows = await tx
    .select()
    .from(sessionTurns)
    .where(
      and(
        eq(sessionTurns.sessionId, input.sessionId),
        eq(sessionTurns.workspaceId, input.input.workspaceId),
      ),
    )
    .orderBy(sessionTurns.ordinal);
  if (turnRows.length !== input.transcriptNormalization.turns.length) {
    return false;
  }

  const turnsAreCurrent = input.transcriptNormalization.turns.every((normalizedTurn, turnIndex) => {
    const turn = turnRows[turnIndex];
    if (turn === undefined) {
      return false;
    }

    return (
      turn.activityIntervalId === input.activityIntervalId &&
      turn.actorKind === normalizedTurn.actorKind &&
      turn.actorLabel === (normalizedTurn.actorLabel ?? null) &&
      jsonEqual(turn.contentParts, normalizedTurn.contentParts) &&
      datesEqual(turn.endedAt, normalizedTurn.endedAt) &&
      turn.harnessTurnId === (normalizedTurn.harnessTurnId ?? null) &&
      jsonEqual(turn.metadata, normalizedTurn.metadata) &&
      turn.model === (normalizedTurn.model ?? null) &&
      turn.ordinal === turnIndex &&
      turn.parentTurnId === null &&
      jsonEqual(turn.rawEventIds, []) &&
      turn.rawSessionRecordId === input.rawSessionRecordId &&
      jsonEqual(turn.rawSpan, normalizedTurn.rawSpan) &&
      turn.role === normalizedTurn.role &&
      turn.sessionId === input.sessionId &&
      datesEqual(turn.startedAt, normalizedTurn.startedAt) &&
      turn.workspaceId === input.input.workspaceId
    );
  });
  if (!turnsAreCurrent) {
    return false;
  }

  return sessionSegmentsAreCurrent(tx, {
    rawSessionRecordId: input.rawSessionRecordId,
    sessionId: input.sessionId,
    workspaceId: input.input.workspaceId,
  });
}

type NormalizedRawSessionImportInput = {
  capturedAt: Date;
  contentBytes: number;
  contentHash: string;
  sourceLocatorHash: string | undefined;
} & RawSessionImportInput;

type ActivityIntervalSettlement = {
  endedAt: Date;
  metadata?: Record<string, unknown> | undefined;
  reason: ActivityIntervalSettlementReason;
  settledAt: Date;
  triggerRawEventId?: string | undefined;
};

type ActivityIntervalResolution = {
  activityInterval: ActivityInterval;
  settlement?: ActivityIntervalSettlement | undefined;
};

function normalizeTranscript(
  input: NormalizedRawSessionImportInput,
): TranscriptNormalization | undefined {
  if (input.harness === 'codex') {
    return normalizeCodexTranscript({
      contentType: input.contentType,
      fallbackHarnessSessionId: input.harnessSessionId,
      fallbackModel: input.model,
      rawContent: input.rawContent,
    });
  }

  return normalizeClaudeTranscript({
    contentType: input.contentType,
    fallbackHarnessSessionId: input.harnessSessionId,
    fallbackModel: input.model,
    rawContent: input.rawContent,
    sourceLocator: input.locator,
  });
}

function extractTranscriptImportHints(
  input: RawSessionImportInput,
  options: {
    fallbackHarnessSessionId?: string | undefined;
  },
): TranscriptImportHints {
  if (input.harness === 'codex') {
    return extractCodexTranscriptImportHints({
      contentType: input.contentType,
      rawContent: input.rawContent,
    });
  }

  return extractClaudeTranscriptImportHints({
    contentType: input.contentType,
    fallbackHarnessSessionId: options.fallbackHarnessSessionId,
    rawContent: input.rawContent,
    sourceLocator: input.locator,
  });
}

function normalizeLifecycleInput(input: LifecycleBoundaryInput): NormalizedRawSessionImportInput {
  const workspaceId = input.workspaceId.trim();
  if (workspaceId === '') {
    throw new RawSessionImportError({ message: 'workspaceId is required' });
  }
  const hostId = input.host.id.trim();
  if (hostId === '') {
    throw new RawSessionImportError({ message: 'host.id is required' });
  }
  const authorHandle = input.author.handle.trim();
  if (authorHandle === '') {
    throw new RawSessionImportError({ message: 'author.handle is required' });
  }
  const triggerId = input.activity.settlementTriggerRawEventId.trim();
  if (triggerId === '') {
    throw new RawSessionImportError({
      message: 'activity.settlementTriggerRawEventId is required',
    });
  }

  const locator = cleanOptional(input.locator);
  const sourceLocatorHash = locator === undefined ? undefined : sha256(normalizeLocator(locator));
  if (cleanOptional(input.harnessSessionId) === undefined && sourceLocatorHash === undefined) {
    throw new RawSessionImportError({
      message: 'harnessSessionId or locator is required to identify a raw session',
    });
  }

  return {
    activity: { ...input.activity, settlementTriggerRawEventId: triggerId },
    author: { ...input.author, handle: authorHandle },
    capturedAt:
      typeof input.capturedAt === 'string' ? new Date(input.capturedAt) : input.capturedAt,
    contentBytes: 0,
    contentHash: '',
    contentType: 'text',
    harness: input.harness,
    harnessMetadata: input.harnessMetadata,
    harnessSessionId: cleanOptional(input.harnessSessionId),
    host: { ...input.host, id: hostId },
    locator,
    metadata: input.metadata,
    model: input.model,
    provenance: input.provenance,
    rawContent: '',
    sourceBindingId: cleanOptional(input.sourceBindingId),
    sourceLocatorHash,
    status: input.status,
    title: input.title,
    workspaceId,
  };
}

async function findLifecycleNoop(
  tx: DatabaseService['db'],
  input: { input: NormalizedRawSessionImportInput; session: Session },
): Promise<ActivityInterval | undefined> {
  const trigger = input.input.activity?.settlementTriggerRawEventId;
  if (trigger === undefined) {
    return undefined;
  }
  const [interval] = await tx
    .select()
    .from(activityIntervals)
    .where(
      and(
        eq(activityIntervals.sessionId, input.session.id),
        eq(activityIntervals.workspaceId, input.input.workspaceId),
        sql`(
          ${activityIntervals.settlementTriggerRawEventId} = ${trigger}
          or ${activityIntervals.metadata} ->> 'triggerRawEventId' = ${trigger}
        )`,
      ),
    )
    .orderBy(desc(activityIntervals.ordinal))
    .limit(1);
  return interval;
}

async function importLifecycleBoundaryEventInTransactionUnsafe(
  tx: DatabaseService['db'],
  input: NormalizedRawSessionImportInput,
): Promise<LifecycleBoundaryResult> {
  const [workspace] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  if (workspace === undefined) {
    throw new RawSessionImportError({
      message: 'workspace binding is required before lifecycle import',
    });
  }

  const now = new Date();
  const authorUser = await upsertHostAuthor(tx, { input, now });
  const sourceBinding = await resolveRawSessionSourceBinding(tx, { input, now });
  const session = await resolveSession(tx, {
    authorUserId: authorUser.id,
    input,
    sourceBindingId: sourceBinding.id,
  });

  const noopInterval = await findLifecycleNoop(tx, { input, session });
  if (noopInterval !== undefined) {
    return {
      activityInterval: noopInterval,
      authorUser,
      operation: 'unchanged',
      session,
      sourceBinding,
    };
  }

  const triggerRawEventId = input.activity!.settlementTriggerRawEventId;
  const activeInterval = await findActiveActivityInterval(tx, {
    sessionId: session.id,
    workspaceId: input.workspaceId,
  });
  const latestOrdinal = await findLatestActivityIntervalOrdinal(tx, { sessionId: session.id });

  // No active interval → open interval 0 with trigger provenance.
  if (activeInterval === undefined) {
    const opened = await insertActivityInterval(tx, {
      input,
      metadata: { importBoundary: 'lifecycle_event', triggerRawEventId },
      ordinal: latestOrdinal + 1,
      sessionId: session.id,
      startedAt: input.capturedAt,
    });
    const isStop = cleanOptional(input.activity?.hookEventName) === 'Stop';
    if (isStop) {
      await settleActivityInterval(tx, {
        interval: opened,
        now,
        settlement: {
          endedAt: input.capturedAt,
          metadata: { settlementSource: 'hook' },
          reason: 'stop_event',
          settledAt: now,
          triggerRawEventId,
        },
      });
      const settledInterval = await findActivityIntervalById(tx, {
        id: opened.id,
        workspaceId: input.workspaceId,
      });
      const updatedSession = await applyLifecycleSessionUpdate(tx, { input, now, session });
      return {
        activityInterval: settledInterval,
        authorUser,
        operation: 'settled',
        session: updatedSession,
        sourceBinding,
      };
    }
    const updatedSession = await applyLifecycleSessionUpdate(tx, { input, now, session });
    return {
      activityInterval: opened,
      authorUser,
      operation: 'opened',
      session: updatedSession,
      sourceBinding,
    };
  }

  // Active interval present: resolve boundary semantics (Stop, clear/compact, idle, or unchanged).
  const activityResolution = await resolveActivityInterval(tx, {
    input,
    now,
    openedIntervalMetadata: { importBoundary: 'lifecycle_event', triggerRawEventId },
    session,
    transcriptNormalization: undefined,
  });

  if (activityResolution.settlement !== undefined) {
    // Stop: settle the active interval, mark session completed.
    await settleActivityInterval(tx, {
      interval: activityResolution.activityInterval,
      now,
      settlement: activityResolution.settlement,
    });
    const settledInterval = await findActivityIntervalById(tx, {
      id: activityResolution.activityInterval.id,
      workspaceId: input.workspaceId,
    });
    const updatedSession = await applyLifecycleSessionUpdate(tx, { input, now, session });
    return {
      activityInterval: settledInterval,
      authorUser,
      operation: 'settled',
      session: updatedSession,
      sourceBinding,
    };
  }

  // clear/compact/idle → new interval opened; or unchanged-active → same interval.
  const updatedSession = await applyLifecycleSessionUpdate(tx, { input, now, session });
  const operation =
    activityResolution.activityInterval.ordinal > activeInterval.ordinal
      ? 'settled_opened'
      : 'updated';
  return {
    activityInterval: activityResolution.activityInterval,
    authorUser,
    operation,
    session: updatedSession,
    sourceBinding,
  };
}

async function applyLifecycleSessionUpdate(
  tx: DatabaseService['db'],
  input: { input: NormalizedRawSessionImportInput; now: Date; session: Session },
): Promise<Session> {
  const isStop = cleanOptional(input.input.activity?.hookEventName) === 'Stop';
  const [updated] = await tx
    .update(sessions)
    .set({
      endedAt: isStop ? input.input.capturedAt : input.session.endedAt,
      lastActivityAt: input.input.capturedAt,
      status: isStop ? 'completed' : (input.input.status ?? input.session.status),
      updatedAt: input.now,
    })
    .where(eq(sessions.id, input.session.id))
    .returning();
  if (updated === undefined) {
    throw new RawSessionImportError({ message: 'session update returned no row' });
  }
  return updated;
}

function normalizeInput(input: RawSessionImportInput): NormalizedRawSessionImportInput {
  const workspaceId = input.workspaceId.trim();
  if (workspaceId === '') {
    throw new RawSessionImportError({ message: 'workspaceId is required' });
  }

  const hostId = input.host.id.trim();
  if (hostId === '') {
    throw new RawSessionImportError({ message: 'host.id is required' });
  }

  const authorHandle = input.author.handle.trim();
  if (authorHandle === '') {
    throw new RawSessionImportError({ message: 'author.handle is required' });
  }

  const inputHarnessSessionId = cleanOptional(input.harnessSessionId);
  const transcriptHints = extractTranscriptImportHints(input, {
    fallbackHarnessSessionId: inputHarnessSessionId,
  });
  const harnessSessionId =
    transcriptHints?.derivedSidechainHarnessSessionId ??
    inputHarnessSessionId ??
    transcriptHints?.harnessSessionId;
  const locator = cleanOptional(input.locator);
  const sourceLocatorHash = locator === undefined ? undefined : sha256(normalizeLocator(locator));
  if (harnessSessionId === undefined && sourceLocatorHash === undefined) {
    throw new RawSessionImportError({
      message: 'harnessSessionId or locator is required to identify a raw session',
    });
  }

  const capturedAt = parseDate(input.capturedAt ?? new Date(), 'capturedAt');
  return {
    ...input,
    author: {
      ...input.author,
      handle: authorHandle,
    },
    capturedAt,
    contentBytes: Buffer.byteLength(input.rawContent, 'utf8'),
    contentHash: sha256(input.rawContent),
    harnessSessionId,
    host: {
      ...input.host,
      id: hostId,
    },
    locator,
    model: input.model ?? transcriptHints?.model,
    sourceBindingId: cleanOptional(input.sourceBindingId),
    sourceLocatorHash,
    workspaceId,
  };
}

async function findSessionWithoutAdoption(
  tx: DatabaseService['db'],
  input: {
    input: NormalizedRawSessionImportInput;
    sourceBindingId: string;
  },
): Promise<Session | undefined> {
  if (input.input.harnessSessionId !== undefined) {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, input.input.workspaceId),
          eq(sessions.sourceBindingId, input.sourceBindingId),
          eq(sessions.harness, input.input.harness),
          eq(sessions.harnessSessionId, input.input.harnessSessionId),
        ),
      )
      .limit(1);
    if (session !== undefined) {
      return session;
    }
  }

  if (input.input.sourceLocatorHash === undefined) {
    return undefined;
  }
  const [session] = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.workspaceId, input.input.workspaceId),
        eq(sessions.sourceBindingId, input.sourceBindingId),
        eq(sessions.harness, input.input.harness),
        isNull(sessions.harnessSessionId),
        eq(sessions.sourceLocatorHash, input.input.sourceLocatorHash),
      ),
    )
    .limit(1);
  return session;
}

async function findSession(
  tx: DatabaseService['db'],
  input: {
    input: NormalizedRawSessionImportInput;
    sourceBindingId: string;
  },
): Promise<Session | undefined> {
  if (input.input.harnessSessionId !== undefined) {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, input.input.workspaceId),
          eq(sessions.sourceBindingId, input.sourceBindingId),
          eq(sessions.harness, input.input.harness),
          eq(sessions.harnessSessionId, input.input.harnessSessionId),
        ),
      )
      .limit(1);
    if (session !== undefined) {
      return session;
    }
  }

  if (input.input.sourceLocatorHash === undefined) {
    return undefined;
  }
  const [session] = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.workspaceId, input.input.workspaceId),
        eq(sessions.sourceBindingId, input.sourceBindingId),
        eq(sessions.harness, input.input.harness),
        isNull(sessions.harnessSessionId),
        eq(sessions.sourceLocatorHash, input.input.sourceLocatorHash),
      ),
    )
    .limit(1);
  if (session !== undefined && input.input.harnessSessionId !== undefined) {
    const [adoptedSession] = await tx
      .update(sessions)
      .set({
        harnessSessionId: input.input.harnessSessionId,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, session.id))
      .returning();
    if (adoptedSession === undefined) {
      throw new RawSessionImportError({
        message: 'legacy locator session adoption returned no row',
      });
    }
    return adoptedSession;
  }
  return session;
}

async function resolveSession(
  tx: DatabaseService['db'],
  input: {
    authorUserId: string;
    input: NormalizedRawSessionImportInput;
    sourceBindingId: string;
  },
): Promise<Session> {
  const existingSession = await findSession(tx, {
    input: input.input,
    sourceBindingId: input.sourceBindingId,
  });
  return (
    existingSession ??
    (await insertSession(tx, {
      authorUserId: input.authorUserId,
      input: input.input,
      sourceBindingId: input.sourceBindingId,
    }))
  );
}

async function insertSession(
  tx: DatabaseService['db'],
  input: {
    authorUserId: string;
    input: NormalizedRawSessionImportInput;
    sourceBindingId: string;
  },
): Promise<Session> {
  const insert = tx.insert(sessions).values({
    authorUserId: input.authorUserId,
    harness: input.input.harness,
    harnessSessionId: input.input.harnessSessionId,
    lastActivityAt: input.input.capturedAt,
    metadata: input.input.harnessMetadata ?? {},
    model: input.input.model,
    provenance: input.input.provenance,
    sourceBindingId: input.sourceBindingId,
    sourceLocator: input.input.locator,
    sourceLocatorHash: input.input.sourceLocatorHash,
    startedAt: input.input.capturedAt,
    status: input.input.status ?? 'active',
    title: input.input.title,
    workspaceId: input.input.workspaceId,
  });

  const [insertedSession] =
    input.input.harnessSessionId === undefined
      ? await insert
          .onConflictDoNothing({
            target: [
              sessions.workspaceId,
              sessions.sourceBindingId,
              sessions.harness,
              sessions.sourceLocatorHash,
            ],
            where: sql`${sessions.harnessSessionId} is null and ${sessions.sourceLocatorHash} is not null`,
          })
          .returning()
      : await insert
          .onConflictDoNothing({
            target: [
              sessions.workspaceId,
              sessions.sourceBindingId,
              sessions.harness,
              sessions.harnessSessionId,
            ],
            where: sql`${sessions.harnessSessionId} is not null`,
          })
          .returning();
  if (insertedSession !== undefined) {
    return insertedSession;
  }

  const session = await findSession(tx, {
    input: input.input,
    sourceBindingId: input.sourceBindingId,
  });
  if (session === undefined) {
    throw new RawSessionImportError({ message: 'session insert returned no row' });
  }
  return session;
}

async function resolveRawSessionSourceBinding(
  tx: DatabaseService['db'],
  input: {
    input: NormalizedRawSessionImportInput;
    now: Date;
  },
): Promise<SourceBinding> {
  const sourceUri = harnessSourceUri(input.input.harness, input.input.host.id);
  const config = sourceBindingConfig(input.input);
  const displayName = sourceBindingDisplayName(input.input);

  if (input.input.sourceBindingId !== undefined) {
    const [sourceBinding] = await tx
      .update(sourceBindings)
      .set({
        config,
        displayName,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(sourceBindings.workspaceId, input.input.workspaceId),
          eq(sourceBindings.id, input.input.sourceBindingId),
          eq(sourceBindings.sourceType, input.input.harness),
          eq(sourceBindings.sourceUri, sourceUri),
        ),
      )
      .returning();
    if (sourceBinding === undefined) {
      throw new RawSessionImportError({
        message: 'source binding does not match the requested harness and host',
      });
    }
    return sourceBinding;
  }

  const [sourceBinding] = await tx
    .insert(sourceBindings)
    .values({
      config,
      displayName,
      sourceType: input.input.harness,
      sourceUri,
      workspaceId: input.input.workspaceId,
    })
    .onConflictDoUpdate({
      set: {
        config,
        displayName,
        enabled: true,
        updatedAt: input.now,
      },
      target: [sourceBindings.workspaceId, sourceBindings.sourceType, sourceBindings.sourceUri],
    })
    .returning();
  if (sourceBinding === undefined) {
    throw new RawSessionImportError({ message: 'source binding returned no row' });
  }
  return sourceBinding;
}

async function findCurrentRawSessionSourceBinding(
  tx: DatabaseService['db'],
  input: NormalizedRawSessionImportInput,
): Promise<SourceBinding | undefined> {
  const sourceUri = harnessSourceUri(input.harness, input.host.id);
  const config = sourceBindingConfig(input);
  const displayName = sourceBindingDisplayName(input);

  if (input.sourceBindingId !== undefined) {
    const [sourceBinding] = await tx
      .select()
      .from(sourceBindings)
      .where(
        and(
          eq(sourceBindings.workspaceId, input.workspaceId),
          eq(sourceBindings.id, input.sourceBindingId),
          eq(sourceBindings.sourceType, input.harness),
          eq(sourceBindings.sourceUri, sourceUri),
        ),
      )
      .limit(1);
    if (sourceBinding === undefined) {
      return undefined;
    }
    return sourceBinding.displayName === displayName && jsonEqual(sourceBinding.config, config)
      ? sourceBinding
      : undefined;
  }

  const [sourceBinding] = await tx
    .select()
    .from(sourceBindings)
    .where(
      and(
        eq(sourceBindings.workspaceId, input.workspaceId),
        eq(sourceBindings.sourceType, input.harness),
        eq(sourceBindings.sourceUri, sourceUri),
      ),
    )
    .limit(1);
  if (sourceBinding === undefined) {
    return undefined;
  }
  return sourceBinding.enabled &&
    sourceBinding.displayName === displayName &&
    jsonEqual(sourceBinding.config, config)
    ? sourceBinding
    : undefined;
}

async function resolveActivityInterval(
  tx: DatabaseService['db'],
  input: {
    input: NormalizedRawSessionImportInput;
    now: Date;
    openedIntervalMetadata?: Record<string, unknown> | undefined;
    session: Session;
    transcriptNormalization?: TranscriptNormalization | undefined;
  },
): Promise<ActivityIntervalResolution> {
  const observedStart = observedActivityIntervalStart({
    input: input.input,
    transcriptNormalization: input.transcriptNormalization,
  });
  const observedLast =
    input.transcriptNormalization?.session.lastActivityAt ??
    input.transcriptNormalization?.activityInterval.endedAt ??
    input.input.capturedAt;
  const triggerRawEventId = cleanOptional(input.input.activity?.settlementTriggerRawEventId);
  const activeInterval = await findActiveActivityInterval(tx, {
    sessionId: input.session.id,
    workspaceId: input.input.workspaceId,
  });
  const latestOrdinal = await findLatestActivityIntervalOrdinal(tx, {
    sessionId: input.session.id,
  });
  const sessionStartSource = cleanOptional(input.input.activity?.sessionStartSource);
  const hookEventName = cleanOptional(input.input.activity?.hookEventName);
  const shouldOpenAfterClear =
    hookEventName === 'SessionStart' &&
    (sessionStartSource === 'clear' || sessionStartSource === 'compact') &&
    activeInterval !== undefined;
  const idleSettlement =
    activeInterval === undefined || shouldOpenAfterClear
      ? undefined
      : idleTimeoutSettlement({
          lastActivityAt: input.session.lastActivityAt,
          observedStart: input.input.capturedAt,
          triggerRawEventId,
        });

  if (shouldOpenAfterClear) {
    await settleActivityInterval(tx, {
      interval: activeInterval,
      now: input.now,
      settlement: {
        endedAt: observedStart,
        metadata: {
          settlementSource: sessionStartSource,
        },
        reason: 'clear_context',
        settledAt: input.now,
        triggerRawEventId,
      },
    });
    return {
      activityInterval: await insertActivityInterval(tx, {
        input: input.input,
        metadata: input.openedIntervalMetadata,
        ordinal: latestOrdinal + 1,
        sessionId: input.session.id,
        startedAt: observedStart,
      }),
    };
  }

  if (idleSettlement !== undefined && activeInterval !== undefined) {
    await settleActivityInterval(tx, {
      interval: activeInterval,
      now: input.now,
      settlement: idleSettlement,
    });
    return {
      activityInterval: await insertActivityInterval(tx, {
        input: input.input,
        metadata: input.openedIntervalMetadata,
        ordinal: latestOrdinal + 1,
        sessionId: input.session.id,
        startedAt: idleSettlement.settledAt,
      }),
    };
  }

  const activityInterval =
    activeInterval ??
    (await insertActivityInterval(tx, {
      input: input.input,
      ordinal: latestOrdinal + 1,
      sessionId: input.session.id,
      startedAt: observedStart,
    }));

  const stopSettlement =
    hookEventName === 'Stop'
      ? {
          endedAt: observedLast,
          metadata: {
            settlementSource: 'hook',
          },
          reason: 'stop_event' as const,
          settledAt: input.now,
          triggerRawEventId,
        }
      : undefined;

  return {
    activityInterval,
    settlement: stopSettlement,
  };
}

function observedActivityIntervalStart(input: {
  input: NormalizedRawSessionImportInput;
  transcriptNormalization?: TranscriptNormalization | undefined;
}): Date {
  const sessionStartSource = cleanOptional(input.input.activity?.sessionStartSource);
  if (
    cleanOptional(input.input.activity?.hookEventName) === 'SessionStart' &&
    (sessionStartSource === 'clear' || sessionStartSource === 'compact')
  ) {
    return input.input.capturedAt;
  }

  return input.transcriptNormalization?.activityInterval.startedAt ?? input.input.capturedAt;
}

function activityIntervalBoundaryRequiredForExistingRawSessionRecord(input: {
  activityInterval: ActivityInterval;
  input: NormalizedRawSessionImportInput;
  session: Session;
  transcriptNormalization?: TranscriptNormalization | undefined;
}): boolean {
  if (input.activityInterval.status !== 'active') {
    return false;
  }

  const sessionStartSource = cleanOptional(input.input.activity?.sessionStartSource);
  const hookEventName = cleanOptional(input.input.activity?.hookEventName);
  if (
    hookEventName === 'SessionStart' &&
    (sessionStartSource === 'clear' || sessionStartSource === 'compact')
  ) {
    return input.activityInterval.startedAt.getTime() < input.input.capturedAt.getTime();
  }

  return (
    idleTimeoutSettlement({
      lastActivityAt: input.session.lastActivityAt,
      observedStart: input.input.capturedAt,
      triggerRawEventId: cleanOptional(input.input.activity?.settlementTriggerRawEventId),
    }) !== undefined
  );
}

function repeatedActivityIntervalBoundaryAlreadySatisfiedForExistingRawSessionRecord(input: {
  activityInterval: ActivityInterval;
  input: NormalizedRawSessionImportInput;
  session: Session;
}): boolean {
  if (input.activityInterval.status !== 'active') {
    return false;
  }
  if (input.activityInterval.startedAt.getTime() !== input.input.capturedAt.getTime()) {
    return false;
  }

  const sessionStartSource = cleanOptional(input.input.activity?.sessionStartSource);
  const hookEventName = cleanOptional(input.input.activity?.hookEventName);
  if (hookEventName === 'Stop') {
    return false;
  }

  if (
    hookEventName === 'SessionStart' &&
    (sessionStartSource === 'clear' || sessionStartSource === 'compact')
  ) {
    return true;
  }

  return (
    hookEventName === undefined &&
    input.activityInterval.ordinal > 0 &&
    input.session.lastActivityAt?.getTime() === input.input.capturedAt.getTime()
  );
}

async function insertActivityInterval(
  tx: DatabaseService['db'],
  input: {
    input: NormalizedRawSessionImportInput;
    metadata?: Record<string, unknown> | undefined;
    ordinal: number;
    sessionId: string;
    startedAt: Date;
  },
): Promise<ActivityInterval> {
  const [interval] = await tx
    .insert(activityIntervals)
    .values({
      metadata: {
        importBoundary: 'raw_session',
        ...input.metadata,
      },
      ordinal: input.ordinal,
      sessionId: input.sessionId,
      startedAt: input.startedAt,
      status: 'active',
      workspaceId: input.input.workspaceId,
    })
    .onConflictDoNothing({
      target: [activityIntervals.sessionId, activityIntervals.ordinal],
    })
    .returning();
  if (interval !== undefined) {
    return interval;
  }

  const [existingInterval] = await tx
    .select()
    .from(activityIntervals)
    .where(
      and(
        eq(activityIntervals.sessionId, input.sessionId),
        eq(activityIntervals.ordinal, input.ordinal),
      ),
    )
    .limit(1);
  if (existingInterval === undefined) {
    throw new RawSessionImportError({ message: 'activity interval returned no row' });
  }
  return existingInterval;
}

async function findActivityIntervalById(
  tx: DatabaseService['db'],
  input: { id: string; workspaceId: string },
): Promise<ActivityInterval> {
  const [interval] = await tx
    .select()
    .from(activityIntervals)
    .where(
      and(eq(activityIntervals.id, input.id), eq(activityIntervals.workspaceId, input.workspaceId)),
    )
    .limit(1);
  if (interval === undefined) {
    throw new RawSessionImportError({ message: 'raw session activity interval is missing' });
  }
  return interval;
}

async function findActiveActivityInterval(
  tx: DatabaseService['db'],
  input: { sessionId: string; workspaceId: string },
): Promise<ActivityInterval | undefined> {
  const [interval] = await tx
    .select()
    .from(activityIntervals)
    .where(
      and(
        eq(activityIntervals.sessionId, input.sessionId),
        eq(activityIntervals.workspaceId, input.workspaceId),
        eq(activityIntervals.status, 'active'),
      ),
    )
    .orderBy(desc(activityIntervals.ordinal))
    .limit(1);
  return interval;
}

async function findLatestActivityIntervalOrdinal(
  tx: DatabaseService['db'],
  input: { sessionId: string },
): Promise<number> {
  const [interval] = await tx
    .select({ ordinal: activityIntervals.ordinal })
    .from(activityIntervals)
    .where(eq(activityIntervals.sessionId, input.sessionId))
    .orderBy(desc(activityIntervals.ordinal))
    .limit(1);
  return interval?.ordinal ?? -1;
}

async function settleActivityInterval(
  tx: DatabaseService['db'],
  input: {
    interval: ActivityInterval;
    now: Date;
    settlement: ActivityIntervalSettlement;
  },
): Promise<void> {
  const [settled] = await tx
    .update(activityIntervals)
    .set({
      endedAt: input.settlement.endedAt,
      metadata: {
        ...asRecord(input.interval.metadata),
        ...input.settlement.metadata,
      },
      settledAt: input.settlement.settledAt,
      settlementReason: input.settlement.reason,
      settlementTriggerRawEventId: input.settlement.triggerRawEventId,
      status: 'settled',
      updatedAt: input.now,
    })
    .where(
      and(
        eq(activityIntervals.id, input.interval.id),
        eq(activityIntervals.workspaceId, input.interval.workspaceId),
        eq(activityIntervals.status, 'active'),
      ),
    )
    .returning({ id: activityIntervals.id });
  if (settled === undefined) {
    throw new RawSessionImportError({ message: 'active activity interval changed during import' });
  }
}

async function updateActiveRawSessionRecordActivityInterval(
  tx: DatabaseService['db'],
  input: {
    activityIntervalId: string;
    existingRecord: RawSessionRecord;
    now: Date;
  },
): Promise<RawSessionRecord> {
  const [rawSessionRecord] = await tx
    .update(rawSessionRecords)
    .set({
      activityIntervalId: input.activityIntervalId,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(rawSessionRecords.id, input.existingRecord.id),
        eq(rawSessionRecords.workspaceId, input.existingRecord.workspaceId),
        eq(rawSessionRecords.isActive, true),
      ),
    )
    .returning();
  if (rawSessionRecord === undefined) {
    throw new RawSessionImportError({
      message: 'active raw session record changed during import',
    });
  }
  return rawSessionRecord;
}

function idleTimeoutSettlement(input: {
  lastActivityAt: Date | null;
  observedStart: Date;
  triggerRawEventId?: string | undefined;
}): ActivityIntervalSettlement | undefined {
  if (input.lastActivityAt === null) {
    return undefined;
  }
  const idleMs = input.observedStart.getTime() - input.lastActivityAt.getTime();
  if (idleMs <= ACTIVITY_IDLE_TIMEOUT_MS) {
    return undefined;
  }
  const endedAt = new Date(input.lastActivityAt.getTime() + ACTIVITY_IDLE_TIMEOUT_MS);
  return {
    endedAt,
    metadata: {
      idleThresholdMinutes: 30,
    },
    reason: 'idle_timeout',
    settledAt: input.observedStart,
    triggerRawEventId: input.triggerRawEventId,
  };
}

function settlementForExistingRawSessionRecord(input: {
  activityInterval: ActivityInterval;
  input: NormalizedRawSessionImportInput;
  now: Date;
  transcriptNormalization?: TranscriptNormalization | undefined;
}): ActivityIntervalSettlement | undefined {
  if (input.activityInterval.status !== 'active') {
    return undefined;
  }
  if (cleanOptional(input.input.activity?.hookEventName) !== 'Stop') {
    return undefined;
  }
  return {
    endedAt:
      input.transcriptNormalization?.session.lastActivityAt ??
      input.transcriptNormalization?.activityInterval.endedAt ??
      input.input.capturedAt,
    metadata: {
      settlementSource: 'hook',
    },
    reason: 'stop_event',
    settledAt: input.now,
    triggerRawEventId: cleanOptional(input.input.activity?.settlementTriggerRawEventId),
  };
}

async function findRawSessionRecordByContentHash(
  tx: DatabaseService['db'],
  input: { contentHash: string; sessionId: string },
): Promise<RawSessionRecord | undefined> {
  const [record] = await tx
    .select()
    .from(rawSessionRecords)
    .where(
      and(
        eq(rawSessionRecords.sessionId, input.sessionId),
        eq(rawSessionRecords.contentHash, input.contentHash),
      ),
    )
    .limit(1);
  return record;
}

function assertExpectedActiveRawSessionRecord(
  input: NormalizedRawSessionImportInput,
  activeRecord: RawSessionRecord | undefined,
): void {
  const expectedActiveRawSessionRecordId = cleanOptional(
    input.rawRecord?.expectedActiveRawSessionRecordId,
  );
  if (expectedActiveRawSessionRecordId === undefined) {
    return;
  }
  if (activeRecord?.id === expectedActiveRawSessionRecordId) {
    return;
  }
  throw new RawSessionImportError({
    message: 'active raw session record changed during import',
  });
}

async function regenerateDerivedSessionRecords(
  tx: DatabaseService['db'],
  input: {
    activityIntervalId: string;
    input: NormalizedRawSessionImportInput;
    rawSessionRecordId: string;
    sessionId: string;
    transcriptNormalization?: TranscriptNormalization | undefined;
  },
): Promise<void> {
  const rawSessionRecordIds = await tx
    .select({ id: rawSessionRecords.id })
    .from(rawSessionRecords)
    .where(
      and(
        eq(rawSessionRecords.sessionId, input.sessionId),
        eq(rawSessionRecords.workspaceId, input.input.workspaceId),
      ),
    );

  if (rawSessionRecordIds.length > 0) {
    await tx.delete(sessionSegmentEmbeddings).where(
      inArray(
        sessionSegmentEmbeddings.rawSessionRecordId,
        rawSessionRecordIds.map((record) => record.id),
      ),
    );
  }

  await tx
    .delete(sessionSegments)
    .where(
      and(
        eq(sessionSegments.sessionId, input.sessionId),
        eq(sessionSegments.workspaceId, input.input.workspaceId),
      ),
    );
  await tx
    .delete(sessionTurns)
    .where(
      and(
        eq(sessionTurns.sessionId, input.sessionId),
        eq(sessionTurns.workspaceId, input.input.workspaceId),
      ),
    );

  if (input.transcriptNormalization !== undefined) {
    await insertNormalizedTranscriptTurns(tx, {
      activityIntervalId: input.activityIntervalId,
      input: input.input,
      rawSessionRecordId: input.rawSessionRecordId,
      sessionId: input.sessionId,
      turns: input.transcriptNormalization.turns,
    });
    await insertDerivedSessionSegments(tx, {
      rawSessionRecordId: input.rawSessionRecordId,
      sessionId: input.sessionId,
      workspaceId: input.input.workspaceId,
    });
    return;
  }

  const searchText = deriveSearchText(input.input);
  if (searchText === '') {
    return;
  }

  const [turn] = await tx
    .insert(sessionTurns)
    .values({
      activityIntervalId: input.activityIntervalId,
      actorKind: 'harness',
      actorLabel: input.input.harness,
      contentParts: [{ text: searchText, type: 'text' }],
      ordinal: 0,
      rawEventIds: [],
      rawSessionRecordId: input.rawSessionRecordId,
      role: 'system',
      sessionId: input.sessionId,
      workspaceId: input.input.workspaceId,
    })
    .returning();
  if (turn === undefined) {
    throw new RawSessionImportError({ message: 'session turn insert returned no row' });
  }

  await insertDerivedSessionSegments(tx, {
    rawSessionRecordId: input.rawSessionRecordId,
    sessionId: input.sessionId,
    workspaceId: input.input.workspaceId,
  });
}

async function insertNormalizedTranscriptTurns(
  tx: DatabaseService['db'],
  input: {
    activityIntervalId: string;
    input: NormalizedRawSessionImportInput;
    rawSessionRecordId: string;
    sessionId: string;
    turns: readonly NormalizedTranscriptTurn[];
  },
): Promise<void> {
  for (const [turnIndex, normalizedTurn] of input.turns.entries()) {
    const [turn] = await tx
      .insert(sessionTurns)
      .values({
        activityIntervalId: input.activityIntervalId,
        actorKind: normalizedTurn.actorKind,
        actorLabel: normalizedTurn.actorLabel,
        contentParts: normalizedTurn.contentParts,
        endedAt: normalizedTurn.endedAt,
        harnessTurnId: normalizedTurn.harnessTurnId,
        metadata: normalizedTurn.metadata,
        model: normalizedTurn.model,
        ordinal: turnIndex,
        rawEventIds: [],
        rawSessionRecordId: input.rawSessionRecordId,
        rawSpan: normalizedTurn.rawSpan,
        role: normalizedTurn.role,
        sessionId: input.sessionId,
        startedAt: normalizedTurn.startedAt,
        workspaceId: input.input.workspaceId,
      })
      .returning();
    if (turn === undefined) {
      throw new RawSessionImportError({ message: 'session turn insert returned no row' });
    }
  }
}

function buildRawBody(input: NormalizedRawSessionImportInput): {
  bodyJson: JsonBody | undefined;
  bodyText: string | undefined;
} {
  if (input.contentType === 'json') {
    return {
      bodyJson: parseJsonBody(input.rawContent),
      bodyText: input.rawContent,
    };
  }

  if (input.contentType === 'jsonl') {
    return {
      bodyJson: parseJsonlBody(input.rawContent),
      bodyText: input.rawContent,
    };
  }

  return {
    bodyJson: undefined,
    bodyText: input.rawContent,
  };
}

function parseJsonBody(rawContent: string): JsonBody | undefined {
  try {
    return JSON.parse(rawContent) as JsonBody;
  } catch {
    return undefined;
  }
}

function parseJsonlBody(rawContent: string): JsonBody[] | undefined {
  const values: JsonBody[] = [];
  for (const line of rawContent.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const parsed = parseJsonBody(trimmed);
    if (parsed === undefined) {
      return undefined;
    }
    values.push(parsed);
  }
  return values;
}

function deriveSearchText(input: NormalizedRawSessionImportInput): string {
  const normalized = input.rawContent.replaceAll(/\s+/g, ' ').trim();
  if (normalized.length <= 4000) {
    return normalized;
  }
  return normalized.slice(0, 4000);
}

function harnessSourceUri(harness: RawSessionHarness, hostId: string): string {
  return `${harness}://host/${hostId}`;
}

function harnessDisplayName(harness: RawSessionHarness): string {
  return harness === 'claude' ? 'Claude Code' : 'Codex';
}

function sourceBindingConfig(input: NormalizedRawSessionImportInput): Record<string, unknown> {
  return compactRecord({
    hostId: input.host.id,
    hostLabel: input.host.label,
    projectRoot: input.host.projectRoot,
  });
}

function sourceBindingDisplayName(input: NormalizedRawSessionImportInput): string {
  return `${harnessDisplayName(input.harness)} on ${input.host.label ?? input.host.id}`;
}

async function upsertHostAuthor(
  tx: DatabaseService['db'],
  input: { input: NormalizedRawSessionImportInput; now: Date },
): Promise<User> {
  const [authorUser] = await tx
    .insert(users)
    .values({
      displayName: input.input.author.displayName,
      externalSubject: input.input.author.externalSubject ?? input.input.host.id,
      handle: input.input.author.handle,
      identitySource: 'host',
      metadata: {
        hostId: input.input.host.id,
        hostLabel: input.input.host.label,
      },
      workspaceId: input.input.workspaceId,
    })
    .onConflictDoUpdate({
      set: {
        displayName: input.input.author.displayName,
        externalSubject: input.input.author.externalSubject ?? input.input.host.id,
        metadata: {
          hostId: input.input.host.id,
          hostLabel: input.input.host.label,
        },
        updatedAt: input.now,
      },
      target: [users.workspaceId, users.identitySource, users.handle, users.externalSubject],
    })
    .returning();
  if (authorUser === undefined) {
    throw new RawSessionImportError({ message: 'host user attribution returned no row' });
  }
  return authorUser;
}

async function findCurrentHostUser(
  tx: DatabaseService['db'],
  input: NormalizedRawSessionImportInput,
): Promise<User | undefined> {
  const [user] = await tx
    .select()
    .from(users)
    .where(
      and(
        eq(users.workspaceId, input.workspaceId),
        eq(users.identitySource, 'host'),
        eq(users.handle, input.author.handle),
        eq(users.externalSubject, input.author.externalSubject ?? input.host.id),
      ),
    )
    .limit(1);
  if (user === undefined) {
    return undefined;
  }

  const metadata = compactRecord({
    hostId: input.host.id,
    hostLabel: input.host.label,
  });
  return user.displayName === (input.author.displayName ?? null) &&
    jsonEqual(user.metadata, metadata)
    ? user
    : undefined;
}

function normalizeLocator(locator: string): string {
  return locator.trim().replaceAll(/\\/g, '/');
}

function parseDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RawSessionImportError({ message: `${field} must be an ISO timestamp` });
  }
  return date;
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const records: Record<string, unknown>[] = [];
  for (const entry of value) {
    const record = optionalRecord(entry);
    if (record !== undefined) {
      records.push(record);
    }
  }
  return records;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

function datesEqual(actual: Date | null, expected: Date | undefined): boolean {
  if (actual === null || expected === undefined) {
    return actual === null && expected === undefined;
  }
  return actual.getTime() === expected.getTime();
}

function nullableDatesEqual(actual: Date | null, expected: Date | null): boolean {
  if (actual === null || expected === null) {
    return actual === null && expected === null;
  }
  return actual.getTime() === expected.getTime();
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entryValue]) => [key, canonicalJson(entryValue)]),
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isRetryableImportConflict(cause: unknown): boolean {
  if (cause instanceof RawSessionImportError) {
    return cause.message === 'active activity interval changed during import';
  }

  const conflict = asRecord(cause);
  if (conflict.code === '40001' || conflict.code === '40P01') {
    return true;
  }
  if (conflict.code !== '23505') {
    return false;
  }

  return (
    conflict.constraint === 'activity_intervals_session_ordinal_unique' ||
    conflict.constraint === 'raw_session_records_one_active_per_session_idx' ||
    conflict.constraint === 'raw_session_records_session_content_hash_unique' ||
    conflict.constraint === 'raw_session_records_session_snapshot_unique' ||
    conflict.constraint === 'sessions_workspace_harness_locator_unique' ||
    conflict.constraint === 'sessions_workspace_harness_session_unique' ||
    conflict.constraint === 'sessions_workspace_source_harness_locator_unique' ||
    conflict.constraint === 'sessions_workspace_source_harness_session_unique'
  );
}
