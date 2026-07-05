import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseDotenv } from 'dotenv';
import { Context, Data, Effect, Layer } from 'effect';

import { IS_PRODUCTION } from './build-profile.js';
import { installationConfigLocation } from './embedding-policy.js';

// The single source of truth for the database environment variable name. The one
// reader below keys off it dynamically and every user-facing guidance/error
// message builds the name from it, so the variable is named in exactly one place
// (a future rename is one edit). The `SAGA_` namespace is deliberate: an ambient
// `DATABASE_URL` in an operator's shell can no longer silently point installed
// saga at the wrong shared Postgres. `SAGA_DATABASE_URL` keeps env-wins semantics
// in every mode.
export const DATABASE_URL_ENV = 'SAGA_DATABASE_URL';
export const DATABASE_URL_FILE_ENV = `${DATABASE_URL_ENV}_FILE`;

export type SagaEnvironment = 'development' | 'test' | 'production';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DatabaseUrlSource =
  | 'environment'
  | 'project-env-file'
  | 'installation-config'
  | 'missing';

export type RuntimeConfig = {
  databaseUrl: string | undefined;
  databaseUrlSource: DatabaseUrlSource;
  environment: SagaEnvironment;
  installationConfigIssue?: string;
  logLevel: LogLevel;
  service: {
    host: string;
    port: number;
  };
  secrets: {
    openaiApiKey: string | undefined;
  };
};

export type RedactedRuntimeConfig = {
  databaseUrl: string | undefined;
  databaseUrlSource: DatabaseUrlSource;
  environment: SagaEnvironment;
  installationConfigIssue?: string;
  logLevel: LogLevel;
  service: {
    host: string;
    port: number;
  };
  secrets: {
    openaiApiKey: string | undefined;
  };
};

export type ConfigIssue = {
  key: string;
  message: string;
};

export class ConfigError extends Data.TaggedError('ConfigError')<{
  readonly issues: readonly ConfigIssue[];
}> {}

export type LoadRuntimeConfigOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  envFiles?: readonly string[];
  homeDir?: string;
  installationConfig?: false;
  // Config-precedence build profile: when true, project .env files are not read
  // (dotenv is source-only, ADR-0044). Defaults to the compiled-in IS_PRODUCTION;
  // an explicit value lets tests exercise both modes without a compiled binary.
  isProduction?: boolean;
  readInstallationFile?: (path: string) => string;
};

export const RuntimeConfigTag = Context.GenericTag<RuntimeConfig>('@saga/runtime/RuntimeConfig');

export function RuntimeConfigLive(
  options: LoadRuntimeConfigOptions = {},
): Layer.Layer<RuntimeConfig, ConfigError> {
  return Layer.effect(RuntimeConfigTag, loadRuntimeConfig(options));
}

const DEFAULT_ENV_FILES = ['.env', '.env.local'] as const;
const DEFAULT_ENVIRONMENT: SagaEnvironment = 'development';
const DEFAULT_LOG_LEVEL: LogLevel = 'info';
const DEFAULT_SERVICE_HOST = '127.0.0.1';
const DEFAULT_SERVICE_PORT = 4766;
const REDACTED = '<redacted>';

export function loadLocalEnv(
  cwd = process.cwd(),
  envFiles: readonly string[] = DEFAULT_ENV_FILES,
): Record<string, string> {
  const loaded: Record<string, string> = {};

  for (const envFile of envFiles) {
    const path = resolve(cwd, envFile);
    if (!existsSync(path)) {
      continue;
    }
    Object.assign(loaded, parseDotenv(readFileSync(path)));
  }

  return loaded;
}

export function loadRuntimeConfig(
  options: LoadRuntimeConfigOptions = {},
): Effect.Effect<RuntimeConfig, ConfigError> {
  return Effect.sync(() => {
    const explicitEnv = options.env ?? process.env;
    // dotenv is source-only: a compiled/production build never reads project .env
    // files (ADR-0044). The gate lives here in the loader, not at call sites.
    const isProduction = options.isProduction ?? IS_PRODUCTION;
    const localEnv = isProduction ? {} : loadLocalEnv(options.cwd, options.envFiles);
    const env = mergeEnv(localEnv, explicitEnv);
    // The database URL resolves per-layer below, so the merged env must not
    // contribute a cross-layer database value or duplicate secret-file issues.
    const {
      [DATABASE_URL_ENV]: _databaseUrl,
      [DATABASE_URL_FILE_ENV]: _databaseUrlFile,
      ...envWithoutDatabase
    } = env;
    const result = parseRuntimeConfig(envWithoutDatabase);
    const issues = [...result.issues];
    const config = resolveDatabaseConfig(result.config, explicitEnv, issues, options);
    return { config, issues };
  }).pipe(
    Effect.flatMap((result) =>
      result.issues.length === 0
        ? Effect.succeed(result.config)
        : Effect.fail(new ConfigError({ issues: result.issues })),
    ),
  );
}

