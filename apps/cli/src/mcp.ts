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

// Bound each forwarded request so a service that accepts the connection but never
// responds cannot hang `saga mcp` on that request forever.
const BRIDGE_REQUEST_TIMEOUT_MS = 15_000;

export async function runMcpCommand(
  _args: readonly string[],
  _options: RenderOptions,
  write: (text: string) => void,
  dependencies: McpBridgeDependencies = {},
): Promise<string | undefined> {
  const stdin = dependencies.stdin ?? process.stdin;
  // The forwarder resolves the service connection LAZILY on first use (not here), so a
  // missing service URL surfaces as a per-request JSON-RPC error inside the loop rather
  // than an uncaught throw that would crash the process with a non-JSON-RPC line on
  // stdout (which an MCP client parses as protocol garbage).
  const forward = dependencies.forward ?? createServiceForwarder(dependencies.service ?? {});
  // The project root is invariant across `saga init` rebinds (a rebind rewrites
  // .saga.local.json, not the repo root), so resolve it ONCE — only the binding file
  // is re-read per request, keeping the workspace live without a git subprocess per call.
  const projectRoot = findProjectRoot(dependencies.cwd ?? process.cwd());

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

    // A JSON-RPC notification (no id) must never receive a response frame — not even an
    // error one — per the spec; the old stdio server returned undefined for any id-less
    // request before touching I/O.
    const isNotification = request.id === undefined || request.id === null;

    // Resolve the workspace OUTSIDE the transport try so a local binding-file parse
    // error is reported as a local config error, not mislabeled as a service failure.
    let workspaceId: string | undefined;
    try {
      workspaceId = readBindingFile(projectRoot)?.workspace.id;
    } catch (error) {
      if (!isNotification) {
        write(JSON.stringify(jsonRpcLocalError(request.id, error)));
      }
      continue;
    }

    try {
      const response = await forward(request, workspaceId);
      if (response !== undefined && !isNotification) {
        write(JSON.stringify(response));
      }
    } catch (error) {
      // A transport failure (unreachable, timeout, non-2xx) becomes a JSON-RPC error
      // for an id'd request; a notification is swallowed (no frame).
      if (!isNotification) {
        write(JSON.stringify(jsonRpcTransportError(request.id, error)));
      }
    }
  }
  return undefined;
}

function createServiceForwarder(options: ResolveApiClientOptions): McpRequestForwarder {
  // Resolved lazily and memoized on first forward: a missing service URL throws here,
  // inside the caller's per-request try/catch, so it becomes a clean JSON-RPC error
  // rather than a startup crash.
  let resolved: { endpoint: string; headers: Record<string, string> } | undefined;
  const connect = (): { endpoint: string; headers: Record<string, string> } => {
    if (resolved === undefined) {
      const { authToken, baseUrl } = resolveServiceConnection(options);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (authToken !== undefined) {
        headers.authorization = `Bearer ${authToken}`;
      }
      resolved = { endpoint: `${baseUrl.replace(/\/+$/u, '')}/mcp`, headers };
    }
    return resolved;
  };

  return async (request, workspaceId) => {
    const { endpoint, headers } = connect();
    const url =
      workspaceId === undefined
        ? endpoint
        : `${endpoint}?workspaceId=${encodeURIComponent(workspaceId)}`;
    const response = await fetch(url, {
      body: JSON.stringify(request),
      headers,
      method: 'POST',
      signal: AbortSignal.timeout(BRIDGE_REQUEST_TIMEOUT_MS),
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

// A LOCAL failure (e.g. a corrupt .saga.local.json) — distinct from a transport
// failure so the message points at the on-disk config, not the (healthy) service.
function jsonRpcLocalError(id: JsonRpcRequest['id'], error: unknown): JsonRpcResponse {
  return {
    error: {
      code: -32000,
      message: `saga workspace binding could not be read: ${error instanceof Error ? error.message : String(error)}`,
    },
    id: id ?? null,
    jsonrpc: '2.0',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
