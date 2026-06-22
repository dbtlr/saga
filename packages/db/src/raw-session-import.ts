import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import type { DatabaseError, DatabaseService } from "./database.js";
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

export type RawSessionHarness = "claude" | "codex";
export type RawSessionContentType = "json" | "jsonl" | "text";
export type RawSessionImportStatus = "inserted" | "unchanged";
type JsonBody = boolean | null | number | string | JsonBody[] | { [key: string]: JsonBody };

export interface RawSessionImportInput {
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
  rawContent: string;
  status?: "active" | "completed" | undefined;
  title?: string | undefined;
  workspaceId: string;
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

    const sourceUri = harnessSourceUri(input.harness, input.host.id);
    const [sourceBinding] = await tx
      .insert(sourceBindings)
      .values({
        config: {
          hostId: input.host.id,
          hostLabel: input.host.label,
          projectRoot: input.host.projectRoot,
        },
        displayName: `${harnessDisplayName(input.harness)} on ${input.host.label ?? input.host.id}`,
        sourceType: input.harness,
        sourceUri,
        workspaceId: input.workspaceId,
      })
      .onConflictDoUpdate({
        set: {
          config: {
            hostId: input.host.id,
            hostLabel: input.host.label,
            projectRoot: input.host.projectRoot,
          },
          displayName: `${harnessDisplayName(input.harness)} on ${input.host.label ?? input.host.id}`,
          enabled: true,
          updatedAt: now,
        },
        target: [sourceBindings.workspaceId, sourceBindings.sourceType, sourceBindings.sourceUri],
      })
      .returning();
    if (sourceBinding === undefined) {
      throw new RawSessionImportError({ message: "source binding returned no row" });
    }

    const existingSession = await findSession(tx, input);
    const session =
      existingSession ??
      (await insertSession(tx, {
        authorUserId: authorUser.id,
        input,
        sourceBindingId: sourceBinding.id,
      }));

    const activityInterval = await ensureActivityInterval(tx, {
      input,
      sessionId: session.id,
    });

    const existingRecord = await findRawSessionRecordByContentHash(tx, {
      contentHash: input.contentHash,
      sessionId: session.id,
    });
    if (existingRecord !== undefined) {
      return {
        activityInterval,
        authorUser,
        contentHash: input.contentHash,
        operation: "unchanged",
        rawSessionRecord: existingRecord,
        session,
        sourceBinding,
      };
    }

    const [activeRecord] = await tx
      .select()
      .from(rawSessionRecords)
      .where(and(eq(rawSessionRecords.sessionId, session.id), eq(rawSessionRecords.isActive, true)))
      .limit(1);

    const [maxSnapshot] = await tx
      .select({ snapshotOrdinal: rawSessionRecords.snapshotOrdinal })
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, session.id))
      .orderBy(desc(rawSessionRecords.snapshotOrdinal))
      .limit(1);

    const nextSnapshotOrdinal = (maxSnapshot?.snapshotOrdinal ?? -1) + 1;
    if (activeRecord !== undefined) {
      await tx
        .update(rawSessionRecords)
        .set({ isActive: false, updatedAt: now })
        .where(eq(rawSessionRecords.id, activeRecord.id));
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
          sourceLocatorHash: input.sourceLocatorHash,
        },
        provenance: input.provenance,
        sessionId: session.id,
        snapshotOrdinal: nextSnapshotOrdinal,
        sourceBindingId: sourceBinding.id,
        sourceLocator: input.locator,
        workspaceId: input.workspaceId,
      })
      .returning();
    if (rawSessionRecord === undefined) {
      throw new RawSessionImportError({ message: "raw session record insert returned no row" });
    }

    await tx
      .update(sessions)
      .set({
        lastActivityAt: input.capturedAt,
        metadata: {
          ...asRecord(session.metadata),
          latestRawSessionRecordId: rawSessionRecord.id,
        },
        model: input.model ?? session.model,
        status: input.status ?? session.status,
        title: input.title ?? session.title,
        updatedAt: now,
      })
      .where(eq(sessions.id, session.id));

    await regenerateDerivedSessionRecords(tx, {
      activityIntervalId: activityInterval.id,
      input,
      rawSessionRecordId: rawSessionRecord.id,
      sessionId: session.id,
    });

    return {
      activityInterval,
      authorUser,
      contentHash: input.contentHash,
      operation: "inserted",
      rawSessionRecord,
      session,
      sourceBinding,
    };
  });
}

interface NormalizedRawSessionImportInput extends RawSessionImportInput {
  capturedAt: Date;
  contentBytes: number;
  contentHash: string;
  sourceLocatorHash: string | undefined;
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

  const harnessSessionId = cleanOptional(input.harnessSessionId);
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
    return session;
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

async function ensureActivityInterval(
  tx: DatabaseService["db"],
  input: {
    input: NormalizedRawSessionImportInput;
    sessionId: string;
  },
): Promise<ActivityInterval> {
  const [interval] = await tx
    .insert(activityIntervals)
    .values({
      metadata: {
        importBoundary: "raw_session",
      },
      ordinal: 0,
      sessionId: input.sessionId,
      startedAt: input.input.capturedAt,
      status: "active",
      workspaceId: input.input.workspaceId,
    })
    .onConflictDoUpdate({
      set: {
        updatedAt: new Date(),
      },
      target: [activityIntervals.sessionId, activityIntervals.ordinal],
    })
    .returning();
  if (interval === undefined) {
    throw new RawSessionImportError({ message: "activity interval returned no row" });
  }
  return interval;
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

async function regenerateDerivedSessionRecords(
  tx: DatabaseService["db"],
  input: {
    activityIntervalId: string;
    input: NormalizedRawSessionImportInput;
    rawSessionRecordId: string;
    sessionId: string;
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

  const [segment] = await tx
    .insert(sessionSegments)
    .values({
      activityIntervalId: input.activityIntervalId,
      metadata: {
        normalizer: "raw-session-import-stub",
      },
      ordinal: 0,
      rawSessionRecordId: input.rawSessionRecordId,
      searchText,
      sessionId: input.sessionId,
      snippet: searchText.slice(0, 240),
      turnId: turn.id,
      workspaceId: input.input.workspaceId,
    })
    .returning();
  if (segment === undefined) {
    throw new RawSessionImportError({ message: "session segment insert returned no row" });
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
