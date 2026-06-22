import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import {
  extractCodexTranscriptImportHints,
  normalizeCodexTranscript,
} from "./codex-transcript-normalizer.js";
import {
  extractClaudeTranscriptImportHints,
  normalizeClaudeTranscript,
} from "./claude-transcript-normalizer.js";
import type { DatabaseError, DatabaseService } from "./database.js";
import { insertDerivedSessionSegments, sessionSegmentsAreCurrent } from "./session-segments.js";
import {
  activityIntervals,
  rawSessionRecords,
  sessionSegmentEmbeddings,
  sessionSegments,
  sessionTurns,
  sessions,
  sourceBindings,
  users,
  workspaces,
  type ActivityInterval,
  type RawSessionRecord,
  type Session,
  type SourceBinding,
  type User,
} from "./schema.js";
import type {
  NormalizedTranscriptTurn,
  TranscriptImportHints,
  TranscriptNormalization,
} from "./transcript-normalizer.js";

export type RawSessionHarness = "claude" | "codex";
export type RawSessionContentType = "json" | "jsonl" | "text";
export type RawSessionImportStatus = "inserted" | "unchanged";
type JsonBody = boolean | null | number | string | JsonBody[] | { [key: string]: JsonBody };
type ActivityIntervalSettlementReason = "clear_context" | "idle_timeout" | "manual" | "stop_event";

const ACTIVITY_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface RawSessionImportInput {
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
  status?: "active" | "completed" | undefined;
  title?: string | undefined;
  workspaceId: string;
}

export interface RawSessionImportActivityInput {
  hookEventName?: string | undefined;
  sessionStartSource?: string | undefined;
  settlementTriggerRawEventId?: string | undefined;
}

export interface RawSessionImportResult {
  activityInterval: ActivityInterval;
  authorUser: User;
  contentHash: string;
  operation: RawSessionImportStatus;
  rawSessionRecord: RawSessionRecord;
  session: Session;
  sourceBinding: SourceBinding;
}

export class RawSessionImportError extends Data.TaggedError("RawSessionImportError")<{
  readonly message: string;
}> {}

export function importRawSessionRecord(
  service: DatabaseService,
  input: RawSessionImportInput,
): Effect.Effect<RawSessionImportResult, DatabaseError | RawSessionImportError> {
  return Effect.tryPromise({
    try: () => importRawSessionRecordUnsafe(service, normalizeInput(input)),
    catch: (cause) =>
      cause instanceof RawSessionImportError
        ? cause
        : new RawSessionImportError({ message: errorMessage(cause) }),
  });
}

