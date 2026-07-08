import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonRpcRequest, JsonRpcResponse } from '@saga/mcp';
import { afterEach, describe, expect, it } from 'vitest';

import { writeBindingFile } from './init.js';
import { runMcpCommand } from './mcp.js';
import type { McpRequestForwarder } from './mcp.js';

async function* chunks(text: string) {
  yield text;
}

const RENDER_OPTIONS = { ascii: false, color: 'never', format: 'records', isTty: false } as const;

// Hoisted so lint doesn't flag them as scope-free closures recreated per test.
const NOTIFICATION_FORWARDER: McpRequestForwarder = async () => undefined;
const THROWING_FORWARDER: McpRequestForwarder = async () => {
  throw new Error('service unreachable');
};

// A temp project with a workspace binding so the bridge resolves a workspace id LIVE.
function boundProject(workspaceId: string): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saga-mcp-bridge-'));
  writeBindingFile(projectRoot, {
    project: { gitRemote: undefined, root: projectRoot },
    schemaVersion: 1,
    service: { databaseUrl: 'environment' },
    sourceBinding: { id: 'source-id' },
    workspace: { handle: 'saga', id: workspaceId },
  });
  return projectRoot;
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

// Records every (request, workspaceId) the bridge forwards and returns a canned
// response, standing in for the live service.
function recordingForwarder(): {
  calls: { request: JsonRpcRequest; workspaceId: string | undefined }[];
  forward: McpRequestForwarder;
} {
  const calls: { request: JsonRpcRequest; workspaceId: string | undefined }[] = [];
  const forward: McpRequestForwarder = async (request, workspaceId) => {
    calls.push({ request, workspaceId });
    return { id: request.id ?? null, jsonrpc: '2.0', result: { ok: true } };
  };
  return { calls, forward };
}

describe('runMcpCommand bridge', () => {
  it('forwards a request with the live-resolved workspace id and relays the response', async () => {
    const projectRoot = boundProject('11111111-1111-1111-1111-111111111111');
    created.push(projectRoot);
    const { calls, forward } = recordingForwarder();
    const output: string[] = [];

    await runMcpCommand([], RENDER_OPTIONS, (text) => output.push(text), {
      cwd: projectRoot,
      forward,
      stdin: chunks(`${JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' })}\n`),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.method).toBe('tools/list');
    expect(calls[0]?.workspaceId).toBe('11111111-1111-1111-1111-111111111111');
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({ id: 1, result: { ok: true } });
  });

  it('forwards without a workspace id when no binding exists (initialize/tools/list still work)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saga-mcp-nobind-'));
    created.push(projectRoot);
    const { calls, forward } = recordingForwarder();

    await runMcpCommand([], RENDER_OPTIONS, () => undefined, {
      cwd: projectRoot,
      forward,
      stdin: chunks(`${JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'initialize' })}\n`),
    });

    expect(calls).toHaveLength(1);
    // No binding → undefined workspace; the service answers initialize transport-only
    // and would return its own missing-workspace error for a tools/call.
    expect(calls[0]?.workspaceId).toBeUndefined();
  });

  it('re-resolves the workspace live per request (a rebind is picked up)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saga-mcp-rebind-'));
    created.push(projectRoot);
    const calls: { workspaceId: string | undefined }[] = [];

    writeBindingFile(projectRoot, {
      project: { gitRemote: undefined, root: projectRoot },
      schemaVersion: 1,
      service: { databaseUrl: 'environment' },
      sourceBinding: { id: 'source-id' },
      workspace: { handle: 'saga', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    });

    // Two requests; between them the binding is rewritten to a new workspace id.
    await runMcpCommand([], RENDER_OPTIONS, () => undefined, {
      cwd: projectRoot,
      forward: async (request, workspaceId) => {
        calls.push({ workspaceId });
        if (calls.length === 1) {
          writeBindingFile(projectRoot, {
            project: { gitRemote: undefined, root: projectRoot },
            schemaVersion: 1,
            service: { databaseUrl: 'environment' },
            sourceBinding: { id: 'source-id' },
            workspace: { handle: 'saga', id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
          });
        }
        return { id: request.id ?? null, jsonrpc: '2.0', result: {} };
      },
      stdin: chunks(
        `${JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/call' })}\n` +
          `${JSON.stringify({ id: 2, jsonrpc: '2.0', method: 'tools/call' })}\n`,
      ),
    });

    expect(calls[0]?.workspaceId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(calls[1]?.workspaceId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });

  it('never forwards a notification response (the service acks it with no body)', async () => {
    const projectRoot = boundProject('11111111-1111-1111-1111-111111111111');
    created.push(projectRoot);
    const output: string[] = [];

    await runMcpCommand([], RENDER_OPTIONS, (text) => output.push(text), {
      cwd: projectRoot,
      // Forwarder returns undefined (the 202 no-body case).
      forward: NOTIFICATION_FORWARDER,
      stdin: chunks(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`),
    });

    expect(output).toHaveLength(0);
  });

  it('answers a malformed frame locally without forwarding it', async () => {
    const { calls, forward } = recordingForwarder();
    const output: string[] = [];

    await runMcpCommand([], RENDER_OPTIONS, (text) => output.push(text), {
      forward,
      stdin: chunks('not json{\n'),
    });

    expect(calls).toHaveLength(0);
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({ error: { code: -32700 }, id: null });
  });

  it('answers an invalid request id locally without forwarding it', async () => {
    const { calls, forward } = recordingForwarder();
    const output: string[] = [];

    await runMcpCommand([], RENDER_OPTIONS, (text) => output.push(text), {
      forward,
      stdin: chunks(`${JSON.stringify({ id: {}, jsonrpc: '2.0', method: 'tools/list' })}\n`),
    });

    expect(calls).toHaveLength(0);
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({ error: { code: -32600 }, id: null });
  });

  it('maps a transport failure onto a JSON-RPC error for the request id', async () => {
    const projectRoot = boundProject('11111111-1111-1111-1111-111111111111');
    created.push(projectRoot);
    const output: string[] = [];

    await runMcpCommand([], RENDER_OPTIONS, (text) => output.push(text), {
      cwd: projectRoot,
      forward: THROWING_FORWARDER,
      stdin: chunks(`${JSON.stringify({ id: 7, jsonrpc: '2.0', method: 'tools/list' })}\n`),
    });

    const parsed = JSON.parse(output[0] ?? '{}') as JsonRpcResponse;
    expect(parsed.id).toBe(7);
    expect(parsed.error?.code).toBe(-32000);
    expect(parsed.error?.message).toContain('service unreachable');
  });
});
