// Compile-time parity guard (never executed): each @saga/api-client wire type
// must equal the @saga/db read shape it mirrors, after Date fields are mapped to
// the ISO strings that cross the HTTP boundary. This is the forcing function that
// makes a silent drift between the two type sets a typecheck failure — e.g. a
// field the server returns but the wire type omits. apps/service already imports
// both packages, so there is no boundary concern in referencing them here.

import type {
  RawEvent as WireRawEvent,
  RecallContextExpansion as WireRecallContextExpansion,
  RecallExpandedSegment as WireRecallExpandedSegment,
  RecallExpandedTurn as WireRecallExpandedTurn,
  RecallSearchResult as WireRecallSearchResult,
  RecentSessionRecord as WireRecentSessionRecord,
  SessionDetail as WireSessionDetail,
} from '@saga/api-client';
import type {
  RawEvent as DbRawEvent,
  RecallContextExpansion as DbRecallContextExpansion,
  RecallExpandedSegment as DbRecallExpandedSegment,
  RecallExpandedTurn as DbRecallExpandedTurn,
  RecallSearchResult as DbRecallSearchResult,
  RecentSessionRecord as DbRecentSessionRecord,
  SessionDetail as DbSessionDetail,
} from '@saga/db';

// Map a db read shape onto its JSON-serialized form: Date -> string, recursing
// through arrays and objects, leaving every other type as-is. Mirrors what
// JSON.stringify does to the read result before it crosses the wire.
type Jsonify<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonify<U>[]
    : T extends readonly (infer U)[]
      ? readonly Jsonify<U>[]
      : T extends object
        ? { [K in keyof T]: Jsonify<T[K]> }
        : T;

// Exact structural equality (invariant in both directions). The (<T>() => ...)
// form is the canonical exact-equality trick; each T is single-use by design.
/* oxlint-disable typescript/no-unnecessary-type-parameters */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/* oxlint-enable typescript/no-unnecessary-type-parameters */
type Extends<A, B> = A extends B ? true : false;
type Expect<T extends true> = T;

// The wire types express some shapes as intersections (e.g. `SegmentMetadata &
// { ... }`); Jsonify flattens those recursively. Run BOTH sides through Jsonify
// so the comparison is between two identically-normalized structures — the wire
// side has no Date fields, so Jsonify only flattens it.
type WireMatchesDb<Wire, Db> = Equal<Jsonify<Wire>, Jsonify<Db>>;

// Each assertion fails to compile the moment the two shapes diverge.
type _turnParity = Expect<WireMatchesDb<WireRecallExpandedTurn, DbRecallExpandedTurn>>;
type _segmentParity = Expect<WireMatchesDb<WireRecallExpandedSegment, DbRecallExpandedSegment>>;
type _contextParity = Expect<WireMatchesDb<WireRecallContextExpansion, DbRecallContextExpansion>>;
type _sessionDetailParity = Expect<WireMatchesDb<WireSessionDetail, DbSessionDetail>>;
type _recentSessionParity = Expect<WireMatchesDb<WireRecentSessionRecord, DbRecentSessionRecord>>;
type _recallResultParity = Expect<WireMatchesDb<WireRecallSearchResult, DbRecallSearchResult>>;

// RawEvent is exact everywhere except trustLevel, which the wire type
// deliberately narrows from the db column's bare `string` to the TrustLevel
// union. Assert the rest is exact, then that the narrowing is a valid subtype.
type _rawEventParity = Expect<
  WireMatchesDb<Omit<WireRawEvent, 'trustLevel'>, Omit<DbRawEvent, 'trustLevel'>>
>;
type _rawEventTrustParity = Expect<
  Extends<WireRawEvent['trustLevel'], Jsonify<DbRawEvent>['trustLevel']>
>;
