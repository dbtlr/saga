import { readFileSync } from 'node:fs';

import { resolveCodexAuth } from './codex-auth.js';
import type { CodexAuthMode, CodexAuthStatus } from './codex-auth.js';
import { installationConfigLocation } from './embedding-policy.js';
import {
  isRecord,
  optionalString,
  readInstallationConfig,
  readOpenAiApiKeyFromEnv,
} from './internal/credential-io.js';

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

// A tier either supplies a key ('found'), is not configured at all ('absent', skipped
// quietly), or is configured but broken ('issue'). A present-but-broken tier does not fail
// the whole resolution — a lower tier can still supply a working key — but its issue is
// carried forward so that if resolution ultimately degrades to lexical, doctor/recall name
// the operator's actual misconfiguration instead of masking it behind the Codex message.
type TierResult =
  | { apiKey: string; detail: string; displayPath: string; status: 'found' }
  | { issue: string; status: 'issue' }
  | { status: 'absent' };

// Resolve the OpenAI embedding key by precedence — explicit env, then installation config,
// then the read-only cached Codex key — mirroring resolveDatabaseConfig's layered walk. This
// is orthogonal to the ADR-0032 remote-embeddings policy gate: it decides *which* key to use,
// never *whether* remote embeddings are allowed.
export function resolveEmbeddingCredential(
  options: EmbeddingCredentialResolutionOptions = {},
): EmbeddingCredential {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const issues: string[] = [];

  const fromEnv = readOpenAiApiKeyFromEnv(env, readFile);
  if (fromEnv.status === 'found') {
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
  if (fromEnv.status === 'issue') {
    issues.push(fromEnv.issue);
  }

  const fromInstallation = readInstallationApiKey(env, options, readFile);
  if (fromInstallation.status === 'found') {
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
  if (fromInstallation.status === 'issue') {
    issues.push(fromInstallation.issue);
  }

  return fromCodexAuth(resolveCodexAuth(options), issues);
}

function fromCodexAuth(auth: CodexAuthStatus, issues: readonly string[]): EmbeddingCredential {
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
  // No tier produced a key. If a higher tier was configured-but-broken, lead with that so
  // the operator sees their real problem rather than only the Codex fall-through message.
  return {
    detail: [...issues, auth.detail].join('; '),
    guidance:
      issues.length === 0
        ? auth.guidance
        : `Fix the configured OpenAI embedding credential above. ${auth.guidance}`,
    mode: auth.mode,
    reason: auth.reason,
    status: 'unavailable',
  };
}

function readInstallationApiKey(
  env: NodeJS.ProcessEnv,
  options: EmbeddingCredentialResolutionOptions,
  readFile: (path: string) => string,
): TierResult {
  const location = installationConfigLocation({
    env,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });

  const read = readInstallationConfig(location, readFile);
  // A missing installation config is a quiet skip; unreadable or malformed is a real problem.
  if (read.status === 'missing') {
    return { status: 'absent' };
  }
  if (read.status === 'unreadable' || read.status === 'malformed') {
    return { issue: read.message, status: 'issue' };
  }

  const parsed = read.value;
  if (!isRecord(parsed) || !isRecord(parsed.embeddings)) {
    return { status: 'absent' };
  }
  const key = parsed.embeddings.openaiApiKey;
  if (key === undefined) {
    return { status: 'absent' };
  }
  const value = typeof key === 'string' ? optionalString(key) : undefined;
  if (value === undefined) {
    return {
      issue: `embeddings.openaiApiKey in ${location.displayPath} must be a non-empty string`,
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
