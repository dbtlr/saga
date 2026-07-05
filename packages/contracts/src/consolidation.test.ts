import { Either, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import {
  ConsolidationOutput,
  ConsolidationRecord,
  Disposition,
  EvidencePointer,
  Finding,
  FindingType,
} from './consolidation.js';

const findingA = '11111111-1111-4111-8111-111111111111';
const findingB = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';

describe('consolidation contract', () => {
  it('enumerates exactly the four finding types', () => {
    expect(FindingType.literals).toEqual([
      'decision',
      'follow_up',
      'deviation_or_correction',
      'candidate_learning',
    ]);
  });

  it('accepts a well-formed extractor output', () => {
    const output = {
      narrative: 'The interval landed the schema.',
      findings: [
        {
          id: findingA,
          type: 'decision' as const,
          text: 'Chose composite foreign keys.',
          evidence: [{ sessionId, activityIntervalOrdinal: 0, turnOrdinal: 4 }],
        },
      ],
      dispositions: [{ kind: 'builds_on' as const, fromFindingId: findingA, toFindingId: findingB }],
    };

    expect(Schema.decodeUnknownEither(ConsolidationOutput)(output)._tag).toBe('Right');
  });

  it('allows evidence pointers that name only a session', () => {
    expect(Schema.decodeUnknownSync(EvidencePointer)({ sessionId })).toEqual({ sessionId });
  });

  it('rejects an unknown finding type', () => {
    const result = Schema.decodeUnknownEither(Finding)({
      id: findingA,
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

  it('rejects a disposition with a non-uuid finding reference', () => {
    const result = Schema.decodeUnknownEither(Disposition)({
      kind: 'refutes',
      fromFindingId: findingA,
      toFindingId: 'not-a-uuid',
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it('carries the system envelope on a persisted record', () => {
    const record = Schema.decodeUnknownSync(ConsolidationRecord)({
      id: '44444444-4444-4444-8444-444444444444',
      workspaceId: '55555555-5555-4555-8555-555555555555',
      sessionId,
      activityIntervalId: '66666666-6666-4666-8666-666666666666',
      narrative: 'done',
      findings: [],
      dispositions: [],
      modelId: 'test-model',
      authPath: 'oauth',
      createdAt: new Date('2026-07-04T00:00:00Z'),
    });
    expect(record.modelId).toBe('test-model');
    expect(record.authPath).toBe('oauth');
    expect(record.createdAt).toBeInstanceOf(Date);
  });
});
