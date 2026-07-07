#!/usr/bin/env node

// HTTP MCP smoke (SGA-238): the service-hosted MCP twin. Seeds a workspace via the
// real CLI capture path (identical to smoke-mcp.mjs, which exercises the stdio MCP),
// boots the saga service against the same database, and drives POST /mcp end to end
// — initialize, tools/list, and each of the three session tools — asserting the
// captured session, recall match, and expanded context surface over HTTP. Runs
// alongside the untouched stdio smoke; both die into one path at the swap (SGA-249).

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cliBin = join(repoRoot, 'apps/cli/bin/saga.js');
const serviceEntry = join(repoRoot, 'apps/service/src/main.ts');
const requireFromCli = createRequire(new URL('../apps/cli/package.json', import.meta.url));
const postgresModule = await import(pathToFileURL(requireFromCli.resolve('postgres')).href);
const postgres = postgresModule.default;

const SESSION_TOOLS = ['list_recent_sessions', 'search_sessions', 'get_session_context'];

const adminDatabaseUrl = process.env.SAGA_TEST_DATABASE_URL?.trim();
if (adminDatabaseUrl === undefined || adminDatabaseUrl === '') {
  console.error('missing required environment variable: SAGA_TEST_DATABASE_URL');
  process.exit(1);
}

const databaseName = `saga_mcp_http_smoke_${Date.now().toString(36)}_${process.pid.toString(36)}`;
const adminSql = postgres(adminDatabaseUrl, { max: 1 });
let workspacePath;
let sagaHomePath;
let serviceProcess;
let failed = true;

try {
  await adminSql.unsafe(`create database "${databaseName}"`);
  const databaseUrl = new URL(adminDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;

  workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'saga-mcp-http-smoke-')));
  seedGitWorkspace(workspacePath);

  // An empty installation config home keeps remote embeddings disabled by policy
  // (ADR 0032): the service recall path is lexical-only here with no query egress.
  sagaHomePath = realpathSync(mkdtempSync(join(tmpdir(), 'saga-mcp-http-smoke-home-')));
  const env = {
    ...process.env,
    SAGA_DATABASE_URL: databaseUrl.toString(),
    SAGA_HOME: sagaHomePath,
  };

  run('bun', ['run', '--filter', '@saga/service', 'migrate'], { cwd: repoRoot, env });
  run(process.execPath, [cliBin, '--ascii', 'init', 'MCP HTTP Smoke'], { cwd: workspacePath, env });
  run(process.execPath, [cliBin, '--ascii', 'harness', 'install', 'codex'], {
    cwd: workspacePath,
    env,
  });
  writeFileSync(
    join(workspacePath, '.codex', 'mcp-http-smoke-transcript.jsonl'),
    [
      JSON.stringify({
        text: 'We should dogfood Saga capture before broad rollout.',
        type: 'user',
      }),
      JSON.stringify({
        text: 'The assistant agrees the dogfood capture loop is the next milestone.',
        type: 'assistant',
      }),
      '',
    ].join('\n'),
  );
  run(join(workspacePath, '.codex', 'saga-codex-hook.sh'), [], {
    cwd: workspacePath,
    env,
    input: JSON.stringify(codexHookPayload(workspacePath)),
  });

  const binding = JSON.parse(readFileSync(join(workspacePath, '.saga.local.json'), 'utf8'));
  const workspaceId = binding.workspace.id;

  // Boot the service against the seeded database on a free port (the config gate
  // rejects port 0); main.ts prints the bound URL, which we parse before requests.
  const port = await freePort();
  const started = await startService({
    ...env,
    SAGA_SERVICE_HOST: '127.0.0.1',
    SAGA_SERVICE_PORT: String(port),
  });
  serviceProcess = started.process;
  const baseUrl = started.url;

  const initialize = await postMcp(baseUrl, workspaceId, {
    id: 1,
    jsonrpc: '2.0',
    method: 'initialize',
  });
  assertInitialize(initialize);

  const toolList = await postMcp(baseUrl, workspaceId, {
    id: 2,
    jsonrpc: '2.0',
    method: 'tools/list',
  });
  assertToolList(toolList);

  const recent = await postMcp(baseUrl, workspaceId, {
    id: 3,
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { arguments: { limit: 5 }, name: 'list_recent_sessions' },
  });
  assertRecentSessionsResponse(recent);

  const search = await postMcp(baseUrl, workspaceId, {
    id: 4,
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { arguments: { limit: 5, query: 'dogfood capture' }, name: 'search_sessions' },
  });
  const segmentId = assertSearchSessionsResponse(search);

  const context = await postMcp(baseUrl, workspaceId, {
    id: 5,
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { arguments: { segmentId, windowTurns: 1 }, name: 'get_session_context' },
  });
  assertSessionContextResponse(context);

  console.log(`mcp http smoke passed: ${binding.workspace.handle}`);
  console.log(`service: ${baseUrl}`);
  console.log(`tools: ${SESSION_TOOLS.join(', ')}`);
  failed = false;
} finally {
  if (serviceProcess !== undefined) {
    serviceProcess.kill('SIGTERM');
  }
  await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
  await adminSql.end({ timeout: 5 });

  if (workspacePath !== undefined && !failed && process.env.SAGA_SMOKE_KEEP !== '1') {
    rmSync(workspacePath, { force: true, recursive: true });
  } else if (workspacePath !== undefined && failed) {
    console.error(`smoke workspace kept for inspection: ${workspacePath}`);
  }
  if (sagaHomePath !== undefined) {
    rmSync(sagaHomePath, { force: true, recursive: true });
  }
}

