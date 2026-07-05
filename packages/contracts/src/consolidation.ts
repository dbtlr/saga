import { Schema } from 'effect';

/**
 * Consolidation output contract (ADR-0042, ADR-0008 amendment).
 *
 * Ambient consolidation produces one immutable Consolidation Record per settled
 * Activity Interval of a root session: a narrative plus typed Findings with stable
 * ids, structured Evidence Pointers (by session / activity-interval / turn ordinal),
 * and Disposition edges between findings.
 *
 * This is the first domain contract born in Effect Schema. It is the shape the
 * future extractor's structured output validates against, so the extractor-facing
 * subset ({@link ConsolidationOutput}) stays JSON-clean: it carries only what a
 * model emits. The system-assigned envelope (ids, model id, auth path, timestamp)
 * lives on the persisted {@link ConsolidationRecord}.
 */

const NonNegativeInt = Schema.Int.pipe(Schema.greaterThanOrEqualTo(0));

/** The four Finding types an interval's consolidation may surface. */
export const FindingType = Schema.Literal(
  'decision',
  'follow_up',
  'deviation_or_correction',
  'candidate_learning',
);
export type FindingType = Schema.Schema.Type<typeof FindingType>;

/** Directed relationship a later Finding asserts over an earlier one. */
export const DispositionKind = Schema.Literal('builds_on', 'refutes');
export type DispositionKind = Schema.Schema.Type<typeof DispositionKind>;

/**
 * A resilient pointer into transcript structure. Ordinals (not row ids) are used
 * so pointers survive re-import and redaction. A pointer names a session and,
 * optionally, an activity-interval ordinal within it and a turn ordinal within
 * that interval.
 */
export const EvidencePointer = Schema.Struct({
  sessionId: Schema.UUID,
  activityIntervalOrdinal: Schema.optional(NonNegativeInt),
  turnOrdinal: Schema.optional(NonNegativeInt),
});
export type EvidencePointer = Schema.Schema.Type<typeof EvidencePointer>;

/**
 * A single typed observation. `id` is stable and unique within its record, and is
 * what Disposition edges reference (including edges from a later record into this
 * one across a continuation lineage).
 */
export const Finding = Schema.Struct({
  id: Schema.UUID,
  type: FindingType,
  text: Schema.NonEmptyString,
  evidence: Schema.Array(EvidencePointer),
});
export type Finding = Schema.Schema.Type<typeof Finding>;

/**
 * A directed edge from a Finding in the record being written (`fromFindingId`) to
 * an earlier Finding (`toFindingId`). Self-edges are disallowed. The write path
 * enforces that the target belongs to the same session or its continuation lineage.
 */
export const Disposition = Schema.Struct({
  kind: DispositionKind,
  fromFindingId: Schema.UUID,
  toFindingId: Schema.UUID,
});
export type Disposition = Schema.Schema.Type<typeof Disposition>;

/**
 * The extractor-facing structured output: exactly what a model emits for one
 * settled interval. System-assigned envelope fields are added on persistence.
 */
export const ConsolidationOutput = Schema.Struct({
  narrative: Schema.NonEmptyString,
  findings: Schema.Array(Finding),
  dispositions: Schema.Array(Disposition),
});
export type ConsolidationOutput = Schema.Schema.Type<typeof ConsolidationOutput>;

/**
 * A complete, persisted Consolidation Record: the extractor output plus the
 * immutable envelope the system assigns (identity, scoping, the model id and auth
 * path that produced it, and the creation timestamp).
 */
export const ConsolidationRecord = Schema.Struct({
  id: Schema.UUID,
  workspaceId: Schema.UUID,
  sessionId: Schema.UUID,
  activityIntervalId: Schema.UUID,
  narrative: Schema.NonEmptyString,
  findings: Schema.Array(Finding),
  dispositions: Schema.Array(Disposition),
  modelId: Schema.NonEmptyString,
  authPath: Schema.NonEmptyString,
  createdAt: Schema.DateFromSelf,
});
export type ConsolidationRecord = Schema.Schema.Type<typeof ConsolidationRecord>;
