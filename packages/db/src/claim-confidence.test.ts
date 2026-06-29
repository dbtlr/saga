import { describe, expect, test } from 'vitest';
import { scoreClaimConfidence } from './claim.js';

describe('scoreClaimConfidence', () => {
  test('raises confidence for repeated, recent, explicit trusted human support', () => {
    const result = scoreClaimConfidence({
      actorId: 'control-plane',
      baseConfidence: 0.72,
      claimKind: 'decision',
      eventType: 'supported',
      now: '2026-06-20T00:00:00.000Z',
      occurredAt: '2026-06-19T20:00:00.000Z',
      priorContradictions: 0,
      priorEvents: 2,
      sourceType: 'saga',
      trustLevel: 'trusted',
    });

    expect(result.score).toBe(1);
    expect(result.inputs).toMatchObject({
      actorAuthority: 0.08,
      base: 0.72,
      explicitness: 0.08,
      humanPromotion: 0.15,
      recurrence: 0.08,
      recency: 0.03,
      sourceQuality: 0.13,
    });
  });

  test('lowers confidence for contradicted old claims with prior contradictions', () => {
    const result = scoreClaimConfidence({
      actorId: 'codex',
      baseConfidence: 0.72,
      claimKind: 'decision',
      eventType: 'contradicted',
      now: '2026-06-20T00:00:00.000Z',
      occurredAt: '2025-12-01T00:00:00.000Z',
      priorContradictions: 2,
      priorEvents: 3,
      sourceType: 'codex',
      trustLevel: 'raw',
    });

    expect(result.score).toBe(0.4);
    expect(result.inputs).toMatchObject({
      contradiction: -0.38,
      recurrence: 0.12,
      recency: -0.08,
      sourceQuality: 0.01,
    });
  });
});
