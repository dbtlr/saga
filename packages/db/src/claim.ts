import {
  candidateClaimKey,
  type CandidateClaim,
  type ClaimKind,
  type ClaimEvidence,
} from "@saga/claims";
import { and, desc, eq } from "drizzle-orm";
import { Data, Effect } from "effect";
import type { DatabaseError, DatabaseService } from "./database.js";
import { claimEvents, currentClaims, type ClaimEvent, type CurrentClaim } from "./schema.js";

export type ClaimEventType = "contradicted" | "extracted" | "rejected" | "supported";
export type ClaimState = "candidate" | "contradicted" | "rejected" | "supported";

export interface InsertClaimEventInput {
  attributes: Record<string, unknown>;
  claimKey: string;
  confidence: number;
  evidence: ClaimEvidence;
  eventType: ClaimEventType;
  kind: ClaimKind;
  text: string;
  workspaceId: string;
}

export interface ClaimProjectionResult {
  currentClaim: CurrentClaim;
  event: ClaimEvent;
}

export class ClaimProjectionError extends Data.TaggedError("ClaimProjectionError")<{
  readonly message: string;
}> {}

export function insertExtractedCandidateClaim(
  service: DatabaseService,
  candidate: CandidateClaim,
): Effect.Effect<ClaimProjectionResult, ClaimProjectionError | DatabaseError> {
  return insertClaimEventAndProject(service, {
    attributes: candidate.attributes,
    claimKey: candidateClaimKey(candidate),
    confidence: candidate.confidence,
    evidence: candidate.evidence,
    eventType: "extracted",
    kind: candidate.kind,
    text: candidate.text,
    workspaceId: candidate.workspaceId,
  });
}

export function insertExtractedCandidateClaims(
  service: DatabaseService,
  candidates: readonly CandidateClaim[],
): Effect.Effect<ClaimProjectionResult[], ClaimProjectionError | DatabaseError> {
  return Effect.forEach(candidates, (candidate) =>
    insertExtractedCandidateClaim(service, candidate),
  );
}

export function insertClaimEventAndProject(
  service: DatabaseService,
  input: InsertClaimEventInput,
): Effect.Effect<ClaimProjectionResult, ClaimProjectionError | DatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      const observedAt = new Date(input.evidence.occurredAt);
      if (Number.isNaN(observedAt.getTime())) {
        throw new ClaimProjectionError({
          message: "claim evidence occurredAt must be an ISO timestamp",
        });
      }

      const [insertedEvent] = await service.db
        .insert(claimEvents)
        .values({
          attributes: input.attributes,
          claimKey: input.claimKey,
          claimKind: input.kind,
          claimText: input.text,
          confidence: input.confidence,
          eventType: input.eventType,
          evidence: input.evidence as unknown as Record<string, unknown>,
          occurredAt: observedAt,
          rawEventId: input.evidence.rawEventId,
          workspaceId: input.workspaceId,
        })
        .onConflictDoNothing({
          target: [
            claimEvents.workspaceId,
            claimEvents.eventType,
            claimEvents.claimKey,
            claimEvents.rawEventId,
          ],
        })
        .returning();

      const event = insertedEvent ?? (await findExistingClaimEvent(service, input));
      const state = stateForEventType(input.eventType);
      const [existingCurrentClaim] = await service.db
        .select()
        .from(currentClaims)
        .where(
          and(
            eq(currentClaims.workspaceId, input.workspaceId),
            eq(currentClaims.claimKey, input.claimKey),
          ),
        )
        .limit(1);

      if (
        existingCurrentClaim !== undefined &&
        !shouldProjectClaimEvent(existingCurrentClaim, state, observedAt)
      ) {
        return { currentClaim: existingCurrentClaim, event };
      }

      const [currentClaim] = await service.db
        .insert(currentClaims)
        .values({
          attributes: input.attributes,
          claimKey: input.claimKey,
          claimKind: input.kind,
          claimText: input.text,
          confidence: input.confidence,
          evidence: input.evidence as unknown as Record<string, unknown>,
          latestEventId: event.id,
          observedAt,
          state,
          workspaceId: input.workspaceId,
        })
        .onConflictDoUpdate({
          set: {
            attributes: input.attributes,
            claimKind: input.kind,
            claimText: input.text,
            confidence: input.confidence,
            evidence: input.evidence as unknown as Record<string, unknown>,
            latestEventId: event.id,
            observedAt,
            state,
            updatedAt: new Date(),
          },
          target: [currentClaims.workspaceId, currentClaims.claimKey],
        })
        .returning();

      if (currentClaim === undefined) {
        throw new ClaimProjectionError({ message: "current claim projection returned no row" });
      }

      return { currentClaim, event };
    },
    catch: (cause) =>
      cause instanceof ClaimProjectionError
        ? cause
        : new ClaimProjectionError({ message: errorMessage(cause) }),
  });
}

export function listCurrentClaims(
  service: DatabaseService,
  input: {
    limit?: number | undefined;
    workspaceId: string;
  },
): Effect.Effect<CurrentClaim[], ClaimProjectionError> {
  return Effect.tryPromise({
    try: () =>
      service.db
        .select()
        .from(currentClaims)
        .where(and(eq(currentClaims.workspaceId, input.workspaceId)))
        .orderBy(desc(currentClaims.confidence), desc(currentClaims.observedAt))
        .limit(input.limit ?? 20),
    catch: (cause) => new ClaimProjectionError({ message: errorMessage(cause) }),
  });
}

async function findExistingClaimEvent(
  service: DatabaseService,
  input: InsertClaimEventInput,
): Promise<ClaimEvent> {
  const [event] = await service.db
    .select()
    .from(claimEvents)
    .where(
      and(
        eq(claimEvents.workspaceId, input.workspaceId),
        eq(claimEvents.eventType, input.eventType),
        eq(claimEvents.claimKey, input.claimKey),
        eq(claimEvents.rawEventId, input.evidence.rawEventId),
      ),
    )
    .limit(1);

  if (event === undefined) {
    throw new ClaimProjectionError({ message: "claim event insert returned no row" });
  }

  return event;
}

function stateForEventType(eventType: ClaimEventType): ClaimState {
  if (eventType === "supported") return "supported";
  if (eventType === "contradicted") return "contradicted";
  if (eventType === "rejected") return "rejected";
  return "candidate";
}

function shouldProjectClaimEvent(
  existing: CurrentClaim,
  nextState: ClaimState,
  nextObservedAt: Date,
): boolean {
  const existingTime = existing.observedAt.getTime();
  const nextTime = nextObservedAt.getTime();
  if (nextTime < existingTime) return false;

  const existingPrecedence = statePrecedence(existing.state);
  const nextPrecedence = statePrecedence(nextState);
  if (nextTime === existingTime) return nextPrecedence >= existingPrecedence;
  return nextPrecedence >= existingPrecedence || existing.state === "candidate";
}

function statePrecedence(state: string): number {
  if (state === "rejected") return 3;
  if (state === "contradicted") return 2;
  if (state === "supported") return 1;
  return 0;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
