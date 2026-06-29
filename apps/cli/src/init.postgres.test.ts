import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import postgres from 'postgres';
import { BINDING_FILE_NAME, initProject } from './init.js';

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres('initProject postgres integration', () => {
  const databaseName = `saga_init_${Date.now().toString(36)}`;
  const adminSql = postgres(databaseUrl ?? '', { max: 1 });
  let previousDatabaseUrl: string | undefined;
  let testDatabaseUrl: string | undefined;

  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    const url = new URL(databaseUrl ?? '');
    url.pathname = `/${databaseName}`;
    testDatabaseUrl = url.toString();
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = testDatabaseUrl;
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 5 });
  });

  test('registers a git workspace from a nested cwd and writes the local binding', async () => {
    if (testDatabaseUrl === undefined) throw new Error('test database URL was not initialized');
    const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'saga-init-e2e-')));
    const nested = join(projectRoot, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:dbtlr/saga-init-e2e.git'], {
      cwd: projectRoot,
      stdio: 'ignore',
    });

    const result = await initProject({ cwd: nested, handle: 'Init E2E' });
    const secondResult = await initProject({ cwd: nested, handle: 'Init E2E' });

    expect(result.projectRoot).toBe(projectRoot);
    expect(secondResult.projectRoot).toBe(projectRoot);
    expect(secondResult.registration.workspace.id).toBe(result.registration.workspace.id);
    expect(secondResult.registration.sourceBinding.id).toBe(result.registration.sourceBinding.id);
    expect(result.bindingPath).toBe(join(projectRoot, BINDING_FILE_NAME));
    const binding = JSON.parse(readFileSync(result.bindingPath, 'utf8')) as {
      project: { gitRemote?: string | undefined; root: string };
      sourceBinding: { id: string };
      workspace: { handle: string; id: string };
    };
    expect(binding).toMatchObject({
      project: {
        gitRemote: 'git@github.com:dbtlr/saga-init-e2e.git',
        root: projectRoot,
      },
      sourceBinding: {
        id: result.registration.sourceBinding.id,
      },
      workspace: {
        handle: 'init-e2e',
        id: result.registration.workspace.id,
      },
    });

    const sql = postgres(testDatabaseUrl, { max: 1 });
    try {
      const rows = await sql`
        select
          w.handle,
          s.source_type,
          s.source_uri,
          s.config->>'gitRemote' as git_remote,
          s.config->>'path' as path
        from workspaces w
        join source_bindings s on s.workspace_id = w.id
        where w.id = ${result.registration.workspace.id}
      `;
      expect(rows[0]).toMatchObject({
        git_remote: 'git@github.com:dbtlr/saga-init-e2e.git',
        handle: 'init-e2e',
        path: projectRoot,
        source_type: 'git',
        source_uri: expect.stringMatching(/^file:/u),
      });
      const counts = await sql`
        select
          (select count(*)::int from workspaces where handle = 'init-e2e') as workspace_count,
          (select count(*)::int from source_bindings where workspace_id = ${result.registration.workspace.id}) as source_count
      `;
      expect(counts[0]).toMatchObject({
        source_count: 1,
        workspace_count: 1,
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
