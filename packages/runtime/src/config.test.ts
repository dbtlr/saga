import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Exit } from 'effect';
import { assert, describe, expect, it, test } from 'vitest';

import {
  ConfigError,
  RuntimeConfigLive,
  RuntimeConfigTag,
  loadLocalEnv,
  loadRuntimeConfig,
  parseRuntimeConfig,
  redactRuntimeConfig,
} from './config.js';

describe('parseRuntimeConfig', () => {
  it('applies defaults and reads known environment values', () => {
    const { config, issues } = parseRuntimeConfig({
      SAGA_DATABASE_URL: 'postgres://localhost/saga',
      OPENAI_API_KEY: 'sk-test',
      SAGA_ENV: 'test',
      SAGA_LOG_LEVEL: 'debug',
    });

    expect(issues).toStrictEqual([]);
    expect(config).toStrictEqual({
      databaseUrl: 'postgres://localhost/saga',
      databaseUrlSource: 'environment',
      environment: 'test',
      logLevel: 'debug',
      service: {
        host: '127.0.0.1',
        port: 4766,
      },
      secrets: {
        openaiApiKey: 'sk-test',
      },
    });
  });

  it('parses service host and port', () => {
    const { config, issues } = parseRuntimeConfig({
      SAGA_SERVICE_HOST: '0.0.0.0',
      SAGA_SERVICE_PORT: '5000',
    });

    expect(issues).toStrictEqual([]);
    expect(config.service).toStrictEqual({
      host: '0.0.0.0',
      port: 5000,
    });
  });

  it('loads secret-bearing values from file indirection', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const databaseUrlFile = join(cwd, 'database-url');
    const openAiKeyFile = join(cwd, 'openai-key');
    writeFileSync(databaseUrlFile, 'postgres://file/saga\n');
    writeFileSync(openAiKeyFile, 'sk-file\n');

    const { config, issues } = parseRuntimeConfig({
      SAGA_DATABASE_URL_FILE: databaseUrlFile,
      OPENAI_API_KEY_FILE: openAiKeyFile,
    });

    expect(issues).toStrictEqual([]);
    expect(config.databaseUrl).toBe('postgres://file/saga');
    expect(config.secrets.openaiApiKey).toBe('sk-file');
  });

  it('prefers direct secret-bearing env values over file indirection', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const databaseUrlFile = join(cwd, 'database-url');
    writeFileSync(databaseUrlFile, 'postgres://file/saga\n');

    const { config, issues } = parseRuntimeConfig({
      SAGA_DATABASE_URL: 'postgres://direct/saga',
      SAGA_DATABASE_URL_FILE: databaseUrlFile,
    });

    expect(issues).toStrictEqual([]);
    expect(config.databaseUrl).toBe('postgres://direct/saga');
  });

  it('returns validation issues for unreadable secret files', () => {
    const { config, issues } = parseRuntimeConfig({
      OPENAI_API_KEY_FILE: '/tmp/saga-missing-secret-file',
    });

    expect(config.secrets.openaiApiKey).toBeUndefined();
    expect(issues).toStrictEqual([
      expect.objectContaining({
        key: 'OPENAI_API_KEY_FILE',
      }),
    ]);
  });

  it('returns validation issues for blank secret files', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const openAiKeyFile = join(cwd, 'openai-key');
    writeFileSync(openAiKeyFile, '\n');

    const { config, issues } = parseRuntimeConfig({
      OPENAI_API_KEY_FILE: openAiKeyFile,
    });

    expect(config.secrets.openaiApiKey).toBeUndefined();
    expect(issues).toStrictEqual([
      {
        key: 'OPENAI_API_KEY_FILE',
        message: `secret file ${openAiKeyFile} is empty`,
      },
    ]);
  });

  it('returns validation issues for invalid enum values', () => {
    const { config, issues } = parseRuntimeConfig({
      SAGA_ENV: 'local',
      SAGA_LOG_LEVEL: 'trace',
      SAGA_SERVICE_PORT: 'nope',
    });

    expect(config.environment).toBe('development');
    expect(config.logLevel).toBe('info');
    expect(issues).toStrictEqual([
      { key: 'SAGA_ENV', message: 'expected one of development, test, production' },
      { key: 'SAGA_LOG_LEVEL', message: 'expected one of debug, info, warn, error' },
      { key: 'SAGA_SERVICE_PORT', message: 'expected an integer from 1 to 65535' },
    ]);
  });
});

