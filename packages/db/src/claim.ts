import { randomUUID } from 'node:crypto';

import {
  candidateClaimKey,
  detectClaimContradiction,
  type CandidateClaim,
  type ClaimKind,
  type ClaimEvidence,
} from '@saga/claims';
import { and, desc, eq, notInArray, sql, type SQL } from 'drizzle-orm';
import { Data, Effect } from 'effect';

import type { DatabaseError, DatabaseService } from './database.js';
import { insertRawEvent } from './raw-event.js';
import {
  claimEvents,
  currentClaims,
  rawEvents,
  sourceBindings,
  type ClaimEvent,
  type CurrentClaim,
  type RawEvent,
} from './schema.js';

export type ClaimEventType =
  | 'contradicted'
  | 'decayed'
  | 'extracted'
  | 'merged'
  | 'pinned'
  | 'promoted'
  | 'rejected'
  | 'split'
  | 'supported'
  | 'superseded'
  | 'unpinned'
  | 'unwatched'
  | 'watched';
export type ClaimState =
  | 'candidate'
  | 'contradicted'
  | 'decayed'
  | 'rejected'
  | 'supported'
  | 'superseded';
export type ClaimMaintenanceAction = 'decay' | 'merge' | 'split' | 'supersede';
export type ClaimReviewAction = 'accept' | 'pin' | 'reject' | 'unpin' | 'unwatch' | 'watch';

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

export interface ClaimConfidenceInput {
  actorId?: string | null | undefined;
  baseConfidence: number;
  claimKind: ClaimKind;
  eventType: ClaimEventType;
  now?: Date | string | undefined;
  occurredAt: Date | string;
  priorContradictions: number;
  priorEvents: number;
  sourceType: string;
  trustLevel?: string | null | undefined;
}

export interface ClaimConfidenceResult {
  inputs: {
    actorAuthority: number;
    base: number;
    contradiction: number;
    explicitness: number;
    humanPromotion: number;
    recurrence: number;
    recency: number;
    sourceQuality: number;
  };
  score: number;
}

export interface InsertClaimReviewEventInput {
  action: ClaimReviewAction;
  actorId?: string | undefined;
  claimKey: string;
  occurredAt?: Date | string | undefined;
  workspaceId: string;
}

export interface InsertClaimMaintenanceEventInput {
  action: ClaimMaintenanceAction;
  actorId?: string | undefined;
  claimKey: string;
  occurredAt?: Date | string | undefined;
  reason?: string | undefined;
  targetClaimKeys?: readonly string[] | undefined;
  workspaceId: string;
}

export interface InsertClaimPromotionEventInput {
  actorId?: string | undefined;
  claimKey: string;
  occurredAt?: Date | string | undefined;
  title?: string | undefined;
  workspaceId: string;
}

export class ClaimProjectionError extends Data.TaggedError('ClaimProjectionError')<{
  readonly message: string;
}> {}

