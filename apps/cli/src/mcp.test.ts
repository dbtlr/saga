import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RecallSearchInput, RecallSearchResult } from '@saga/db';
import { describe, expect, it } from 'vitest';

import { writeBindingFile } from './init.js';
import {
  redactMcpStructuredOutput,
  redactResolvedSagaLink,
  redactSearchMemoryStructuredMatches,
  rewriteResolvedSagaLinkReferences,
  runMcpCommand,
  searchMemoryEntries,
  searchProjectSessions,
} from './mcp.js';
import type { MemorySearchEntry } from './mcp.js';

async function* chunks(text: string) {
  yield text;
}

describe('runMcpCommand', () => {
  it('responds to newline-delimited JSON-RPC requests', async () => {
    const output: string[] = [];

    await runMcpCommand(
      [],
      { ascii: true, color: 'never', format: 'records', isTty: false },
      (text) => output.push(text),
      chunks(`${JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' })}\n`),
    );

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('get_active_context');
    expect(output[0]).toContain('search_memory');
    expect(output[0]).toContain('resolve_saga_link');
    expect(output[0]).toContain('list_recent_sessions');
    expect(output[0]).toContain('search_sessions');
    expect(output[0]).toContain('get_session_context');
  });

  it('streams a response before stdin closes', async () => {
    const output: string[] = [];
    let release: (() => void) | undefined;
    async function* openStream() {
      yield `${JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' })}\n`;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }

    const running = runMcpCommand(
      [],
      { ascii: true, color: 'never', format: 'records', isTty: false },
      (text) => output.push(text),
      openStream(),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(output[0]).toContain('get_active_context');
    expect(output[0]).toContain('list_recent_sessions');
    release?.();
    await running;
  });

  it('returns JSON-RPC parse errors for malformed frames', async () => {
    const output: string[] = [];

    await runMcpCommand(
      [],
      { ascii: true, color: 'never', format: 'records', isTty: false },
      (text) => output.push(text),
      chunks('not-json\n'),
    );

    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      error: {
        code: -32700,
      },
      id: null,
      jsonrpc: '2.0',
    });
  });

  it('returns JSON-RPC invalid request errors for invalid ids', async () => {
    const output: string[] = [];

    await runMcpCommand(
      [],
      { ascii: true, color: 'never', format: 'records', isTty: false },
      (text) => output.push(text),
      chunks(`${JSON.stringify({ id: {}, jsonrpc: '2.0', method: 'tools/list' })}\n`),
    );

    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      error: {
        code: -32600,
        message: 'JSON-RPC request id must be a string, number, or null',
      },
      id: null,
      jsonrpc: '2.0',
    });
  });

  it('rejects non-integer limit and window tool arguments', async () => {
    const cases = [
      {
        arguments: { limit: 1.5, query: 'recall' },
        message: 'search_sessions limit must be a positive integer',
        name: 'search_sessions',
      },
      {
        arguments: { segmentId: 'segment-id', windowTurns: 1.5 },
        message: 'get_session_context windowTurns must be a non-negative integer',
        name: 'get_session_context',
      },
      {
        arguments: { afterTurns: 2.5, segmentId: 'segment-id' },
        message: 'get_session_context afterTurns must be a non-negative integer',
        name: 'get_session_context',
      },
      {
        arguments: { beforeTurns: 0.5, segmentId: 'segment-id' },
        message: 'get_session_context beforeTurns must be a non-negative integer',
        name: 'get_session_context',
      },
      {
        arguments: { limit: 2.5 },
        message: 'list_recent_sessions limit must be a positive integer',
        name: 'list_recent_sessions',
      },
    ] as const;

    for (const entry of cases) {
      const output: string[] = [];
      await runMcpCommand(
        [],
        { ascii: true, color: 'never', format: 'records', isTty: false },
        (text) => output.push(text),
        chunks(
          `${JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: 'tools/call',
            params: { arguments: entry.arguments, name: entry.name },
          })}\n`,
        ),
      );
      expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
        error: {
          message: entry.message,
        },
      });
    }
  });
});

