// SGA-249: `saga mcp` is a zero-logic stdio→HTTP bridge. The harness speaks the
// stdio MCP transport (a `{command, args:['mcp']}` entry in .mcp.json); this reads
// newline-delimited JSON-RPC from stdin and forwards each request to the service's
// HTTP MCP (`POST <serviceUrl>/mcp?workspaceId=<id>`), relaying the response to
// stdout. All recall/session logic — and the database connection — now live in the
// service; the bridge holds no credentials and opens no Postgres.
//
// The workspace is resolved LIVE per request from the on-disk binding (not baked
// into a static URL), so a `saga init` that rebinds the workspace is picked up by
// the very next tool call with no harness re-install. initialize/tools/list carry
// no workspace (the service answers them transport-only); only a tools/call needs
// one, and a bare forward lets the service return its own "workspaceId required"
// JSON-RPC error when the binding is missing — identical to its HTTP behavior.

import { resolveServiceConnection } from '@saga/client-cli';
import type { ResolveApiClientOptions } from '@saga/client-cli';
import type { JsonRpcRequest, JsonRpcResponse } from '@saga/mcp';

import { findProjectRoot, readBindingFile } from './init.js';
import type { RenderOptions } from './render.js';

// Forwards a single JSON-RPC request to the service and resolves to its response,
// or undefined for a notification the service acknowledges with no body. Injected in
// tests to stand in for the live service.
export type McpRequestForwarder = (
  request: JsonRpcRequest,
  workspaceId: string | undefined,
) => Promise<JsonRpcResponse | undefined>;

export type McpBridgeDependencies = {
  // Working directory used to resolve the workspace binding per request.
  cwd?: string | undefined;
  // Transport override (tests); defaults to a fetch-backed forwarder built from the
  // resolved service connection (--service-url/--auth-token → env → client config).
  forward?: McpRequestForwarder | undefined;
  // Service connection resolution seam (service URL / auth token / env / config).
  service?: ResolveApiClientOptions | undefined;
  stdin?: AsyncIterable<Buffer | string> | undefined;
};

export async function runMcpCommand(
  _args: readonly string[],
  _options: RenderOptions,
  write: (text: string) => void,
  dependencies: McpBridgeDependencies = {},
): Promise<string | undefined> {
  const stdin = dependencies.stdin ?? process.stdin;
  // The forwarder resolves the service connection ONCE (process-level config), while
  // the workspace is resolved per request (live binding read) below.
  const forward = dependencies.forward ?? createServiceForwarder(dependencies.service ?? {});

  for await (const line of readJsonLines(stdin)) {
    let request: JsonRpcRequest;
    try {
      request = parseJsonRpcRequest(line);
    } catch (error) {
      // A malformed frame never reaches the service; answer it locally with the same
      // JSON-RPC parse/invalid-request envelope the stdio server always used.
      write(JSON.stringify(jsonRpcInputError(error)));
      continue;
    }
    try {
      const workspaceId = resolveWorkspaceId(dependencies.cwd);
      const response = await forward(request, workspaceId);
      if (response !== undefined) {
        write(JSON.stringify(response));
      }
    } catch (error) {
      // A transport failure (service unreachable, non-2xx) becomes a JSON-RPC error
      // for this request's id rather than crashing the bridge loop.
      write(JSON.stringify(jsonRpcTransportError(request.id, error)));
    }
  }
  return undefined;
}

// Resolve the workspace id from the on-disk binding, or undefined when there is no
// binding — the bridge forwards without a workspace so initialize/tools/list still
// work and a tools/call surfaces the service's own missing-workspace error.
function resolveWorkspaceId(cwd: string | undefined): string | undefined {
  const projectRoot = findProjectRoot(cwd ?? process.cwd());
  return readBindingFile(projectRoot)?.workspace.id;
}

function createServiceForwarder(options: ResolveApiClientOptions): McpRequestForwarder {
  // Resolve the connection once; a missing service URL throws here (on the first
  // request), the same clear error the client commands surface.
  const { authToken, baseUrl } = resolveServiceConnection(options);
  const endpoint = `${baseUrl.replace(/\/+$/u, '')}/mcp`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authToken !== undefined) {
    headers.authorization = `Bearer ${authToken}`;
  }

  return async (request, workspaceId) => {
    const url =
      workspaceId === undefined
        ? endpoint
        : `${endpoint}?workspaceId=${encodeURIComponent(workspaceId)}`;
    const response = await fetch(url, {
      body: JSON.stringify(request),
      headers,
      method: 'POST',
    });
    // A JSON-RPC notification is acknowledged by the service with 202 and no body.
    if (response.status === 202) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`saga service responded ${String(response.status)}`);
    }
    // The service's /mcp answers with a JSON-RPC response envelope; the bridge relays
    // it verbatim to stdout without inspecting it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- trusted service JSON-RPC envelope, relayed verbatim
    return (await response.json()) as JsonRpcResponse;
  };
}

async function* readJsonLines(stdin: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of stdin) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed !== '') {
        yield trimmed;
      }
    }
  }
  const trimmed = buffer.trim();
  if (trimmed !== '') {
    yield trimmed;
  }
}

function parseJsonRpcRequest(line: string): JsonRpcRequest {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
    throw new Error('expected a JSON-RPC 2.0 request object');
  }
  if (
    parsed.id !== undefined &&
    typeof parsed.id !== 'string' &&
    typeof parsed.id !== 'number' &&
    parsed.id !== null
  ) {
    throw new Error('JSON-RPC request id must be a string, number, or null');
  }
  return {
    id: parsed.id,
    jsonrpc: '2.0',
    method: parsed.method,
    params: parsed.params,
  };
}

function jsonRpcInputError(error: unknown): JsonRpcResponse {
  return {
    error: {
      code: error instanceof SyntaxError ? -32700 : -32600,
      message: error instanceof Error ? error.message : String(error),
    },
    id: null,
    jsonrpc: '2.0',
  };
}

// A transport failure mapped onto the originating request's id (JSON-RPC requires the
// id to correlate the error with the call). -32000 is the server-error code the MCP
// core also uses; the message is a static, driver-free summary.
function jsonRpcTransportError(id: JsonRpcRequest['id'], error: unknown): JsonRpcResponse {
  return {
    error: {
      code: -32000,
      message: `saga service request failed: ${error instanceof Error ? error.message : String(error)}`,
    },
    id: id ?? null,
    jsonrpc: '2.0',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
