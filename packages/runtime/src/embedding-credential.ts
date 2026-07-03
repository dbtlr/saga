import { readFileSync } from 'node:fs';

import { resolveCodexAuth } from './codex-auth.js';
import type { CodexAuthMode, CodexAuthStatus } from './codex-auth.js';
import { installationConfigLocation } from './embedding-policy.js';

// Where an OpenAI embedding credential was sourced from, highest precedence first:
// an explicit environment variable, the installation config, then a cached Codex key.
export type EmbeddingCredentialSource = 'environment' | 'installation-config' | 'codex-auth';

export type EmbeddingCredentialResolutionOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  readFile?: (path: string) => string;
};

export type EmbeddingCredentialAvailable = {
  apiKey: string;
  detail: string;
  displayPath: string;
  guidance: string;
  mode: CodexAuthMode;
  source: EmbeddingCredentialSource;
  status: 'available';
};

export type EmbeddingCredentialUnavailable = {
  detail: string;
  guidance: string;
  mode: Exclude<CodexAuthMode, 'api-key'>;
  reason: string;
  status: 'unavailable';
};

export type EmbeddingCredential = EmbeddingCredentialAvailable | EmbeddingCredentialUnavailable;

// Credential sourcing is orthogonal to the ADR-0032 remote-embeddings policy gate: this
// only decides *which* OpenAI key to use, never *whether* remote embeddings are allowed.
// Precedence mirrors resolveDatabaseConfig: explicit env wins, then installation config,
// then the read-only cached Codex key. A tier that is present-but-broken (empty file,
// blank key) is skipped rather than failing the whole resolution, so a lower tier can
// still supply a working key.
export function resolveEmbeddingCredential(
  options: EmbeddingCredentialResolutionOptions = {},
): EmbeddingCredential {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));

  const fromEnv = readEnvApiKey(env, readFile);
  if (fromEnv !== undefined) {
    return {
      apiKey: fromEnv.apiKey,
      detail: fromEnv.detail,
      displayPath: fromEnv.displayPath,
      guidance: 'OpenAI embeddings use the OPENAI_API_KEY configured in the environment.',
      mode: 'api-key',
      source: 'environment',
      status: 'available',
    };
  }

  const fromInstallation = readInstallationApiKey(env, options, readFile);
  if (fromInstallation !== undefined) {
    return {
      apiKey: fromInstallation.apiKey,
      detail: fromInstallation.detail,
      displayPath: fromInstallation.displayPath,
      guidance: `OpenAI embeddings use the openaiApiKey configured in ${fromInstallation.displayPath}.`,
      mode: 'api-key',
      source: 'installation-config',
      status: 'available',
    };
  }

  return fromCodexAuth(resolveCodexAuth(options));
}

function fromCodexAuth(auth: CodexAuthStatus): EmbeddingCredential {
  if (auth.status === 'available') {
    return {
      apiKey: auth.openaiApiKey,
      detail: `cached OPENAI_API_KEY present in ${auth.displayPath}`,
      displayPath: auth.displayPath,
      guidance: auth.guidance,
      mode: auth.mode,
      source: 'codex-auth',
      status: 'available',
    };
  }
  return {
    detail: auth.detail,
    guidance: auth.guidance,
    mode: auth.mode,
    reason: auth.reason,
    status: 'unavailable',
  };
}

function readEnvApiKey(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): { apiKey: string; detail: string; displayPath: string } | undefined {
  const direct = optionalString(env.OPENAI_API_KEY);
  if (direct !== undefined) {
    return {
      apiKey: direct,
      detail: 'OPENAI_API_KEY present in the environment',
      displayPath: 'OPENAI_API_KEY',
    };
  }

  const filePath = optionalString(env.OPENAI_API_KEY_FILE);
  if (filePath === undefined) {
    return undefined;
  }
  let contents: string;
  try {
    contents = readFile(filePath);
  } catch {
    return undefined;
  }
  const value = optionalString(contents);
  if (value === undefined) {
    return undefined;
  }
  return {
    apiKey: value,
    detail: `OPENAI_API_KEY read from ${filePath} (OPENAI_API_KEY_FILE)`,
    displayPath: 'OPENAI_API_KEY_FILE',
  };
}

function readInstallationApiKey(
  env: NodeJS.ProcessEnv,
  options: EmbeddingCredentialResolutionOptions,
  readFile: (path: string) => string,
): { apiKey: string; detail: string; displayPath: string } | undefined {
  const location = installationConfigLocation({
    env,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });

  let rawConfig: string;
  try {
    rawConfig = readFile(location.path);
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(parsed) || !isRecord(parsed.embeddings)) {
    return undefined;
  }
  const key = parsed.embeddings.openaiApiKey;
  if (typeof key !== 'string') {
    return undefined;
  }
  const value = optionalString(key);
  if (value === undefined) {
    return undefined;
  }
  return {
    apiKey: value,
    detail: `openaiApiKey configured in ${location.displayPath}`,
    displayPath: location.displayPath,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}
