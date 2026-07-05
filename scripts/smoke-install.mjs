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

const databaseName = `saga_smoke_${Date.now().toString(36)}_${process.pid.toString(36)}`;
const adminSql = postgres(adminDatabaseUrl, { max: 1 });
let workspacePath;
let failed = true;

try {
  await adminSql.unsafe(`create database "${databaseName}"`);
  const databaseUrl = new URL(adminDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;

  workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'saga-install-smoke-')));
  seedGitWorkspace(workspacePath);

  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl.toString(),
  };

  run('bun', ['run', '--filter', '@saga/service', 'migrate'], { cwd: repoRoot, env });
  run(process.execPath, [cliBin, '--ascii', 'init', 'Install Smoke'], { cwd: workspacePath, env });
  const doctor = JSON.parse(
    run(process.execPath, [cliBin, '--format', 'json', '--ascii', 'doctor'], {
      cwd: workspacePath,
      env,
    }),
  );
  assertDoctor(doctor);

  const bindingPath = join(workspacePath, '.saga.local.json');
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8'));
  assertBinding(binding);

  console.log(`fresh workspace install smoke passed: ${binding.workspace.handle}`);
  console.log(`workspace id: ${binding.workspace.id}`);
  console.log(`source binding id: ${binding.sourceBinding.id}`);
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
        name: 'saga-install-smoke',
        private: true,
        version: '0.0.0',
      },
      null,
      2,
    )}\n`,
  );
  execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'git@example.com:saga/install-smoke.git'], {
    cwd: projectRoot,
    stdio: 'ignore',
  });
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(join(projectRoot, 'src/index.ts'), 'export const smoke = true;\n');
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
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

function assertDoctor(value) {
  if (!Array.isArray(value)) {
    throw new Error('doctor JSON output was not an array');
  }

  const failures = value.filter((check) => check?.status === 'fail');
  if (failures.length > 0) {
    throw new Error(`doctor reported failing checks: ${JSON.stringify(failures, null, 2)}`);
  }

  for (const label of ['binding', 'postgres', 'migrations']) {
    const check = value.find((item) => item?.label === label);
    if (check?.status !== 'ok') {
      throw new Error(`${label} check was not ok: ${JSON.stringify(check)}`);
    }
  }
}

function assertBinding(value) {
  if (value?.workspace?.handle !== 'install-smoke') {
    throw new Error(`unexpected workspace handle in binding: ${JSON.stringify(value)}`);
  }

  if (typeof value?.workspace?.id !== 'string' || value.workspace.id === '') {
    throw new Error('binding is missing workspace.id');
  }

  if (typeof value?.sourceBinding?.id !== 'string' || value.sourceBinding.id === '') {
    throw new Error('binding is missing sourceBinding.id');
  }

  if (value?.service?.databaseUrl !== 'env:DATABASE_URL') {
    throw new Error(`unexpected binding service config: ${JSON.stringify(value.service)}`);
  }
}
