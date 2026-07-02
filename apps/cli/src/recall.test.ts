import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  RecallContextExpansion,
  RecallContextExpansionInput,
  RecallSearchInput,
  RecallSearchResult,
} from '@saga/db';
import { describe, expect, it } from 'vitest';

import { BINDING_FILE_NAME, writeBindingFile } from './init.js';
import { resolveRecallSearchEmbedding, runRecallCommand } from './recall.js';

const renderOptions = {
  ascii: true,
  color: 'never',
  format: 'json',
  isTty: false,
} as const;

describe('runRecallCommand', () => {
  it('searches recall with filters and renders grouped records plus ids', async () => {
    const projectRoot = boundProject();
    let capturedInput: RecallSearchInput | undefined;

    const records = await runRecallCommand(
      [
        'search',
        'lexical',
        'recall',
        '--limit',
        '5',
        '--session',
        'session-id',
        '--activity',
        'activity-id',
        '--raw',
        'raw-record-id',
        '--min-trigram',
        '0.2',
        '--workspace',
        'workspace-override',
        '--no-embeddings',
      ],
      {
        ...renderOptions,
        format: 'records',
      },
      {
        cwd: projectRoot,
        searchRecall: async (input) => {
          capturedInput = input;
          return recallSearchResult();
        },
      },
    );

    expect(capturedInput).toMatchObject({
      activityIntervalId: 'activity-id',
      limit: 5,
      minTrigramScore: 0.2,
      query: 'lexical recall',
      rawSessionRecordId: 'raw-record-id',
      sessionId: 'session-id',
      workspaceId: 'workspace-override',
    });
    expect(capturedInput?.queryEmbedding).toBeUndefined();
    expect(records).toContain('Recall Search');
    expect(records).toContain('lexical (disabled-by-flag)');
    expect(records).toContain('Session');
    expect(records).toContain('Activity Interval 0');
    expect(records).toContain('Match 1');
    expect(records).toContain('segment-id');
    expect(records).toContain('scores');
    expect(records).toContain('[local-path-redacted]');
    expect(records).toContain('raw provenance');
    expect(records).toContain('source type');
    expect(records).not.toContain('raw transcript body');
    expect(records).not.toContain('source locator');
    expect(records).not.toContain('file:///tmp/session.jsonl');
    expect(records).not.toContain('file:///Users/example/.codex/transcripts/session.jsonl');
    expect(records).not.toContain('/Users/example/.codex/transcripts/session.jsonl');
    expect(records).not.toContain('projectRoot');
    expect(records).not.toContain('/work/saga');

    const ids = await runRecallCommand(
      ['search', 'lexical recall', '--no-embeddings'],
      {
        ...renderOptions,
        format: 'ids',
      },
      {
        cwd: projectRoot,
        searchRecall: async () => recallSearchResult(),
      },
    );
    expect(ids).toBe('segment-id');
  });

  it('passes an available query embedding to recall search and reports vector mode', async () => {
    const projectRoot = boundProject();
    let capturedInput: RecallSearchInput | undefined;

    const output = await runRecallCommand(['search', 'semantic', 'needle'], renderOptions, {
      cwd: projectRoot,
      resolveQueryEmbedding: async (query) => {
        expect(query).toBe('semantic needle');
        return {
          posture: { mode: 'vector' },
          queryEmbedding: {
            dimensions: 3,
            model: 'test-embedding',
            provider: 'openai',
            vector: [1, 0, 0],
          },
        };
      },
      searchRecall: async (input) => {
        capturedInput = input;
        return recallSearchResult({
          scores: {
            combined: 0.9,
            lexical: 0,
            trigram: 0,
            vector: 0.9,
          },
        });
      },
    });

    expect(capturedInput?.queryEmbedding).toMatchObject({
      dimensions: 3,
      model: 'test-embedding',
      provider: 'openai',
      vector: [1, 0, 0],
    });
    expect(JSON.parse(output)).toMatchObject({
      search: { mode: 'vector' },
    });
  });

  it('does not pass a query embedding when the resolved posture is degraded', async () => {
    const projectRoot = boundProject();
    let capturedInput: RecallSearchInput | undefined;

    const output = await runRecallCommand(
      ['search', 'semantic', 'needle'],
      { ...renderOptions, format: 'records' },
      {
        cwd: projectRoot,
        resolveQueryEmbedding: async () => ({
          posture: {
            detail: 'OpenAI embeddings request failed with status 500',
            mode: 'degraded',
            reason: 'embedding-error',
          },
        }),
        searchRecall: async (input) => {
          capturedInput = input;
          return recallSearchResult();
        },
      },
    );

    expect(capturedInput?.queryEmbedding).toBeUndefined();
    expect(output).toContain('degraded (embedding-error)');
  });

  it('reports a not-attempted lexical posture when only searchRecall is injected', async () => {
    const projectRoot = boundProject();

    const output = await runRecallCommand(['search', 'lexical'], renderOptions, {
      cwd: projectRoot,
      searchRecall: async (input) => {
        expect(input.queryEmbedding).toBeUndefined();
        return recallSearchResult();
      },
    });

    expect(JSON.parse(output)).toMatchObject({
      search: {
        detail: 'embedding resolution not attempted',
        mode: 'lexical',
        reason: 'not-attempted',
      },
    });
  });

  it('carries the search posture in structured output for --no-embeddings', async () => {
    const projectRoot = boundProject();

    const output = await runRecallCommand(['search', 'lexical', '--no-embeddings'], renderOptions, {
      cwd: projectRoot,
      searchRecall: async () => recallSearchResult(),
    });

    expect(JSON.parse(output)).toMatchObject({
      search: {
        mode: 'lexical',
        reason: 'disabled-by-flag',
      },
    });
  });

  it('shows expanded context around a segment with provenance', async () => {
    const projectRoot = boundProject();
    const output = await runRecallCommand(
      ['show', 'segment-id', '--before', '1', '--after', '3'],
      {
        ...renderOptions,
        format: 'records',
      },
      {
        cwd: projectRoot,
        expandContext: async (input) => {
          expect(input).toStrictEqual({
            afterTurns: 3,
            beforeTurns: 1,
            segmentId: 'segment-id',
            windowTurns: undefined,
            workspaceId: 'workspace-id',
          });
          return recallContextExpansion();
        },
      },
    );

    expect(output).toContain('Recall Context');
    expect(output).toContain('Session');
    expect(output).toContain('Raw Session Record');
    expect(output).toContain('Turn 0');
    expect(output).toContain('Segment 0 anchor');
    expect(output).toContain('1 turns before / 3 turns after');
    expect(output).toContain('provenance');
    expect(output).toContain('expanded segment text');
    expect(output).toContain('[local-path-redacted]');
    expect(output).not.toContain('raw transcript body');
    expect(output).not.toContain('file:///tmp/session.jsonl');
    expect(output).not.toContain('file:///Users/example/.codex/transcripts/session.jsonl');
    expect(output).not.toContain('/Users/example/.codex/transcripts/session.jsonl');
    expect(output).not.toContain('projectRoot');
    expect(output).not.toContain('/work/saga');
    // A clean expansion renders no Warnings block.
    expect(output).not.toContain('Warnings');
  });

  it('renders a Warnings block when expansion content is withheld or redacted', async () => {
    const projectRoot = boundProject();
    const output = await runRecallCommand(
      ['show', 'segment-id'],
      {
        ...renderOptions,
        format: 'records',
      },
      {
        cwd: projectRoot,
        expandContext: async () => ({
          ...recallContextExpansion(),
          warnings: [
            {
              detail:
                'The anchor raw session record was hard-redacted (ADR 0034); expansion shows the scrubbed content.',
              kind: 'hard_redacted',
              scope: 'record',
            },
            {
              detail: 'Turn payload omitted (secret); 1 segment(s) withheld.',
              kind: 'skipped_content',
              scope: 'turn',
              turnId: 'turn-id',
            },
          ],
        }),
      },
    );

    expect(output).toContain('Warnings');
    expect(output).toContain('hard_redacted');
    expect(output).toContain('skipped_content');
    expect(output).toContain('hard-redacted (ADR 0034)');
    expect(output).toContain('(turn turn-id)');
  });

  it('lets specific context window flags override each side independently', async () => {
    const projectRoot = boundProject();
    const cases = [
      {
        args: ['show', 'segment-id', '--window', '5'],
        expected: { segmentId: 'segment-id', windowTurns: 5, workspaceId: 'workspace-id' },
      },
      {
        args: ['show', 'segment-id', '--window', '5', '--before', '1'],
        expected: {
          afterTurns: undefined,
          beforeTurns: 1,
          segmentId: 'segment-id',
          windowTurns: 5,
          workspaceId: 'workspace-id',
        },
      },
      {
        args: ['show', 'segment-id', '--window', '5', '--after', '0'],
        expected: {
          afterTurns: 0,
          beforeTurns: undefined,
          segmentId: 'segment-id',
          windowTurns: 5,
          workspaceId: 'workspace-id',
        },
      },
    ] as const;

    for (const entry of cases) {
      let capturedInput: RecallContextExpansionInput | undefined;
      await runRecallCommand(entry.args, renderOptions, {
        cwd: projectRoot,
        expandContext: async (input) => {
          capturedInput = input;
          return recallContextExpansion();
        },
      });
      expect(capturedInput).toStrictEqual(entry.expected);
    }
  });

  it('renders structured JSON for expanded context', async () => {
    const projectRoot = boundProject();
    const output = await runRecallCommand(['show', 'segment-id', '--window', '0'], renderOptions, {
      cwd: projectRoot,
      expandContext: async (input) => {
        expect(input.windowTurns).toBe(0);
        return recallContextExpansion();
      },
    });

    expect(JSON.parse(output)).toMatchObject({
      anchor: {
        segment: {
          id: 'segment-id',
          snippet: 'lexical recall matched snippet from [local-path-redacted]',
        },
      },
      rawSessionRecord: {
        provenance: {
          importedBy: 'fixture',
        },
      },
      session: {
        provenance: {
          source: 'fixture',
        },
      },
    });
    expect(output).toContain('[local-path-redacted]');
    expect(output).not.toContain('file:///Users/example/.codex/transcripts/session.jsonl');
    expect(output).not.toContain('/Users/example/.codex/transcripts/session.jsonl');
  });

  it('redacts local paths from structured recall search segment snippets', async () => {
    const projectRoot = boundProject();
    const output = await runRecallCommand(['search', 'lexical', '--no-embeddings'], renderOptions, {
      cwd: projectRoot,
      searchRecall: async () => recallSearchResult(),
    });

    expect(JSON.parse(output)).toMatchObject({
      sessions: [
        {
          matches: [
            {
              snippet: 'lexical recall matched snippet from [local-path-redacted]',
            },
          ],
        },
      ],
    });
    expect(output).toContain('[local-path-redacted]');
    expect(output).not.toContain('file:///Users/example/.codex/transcripts/session.jsonl');
    expect(output).not.toContain('/Users/example/.codex/transcripts/session.jsonl');
  });

  it('does not backfill host into a no-host binding', async () => {
    const projectRoot = boundProjectWithoutHost();
    const before = readFileSync(join(projectRoot, BINDING_FILE_NAME), 'utf8');

    await runRecallCommand(['search', 'lexical', '--no-embeddings'], renderOptions, {
      cwd: projectRoot,
      searchRecall: async (input) => {
        expect(input.workspaceId).toBe('workspace-id');
        return recallSearchResult();
      },
    });

    expect(readFileSync(join(projectRoot, BINDING_FILE_NAME), 'utf8')).toBe(before);
  });
});