export function parseRuntimeConfig(env: NodeJS.ProcessEnv): {
  config: RuntimeConfig;
  issues: readonly ConfigIssue[];
} {
  const issues: ConfigIssue[] = [];
  const environment = parseEnum(
    env.SAGA_ENV,
    ['development', 'test', 'production'],
    DEFAULT_ENVIRONMENT,
    'SAGA_ENV',
    issues,
  );
  const logLevel = parseEnum(
    env.SAGA_LOG_LEVEL,
    ['debug', 'info', 'warn', 'error'],
    DEFAULT_LOG_LEVEL,
    'SAGA_LOG_LEVEL',
    issues,
  );

  const databaseUrl = readSecretValue(env, DATABASE_URL_ENV, issues);
  const config: RuntimeConfig = {
    databaseUrl,
    databaseUrlSource: databaseUrl === undefined ? 'missing' : 'environment',
    environment,
    logLevel,
    service: {
      host: optionalString(env.SAGA_SERVICE_HOST) ?? DEFAULT_SERVICE_HOST,
      port: parsePort(env.SAGA_SERVICE_PORT, 'SAGA_SERVICE_PORT', issues),
    },
    secrets: {
      openaiApiKey: readSecretValue(env, 'OPENAI_API_KEY', issues),
    },
  };

  return { config, issues };
}

export function redactRuntimeConfig(config: RuntimeConfig): RedactedRuntimeConfig {
  return {
    databaseUrl: redactSecret(config.databaseUrl),
    databaseUrlSource: config.databaseUrlSource,
    environment: config.environment,
    ...(config.installationConfigIssue === undefined
      ? {}
      : { installationConfigIssue: config.installationConfigIssue }),
    logLevel: config.logLevel,
    service: config.service,
    secrets: {
      openaiApiKey: redactSecret(config.secrets.openaiApiKey),
    },
  };
}

function mergeEnv(
  localEnv: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...localEnv, ...processEnv };
}

// Database resolution is layered, highest precedence first: explicit env, then each
// project env file (.env.local before .env), then installation config. The first
// layer that names SAGA_DATABASE_URL or SAGA_DATABASE_URL_FILE wins outright — a
// named but broken value fails loudly rather than silently falling through to
// another database. Empty-string values count as unset. Installation config is the
// lowest layer so project env can pin a dev database. A compiled/production build
// never reads project env files (dotenv is gated source-only, see loadRuntimeConfig
// / resolveDatabaseConfig), so an installed binary resolves the DB from explicit
// env then installation config only (ADR 0044/0038).
function resolveDatabaseConfig(
  config: RuntimeConfig,
  explicitEnv: NodeJS.ProcessEnv,
  issues: ConfigIssue[],
  options: LoadRuntimeConfigOptions,
): RuntimeConfig {
  // dotenv is source-only (ADR-0044): a compiled/production build resolves the DB
  // from explicit env then installation config, skipping the project-env layers.
  // The compiled binary is built with --no-compile-autoload-dotenv, so Bun does not
  // inject repo .env into process.env — the explicit-env layer is a real deployment
  // env in production.
  const isProduction = options.isProduction ?? IS_PRODUCTION;
  const layers: readonly { env: NodeJS.ProcessEnv; source: 'environment' | 'project-env-file' }[] =
    [
      { env: explicitEnv, source: 'environment' },
      ...(isProduction
        ? []
        : loadLocalEnvLayers(options.cwd, options.envFiles).map((env) => ({
            env,
            source: 'project-env-file' as const,
          }))),
    ];

  const installation =
    options.installationConfig === false
      ? { issue: undefined, url: undefined }
      : readInstallationDatabaseUrl(explicitEnv, options);
  const withIssue: RuntimeConfig =
    installation.issue === undefined
      ? config
      : { ...config, installationConfigIssue: installation.issue };

  for (const layer of layers) {
    if (
      optionalString(layer.env[DATABASE_URL_ENV]) === undefined &&
      optionalString(layer.env[DATABASE_URL_FILE_ENV]) === undefined
    ) {
      continue;
    }
    const url = readSecretValue(layer.env, DATABASE_URL_ENV, issues);
    return {
      ...withIssue,
      databaseUrl: url,
      databaseUrlSource: url === undefined ? 'missing' : layer.source,
    };
  }

  if (installation.url !== undefined) {
    return {
      ...withIssue,
      databaseUrl: installation.url,
      databaseUrlSource: 'installation-config',
    };
  }
  return { ...withIssue, databaseUrl: undefined, databaseUrlSource: 'missing' };
}