describe('redactRuntimeConfig', () => {
  it('redacts secret-bearing values', () => {
    const { config } = parseRuntimeConfig({
      SAGA_DATABASE_URL: 'postgres://localhost/saga',
      OPENAI_API_KEY: 'sk-test',
    });

    expect(redactRuntimeConfig(config)).toStrictEqual({
      databaseUrl: '<redacted>',
      databaseUrlSource: 'environment',
      environment: 'development',
      logLevel: 'info',
      service: {
        host: '127.0.0.1',
        port: 4766,
      },
      secrets: {
        openaiApiKey: '<redacted>',
      },
    });
  });
});

describe('loadLocalEnv', () => {
  it('loads configured env files in order', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    writeFileSync(join(cwd, '.env'), 'SAGA_LOG_LEVEL=debug\nSAGA_DATABASE_URL=postgres://env\n');
    writeFileSync(join(cwd, '.env.local'), 'SAGA_LOG_LEVEL=warn\nOPENAI_API_KEY=local\n');

    expect(loadLocalEnv(cwd)).toStrictEqual({
      SAGA_DATABASE_URL: 'postgres://env',
      OPENAI_API_KEY: 'local',
      SAGA_LOG_LEVEL: 'warn',
    });
  });
});

describe('loadRuntimeConfig', () => {
  it('exposes validation failures as Effect errors', async () => {
    const result = await Effect.runPromiseExit(
      loadRuntimeConfig({
        env: { SAGA_ENV: 'bad' },
        envFiles: [],
        installationConfig: false,
      }),
    );

    assert(Exit.isFailure(result));
    expect(result.cause.toString()).toContain('ConfigError');
  });

  it('loads explicit env over local env files', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    writeFileSync(join(cwd, '.env'), 'SAGA_LOG_LEVEL=debug\n');

    const config = await Effect.runPromise(
      loadRuntimeConfig({
        cwd,
        env: { SAGA_LOG_LEVEL: 'error' },
        installationConfig: false,
      }),
    );

    expect(config.logLevel).toBe('error');
  });
});

