import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  importRawSessionRecord,
  insertRawEvent,
  makeDatabase,
  runMigrations,
  searchSessionRecall,
  workspaces,
} from '@saga/db';
import type { DatabaseService } from '@saga/db';
import type { JsonRpcRequest, JsonRpcResponse } from '@saga/mcp';
import type { RuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { SERVICE_LEXICAL_POSTURE } from './mcp-presentation.js';
import { startSagaService } from './server.js';
import type { SagaServiceHandle } from './server.js';

// STRANGLER TWIN PARITY (SGA-238, reconciled at SGA-249). The service MCP must
// produce byte-identical output to apps/cli's stdio MCP for the same seeded data.
// The oracle is the real `saga mcp` stdio server driven as a SUBPROCESS (the same
// way scripts/smoke-mcp.mjs exercises it): no source import of apps/cli (which
// would breach the app boundary and the service's tsconfig rootDir) and no
// package dependency (which would cycle — @saga/cli depends on @saga/service). It
// reads its workspace + database from an on-disk binding + the child env, so this
// test never mutates the parent process env. When the stdio server is retired the
// oracle goes away.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cliBin = join(repoRoot, 'apps/cli/bin/saga.js');

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL ?? process.env.SAGA_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

// A JSON round-trip normalizes Date instances to the ISO strings that cross the
// HTTP wire, so the subprocess oracle output compares equal to the service's
// parsed-JSON response.
function jsonify(value: unknown): unknown {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- must serialize Dates to wire strings
  return JSON.parse(JSON.stringify(value));
}

function testConfig(url: string): RuntimeConfig {
  return {
    databaseUrl: url,
    databaseUrlSource: 'environment',
    environment: 'test',
    logLevel: 'info',
    service: { host: '127.0.0.1', port: 0 },
    secrets: { openaiApiKey: undefined },
  };
}

// The two search-only divergences: `searchedAt` is stamped per call, and the
// recall posture is environment-resolved (the stdio server reads local policy and
// lands on lexical `disabled-by-policy`, while the service is lexical-only by
// decree). Neutralize both — the posture is asserted separately — so the rest of
// the compaction/redaction/markdown pipeline is compared exactly.
function normalizeSearch(response: unknown): unknown {
  const clone = jsonify(response) as {
    result?: {
      content?: { text?: string }[];
      structuredContent?: { search?: unknown; searchedAt?: unknown };
    };
  };
  const structured = clone.result?.structuredContent;
  if (structured !== undefined) {
    delete structured.search;
    delete structured.searchedAt;
  }
  const content = clone.result?.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (typeof entry.text === 'string') {
        entry.text = entry.text
          .replace(/^- Mode: .*$/mu, '- Mode: <normalized>')
          .replace(/^- Searched: .*$/mu, '- Searched: <normalized>');
      }
    }
  }
  return clone;
}