// Per-file env layers in precedence order (last file in envFiles wins, matching
// loadLocalEnv's merge order, so the returned list is reversed).
function loadLocalEnvLayers(
  cwd = process.cwd(),
  envFiles: readonly string[] = DEFAULT_ENV_FILES,
): Record<string, string>[] {
  const layers: Record<string, string>[] = [];
  for (const envFile of envFiles) {
    const path = resolve(cwd, envFile);
    if (!existsSync(path)) {
      continue;
    }
    layers.unshift(parseDotenv(readFileSync(path)));
  }
  return layers;
}

function readInstallationDatabaseUrl(
  env: NodeJS.ProcessEnv,
  options: LoadRuntimeConfigOptions,
): { issue: string | undefined; url: string | undefined } {
  const readFile = options.readInstallationFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const location = installationConfigLocation({
    env,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });

  let rawConfig: string;
  try {
    rawConfig = readFile(location.path);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { issue: undefined, url: undefined };
    }
    return {
      issue: `could not read ${location.displayPath}: ${errorMessage(error)}`,
      url: undefined,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch {
    return { issue: `could not parse ${location.displayPath}`, url: undefined };
  }

  if (!isRecord(parsed)) {
    return { issue: `${location.displayPath} does not contain a JSON object`, url: undefined };
  }
  const database = parsed.database;
  if (database === undefined) {
    return { issue: undefined, url: undefined };
  }
  if (!isRecord(database)) {
    return { issue: `database in ${location.displayPath} must be an object`, url: undefined };
  }
  const url = database.url;
  if (url === undefined) {
    return { issue: undefined, url: undefined };
  }
  if (typeof url !== 'string' || url.trim() === '') {
    return {
      issue: `database.url in ${location.displayPath} must be a non-empty string`,
      url: undefined,
    };
  }
  return { issue: undefined, url: url.trim() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readSecretValue(
  env: NodeJS.ProcessEnv,
  key: typeof DATABASE_URL_ENV | 'OPENAI_API_KEY',
  issues: ConfigIssue[],
): string | undefined {
  const directValue = optionalString(env[key]);
  if (directValue !== undefined) {
    return directValue;
  }

  const filePath = optionalString(env[`${key}_FILE`]);
  if (filePath === undefined) {
    return undefined;
  }

  try {
    const value = optionalString(readFileSync(filePath, 'utf8'));
    if (value !== undefined) {
      return value;
    }
    issues.push({
      key: `${key}_FILE`,
      message: `secret file ${filePath} is empty`,
    });
    return undefined;
  } catch (error) {
    issues.push({
      key: `${key}_FILE`,
      message: `could not read secret file ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return undefined;
  }
}

function parseEnum<const Value extends string>(
  value: string | undefined,
  allowed: readonly Value[],
  fallback: Value,
  key: string,
  issues: ConfigIssue[],
): Value {
  const normalized = optionalString(value);
  if (normalized === undefined) {
    return fallback;
  }
  const match = allowed.find((candidate) => candidate === normalized);
  if (match !== undefined) {
    return match;
  }

  issues.push({
    key,
    message: `expected one of ${allowed.join(', ')}`,
  });
  return fallback;
}

function parsePort(value: string | undefined, key: string, issues: ConfigIssue[]): number {
  const normalized = optionalString(value);
  if (normalized === undefined) {
    return DEFAULT_SERVICE_PORT;
  }

  const port = Number.parseInt(normalized, 10);
  if (Number.isInteger(port) && port > 0 && port <= 65_535 && String(port) === normalized) {
    return port;
  }

  issues.push({
    key,
    message: 'expected an integer from 1 to 65535',
  });
  return DEFAULT_SERVICE_PORT;
}

function redactSecret(value: string | undefined): string | undefined {
  return value === undefined ? undefined : REDACTED;
}