describe('searchProjectSessions', () => {
  it('passes the resolved query embedding and reports vector mode', async () => {
    const projectRoot = boundMcpProject();
    let capturedInput: RecallSearchInput | undefined;

    const result = await searchProjectSessions(
      { query: 'semantic needle' },
      {
        cwd: projectRoot,
        resolveRecallEmbedding: async (query) => {
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
          return emptyRecallResult('semantic needle');
        },
      },
    );

    expect(capturedInput?.queryEmbedding).toMatchObject({
      dimensions: 3,
      model: 'test-embedding',
      provider: 'openai',
      vector: [1, 0, 0],
    });
    expect(capturedInput?.workspaceId).toBe('workspace-id');
    expect(result.markdown).toContain('- Mode: vector');
    expect(result.recall).toMatchObject({
      search: { mode: 'vector' },
    });
  });

  it('withholds the query embedding and reports a degraded posture', async () => {
    const projectRoot = boundMcpProject();
    let capturedInput: RecallSearchInput | undefined;

    const result = await searchProjectSessions(
      { query: 'semantic needle' },
      {
        cwd: projectRoot,
        resolveRecallEmbedding: async () => ({
          posture: {
            detail: 'OpenAI embeddings request failed with status 500',
            mode: 'degraded',
            reason: 'embedding-error',
          },
        }),
        searchRecall: async (input) => {
          capturedInput = input;
          return emptyRecallResult('semantic needle');
        },
      },
    );

    expect(capturedInput?.queryEmbedding).toBeUndefined();
    expect(result.markdown).toContain('- Mode: degraded (embedding-error)');
    expect(result.recall).toMatchObject({
      search: {
        detail: 'OpenAI embeddings request failed with status 500',
        mode: 'degraded',
        reason: 'embedding-error',
      },
    });
  });

  it('reports a lexical posture when a policy-disabled resolver is injected', async () => {
    const projectRoot = boundMcpProject();

    const result = await searchProjectSessions(
      { query: 'lexical recall' },
      {
        cwd: projectRoot,
        resolveRecallEmbedding: async () => ({
          posture: { mode: 'lexical', reason: 'disabled-by-policy' },
        }),
        searchRecall: async () => emptyRecallResult('lexical recall'),
      },
    );

    expect(result.markdown).toContain('- Mode: lexical (disabled-by-policy)');
    expect(result.recall).toMatchObject({
      search: { mode: 'lexical', reason: 'disabled-by-policy' },
    });
  });

  it('does not attempt embedding resolution when only searchRecall is injected', async () => {
    const projectRoot = boundMcpProject();

    const result = await searchProjectSessions(
      { query: 'lexical recall' },
      {
        cwd: projectRoot,
        searchRecall: async (input) => {
          expect(input.queryEmbedding).toBeUndefined();
          return emptyRecallResult('lexical recall');
        },
      },
    );

    expect(result.markdown).toContain('- Mode: lexical (not-attempted)');
    expect(result.recall).toMatchObject({
      search: { mode: 'lexical', reason: 'not-attempted' },
    });
  });
});

function boundMcpProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saga-mcp-search-'));
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

function emptyRecallResult(query: string): RecallSearchResult {
  return {
    intervals: [],
    matchCount: 0,
    query,
    searchedAt: '2026-06-22T10:00:00.000Z',
    sessions: [],
    workspaceId: 'workspace-id',
  };
}