async function importRawSessionRecordUnsafe(
  service: DatabaseService,
  input: NormalizedRawSessionImportInput,
): Promise<RawSessionImportResult> {
  return service.db.transaction(async (tx) => {
    const [workspace] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1);

    if (workspace === undefined) {
      throw new RawSessionImportError({
        message: "workspace binding is required before importing raw sessions",
      });
    }

    const now = new Date();
    const [authorUser] = await tx
      .insert(users)
      .values({
        displayName: input.author.displayName,
        externalSubject: input.author.externalSubject ?? input.host.id,
        handle: input.author.handle,
        identitySource: "host",
        metadata: {
          hostId: input.host.id,
          hostLabel: input.host.label,
        },
        workspaceId: input.workspaceId,
      })
      .onConflictDoUpdate({
        set: {
          displayName: input.author.displayName,
          externalSubject: input.author.externalSubject ?? input.host.id,
          metadata: {
            hostId: input.host.id,
            hostLabel: input.host.label,
          },
          updatedAt: now,
        },
        target: [users.workspaceId, users.identitySource, users.handle],
      })
      .returning();
    if (authorUser === undefined) {
      throw new RawSessionImportError({ message: "host user attribution returned no row" });
    }

    const sourceBinding = await resolveRawSessionSourceBinding(tx, { input, now });

    const existingSession = await findSession(tx, input);
    const session =
      existingSession ??
      (await insertSession(tx, {
        authorUserId: authorUser.id,
        input,
        sourceBindingId: sourceBinding.id,
      }));

    const transcriptNormalization = normalizeTranscript(input);

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
      const existingInterval =
        existingRecord.activityIntervalId === null
          ? await resolveActivityInterval(tx, {
              input,
              now,
              session,
              transcriptNormalization,
            }).then((resolution) => resolution.activityInterval)
          : await findActivityIntervalById(tx, {
              id: existingRecord.activityIntervalId,
              workspaceId: input.workspaceId,
            });
      const repairedRecord =
        existingRecord.isActive && transcriptNormalization !== undefined
          ? await repairActiveRawSessionRecordDerivedRows(tx, {
              activityIntervalId: existingInterval.id,
              existingRecord,
              input,
              sessionId: session.id,
              transcriptNormalization,
            })
          : existingRecord;
      const existingSettlement = settlementForExistingRawSessionRecord({
        activityInterval: existingInterval,
        input,
        now,
        transcriptNormalization,
      });
      const refreshed =
        existingRecord.isActive && transcriptNormalization !== undefined
          ? await refreshSessionAndActivityInterval(tx, {
              activityInterval: existingInterval,
              input,
              now,
              rawSessionRecordId: repairedRecord.id,
              settlement: existingSettlement,
              session,
              transcriptNormalization,
            })
          : { activityInterval: existingInterval, session };
      return {
        activityInterval: refreshed.activityInterval,
        authorUser,
        contentHash: input.contentHash,
        operation: "unchanged",
        rawSessionRecord: repairedRecord,
        session: refreshed.session,
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
        throw new RawSessionImportError({
          message: "active raw session record changed during import",
        });
      }
    }

    const rawBody = buildRawBody(input);
    const [rawSessionRecord] = await tx
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
        status: input.rawRecord?.status ?? "captured",
        workspaceId: input.workspaceId,
      })
      .returning();
    if (rawSessionRecord === undefined) {
      throw new RawSessionImportError({ message: "raw session record insert returned no row" });
    }

    const updated = await refreshSessionAndActivityInterval(tx, {
      activityInterval,
      input,
      now,
      rawSessionRecordId: rawSessionRecord.id,
      settlement: activityResolution.settlement,
      session,
      transcriptNormalization,
    });

    await regenerateDerivedSessionRecords(tx, {
      activityIntervalId: activityInterval.id,
      input,
      transcriptNormalization,
      rawSessionRecordId: rawSessionRecord.id,
      sessionId: session.id,
    });

    return {
      activityInterval: updated.activityInterval,
      authorUser,
      contentHash: input.contentHash,
      operation: "inserted",
      rawSessionRecord,
      session: updated.session,
      sourceBinding,
    };
  });
}

async function refreshSessionAndActivityInterval(
  tx: DatabaseService["db"],
  input: {
    activityInterval: ActivityInterval;
    input: NormalizedRawSessionImportInput;
    now: Date;
    rawSessionRecordId: string;
    settlement?: ActivityIntervalSettlement | undefined;
    session: Session;
    transcriptNormalization?: TranscriptNormalization | undefined;
  },
): Promise<{ activityInterval: ActivityInterval; session: Session }> {
  const [updatedSession] = await tx
    .update(sessions)
    .set({
      endedAt:
        input.transcriptNormalization?.session.endedAt ??
        (input.settlement?.reason === "stop_event" ? input.settlement.endedAt : undefined),
      lastActivityAt:
        input.transcriptNormalization?.session.lastActivityAt ?? input.input.capturedAt,
      metadata: {
        ...asRecord(input.session.metadata),
        ...input.transcriptNormalization?.session.metadata,
        latestRawSessionRecordId: input.rawSessionRecordId,
      },
      model:
        input.transcriptNormalization?.session.model ?? input.input.model ?? input.session.model,
      startedAt: input.transcriptNormalization?.session.startedAt ?? input.session.startedAt,
      status:
        input.transcriptNormalization?.session.status ??
        input.input.status ??
        (input.settlement?.reason === "stop_event" ? "completed" : input.session.status),
      title:
        input.transcriptNormalization?.session.title ?? input.input.title ?? input.session.title,
      updatedAt: input.now,
    })
    .where(eq(sessions.id, input.session.id))
    .returning();
  if (updatedSession === undefined) {
    throw new RawSessionImportError({ message: "session update returned no row" });
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
        input.transcriptNormalization?.activityInterval.startedAt ??
        input.activityInterval.startedAt,
      status:
        input.settlement === undefined
          ? (input.transcriptNormalization?.activityInterval.status ??
            input.activityInterval.status)
          : "settled",
      updatedAt: input.now,
    })
    .where(eq(activityIntervals.id, input.activityInterval.id))
    .returning();
  if (updatedActivityInterval === undefined) {
    throw new RawSessionImportError({ message: "activity interval update returned no row" });
  }

  return { activityInterval: updatedActivityInterval, session: updatedSession };
}

