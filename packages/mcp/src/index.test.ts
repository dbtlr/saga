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
  it('lists exactly the session capture and recall tools', async () => {
    const response = await server.handle({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/list',
    });

    expect(response?.result).toMatchObject({
      tools: [
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

  it('rejects removed pre-consolidation tools', async () => {
    for (const name of ['get_active_context', 'search_memory', 'resolve_saga_link']) {
      const response = await server.handle({
        id: `removed-${name}`,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          arguments: {},
          name,
        },
      });

      expect(response?.error?.message).toBe(`unknown Saga MCP tool: ${name}`);
    }
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
        name: 'search_sessions',
      },
    });

    expect(response?.error?.message).toBe('search_sessions requires a non-empty query');
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