describe('rewriteResolvedSagaLinkReferences', () => {
  it('rewrites resolved connector references through workspace Context Index entries', async () => {
    const rewritten = await rewriteResolvedSagaLinkReferences(
      {
        externalId: 'notes/architecture.md',
        metadata: {
          content: 'Architecture note',
          references: [
            {
              externalId: 'notes/adr.md',
              title: 'ADR',
              url: 'file:///vault/notes/adr.md',
            },
            {
              externalId: 'notes/adr.md',
              sourceBindingId: 'source-2',
              title: 'Other ADR',
              url: 'file:///other-vault/notes/adr.md',
            },
          ],
        },
        sourceBinding: {
          id: 'source-1',
          sourceType: 'norn',
          sourceUri: 'norn://workspace',
        },
      },
      [
        {
          externalId: 'notes/adr.md',
          sagaLink: 'saga:context/adr',
          sourceBinding: {
            id: 'source-1',
            sourceType: 'vault',
          },
        },
      ],
    );

    expect(rewritten.references[0]).toMatchObject({
      originalUrl: 'file:///vault/notes/adr.md',
      sagaLink: 'saga:context/adr',
      sourceBindingId: 'source-1',
      url: 'saga:context/adr',
    });
    expect(rewritten.references[1]).toStrictEqual({
      connector: 'norn',
      externalId: 'notes/adr.md',
      sourceBindingId: 'source-2',
      title: 'Other ADR',
      url: 'file:///other-vault/notes/adr.md',
    });
  });

  it('uses metadata-only retrieval by default for MCP link resolution', async () => {
    const rewritten = await rewriteResolvedSagaLinkReferences(
      {
        externalId: 'pr:12',
        metadata: {},
        sourceBinding: {
          config: {
            repositoryFullName: 'dbtlr/saga',
            token: 'secret-token',
          },
          id: 'github-source',
          sourceType: 'github',
          sourceUri: 'github://dbtlr/saga',
        },
      },
      [],
    );

    expect(rewritten).toMatchObject({
      content: '',
      evidence: {
        contentAvailable: false,
        maxContentBytes: 65536,
        source: 'metadata',
      },
      target: {
        apiUrl: 'https://api.github.com/repos/dbtlr/saga/pulls/12',
        url: 'https://github.com/dbtlr/saga/pull/12',
      },
    });
    expect(JSON.stringify(rewritten)).not.toContain('secret-token');
  });

  it('caps metadata content returned through MCP link resolution', async () => {
    const rewritten = await rewriteResolvedSagaLinkReferences(
      {
        externalId: 'notes/large.md',
        metadata: {
          content: `${'a'.repeat(65535)}éextra`,
        },
        sourceBinding: {
          id: 'vault-source',
          sourceType: 'vault',
          sourceUri: 'file:///vault',
        },
      },
      [],
    );

    expect(Buffer.byteLength(rewritten.content ?? '', 'utf8')).toBeLessThanOrEqual(65536);
    expect(rewritten.content).not.toContain('extra');
    expect(rewritten.evidence).toMatchObject({
      contentAvailable: true,
      maxContentBytes: 65536,
      source: 'metadata',
      truncated: true,
    });
  });
});

describe('redactResolvedSagaLink', () => {
  it('omits source binding config from MCP structured results', () => {
    const redacted = redactResolvedSagaLink({
      entry: {
        externalId: 'pr:12',
        key: 'review-pr',
        sagaLink: 'saga:context/review-pr',
        sourceBinding: {
          config: {
            authToken: 'secret-token',
          },
          displayName: 'GitHub',
          enabled: true,
          id: 'github-source',
          sourceType: 'github',
          sourceUri: 'github://dbtlr/saga',
        },
        title: 'Review PR',
      },
      provenance: {
        sourceBindingId: 'github-source',
      },
    });

    expect(redacted.entry.sourceBinding).toStrictEqual({
      displayName: 'GitHub',
      enabled: true,
      id: 'github-source',
      sourceType: 'github',
      sourceUri: 'github://dbtlr/saga',
    });
    expect(JSON.stringify(redacted)).not.toContain('config');
    expect(JSON.stringify(redacted)).not.toContain('secret-token');
  });
});

