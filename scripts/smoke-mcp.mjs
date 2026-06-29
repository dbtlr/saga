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

const adminDatabaseUrl = process.env.SAGA_TEST_DATABASE_URL?.trim();
if (adminDatabaseUrl === undefined || adminDatabaseUrl === '') {
  console.error('missing required environment variable: SAGA_TEST_DATABASE_URL');
  process.exit(1);
}

const databaseName = `saga_mcp_smoke_${Date.now().toString(36)}_${process.pid.toString(36)}`;
const adminSql = postgres(adminDatabaseUrl, { max: 1 });
let workspacePath;
let failed = true;

try {
  await adminSql.unsafe(`create database "${databaseName}"`);
  const databaseUrl = new URL(adminDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;

  workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'saga-mcp-smoke-')));
  seedGitWorkspace(workspacePath);

  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl.toString(),
  };

  run('pnpm', ['--filter', '@saga/service', 'migrate'], { cwd: repoRoot, env });
  run(process.execPath, [cliBin, '--ascii', 'init', 'MCP Smoke'], { cwd: workspacePath, env });
  run(process.execPath, [cliBin, '--ascii', 'harness', 'install', 'codex'], {
    cwd: workspacePath,
    env,
  });
  run(join(workspacePath, '.codex', 'saga-codex-hook.sh'), [], {
    cwd: workspacePath,
    env,
    input: JSON.stringify(codexHookPayload(workspacePath)),
  });

  const binding = JSON.parse(readFileSync(join(workspacePath, '.saga.local.json'), 'utf8'));
  await seedContextIndex(databaseUrl.toString(), binding);

  const responses = runMcpRequests(workspacePath, env, [
    {
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name: 'get_active_context' },
    },
    {
      id: 2,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: { limit: 5, query: 'dogfood capture' },
        name: 'search_memory',
      },
    },
    {
      id: 3,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: { link: 'saga:context/dogfood-note' },
        name: 'resolve_saga_link',
      },
    },
  ]);

  assertActiveContextResponse(responses.get(1));
  assertSearchResponse(responses.get(2));
  assertResolveResponse(responses.get(3));

  console.log(`mcp smoke passed: ${binding.workspace.handle}`);
  console.log('tools: get_active_context, search_memory, resolve_saga_link');
  failed = false;
} finally {
  await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
  await adminSql.end({ timeout: 5 });

  if (workspacePath !== undefined && !failed && process.env.SAGA_SMOKE_KEEP !== '1') {
    rmSync(workspacePath, { force: true, recursive: true });
  } else if (workspacePath !== undefined && failed) {
    console.error(`smoke workspace kept for inspection: ${workspacePath}`);
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

async function seedContextIndex(databaseUrl, binding) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [source] = await sql`
      insert into source_bindings (
        workspace_id,
        source_type,
        source_uri,
        display_name,
        enabled,
        config
      )
      values (
        ${binding.workspace.id},
        'document',
        'https://docs.example.test/saga',
        'Dogfood Docs',
        true,
        '{}'::jsonb
      )
      returning id
    `;

    await sql`
      insert into context_index_entries (
        workspace_id,
        source_binding_id,
        key,
        title,
        description,
        external_id,
        saga_link,
        importance,
        include_policy,
        metadata
      )
      values (
        ${binding.workspace.id},
        ${source.id},
        'dogfood-note',
        'Dogfood Capture Note',
        'Smoke seeded retrieval door for MCP Saga Link resolution.',
        'notes/dogfood-capture.md',
        'saga:context/dogfood-note',
        0.91,
        'always',
        ${sql.json({
          content: 'Dogfood capture evidence should be available through MCP Saga Link resolution.',
        })}
      )
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
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
    if (response.error !== undefined) {
      throw new Error(`MCP request failed: ${line}`);
    }
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

function assertActiveContextResponse(response) {
  const result = response?.result;
  if (!toolText(result).includes('codex.UserPromptSubmit')) {
    throw new Error(
      `get_active_context text did not include recent hook activity: ${json(result)}`,
    );
  }

  const sections = result?.structuredContent?.sections;
  if (!Array.isArray(sections)) {
    throw new Error(`get_active_context structured content was missing sections: ${json(result)}`);
  }
}

function assertSearchResponse(response) {
  const result = response?.result;
  if (!toolText(result).includes('dogfood')) {
    throw new Error(`search_memory text did not include dogfood matches: ${json(result)}`);
  }

  const matches = result?.structuredContent?.matches;
  if (!Array.isArray(matches) || matches.length === 0) {
    throw new Error(`search_memory structured matches were empty: ${json(result)}`);
  }
}

function assertResolveResponse(response) {
  const result = response?.result;
  if (!toolText(result).includes('Dogfood capture evidence')) {
    throw new Error(`resolve_saga_link text did not include retrieved content: ${json(result)}`);
  }

  const resolved = result?.structuredContent;
  if (resolved?.entry?.sagaLink !== 'saga:context/dogfood-note') {
    throw new Error(`resolve_saga_link structured content had wrong link: ${json(result)}`);
  }

  if (
    resolved?.retrieval?.target?.url !== 'https://docs.example.test/saga/notes/dogfood-capture.md'
  ) {
    throw new Error(`resolve_saga_link target URL was wrong: ${json(result)}`);
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
