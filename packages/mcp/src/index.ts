export const packageName = "@saga/mcp";

export interface JsonRpcRequest {
  id?: number | string | null | undefined;
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: number | string | null;
  jsonrpc: "2.0";
  error?: {
    code: number;
    message: string;
  };
  result?: unknown;
}

export interface ActiveContextToolResult {
  document: unknown;
  markdown: string;
}

export interface SearchMemoryInput {
  limit?: number | undefined;
  query: string;
}

export interface SearchMemoryToolResult {
  matches: Array<{
    confidence: number;
    key: string;
    kind: string;
    matchedFields?: string[] | undefined;
    snippet?: string | undefined;
    source?: string | undefined;
    state: string;
    text: string;
  }>;
  markdown: string;
}

export interface ResolveSagaLinkInput {
  link: string;
}

export interface ResolveSagaLinkToolResult {
  markdown: string;
  resolved: unknown;
}

export interface SagaMcpHandlers {
  getActiveContext: () => Promise<ActiveContextToolResult>;
  resolveSagaLink: (input: ResolveSagaLinkInput) => Promise<ResolveSagaLinkToolResult>;
  searchMemory: (input: SearchMemoryInput) => Promise<SearchMemoryToolResult>;
}

export const SAGA_MCP_TOOLS = [
  {
    description: "Return the compiled Saga Active Context for the current workspace.",
    inputSchema: {
      additionalProperties: false,
      properties: {},
      type: "object",
    },
    name: "get_active_context",
  },
  {
    description:
      "Search projected Saga memory, recent activity, and compiled Active Context for the current workspace.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        limit: {
          minimum: 1,
          type: "number",
        },
        query: {
          type: "string",
        },
      },
      required: ["query"],
      type: "object",
    },
    name: "search_memory",
  },
  {
    description: "Resolve a Saga Link into the configured connector target and provenance.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        link: {
          type: "string",
        },
      },
      required: ["link"],
      type: "object",
    },
    name: "resolve_saga_link",
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
  if (request.id === undefined) return undefined;

  try {
    if (request.method === "initialize") {
      return response(request.id, {
        capabilities: {
          tools: {},
        },
        protocolVersion: "2025-06-18",
        serverInfo: {
          name: "saga",
          version: "0.0.0",
        },
      });
    }

    if (request.method === "tools/list") {
      return response(request.id, {
        tools: SAGA_MCP_TOOLS,
      });
    }

    if (request.method === "tools/call") {
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
  if (input.name === "get_active_context") {
    const result = await handlers.getActiveContext();
    return toolResult(result.markdown, result.document);
  }

  if (input.name === "search_memory") {
    const result = await handlers.searchMemory(parseSearchMemoryInput(input.arguments));
    return toolResult(result.markdown, { matches: result.matches });
  }

  if (input.name === "resolve_saga_link") {
    const result = await handlers.resolveSagaLink(parseResolveSagaLinkInput(input.arguments));
    return toolResult(result.markdown, result.resolved);
  }

  throw new Error(`unknown Saga MCP tool: ${input.name}`);
}

function toolResult(text: string, structuredContent: unknown) {
  return {
    content: [
      {
        text,
        type: "text",
      },
    ],
    structuredContent,
  };
}

function parseToolCallParams(params: unknown): {
  arguments?: Record<string, unknown> | undefined;
  name: string;
} {
  if (!isRecord(params) || typeof params.name !== "string") {
    throw new Error("tools/call params must include a tool name");
  }
  return {
    arguments: isRecord(params.arguments) ? params.arguments : undefined,
    name: params.name,
  };
}

function parseSearchMemoryInput(input: Record<string, unknown> | undefined): SearchMemoryInput {
  const query = input?.query;
  if (typeof query !== "string" || query.trim() === "") {
    throw new Error("search_memory requires a non-empty query");
  }

  const limit = input?.limit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) {
    throw new Error("search_memory limit must be a positive integer");
  }

  return {
    limit,
    query,
  };
}

function parseResolveSagaLinkInput(
  input: Record<string, unknown> | undefined,
): ResolveSagaLinkInput {
  const link = input?.link;
  if (typeof link !== "string" || link.trim() === "") {
    throw new Error("resolve_saga_link requires a non-empty link");
  }

  return { link };
}

function response(id: number | string | null, result: unknown): JsonRpcResponse {
  return {
    id,
    jsonrpc: "2.0",
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
    jsonrpc: "2.0",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