async function repairActiveRawSessionRecordDerivedRows(
  tx: DatabaseService["db"],
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

  if (derivedRowsCurrent && rawRecordCurrent) return input.existingRecord;

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
    throw new RawSessionImportError({ message: "raw session record repair returned no row" });
  }
  return rawSessionRecord;
}

async function transcriptDerivedRowsAreCurrent(
  tx: DatabaseService["db"],
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
  if (turnRows.length !== input.transcriptNormalization.turns.length) return false;

  const turnsAreCurrent = input.transcriptNormalization.turns.every((normalizedTurn, turnIndex) => {
    const turn = turnRows[turnIndex];
    if (turn === undefined) return false;

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
  if (!turnsAreCurrent) return false;

  return sessionSegmentsAreCurrent(tx, {
    rawSessionRecordId: input.rawSessionRecordId,
    sessionId: input.sessionId,
    workspaceId: input.input.workspaceId,
  });
}

interface NormalizedRawSessionImportInput extends RawSessionImportInput {
  capturedAt: Date;
  contentBytes: number;
  contentHash: string;
  sourceLocatorHash: string | undefined;
}

interface ActivityIntervalSettlement {
  endedAt: Date;
  metadata?: Record<string, unknown> | undefined;
  reason: ActivityIntervalSettlementReason;
  settledAt: Date;
  triggerRawEventId?: string | undefined;
}

interface ActivityIntervalResolution {
  activityInterval: ActivityInterval;
  settlement?: ActivityIntervalSettlement | undefined;
}

function normalizeTranscript(
  input: NormalizedRawSessionImportInput,
): TranscriptNormalization | undefined {
  if (input.harness === "codex") {
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
  if (input.harness === "codex") {
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

function normalizeInput(input: RawSessionImportInput): NormalizedRawSessionImportInput {
  const workspaceId = input.workspaceId.trim();
  if (workspaceId === "") {
    throw new RawSessionImportError({ message: "workspaceId is required" });
  }

  const hostId = input.host.id.trim();
  if (hostId === "") {
    throw new RawSessionImportError({ message: "host.id is required" });
  }

  const authorHandle = input.author.handle.trim();
  if (authorHandle === "") {
    throw new RawSessionImportError({ message: "author.handle is required" });
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
      message: "harnessSessionId or locator is required to identify a raw session",
    });
  }

  const capturedAt = parseDate(input.capturedAt ?? new Date(), "capturedAt");
  return {
    ...input,
    author: {
      ...input.author,
      handle: authorHandle,
    },
    capturedAt,
    contentBytes: Buffer.byteLength(input.rawContent, "utf8"),
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

async function findSession(
  tx: DatabaseService["db"],
  input: NormalizedRawSessionImportInput,
): Promise<Session | undefined> {
  if (input.harnessSessionId !== undefined) {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, input.workspaceId),
          eq(sessions.harness, input.harness),
          eq(sessions.harnessSessionId, input.harnessSessionId),
        ),
      )
      .limit(1);
    if (session !== undefined) return session;
  }

  if (input.sourceLocatorHash === undefined) return undefined;
  const [session] = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.workspaceId, input.workspaceId),
        eq(sessions.harness, input.harness),
        isNull(sessions.harnessSessionId),
        eq(sessions.sourceLocatorHash, input.sourceLocatorHash),
      ),
    )
    .limit(1);
  if (session !== undefined && input.harnessSessionId !== undefined) {
    const [adoptedSession] = await tx
      .update(sessions)
      .set({
        harnessSessionId: input.harnessSessionId,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, session.id))
      .returning();
    if (adoptedSession === undefined) {
      throw new RawSessionImportError({
        message: "legacy locator session adoption returned no row",
      });
    }
    return adoptedSession;
  }
  return session;
}

