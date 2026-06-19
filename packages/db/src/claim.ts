import { randomUUID } from "node:crypto";
import {
  candidateClaimKey,
  type CandidateClaim,
  type ClaimKind,
  type ClaimEvidence,
} from "@saga/claims";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { Data, Effect } from "effect";
import type { DatabaseError, DatabaseService } from "./database.js";
import { insertRawEvent } from "./raw-event.js";
import {
  claimEvents,
  currentClaims,
  sourceBindings,
  type ClaimEvent,
  type CurrentClaim,
} from "./schema.js";

export type ClaimEventType =
  | "contradicted"
  | "extracted"
  | "pinned"
  | "rejected"
  | "supported"
  | "unpinned"
  | "unwatched"
  | "watched";
export type ClaimState = "candidate" | "contradicted" | "rejected" | "supported";
export type ClaimReviewAction = "accept" | "pin" | "reject" | "unpin" | "unwatch" | "watch";

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

export interface InsertClaimReviewEventInput {
  action: ClaimReviewAction;
  actorId?: string | undefined;
  claimKey: string;
  occurredAt?: Date | string | undefined;
  workspaceId: string;
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
      const existingCurrentClaim = await findOptionalCurrentClaim(service, input);
      if (isReviewAttributeEventType(input.eventType)) {
        const existingClaim =
          existingCurrentClaim ?? (await findExistingCurrentClaim(service, input));
        const [currentClaim] = await service.db
          .update(currentClaims)
          .set({
            attributes: input.attributes,
            latestEventId: event.id,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(currentClaims.workspaceId, input.workspaceId),
              eq(currentClaims.claimKey, input.claimKey),
            ),
          )
          .returning();

        return {
          currentClaim: currentClaim ?? existingClaim,
          event,
        };
      }

      const state = stateForEventType(input.eventType);
      const projectedAttributes = preserveReviewAttributes(
        input.attributes,
        existingCurrentClaim?.attributes,
      );
      const [currentClaim] = await service.db
        .insert(currentClaims)
        .values({
          attributes: projectedAttributes,
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
            attributes: projectedAttributes,
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
          where: projectionAdvanceSql(state, observedAt, isLifecycleReviewEvent(input)),
        })
        .returning();

      if (currentClaim !== undefined) return { currentClaim, event };

      return { currentClaim: await findExistingCurrentClaim(service, input), event };
    },
    catch: (cause) =>
      cause instanceof ClaimProjectionError
        ? cause
        : new ClaimProjectionError({ message: errorMessage(cause) }),
  });
}

export function insertClaimReviewEventAndProject(
  service: DatabaseService,
  input: InsertClaimReviewEventInput,
): Effect.Effect<ClaimProjectionResult, ClaimProjectionError | DatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      const [claim] = await service.db
        .select()
        .from(currentClaims)
        .where(
          and(
            eq(currentClaims.workspaceId, input.workspaceId),
            eq(currentClaims.claimKey, input.claimKey),
          ),
        )
        .limit(1);

      if (claim === undefined) {
        throw new ClaimProjectionError({ message: "claim is not available for review" });
      }

      const occurredAt = input.occurredAt === undefined ? new Date() : new Date(input.occurredAt);
      if (Number.isNaN(occurredAt.getTime())) {
        throw new ClaimProjectionError({
          message: "claim review occurredAt must be an ISO timestamp",
        });
      }

      const sourceBinding = await ensureControlPlaneSourceBinding(service, input.workspaceId);
      const reviewEventType = eventTypeForReviewAction(input.action);
      const externalEventId = [
        "saga",
        "claim-review",
        input.claimKey,
        input.action,
        occurredAt.toISOString(),
        randomUUID(),
      ].join(":");
      const rawEvent = await Effect.runPromise(
        insertRawEvent(service, {
          actorId: input.actorId ?? "control-plane",
          eventType: "saga.claim.review",
          externalEventId,
          occurredAt: occurredAt.toISOString(),
          payload: {
            action: input.action,
            claimKey: input.claimKey,
            previousState: claim.state,
          },
          provenance: {
            surface: "control-plane",
          },
          sourceBindingId: sourceBinding.id,
          sourceId: "saga:control-plane",
          sourceType: "saga",
          trustLevel: "trusted",
          workspaceId: input.workspaceId,
        }),
      );
      const evidence: ClaimEvidence = {
        eventType: rawEvent.eventType,
        externalEventId: rawEvent.externalEventId,
        occurredAt: rawEvent.occurredAt.toISOString(),
        quote: `Control-plane review action: ${input.action}`,
        rawEventId: rawEvent.id,
        sourceId: rawEvent.sourceId,
        sourceType: rawEvent.sourceType,
      };

      return await Effect.runPromise(
        insertClaimEventAndProject(service, {
          attributes: reviewAttributesForEventType(
            claim.attributes,
            reviewEventType,
            occurredAt.toISOString(),
          ),
          claimKey: claim.claimKey,
          confidence: claim.confidence,
          evidence,
          eventType: reviewEventType,
          kind: readClaimKind(claim.claimKind),
          text: claim.claimText,
          workspaceId: input.workspaceId,
        }),
      );
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