function seedGitWorkspace(projectRoot) {
  const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify(
      {
        engines: rootPackageJson.engines,
        name: 'saga-mcp-http-smoke',
        private: true,
        version: '0.0.0',
      },
      null,
      2,
    )}\n`,
  );
  execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'git@example.com:saga/mcp-http-smoke.git'], {
    cwd: projectRoot,
    stdio: 'ignore',
  });
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(join(projectRoot, 'src/index.ts'), 'export const mcpHttpSmoke = true;\n');
}

function codexHookPayload(projectRoot) {
  return {
    cwd: projectRoot,
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-5',
    permission_mode: 'workspace-write',
    prompt: 'We should dogfood Saga capture before broad rollout.',
    session_id: 'mcp-http-smoke-session',
    transcript_path: join(projectRoot, '.codex', 'mcp-http-smoke-transcript.jsonl'),
    turn_id: 'mcp-http-smoke-turn-1',
  };
}

// Ask the OS for an ephemeral port, then hand it to the service. A brief race
// window exists between close and the service's bind, acceptable for a smoke.
function freePort() {
  return new Promise((_resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => _resolve(port));
    });
  });
}

// Boot apps/service/main.ts under bun with cwd at the seeded workspace (a git repo
// with no .env), so its runtime config resolves the database strictly from the env
// we pass. Resolves once the listening URL is printed; rejects on early exit.
function startService(env) {
  return new Promise((_resolve, reject) => {
    const child = spawn('bun', [serviceEntry], {
      cwd: workspacePath,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const deadline = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`service did not report a listening URL in time\n${stdout}\n${stderr}`));
    }, 60_000);

    const listeningPattern = /listening on (http:\/\/\S+)/u;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const match = listeningPattern.exec(stdout);
      if (match !== null) {
        clearTimeout(deadline);
        _resolve({ process: child, url: match[1] });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('exit', (code) => {
      clearTimeout(deadline);
      reject(new Error(`service exited early (code ${String(code)})\n${stdout}\n${stderr}`));
    });
  });
}

async function postMcp(baseUrl, workspaceId, request) {
  const response = await fetch(`${baseUrl}/mcp?workspaceId=${workspaceId}`, {
    body: JSON.stringify(request),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`POST /mcp ${request.method} returned HTTP ${String(response.status)}`);
  }
  return response.json();
}

function assertOk(response, label) {
  if (response?.error !== undefined) {
    throw new Error(`${label} failed: ${json(response)}`);
  }
  return response?.result;
}

function assertInitialize(response) {
  const result = assertOk(response, 'initialize');
  if (result?.serverInfo?.name !== 'saga') {
    throw new Error(`initialize did not return the saga server info: ${json(result)}`);
  }
}

function assertToolList(response) {
  const result = assertOk(response, 'tools/list');
  const names = (result?.tools ?? []).map((tool) => tool?.name);
  if (JSON.stringify(names) !== JSON.stringify(SESSION_TOOLS)) {
    throw new Error(
      `tools/list must expose exactly the session capture and recall tools: ${json(names)}`,
    );
  }
}

function assertRecentSessionsResponse(response) {
  const result = assertOk(response, 'list_recent_sessions');
  if (!toolText(result).includes('mcp-http-smoke-session')) {
    throw new Error(`list_recent_sessions did not include the captured session: ${json(result)}`);
  }
  const sessions = result?.structuredContent?.sessions;
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new Error(`list_recent_sessions structured sessions were empty: ${json(result)}`);
  }
}

function assertSearchSessionsResponse(response) {
  const result = assertOk(response, 'search_sessions');
  if (!toolText(result).includes('dogfood')) {
    throw new Error(`search_sessions text did not include dogfood matches: ${json(result)}`);
  }
  const segmentId = result?.structuredContent?.sessions?.[0]?.matches?.[0]?.segment?.id;
  if (typeof segmentId !== 'string' || segmentId === '') {
    throw new Error(`search_sessions did not return a matched segment id: ${json(result)}`);
  }
  return segmentId;
}

function assertSessionContextResponse(response) {
  const result = assertOk(response, 'get_session_context');
  const text = toolText(result);
  if (!text.includes('dogfood Saga capture') || !text.includes('next milestone')) {
    throw new Error(`get_session_context did not expand surrounding turns: ${json(result)}`);
  }
}

function toolText(result) {
  return result?.content
    ?.map((entry) => (entry?.type === 'text' && typeof entry.text === 'string' ? entry.text : ''))
    .join('\n');
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(' ')} failed with exit code ${String(result.status)}`,
        result.stdout,
        result.stderr,
      ]
        .filter((part) => part.trim() !== '')
        .join('\n'),
    );
  }

  return result.stdout;
}

function json(value) {
  return JSON.stringify(value, null, 2);
}
