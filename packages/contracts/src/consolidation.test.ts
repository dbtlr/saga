import { Either, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import {
  ConsolidationOutput,
  ConsolidationRecord,
  DISPOSITION_KINDS,
  Disposition,
  DispositionKind,
  EvidencePointer,
  FINDING_TYPES,
  Finding,
  FindingType,
  OutputDisposition,
  OutputFinding,
} from './consolidation.js';

const findingA = '11111111-1111-4111-8111-111111111111';
const findingB = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';

describe('consolidation contract', () => {
  it('exposes the four finding types as a single runtime source', () => {
    expect([...FINDING_TYPES]).toStrictEqual([
      'decision',
      'follow_up',
      'deviation_or_correction',
      'candidate_learning',
    ]);
    expect(FindingType.literals).toStrictEqual([...FINDING_TYPES]);
  });

  it('exposes the disposition kinds as a single runtime source', () => {
    expect([...DISPOSITION_KINDS]).toStrictEqual(['builds_on', 'refutes']);
    expect(DispositionKind.literals).toStrictEqual([...DISPOSITION_KINDS]);
  });

  it('accepts a well-formed extractor output with local finding keys', () => {
    const output = {
      narrative: 'The interval landed the schema.',
      findings: [
        {
          key: 'a',
          type: 'decision' as const,
          text: 'Chose composite foreign keys.',
          evidence: [{ sessionId, activityIntervalOrdinal: 0, turnOrdinal: 4 }],
        },
        { key: 'b', type: 'follow_up' as const, text: 'Regenerate the snapshot.', evidence: [] },
      ],
      dispositions: [
        // same-record edge (local key target)
        { kind: 'builds_on' as const, fromKey: 'b', toKey: 'a' },
        // cross-record edge (persisted finding UUID target)
        { kind: 'refutes' as const, fromKey: 'a', toFindingId: findingB },
      ],
    };

    expect(Either.isRight(Schema.decodeUnknownEither(ConsolidationOutput)(output))).toBe(true);
  });

  it('requires a non-empty local key on an output finding', () => {
    const result = Schema.decodeUnknownEither(OutputFinding)({
      key: '',
      type: 'decision',
      text: 'nope',
      evidence: [],
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it('rejects an output disposition that names neither a local key nor a finding id', () => {
    const result = Schema.decodeUnknownEither(OutputDisposition)({
      kind: 'builds_on',
      fromKey: 'a',
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it('rejects an output disposition whose finding-id target is not a uuid', () => {
    const result = Schema.decodeUnknownEither(OutputDisposition)({
      kind: 'builds_on',
      fromKey: 'a',
      toFindingId: 'not-a-uuid',
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it('allows evidence pointers that name only a session', () => {
    expect(Schema.decodeUnknownSync(EvidencePointer)({ sessionId })).toStrictEqual({ sessionId });
  });

  it('rejects an unknown finding type', () => {
    const result = Schema.decodeUnknownEither(OutputFinding)({
      key: 'a',
      type: 'speculation',
      text: 'nope',
      evidence: [],
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it('rejects an empty narrative', () => {
    const result = Schema.decodeUnknownEither(ConsolidationOutput)({
      narrative: '',
      findings: [],
      dispositions: [],
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it('rejects a negative turn ordinal', () => {
    const result = Schema.decodeUnknownEither(EvidencePointer)({ sessionId, turnOrdinal: -1 });
    expect(Either.isLeft(result)).toBe(true);
  });

  it('carries the system envelope on a persisted record with UUID finding ids', () => {
    const record = Schema.decodeUnknownSync(ConsolidationRecord)({
      id: '44444444-4444-4444-8444-444444444444',
      workspaceId: '55555555-5555-4555-8555-555555555555',
      sessionId,
      activityIntervalId: '66666666-6666-4666-8666-666666666666',
      narrative: 'done',
      findings: [{ id: findingA, type: 'decision', text: 'persisted', evidence: [] }],
      dispositions: [{ kind: 'builds_on', fromFindingId: findingA, toFindingId: findingB }],
      modelId: 'test-model',
      authPath: 'oauth',
      createdAt: new Date('2026-07-04T00:00:00Z'),
    });
    expect(record.modelId).toBe('test-model');
    expect(record.authPath).toBe('oauth');
    expect(record.findings[0]?.id).toBe(findingA);
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  it('rejects a persisted disposition with a non-uuid finding reference', () => {
    const result = Schema.decodeUnknownEither(Disposition)({
      kind: 'refutes',
      fromFindingId: findingA,
      toFindingId: 'not-a-uuid',
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it('rejects a persisted finding without a UUID id', () => {
    const result = Schema.decodeUnknownEither(Finding)({
      id: 'local-key',
      type: 'decision',
      text: 'nope',
      evidence: [],
    });
    expect(Either.isLeft(result)).toBe(true);
  });
});
