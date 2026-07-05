#!/usr/bin/env node

// SGA-224 regression guard (ADR-0044). A compiled/installed saga binary must
// resolve its database from explicit environment + installation config only, and
// never let a repo .env file select the database. That property rests entirely on
// building the binary with `--no-compile-autoload-dotenv` (Bun otherwise auto-loads
// repo .env into process.env at runtime, even for a standalone binary). This smoke
// runs the ACTUAL compiled artifact and fails if a repo .env can pick the database
// — so a future compile that drops the flag is caught in CI rather than silently
// pointing the production binary at the wrong Postgres.
//
// Usage: node scripts/smoke-compiled-config.mjs <path-to-compiled-saga>
// Run against release.yml's built artifact (not a rebuild) on each platform.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bin = process.argv[2];
if (bin === undefined || bin === '') {
  console.error('usage: node scripts/smoke-compiled-config.mjs <path-to-compiled-saga>');
  process.exit(1);
}

// Unreachable-but-fast addresses: 127.0.0.1:1 refuses immediately. The database
// source label is computed before doctor attempts the connect, so a refused
// connection never affects the assertion.
const installConfigUrl = 'postgres://127.0.0.1:1/installcfg';
const dotenvUrl = 'postgres://127.0.0.1:1/dotenv';
const exportUrl = 'postgres://127.0.0.1:1/export';

const cwd = mkdtempSync(join(tmpdir(), 'saga-compiled-config-'));
const sagaHome = mkdtempSync(join(tmpdir(), 'saga-compiled-config-home-'));
let failed = false;

try {
  writeFileSync(
    join(sagaHome, 'config.json'),
    JSON.stringify({ database: { url: installConfigUrl } }),
  );
  writeFileSync(join(cwd, '.env'), `SAGA_DATABASE_URL=${dotenvUrl}\n`);

  // (a) No exported SAGA_DATABASE_URL: the repo .env must be ignored, so the
  // database resolves from the installation config.
  assertSource({
    label: 'repo .env ignored -> installation config',
    expected: 'installation config',
    env: withoutKeys({ ...process.env, HOME: sagaHome, SAGA_HOME: sagaHome }, [
      'SAGA_DATABASE_URL',
      'SAGA_DATABASE_URL_FILE',
      'DATABASE_URL',
    ]),
  });

  // (b) A genuine exported SAGA_DATABASE_URL wins.
  assertSource({
    label: 'real export wins -> environment',
    expected: 'environment',
    env: withoutKeys(
      { ...process.env, HOME: sagaHome, SAGA_HOME: sagaHome, SAGA_DATABASE_URL: exportUrl },
      ['SAGA_DATABASE_URL_FILE', 'DATABASE_URL'],
    ),
  });

  console.log('compiled-binary config smoke passed');
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(cwd, { force: true, recursive: true });
  rmSync(sagaHome, { force: true, recursive: true });
}

process.exit(failed ? 1 : 0);

function assertSource({ label, expected, env }) {
  const detail = databaseConfigDetail(env);
  if (detail === undefined) {
    throw new Error(`${label}: doctor produced no 'database config' check`);
  }
  // The source line reads "SAGA_DATABASE_URL from <source>".
  if (!detail.includes(`from ${expected}`)) {
    throw new Error(`${label}: expected DB source "${expected}", got: "${detail}"`);
  }
  console.log(`ok: ${label} :: ${detail}`);
}

function databaseConfigDetail(env) {
  // Tolerate doctor's non-zero exit (the unreachable DB fails the postgres check)
  // and any other check noise; spawnSync captures stdout regardless of exit code.
  const result = spawnSync(bin, ['--format', 'json', 'doctor'], { cwd, env, encoding: 'utf8' });
  const stdout = result.stdout ?? '';
  let checks;
  try {
    checks = JSON.parse(stdout);
  } catch {
    throw new Error(
      `could not parse doctor JSON:\n${stdout.slice(0, 400)}\n${(result.stderr ?? '').slice(0, 400)}`,
    );
  }
  const check = Array.isArray(checks)
    ? checks.find((entry) => entry.label === 'database config')
    : undefined;
  return check?.detail;
}

function withoutKeys(env, keys) {
  const copy = { ...env };
  for (const key of keys) {
    delete copy[key];
  }
  return copy;
}
