// oxlint-disable new-cap -- Effect Schema exposes its combinators as capitalized
// factory functions (Struct, Literal, Array); calling them is the intended API.
import { Schema } from 'effect';

/**
 * Consolidation output contract (ADR-0042, ADR-0008 amendment).
 *
 * Ambient consolidation produces one immutable Consolidation Record per settled
 * Activity Interval of a root session: a narrative plus typed Findings, structured
 * Evidence Pointers (by session / activity-interval / turn ordinal), and Disposition
 * edges between findings.
 *
 * This is the first domain contract born in Effect Schema. It draws a hard seam
 * between what a model emits and what the system persists:
 *
 * - {@link ConsolidationOutput} is the extractor-facing shape. Its findings carry a
 *   LOCAL {@link OutputFinding.key} (unique within the one output), never a system
 *   id. A disposition's source is always a local key; its target is EITHER a local
 *   key (same-record) OR an already-persisted finding UUID (cross-record, because
 *   prior records are the extractor's input context). No model-emitted value ever
 *   becomes a row primary key.
 * - {@link ConsolidationRecord} is the persisted envelope. The write path mints the
 *   finding UUIDs, resolves the local keys to them, and stamps identity, scoping,
 *   the model id / auth path, and the creation timestamp.
 */

const NonNegativeInt = Schema.Int.pipe(Schema.greaterThanOrEqualTo(0));

/**
 * The four Finding types an interval's consolidation may surface. {@link FINDING_TYPES}
 * is the single runtime source of truth: it drives this literal union and the
 * database's finding-type check constraint.
 */
export const FINDING_TYPES = [
  'decision',
  'follow_up',
  'deviation_or_correction',
  'candidate_learning',
] as const;
export const FindingType = Schema.Literal(...FINDING_TYPES);
export type FindingType = Schema.Schema.Type<typeof FindingType>;

/**
 * Directed relationship a later Finding asserts over an earlier one.
 * {@link DISPOSITION_KINDS} is the single runtime source of truth: it drives this
 * literal union and the database's disposition-kind check constraint.
 */
export const DISPOSITION_KINDS = ['builds_on', 'refutes'] as const;
export const DispositionKind = Schema.Literal(...DISPOSITION_KINDS);
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
 * A single typed observation as the extractor emits it. `key` is a local label,
 * unique only within this one output; dispositions in the same output reference it.
 * The write path mints the persisted UUID — the extractor never sees or supplies it.
 */
export const OutputFinding = Schema.Struct({
  key: Schema.NonEmptyString,
  type: FindingType,
  text: Schema.NonEmptyString,
  evidence: Schema.Array(EvidencePointer),
});
export type OutputFinding = Schema.Schema.Type<typeof OutputFinding>;

/**
 * A directed edge the extractor emits. `fromKey` is always a local finding key in
 * the same output. The target is EITHER `toKey` (a local key in the same output,
 * i.e. a same-record edge) OR `toFindingId` (the UUID of an already-persisted
 * finding, i.e. a cross-record edge into an earlier record of the continuation
 * lineage). Exactly one target form is present; the write path resolves and
 * validates it. Self-edges and duplicate edges are rejected downstream.
 */
export const OutputDisposition = Schema.Union(
  Schema.Struct({
    kind: DispositionKind,
    fromKey: Schema.NonEmptyString,
    toKey: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: DispositionKind,
    fromKey: Schema.NonEmptyString,
    toFindingId: Schema.UUID,
  }),
);
export type OutputDisposition = Schema.Schema.Type<typeof OutputDisposition>;

/**
 * The extractor-facing structured output: exactly what a model emits for one
 * settled interval. System-assigned identity is added on persistence.
 */
export const ConsolidationOutput = Schema.Struct({
  narrative: Schema.NonEmptyString,
  findings: Schema.Array(OutputFinding),
  dispositions: Schema.Array(OutputDisposition),
});
export type ConsolidationOutput = Schema.Schema.Type<typeof ConsolidationOutput>;

/**
 * A persisted Finding: the system-minted UUID `id` is what cross-record Disposition
 * edges reference (including edges from a later record into this one across a
 * continuation lineage).
 */
export const Finding = Schema.Struct({
  id: Schema.UUID,
  type: FindingType,
  text: Schema.NonEmptyString,
  evidence: Schema.Array(EvidencePointer),
});
export type Finding = Schema.Schema.Type<typeof Finding>;

/**
 * A persisted directed edge from a Finding in this record (`fromFindingId`) to an
 * earlier Finding (`toFindingId`), both by minted UUID.
 */
export const Disposition = Schema.Struct({
  kind: DispositionKind,
  fromFindingId: Schema.UUID,
  toFindingId: Schema.UUID,
});
export type Disposition = Schema.Schema.Type<typeof Disposition>;

/**
 * A complete, persisted Consolidation Record: the extractor's narrative and
 * findings (now UUID-identified) plus the immutable envelope the system assigns
 * (identity, scoping, the model id and auth path that produced it, and the creation
 * timestamp). This is the shape the read path decodes against.
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
