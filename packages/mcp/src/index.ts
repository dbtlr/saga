export const packageName = '@saga/mcp';

export type JsonRpcRequest = {
  id?: number | string | null | undefined;
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  id: number | string | null;
  jsonrpc: '2.0';
  error?: {
    code: number;
    message: string;
  };
  result?: unknown;
};

export type ListRecentSessionsInput = {
  activeOnly?: boolean | undefined;
  harness?: string | undefined;
  limit?: number | undefined;
};

export type ListRecentSessionsToolResult = {
  markdown: string;
  sessions: unknown[];
};

export type SearchSessionsInput = {
  activityIntervalId?: string | undefined;
  limit?: number | undefined;
  minTrigramScore?: number | undefined;
  query: string;
  rawSessionRecordId?: string | undefined;
  sessionId?: string | undefined;
};

export type SearchSessionsToolResult = {
  markdown: string;
  recall: unknown;
};

export type GetSessionContextInput = {
  afterTurns?: number | undefined;
  beforeTurns?: number | undefined;
  segmentId: string;
  windowTurns?: number | undefined;
};

export type GetSessionContextToolResult = {
  context: unknown;
  markdown: string;
};

export type SagaMcpHandlers = {
  getSessionContext: (input: GetSessionContextInput) => Promise<GetSessionContextToolResult>;
  listRecentSessions: (input: ListRecentSessionsInput) => Promise<ListRecentSessionsToolResult>;
  searchSessions: (input: SearchSessionsInput) => Promise<SearchSessionsToolResult>;
};

export const SAGA_MCP_TOOLS = [
  {
    description:
      'List recent captured Saga sessions for the current workspace with session, raw-record, host-user, harness, model, and provenance metadata.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        activeOnly: {
          type: 'boolean',
        },
        harness: {
          type: 'string',
        },
        limit: {
          minimum: 1,
          type: 'integer',
        },
      },
      type: 'object',
    },
    name: 'list_recent_sessions',
  },
  {
    description:
      'Search captured Saga session segments for the current workspace using vector recall when embeddings are enabled (lexical otherwise) and return snippets, scores, pointers, provenance, and the effective search mode.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        activityIntervalId: {
          type: 'string',
        },
        limit: {
          minimum: 1,
          type: 'integer',
        },
        minTrigramScore: {
          maximum: 1,
          minimum: 0,
          type: 'number',
        },
        query: {
          type: 'string',
        },
        rawSessionRecordId: {
          type: 'string',
        },
        sessionId: {
          type: 'string',
        },
      },
      required: ['query'],
      type: 'object',
    },
    name: 'search_sessions',
  },
  {
    description:
      'Expand session context around a recalled segment for the current workspace, including surrounding turns, segment text, pointers, and provenance. The window is measured in normalized Turns within the same Session, Activity Interval, and Raw Session Record. Withheld or transformed content (skipped payloads, hard-redacted records) stays explicit in a `warnings` array rather than being replaced with indexed text.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        afterTurns: {
          description: 'Turns after the anchor; overrides windowTurns on the after side.',
          minimum: 0,
          type: 'integer',
        },
        beforeTurns: {
          description: 'Turns before the anchor; overrides windowTurns on the before side.',
          minimum: 0,
          type: 'integer',
        },
        segmentId: {
          type: 'string',
        },
        windowTurns: {
          description:
            'Base number of Turns to expand before and after the anchor (default 2, max 20).',
          minimum: 0,
          type: 'integer',
        },
      },
      required: ['segmentId'],
      type: 'object',
    },
    name: 'get_session_context',
  },
] as const;

