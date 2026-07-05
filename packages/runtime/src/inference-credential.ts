import { readFileSync } from 'node:fs';

import { installationConfigLocation } from './embedding-policy.js';
import type { EmbeddingPolicyResolutionOptions } from './embedding-policy.js';

// Where the OpenAI inference API key was sourced from, highest precedence first: an explicit
// environment variable, then the installation config's inference section. This mirrors the
// embedding credential ladder but reads inference.openaiApiKey, keeping the two policies'
// credentials independent.
export type InferenceCredentialSource = 'environment' | 'installation-config';

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

  const detail =
    issues.length > 0
      ? issues.join('; ')
      : 'no OpenAI inference API key found in the environment or installation config';
  return { detail, status: 'unavailable' };
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