async function insertSession(
  tx: DatabaseService["db"],
  input: {
    authorUserId: string;
    input: NormalizedRawSessionImportInput;
    sourceBindingId: string;
  },
): Promise<Session> {
  const [session] = await tx
    .insert(sessions)
    .values({
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
      status: input.input.status ?? "active",
      title: input.input.title,
      workspaceId: input.input.workspaceId,
    })
    .returning();
  if (session === undefined) {
    throw new RawSessionImportError({ message: "session insert returned no row" });
  }
  return session;
}

async function resolveRawSessionSourceBinding(
  tx: DatabaseService["db"],
  input: {
    input: NormalizedRawSessionImportInput;
    now: Date;
  },
): Promise<SourceBinding> {
  const sourceUri = harnessSourceUri(input.input.harness, input.input.host.id);
  const config = {
    hostId: input.input.host.id,
    hostLabel: input.input.host.label,
    projectRoot: input.input.host.projectRoot,
  };
  const displayName = `${harnessDisplayName(input.input.harness)} on ${
    input.input.host.label ?? input.input.host.id
  }`;

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
        message: "source binding does not match the requested harness and host",
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
    throw new RawSessionImportError({ message: "source binding returned no row" });
  }
  return sourceBinding;
}

async function resolveActivityInterval(
  tx: DatabaseService["db"],
  input: {
    input: NormalizedRawSessionImportInput;
    now: Date;
    session: Session;
    transcriptNormalization?: TranscriptNormalization | undefined;
  },
): Promise<ActivityIntervalResolution> {
  const observedStart =
    input.transcriptNormalization?.activityInterval.startedAt ?? input.input.capturedAt;
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
    hookEventName === "SessionStart" &&
    (sessionStartSource === "clear" || sessionStartSource === "compact") &&
    activeInterval !== undefined;
  const idleSettlement =
    activeInterval === undefined || shouldOpenAfterClear
      ? undefined
      : idleTimeoutSettlement({
          lastActivityAt: input.session.lastActivityAt,
          observedStart,
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
        reason: "clear_context",
        settledAt: input.now,
        triggerRawEventId,
      },
    });
    return {
      activityInterval: await insertActivityInterval(tx, {
        input: input.input,
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
        ordinal: latestOrdinal + 1,
        sessionId: input.session.id,
        startedAt: observedStart,
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
    hookEventName === "Stop"
      ? {
          endedAt: observedLast,
          metadata: {
            settlementSource: "hook",
          },
          reason: "stop_event" as const,
          settledAt: input.now,
          triggerRawEventId,
        }
      : undefined;

  return {
    activityInterval,
    settlement: stopSettlement,
  };
}

async function insertActivityInterval(
  tx: DatabaseService["db"],
  input: {
    input: NormalizedRawSessionImportInput;
    ordinal: number;
    sessionId: string;
    startedAt: Date;
  },
): Promise<ActivityInterval> {
  const [interval] = await tx
    .insert(activityIntervals)
    .values({
      metadata: {
        importBoundary: "raw_session",
      },
      ordinal: input.ordinal,
      sessionId: input.sessionId,
      startedAt: input.startedAt,
      status: "active",
      workspaceId: input.input.workspaceId,
    })
    .returning();
  if (interval === undefined) {
    throw new RawSessionImportError({ message: "activity interval returned no row" });
  }
  return interval;
}

async function findActivityIntervalById(
  tx: DatabaseService["db"],
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
    throw new RawSessionImportError({ message: "raw session activity interval is missing" });
  }
  return interval;
}

async function findActiveActivityInterval(
  tx: DatabaseService["db"],
  input: { sessionId: string; workspaceId: string },
): Promise<ActivityInterval | undefined> {
  const [interval] = await tx
    .select()
    .from(activityIntervals)
    .where(
      and(
        eq(activityIntervals.sessionId, input.sessionId),
        eq(activityIntervals.workspaceId, input.workspaceId),
        eq(activityIntervals.status, "active"),
      ),
    )
    .orderBy(desc(activityIntervals.ordinal))
    .limit(1);
  return interval;
}

async function findLatestActivityIntervalOrdinal(
  tx: DatabaseService["db"],
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
  tx: DatabaseService["db"],
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
      status: "settled",
      updatedAt: input.now,
    })
    .where(
      and(
        eq(activityIntervals.id, input.interval.id),
        eq(activityIntervals.workspaceId, input.interval.workspaceId),
        eq(activityIntervals.status, "active"),
      ),
    )
    .returning({ id: activityIntervals.id });
  if (settled === undefined) {
    throw new RawSessionImportError({ message: "active activity interval changed during import" });
  }
}

