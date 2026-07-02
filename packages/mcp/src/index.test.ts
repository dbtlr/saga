import { describe, expect, it } from 'vitest';

import { createSagaMcpServer } from './index.js';

const server = createSagaMcpServer({
  getSessionContext: async (input) => ({
    context: {
      anchor: {
        segment: {
          id: input.segmentId,
        },
      },
      windowTurns: input.windowTurns,
    },
    markdown: `# Session Context\n${input.segmentId}`,
  }),
  getActiveContext: async () => ({
    document: { summary: 'Active Context for saga' },
    markdown: '# Active Context for saga',
  }),
  listRecentSessions: async (input) => ({
    markdown: `# Recent Sessions\n${input.harness ?? 'all'}`,
    sessions: [
      {
        rawSessionRecord: {
          id: 'raw-record-id',
        },
        session: {
          id: 'session-id',
        },
      },
    ],
  }),
  resolveSagaLink: async (input) => ({
    markdown: `# Link\n${input.link}`,
    resolved: {
      entry: {
        sagaLink: input.link,
      },
    },
  }),
  searchMemory: async (input) => ({
    markdown: `# Search\n${input.query}`,
    matches: [
      {
        confidence: 0.9,
        key: 'claim-key',
        kind: 'decision',
        state: 'candidate',
        text: `Found ${input.query}`,
      },
    ],
  }),
  searchSessions: async (input) => ({
    markdown: `# Session Search\n${input.query}`,
    recall: {
      query: input.query,
      sessions: [
        {
          matches: [
            {
              segment: {
                id: 'segment-id',
              },
              snippet: `Found ${input.query}`,
            },
          ],
        },
      ],
    },
  }),
});

describe('createSagaMcpServer', () => {
  it('lists Saga MCP tools', async () => {
    const response = await server.handle({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/list',
    });

    expect(response?.result).toMatchObject({
      tools: [
        {
          name: 'get_active_context',
        },
        {
          name: 'search_memory',
        },
        {
          name: 'resolve_saga_link',
        },
        {
          name: 'list_recent_sessions',
        },
        {
          name: 'search_sessions',
        },
        {
          name: 'get_session_context',
        },
      ],
    });
  });

  it('declares integer schemas for count and turn-window inputs', async () => {
    const response = await server.handle({
      id: 'schemas',
      jsonrpc: '2.0',
      method: 'tools/list',
    });

    expect(response?.result).toMatchObject({
      tools: [
        { name: 'get_active_context' },
        {
          inputSchema: { properties: { limit: { type: 'integer' } } },
          name: 'search_memory',
        },
        { name: 'resolve_saga_link' },
        {
          inputSchema: { properties: { limit: { type: 'integer' } } },
          name: 'list_recent_sessions',
        },
        {
          inputSchema: {
            properties: {
              limit: { type: 'integer' },
              minTrigramScore: { type: 'number' },
            },
          },
          name: 'search_sessions',
        },
        {
          inputSchema: {
            properties: {
              afterTurns: { type: 'integer' },
              beforeTurns: { type: 'integer' },
              windowTurns: { type: 'integer' },
            },
          },
          name: 'get_session_context',
        },
      ],
    });
  });

  it('calls get_active_context', async () => {
    const response = await server.handle({
      id: 'context',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'get_active_context',
      },
    });

    expect(response?.result).toMatchObject({
      content: [
        {
          text: '# Active Context for saga',
          type: 'text',
        },
      ],
      structuredContent: {
        summary: 'Active Context for saga',
      },
    });
  });

  it('calls search_memory', async () => {
    const response = await server.handle({
      id: 'search',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {
          query: 'Active Context',
        },
        name: 'search_memory',
      },
    });

    expect(JSON.stringify(response?.result)).toContain('Found Active Context');
  });

  it('calls resolve_saga_link', async () => {
    const response = await server.handle({
      id: 'resolve',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {
          link: 'saga:context/architecture-seed',
        },
        name: 'resolve_saga_link',
      },
    });

    expect(JSON.stringify(response?.result)).toContain('saga:context/architecture-seed');
  });

  it('calls list_recent_sessions', async () => {
    const response = await server.handle({
      id: 'recent',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {
          activeOnly: true,
          harness: 'codex',
          limit: 5,
        },
        name: 'list_recent_sessions',
      },
    });

    expect(response?.result).toMatchObject({
      content: [
        {
          text: expect.stringContaining('codex'),
          type: 'text',
        },
      ],
      structuredContent: {
        sessions: [
          {
            rawSessionRecord: {
              id: 'raw-record-id',
            },
            session: {
              id: 'session-id',
            },
          },
        ],
      },
    });
  });

  it('calls search_sessions', async () => {
    const response = await server.handle({
      id: 'session-search',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {
          limit: 3,
          minTrigramScore: 0.3,
          query: 'lexical recall',
          sessionId: 'session-id',
        },
        name: 'search_sessions',
      },
    });

    expect(JSON.stringify(response?.result)).toContain('Found lexical recall');
    expect(response?.result).toMatchObject({
      structuredContent: {
        query: 'lexical recall',
      },
    });
  });

  it('calls get_session_context', async () => {
    const response = await server.handle({
      id: 'session-context',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {
          segmentId: 'segment-id',
          windowTurns: 1,
        },
        name: 'get_session_context',
      },
    });

    expect(response?.result).toMatchObject({
      content: [
        {
          text: expect.stringContaining('segment-id'),
          type: 'text',
        },
      ],
      structuredContent: {
        anchor: {
          segment: {
            id: 'segment-id',
          },
        },
        windowTurns: 1,
      },
    });
  });

  it('returns JSON-RPC errors', async () => {
    const response = await server.handle({
      id: 99,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {},
        name: 'search_memory',
      },
    });

    expect(response?.error?.message).toBe('search_memory requires a non-empty query');
  });

  it('validates session recall tool arguments', async () => {
    await expect(
      server.handle({
        id: 100,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          arguments: {
            windowTurns: -1,
          },
          name: 'get_session_context',
        },
      }),
    ).resolves.toMatchObject({
      error: {
        message: 'get_session_context requires a non-empty segmentId',
      },
    });

    await expect(
      server.handle({
        id: 101,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          arguments: {
            minTrigramScore: 2,
            query: 'recall',
          },
          name: 'search_sessions',
        },
      }),
    ).resolves.toMatchObject({
      error: {
        message: 'search_sessions minTrigramScore must be between 0 and 1',
      },
    });
  });
});
