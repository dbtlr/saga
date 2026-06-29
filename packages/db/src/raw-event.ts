import type { RawEventEnvelope } from '@saga/contracts';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { Data, Effect } from 'effect';

import type { DatabaseError, DatabaseService } from './database.js';
import { rawEvents, sourceBindings, type RawEvent } from './schema.js';

export class RawEventInsertError extends Data.TaggedError('RawEventInsertError')<{
  readonly message: string;
}> {}

export function insertRawEvent(
  service: DatabaseService,
  event: RawEventEnvelope,
): Effect.Effect<RawEvent, DatabaseError | RawEventInsertError> {
  return Effect.tryPromise({
    try: async () => {
      await assertSourceBindingInWorkspace(service, {
        sourceBindingId: event.sourceBindingId,
        workspaceId: event.workspaceId,
      });

      const [row] = await service.db
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

      if (row !== undefined) return row;

      const [existing] = await service.db
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

      return existing;
    },
    catch: (cause) =>
      cause instanceof RawEventInsertError
        ? cause
        : new RawEventInsertError({ message: errorMessage(cause) }),
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
        .limit(input.limit ?? 10),
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
  service: DatabaseService,
  input: { sourceBindingId: string; workspaceId: string },
): Promise<void> {
  const [sourceBinding] = await service.db
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