describe('loadRuntimeConfig installation config', () => {
  it('uses the installation config database url when env and project files provide none', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const homeDir = makeInstallationHome(
      JSON.stringify({ database: { url: 'postgres://installation/saga' } }),
    );

    const config = await Effect.runPromise(loadRuntimeConfig({ cwd, env: {}, homeDir }));

    expect(config.databaseUrl).toBe('postgres://installation/saga');
    expect(config.databaseUrlSource).toBe('installation-config');
    expect(config.installationConfigIssue).toBeUndefined();
  });

  it('prefers explicit env over project env files and installation config', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    writeFileSync(join(cwd, '.env.local'), 'SAGA_DATABASE_URL=postgres://project/saga\n');
    const homeDir = makeInstallationHome(
      JSON.stringify({ database: { url: 'postgres://installation/saga' } }),
    );

    const config = await Effect.runPromise(
      loadRuntimeConfig({ cwd, env: { SAGA_DATABASE_URL: 'postgres://env/saga' }, homeDir }),
    );

    expect(config.databaseUrl).toBe('postgres://env/saga');
    expect(config.databaseUrlSource).toBe('environment');
  });

  it('prefers project env files over installation config', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    writeFileSync(join(cwd, '.env.local'), 'SAGA_DATABASE_URL=postgres://project/saga\n');
    const homeDir = makeInstallationHome(
      JSON.stringify({ database: { url: 'postgres://installation/saga' } }),
    );

    const config = await Effect.runPromise(loadRuntimeConfig({ cwd, env: {}, homeDir }));

    expect(config.databaseUrl).toBe('postgres://project/saga');
    expect(config.databaseUrlSource).toBe('project-env-file');
  });

  it('treats env-provided SAGA_DATABASE_URL_FILE as an environment source', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const databaseUrlFile = join(cwd, 'database-url');
    writeFileSync(databaseUrlFile, 'postgres://file/saga\n');
    const homeDir = makeInstallationHome(
      JSON.stringify({ database: { url: 'postgres://installation/saga' } }),
    );

    const config = await Effect.runPromise(
      loadRuntimeConfig({ cwd, env: { SAGA_DATABASE_URL_FILE: databaseUrlFile }, homeDir }),
    );

    expect(config.databaseUrl).toBe('postgres://file/saga');
    expect(config.databaseUrlSource).toBe('environment');
  });

  it('lets an explicit env SAGA_DATABASE_URL_FILE beat a project env file SAGA_DATABASE_URL', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const databaseUrlFile = join(cwd, 'database-url');
    writeFileSync(databaseUrlFile, 'postgres://env-file/saga\n');
    writeFileSync(join(cwd, '.env.local'), 'SAGA_DATABASE_URL=postgres://project/saga\n');

    const config = await Effect.runPromise(
      loadRuntimeConfig({
        cwd,
        env: { SAGA_DATABASE_URL_FILE: databaseUrlFile },
        installationConfig: false,
      }),
    );

    expect(config.databaseUrl).toBe('postgres://env-file/saga');
    expect(config.databaseUrlSource).toBe('environment');
  });

  it('treats an empty explicit env SAGA_DATABASE_URL as unset and falls through to project env', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    writeFileSync(join(cwd, '.env.local'), 'SAGA_DATABASE_URL=postgres://project/saga\n');

    const config = await Effect.runPromise(
      loadRuntimeConfig({ cwd, env: { SAGA_DATABASE_URL: '' }, installationConfig: false }),
    );

    expect(config.databaseUrl).toBe('postgres://project/saga');
    expect(config.databaseUrlSource).toBe('project-env-file');
  });

  it('lets .env.local SAGA_DATABASE_URL_FILE beat .env SAGA_DATABASE_URL', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const databaseUrlFile = join(cwd, 'database-url');
    writeFileSync(databaseUrlFile, 'postgres://local-file/saga\n');
    writeFileSync(join(cwd, '.env.local'), `SAGA_DATABASE_URL_FILE=${databaseUrlFile}\n`);
    writeFileSync(join(cwd, '.env'), 'SAGA_DATABASE_URL=postgres://dotenv/saga\n');

    const config = await Effect.runPromise(
      loadRuntimeConfig({ cwd, env: {}, installationConfig: false }),
    );

    expect(config.databaseUrl).toBe('postgres://local-file/saga');
    expect(config.databaseUrlSource).toBe('project-env-file');
  });

  it('fails loudly when the winning layer names a broken SAGA_DATABASE_URL_FILE instead of falling through', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    writeFileSync(join(cwd, '.env.local'), 'SAGA_DATABASE_URL=postgres://project/saga\n');

    const failure = await Effect.runPromise(
      Effect.flip(
        loadRuntimeConfig({
          cwd,
          env: { SAGA_DATABASE_URL_FILE: join(cwd, 'missing-secret') },
          installationConfig: false,
        }),
      ),
    );

    expect(failure.issues.some((issue) => issue.key === 'SAGA_DATABASE_URL_FILE')).toBe(true);
  });

  it('honors a SAGA_HOME override from the effective env', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const sagaHome = mkdtempSync(join(tmpdir(), 'saga-config-saga-home-'));
    writeFileSync(
      join(sagaHome, 'config.json'),
      JSON.stringify({ database: { url: 'postgres://saga-home/saga' } }),
    );
    const homeDir = makeInstallationHome(
      JSON.stringify({ database: { url: 'postgres://home/saga' } }),
    );

    const config = await Effect.runPromise(
      loadRuntimeConfig({ cwd, env: { SAGA_HOME: sagaHome }, homeDir }),
    );

    expect(config.databaseUrl).toBe('postgres://saga-home/saga');
    expect(config.databaseUrlSource).toBe('installation-config');
  });

  it('supports the readInstallationFile seam', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const homeDir = makeInstallationHome();

    const config = await Effect.runPromise(
      loadRuntimeConfig({
        cwd,
        env: {},
        homeDir,
        readInstallationFile: () =>
          JSON.stringify({ database: { url: 'postgres://injected/saga' } }),
      }),
    );

    expect(config.databaseUrl).toBe('postgres://injected/saga');
    expect(config.databaseUrlSource).toBe('installation-config');
  });

  it('reads no installation config when disabled', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const homeDir = makeInstallationHome(
      JSON.stringify({ database: { url: 'postgres://installation/saga' } }),
    );

    const config = await Effect.runPromise(
      loadRuntimeConfig({ cwd, env: {}, homeDir, installationConfig: false }),
    );

    expect(config.databaseUrl).toBeUndefined();
    expect(config.databaseUrlSource).toBe('missing');
    expect(config.installationConfigIssue).toBeUndefined();
  });

  it('contributes nothing and reports no issue when the file is absent', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const homeDir = makeInstallationHome();

    const config = await Effect.runPromise(loadRuntimeConfig({ cwd, env: {}, homeDir }));

    expect(config.databaseUrl).toBeUndefined();
    expect(config.databaseUrlSource).toBe('missing');
    expect(config.installationConfigIssue).toBeUndefined();
  });

  it('reports no issue when the file omits database configuration', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const homeDir = makeInstallationHome(JSON.stringify({ embeddings: { remote: 'enabled' } }));

    const config = await Effect.runPromise(loadRuntimeConfig({ cwd, env: {}, homeDir }));

    expect(config.databaseUrl).toBeUndefined();
    expect(config.databaseUrlSource).toBe('missing');
    expect(config.installationConfigIssue).toBeUndefined();
  });

  it('reports a malformed installation config without failing the load', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const homeDir = makeInstallationHome('not json');

    const config = await Effect.runPromise(
      loadRuntimeConfig({ cwd, env: { SAGA_LOG_LEVEL: 'warn' }, homeDir }),
    );

    expect(config.databaseUrl).toBeUndefined();
    expect(config.databaseUrlSource).toBe('missing');
    expect(config.installationConfigIssue).toBe('could not parse ~/.saga/config.json');
    expect(config.logLevel).toBe('warn');
  });

  it('reports a non-object database entry as an issue', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const homeDir = makeInstallationHome(JSON.stringify({ database: 'nope' }));

    const config = await Effect.runPromise(loadRuntimeConfig({ cwd, env: {}, homeDir }));

    expect(config.databaseUrl).toBeUndefined();
    expect(config.installationConfigIssue).toBe(
      'database in ~/.saga/config.json must be an object',
    );
  });

  it('reports a blank database url as an issue', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const homeDir = makeInstallationHome(JSON.stringify({ database: { url: '  ' } }));

    const config = await Effect.runPromise(loadRuntimeConfig({ cwd, env: {}, homeDir }));

    expect(config.databaseUrl).toBeUndefined();
    expect(config.databaseUrlSource).toBe('missing');
    expect(config.installationConfigIssue).toBe(
      'database.url in ~/.saga/config.json must be a non-empty string',
    );
  });

  it('surfaces installation config issues even when the env provides the url', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const homeDir = makeInstallationHome('not json');

    const config = await Effect.runPromise(
      loadRuntimeConfig({ cwd, env: { SAGA_DATABASE_URL: 'postgres://env/saga' }, homeDir }),
    );

    expect(config.databaseUrl).toBe('postgres://env/saga');
    expect(config.databaseUrlSource).toBe('environment');
    expect(config.installationConfigIssue).toBe('could not parse ~/.saga/config.json');
  });

  it('redacts the url but passes provenance through unredacted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    const homeDir = makeInstallationHome(
      JSON.stringify({ database: { url: 'postgres://installation/saga' } }),
    );

    const config = await Effect.runPromise(loadRuntimeConfig({ cwd, env: {}, homeDir }));
    const redacted = redactRuntimeConfig(config);

    expect(redacted.databaseUrl).toBe('<redacted>');
    expect(redacted.databaseUrlSource).toBe('installation-config');
    expect(JSON.stringify(redacted)).not.toContain('postgres://installation/saga');
  });
});