async function findExistingCurrentClaim(
  service: DatabaseService,
  input: InsertClaimEventInput,
): Promise<CurrentClaim> {
  const currentClaim = await findOptionalCurrentClaim(service, input);

  if (currentClaim === undefined) {
    throw new ClaimProjectionError({ message: "current claim projection returned no row" });
  }

  return currentClaim;
}

async function findOptionalCurrentClaim(
  service: DatabaseService,
  input: InsertClaimEventInput,
): Promise<CurrentClaim | undefined> {
  const [currentClaim] = await service.db
    .select()
    .from(currentClaims)
    .where(
      and(
        eq(currentClaims.workspaceId, input.workspaceId),
        eq(currentClaims.claimKey, input.claimKey),
      ),
    )
    .limit(1);

  return currentClaim;
}

function stateForEventType(eventType: ClaimEventType): ClaimState {
  if (eventType === "supported") return "supported";
  if (eventType === "contradicted") return "contradicted";
  if (eventType === "rejected") return "rejected";
  return "candidate";
}

function eventTypeForReviewAction(action: ClaimReviewAction): ClaimEventType {
  if (action === "accept") return "supported";
  if (action === "reject") return "rejected";
  if (action === "pin") return "pinned";
  if (action === "unpin") return "unpinned";
  if (action === "watch") return "watched";
  return "unwatched";
}

function isReviewAttributeEventType(eventType: ClaimEventType): boolean {
  return (
    eventType === "pinned" ||
    eventType === "unpinned" ||
    eventType === "watched" ||
    eventType === "unwatched"
  );
}

function isLifecycleReviewEvent(input: InsertClaimEventInput): boolean {
  return (
    (input.eventType === "supported" || input.eventType === "rejected") &&
    input.evidence.eventType === "saga.claim.review"
  );
}

function preserveReviewAttributes(
  nextAttributes: Record<string, unknown>,
  existingAttributes: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (existingAttributes === undefined) return nextAttributes;

  const reviewAttributes = Object.fromEntries(
    Object.entries(existingAttributes).filter(([key]) => key.startsWith("review")),
  );
  return {
    ...reviewAttributes,
    ...nextAttributes,
  };
}

function reviewAttributesForEventType(
  attributes: Record<string, unknown>,
  eventType: ClaimEventType,
  reviewedAt: string,
): Record<string, unknown> {
  const next = {
    ...attributes,
    reviewLastAction: eventType,
    reviewLastAt: reviewedAt,
  };
  if (eventType === "pinned") return { ...next, reviewPinned: true };
  if (eventType === "unpinned") return { ...next, reviewPinned: false };
  if (eventType === "watched") return { ...next, reviewWatched: true };
  if (eventType === "unwatched") return { ...next, reviewWatched: false };
  return next;
}

async function ensureControlPlaneSourceBinding(
  service: DatabaseService,
  workspaceId: string,
): Promise<{ id: string }> {
  const [sourceBinding] = await service.db
    .insert(sourceBindings)
    .values({
      displayName: "Saga Control Plane",
      sourceType: "saga",
      sourceUri: "saga://control-plane",
      workspaceId,
    })
    .onConflictDoUpdate({
      set: {
        displayName: "Saga Control Plane",
        updatedAt: new Date(),
      },
      target: [sourceBindings.workspaceId, sourceBindings.sourceType, sourceBindings.sourceUri],
    })
    .returning({ id: sourceBindings.id });

  if (sourceBinding === undefined) {
    throw new ClaimProjectionError({ message: "control-plane source binding returned no row" });
  }

  return sourceBinding;
}

function readClaimKind(value: string): ClaimKind {
  if (
    value === "decision" ||
    value === "follow_up" ||
    value === "observation" ||
    value === "preference"
  ) {
    return value;
  }

  throw new ClaimProjectionError({ message: `unsupported claim kind: ${value}` });
}

function projectionAdvanceSql(
  nextState: ClaimState,
  nextObservedAt: Date,
  allowStateRegression: boolean,
): SQL {
  const nextPrecedence = statePrecedence(nextState);
  const nextObservedAtIso = nextObservedAt.toISOString();
  if (allowStateRegression) {
    return sql`${currentClaims.observedAt} <= ${nextObservedAtIso}`;
  }

  const existingPrecedence = sql<number>`case ${currentClaims.state}
    when 'rejected' then 3
    when 'contradicted' then 2
    when 'supported' then 1
    else 0
  end`;
  return sql`(
    ${currentClaims.observedAt} < ${nextObservedAtIso}
    and (${currentClaims.state} = 'candidate' or ${nextPrecedence} >= ${existingPrecedence})
  ) or (
    ${currentClaims.observedAt} = ${nextObservedAtIso}
    and ${nextPrecedence} >= ${existingPrecedence}
  )`;
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
