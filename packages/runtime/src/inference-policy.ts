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

// A cheap-tier default keeps structured extraction inexpensive by default; operators raise
// it in the installation config when a task needs a stronger model.
export const DEFAULT_INFERENCE_MODEL = 'gpt-4o-mini';
export const DEFAULT_INFERENCE_PROVIDER: InferenceProvider = 'openai-api';

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

  const provider = readProvider(inference.provider);
  const model = readModel(inference.model);

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
    model: DEFAULT_INFERENCE_MODEL,
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

function readProvider(value: unknown): InferenceProvider {
  if (value === 'openai-api' || value === 'codex-subscription') {
    return value;
  }
  return DEFAULT_INFERENCE_PROVIDER;
}

function readModel(value: unknown): string {
  const model = typeof value === 'string' ? optionalString(value) : undefined;
  return model ?? DEFAULT_INFERENCE_MODEL;
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