export function insertExtractedCandidateClaim(
  service: DatabaseService,
  candidate: CandidateClaim,
): Effect.Effect<ClaimProjectionResult, ClaimProjectionError | DatabaseError> {
  return Effect.gen(function* () {
    const result = yield* insertClaimEventAndProject(service, {
      attributes: candidate.attributes,
      claimKey: candidateClaimKey(candidate),
      confidence: candidate.confidence,
      evidence: candidate.evidence,
      eventType: 'extracted',
      kind: candidate.kind,
      text: candidate.text,
      workspaceId: candidate.workspaceId,
    });
    yield* projectContradictionsForCandidate(service, candidate, result.currentClaim.claimKey);
    return result;
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
          message: 'claim evidence occurredAt must be an ISO timestamp',
        });
      }
      const rawEvent = await findRawEventForEvidence(service, input);
      const confidenceStats = await readClaimConfidenceStats(service, input);
      const confidence = scoreClaimConfidence({
        actorId: rawEvent.actorId,
        baseConfidence: input.confidence,
        claimKind: input.kind,
        eventType: input.eventType,
        occurredAt: observedAt,
        priorContradictions: confidenceStats.priorContradictions,
        priorEvents: confidenceStats.priorEvents,
        sourceType: rawEvent.sourceType,
        trustLevel: rawEvent.trustLevel,
      });
      const eventAttributes = withConfidenceAttributes(input.attributes, confidence);

      const [insertedEvent] = await service.db
        .insert(claimEvents)
        .values({
          attributes: eventAttributes,
          claimKey: input.claimKey,
          claimKind: input.kind,
          claimText: input.text,
          confidence: confidence.score,
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
      const projectedAttributes = asRecord(event.attributes);
      const projectedEvidence = asRecord(event.evidence);
      const existingCurrentClaim = await findOptionalCurrentClaim(service, input);
      if (isReviewAttributeEventType(input.eventType)) {
        const existingClaim =
          existingCurrentClaim ?? (await findExistingCurrentClaim(service, input));
        const [currentClaim] = await service.db
          .update(currentClaims)
          .set({
            attributes: projectedAttributes,
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
      const nextAttributes = preserveReviewAttributes(
        projectedAttributes,
        existingCurrentClaim?.attributes,
      );
      const [currentClaim] = await service.db
        .insert(currentClaims)
        .values({
          attributes: nextAttributes,
          claimKey: input.claimKey,
          claimKind: event.claimKind,
          claimText: event.claimText,
          confidence: event.confidence,
          evidence: projectedEvidence,
          latestEventId: event.id,
          observedAt,
          state,
          workspaceId: input.workspaceId,
        })
        .onConflictDoUpdate({
          set: {
            attributes: nextAttributes,
            claimKind: event.claimKind,
            claimText: event.claimText,
            confidence: event.confidence,
            evidence: projectedEvidence,
            latestEventId: event.id,
            observedAt,
            state,
            updatedAt: new Date(),
          },
          target: [currentClaims.workspaceId, currentClaims.claimKey],
          where: projectionAdvanceSql(
            state,
            observedAt,
            isLifecycleReviewEvent(input) ||
              isLifecycleMaintenanceEvent(input) ||
              isPromotionEvent(input),
          ),
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

export function scoreClaimConfidence(input: ClaimConfidenceInput): ClaimConfidenceResult {
  const occurredAt = toDate(input.occurredAt);
  const now = toDate(input.now ?? new Date());
  const ageDays = Math.max(0, (now.getTime() - occurredAt.getTime()) / 86_400_000);
  const inputs = {
    actorAuthority: actorAuthorityScore(input.actorId),
    base: clampConfidence(input.baseConfidence),
    contradiction: contradictionScore(input),
    explicitness: explicitnessScore(input),
    humanPromotion: humanPromotionScore(input),
    recurrence: recurrenceScore(input.priorEvents),
    recency: recencyScore(ageDays),
    sourceQuality: sourceQualityScore(input),
  };
  const score = clampConfidence(
    inputs.base +
      inputs.actorAuthority +
      inputs.contradiction +
      inputs.explicitness +
      inputs.humanPromotion +
      inputs.recurrence +
      inputs.recency +
      inputs.sourceQuality,
  );

  return {
    inputs,
    score,
  };
}

function projectContradictionsForCandidate(
  service: DatabaseService,
  candidate: CandidateClaim,
  candidateKey: string,
): Effect.Effect<void, ClaimProjectionError | DatabaseError> {
  return Effect.gen(function* () {
    const existingClaims = yield* listCurrentClaims(service, {
      limit: 100,
      workspaceId: candidate.workspaceId,
    });
    for (const claim of existingClaims) {
      if (claim.claimKey === candidateKey) continue;
      if (claim.state === 'rejected' || claim.state === 'contradicted') continue;

      const contradiction = detectClaimContradiction(claim.claimText, candidate.text);
      if (contradiction === undefined) continue;

      yield* insertClaimEventAndProject(service, {
        attributes: {
          ...candidate.attributes,
          contradiction: {
            detectedByClaimKey: candidateKey,
            detectedByClaimText: candidate.text,
            score: contradiction.score,
          },
        },
        claimKey: claim.claimKey,
        confidence: candidate.confidence,
        evidence: candidate.evidence,
        eventType: 'contradicted',
        kind: readClaimKind(claim.claimKind),
        text: claim.claimText,
        workspaceId: candidate.workspaceId,
      });
    }
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
        throw new ClaimProjectionError({ message: 'claim is not available for review' });
      }

      const occurredAt = input.occurredAt === undefined ? new Date() : new Date(input.occurredAt);
      if (Number.isNaN(occurredAt.getTime())) {
        throw new ClaimProjectionError({
          message: 'claim review occurredAt must be an ISO timestamp',
        });
      }

      const sourceBinding = await ensureControlPlaneSourceBinding(service, input.workspaceId);
      const reviewEventType = eventTypeForReviewAction(input.action);
      const externalEventId = [
        'saga',
        'claim-review',
        input.claimKey,
        input.action,
        occurredAt.toISOString(),
        randomUUID(),
      ].join(':');
      const rawEvent = await Effect.runPromise(
        insertRawEvent(service, {
          actorId: input.actorId ?? 'control-plane',
          eventType: 'saga.claim.review',
          externalEventId,
          occurredAt: occurredAt.toISOString(),
          payload: {
            action: input.action,
            claimKey: input.claimKey,
            previousState: claim.state,
          },
          provenance: {
            surface: 'control-plane',
          },
          sourceBindingId: sourceBinding.id,
          sourceId: 'saga:control-plane',
          sourceType: 'saga',
          trustLevel: 'trusted',
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

export function insertClaimMaintenanceEventAndProject(
  service: DatabaseService,
  input: InsertClaimMaintenanceEventInput,
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
        throw new ClaimProjectionError({ message: 'claim is not available for maintenance' });
      }

      const occurredAt = input.occurredAt === undefined ? new Date() : new Date(input.occurredAt);
      if (Number.isNaN(occurredAt.getTime())) {
        throw new ClaimProjectionError({
          message: 'claim maintenance occurredAt must be an ISO timestamp',
        });
      }

      const sourceBinding = await ensureControlPlaneSourceBinding(service, input.workspaceId);
      const maintenanceEventType = eventTypeForMaintenanceAction(input.action);
      const externalEventId = [
        'saga',
        'claim-maintenance',
        input.claimKey,
        input.action,
        occurredAt.toISOString(),
        randomUUID(),
      ].join(':');
      const rawEvent = await Effect.runPromise(
        insertRawEvent(service, {
          actorId: input.actorId ?? 'control-plane',
          eventType: 'saga.claim.maintenance',
          externalEventId,
          occurredAt: occurredAt.toISOString(),
          payload: {
            action: input.action,
            claimKey: input.claimKey,
            previousState: claim.state,
            reason: input.reason,
            targetClaimKeys: input.targetClaimKeys ?? [],
          },
          provenance: {
            surface: 'control-plane',
          },
          sourceBindingId: sourceBinding.id,
          sourceId: 'saga:control-plane',
          sourceType: 'saga',
          trustLevel: 'trusted',
          workspaceId: input.workspaceId,
        }),
      );
      const evidence: ClaimEvidence = {
        eventType: rawEvent.eventType,
        externalEventId: rawEvent.externalEventId,
        occurredAt: rawEvent.occurredAt.toISOString(),
        quote: `Control-plane maintenance action: ${input.action}`,
        rawEventId: rawEvent.id,
        sourceId: rawEvent.sourceId,
        sourceType: rawEvent.sourceType,
      };

      return await Effect.runPromise(
        insertClaimEventAndProject(service, {
          attributes: maintenanceAttributesForEventType(
            claim.attributes,
            maintenanceEventType,
            occurredAt.toISOString(),
            {
              reason: input.reason,
              targetClaimKeys: input.targetClaimKeys,
            },
          ),
          claimKey: claim.claimKey,
          confidence: claim.confidence,
          evidence,
          eventType: maintenanceEventType,
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

export function insertClaimPromotionEventAndProject(
  service: DatabaseService,
  input: InsertClaimPromotionEventInput,
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
        throw new ClaimProjectionError({ message: 'claim is not available for promotion' });
      }
      if (claim.state === 'rejected' || claim.state === 'superseded') {
        throw new ClaimProjectionError({
          message: 'terminal claims are not available for promotion',
        });
      }

      const occurredAt = input.occurredAt === undefined ? new Date() : new Date(input.occurredAt);
      if (Number.isNaN(occurredAt.getTime())) {
        throw new ClaimProjectionError({
          message: 'claim promotion occurredAt must be an ISO timestamp',
        });
      }

      const sourceBinding = await ensureControlPlaneSourceBinding(service, input.workspaceId);
      const title = promotionTitle(input.title, claim.claimText);
      const externalEventId = [
        'saga',
        'claim-promotion',
        input.claimKey,
        occurredAt.toISOString(),
        randomUUID(),
      ].join(':');
      const rawEvent = await Effect.runPromise(
        insertRawEvent(service, {
          actorId: input.actorId ?? 'control-plane',
          eventType: 'saga.claim.promotion',
          externalEventId,
          occurredAt: occurredAt.toISOString(),
          payload: {
            claimKey: input.claimKey,
            previousState: claim.state,
            title,
          },
          provenance: {
            surface: 'control-plane',
          },
          sourceBindingId: sourceBinding.id,
          sourceId: 'saga:control-plane',
          sourceType: 'saga',
          trustLevel: 'trusted',
          workspaceId: input.workspaceId,
        }),
      );
      const evidence: ClaimEvidence = {
        eventType: rawEvent.eventType,
        externalEventId: rawEvent.externalEventId,
        occurredAt: rawEvent.occurredAt.toISOString(),
        quote: `Promoted to decision record: ${title}`,
        rawEventId: rawEvent.id,
        sourceId: rawEvent.sourceId,
        sourceType: rawEvent.sourceType,
      };

      return await Effect.runPromise(
        insertClaimEventAndProject(service, {
          attributes: promotionAttributes(claim.attributes, {
            promotedAt: occurredAt.toISOString(),
            title,
          }),
          claimKey: claim.claimKey,
          confidence: claim.confidence,
          evidence,
          eventType: 'promoted',
          kind: 'decision',
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

export function listActiveContextClaims(
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
        .where(
          and(
            eq(currentClaims.workspaceId, input.workspaceId),
            notInArray(currentClaims.state, ['rejected', 'superseded']),
          ),
        )
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
    throw new ClaimProjectionError({ message: 'claim event insert returned no row' });
  }

  return event;
}

async function findExistingCurrentClaim(
  service: DatabaseService,
  input: InsertClaimEventInput,
): Promise<CurrentClaim> {
  const currentClaim = await findOptionalCurrentClaim(service, input);

  if (currentClaim === undefined) {
    throw new ClaimProjectionError({ message: 'current claim projection returned no row' });
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

async function findRawEventForEvidence(
  service: DatabaseService,
  input: InsertClaimEventInput,
): Promise<RawEvent> {
  const [rawEvent] = await service.db
    .select()
    .from(rawEvents)
    .where(eq(rawEvents.id, input.evidence.rawEventId))
    .limit(1);

  if (rawEvent === undefined) {
    throw new ClaimProjectionError({ message: 'claim evidence rawEventId does not exist' });
  }
  if (rawEvent.workspaceId !== input.workspaceId) {
    throw new ClaimProjectionError({
      message: 'claim evidence rawEventId belongs to a different workspace',
    });
  }
  if (
    rawEvent.sourceId !== input.evidence.sourceId ||
    rawEvent.sourceType !== input.evidence.sourceType ||
    rawEvent.externalEventId !== input.evidence.externalEventId
  ) {
    throw new ClaimProjectionError({
      message: 'claim evidence does not match the referenced raw event',
    });
  }

  return rawEvent;
}

async function readClaimConfidenceStats(
  service: DatabaseService,
  input: InsertClaimEventInput,
): Promise<{ priorContradictions: number; priorEvents: number }> {
  const [stats] = await service.db
    .select({
      priorContradictions: sql<number>`count(*) filter (
        where ${claimEvents.eventType} in ('contradicted', 'rejected')
      )::int`,
      priorEvents: sql<number>`count(distinct ${claimEvents.rawEventId}) filter (
        where ${claimEvents.eventType} in ('extracted', 'supported')
      )::int`,
    })
    .from(claimEvents)
    .where(
      and(eq(claimEvents.workspaceId, input.workspaceId), eq(claimEvents.claimKey, input.claimKey)),
    );

  return {
    priorContradictions: Number(stats?.priorContradictions ?? 0),
    priorEvents: Number(stats?.priorEvents ?? 0),
  };
}

function stateForEventType(eventType: ClaimEventType): ClaimState {
  if (eventType === 'supported' || eventType === 'promoted') return 'supported';
  if (eventType === 'contradicted') return 'contradicted';
  if (eventType === 'decayed') return 'decayed';
  if (eventType === 'rejected') return 'rejected';
  if (eventType === 'merged' || eventType === 'split' || eventType === 'superseded') {
    return 'superseded';
  }
  return 'candidate';
}

function eventTypeForReviewAction(action: ClaimReviewAction): ClaimEventType {
  if (action === 'accept') return 'supported';
  if (action === 'reject') return 'rejected';
  if (action === 'pin') return 'pinned';
  if (action === 'unpin') return 'unpinned';
  if (action === 'watch') return 'watched';
  return 'unwatched';
}

function eventTypeForMaintenanceAction(action: ClaimMaintenanceAction): ClaimEventType {
  if (action === 'decay') return 'decayed';
  if (action === 'merge') return 'merged';
  if (action === 'split') return 'split';
  return 'superseded';
}

function isReviewAttributeEventType(eventType: ClaimEventType): boolean {
  return (
    eventType === 'pinned' ||
    eventType === 'unpinned' ||
    eventType === 'watched' ||
    eventType === 'unwatched'
  );
}

function isLifecycleReviewEvent(input: InsertClaimEventInput): boolean {
  return (
    (input.eventType === 'supported' || input.eventType === 'rejected') &&
    input.evidence.eventType === 'saga.claim.review'
  );
}

function isPromotionEvent(input: InsertClaimEventInput): boolean {
  return input.eventType === 'promoted' && input.evidence.eventType === 'saga.claim.promotion';
}

function isLifecycleMaintenanceEvent(input: InsertClaimEventInput): boolean {
  return (
    (input.eventType === 'decayed' ||
      input.eventType === 'merged' ||
      input.eventType === 'split' ||
      input.eventType === 'superseded') &&
    input.evidence.eventType === 'saga.claim.maintenance'
  );
}

function preserveReviewAttributes(
  nextAttributes: Record<string, unknown>,
  existingAttributes: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (existingAttributes === undefined) return nextAttributes;

  const governanceAttributes = Object.fromEntries(
    Object.entries(existingAttributes).filter(
      ([key]) => key.startsWith('review') || key.startsWith('adr'),
    ),
  );
  return {
    ...governanceAttributes,
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
  if (eventType === 'pinned') return { ...next, reviewPinned: true };
  if (eventType === 'unpinned') return { ...next, reviewPinned: false };
  if (eventType === 'watched') return { ...next, reviewWatched: true };
  if (eventType === 'unwatched') return { ...next, reviewWatched: false };
  return next;
}

function promotionAttributes(
  attributes: Record<string, unknown>,
  input: {
    promotedAt: string;
    title: string;
  },
): Record<string, unknown> {
  return {
    ...attributes,
    adrPromoted: true,
    adrPromotedAt: input.promotedAt,
    adrTitle: input.title,
  };
}

function promotionTitle(title: string | undefined, claimText: string): string {
  const normalized = title?.trim();
  if (normalized !== undefined && normalized !== '') return normalized;
  return claimText.length <= 72 ? claimText : `${claimText.slice(0, 69)}...`;
}

function maintenanceAttributesForEventType(
  attributes: Record<string, unknown>,
  eventType: ClaimEventType,
  maintainedAt: string,
  input: {
    reason?: string | undefined;
    targetClaimKeys?: readonly string[] | undefined;
  },
): Record<string, unknown> {
  return {
    ...attributes,
    maintenanceLastAction: eventType,
    maintenanceLastAt: maintainedAt,
    ...(input.reason === undefined ? {} : { maintenanceReason: input.reason }),
    ...((input.targetClaimKeys ?? []).length === 0
      ? {}
      : { maintenanceTargetClaimKeys: input.targetClaimKeys }),
  };
}

async function ensureControlPlaneSourceBinding(
  service: DatabaseService,
  workspaceId: string,
): Promise<{ id: string }> {
  const [sourceBinding] = await service.db
    .insert(sourceBindings)
    .values({
      displayName: 'Saga Control Plane',
      sourceType: 'saga',
      sourceUri: 'saga://control-plane',
      workspaceId,
    })
    .onConflictDoUpdate({
      set: {
        displayName: 'Saga Control Plane',
        updatedAt: new Date(),
      },
      target: [sourceBindings.workspaceId, sourceBindings.sourceType, sourceBindings.sourceUri],
    })
    .returning({ id: sourceBindings.id });

  if (sourceBinding === undefined) {
    throw new ClaimProjectionError({ message: 'control-plane source binding returned no row' });
  }

  return sourceBinding;
}

function readClaimKind(value: string): ClaimKind {
  if (
    value === 'decision' ||
    value === 'follow_up' ||
    value === 'observation' ||
    value === 'preference'
  ) {
    return value;
  }

  throw new ClaimProjectionError({ message: `unsupported claim kind: ${value}` });
}

function withConfidenceAttributes(
  attributes: Record<string, unknown>,
  confidence: ClaimConfidenceResult,
): Record<string, unknown> {
  return {
    ...attributes,
    confidenceBase: confidence.inputs.base,
    confidenceInputs: confidence.inputs,
  };
}

function actorAuthorityScore(actorId: string | null | undefined): number {
  if (actorId === 'control-plane') return 0.08;
  if (actorId === 'human') return 0.08;
  if (actorId === 'codex' || actorId === 'claude') return 0.01;
  return 0;
}

function contradictionScore(input: ClaimConfidenceInput): number {
  const priorPenalty = -Math.min(0.16, input.priorContradictions * 0.08);
  if (input.eventType === 'contradicted') return priorPenalty - 0.22;
  if (input.eventType === 'decayed') return priorPenalty - 0.45;
  if (
    input.eventType === 'merged' ||
    input.eventType === 'split' ||
    input.eventType === 'superseded'
  ) {
    return priorPenalty - 0.5;
  }
  if (input.eventType === 'rejected') return priorPenalty - 0.35;
  return priorPenalty;
}

function explicitnessScore(input: ClaimConfidenceInput): number {
  if (input.eventType === 'promoted') return 0.12;
  if (input.eventType === 'supported' && input.sourceType === 'saga') return 0.08;
  if (input.eventType === 'extracted' && input.claimKind === 'decision') return 0.03;
  if (input.eventType === 'extracted' && input.claimKind === 'preference') return 0.02;
  return 0;
}

function humanPromotionScore(input: ClaimConfidenceInput): number {
  if (input.eventType === 'promoted' && input.sourceType === 'saga') return 0.2;
  if (input.eventType === 'supported' && input.sourceType === 'saga') return 0.15;
  if (input.eventType === 'rejected' && input.sourceType === 'saga') return -0.35;
  return 0;
}

function recurrenceScore(priorEvents: number): number {
  return Math.min(0.12, Math.max(0, priorEvents) * 0.04);
}

function recencyScore(ageDays: number): number {
  if (ageDays <= 7) return 0.03;
  if (ageDays <= 30) return 0.01;
  if (ageDays <= 90) return 0;
  return -0.08;
}

function sourceQualityScore(input: ClaimConfidenceInput): number {
  const trustScore = input.trustLevel === 'trusted' ? 0.08 : 0;
  if (input.sourceType === 'saga') return trustScore + 0.05;
  if (input.sourceType === 'git') return trustScore + 0.03;
  if (input.sourceType === 'codex' || input.sourceType === 'claude') return trustScore + 0.01;
  return trustScore;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
    when 'rejected' then 4
    when 'superseded' then 3
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
  if (state === 'rejected') return 4;
  if (state === 'superseded') return 3;
  if (state === 'contradicted') return 2;
  if (state === 'supported') return 1;
  return 0;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
