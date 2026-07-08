#!/usr/bin/env node

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

const adminDatabaseUrl = process.env.SAGA_TEST_DATABASE_URL?.trim();
if (adminDatabaseUrl === undefined || adminDatabaseUrl === '') {
  console.error('missing required environment variable: SAGA_TEST_DATABASE_URL');
  process.exit(1);
}

const databaseName = `saga_codex_smoke_${Date.now().toString(36)}_${process.pid.toString(36)}`;
const adminSql = postgres(adminDatabaseUrl, { max: 1 });
let workspacePath;
let serviceProcess;
let failed = true;

try {
  await adminSql.unsafe(`create database "${databaseName}"`);
  const databaseUrl = new URL(adminDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;

  workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'saga-codex-loop-smoke-')));
  seedGitWorkspace(workspacePath);

  const env = {
    ...process.env,
    SAGA_DATABASE_URL: databaseUrl.toString(),
  };

  run('bun', ['run', '--filter', '@saga/service', 'migrate'], { cwd: repoRoot, env });
  run(process.execPath, [cliBin, '--ascii', 'init', 'Codex Loop Smoke'], {
    cwd: workspacePath,
    env,
  });
  run(process.execPath, [cliBin, '--ascii', 'harness', 'install', 'codex'], {
    cwd: workspacePath,
    env,
  });

  // Boot the service against the seeded database on a free port (the config gate
  // rejects port 0); main.ts prints the bound URL, which we parse before requests.
  // Booted BEFORE the codex hook runs: the hook POSTs to SAGA_SERVICE_URL and
  // silently no-ops under the {continue:true} contract when the service is down.
  // `saga ingest recent` / `saga sessions recent` (both API-backed) resolve the
  // same service from SAGA_SERVICE_URL, so the same env carries it through all three.
  const port = await freePort();
  const started = await startService({
    ...env,
    SAGA_SERVICE_HOST: '127.0.0.1',
    SAGA_SERVICE_PORT: String(port),
  });
  serviceProcess = started.process;
  const serviceEnv = { ...env, SAGA_SERVICE_URL: started.url };

  writeFileSync(
    join(workspacePath, '.codex', 'smoke-transcript.jsonl'),
    [
      JSON.stringify({
        text: 'We should dogfood Saga capture before broad rollout.',
        type: 'user',
      }),
      '',
    ].join('\n'),
  );
  const hookResult = run(join(workspacePath, '.codex', 'saga-codex-hook.sh'), [], {
    cwd: workspacePath,
    env: serviceEnv,
    input: JSON.stringify(codexHookPayload(workspacePath)),
  });
  assertHookResult(hookResult);

  // Codex's pending-trust gate only flips to configured once a real hook raw_event
  // is on record (harness.ts activation evidence), so this check has to run after
  // the hook fires, not right after install. It queries Postgres directly
  // (SAGA_DATABASE_URL) — `harness status` is a host-ops command, not API-backed —
  // so the plain env works here too.
  const status = JSON.parse(
    run(process.execPath, [cliBin, '--format', 'json', '--ascii', 'harness', 'status', 'codex'], {
      cwd: workspacePath,
      env,
    }),
  );
  assertCodexHarnessStatus(status);

  const recent = JSON.parse(
    run(process.execPath, [cliBin, '--format', 'json', '--ascii', 'ingest', 'recent'], {
      cwd: workspacePath,
      env: serviceEnv,
    }),
  );
  assertRecentEvents(recent);

  // /v1/ingest stores the raw event synchronously, but the session is derived
  // asynchronously by the service's extraction job; poll until it lands.
  const sessions = await pollForCapturedSession(serviceEnv);
  assertCapturedSession(sessions);

  console.log('codex hook capture smoke passed');
  console.log(`raw events: ${recent.length.toString()}`);
  console.log(`sessions: ${sessions.length.toString()}`);
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
}

function seedGitWorkspace(projectRoot) {
  const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify(
      {
        engines: rootPackageJson.engines,
        name: 'saga-codex-loop-smoke',
        private: true,
        version: '0.0.0',
      },
      null,
      2,
    )}\n`,
  );
  execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'git@example.com:saga/codex-loop-smoke.git'], {
    cwd: projectRoot,
    stdio: 'ignore',
  });
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(join(projectRoot, 'src/index.ts'), 'export const codexLoopSmoke = true;\n');
}

function codexHookPayload(projectRoot) {
  return {
    cwd: projectRoot,
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-5',
    permission_mode: 'workspace-write',
    prompt: 'We should dogfood Saga capture before broad rollout.',
    session_id: 'codex-loop-smoke-session',
    transcript_path: join(projectRoot, '.codex', 'smoke-transcript.jsonl'),
    turn_id: 'codex-loop-smoke-turn-1',
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

// Polls `saga sessions recent` until the captured session shows up (extraction
// runs asynchronously after /v1/ingest returns) or the deadline passes.
async function pollForCapturedSession(env, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const sessions = JSON.parse(
      run(process.execPath, [cliBin, '--format', 'json', '--ascii', 'sessions', 'recent'], {
        cwd: workspacePath,
        env,
      }),
    );
    last = sessions;
    if (
      Array.isArray(sessions) &&
      sessions.some((row) => row?.session?.harnessSessionId === 'codex-loop-smoke-session')
    ) {
      return sessions;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `timed out waiting for the captured session to be extracted: ${JSON.stringify(last, null, 2)}`,
  );
}

function sleep(ms) {
  return new Promise((_resolve) => setTimeout(_resolve, ms));
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

function assertCodexHarnessStatus(value) {
  if (value?.target !== 'codex' || value?.state !== 'configured') {
    throw new Error(`Codex harness was not configured: ${JSON.stringify(value, null, 2)}`);
  }

  if (value?.hooksCoverage !== 'complete' || value?.hooks !== 'installed') {
    throw new Error(`Codex hooks were not complete: ${JSON.stringify(value, null, 2)}`);
  }
}

function assertHookResult(stdout) {
  const parsed = JSON.parse(stdout);
  if (parsed?.continue !== true) {
    throw new Error(`Codex hook did not return a continuation response: ${stdout}`);
  }
  if (parsed.systemMessage !== undefined) {
    throw new Error(`Codex hook reported skipped capture: ${stdout}`);
  }
}

function assertRecentEvents(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`recent raw events were empty: ${JSON.stringify(value)}`);
  }

  const event = value.find((entry) => entry?.eventType === 'codex.UserPromptSubmit');
  if (event === undefined) {
    throw new Error(`Codex prompt event was not captured: ${JSON.stringify(value, null, 2)}`);
  }

  if (event.payload?.prompt !== 'We should dogfood Saga capture before broad rollout.') {
    throw new Error(`Codex prompt payload was not preserved: ${JSON.stringify(event, null, 2)}`);
  }
}

function assertCapturedSession(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`recent sessions were empty: ${JSON.stringify(value)}`);
  }

  const entry = value.find((row) => row?.session?.harnessSessionId === 'codex-loop-smoke-session');
  if (entry === undefined) {
    throw new Error(`Codex session was not captured: ${JSON.stringify(value, null, 2)}`);
  }
}