describe('redactMcpStructuredOutput', () => {
  it('removes unsafe locator keys and redacts local path values', () => {
    const redacted = redactMcpStructuredOutput({
      rawSessionRecord: {
        id: 'raw-1',
        metadata: {
          lifecycleEvents: [{ payload: { type: 'task_started' }, type: 'task_started' }],
          normalization: { sessionMeta: { base_instructions: 'huge harness prompt' } },
        },
        details: {
          capturedText:
            'Use /work/saga, /home/drew/work/saga, /custom-root/saga, C:\\Users\\drew\\.codex\\transcripts\\session.jsonl, and file:///tmp/saga/session.jsonl but keep https://example.com/docs/path and saga:context/workflow.',
          embedded: 'cwd=/work/saga log=/custom-root/saga/session.log',
          genericInputPath: '/custom-root/saga/session.jsonl',
          inputPath: '/Volumes/data/workspaces/saga/session.jsonl',
          linuxInputPath: '/work/saga/session.jsonl',
          nested: {
            sourceLocator: 'file:///Volumes/data/workspaces/saga/session.jsonl',
          },
          nonLocalId: 'github/dbtlr/saga',
          pseudoSchemes: 'cwd:/work/saga log:/custom-root/saga/session.log',
          referenceUrl: 'https://example.com/docs/path?target=saga',
          safeGithubUri: 'github://dbtlr/saga/pull/12',
          safeMimirUri: 'mimir://project/SGA-130',
          safeNornUri: 'norn://workspace/notes/saga',
          sagaLink: 'saga:context/workflow',
          sourceLocatorHash: 'sha256:local-path-hash',
        },
        provenance: {
          homeProjectRoot: '/home/drew/work/saga',
          projectRoot: '/Users/drew/work/saga',
          transcript:
            'loaded from file:///tmp/saga/session.jsonl cwd=/work/saga windows=C:\\Users\\drew\\.codex\\transcripts\\session.jsonl',
          windowsTranscriptPath: 'C:\\Users\\drew\\.codex\\transcripts\\session.jsonl',
        },
        sourceLocator: 'file:///Volumes/data/workspaces/saga/session.jsonl',
      },
      session: {
        id: 'session-1',
        sourceLocator: 'file:///Volumes/data/workspaces/saga/session.jsonl',
      },
      sourceBinding: {
        config: {
          token: 'secret-token',
        },
        displayName: 'Codex',
        enabled: true,
        id: 'source-1',
        sourceType: 'codex',
        sourceUri: 'codex://local',
      },
      target: {
        apiUrl: 'https://api.github.com/repos/dbtlr/saga/pulls/12',
        sourceUri: 'codex://local/session/abc',
      },
    });

    expect(redacted).toMatchObject({
      rawSessionRecord: {
        id: 'raw-1',
        details: {
          capturedText:
            'Use [local-path-redacted], [local-path-redacted], [local-path-redacted], [local-path-redacted], and [local-path-redacted] but keep https://example.com/docs/path and saga:context/workflow.',
          embedded: 'cwd=[local-path-redacted] log=[local-path-redacted]',
          genericInputPath: '[local-path-redacted]',
          inputPath: '[local-path-redacted]',
          linuxInputPath: '[local-path-redacted]',
          nested: {},
          nonLocalId: 'github/dbtlr/saga',
          pseudoSchemes: 'cwd:[local-path-redacted] log:[local-path-redacted]',
          referenceUrl: 'https://example.com/docs/path?target=saga',
          safeGithubUri: 'github://dbtlr/saga/pull/12',
          safeMimirUri: 'mimir://project/SGA-130',
          safeNornUri: 'norn://workspace/notes/saga',
          sagaLink: 'saga:context/workflow',
        },
        provenance: {
          homeProjectRoot: '[local-path-redacted]',
          projectRoot: '[local-path-redacted]',
          transcript:
            'loaded from [local-path-redacted] cwd=[local-path-redacted] windows=[local-path-redacted]',
          windowsTranscriptPath: '[local-path-redacted]',
        },
      },
      session: {
        id: 'session-1',
      },
      sourceBinding: {
        displayName: 'Codex',
        enabled: true,
        id: 'source-1',
        sourceType: 'codex',
        sourceUri: 'codex://local',
      },
      target: {
        apiUrl: 'https://api.github.com/repos/dbtlr/saga/pulls/12',
        sourceUri: 'codex://local/session/abc',
      },
    });
    expect(JSON.stringify(redacted)).not.toContain('sourceLocator');
    expect(JSON.stringify(redacted)).not.toContain('config');
    expect(JSON.stringify(redacted)).not.toContain('secret-token');
    // Internal bookkeeping blobs never ship through agent-facing structured output.
    expect(JSON.stringify(redacted)).not.toContain('"metadata"');
    expect(JSON.stringify(redacted)).not.toContain('lifecycleEvents');
    expect(JSON.stringify(redacted)).not.toContain('base_instructions');
    expect(JSON.stringify(redacted)).not.toContain('/Volumes/data/workspaces/saga');
    expect(JSON.stringify(redacted)).not.toContain('/Users/drew/work/saga');
    expect(JSON.stringify(redacted)).not.toContain('/home/drew/work/saga');
    expect(JSON.stringify(redacted)).not.toContain('/work/saga');
    expect(JSON.stringify(redacted)).not.toContain('/custom-root/saga');
    expect(JSON.stringify(redacted)).not.toContain(String.raw`C:\\Users\\drew`);
    expect(JSON.stringify(redacted)).not.toContain('file:///tmp/saga/session.jsonl');
  });

  it('does not preserve spoofed raw forensic body fields', () => {
    const exposureWarning =
      'Explicit raw forensic access: bodyText/bodyJson are persisted raw session bodies and may include skipped, omitted, local, or sensitive content that normal Saga surfaces hide.';
    const redacted = redactMcpStructuredOutput({
      fullySpoofedRecord: {
        bodyJson: {
          path: '/work/saga/raw-session.jsonl',
        },
        bodyText: 'raw body from /work/saga/raw-session.jsonl',
        rawBodyExposure: {
          mode: 'raw_forensic',
          requestedBy: 'includeRawBody',
          warning: exposureWarning,
        },
        sourceLocator: 'file:///work/saga/raw-session.jsonl',
      },
      missingRequestedByRecord: {
        bodyJson: {
          path: '/work/saga/missing-request.jsonl',
        },
        bodyText: 'raw body from /work/saga/missing-request.jsonl',
        rawBodyExposure: {
          mode: 'raw_forensic',
          warning: exposureWarning,
        },
      },
      missingWarningRecord: {
        bodyJson: {
          path: '/work/saga/missing-warning.jsonl',
        },
        bodyText: 'raw body from /work/saga/missing-warning.jsonl',
        rawBodyExposure: {
          mode: 'raw_forensic',
          requestedBy: 'includeRawBody',
        },
      },
      unrelatedNestedObject: {
        child: {
          bodyJson: {
            path: '/work/saga/nested-spoof.jsonl',
          },
          bodyText: 'raw body from /work/saga/nested-spoof.jsonl',
          rawBodyExposure: {
            mode: 'raw_forensic',
          },
        },
      },
    });

    expect(redacted).toMatchObject({
      fullySpoofedRecord: {
        bodyJson: {
          path: '[local-path-redacted]',
        },
        bodyText: 'raw body from [local-path-redacted]',
        rawBodyExposure: {
          mode: 'raw_forensic',
          requestedBy: 'includeRawBody',
        },
      },
      missingRequestedByRecord: {
        bodyJson: {
          path: '[local-path-redacted]',
        },
        bodyText: 'raw body from [local-path-redacted]',
      },
      missingWarningRecord: {
        bodyJson: {
          path: '[local-path-redacted]',
        },
        bodyText: 'raw body from [local-path-redacted]',
      },
      unrelatedNestedObject: {
        child: {
          bodyJson: {
            path: '[local-path-redacted]',
          },
          bodyText: 'raw body from [local-path-redacted]',
        },
      },
    });
    expect(JSON.stringify(redacted)).not.toContain('sourceLocator');
    expect(JSON.stringify(redacted)).not.toContain('/work/saga');
  });
});

