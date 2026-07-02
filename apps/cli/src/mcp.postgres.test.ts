import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { insertRawEvent, makeDatabase } from '@saga/db';
import type { SessionEmbeddingGenerator } from '@saga/db';
import { DEFAULT_OPENAI_EMBEDDING_PROVIDER, loadRuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { runIndexCommand } from './index-command.js';
import { ingestClaims, inspectRecentRawEvents } from './ingest.js';
import { initProject } from './init.js';
import { createProjectMcpServer } from './mcp.js';
import type { ResolvedRecallEmbedding } from './recall.js';
import { runSessionsCommand } from './sessions.js';

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const renderOptions = {
  ascii: true,
  color: 'never',
  format: 'records',
  isTty: false,
} as const;
const jsonRenderOptions = {
  ...renderOptions,
  format: 'json',
} as const;

const { dimensions, id: providerId, model } = DEFAULT_OPENAI_EMBEDDING_PROVIDER;

// One-hot vectors of the production dimension: `alpha` text -> axis 0, `beta` -> axis 1,
// anything else -> axis 2. Cosine distance is 0 between identical axes and 1 otherwise, so a
// query embedding on axis 0 matches only the `alpha` segment via the vector path.
function oneHotVector(axis: number): number[] {
  return Array.from({ length: dimensions }, (_value, index) => (index === axis ? 1 : 0));
}

function axisForText(text: string): number {
  if (text.includes('alpha')) {
    return 0;
  }
  if (text.includes('beta')) {
    return 1;
  }
  return 2;
}

function fakeGenerator(): SessionEmbeddingGenerator {
  return {
    embedSegments: async (inputs) =>
      inputs.map((input) => ({
        embedding: oneHotVector(axisForText(input.text)),
        segmentId: input.segmentId,
      })),
    provider: DEFAULT_OPENAI_EMBEDDING_PROVIDER,
  };
}

describePostgres('MCP session recall postgres integration', () => {
  const databaseName = `saga_mcp_recall_${Date.now().toString(36)}`;
  const adminSql = postgres(databaseUrl ?? '', { max: 1 });
  let previousDatabaseUrl: string | undefined;
  let projectRoot: string | undefined;

  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    const url = new URL(databaseUrl ?? '');
    url.pathname = `/${databaseName}`;
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url.toString();
    projectRoot = mkdtempSync(join(tmpdir(), 'saga-mcp-recall-'));
    await initProject({ cwd: projectRoot, handle: 'MCP Recall' });
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 5 });
  });

  test('lists, searches, and expands imported session context through MCP tools', async () => {
    if (projectRoot === undefined) {
      throw new Error('project root was not initialized');
    }
    const inputPath = join(projectRoot, 'mcp-session.jsonl');
    const linuxCwd = '/work/saga';
    const linuxProjectRoot = '/home/drew/work/saga';
    const linuxTranscriptPath = '/work/saga/mcp-session.jsonl';
    const customRoot = '/custom-root/saga';
    const fileUri = 'file:///tmp/saga/session.jsonl';
    const windowsTranscriptPath = String.raw`C:\Users\drew\.codex\transcripts\session.jsonl`;
    const linuxUnsafePaths = [
      linuxCwd,
      linuxProjectRoot,
      linuxTranscriptPath,
      customRoot,
      fileUri,
      windowsTranscriptPath,
    ] as const;
    writeFileSync(
      inputPath,
      [
        JSON.stringify({
          text: `MCP recall sentinel phrase for SGA-130 search with imported path evidence ${linuxCwd} ${linuxProjectRoot} ${customRoot} ${fileUri} ${windowsTranscriptPath} kept around plain words`,
          type: 'user',
        }),
        JSON.stringify({
          text: `The assistant response provides MCP surrounding context from ${customRoot}/session.log and ${fileUri} plus ${windowsTranscriptPath} with non-sensitive summary intact`,
          type: 'assistant',
        }),
        '',
      ].join('\n'),
    );

    await runSessionsCommand(
      [
        'import',
        inputPath,
        '--harness',
        'codex',
        '--harness-session-id',
        'mcp-recall-session',
        '--host-project-root',
        linuxProjectRoot,
        '--metadata',
        JSON.stringify({
          cwd: linuxCwd,
          note: `cwd=${linuxCwd}`,
          windowsTranscriptPath,
        }),
        '--provenance',
        JSON.stringify({ transcriptPath: linuxTranscriptPath, windowsTranscriptPath }),
      ],
      renderOptions,
      { cwd: projectRoot },
    );

    // Inject a policy-disabled resolution so the test never reads host policy/auth state;
    // the lexical search path itself runs for real against Postgres.
    const server = createProjectMcpServer({
      cwd: projectRoot,
      resolveRecallEmbedding: async (): Promise<ResolvedRecallEmbedding> => ({
        posture: {
          detail: 'remote embeddings disabled by installation standard',
          mode: 'lexical',
          reason: 'disabled-by-policy',
        },
      }),
    });
    const recent = await server.handle({
      id: 'recent',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {
          limit: 5,
        },
        name: 'list_recent_sessions',
      },
    });
    const recentResult = recent?.result as ToolResult | undefined;
    expect(recentResult?.content[0]?.text).toContain('Recent Saga Sessions');
    expect(recentResult?.content[0]?.text).toContain('mcp-recall-session');
    expect(recentResult?.content[0]?.text).toContain('Host user');
    expect(recentResult?.content[0]?.text).not.toContain(inputPath);
    expect(recentResult?.content[0]?.text).not.toContain(projectRoot);
    for (const unsafePath of linuxUnsafePaths) {
      expect(recentResult?.content[0]?.text).not.toContain(unsafePath);
    }
    expectNoUnsafeMcpStructuredContent(recentResult?.structuredContent, {
      extraPaths: linuxUnsafePaths,
      inputPath,
      projectRoot,
    });

    const search = await server.handle({
      id: 'search',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {
          query: 'imported path evidence',
        },
        name: 'search_sessions',
      },
    });
    const searchResult = search?.result as ToolResult | undefined;
    expect(searchResult?.content[0]?.text).toContain('Saga Session Search');
    expect(searchResult?.content[0]?.text).toContain('Mode: lexical (disabled-by-policy)');
    expect(searchResult?.content[0]?.text).toContain('imported path evidence');
    expect(searchResult?.structuredContent).toMatchObject({
      search: {
        mode: 'lexical',
        reason: 'disabled-by-policy',
      },
    });
    expect(searchResult?.content[0]?.text).toContain('[local-path-redacted]');
    expect(searchResult?.content[0]?.text).toContain('Retrieved Content');
    expect(searchResult?.content[0]?.text).not.toContain(inputPath);
    expect(searchResult?.content[0]?.text).not.toContain(projectRoot);
    for (const unsafePath of linuxUnsafePaths) {
      expect(searchResult?.content[0]?.text).not.toContain(unsafePath);
    }
    expectNoUnsafeMcpStructuredContent(searchResult?.structuredContent, {
      extraPaths: linuxUnsafePaths,
      inputPath,
      projectRoot,
    });

    const segmentId = firstSegmentId(searchResult?.structuredContent);
    expect(segmentId).toMatch(/[0-9a-f-]{36}/u);

    const context = await server.handle({
      id: 'context',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {
          segmentId,
          windowTurns: 1,
        },
        name: 'get_session_context',
      },
    });
    const contextResult = context?.result as ToolResult | undefined;
    expect(contextResult?.content[0]?.text).toContain('Saga Session Context');
    expect(contextResult?.content[0]?.text).toContain('Segment 0 anchor');
    expect(contextResult?.content[0]?.text).toContain('MCP recall sentinel');
    expect(contextResult?.content[0]?.text).toContain('MCP surrounding context');
    expect(contextResult?.content[0]?.text).toContain('imported path evidence');
    expect(contextResult?.content[0]?.text).toContain('non-sensitive summary intact');
    expect(contextResult?.content[0]?.text).not.toContain(inputPath);
    expect(contextResult?.content[0]?.text).not.toContain(projectRoot);
    for (const unsafePath of linuxUnsafePaths) {
      expect(contextResult?.content[0]?.text).not.toContain(unsafePath);
    }
    expectNoUnsafeMcpStructuredContent(contextResult?.structuredContent, {
      extraPaths: linuxUnsafePaths,
      inputPath,
      projectRoot,
    });
  });

  test('searches indexed session segments through MCP vector recall end-to-end', async () => {
    if (projectRoot === undefined) {
      throw new Error('project root was not initialized');
    }
    const inputPath = join(projectRoot, 'mcp-vector-session.jsonl');
    writeFileSync(
      inputPath,
      [
        JSON.stringify({ text: 'alpha distinctive marker content', type: 'user' }),
        JSON.stringify({ text: 'beta distinctive marker content', type: 'assistant' }),
        '',
      ].join('\n'),
    );
    await runSessionsCommand(
      ['import', inputPath, '--harness', 'codex', '--harness-session-id', 'mcp-vector-session'],
      renderOptions,
      { cwd: projectRoot },
    );
    await runIndexCommand([], renderOptions, {
      cwd: projectRoot,
      embeddingGenerator: fakeGenerator(),
    });

    const server = createProjectMcpServer({
      cwd: projectRoot,
      resolveRecallEmbedding: async (): Promise<ResolvedRecallEmbedding> => ({
        posture: { mode: 'vector' },
        queryEmbedding: {
          dimensions,
          model,
          provider: providerId,
          vector: oneHotVector(0),
        },
      }),
    });
    // The query matches no lexical or trigram token, so a hit can only come from the vector
    // path; the alpha segment ranks first with a perfect (1) vector score.
    const search = await server.handle({
      id: 'vector-search',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {
          query: 'qzxvnomatchtoken',
        },
        name: 'search_sessions',
      },
    });
    const searchResult = search?.result as ToolResult | undefined;
    const text = searchResult?.content[0]?.text ?? '';
    expect(text).toContain('Saga Session Search');
    expect(text).toContain('Mode: vector');
    expect(text).toContain('Match 1');
    expect(text).toContain('alpha distinctive marker');
    expect(text).toContain('vector 1');
    expect(text).toContain('lexical 0');
    expect(searchResult?.structuredContent).toMatchObject({
      search: { mode: 'vector' },
    });
  });

  test('does not return redacted raw event evidence through MCP search_memory or CLI recent events', async () => {
    if (projectRoot === undefined) {
      throw new Error('project root was not initialized');
    }
    const inputPath = join(projectRoot, 'mcp-redacted-raw-event.jsonl');
    const secret = 'mcp-raw-event-secret-token';
    writeFileSync(
      inputPath,
      [
        JSON.stringify({
          text: `The raw event safety test contains ${secret}`,
          type: 'user',
        }),
        '',
      ].join('\n'),
    );

    const importOutput = await runSessionsCommand(
      ['import', inputPath, '--harness', 'codex', '--harness-session-id', 'mcp-redacted-raw-event'],
      jsonRenderOptions,
      { cwd: projectRoot },
    );
    const imported = parseImportResult(importOutput);
    const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
    const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
    try {
      await Effect.runPromise(
        insertRawEvent(service, {
          actorId: 'codex',
          eventType: 'codex.UserPromptSubmit',
          externalEventId: 'mcp-redacted-raw-event',
          occurredAt: '2026-06-22T12:00:01.000Z',
          payload: {
            hook_event_name: 'UserPromptSubmit',
            prompt: `Please remember raw hook prompt ${secret}.`,
          },
          provenance: {
            hookEventName: 'UserPromptSubmit',
            prompt: `raw hook provenance ${secret}`,
          },
          sessionId: imported.session.harnessSessionId,
          sourceBindingId: imported.sourceBinding.id,
          sourceId: 'codex:local',
          sourceType: 'codex',
          traceId: 'mcp-redacted-raw-event-turn',
          trustLevel: 'raw',
          workspaceId: imported.session.workspaceId,
        }),
      );
    } finally {
      await Effect.runPromise(service.close());
    }
    const claimProjection = await ingestClaims({ cwd: projectRoot, limit: 10 }, jsonRenderOptions);
    expect(claimProjection).toContain('"projected": 1');

    const server = createProjectMcpServer({ cwd: projectRoot });
    const before = await server.handle({
      id: 'search-memory-before-redaction',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {
          query: secret,
        },
        name: 'search_memory',
      },
    });
    expect(JSON.stringify((before?.result as ToolResult | undefined)?.structuredContent)).toContain(
      secret,
    );

    await runSessionsCommand(['redact', imported.session.id, '--literal', secret], renderOptions, {
      cwd: projectRoot,
    });

    const after = await server.handle({
      id: 'search-memory-after-redaction',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {
          query: secret,
        },
        name: 'search_memory',
      },
    });
    const afterResult = after?.result as ToolResult | undefined;
    expect(afterResult?.content[0]?.text).toContain(`No matches for ${secret}`);
    expect(afterResult?.content[0]?.text).not.toContain('raw hook prompt');
    expect(afterResult?.content[0]?.text).not.toContain('raw_event');
    expect(JSON.stringify(afterResult?.structuredContent)).not.toContain(secret);

    const recentRawEvents = await inspectRecentRawEvents(
      { cwd: projectRoot, limit: 10 },
      jsonRenderOptions,
    );
    expect(recentRawEvents).not.toContain(secret);
    expect(recentRawEvents).toContain('[REDACTED]');
  });
});

