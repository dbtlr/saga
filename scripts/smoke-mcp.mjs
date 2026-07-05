#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cliBin = join(repoRoot, 'apps/cli/bin/saga.js');
const requireFromCli = createRequire(new URL('../apps/cli/package.json', import.meta.url));
const postgresModule = await import(pathToFileURL(requireFromCli.resolve('postgres')).href);
const postgres = postgresModule.default;

const SESSION_TOOLS = ['list_recent_sessions', 'search_sessions', 'get_session_context'];
const REMOVED_TOOLS = ['get_active_context', 'search_memory', 'resolve_saga_link'];

const adminDatabaseUrl = process.env.SAGA_TEST_DATABASE_URL?.trim();
if (adminDatabaseUrl === undefined || adminDatabaseUrl === '') {
  console.error('missing required environment variable: SAGA_TEST_DATABASE_URL');
  process.exit(1);
}

const databaseName = `saga_mcp_smoke_${Date.now().toString(36)}_${process.pid.toString(36)}`;
const adminSql = postgres(adminDatabaseUrl, { max: 1 });
let workspacePath;
let sagaHomePath;
let failed = true;

try {
  await adminSql.unsafe(`create database "${databaseName}"`);
  const databaseUrl = new URL(adminDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;

  workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'saga-mcp-smoke-')));
  seedGitWorkspace(workspacePath);

  // An empty installation config home keeps remote embeddings disabled by
  // policy (ADR 0032): the search below stays lexical with no query egress.
  sagaHomePath = realpathSync(mkdtempSync(join(tmpdir(), 'saga-mcp-smoke-home-')));
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl.toString(),
    SAGA_HOME: sagaHomePath,
  };

  run('bun', ['run', '--filter', '@saga/service', 'migrate'], { cwd: repoRoot, env });
  run(process.execPath, [cliBin, '--ascii', 'init', 'MCP Smoke'], { cwd: workspacePath, env });
  run(process.execPath, [cliBin, '--ascii', 'harness', 'install', 'codex'], {
    cwd: workspacePath,
    env,
  });
  writeFileSync(
    join(workspacePath, '.codex', 'mcp-smoke-transcript.jsonl'),
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

  const responses = runMcpRequests(workspacePath, env, [
    { id: 1, jsonrpc: '2.0', method: 'tools/list' },
    {
      id: 2,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { limit: 5 }, name: 'list_recent_sessions' },
    },
    {
      id: 3,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: { limit: 5, query: 'dogfood capture' },
        name: 'search_sessions',
      },
    },
  ]);

  assertToolList(responses.get(1));
  assertRecentSessionsResponse(responses.get(2));
  const segmentId = assertSearchSessionsResponse(responses.get(3));

  const contextResponses = runMcpRequests(workspacePath, env, [
    {
      id: 4,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: { segmentId, windowTurns: 1 },
        name: 'get_session_context',
      },
    },
    ...REMOVED_TOOLS.map((name, index) => ({
      id: 5 + index,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name },
    })),
  ]);

  assertSessionContextResponse(contextResponses.get(4));
  for (const [index, name] of REMOVED_TOOLS.entries()) {
    assertRemovedToolResponse(contextResponses.get(5 + index), name);
  }

  console.log(`mcp smoke passed: ${binding.workspace.handle}`);
  console.log(`tools: ${SESSION_TOOLS.join(', ')}`);
  failed = false;
} finally {
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
        name: 'saga-mcp-smoke',
        private: true,
        version: '0.0.0',
      },
      null,
      2,
    )}\n`,
  );
  execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'git@example.com:saga/mcp-smoke.git'], {
    cwd: projectRoot,
    stdio: 'ignore',
  });
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(join(projectRoot, 'src/index.ts'), 'export const mcpSmoke = true;\n');
}

function codexHookPayload(projectRoot) {
  return {
    cwd: projectRoot,
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-5',
    permission_mode: 'workspace-write',
    prompt: 'We should dogfood Saga capture before broad rollout.',
    session_id: 'mcp-smoke-session',
    transcript_path: join(projectRoot, '.codex', 'mcp-smoke-transcript.jsonl'),
    turn_id: 'mcp-smoke-turn-1',
  };
}

function runMcpRequests(cwd, env, requests) {
  const stdout = run(process.execPath, [cliBin, 'mcp'], {
    cwd,
    env,
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
  });
  const responses = new Map();
  for (const line of stdout.split(/\r?\n/).filter((entry) => entry.trim() !== '')) {
    const response = JSON.parse(line);
    responses.set(response.id, response);
  }
  return responses;
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

function assertOk(response, label) {
  if (response?.error !== undefined) {
    throw new Error(`${label} failed: ${json(response)}`);
  }
  return response?.result;
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
  if (!toolText(result).includes('mcp-smoke-session')) {
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

function assertRemovedToolResponse(response, name) {
  const message = response?.error?.message;
  if (message !== `unknown Saga MCP tool: ${name}`) {
    throw new Error(`removed tool ${name} should be unknown, got: ${json(response)}`);
  }
}

function toolText(result) {
  return result?.content
    ?.map((entry) => (entry?.type === 'text' && typeof entry.text === 'string' ? entry.text : ''))
    .join('\n');
}

function json(value) {
  return JSON.stringify(value, null, 2);
}