function recordingFetch(): { calls: number; impl: typeof fetch } {
  const state = { calls: 0 };
  const impl = (async () => {
    state.calls += 1;
    return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }, { status: 200 });
  }) as unknown as typeof fetch;
  return {
    get calls() {
      return state.calls;
    },
    impl,
  };
}

describe('resolveRecallSearchEmbedding', () => {
  const availableAuthOptions = {
    env: {},
    homeDir: '/tmp/saga-recall-available-codex',
    readFile: () => JSON.stringify({ OPENAI_API_KEY: 'sk-recall-secret' }),
  };
  const disabledPolicyOptions = {
    env: {},
    homeDir: '/tmp/saga-recall-disabled-home',
    readFile: () => JSON.stringify({ embeddings: { remote: 'disabled' } }),
  };
  const enabledPolicyOptions = {
    env: {},
    homeDir: '/tmp/saga-recall-enabled-home',
    readFile: () => JSON.stringify({ embeddings: { remote: 'enabled' } }),
  };

  it('never calls the remote provider when remote embeddings are disabled by policy', async () => {
    const fetchSpy = recordingFetch();

    const resolved = await resolveRecallSearchEmbedding('lexical recall', {
      // Valid credentials are present; only policy should keep the query text local.
      authOptions: availableAuthOptions,
      fetchImpl: fetchSpy.impl,
      policyOptions: disabledPolicyOptions,
    });

    expect(resolved.queryEmbedding).toBeUndefined();
    expect(resolved.posture).toMatchObject({
      mode: 'lexical',
      reason: 'disabled-by-policy',
    });
    expect(resolved.posture.detail).toContain('disabled by installation standard');
    expect(fetchSpy.calls).toBe(0);
  });

  it('degrades without a remote call when credentials are unavailable', async () => {
    const fetchSpy = recordingFetch();

    const resolved = await resolveRecallSearchEmbedding('lexical recall', {
      authOptions: {
        env: {},
        homeDir: '/tmp/saga-recall-missing-codex',
        readFile: () => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
      },
      fetchImpl: fetchSpy.impl,
      policyOptions: enabledPolicyOptions,
    });

    expect(resolved.queryEmbedding).toBeUndefined();
    expect(resolved.posture).toMatchObject({
      mode: 'degraded',
      reason: 'missing-auth-file',
    });
    expect(fetchSpy.calls).toBe(0);
  });

  it('embeds the query against the remote provider when policy enabled and credentials available', async () => {
    const fetchSpy = recordingFetch();

    const resolved = await resolveRecallSearchEmbedding('lexical recall', {
      authOptions: availableAuthOptions,
      fetchImpl: fetchSpy.impl,
      policyOptions: enabledPolicyOptions,
    });

    expect(fetchSpy.calls).toBe(1);
    expect(resolved.posture).toStrictEqual({ mode: 'vector' });
    expect(resolved.queryEmbedding).toMatchObject({
      provider: 'openai',
      vector: [0.1, 0.2, 0.3],
    });
  });

  it('degrades with embedding-error when the embedding request fails', async () => {
    const failingFetch = (async () =>
      Response.json({ error: 'boom' }, { status: 500 })) as unknown as typeof fetch;

    const resolved = await resolveRecallSearchEmbedding('lexical recall', {
      authOptions: availableAuthOptions,
      fetchImpl: failingFetch,
      policyOptions: enabledPolicyOptions,
    });

    expect(resolved.queryEmbedding).toBeUndefined();
    expect(resolved.posture).toMatchObject({
      mode: 'degraded',
      reason: 'embedding-error',
    });
    expect(resolved.posture.detail).not.toContain('sk-recall-secret');
  });
});

function boundProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saga-recall-'));
  writeBindingFile(projectRoot, {
    host: {
      generatedAt: '2026-06-22T00:00:00.000Z',
      id: 'host-id',
      label: 'test-host',
    },
    project: {
      gitRemote: undefined,
      root: projectRoot,
    },
    schemaVersion: 1,
    service: {
      databaseUrl: 'env:DATABASE_URL',
    },
    sourceBinding: {
      id: 'source-id',
    },
    workspace: {
      handle: 'saga',
      id: 'workspace-id',
    },
  });
  return projectRoot;
}

function boundProjectWithoutHost(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saga-recall-no-host-'));
  writeFileSync(
    join(projectRoot, BINDING_FILE_NAME),
    `${JSON.stringify(
      {
        project: {
          root: projectRoot,
        },
        schemaVersion: 1,
        service: {
          databaseUrl: 'env:DATABASE_URL',
        },
        sourceBinding: {
          id: 'source-id',
        },
        workspace: {
          handle: 'saga',
          id: 'workspace-id',
        },
      },
      null,
      2,
    )}\n`,
  );
  return projectRoot;
}

function recallSearchResult(
  input: {
    scores?: RecallSearchResult['sessions'][number]['matches'][number]['scores'];
  } = {},
): RecallSearchResult {
  const now = new Date('2026-06-22T10:00:00.000Z');
  const match = {
    activityInterval: activityInterval(now),
    combinedScore: input.scores?.combined ?? 0.8,
    rawSessionRecord: rawSessionRecord(now),
    scores: input.scores ?? {
      combined: 0.8,
      lexical: 0.6,
      trigram: 0.4,
    },
    segment: segmentPointer(),
    session: session(now),
    snippet:
      'lexical recall matched snippet from file:///Users/example/.codex/transcripts/session.jsonl',
    sourceBinding: sourceBinding(),
    turn: turnPointer(),
  };
  return {
    intervals: [
      {
        activityInterval: activityInterval(now),
        matches: [match],
        sessionId: 'session-id',
      },
    ],
    matchCount: 1,
    query: 'lexical recall',
    searchedAt: now.toISOString(),
    sessions: [
      {
        activityIntervals: [
          {
            activityInterval: activityInterval(now),
            matches: [match],
            sessionId: 'session-id',
          },
        ],
        matches: [match],
        session: session(now),
      },
    ],
    workspaceId: 'workspace-id',
  };
}

