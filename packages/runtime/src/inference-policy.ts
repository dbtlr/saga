import { readFileSync } from 'node:fs';

import { installationConfigLocation } from './embedding-policy.js';
import type { EmbeddingPolicyResolutionOptions } from './embedding-policy.js';

// The remote-inference policy gate. Unlike the embedding gate (which collapses every
// non-enabled outcome to 'disabled'), inference distinguishes an explicit installation
// standard of 'disabled' from the fail-closed 'not-configured' fall-through, because the
// consuming job surfaces those differently (misconfiguration vs. deliberate opt-out).
export type RemoteInferencePolicyState = 'enabled' | 'disabled' | 'not-configured';
export type InferencePolicySource = 'installation-config' | 'default';
// The OpenAI-family transport / auth path. Both are the Responses API surface; they differ
// only in authentication and streaming.
export type InferenceProvider = 'openai-api' | 'codex-subscription';

export type InferencePolicyResolutionOptions = EmbeddingPolicyResolutionOptions;

export type InferenceConfig = {
  detail: string;
  model: string;
  policy: RemoteInferencePolicyState;
  provider: InferenceProvider;
  source: InferencePolicySource;
};

export const DEFAULT_INFERENCE_PROVIDER: InferenceProvider = 'openai-api';
// Per-provider current-generation defaults. Each is a single exported const so upgrading the
// default stays a one-line edit. The codex default matches the proven Skald provider for the
// same ChatGPT backend.
export const DEFAULT_OPENAI_API_MODEL = 'gpt-5-mini';
export const DEFAULT_CODEX_SUBSCRIPTION_MODEL = 'gpt-5.5';

function defaultModelFor(provider: InferenceProvider): string {
  return provider === 'codex-subscription'
    ? DEFAULT_CODEX_SUBSCRIPTION_MODEL
    : DEFAULT_OPENAI_API_MODEL;
}

export function resolveInferenceConfig(
  options: InferencePolicyResolutionOptions = {},
): InferenceConfig {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const location = installationConfigLocation(options);

  let rawConfig: string;
  try {
    rawConfig = readFile(location.path);
  } catch (error) {
    if (isMissingFileError(error)) {
      return notConfigured(
        `no installation config at ${location.displayPath}; remote inference not configured`,
      );
    }
    return notConfigured(
      `could not read ${location.displayPath}: ${errorMessage(error)}; remote inference not configured`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch {
    // Never echo raw config text: it may contain the API key or other secrets.
    return notConfigured(
      `could not parse ${location.displayPath}; remote inference not configured`,
    );
  }

  const inference = readInferenceSection(parsed);
  if (inference === undefined) {
    return notConfigured(
      `${location.displayPath} does not set inference.remote; remote inference not configured`,
    );
  }

  // Fail closed on a present-but-invalid provider or model: a typo must not silently degrade
  // to a default. Surface the offending KEY, never the raw value (it may sit next to secrets).
  const providerResult = readProvider(inference.provider);
  if (providerResult.status === 'invalid') {
    return notConfigured(
      `inference.provider in ${location.displayPath} is not a supported provider; remote inference not configured`,
    );
  }
  const modelResult = readModel(inference.model);
  if (modelResult.status === 'invalid') {
    return notConfigured(
      `inference.model in ${location.displayPath} must be a non-empty string; remote inference not configured`,
    );
  }
  const provider = providerResult.provider;
  const model = modelResult.model ?? defaultModelFor(provider);

  if (inference.remote === 'enabled') {
    return {
      detail: `remote inference enabled by installation standard in ${location.displayPath}`,
      model,
      policy: 'enabled',
      provider,
      source: 'installation-config',
    };
  }

  return {
    detail: `remote inference disabled by installation standard in ${location.displayPath}`,
    model,
    policy: 'disabled',
    provider,
    source: 'installation-config',
  };
}

function notConfigured(detail: string): InferenceConfig {
  return {
    detail,
    model: defaultModelFor(DEFAULT_INFERENCE_PROVIDER),
    policy: 'not-configured',
    provider: DEFAULT_INFERENCE_PROVIDER,
    source: 'default',
  };
}

type InferenceSection = {
  model: unknown;
  provider: unknown;
  remote: 'enabled' | 'disabled';
};

function readInferenceSection(value: unknown): InferenceSection | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const inference = value.inference;
  if (!isRecord(inference)) {
    return undefined;
  }
  const remote = inference.remote;
  if (remote !== 'enabled' && remote !== 'disabled') {
    return undefined;
  }
  return { model: inference.model, provider: inference.provider, remote };
}

type ProviderResult = { provider: InferenceProvider; status: 'ok' } | { status: 'invalid' };
type ModelResult = { model: string | undefined; status: 'ok' } | { status: 'invalid' };

// Absent (undefined) falls through to the default; any present-but-unknown value is invalid.
function readProvider(value: unknown): ProviderResult {
  if (value === undefined) {
    return { provider: DEFAULT_INFERENCE_PROVIDER, status: 'ok' };
  }
  if (value === 'openai-api' || value === 'codex-subscription') {
    return { provider: value, status: 'ok' };
  }
  return { status: 'invalid' };
}

// Absent (undefined) falls through to the per-provider default; a present non-string or
// blank string is invalid rather than silently defaulted.
function readModel(value: unknown): ModelResult {
  if (value === undefined) {
    return { model: undefined, status: 'ok' };
  }
  if (typeof value !== 'string') {
    return { status: 'invalid' };
  }
  const model = optionalString(value);
  return model === undefined ? { status: 'invalid' } : { model, status: 'ok' };
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