describe('loadRuntimeConfig production build profile', () => {
  it('does not read project env files when the build is production', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    writeFileSync(join(cwd, '.env.local'), 'SAGA_DATABASE_URL=postgres://project/saga\n');
    const homeDir = makeInstallationHome(
      JSON.stringify({ database: { url: 'postgres://installation/saga' } }),
    );

    const config = await Effect.runPromise(
      loadRuntimeConfig({ cwd, env: {}, homeDir, isProduction: true }),
    );

    expect(config.databaseUrl).toBe('postgres://installation/saga');
    expect(config.databaseUrlSource).toBe('installation-config');
  });

  it('still lets explicit env win in a production build', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    writeFileSync(join(cwd, '.env.local'), 'SAGA_DATABASE_URL=postgres://project/saga\n');
    const homeDir = makeInstallationHome(
      JSON.stringify({ database: { url: 'postgres://installation/saga' } }),
    );

    const config = await Effect.runPromise(
      loadRuntimeConfig({
        cwd,
        env: { SAGA_DATABASE_URL: 'postgres://env/saga' },
        homeDir,
        isProduction: true,
      }),
    );

    expect(config.databaseUrl).toBe('postgres://env/saga');
    expect(config.databaseUrlSource).toBe('environment');
  });

  it('reads project env files when the build is source (dev)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    writeFileSync(join(cwd, '.env.local'), 'SAGA_DATABASE_URL=postgres://project/saga\n');
    const homeDir = makeInstallationHome(
      JSON.stringify({ database: { url: 'postgres://installation/saga' } }),
    );

    const config = await Effect.runPromise(
      loadRuntimeConfig({ cwd, env: {}, homeDir, isProduction: false }),
    );

    expect(config.databaseUrl).toBe('postgres://project/saga');
    expect(config.databaseUrlSource).toBe('project-env-file');
  });

  it('ignores a database env value that only echoes the repo .env in production (Bun auto-load)', async () => {
    // Bun auto-loads .env into process.env even for a compiled binary, so simulate
    // an explicit env whose SAGA_DATABASE_URL equals the on-disk .env value.
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    writeFileSync(join(cwd, '.env.local'), 'SAGA_DATABASE_URL=postgres://dotenv/saga\n');
    const homeDir = makeInstallationHome(
      JSON.stringify({ database: { url: 'postgres://installation/saga' } }),
    );

    const config = await Effect.runPromise(
      loadRuntimeConfig({
        cwd,
        env: { SAGA_DATABASE_URL: 'postgres://dotenv/saga' },
        homeDir,
        isProduction: true,
      }),
    );

    expect(config.databaseUrl).toBe('postgres://installation/saga');
    expect(config.databaseUrlSource).toBe('installation-config');
  });

  it('keeps a genuine deployment export that differs from the repo .env in production', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    writeFileSync(join(cwd, '.env.local'), 'SAGA_DATABASE_URL=postgres://dotenv/saga\n');
    const homeDir = makeInstallationHome(
      JSON.stringify({ database: { url: 'postgres://installation/saga' } }),
    );

    const config = await Effect.runPromise(
      loadRuntimeConfig({
        cwd,
        env: { SAGA_DATABASE_URL: 'postgres://real-export/saga' },
        homeDir,
        isProduction: true,
      }),
    );

    expect(config.databaseUrl).toBe('postgres://real-export/saga');
    expect(config.databaseUrlSource).toBe('environment');
  });

  it('ignores non-database project env values too when production', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-config-'));
    writeFileSync(join(cwd, '.env'), 'SAGA_LOG_LEVEL=debug\n');

    const config = await Effect.runPromise(
      loadRuntimeConfig({ cwd, env: {}, installationConfig: false, isProduction: true }),
    );

    expect(config.logLevel).toBe('info');
  });
});

function makeInstallationHome(contents?: string): string {
  const homeDir = mkdtempSync(join(tmpdir(), 'saga-config-home-'));
  if (contents !== undefined) {
    mkdirSync(join(homeDir, '.saga'), { recursive: true });
    writeFileSync(join(homeDir, '.saga', 'config.json'), contents);
  }
  return homeDir;
}

describe('runtimeConfigLive', () => {
  it('provides runtime config through an Effect layer', async () => {
    const program = Effect.gen(function* program() {
      return yield* RuntimeConfigTag;
    }).pipe(
      Effect.provide(
        RuntimeConfigLive({
          env: { SAGA_ENV: 'test' },
          envFiles: [],
          installationConfig: false,
        }),
      ),
    );

    await expect(Effect.runPromise(program)).resolves.toMatchObject({
      environment: 'test',
    });
  });
});

test('configError carries structured issues', () => {
  const error = new ConfigError({ issues: [{ key: 'SAGA_ENV', message: 'bad' }] });

  expect(error.issues).toStrictEqual([{ key: 'SAGA_ENV', message: 'bad' }]);
});
