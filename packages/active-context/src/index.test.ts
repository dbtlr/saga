import { describe, expect, test } from 'vitest';
import { compileActiveContext, renderActiveContextMarkdown } from './index.js';

describe('compileActiveContext', () => {
  test('compiles profile, current claims, and recent activity', () => {
    const document = compileActiveContext({
      claims: [
        {
          claimKey: 'low',
          claimKind: 'preference',
          claimText: 'Use terse output.',
          confidence: 0.6,
          observedAt: '2026-06-19T20:00:00.000Z',
          state: 'candidate',
        },
        {
          claimKey: 'high',
          claimKind: 'decision',
          claimText: 'Compile Active Context from projected claims.',
          confidence: 0.9,
          observedAt: '2026-06-19T20:01:00.000Z',
          state: 'supported',
        },
        {
          claimKey: 'rejected',
          claimKind: 'observation',
          claimText: 'Ignore this.',
          confidence: 0.99,
          observedAt: '2026-06-19T20:02:00.000Z',
          state: 'rejected',
        },
        {
          claimKey: 'superseded',
          claimKind: 'decision',
          claimText: 'This was replaced.',
          confidence: 0.98,
          observedAt: '2026-06-19T20:02:30.000Z',
          state: 'superseded',
        },
        {
          claimKey: 'decayed',
          claimKind: 'observation',
          claimText: 'This may be stale.',
          confidence: 0.5,
          observedAt: '2026-06-19T20:02:45.000Z',
          state: 'decayed',
        },
      ],
      contextIndex: [
        {
          connector: 'vault',
          description: 'Seed architecture note.',
          externalId: 'notes/saga-v2-architecture-seed.md',
          importance: 0.9,
          includePolicy: 'always',
          key: 'architecture-seed',
          sagaLink: 'saga:context/architecture-seed',
          title: 'Architecture Seed',
        },
        {
          connector: 'vault',
          externalId: 'notes/rarely-needed.md',
          importance: 1,
          includePolicy: 'when_relevant',
          key: 'rarely-needed',
          sagaLink: 'saga:context/rarely-needed',
          title: 'Rarely Needed',
        },
      ],
      generatedAt: '2026-06-19T21:00:00.000Z',
      recentEvents: [
        {
          eventType: 'codex.UserPromptSubmit',
          occurredAt: '2026-06-19T20:03:00.000Z',
          sessionId: 'session-id',
          sourceType: 'codex',
        },
      ],
      workspace: {
        handle: 'saga',
        id: 'workspace-id',
        profile: {
          summary: 'Postgres-backed workspace memory.',
        },
      },
    });

    expect(document.summary).toBe('Active Context for saga');
    expect(document.sections[0]?.lines).toEqual(['Postgres-backed workspace memory.']);
    expect(document.sections[1]?.lines[0]).toContain('[supported]');
    expect(document.sections[1]?.lines.join('\n')).not.toContain('Ignore this.');
    expect(document.sections[1]?.lines.join('\n')).not.toContain('This was replaced.');
    expect(document.sections[1]?.lines.join('\n')).toContain('[decayed]');
    expect(document.sections[2]?.lines[0]).toContain('saga:context/architecture-seed');
    expect(document.sections[2]?.lines.join('\n')).not.toContain('Rarely Needed');
    expect(document.sections[3]?.lines[0]).toContain('codex.UserPromptSubmit');
  });

  test('renders markdown', () => {
    const markdown = renderActiveContextMarkdown(
      compileActiveContext({
        claims: [],
        generatedAt: '2026-06-19T21:00:00.000Z',
        recentEvents: [],
        workspace: {
          handle: 'saga',
          id: 'workspace-id',
        },
      }),
    );

    expect(markdown).toContain('# Active Context for saga');
    expect(markdown).toContain('No current claims projected yet.');
  });
});