function recallContextExpansion(): RecallContextExpansion {
  const now = new Date('2026-06-22T10:00:00.000Z');
  return {
    activityInterval: activityInterval(now),
    anchor: {
      segment: segmentPointer(),
      turn: turnPointer(),
    },
    rawSessionRecord: rawSessionRecord(now),
    session: session(now),
    sourceBinding: sourceBinding(),
    turns: [
      {
        ...turnPointer(),
        contentParts: [{ text: 'expanded turn text', type: 'text' }],
        endedAt: null,
        metadata: {
          cwd: '/work/saga',
        },
        rawEventIds: ['raw-event-id'],
        rawSpan: {
          line: 1,
        },
        segments: [
          {
            ...segmentPointer(),
            metadata: {
              source: 'fixture',
            },
            searchText:
              'expanded segment text from /Users/example/.codex/transcripts/session.jsonl and file:///Users/example/.codex/transcripts/session.jsonl',
          },
        ],
        startedAt: now,
      },
    ],
    afterTurns: 3,
    beforeTurns: 1,
    warnings: [],
    windowTurns: 3,
    workspaceId: 'workspace-id',
  };
}

function session(now: Date): RecallSearchResult['sessions'][number]['session'] {
  return {
    authorUser: {
      displayName: 'Drew',
      externalSubject: 'host-id',
      handle: 'drew',
      id: 'user-id',
      identitySource: 'host',
      metadata: {
        hostId: 'host-id',
      },
    },
    endedAt: null,
    harness: 'codex',
    harnessSessionId: 'codex-session-1',
    id: 'session-id',
    lastActivityAt: now,
    metadata: {
      latestRawSessionRecordId: 'raw-record-id',
    },
    model: 'gpt-5-codex',
    provenance: {
      source: 'fixture',
    },
    sourceBindingId: 'source-binding-id',
    sourceLocator: 'file:///tmp/session.jsonl',
    startedAt: now,
    status: 'active',
    title: 'Recall fixture',
    workspaceId: 'workspace-id',
  };
}

