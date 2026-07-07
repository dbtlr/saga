import type { RawEventEnvelope } from '@saga/contracts';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { Data, Effect } from 'effect';

import type { DatabaseError, DatabaseService } from './database.js';
import { lifecycleSettlementQueue, rawEvents, sourceBindings } from './schema.js';
import type { RawEvent } from './schema.js';

export class RawEventInsertError extends Data.TaggedError('RawEventInsertError')<{
  readonly message: string;
}> {}

// Match listRecentSessionRecords: a caller-supplied limit is clamped so an
// uncapped or oversized request can never fan a full-table scan (or an unsafe
// int) into the query. This also caps the CLI's `ingest recent` path.
const DEFAULT_RECENT_RAW_EVENT_LIMIT = 10;
const MAX_RECENT_RAW_EVENT_LIMIT = 100;

export function insertRawEvent(
  service: DatabaseService,
  event: RawEventEnvelope,
): Effect.Effect<RawEvent, DatabaseError | RawEventInsertError> {
  return Effect.tryPromise({
    try: async () => {
      await assertSourceBindingInWorkspace(service.db, {
        sourceBindingId: event.sourceBindingId,
        workspaceId: event.workspaceId,
      });
      const { row } = await insertRawEventUnsafe(service.db, event);
      return row;
    },
    catch: (cause) =>
      cause instanceof RawEventInsertError
        ? cause
        : new RawEventInsertError({ message: errorMessage(cause) }),
  });
}

// SGA-238: store a lifecycle-boundary raw event AND enqueue its settlement in ONE
// transaction, so a crash between the two can never strand the boundary (the queue
// is now the only settlement-discovery path). `inserted` is false when the raw
// event already existed (idempotent re-post); the enqueue is idempotent on the
// raw event id, so a re-post never resets a row the job already processed.
export function insertLifecycleBoundaryEvent(
  service: DatabaseService,
  event: RawEventEnvelope,
): Effect.Effect<{ inserted: boolean; rawEvent: RawEvent }, DatabaseError | RawEventInsertError> {
  return Effect.tryPromise({
    try: () =>
      service.db.transaction(async (tx) => {
        const db = tx as DatabaseService['db'];
        await assertSourceBindingInWorkspace(db, {
          sourceBindingId: event.sourceBindingId,
          workspaceId: event.workspaceId,
        });
        const { row, inserted } = await insertRawEventUnsafe(db, event);
        await db
          .insert(lifecycleSettlementQueue)
          .values({ rawEventId: row.id, workspaceId: event.workspaceId })
          .onConflictDoNothing({ target: [lifecycleSettlementQueue.rawEventId] });
        return { inserted, rawEvent: row };
      }),
    catch: (cause) =>
      cause instanceof RawEventInsertError
        ? cause
        : new RawEventInsertError({ message: errorMessage(cause) }),
  });
}

// Insert the raw event idempotently on its 4-column key, returning the row and
// whether it was freshly inserted (vs an existing row on conflict).
async function insertRawEventUnsafe(
  db: DatabaseService['db'],
  event: RawEventEnvelope,
): Promise<{ inserted: boolean; row: RawEvent }> {
  const [row] = await db
    .insert(rawEvents)
    .values({
      actorId: event.actorId,
      eventType: event.eventType,
      externalEventId: event.externalEventId,
      ingestedAt:
        event.ingestedAt === undefined ? undefined : parseDate(event.ingestedAt, 'ingestedAt'),
      occurredAt: parseDate(event.occurredAt, 'occurredAt'),
      payload: event.payload,
      provenance: event.provenance,
      sessionId: event.sessionId,
      sourceBindingId: event.sourceBindingId,
      sourceId: event.sourceId,
      sourceType: event.sourceType,
      traceId: event.traceId,
      trustLevel: event.trustLevel,
      workspaceId: event.workspaceId,
    })
    .onConflictDoNothing({
      target: [
        rawEvents.workspaceId,
        rawEvents.sourceType,
        rawEvents.sourceId,
        rawEvents.externalEventId,
      ],
    })
    .returning();

  if (row !== undefined) {
    return { inserted: true, row };
  }

  const [existing] = await db
    .select()
    .from(rawEvents)
    .where(
      and(
        eq(rawEvents.workspaceId, event.workspaceId),
        eq(rawEvents.sourceType, event.sourceType),
        eq(rawEvents.sourceId, event.sourceId),
        eq(rawEvents.externalEventId, event.externalEventId),
      ),
    )
    .limit(1);

  if (existing === undefined) {
    throw new RawEventInsertError({ message: 'raw event insert returned no row' });
  }

  return { inserted: false, row: existing };
}