describePostgres('service MCP parity with the stdio MCP', () => {
  const databaseName = `saga_service_mcp_${Date.now().toString(36)}`;
  let admin: DatabaseService | undefined;
  let service: DatabaseService | undefined;
  let handle: SagaServiceHandle | undefined;
  let bindingDir: string | undefined;
  let sagaHome: string | undefined;
  let scopedUrl = '';

  let workspaceId = '';
  let segmentId = '';

  const recallQuery = 'Parity dogfood capture sentinel phrase';

  // The full request set, driven once through the stdio oracle and then one by one
  // against POST /mcp.
  const requests = {
    context: {
      id: 5,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { segmentId: '', windowTurns: 1 }, name: 'get_session_context' },
    },
    initialize: { id: 1, jsonrpc: '2.0', method: 'initialize' },
    recent: {
      id: 3,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { limit: 5 }, name: 'list_recent_sessions' },
    },
    removed: {
      id: 6,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name: 'get_active_context' },
    },
    search: {
      id: 4,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { limit: 5, query: recallQuery }, name: 'search_sessions' },
    },
    toolsList: { id: 2, jsonrpc: '2.0', method: 'tools/list' },
  } satisfies Record<string, JsonRpcRequest>;

  let oracle = new Map<number, JsonRpcResponse>();

  beforeAll(async () => {
    admin = await Effect.runPromise(
      makeDatabase(testConfig(databaseUrl ?? ''), { postgres: { max: 1 } }),
    );
    await admin.sql.unsafe(`create database "${databaseName}"`);

    const url = new URL(databaseUrl ?? '');
    url.pathname = `/${databaseName}`;
    scopedUrl = url.toString();
    service = await Effect.runPromise(
      makeDatabase(testConfig(scopedUrl), { postgres: { max: 10 } }),
    );
    await Effect.runPromise(runMigrations(service));

    const [workspace] = await service.db
      .insert(workspaces)
      .values({ handle: `mcp-parity-${Date.now().toString(36)}` })
      .returning();
    if (workspace === undefined) {
      throw new Error('workspace insert returned no row');
    }
    workspaceId = workspace.id;

    const imported = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-21T14:00:00.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'mcp-parity-session',
        host: { id: 'host-1', label: 'local-host', projectRoot: '/tmp/saga' },
        rawContent: [
          JSON.stringify({ text: recallQuery, type: 'user' }),
          JSON.stringify({ text: 'assistant reply keeps surrounding context', type: 'assistant' }),
          '',
        ].join('\n'),
        workspaceId,
      }),
    );

    await Effect.runPromise(
      insertRawEvent(service, {
        actorId: 'host-1',
        eventType: 'user-prompt',
        externalEventId: 'mcp-parity-evt-1',
        occurredAt: '2026-06-21T14:00:01.000Z',
        payload: { hook_event_name: 'user-prompt' },
        provenance: { importedBy: 'parity-test' },
        sourceBindingId: imported.sourceBinding.id,
        sourceId: 'codex:local',
        sourceType: 'codex',
        trustLevel: 'raw',
        workspaceId,
      }),
    );

    const seed = await Effect.runPromise(
      searchSessionRecall(service, { query: recallQuery, workspaceId }),
    );
    segmentId = seed.sessions[0]?.matches[0]?.segment.id ?? '';
    if (segmentId === '') {
      throw new Error('seed recall produced no segment to anchor the context expansion');
    }
    (requests.context.params as { arguments: { segmentId: string } }).arguments.segmentId =
      segmentId;

    handle = await startSagaService(testConfig(scopedUrl), {
      database: service,
      recordRun: () => Effect.void,
      validateDatabase: async () => undefined,
    });

    // The stdio oracle resolves its workspace + database from an on-disk binding
    // and its runtime config. findProjectRoot falls back to the cwd when git
    // rev-parse fails (a bare temp dir), so no repo is created. An empty SAGA_HOME
    // keeps installation config (and any real embedding credential) out of the
    // oracle's resolution, so recall stays lexical with no query egress.
    bindingDir = mkdtempSync(join(tmpdir(), 'saga-mcp-parity-'));
    sagaHome = mkdtempSync(join(tmpdir(), 'saga-mcp-parity-home-'));
    writeFileSync(
      join(bindingDir, '.saga.local.json'),
      JSON.stringify({
        project: { gitRemote: undefined, root: bindingDir },
        schemaVersion: 1,
        service: { databaseUrl: 'environment' },
        sourceBinding: { id: imported.sourceBinding.id },
        workspace: { handle: workspace.handle, id: workspaceId },
      }),
    );

    oracle = runStdioMcp(Object.values(requests));
  });

  afterAll(async () => {
    if (bindingDir !== undefined) {
      rmSync(bindingDir, { force: true, recursive: true });
    }
    if (sagaHome !== undefined) {
      rmSync(sagaHome, { force: true, recursive: true });
    }
    if (handle !== undefined) {
      await handle.close();
    }
    if (service !== undefined) {
      await Effect.runPromise(service.close());
    }
    if (admin !== undefined) {
      await admin.sql.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await Effect.runPromise(admin.close());
    }
  });

  // Feed every request to `saga mcp` on stdin and collect the responses by id. The
  // child reads its database from SAGA_DATABASE_URL and its workspace from the
  // binding at cwd — no parent-env mutation.
  function runStdioMcp(all: JsonRpcRequest[]): Map<number, JsonRpcResponse> {
    const result = spawnSync(process.execPath, [cliBin, 'mcp'], {
      cwd: bindingDir,
      encoding: 'utf8',
      env: { ...process.env, SAGA_DATABASE_URL: scopedUrl, SAGA_HOME: sagaHome },
      input: `${all.map((request) => JSON.stringify(request)).join('\n')}\n`,
    });
    if (result.status !== 0) {
      throw new Error(
        `stdio MCP oracle failed (status ${String(result.status)}):\n${result.stderr}`,
      );
    }
    const responses = new Map<number, JsonRpcResponse>();
    for (const line of result.stdout.split(/\r?\n/u)) {
      if (line.trim() === '') {
        continue;
      }
      const response = JSON.parse(line) as JsonRpcResponse;
      if (typeof response.id === 'number') {
        responses.set(response.id, response);
      }
    }
    return responses;
  }

  async function postMcp(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const response = await fetch(`${(handle ?? fail()).url}/mcp?workspaceId=${workspaceId}`, {
      body: JSON.stringify(request),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(200);
    return (await response.json()) as JsonRpcResponse;
  }

  test('initialize matches the stdio server', async () => {
    const request = requests.initialize;
    expect(jsonify(oracle.get(1))).toStrictEqual(await postMcp(request));
  });

  test('tools/list exposes the identical tool set', async () => {
    const request = requests.toolsList;
    expect(jsonify(oracle.get(2))).toStrictEqual(await postMcp(request));
  });

  test('list_recent_sessions structuredContent + markdown match', async () => {
    const request = requests.recent;
    expect(jsonify(oracle.get(3))).toStrictEqual(await postMcp(request));
  });

  test('search_sessions matches (modulo per-call searchedAt + posture)', async () => {
    const viaService = await postMcp(requests.search);
    expect(normalizeSearch(oracle.get(4))).toStrictEqual(normalizeSearch(viaService));
    // The lexical-only posture is stamped on the service structured content and its
    // markdown; the searchedAt is a valid instant.
    const structured = viaService.result as {
      structuredContent: { search: unknown; searchedAt: string };
    };
    expect(structured.structuredContent.search).toStrictEqual(jsonify(SERVICE_LEXICAL_POSTURE));
    expect(new Date(structured.structuredContent.searchedAt).toISOString()).toBe(
      structured.structuredContent.searchedAt,
    );
  });

  test('get_session_context structuredContent + markdown match', async () => {
    const request = requests.context;
    expect(jsonify(oracle.get(5))).toStrictEqual(await postMcp(request));
  });

  test('a removed tool yields the identical unknown-tool error', async () => {
    const viaService = await postMcp(requests.removed);
    expect(jsonify(oracle.get(6))).toStrictEqual(viaService);
    expect(viaService.error?.message).toBe('unknown Saga MCP tool: get_active_context');
  });

  test('a tools/call without a workspace scope is a JSON-RPC error', async () => {
    const response = await fetch(`${(handle ?? fail()).url}/mcp`, {
      body: JSON.stringify({
        id: 7,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { arguments: { limit: 1 }, name: 'list_recent_sessions' },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toContain('workspaceId');
  });
});

function fail(): never {
  throw new Error('service MCP parity fixture was not initialized');
}
