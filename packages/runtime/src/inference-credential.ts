import { readFileSync } from 'node:fs';

import { resolveCodexAuth } from './codex-auth.js';
import { installationConfigLocation } from './embedding-policy.js';
import type { EmbeddingPolicyResolutionOptions } from './embedding-policy.js';

// Where the OpenAI inference API key was sourced from, highest precedence first: an explicit
// environment variable, then the installation config's inference section, then the read-only
// cached Codex OPENAI_API_KEY. This is the same three-tier ladder, in the same order and with
// the same source labels, as the embedding credential twin — it only reads
// inference.openaiApiKey for the installation tier, keeping the two policies' keys independent.
export type InferenceCredentialSource = 'environment' | 'installation-config' | 'codex-auth';

export type InferenceCredentialResolutionOptions = EmbeddingPolicyResolutionOptions;

export type InferenceCredentialAvailable = {
  apiKey: string;
  detail: string;
  displayPath: string;
  source: InferenceCredentialSource;
  status: 'available';
};

export type InferenceCredentialUnavailable = {
  detail: string;
  status: 'unavailable';
};

export type InferenceCredential = InferenceCredentialAvailable | InferenceCredentialUnavailable;

type TierResult =
  | { apiKey: string; detail: string; displayPath: string; status: 'found' }
  | { issue: string; status: 'issue' }
  | { status: 'absent' };

export function resolveInferenceApiKey(
  options: InferenceCredentialResolutionOptions = {},
): InferenceCredential {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const issues: string[] = [];

  const fromEnv = readEnvApiKey(env, readFile);
  if (fromEnv.status === 'found') {
    return {
      apiKey: fromEnv.apiKey,
      detail: fromEnv.detail,
      displayPath: fromEnv.displayPath,
      source: 'environment',
      status: 'available',
    };
  }
  if (fromEnv.status === 'issue') {
    issues.push(fromEnv.issue);
  }

  const fromInstallation = readInstallationApiKey(env, options, readFile);
  if (fromInstallation.status === 'found') {
    return {
      apiKey: fromInstallation.apiKey,
      detail: fromInstallation.detail,
      displayPath: fromInstallation.displayPath,
      source: 'installation-config',
      status: 'available',
    };
  }
  if (fromInstallation.status === 'issue') {
    issues.push(fromInstallation.issue);
  }

  // Third tier: the cached Codex OPENAI_API_KEY, via the same shared reader the embedding
  // credential uses. Reuse keeps the two ladders from drifting.
  const codex = resolveCodexAuth({
    env,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    readFile,
  });
  if (codex.status === 'available') {
    return {
      apiKey: codex.openaiApiKey,
      detail: `cached OPENAI_API_KEY present in ${codex.displayPath}`,
      displayPath: codex.displayPath,
      source: 'codex-auth',
      status: 'available',
    };
  }

  // No tier produced a key. Lead with any configured-but-broken higher tier so the operator
  // sees their real problem rather than only the Codex fall-through message.
  return { detail: [...issues, codex.detail].join('; '), status: 'unavailable' };
}

function readEnvApiKey(env: NodeJS.ProcessEnv, readFile: (path: string) => string): TierResult {
  const direct = optionalString(env.OPENAI_API_KEY);
  if (direct !== undefined) {
    return {
      apiKey: direct,
      detail: 'OPENAI_API_KEY present in the environment',
      displayPath: 'OPENAI_API_KEY',
      status: 'found',
    };
  }

  const filePath = optionalString(env.OPENAI_API_KEY_FILE);
  if (filePath === undefined) {
    return { status: 'absent' };
  }
  let contents: string;
  try {
    contents = readFile(filePath);
  } catch (error) {
    return {
      issue: `OPENAI_API_KEY_FILE could not be read: ${errorMessage(error)}`,
      status: 'issue',
    };
  }
  const value = optionalString(contents);
  if (value === undefined) {
    return { issue: `OPENAI_API_KEY_FILE points at an empty file (${filePath})`, status: 'issue' };
  }
  return {
    apiKey: value,
    detail: `OPENAI_API_KEY read from ${filePath} (OPENAI_API_KEY_FILE)`,
    displayPath: 'OPENAI_API_KEY_FILE',
    status: 'found',
  };
}

function readInstallationApiKey(
  env: NodeJS.ProcessEnv,
  options: InferenceCredentialResolutionOptions,
  readFile: (path: string) => string,
): TierResult {
  const location = installationConfigLocation({
    env,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });

  let rawConfig: string;
  try {
    rawConfig = readFile(location.path);
  } catch (error) {
    return isMissingFileError(error)
      ? { status: 'absent' }
      : {
          issue: `could not read ${location.displayPath}: ${errorMessage(error)}`,
          status: 'issue',
        };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch {
    return { issue: `could not parse ${location.displayPath}`, status: 'issue' };
  }

  if (!isRecord(parsed) || !isRecord(parsed.inference)) {
    return { status: 'absent' };
  }
  const key = parsed.inference.openaiApiKey;
  if (key === undefined) {
    return { status: 'absent' };
  }
  const value = typeof key === 'string' ? optionalString(key) : undefined;
  if (value === undefined) {
    return {
      issue: `inference.openaiApiKey in ${location.displayPath} must be a non-empty string`,
      status: 'issue',
    };
  }
  return {
    apiKey: value,
    detail: `openaiApiKey configured in ${location.displayPath}`,
    displayPath: location.displayPath,
    status: 'found',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