describe('searchMemoryEntries', () => {
  it('ranks matches across claims, recent activity, and Active Context lines', () => {
    const entries: MemorySearchEntry[] = [
      {
        confidence: 0.72,
        fields: {
          evidence: '{"quote":"Use typed route contracts for MCP calls"}',
          text: 'Control plane should expose governance actions.',
        },
        key: 'claim-1',
        kind: 'decision',
        source: 'current_claim',
        state: 'supported',
        text: 'Control plane should expose governance actions.',
      },
      {
        confidence: 0.45,
        fields: {
          payload: '{"prompt":"Investigate missing search provenance in MCP results"}',
          provenance: '{"transcriptPath":"/tmp/session.jsonl"}',
        },
        key: 'raw-1',
        kind: 'raw_event',
        source: 'recent_activity',
        state: 'raw',
        text: 'codex.UserPromptSubmit codex:turn-1',
      },
      {
        confidence: 1,
        fields: {
          line: 'Current Claims: Active Context should include promoted decisions.',
          provenance: 'claim:claim-2',
          section: 'Current Claims',
        },
        key: 'active-context:Current Claims:0',
        kind: 'active_context',
        source: 'active_context',
        state: 'compiled',
        text: 'Current Claims: Active Context should include promoted decisions.',
      },
      {
        confidence: 0.9,
        fields: {
          connector: 'vault',
          description: 'Seed architecture note.',
          externalId: 'notes/saga-v2-architecture-seed.md',
          sagaLink: 'saga:context/architecture-seed',
          title: 'Architecture Seed',
        },
        key: 'saga:context/architecture-seed',
        kind: 'context_index',
        source: 'context_index',
        state: 'always',
        text: 'Architecture Seed',
      },
    ];

    expect(searchMemoryEntries({ query: 'typed route' }, entries)[0]).toMatchObject({
      key: 'claim-1',
      matchedFields: ['evidence'],
      source: 'current_claim',
    });
    expect(searchMemoryEntries({ query: 'search session' }, entries)[0]).toMatchObject({
      key: 'raw-1',
      matchedFields: ['payload', 'provenance'],
      snippet: expect.stringContaining('search provenance'),
      source: 'recent_activity',
    });
    expect(searchMemoryEntries({ query: 'promoted decisions' }, entries)[0]).toMatchObject({
      key: 'active-context:Current Claims:0',
      matchedFields: ['line'],
      source: 'active_context',
    });
    const contextIndexMatch = searchMemoryEntries({ query: 'architecture seed' }, entries)[0];
    expect(contextIndexMatch).toMatchObject({
      key: 'saga:context/architecture-seed',
      sagaLink: 'saga:context/architecture-seed',
      source: 'context_index',
    });
    expect(contextIndexMatch?.matchedFields).toContain('title');
  });

  it('redacts local paths from structured search memory matches', () => {
    const matches = searchMemoryEntries({ query: 'transcript' }, [
      {
        confidence: 0.45,
        fields: {
          payload: '{"prompt":"inspect transcript"}',
          provenance:
            '{"transcriptPath":"C:\\\\Users\\\\Drew Smith\\\\.codex\\\\transcripts\\\\session.jsonl","unc":"\\\\\\\\server\\\\share\\\\Users\\\\drew\\\\.codex\\\\transcripts\\\\session.jsonl","safe":"https://example.test/session"}',
        },
        key: 'raw-structured',
        kind: 'raw_event',
        source: 'recent_activity',
        state: 'raw',
        text: 'codex.UserPromptSubmit /Users/Drew Smith/.codex/transcripts/session.jsonl https://example.test/session',
      },
    ]);

    const structured = redactSearchMemoryStructuredMatches(matches);
    expect(JSON.stringify(structured)).toContain('[local-path-redacted]');
    expect(JSON.stringify(structured)).toContain('https://example.test/session');
    expect(JSON.stringify(structured)).not.toContain('/Users/Drew Smith');
    expect(JSON.stringify(structured)).not.toContain(String.raw`C:\\Users\\Drew Smith`);
    expect(JSON.stringify(structured)).not.toContain(String.raw`\\\\server\\share`);
    expect(structured[0]).not.toHaveProperty('score');
  });
});
