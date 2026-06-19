import type { RawEventEnvelope } from "@saga/contracts";
import { Data, Effect } from "effect";
import type { DatabaseError, DatabaseService } from "./database.js";
import { rawEvents, type RawEvent } from "./schema.js";

export class RawEventInsertError extends Data.TaggedError("RawEventInsertError")<{
  readonly message: string;
}> {}

export function insertRawEvent(
  service: DatabaseService,
  event: RawEventEnvelope,
): Effect.Effect<RawEvent, DatabaseError | RawEventInsertError> {
  return Effect.tryPromise({
    try: async () => {
      const [row] = await service.db
        .insert(rawEvents)
        .values({
          actorId: event.actorId,
          eventType: event.eventType,
          ingestedAt:
            event.ingestedAt === undefined ? undefined : parseDate(event.ingestedAt, "ingestedAt"),
          occurredAt: parseDate(event.occurredAt, "occurredAt"),
          payload: event.payload,
          provenance: event.provenance,
          sessionId: event.sessionId,
          sourceBindingId: event.sourceId,
          sourceId: event.sourceId,
          sourceType: event.sourceType,
          traceId: event.traceId,
          trustLevel: event.trustLevel,
          workspaceId: event.workspaceId,
        })
        .returning();

      if (row === undefined) {
        throw new RawEventInsertError({ message: "raw event insert returned no row" });
      }

      return row;
    },
    catch: (cause) =>
      cause instanceof RawEventInsertError
        ? cause
        : new RawEventInsertError({ message: errorMessage(cause) }),
  });
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
