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
  let sessionId = '';
  let segmentId = '';

  const recallQuery = 'Parity dogfood capture sentinel phrase';

  // Sensitive values seeded into the session so the redaction-correctness test can
  // assert the SERVICE structured output actually scrubs them (not just that it
  // equals the stdio output — a shared regression would keep parity green while
  // leaking in both). A local path must be scrubbed to the placeholder; the
  // MCP-only unsafe structured keys (`config`, anything containing `sourceLocator`)
  // must be dropped while a sibling key survives.
  const leakTitle = 'notes /Users/someone/secret/path.md marker';
  const redactionPlaceholder = '[local-path-redacted]';
  const sensitiveMetadata = {
    config: { apiKey: 'sk-should-be-dropped' },
    keepMe: 'retained-value',
    sourceLocator: '/Users/someone/secret/locator',
  };

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
    sessionId = imported.session.id;

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

    // Seed the sensitive title + metadata BEFORE the oracle snapshot so both the
    // stdio oracle and the live service see identical data — parity proves the
    // duplicated redaction matches, and the dedicated test proves it is correct.
    await service.sql`
      update sessions
      set title = ${leakTitle}, metadata = ${JSON.stringify(sensitiveMetadata)}::jsonb
      where id = ${sessionId} and workspace_id = ${workspaceId}
    `;

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
    // Pin the oracle to lexical DETERMINISTICALLY regardless of the host env: with
    // no embedding credential resolvable, recall can never take the vector path
    // (which would diverge scores/ordering from the lexical-only service). Point
    // HOME/CODEX_HOME/SAGA_HOME at an empty dir and strip any OPENAI key so no
    // cached credential is found.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: sagaHome,
      HOME: sagaHome,
      SAGA_DATABASE_URL: scopedUrl,
      SAGA_HOME: sagaHome,
    };
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_API_KEY_FILE;

    const result = spawnSync(process.execPath, [cliBin, 'mcp'], {
      cwd: bindingDir,
      encoding: 'utf8',
      env,
      input: `${all.map((request) => JSON.stringify(request)).join('\n')}\n`,
      // Fail fast rather than hang the suite if `saga mcp` never terminates, and
      // allow a generous stdout buffer for the largest structured response.
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(
        `stdio MCP oracle failed (status ${String(result.status)}, signal ${String(result.signal)}): ${String(result.error ?? '')}\n${result.stderr}`,
      );
    }
    const responses = new Map<number, JsonRpcResponse>();
    for (const line of result.stdout.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      // Tolerate a stray banner/warning line on stdout: a JSON-RPC response is a
      // single JSON object per line, so skip anything that does not parse.
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(trimmed) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof response.id === 'number') {
        responses.set(response.id, response);
      }
    }
    return responses;
  }

  // Fetch an oracle response by id with a readable failure, so a missing response
  // fails the assertion clearly instead of surfacing as `undefined` deep in a diff.
  function oracleResponse(id: number): JsonRpcResponse {
    const response = oracle.get(id);
    if (response === undefined) {
      throw new Error(`stdio MCP oracle produced no response for request id ${String(id)}`);
    }
    return response;
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
    expect(jsonify(oracleResponse(1))).toStrictEqual(await postMcp(requests.initialize));
  });

  test('tools/list exposes the identical tool set', async () => {
    expect(jsonify(oracleResponse(2))).toStrictEqual(await postMcp(requests.toolsList));
  });

  test('list_recent_sessions structuredContent + markdown match', async () => {
    expect(jsonify(oracleResponse(3))).toStrictEqual(await postMcp(requests.recent));
  });

  test('search_sessions matches (modulo per-call searchedAt + posture)', async () => {
    const viaService = await postMcp(requests.search);
    expect(normalizeSearch(oracleResponse(4))).toStrictEqual(normalizeSearch(viaService));
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
    expect(jsonify(oracleResponse(5))).toStrictEqual(await postMcp(requests.context));
  });

  test('a removed tool yields the identical unknown-tool error', async () => {
    const viaService = await postMcp(requests.removed);
    expect(jsonify(oracleResponse(6))).toStrictEqual(viaService);
    expect(viaService.error?.message).toBe('unknown Saga MCP tool: get_active_context');
  });

  // Correctness, independent of the equality check: a shared redaction regression
  // would leak in BOTH the service and the oracle and keep parity green. Assert the
  // SERVICE structured output actually scrubs the seeded sensitive values.
  test('service structuredContent scrubs local paths and drops unsafe keys', async () => {
    const viaService = await postMcp(requests.recent);
    const sessions = (
      viaService.result as { structuredContent: { sessions: Record<string, unknown>[] } }
    ).structuredContent.sessions;
    const record = sessions.find((entry) => (entry.session as { id?: string }).id === sessionId);
    expect(record).toBeDefined();
    const session = (record as { session: Record<string, unknown> }).session;

    // The local path in the title is scrubbed to the placeholder.
    expect(session.title).not.toContain('/Users/');
    expect(session.title).toContain(redactionPlaceholder);

    // The MCP-only unsafe structured keys are dropped; a sibling key survives.
    const metadata = session.metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty('config');
    expect(metadata).not.toHaveProperty('sourceLocator');
    expect(metadata.keepMe).toBe('retained-value');

    // No '/Users/' path survives anywhere in the STRUCTURED content (title scrubbed,
    // sourceLocator dropped). Note: the markdown `- Title:` line renders the raw
    // title unredacted — that is the stdio server's existing behavior, faithfully
    // duplicated here (the parity tests prove both surfaces match), and out of scope
    // for this slice; the structured payload is the machine-read contract.
    expect(JSON.stringify(session)).not.toContain('/Users/');
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

  test('a malformed workspaceId is rejected at the boundary with no driver text', async () => {
    const response = await fetch(`${(handle ?? fail()).url}/mcp?workspaceId=not-a-uuid`, {
      body: JSON.stringify({
        id: 8,
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
    expect(body.error?.message).toBe('workspaceId query parameter must be a valid UUID');
    // The malformed value never reaches the pg uuid cast, so no driver text leaks.
    expect(body.error?.message).not.toContain('invalid input syntax');
    expect(body.error?.message).not.toContain('uuid:');
  });
});

function fail(): never {
  throw new Error('service MCP parity fixture was not initialized');
}