function sourceBinding(): RecallSearchResult['sessions'][number]['matches'][number]['sourceBinding'] {
  return {
    config: {
      projectRoot: '/work/saga',
    },
    displayName: 'Codex on test-host',
    enabled: true,
    id: 'source-binding-id',
    sourceType: 'codex',
    sourceUri: 'codex://host/host-id',
  };
}

function activityInterval(now: Date): RecallSearchResult['intervals'][number]['activityInterval'] {
  return {
    endedAt: null,
    id: 'activity-id',
    metadata: {
      cwd: '/work/saga',
    },
    ordinal: 0,
    sessionId: 'session-id',
    settledAt: null,
    settlementReason: null,
    startedAt: now,
    status: 'active',
  };
}

function rawSessionRecord(
  now: Date,
): RecallSearchResult['sessions'][number]['matches'][number]['rawSessionRecord'] {
  return {
    capturedAt: now,
    contentHash: 'sha256:test',
    contentType: 'jsonl',
    harness: 'codex',
    harnessSessionId: 'codex-session-1',
    id: 'raw-record-id',
    isActive: true,
    metadata: {
      contentBytes: 42,
    },
    provenance: {
      importedBy: 'fixture',
    },
    snapshotOrdinal: 0,
    sourceLocator: 'file:///tmp/session.jsonl',
    status: 'captured',
  };
}

function turnPointer(): RecallSearchResult['sessions'][number]['matches'][number]['turn'] {
  return {
    actorKind: 'host_user',
    actorLabel: 'drew',
    harnessTurnId: 'turn-1',
    id: 'turn-id',
    model: 'gpt-5-codex',
    ordinal: 0,
    role: 'user',
  };
}

function segmentPointer(): RecallSearchResult['sessions'][number]['matches'][number]['segment'] {
  return {
    charEnd: 24,
    charStart: 0,
    id: 'segment-id',
    ordinal: 0,
    segmentKind: 'turn',
    snippet: 'lexical recall matched snippet from /Users/example/.codex/transcripts/session.jsonl',
    tokenEnd: 4,
    tokenStart: 0,
  };
}