type ToolResult = {
  content: {
    text: string;
    type: 'text';
  }[];
  structuredContent: unknown;
};

type ImportResult = {
  session: {
    harnessSessionId: string;
    id: string;
    workspaceId: string;
  };
  sourceBinding: {
    id: string;
  };
};

function parseImportResult(output: string): ImportResult {
  const parsed = JSON.parse(output) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('import output was not an object');
  }
  const session = parsed.session;
  const sourceBinding = parsed.sourceBinding;
  if (!isRecord(session) || !isRecord(sourceBinding)) {
    throw new Error('import output did not include session/source binding');
  }
  const harnessSessionId = session.harnessSessionId;
  const sessionId = session.id;
  const workspaceId = session.workspaceId;
  const sourceBindingId = sourceBinding.id;
  if (
    typeof harnessSessionId !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof workspaceId !== 'string' ||
    typeof sourceBindingId !== 'string'
  ) {
    throw new Error('import output had invalid ids');
  }
  return {
    session: {
      harnessSessionId,
      id: sessionId,
      workspaceId,
    },
    sourceBinding: {
      id: sourceBindingId,
    },
  };
}

function firstSegmentId(structuredContent: unknown): string {
  if (!isRecord(structuredContent)) {
    return '';
  }
  const sessions = structuredContent.sessions;
  if (!Array.isArray(sessions)) {
    return '';
  }
  const firstSession = sessions[0];
  if (!isRecord(firstSession)) {
    return '';
  }
  const matches = firstSession.matches;
  if (!Array.isArray(matches)) {
    return '';
  }
  const firstMatch = matches[0];
  if (!isRecord(firstMatch)) {
    return '';
  }
  const segment = firstMatch.segment;
  if (!isRecord(segment)) {
    return '';
  }
  return typeof segment.id === 'string' ? segment.id : '';
}

function expectNoUnsafeMcpStructuredContent(
  structuredContent: unknown,
  input: { extraPaths?: readonly string[]; inputPath: string; projectRoot: string },
) {
  const serialized = JSON.stringify(structuredContent);
  for (const unsafePath of [input.inputPath, input.projectRoot, ...(input.extraPaths ?? [])]) {
    expect(serialized).not.toContain(unsafePath);
    expect(serialized).not.toContain(unsafePath.replaceAll('\\', String.raw`\\`));
  }
  expect(serialized).not.toContain('sourceLocator');
  expect(serialized).not.toContain('"config"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