export function createSagaMcpServer(handlers: SagaMcpHandlers) {
  return {
    handle: (request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> =>
      handleSagaMcpRequest(handlers, request),
  };
}

export async function handleSagaMcpRequest(
  handlers: SagaMcpHandlers,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | undefined> {
  if (request.id === undefined) {
    return undefined;
  }

  try {
    if (request.method === 'initialize') {
      return response(request.id, {
        capabilities: {
          tools: {},
        },
        protocolVersion: '2025-06-18',
        serverInfo: {
          name: 'saga',
          version: '0.0.0',
        },
      });
    }

    if (request.method === 'tools/list') {
      return response(request.id, {
        tools: SAGA_MCP_TOOLS,
      });
    }

    if (request.method === 'tools/call') {
      return response(
        request.id,
        await callSagaMcpTool(handlers, parseToolCallParams(request.params)),
      );
    }

    return errorResponse(request.id, -32601, `method not found: ${request.method}`);
  } catch (error) {
    return errorResponse(
      request.id,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function callSagaMcpTool(
  handlers: SagaMcpHandlers,
  input: {
    arguments?: Record<string, unknown> | undefined;
    name: string;
  },
) {
  if (input.name === 'list_recent_sessions') {
    const result = await handlers.listRecentSessions(parseListRecentSessionsInput(input.arguments));
    return toolResult(result.markdown, { sessions: result.sessions });
  }

  if (input.name === 'search_sessions') {
    const result = await handlers.searchSessions(parseSearchSessionsInput(input.arguments));
    return toolResult(result.markdown, result.recall);
  }

  if (input.name === 'get_session_context') {
    const result = await handlers.getSessionContext(parseGetSessionContextInput(input.arguments));
    return toolResult(result.markdown, result.context);
  }

  throw new Error(`unknown Saga MCP tool: ${input.name}`);
}

function toolResult(text: string, structuredContent: unknown) {
  return {
    content: [
      {
        text,
        type: 'text',
      },
    ],
    structuredContent,
  };
}

function parseToolCallParams(params: unknown): {
  arguments?: Record<string, unknown> | undefined;
  name: string;
} {
  if (!isRecord(params) || typeof params.name !== 'string') {
    throw new Error('tools/call params must include a tool name');
  }
  return {
    arguments: isRecord(params.arguments) ? params.arguments : undefined,
    name: params.name,
  };
}

function parseListRecentSessionsInput(
  input: Record<string, unknown> | undefined,
): ListRecentSessionsInput {
  const limit = parseOptionalPositiveInteger(input?.limit, 'list_recent_sessions limit');
  const harness = parseOptionalString(input?.harness, 'list_recent_sessions harness');
  const activeOnly = input?.activeOnly;
  if (activeOnly !== undefined && typeof activeOnly !== 'boolean') {
    throw new Error('list_recent_sessions activeOnly must be a boolean');
  }

  return {
    activeOnly,
    harness,
    limit,
  };
}

function parseSearchSessionsInput(input: Record<string, unknown> | undefined): SearchSessionsInput {
  const query = input?.query;
  if (typeof query !== 'string' || query.trim() === '') {
    throw new Error('search_sessions requires a non-empty query');
  }

  const minTrigramScore = input?.minTrigramScore;
  if (
    minTrigramScore !== undefined &&
    (typeof minTrigramScore !== 'number' ||
      !Number.isFinite(minTrigramScore) ||
      minTrigramScore < 0 ||
      minTrigramScore > 1)
  ) {
    throw new Error('search_sessions minTrigramScore must be between 0 and 1');
  }

  return {
    activityIntervalId: parseOptionalString(
      input?.activityIntervalId,
      'search_sessions activityIntervalId',
    ),
    limit: parseOptionalPositiveInteger(input?.limit, 'search_sessions limit'),
    minTrigramScore,
    query,
    rawSessionRecordId: parseOptionalString(
      input?.rawSessionRecordId,
      'search_sessions rawSessionRecordId',
    ),
    sessionId: parseOptionalString(input?.sessionId, 'search_sessions sessionId'),
  };
}

function parseGetSessionContextInput(
  input: Record<string, unknown> | undefined,
): GetSessionContextInput {
  const segmentId = input?.segmentId;
  if (typeof segmentId !== 'string' || segmentId.trim() === '') {
    throw new Error('get_session_context requires a non-empty segmentId');
  }

  return {
    afterTurns: parseOptionalNonNegativeInteger(
      input?.afterTurns,
      'get_session_context afterTurns',
    ),
    beforeTurns: parseOptionalNonNegativeInteger(
      input?.beforeTurns,
      'get_session_context beforeTurns',
    ),
    segmentId,
    windowTurns: parseOptionalNonNegativeInteger(
      input?.windowTurns,
      'get_session_context windowTurns',
    ),
  };
}

function parseOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseOptionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function response(id: number | string | null, result: unknown): JsonRpcResponse {
  return {
    id,
    jsonrpc: '2.0',
    result,
  };
}

function errorResponse(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return {
    error: {
      code,
      message,
    },
    id,
    jsonrpc: '2.0',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