function idleTimeoutSettlement(input: {
  lastActivityAt: Date | null;
  observedStart: Date;
  triggerRawEventId?: string | undefined;
}): ActivityIntervalSettlement | undefined {
  if (input.lastActivityAt === null) return undefined;
  const idleMs = input.observedStart.getTime() - input.lastActivityAt.getTime();
  if (idleMs <= ACTIVITY_IDLE_TIMEOUT_MS) return undefined;
  const endedAt = new Date(input.lastActivityAt.getTime() + ACTIVITY_IDLE_TIMEOUT_MS);
  return {
    endedAt,
    metadata: {
      idleThresholdMinutes: 30,
    },
    reason: "idle_timeout",
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
  if (input.activityInterval.status !== "active") return undefined;
  if (cleanOptional(input.input.activity?.hookEventName) !== "Stop") return undefined;
  return {
    endedAt:
      input.transcriptNormalization?.session.lastActivityAt ??
      input.transcriptNormalization?.activityInterval.endedAt ??
      input.input.capturedAt,
    metadata: {
      settlementSource: "hook",
    },
    reason: "stop_event",
    settledAt: input.now,
    triggerRawEventId: cleanOptional(input.input.activity?.settlementTriggerRawEventId),
  };
}

async function findRawSessionRecordByContentHash(
  tx: DatabaseService["db"],
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
  if (expectedActiveRawSessionRecordId === undefined) return;
  if (activeRecord?.id === expectedActiveRawSessionRecordId) return;
  throw new RawSessionImportError({
    message: "active raw session record changed during import",
  });
}

async function regenerateDerivedSessionRecords(
  tx: DatabaseService["db"],
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
  if (searchText === "") return;

  const [turn] = await tx
    .insert(sessionTurns)
    .values({
      activityIntervalId: input.activityIntervalId,
      actorKind: "harness",
      actorLabel: input.input.harness,
      contentParts: [{ text: searchText, type: "text" }],
      ordinal: 0,
      rawEventIds: [],
      rawSessionRecordId: input.rawSessionRecordId,
      role: "system",
      sessionId: input.sessionId,
      workspaceId: input.input.workspaceId,
    })
    .returning();
  if (turn === undefined) {
    throw new RawSessionImportError({ message: "session turn insert returned no row" });
  }

  await insertDerivedSessionSegments(tx, {
    rawSessionRecordId: input.rawSessionRecordId,
    sessionId: input.sessionId,
    workspaceId: input.input.workspaceId,
  });
}

async function insertNormalizedTranscriptTurns(
  tx: DatabaseService["db"],
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
      throw new RawSessionImportError({ message: "session turn insert returned no row" });
    }
  }
}

function buildRawBody(input: NormalizedRawSessionImportInput): {
  bodyJson: JsonBody | undefined;
  bodyText: string | undefined;
} {
  if (input.contentType === "json") {
    return {
      bodyJson: parseJsonBody(input.rawContent),
      bodyText: input.rawContent,
    };
  }

  if (input.contentType === "jsonl") {
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
    if (trimmed === "") continue;
    const parsed = parseJsonBody(trimmed);
    if (parsed === undefined) return undefined;
    values.push(parsed);
  }
  return values;
}

function deriveSearchText(input: NormalizedRawSessionImportInput): string {
  const normalized = input.rawContent.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= 4000) return normalized;
  return normalized.slice(0, 4000);
}

function harnessSourceUri(harness: RawSessionHarness, hostId: string): string {
  return `${harness}://host/${hostId}`;
}

function harnessDisplayName(harness: RawSessionHarness): string {
  return harness === "claude" ? "Claude Code" : "Codex";
}

function normalizeLocator(locator: string): string {
  return locator.trim().replaceAll(/\\/g, "/");
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
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function datesEqual(actual: Date | null, expected: Date | undefined): boolean {
  if (actual === null || expected === undefined) return actual === null && expected === undefined;
  return actual.getTime() === expected.getTime();
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entryValue]) => [key, canonicalJson(entryValue)]),
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