// SGA-238: look up a raw event by its idempotency key (the 4-col unique tuple)
// so the ingest handler can report 'stored' vs 'duplicate'. insertRawEvent is
// idempotent regardless; this only informs the per-item ack.
export function findRawEventByEnvelopeKey(
  service: DatabaseService,
  key: { externalEventId: string; sourceId: string; sourceType: string; workspaceId: string },
): Effect.Effect<RawEvent | undefined, RawEventInsertError> {
  return Effect.tryPromise({
    try: async () => {
      const [row] = await service.db
        .select()
        .from(rawEvents)
        .where(
          and(
            eq(rawEvents.workspaceId, key.workspaceId),
            eq(rawEvents.sourceType, key.sourceType),
            eq(rawEvents.sourceId, key.sourceId),
            eq(rawEvents.externalEventId, key.externalEventId),
          ),
        )
        .limit(1);
      return row;
    },
    catch: (cause) => new RawEventInsertError({ message: errorMessage(cause) }),
  });
}

export function listRecentRawEvents(
  service: DatabaseService,
  input: {
    limit?: number | undefined;
    workspaceId: string;
  },
): Effect.Effect<RawEvent[], RawEventInsertError> {
  return Effect.tryPromise({
    try: () =>
      service.db
        .select()
        .from(rawEvents)
        .where(and(eq(rawEvents.workspaceId, input.workspaceId)))
        .orderBy(desc(rawEvents.occurredAt), desc(rawEvents.ingestedAt))
        .limit(Math.min(input.limit ?? DEFAULT_RECENT_RAW_EVENT_LIMIT, MAX_RECENT_RAW_EVENT_LIMIT)),
    catch: (cause) => new RawEventInsertError({ message: errorMessage(cause) }),
  });
}

export function listCodexActivationRawEvents(
  service: DatabaseService,
  input: {
    limit?: number | undefined;
    sourceBindingId: string;
    workspaceId: string;
  },
): Effect.Effect<RawEvent[], RawEventInsertError> {
  return listHarnessActivationRawEvents(service, { ...input, sourceType: 'codex' });
}

export function listHarnessActivationRawEvents(
  service: DatabaseService,
  input: {
    limit?: number | undefined;
    sourceBindingId: string;
    sourceType: 'claude' | 'codex';
    workspaceId: string;
  },
): Effect.Effect<RawEvent[], RawEventInsertError> {
  const activationEventTypes = [
    `${input.sourceType}.SessionStart`,
    `${input.sourceType}.UserPromptSubmit`,
  ];
  return Effect.tryPromise({
    try: () =>
      service.db
        .select()
        .from(rawEvents)
        .where(
          and(
            eq(rawEvents.workspaceId, input.workspaceId),
            eq(rawEvents.sourceBindingId, input.sourceBindingId),
            eq(rawEvents.sourceType, input.sourceType),
            inArray(rawEvents.eventType, activationEventTypes),
          ),
        )
        .orderBy(desc(rawEvents.occurredAt), desc(rawEvents.ingestedAt))
        .limit(input.limit ?? 50),
    catch: (cause) => new RawEventInsertError({ message: errorMessage(cause) }),
  });
}

async function assertSourceBindingInWorkspace(
  db: DatabaseService['db'],
  input: { sourceBindingId: string; workspaceId: string },
): Promise<void> {
  const [sourceBinding] = await db
    .select({ id: sourceBindings.id })
    .from(sourceBindings)
    .where(
      and(
        eq(sourceBindings.id, input.sourceBindingId),
        eq(sourceBindings.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  if (sourceBinding === undefined) {
    throw new RawEventInsertError({
      message: 'raw event source binding must belong to the same workspace',
    });
  }
}

function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RawEventInsertError({ message: `${field} must be an ISO timestamp` });
  }
  return date;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
