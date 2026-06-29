import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseDotenv } from 'dotenv';
import { Context, Data, Effect, Layer } from 'effect';

export type SagaEnvironment = 'development' | 'test' | 'production';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeConfig {
  databaseUrl: string | undefined;
  environment: SagaEnvironment;
  logLevel: LogLevel;
  service: {
    host: string;
    port: number;
  };
  secrets: {
    openaiApiKey: string | undefined;
  };
}

export interface RedactedRuntimeConfig {
  databaseUrl: string | undefined;
  environment: SagaEnvironment;
  logLevel: LogLevel;
  service: {
    host: string;
    port: number;
  };
  secrets: {
    openaiApiKey: string | undefined;
  };
}

export interface ConfigIssue {
  key: string;
  message: string;
}

export class ConfigError extends Data.TaggedError('ConfigError')<{
  readonly issues: readonly ConfigIssue[];
}> {}

export interface LoadRuntimeConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  envFiles?: readonly string[];
}

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
    if (!existsSync(path)) continue;
    Object.assign(loaded, parseDotenv(readFileSync(path)));
  }

  return loaded;
}

export function loadRuntimeConfig(
  options: LoadRuntimeConfigOptions = {},
): Effect.Effect<RuntimeConfig, ConfigError> {
  return Effect.sync(() => {
    const env = mergeEnv(loadLocalEnv(options.cwd, options.envFiles), options.env ?? process.env);
    return parseRuntimeConfig(env);
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

  const config: RuntimeConfig = {
    databaseUrl: readSecretValue(env, 'DATABASE_URL', issues),
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
    environment: config.environment,
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

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readSecretValue(
  env: NodeJS.ProcessEnv,
  key: 'DATABASE_URL' | 'OPENAI_API_KEY',
  issues: ConfigIssue[],
): string | undefined {
  const directValue = optionalString(env[key]);
  if (directValue !== undefined) return directValue;

  const filePath = optionalString(env[`${key}_FILE`]);
  if (filePath === undefined) return undefined;

  try {
    const value = optionalString(readFileSync(filePath, 'utf8'));
    if (value !== undefined) return value;
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
  if (normalized === undefined) return fallback;
  if (allowed.includes(normalized as Value)) return normalized as Value;

  issues.push({
    key,
    message: `expected one of ${allowed.join(', ')}`,
  });
  return fallback;
}

function parsePort(value: string | undefined, key: string, issues: ConfigIssue[]): number {
  const normalized = optionalString(value);
  if (normalized === undefined) return DEFAULT_SERVICE_PORT;

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
